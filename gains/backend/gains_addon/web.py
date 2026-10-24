"""The add-on's HTTP server, reached through Home Assistant ingress.

Serves the panel itself plus everything it used to get from Home Assistant:
- `api/states` / `api/websocket` - the `hass.states`-shaped read model (see
  states.py) plus who's looking (`hass.user`), pushed over the websocket on
  every change.
- `api/services/<name>` - what `hass.callService("gains", name, ...)` and
  the `call_service` websocket command (with `return_response`) used to be
  (see services.py).

Every path is relative, because ingress serves the add-on under
`/api/hassio_ingress/<token>/` - the panel never builds an absolute URL.

Authentication is ingress's job: Supervisor only proxies requests from
logged-in Home Assistant users, and tells the add-on who they are in
`X-Remote-User-*` headers. That user id is the only identity services.py
ever acts on - the integration's `call.context.user_id`. The middleware
below refuses anything that didn't come through the ingress proxy, so
nobody can reach the port directly and claim to be someone else.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from ipaddress import ip_address
from typing import Any

import aiohttp
from aiohttp import web

from .config import AddonConfig
from .coordinator import GainsCoordinator
from .services import Handler, ServiceError, async_call_service
from .states import build_states

_LOGGER = logging.getLogger(__name__)

# Supervisor's ingress proxy always connects from this address.
_INGRESS_PROXY = ip_address("172.30.32.2")

# Who the viewer is on a dev run outside Supervisor (no ingress headers).
DEV_USER_ID = "developer"

CONFIG_KEY = web.AppKey("config", AddonConfig)
COORDINATOR_KEY = web.AppKey("coordinator", GainsCoordinator)
HANDLERS_KEY = web.AppKey("handlers", dict)
# Open websocket -> the Home Assistant user id it was opened by.
SOCKETS_KEY = web.AppKey("sockets", dict)


def _error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _allow_any_client() -> bool:
    # GAINS_ALLOW_ANY_CLIENT is for running the backend on a dev machine
    # outside Supervisor - never set inside the add-on container.
    return bool(os.environ.get("GAINS_ALLOW_ANY_CLIENT"))


@web.middleware
async def _access_control(request: web.Request, handler):
    if not _allow_any_client():
        peer = request.remote
        try:
            allowed = peer is not None and ip_address(peer) == _INGRESS_PROXY
        except ValueError:
            allowed = False
        if not allowed:
            return web.Response(status=403, text="Gains is only reachable through ingress")
    return await handler(request)


# ------------------------------------------------------------------- user


def _user(request: web.Request) -> dict[str, Any] | None:
    """Who's looking, as `hass.user` described them - the panel only reads
    the id and name."""
    user_id = request.headers.get("X-Remote-User-Id")
    name = request.headers.get("X-Remote-User-Display-Name") or request.headers.get(
        "X-Remote-User-Name"
    )
    if not user_id and _allow_any_client():
        return {"id": DEV_USER_ID, "name": name or "Developer"}
    if not user_id:
        return None
    return {"id": user_id, "name": name or ""}


# ------------------------------------------------------------------ panel


async def index(request: web.Request) -> web.FileResponse:
    response = web.FileResponse(request.app[CONFIG_KEY].static_dir / "index.html")
    # The bundle it references is content-hashed, but the page itself must
    # never be cached or an add-on update wouldn't show up until a hard
    # refresh.
    response.headers["Cache-Control"] = "no-cache"
    return response


# ------------------------------------------------------------------ state


def _snapshot(app: web.Application, viewer_id: str | None) -> dict:
    return {"type": "states", "states": build_states(app[COORDINATOR_KEY], viewer_id)}


async def get_states(request: web.Request) -> web.Response:
    user = _user(request)
    return web.json_response({**_snapshot(request.app, user and user["id"]), "user": user})


async def websocket(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    user = _user(request)
    sockets = request.app[SOCKETS_KEY]
    sockets[ws] = user and user["id"]
    try:
        await ws.send_json({**_snapshot(request.app, sockets[ws]), "user": user})
        async for _msg in ws:
            pass  # push-only - the panel never sends anything
    finally:
        sockets.pop(ws, None)
    return ws


def _install_state_push(app: web.Application) -> None:
    """Coalesces every coordinator change in the same loop iteration into
    one push. Each viewer's snapshot differs (see states.py), so it's built
    once per distinct viewer. The user doesn't change mid-connection, so
    pushes after the first leave it out and the panel keeps the one it
    has."""
    loop = asyncio.get_running_loop()
    pending = False

    async def _push() -> None:
        nonlocal pending
        pending = False
        sockets = list(app[SOCKETS_KEY].items())
        payloads: dict[str | None, str] = {}
        for ws, viewer_id in sockets:
            if ws.closed:
                continue
            if viewer_id not in payloads:
                payloads[viewer_id] = json.dumps(_snapshot(app, viewer_id))
            with contextlib.suppress(ConnectionResetError):
                await ws.send_str(payloads[viewer_id])

    def _on_change() -> None:
        nonlocal pending
        if not pending:
            pending = True
            loop.create_task(_push())

    app[COORDINATOR_KEY].async_add_listener(_on_change)


# --------------------------------------------------------------- services


async def _read_body(request: web.Request) -> dict | None:
    try:
        data = await request.json() if request.can_read_body else {}
    except (json.JSONDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def call_service(request: web.Request) -> web.Response:
    name = request.match_info["service"]
    user = _user(request)
    if user is None:
        return _error("No Home Assistant user on this request", status=401)
    data = await _read_body(request)
    if data is None:
        return _error("Invalid request body")
    try:
        response = await async_call_service(request.app[HANDLERS_KEY], name, user["id"], data)
    except ServiceError as err:
        return _error(str(err))
    except Exception:
        # Home Assistant turned these into a generic service error too.
        _LOGGER.exception("gains.%s failed", name)
        return _error(f"{name} failed - check the Gains add-on log for details", status=500)
    return web.json_response({"response": response})


# -------------------------------------------------------------------- app


def create_app(
    config: AddonConfig,
    coordinator: GainsCoordinator,
    handlers: dict[str, tuple[Any, Handler]],
) -> web.Application:
    app = web.Application(middlewares=[_access_control])
    app[CONFIG_KEY] = config
    app[COORDINATOR_KEY] = coordinator
    app[HANDLERS_KEY] = handlers
    app[SOCKETS_KEY] = {}

    async def _on_startup(app: web.Application) -> None:
        _install_state_push(app)

    async def _on_shutdown(app: web.Application) -> None:
        for ws in list(app[SOCKETS_KEY]):
            await ws.close(code=aiohttp.WSCloseCode.GOING_AWAY)

    app.on_startup.append(_on_startup)
    app.on_shutdown.append(_on_shutdown)

    app.router.add_get("/", index)
    app.router.add_get("/api/states", get_states)
    app.router.add_get("/api/websocket", websocket)
    app.router.add_post("/api/services/{service}", call_service)
    assets = config.static_dir / "assets"
    if assets.is_dir():
        app.router.add_static("/assets", assets)
    return app
