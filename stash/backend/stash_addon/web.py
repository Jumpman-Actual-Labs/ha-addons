"""The add-on's HTTP server, reached through Home Assistant ingress (and, for
the `internal/` routes only, by the Garage add-on).

Serves the panel itself plus everything it used to get from Home Assistant:
- `api/states` / `api/websocket` - the `hass.states`-shaped read model (see
  states.py) plus who's looking (`hass.user`), pushed over the websocket on
  every change.
- `api/services/<name>` - what `hass.callService("finance", name, ...)` used
  to be (see services.py).
- `api/ha_users` - Home Assistant's user list for linking a member to an
  account (the panel used to ask HA's websocket for it directly).

Every path is relative, because ingress serves the add-on under
`/api/hassio_ingress/<token>/` - the panel never builds an absolute URL.

Authentication is ingress's job: Supervisor only proxies requests from
logged-in Home Assistant users. The middleware below refuses anything that
didn't come through the ingress proxy, so the port can't be used to bypass
that - except `internal/...`, which only the Garage add-on may call.

`internal/` is Garage's Stash sync, which used to call the integration's
`finance.*_category_expense` services through Home Assistant and read its
category sensors. Garage reaches this add-on directly on Supervisor's
add-on network instead. Add-ons from the same repository share a hostname
prefix (`<repository hash>-<slug>`), so each side works out the other's
hostname from its own; Stash only answers `internal/` requests whose source
address is what Garage's hostname resolves to.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import socket
import weakref
from ipaddress import ip_address
from typing import Any

import aiohttp
from aiohttp import web

from .config import AddonConfig
from .coordinator import FinanceCoordinator
from .ha_client import HomeAssistantClient, HomeAssistantError, is_admin
from .services import (
    SERVICE_ADD_CATEGORY_EXPENSE,
    SERVICE_DELETE_CATEGORY_EXPENSE,
    SERVICE_EDIT_CATEGORY_EXPENSE,
    Handler,
    ServiceError,
    async_call_service,
)
from .states import build_states

_LOGGER = logging.getLogger(__name__)

# Supervisor's ingress proxy always connects from this address.
_INGRESS_PROXY = ip_address("172.30.32.2")

# All Garage's sync needs - nothing else is callable from outside ingress.
INTERNAL_SERVICES = (
    SERVICE_ADD_CATEGORY_EXPENSE,
    SERVICE_EDIT_CATEGORY_EXPENSE,
    SERVICE_DELETE_CATEGORY_EXPENSE,
)

CONFIG_KEY = web.AppKey("config", AddonConfig)
COORDINATOR_KEY = web.AppKey("coordinator", FinanceCoordinator)
HANDLERS_KEY = web.AppKey("handlers", dict)
HA_KEY = web.AppKey("ha", object)
SOCKETS_KEY = web.AppKey("sockets", weakref.WeakSet)


def _error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _allow_any_client() -> bool:
    # STASH_ALLOW_ANY_CLIENT is for running the backend on a dev machine
    # outside Supervisor - never set inside the add-on container.
    return bool(os.environ.get("STASH_ALLOW_ANY_CLIENT"))


def sibling_hostname(own_hostname: str, slug: str) -> str | None:
    """`a1b2c3d4-stash` -> `a1b2c3d4-garage`. None outside Supervisor, where
    the hostname isn't `<prefix>-stash`."""
    prefix, sep, own_slug = own_hostname.rpartition("-")
    if not sep or not prefix or own_slug != "stash":
        return None
    return f"{prefix}-{slug}"


async def _resolve(hostname: str) -> set[str]:
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(hostname, None)
    except (OSError, socket.gaierror):
        return set()
    return {info[4][0] for info in infos}


async def _is_garage(request: web.Request) -> bool:
    peer = request.remote
    garage = sibling_hostname(request.app[CONFIG_KEY].hostname, "garage")
    if peer is None or garage is None:
        return False
    # Resolved per request rather than cached: Garage's address changes
    # whenever its container is recreated.
    return peer in await _resolve(garage)


@web.middleware
async def _access_control(request: web.Request, handler):
    if not _allow_any_client():
        if request.path.startswith("/internal/"):
            if not await _is_garage(request):
                return web.Response(status=403, text="Only the Garage add-on may call this")
        else:
            peer = request.remote
            try:
                allowed = peer is not None and ip_address(peer) == _INGRESS_PROXY
            except ValueError:
                allowed = False
            if not allowed:
                return web.Response(status=403, text="Stash is only reachable through ingress")
    return await handler(request)


# ------------------------------------------------------------------- user


async def _user(request: web.Request) -> dict[str, Any] | None:
    """Who's looking, as `hass.user` described them. Ingress passes the id
    and name; whether they're an admin (the Household view gates edits on
    it) comes from Home Assistant's user list."""
    user_id = request.headers.get("X-Remote-User-Id")
    ha = request.app[HA_KEY]
    if not isinstance(ha, HomeAssistantClient):
        # Dev run outside Supervisor - no ingress headers, nobody to ask.
        return {"id": user_id or "", "name": "Developer", "is_admin": True}
    if not user_id:
        return None
    name = request.headers.get("X-Remote-User-Display-Name") or request.headers.get(
        "X-Remote-User-Name"
    )
    admin = False
    try:
        record = next((u for u in await ha.list_users() if u.get("id") == user_id), None)
    except HomeAssistantError:
        _LOGGER.warning("Couldn't look up Home Assistant user %s", user_id, exc_info=True)
        record = None
    if record:
        admin = is_admin(record)
        name = name or record.get("name")
    return {"id": user_id, "name": name or "", "is_admin": admin}


# ------------------------------------------------------------------ panel


async def index(request: web.Request) -> web.FileResponse:
    response = web.FileResponse(request.app[CONFIG_KEY].static_dir / "index.html")
    # The bundle it references is content-hashed, but the page itself must
    # never be cached or an add-on update wouldn't show up until a hard
    # refresh.
    response.headers["Cache-Control"] = "no-cache"
    return response


# ------------------------------------------------------------------ state


def _snapshot(app: web.Application) -> dict:
    return {"type": "states", "states": build_states(app[COORDINATOR_KEY].data or {})}


async def get_states(request: web.Request) -> web.Response:
    return web.json_response({**_snapshot(request.app), "user": await _user(request)})


async def websocket(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    sockets = request.app[SOCKETS_KEY]
    sockets.add(ws)
    try:
        await ws.send_json({**_snapshot(request.app), "user": await _user(request)})
        async for _msg in ws:
            pass  # push-only - the panel never sends anything
    finally:
        sockets.discard(ws)
    return ws


def _install_state_push(app: web.Application) -> None:
    """Coalesces every coordinator change in the same loop iteration into
    one push. The user doesn't change mid-connection, so pushes after the
    first leave it out and the panel keeps the one it has."""
    loop = asyncio.get_running_loop()
    pending = False

    async def _push() -> None:
        nonlocal pending
        pending = False
        sockets = list(app[SOCKETS_KEY])
        if not sockets:
            return
        payload = json.dumps(_snapshot(app))
        for ws in sockets:
            if not ws.closed:
                with contextlib.suppress(ConnectionResetError):
                    await ws.send_str(payload)

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


async def _call(request: web.Request, name: str) -> web.Response:
    data = await _read_body(request)
    if data is None:
        return _error("Invalid request body")
    try:
        response = await async_call_service(request.app[HANDLERS_KEY], name, data)
    except ServiceError as err:
        return _error(str(err))
    return web.json_response({"response": response})


async def call_service(request: web.Request) -> web.Response:
    return await _call(request, request.match_info["service"])


async def ha_users(request: web.Request) -> web.Response:
    """Best-effort - without Home Assistant (dev runs) or if the call fails,
    the member form just offers no accounts to link."""
    ha = request.app[HA_KEY]
    if not isinstance(ha, HomeAssistantClient):
        return web.json_response([])
    try:
        users = await ha.list_users()
    except HomeAssistantError:
        _LOGGER.warning("Couldn't list Home Assistant users", exc_info=True)
        return web.json_response([])
    return web.json_response(
        [
            {
                "id": u.get("id"),
                "name": u.get("name"),
                "system_generated": bool(u.get("system_generated")),
            }
            for u in users
        ]
    )


# --------------------------------------------------------------- internal


async def internal_categories(request: web.Request) -> web.Response:
    """What Garage used to find by scanning Home Assistant for Stash's
    category sensors - it looks its configured category up by name."""
    coordinator = request.app[COORDINATOR_KEY]
    return web.json_response([{"id": c.id, "name": c.name} for c in coordinator.categories])


async def internal_service(request: web.Request) -> web.Response:
    name = request.match_info["service"]
    if name not in INTERNAL_SERVICES:
        return _error(f"Unknown service: {name}", status=404)
    return await _call(request, name)


# -------------------------------------------------------------------- app


def create_app(
    config: AddonConfig,
    coordinator: FinanceCoordinator,
    handlers: dict[str, Handler],
    ha: HomeAssistantClient | None,
) -> web.Application:
    app = web.Application(middlewares=[_access_control])
    app[CONFIG_KEY] = config
    app[COORDINATOR_KEY] = coordinator
    app[HANDLERS_KEY] = handlers
    app[HA_KEY] = ha
    app[SOCKETS_KEY] = weakref.WeakSet()

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
    app.router.add_get("/api/ha_users", ha_users)
    app.router.add_get("/internal/categories", internal_categories)
    app.router.add_post("/internal/services/{service}", internal_service)
    assets = config.static_dir / "assets"
    if assets.is_dir():
        app.router.add_static("/assets", assets)
    return app
