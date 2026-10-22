"""The add-on's HTTP server, reached only through Home Assistant ingress.

Serves the panel itself plus everything it used to get from Home Assistant:
- `api/states` / `api/websocket` - the `hass.states`-shaped read model (see
  states.py), pushed over the websocket on every change.
- `api/services/<name>` - what `hass.callService("garage", name, ...)` used
  to be (see services.py).
- `api/upload`, `api/vehicle_photo`, `api/analyze_fuel_photo`,
  `api/decode_vin` - the old integration's http.py views, unchanged apart
  from where files land.
- `api/ha_users` - Home Assistant's user list for linking a driver to an
  account (the panel used to ask HA's websocket for it directly).
- `uploads/...` - uploaded documents and vehicle photos (was
  `/local/garage_documents/` and `/local/garage_vehicles/`).

Every path is relative, because ingress serves the add-on under
`/api/hassio_ingress/<token>/` - the panel never builds an absolute URL.

Authentication is ingress's job: Supervisor only proxies requests from
logged-in Home Assistant users. The middleware below refuses anything that
didn't come through the ingress proxy, so the port can't be used to bypass
that.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
import weakref
from ipaddress import ip_address
from pathlib import Path

import aiohttp
from aiohttp import web

from .config import AddonConfig
from .coordinator import GarageCoordinator
from .ha_client import HomeAssistantClient, HomeAssistantError
from .lookups import LookupFailed, analyze_fuel_photo, decode_vin, get_openai_api_key
from .services import Handler, ServiceError, async_call_service
from .states import build_states

_LOGGER = logging.getLogger(__name__)

# Supervisor's ingress proxy always connects from this address.
_INGRESS_PROXY = ip_address("172.30.32.2")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

_NO_OPENAI_KEY = (
    "No OpenAI API key configured. Add one under Settings > Add-ons > Garage > "
    "Configuration (or an openai_api_key entry in secrets.yaml) to use Scan Pump Photo."
)

CONFIG_KEY = web.AppKey("config", AddonConfig)
COORDINATOR_KEY = web.AppKey("coordinator", GarageCoordinator)
HANDLERS_KEY = web.AppKey("handlers", dict)
SESSION_KEY = web.AppKey("session", aiohttp.ClientSession)
HA_KEY = web.AppKey("ha", object)
SOCKETS_KEY = web.AppKey("sockets", weakref.WeakSet)


def _sanitize_filename(name: str) -> str:
    name = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return _SAFE_NAME.sub("_", name) or "upload"


def _error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


@web.middleware
async def _ingress_only(request: web.Request, handler):
    # GARAGE_ALLOW_ANY_CLIENT is for running the backend on a dev machine
    # outside Supervisor - never set inside the add-on container.
    if not os.environ.get("GARAGE_ALLOW_ANY_CLIENT"):
        peer = request.remote
        try:
            allowed = peer is not None and ip_address(peer) == _INGRESS_PROXY
        except ValueError:
            allowed = False
        if not allowed:
            return web.Response(status=403, text="Garage is only reachable through ingress")
    return await handler(request)


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
    return web.json_response(_snapshot(request.app))


async def websocket(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    sockets = request.app[SOCKETS_KEY]
    sockets.add(ws)
    try:
        await ws.send_json(_snapshot(request.app))
        async for _msg in ws:
            pass  # push-only - the panel never sends anything
    finally:
        sockets.discard(ws)
    return ws


def _install_state_push(app: web.Application) -> None:
    """Coalesces every coordinator change in the same loop iteration into
    one push."""
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
        await async_call_service(request.app[HANDLERS_KEY], name, data)
    except ServiceError as err:
        return _error(str(err))
    return web.json_response({"response": None})


async def ha_users(request: web.Request) -> web.Response:
    """Best-effort - without Home Assistant (dev runs) or if the call fails,
    the driver form just offers no accounts to link."""
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


# ---------------------------------------------------------------- uploads


def _read_file_field(field) -> tuple[bytes, str, str]:
    if field is None or not hasattr(field, "file"):
        raise ServiceError("file is required")
    contents = field.file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise ServiceError("File too large (max 25MB)")
    return contents, field.content_type or "application/octet-stream", field.filename or ""


async def _vehicle_form(request: web.Request) -> tuple[str, dict]:
    """Reads a multipart form with a vehicle_id that must name a real
    vehicle - checked before anything is written, and what keeps the id
    safe to use as a directory name."""
    form = await request.post()
    vehicle_id = str(form.get("vehicle_id") or "").strip()
    if not vehicle_id or form.get("file") is None:
        raise ServiceError("vehicle_id and file are required")
    coordinator = request.app[COORDINATOR_KEY]
    if not any(v.id == vehicle_id for v in coordinator.vehicles):
        raise ServiceError(f"Unknown vehicle_id {vehicle_id}")
    return vehicle_id, form


async def upload_document(request: web.Request) -> web.Response:
    config = request.app[CONFIG_KEY]
    try:
        vehicle_id, form = await _vehicle_form(request)
        contents, _content_type, original = _read_file_field(form.get("file"))
    except ServiceError as err:
        return _error(str(err))
    category = str(form.get("category") or "").strip() or "other"
    filename = _sanitize_filename(original or "upload")

    target_dir = config.uploads_dir / "documents" / vehicle_id

    def _write() -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / filename).write_bytes(contents)

    await asyncio.to_thread(_write)

    url_path = f"uploads/documents/{vehicle_id}/{filename}"
    document = await request.app[COORDINATOR_KEY].async_add_document(
        vehicle_id, category, filename, url_path
    )
    return web.json_response({"document": document.to_dict()})


async def upload_vehicle_photo(request: web.Request) -> web.Response:
    """Sets Vehicle.photo_path directly, unlike upload_document which appends
    a Document record. Always one `photo.<ext>` per vehicle, so re-uploading
    replaces it instead of accumulating old ones."""
    config = request.app[CONFIG_KEY]
    try:
        vehicle_id, form = await _vehicle_form(request)
        contents, _content_type, original = _read_file_field(form.get("file"))
    except ServiceError as err:
        return _error(str(err))
    original = _sanitize_filename(original or "photo.jpg")
    extension = "." + original.rsplit(".", 1)[-1].lower() if "." in original else ".jpg"

    target_dir = config.uploads_dir / "vehicles" / vehicle_id
    filename = f"photo{extension}"

    def _write() -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        for old in target_dir.glob("photo.*"):
            old.unlink(missing_ok=True)
        (target_dir / filename).write_bytes(contents)

    await asyncio.to_thread(_write)

    cache_bust = int(time.time() * 1000)
    url_path = f"uploads/vehicles/{vehicle_id}/{filename}?v={cache_bust}"
    vehicle = await request.app[COORDINATOR_KEY].async_edit_vehicle(
        vehicle_id, photo_path=url_path
    )
    return web.json_response({"vehicle": vehicle.to_dict()})


async def analyze_fuel_photo_view(request: web.Request) -> web.Response:
    """Reads a fuel pump display photo via OpenAI and returns what it can
    make out, for the panel to pre-fill the Add Fuel form. The photo is sent
    straight to OpenAI and discarded."""
    api_key = await get_openai_api_key(request.app[CONFIG_KEY])
    if not api_key:
        return _error(_NO_OPENAI_KEY)

    form = await request.post()
    try:
        contents, content_type, _filename = _read_file_field(form.get("file"))
    except ServiceError as err:
        return _error(str(err))

    try:
        result = await analyze_fuel_photo(request.app[SESSION_KEY], api_key, contents, content_type)
    except LookupFailed as err:
        return _error(str(err), status=err.status)
    return web.json_response(result)


async def decode_vin_view(request: web.Request) -> web.Response:
    vin = request.query.get("vin", "").strip().upper()
    if not vin:
        return _error("vin query parameter is required")
    if not vin.isalnum():
        return _error("VIN may only contain letters and numbers")

    api_key = await get_openai_api_key(request.app[CONFIG_KEY])
    try:
        result = await decode_vin(request.app[SESSION_KEY], vin, api_key)
    except LookupFailed as err:
        return _error(str(err), status=err.status)
    return web.json_response(result)


# -------------------------------------------------------------------- app


def create_app(
    config: AddonConfig,
    coordinator: GarageCoordinator,
    handlers: dict[str, Handler],
    session: aiohttp.ClientSession,
    ha: HomeAssistantClient | None,
) -> web.Application:
    # Leave headroom over MAX_UPLOAD_BYTES for the multipart envelope so
    # _read_file_field's check, not aiohttp's 1MB default, decides.
    app = web.Application(
        middlewares=[_ingress_only], client_max_size=MAX_UPLOAD_BYTES + 1024 * 1024
    )
    app[CONFIG_KEY] = config
    app[COORDINATOR_KEY] = coordinator
    app[HANDLERS_KEY] = handlers
    app[SESSION_KEY] = session
    app[HA_KEY] = ha
    app[SOCKETS_KEY] = weakref.WeakSet()

    async def _on_startup(app: web.Application) -> None:
        _install_state_push(app)

    async def _on_shutdown(app: web.Application) -> None:
        for ws in list(app[SOCKETS_KEY]):
            await ws.close(code=aiohttp.WSCloseCode.GOING_AWAY)

    app.on_startup.append(_on_startup)
    app.on_shutdown.append(_on_shutdown)

    config.uploads_dir.mkdir(parents=True, exist_ok=True)
    app.router.add_get("/", index)
    app.router.add_get("/api/states", get_states)
    app.router.add_get("/api/websocket", websocket)
    app.router.add_post("/api/services/{service}", call_service)
    app.router.add_get("/api/ha_users", ha_users)
    app.router.add_post("/api/upload", upload_document)
    app.router.add_post("/api/vehicle_photo", upload_vehicle_photo)
    app.router.add_post("/api/analyze_fuel_photo", analyze_fuel_photo_view)
    app.router.add_get("/api/decode_vin", decode_vin_view)
    app.router.add_static("/uploads", config.uploads_dir)
    assets = Path(config.static_dir) / "assets"
    if assets.is_dir():
        app.router.add_static("/assets", assets)
    return app
