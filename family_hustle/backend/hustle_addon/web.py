"""The add-on's HTTP server, reached only through Home Assistant ingress.

Serves the panel itself plus everything it used to get from Home Assistant:
- `api/states` / `api/websocket` - the `hass.states`-shaped read model (see
  states.py) plus who's looking (`hass.user`), pushed over the websocket on
  every change.
- `api/services/<name>` - what `hass.callService("hustle", name, ...)` used
  to be (services.py), plus the Calendar tab's (family_calendar.py) and
  Meals tab's (meals.py) services. Answers `{"response": ...}` so the meal
  wizard gets its generated meals/grocery list back.
- `api/ha_users` - Home Assistant's user list for linking a member to an
  account (the panel used to ask HA's websocket for it directly).
- `api/calendar/calendars`, `api/calendar/events`, `api/meals/week` - read
  straight from Home Assistant's calendars on request; nothing about them
  is pushed (calendars have no change signal to push from).
- `api/shopping/lists`, `api/shopping/items` - Home Assistant's to-do
  lists and the shopping list's items, read on request the same way.
- `images/...` - AI chore illustrations (was `/local/hustle_images/`).

Every path is relative, because ingress serves the add-on under
`/api/hassio_ingress/<token>/` - the panel never builds an absolute URL.

Authentication is ingress's job: Supervisor only proxies requests from
logged-in Home Assistant users and says who they are in `X-Remote-User-*`
headers. The middleware below refuses anything that didn't come through
the ingress proxy, so those headers can't be forged by calling the port
directly - which matters, because they decide what services.py's
parent/admin guards allow.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import weakref
from datetime import date, timedelta
from ipaddress import ip_address
from pathlib import Path
from typing import Any

import aiohttp
import voluptuous as vol
from aiohttp import web

from .config import AddonConfig
from .coordinator import HustleCoordinator
from .family_calendar import FamilyCalendar, calendar_entity
from .ha_client import HomeAssistantClient, HomeAssistantError, is_admin
from .meals import load_dinner_week
from .services import Context, Handler, ServiceError, ServiceValidationError, async_call_service
from .shopping import ShoppingList
from .states import build_states

_LOGGER = logging.getLogger(__name__)

# Supervisor's ingress proxy always connects from this address.
_INGRESS_PROXY = ip_address("172.30.32.2")

# Longest range api/calendar/events will read in one go (a month view with
# its leading/trailing weeks is 42 days).
MAX_EVENT_RANGE_DAYS = 62

CONFIG_KEY = web.AppKey("config", AddonConfig)
COORDINATOR_KEY = web.AppKey("coordinator", HustleCoordinator)
SCHEMAS_KEY = web.AppKey("schemas", dict)
HANDLERS_KEY = web.AppKey("handlers", dict)
HA_KEY = web.AppKey("ha", object)
CALENDAR_KEY = web.AppKey("calendar", FamilyCalendar)
SHOPPING_KEY = web.AppKey("shopping", ShoppingList)
SOCKETS_KEY = web.AppKey("sockets", weakref.WeakSet)


def _allow_any_client() -> bool:
    # HUSTLE_ALLOW_ANY_CLIENT is for running the backend on a dev machine
    # outside Supervisor - never set inside the add-on container.
    return bool(os.environ.get("HUSTLE_ALLOW_ANY_CLIENT"))


def _error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


@web.middleware
async def _ingress_only(request: web.Request, handler):
    if not _allow_any_client():
        peer = request.remote
        try:
            allowed = peer is not None and ip_address(peer) == _INGRESS_PROXY
        except ValueError:
            allowed = False
        if not allowed:
            return web.Response(status=403, text="Family Hustle is only reachable through ingress")
    return await handler(request)


# Shown to anyone the Configuration tab's Allowed users leaves out. Styled
# like the panel (light/dark palette), which never loads for them.
_NO_ACCESS_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Family Hustle</title>
    <style>
      :root {
        --bg: #f6f7f9;
        --card: #ffffff;
        --line: #e1e5ea;
        --ink: #2f3a4a;
        --muted: #7b8796;
        --accent: #23765c;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #12151a;
          --card: #1a1e25;
          --line: #2a303a;
          --ink: #e6e9ef;
          --muted: #9aa4b2;
          --accent: #7fc8c0;
        }
      }
      html,
      body {
        margin: 0;
        height: 100%;
        background: var(--bg);
        color: var(--muted);
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        display: flex;
        height: 100%;
        align-items: center;
        justify-content: center;
        padding: 0 16px;
      }
      .card {
        max-width: 420px;
        padding: 32px 28px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--card);
        text-align: center;
      }
      .mark {
        width: 44px;
        height: 44px;
        margin: 0 auto 16px;
        border-radius: 50%;
        border: 2px solid var(--accent);
        color: var(--accent);
        font-size: 22px;
        line-height: 44px;
      }
      h1 {
        margin: 0 0 8px;
        color: var(--ink);
        font-size: 1.15rem;
      }
      p {
        margin: 0;
        font-size: 0.9rem;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <div class="mark">&#x2715;</div>
        <h1>You don't have access to this add-on</h1>
        <p>
          Ask a Home Assistant administrator to add your username to
          Family Hustle's Allowed users option.
        </p>
      </div>
    </main>
  </body>
</html>
"""


@web.middleware
async def _allowed_users_only(request: web.Request, handler):
    """The Configuration tab's Allowed users. Runs after _ingress_only,
    so the X-Remote-User-* headers are ingress's and can't be forged. A request
    without one is refused even when the list is empty (everyone).
    """
    if not _allow_any_client():
        user = (
            request.headers.get("X-Remote-User-Name")
            or request.headers.get("X-Remote-User-Id")
            or ""
        ).strip()
        allowed = request.app[CONFIG_KEY].allowed_users
        if not user:
            _LOGGER.info("Refused a request with no Home Assistant user")
            return web.Response(status=403, text=_NO_ACCESS_PAGE, content_type="text/html")
        if allowed and user.casefold() not in allowed:
            _LOGGER.info("Refused %s - not in Allowed users", user)
            return web.Response(status=403, text=_NO_ACCESS_PAGE, content_type="text/html")
    return await handler(request)


# ------------------------------------------------------------------- user


async def _user(request: web.Request) -> dict[str, Any] | None:
    """Who's looking, as `hass.user` described them. Ingress passes the id
    and name; whether they're an HA admin (only needed for first-run setup)
    comes from Home Assistant's user list."""
    ha = request.app[HA_KEY]
    user_id = request.headers.get("X-Remote-User-Id")
    if not isinstance(ha, HomeAssistantClient) or (not user_id and _allow_any_client()):
        # Dev run outside Supervisor - no ingress headers, so the viewer is
        # HUSTLE_DEV_USER_ID, as an admin.
        dev_id = request.app[CONFIG_KEY].dev_user_id
        return {"id": dev_id, "name": "Developer", "is_admin": True}
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


async def _require_viewer_member(request: web.Request) -> None:
    """Calendar reads are for linked members, like the rest of the panel."""
    user = await _user(request)
    context = Context(user_id=(user or {}).get("id") or None)
    if request.app[COORDINATOR_KEY]._member_for_context(context) is None:
        raise ServiceValidationError(
            "No Hustle member is linked to your Home Assistant user account."
        )


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
    first leave it out (the panel keeps the one it has)."""
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


async def call_service(request: web.Request) -> web.Response:
    name = request.match_info["service"]
    try:
        data = await request.json() if request.can_read_body else {}
    except (json.JSONDecodeError, ValueError):
        return _error("Invalid request body")
    if not isinstance(data, dict):
        return _error("Invalid request body")

    try:
        response = await async_call_service(
            request.app[SCHEMAS_KEY], request.app[HANDLERS_KEY], name, data, await _user(request)
        )
    except ServiceError as err:
        return _error(str(err))
    return web.json_response({"response": response})


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


# --------------------------------------------------------------- calendar


def _date_param(request: web.Request, name: str) -> date:
    try:
        return date.fromisoformat(request.query[name])
    except (KeyError, ValueError) as err:
        raise ServiceError(f"{name} must be a YYYY-MM-DD date") from err


async def calendars(request: web.Request) -> web.Response:
    try:
        await _require_viewer_member(request)
        return web.json_response(await request.app[CALENDAR_KEY].list_calendars())
    except ServiceError as err:
        return _error(str(err))


async def calendar_events(request: web.Request) -> web.Response:
    """`?start=&end=` (dates, end exclusive) over the family calendars, or
    over `entity_id` (repeatable) when given."""
    try:
        await _require_viewer_member(request)
        start = _date_param(request, "start")
        end = _date_param(request, "end")
        if end <= start or end - start > timedelta(days=MAX_EVENT_RANGE_DAYS):
            raise ServiceError(f"end must be 1-{MAX_EVENT_RANGE_DAYS} days after start")
        requested = request.query.getall("entity_id", [])
        try:
            entity_ids = [calendar_entity(e) for e in requested]
        except vol.Invalid as err:
            raise ServiceError(str(err)) from err
        if not entity_ids:
            settings = request.app[COORDINATOR_KEY].calendar_settings
            entity_ids = list(settings.get("family_calendars") or [])
        result: dict[str, Any] = {"events": [], "errors": []}
        if entity_ids:
            result = await request.app[CALENDAR_KEY].events(entity_ids, start, end)
        return web.json_response(result)
    except ServiceError as err:
        return _error(str(err))


async def meals_week(request: web.Request) -> web.Response:
    try:
        await _require_viewer_member(request)
        return web.json_response(
            await load_dinner_week(request.app[CALENDAR_KEY], request.app[COORDINATOR_KEY])
        )
    except ServiceError as err:
        return _error(str(err))


async def shopping_lists(request: web.Request) -> web.Response:
    try:
        await _require_viewer_member(request)
        return web.json_response(await request.app[SHOPPING_KEY].list_lists())
    except ServiceError as err:
        return _error(str(err))


async def shopping_items(request: web.Request) -> web.Response:
    try:
        await _require_viewer_member(request)
        return web.json_response(await request.app[SHOPPING_KEY].items())
    except ServiceError as err:
        return _error(str(err))


# -------------------------------------------------------------------- app


def create_app(
    config: AddonConfig,
    coordinator: HustleCoordinator,
    schemas: dict[str, vol.Schema],
    handlers: dict[str, Handler],
    ha: HomeAssistantClient | None,
    calendar: FamilyCalendar,
    shopping: ShoppingList,
) -> web.Application:
    app = web.Application(middlewares=[_ingress_only, _allowed_users_only])
    app[CONFIG_KEY] = config
    app[COORDINATOR_KEY] = coordinator
    app[SCHEMAS_KEY] = schemas
    app[HANDLERS_KEY] = handlers
    app[HA_KEY] = ha
    app[CALENDAR_KEY] = calendar
    app[SHOPPING_KEY] = shopping
    app[SOCKETS_KEY] = weakref.WeakSet()

    async def _on_startup(app: web.Application) -> None:
        _install_state_push(app)

    async def _on_shutdown(app: web.Application) -> None:
        for ws in list(app[SOCKETS_KEY]):
            await ws.close(code=aiohttp.WSCloseCode.GOING_AWAY)

    app.on_startup.append(_on_startup)
    app.on_shutdown.append(_on_shutdown)

    config.images_dir.mkdir(parents=True, exist_ok=True)
    app.router.add_get("/", index)
    app.router.add_get("/api/states", get_states)
    app.router.add_get("/api/websocket", websocket)
    app.router.add_post("/api/services/{service}", call_service)
    app.router.add_get("/api/ha_users", ha_users)
    app.router.add_get("/api/calendar/calendars", calendars)
    app.router.add_get("/api/calendar/events", calendar_events)
    app.router.add_get("/api/meals/week", meals_week)
    app.router.add_get("/api/shopping/lists", shopping_lists)
    app.router.add_get("/api/shopping/items", shopping_items)
    app.router.add_static("/images", config.images_dir)
    assets = Path(config.static_dir) / "assets"
    if assets.is_dir():
        app.router.add_static("/assets", assets)
    return app
