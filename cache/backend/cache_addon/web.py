"""The add-on's HTTP server, reached only through Home Assistant ingress.

Serves the panel itself plus everything it used to get from Home Assistant:
- `api/states` / `api/websocket` - the `hass.states`-shaped read model (see
  states.py), pushed over the websocket on every change.
- `api/services/<name>` - what `hass.callService("cache", name, ...)` used to
  be (see services.py).
- `api/upload/*`, `api/scan_ammo_box`, `api/lookup_ammo_barcode`,
  `api/estimate_value` - the old integration's http.py views, unchanged
  apart from where files land.
- `uploads/<filename>` - uploaded photos/documents (was `/local/cache_uploads/`).

Every path is relative, because ingress serves the add-on under
`/api/hassio_ingress/<token>/` - the panel never builds an absolute URL.

Authentication is ingress's job: Supervisor only proxies requests from
logged-in Home Assistant users, and tells us who they are via the
X-Remote-User-* headers. The middleware below refuses anything that didn't
come through the ingress proxy, so the port can't be used to bypass that.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import uuid
import weakref
from ipaddress import ip_address
from pathlib import Path

import aiohttp
from aiohttp import web

from .barcode_client import (
    UpcLookupError,
    UpcNotFoundError,
    fallback_fields,
    listing_text,
    lookup_upc,
)
from .config import AddonConfig
from .const import (
    ALLOWED_DOCUMENT_CONTENT_TYPES,
    ALLOWED_PHOTO_CONTENT_TYPES,
    DIAGRAM_TYPES,
    DOCUMENT_TYPES,
    MAX_UPLOAD_BYTES,
)
from .coordinator import CacheCoordinator, CacheError
from .openai_client import (
    OpenAIError,
    estimate_used_value,
    extract_ammo_fields_from_text,
    get_openai_api_key,
    remove_background,
    scan_ammo_box,
)
from .services import ServiceContext, async_call_service
from .states import build_states

_LOGGER = logging.getLogger(__name__)

# Supervisor's ingress proxy always connects from this address.
_INGRESS_PROXY = ip_address("172.30.32.2")

_NO_OPENAI_KEY = (
    "OpenAI API key not configured. Add one under Settings > Add-ons > "
    "Cache > Configuration, or add an openai_api_key entry to secrets.yaml."
)

CONFIG_KEY = web.AppKey("config", AddonConfig)
COORDINATOR_KEY = web.AppKey("coordinator", CacheCoordinator)
SERVICES_KEY = web.AppKey("services", ServiceContext)
SESSION_KEY = web.AppKey("session", aiohttp.ClientSession)
SOCKETS_KEY = web.AppKey("sockets", weakref.WeakSet)


def _upload_url(filename: str) -> str:
    return f"uploads/{filename}"


def _error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


@web.middleware
async def _ingress_only(request: web.Request, handler):
    # CACHE_ALLOW_ANY_CLIENT is for running the backend on a dev machine
    # outside Supervisor - never set inside the add-on container.
    if not os.environ.get("CACHE_ALLOW_ANY_CLIENT"):
        peer = request.remote
        try:
            allowed = peer is not None and ip_address(peer) == _INGRESS_PROXY
        except ValueError:
            allowed = False
        if not allowed:
            return web.Response(status=403, text="Cache is only reachable through ingress")
    return await handler(request)


# Shown to anyone the Configuration tab's Allowed users leaves out. Styled
# like the panel (dark HUD palette), which never loads for them.
_NO_ACCESS_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cache</title>
    <style>
      :root {
        --bg: #090b0c;
        --card: #0f1213;
        --line: rgba(174, 180, 184, 0.2);
        --ink: #f0f2f2;
        --muted: #a4aaad;
        --accent: #8e9a62;
      }
      html,
      body {
        margin: 0;
        height: 100%;
        background: var(--bg);
        color: var(--muted);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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
          Cache's Allowed users option.
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
    if not os.environ.get("CACHE_ALLOW_ANY_CLIENT"):
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


def _user(request: web.Request) -> dict[str, str | None]:
    return {
        "id": request.headers.get("X-Remote-User-Id"),
        "name": request.headers.get("X-Remote-User-Display-Name")
        or request.headers.get("X-Remote-User-Name"),
    }


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
    return web.json_response({**_snapshot(request.app), "user": _user(request)})


async def websocket(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    sockets = request.app[SOCKETS_KEY]
    sockets.add(ws)
    try:
        await ws.send_json({**_snapshot(request.app), "user": _user(request)})
        async for _msg in ws:
            pass  # push-only - the panel never sends anything
    finally:
        sockets.discard(ws)
    return ws


def _install_state_push(app: web.Application) -> None:
    """Coalesces every coordinator change in the same loop iteration into
    one push - a range session log, say, touches firearms, ammo and
    schedules but only needs to reach the panel once."""
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
            request.app[SERVICES_KEY], name, data, _user(request)["name"]
        )
    except CacheError as err:
        return _error(str(err))
    return web.json_response({"response": response})


# ---------------------------------------------------------------- uploads


def _read_upload(field, allowed_types: set[str]) -> tuple[bytes, str, str]:
    """Validates and reads an uploaded field without persisting it -
    shared by the photo/document views (which then write it to disk) and
    the ammo-scan view (which sends it straight to OpenAI and discards it)."""
    if field is None or not hasattr(field, "file"):
        raise CacheError("A file is required")
    content_type = getattr(field, "content_type", None)
    if content_type not in allowed_types:
        raise CacheError(f"Unsupported file type: {content_type}")

    contents = field.file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise CacheError("File too large (max 25MB)")

    return contents, content_type, field.filename or "upload"


async def _write_bytes(config: AddonConfig, stored_name: str, contents: bytes) -> None:
    def _write() -> None:
        config.uploads_dir.mkdir(parents=True, exist_ok=True)
        (config.uploads_dir / stored_name).write_bytes(contents)

    await asyncio.to_thread(_write)


async def _save_upload(config: AddonConfig, field, allowed_types: set[str]) -> tuple[str, str]:
    contents, _content_type, original_filename = _read_upload(field, allowed_types)

    ext = Path(original_filename).suffix[:10]
    stored_name = f"{uuid.uuid4().hex}{ext}"
    await _write_bytes(config, stored_name, contents)
    return stored_name, original_filename


async def _unlink_upload(config: AddonConfig, filename: str) -> None:
    path = config.uploads_dir / filename

    def _unlink() -> None:
        if path.is_file():
            path.unlink()

    await asyncio.to_thread(_unlink)


async def upload_photo(request: web.Request) -> web.Response:
    """With an OpenAI key configured, every photo uploaded here - firearm
    gallery or inventory item (part) - is run through OpenAI's background
    removal first (`openai_client.remove_background`) before saving, so it
    reads as a clean cutout rather than a product photo with its original
    background. Without a key the photo is saved exactly as uploaded -
    background removal is a nicety, and a new install shouldn't be unable
    to add photos at all until someone sets up an OpenAI account. A key
    that IS configured but fails (OpenAI down, out of credit) still fails
    the upload rather than silently skipping the cutout the user expects.
    Parts and firearms both go through this same endpoint regardless of
    entity_type. Photos saved without removal can be cut out later with
    services.py's `reprocess_firearm_photos` once a key is added."""
    config = request.app[CONFIG_KEY]
    form = await request.post()

    entity_type = form.get("entity_type")
    entity_id = form.get("entity_id")
    if entity_type not in ("firearm", "inventory_item") or not entity_id:
        return _error("entity_type ('firearm' or 'inventory_item') and entity_id are required")

    api_key = await get_openai_api_key(config)

    try:
        image_bytes, content_type, original_filename = _read_upload(
            form.get("file"), ALLOWED_PHOTO_CONTENT_TYPES
        )
        if api_key:
            try:
                image_bytes = await remove_background(
                    request.app[SESSION_KEY], api_key, image_bytes, content_type
                )
            except OpenAIError as err:
                return _error(str(err), status=502)
            ext = ".png"
        else:
            ext = Path(original_filename).suffix[:10]
        stored_name = f"{uuid.uuid4().hex}{ext}"
        await _write_bytes(config, stored_name, image_bytes)

        photo = await request.app[COORDINATOR_KEY].async_add_photo(
            str(entity_type), str(entity_id), stored_name, original_filename
        )
    except CacheError as err:
        return _error(str(err))

    return web.json_response(
        {
            "id": photo.id,
            "filename": photo.filename,
            "original_filename": photo.original_filename,
            "is_primary": photo.is_primary,
            "uploaded_at": photo.uploaded_at,
            "url": _upload_url(photo.filename),
        }
    )


async def upload_document(request: web.Request) -> web.Response:
    config = request.app[CONFIG_KEY]
    form = await request.post()

    firearm_id = form.get("firearm_id")
    document_type = form.get("document_type") or "Other"
    if not firearm_id:
        return _error("firearm_id is required")
    if document_type not in DOCUMENT_TYPES:
        return _error("Invalid document_type")

    try:
        stored_name, original_filename = await _save_upload(
            config, form.get("file"), ALLOWED_DOCUMENT_CONTENT_TYPES
        )
        doc = await request.app[COORDINATOR_KEY].async_add_document(
            str(firearm_id), stored_name, str(document_type), original_filename
        )
    except CacheError as err:
        return _error(str(err))

    return web.json_response(
        {
            "id": doc.id,
            "filename": doc.filename,
            "original_filename": doc.original_filename,
            "document_type": doc.document_type,
            "uploaded_at": doc.uploaded_at,
            "url": _upload_url(doc.filename),
        }
    )


async def upload_diagram_image(request: web.Request) -> web.Response:
    """Uploads a diagram's reference image (Settings' diagram anchor
    editor) - not tied to any firearm/inventory_item, just a
    per-diagram_type override recorded on CacheSettings. Replacing an
    existing image deletes the old file from disk (the coordinator hands
    back the previous filename precisely so this view can clean it up)."""
    config = request.app[CONFIG_KEY]
    form = await request.post()

    diagram_type = form.get("diagram_type")
    if diagram_type not in DIAGRAM_TYPES:
        return _error("Invalid diagram_type")

    try:
        stored_name, _original_filename = await _save_upload(
            config, form.get("file"), ALLOWED_PHOTO_CONTENT_TYPES
        )
        previous_filename = await request.app[
            COORDINATOR_KEY
        ].async_set_diagram_reference_image(str(diagram_type), stored_name)
    except CacheError as err:
        return _error(str(err))

    if previous_filename:
        await _unlink_upload(config, previous_filename)

    return web.json_response(
        {"diagram_type": diagram_type, "filename": stored_name, "url": _upload_url(stored_name)}
    )


async def scan_ammo_box_view(request: web.Request) -> web.Response:
    """Reads a photo of an ammo box and asks OpenAI to extract the printed
    fields (see openai_client.py) - the image is sent straight to OpenAI's
    API and discarded, never written to disk or stored."""
    api_key = await get_openai_api_key(request.app[CONFIG_KEY])
    if not api_key:
        return _error(_NO_OPENAI_KEY)

    form = await request.post()
    try:
        image_bytes, content_type, _filename = _read_upload(
            form.get("file"), ALLOWED_PHOTO_CONTENT_TYPES
        )
    except CacheError as err:
        return _error(str(err))

    try:
        fields = await scan_ammo_box(request.app[SESSION_KEY], api_key, image_bytes, content_type)
    except OpenAIError as err:
        return _error(str(err), status=502)

    return web.json_response(fields)


async def lookup_ammo_barcode(request: web.Request) -> web.Response:
    """Looks up a scanned UPC/EAN barcode via UPCitemdb (see
    barcode_client.py), then - if an OpenAI key is configured - asks OpenAI
    to turn that listing's title/brand/description into the same structured
    ammo fields scan_ammo_box returns. Without a configured key (or if that
    extraction call fails), falls back to a plain field mapping instead of
    failing outright - manufacturer/product_name still prefill."""
    try:
        data = await request.json()
    except (json.JSONDecodeError, ValueError):
        return _error("Invalid request body")

    barcode = str(data.get("barcode") or "").strip()
    if not barcode:
        return _error("A barcode is required")

    session = request.app[SESSION_KEY]
    try:
        item = await lookup_upc(session, barcode)
    except UpcNotFoundError as err:
        return _error(str(err), status=404)
    except UpcLookupError as err:
        return _error(str(err), status=502)

    text = listing_text(item)
    api_key = await get_openai_api_key(request.app[CONFIG_KEY]) if text else None
    if api_key:
        try:
            fields = await extract_ammo_fields_from_text(session, api_key, text)
        except OpenAIError:
            fields = fallback_fields(item)
    else:
        fields = fallback_fields(item)

    return web.json_response(fields)


async def estimate_value(request: web.Request) -> web.Response:
    """Asks OpenAI for a rough used/resale price range for a firearm or
    part, from its own general knowledge (see openai_client.
    estimate_used_value) - NOT live market data, nothing here browses the
    web. Takes a plain text description built by the caller (manufacturer/
    model/type/caliber/condition, whatever's on file) rather than
    structured fields, so one endpoint serves both firearms and parts.
    Nothing is persisted - same "ask AI, return fields, discard the request"
    shape as scan_ammo_box/lookup_ammo_barcode; the panel shows the estimate
    for the user to review and explicitly apply if they want it."""
    try:
        data = await request.json()
    except (json.JSONDecodeError, ValueError):
        return _error("Invalid request body")

    description = str(data.get("description") or "").strip()
    if not description:
        return _error("A description is required")

    api_key = await get_openai_api_key(request.app[CONFIG_KEY])
    if not api_key:
        return _error(_NO_OPENAI_KEY)

    try:
        estimate = await estimate_used_value(request.app[SESSION_KEY], api_key, description)
    except OpenAIError as err:
        return _error(str(err), status=502)

    return web.json_response(estimate)


# -------------------------------------------------------------------- app


def create_app(
    config: AddonConfig,
    coordinator: CacheCoordinator,
    services: ServiceContext,
    session: aiohttp.ClientSession,
) -> web.Application:
    # Uploads are capped at 25MB by _read_upload - leave headroom for the
    # multipart envelope so that check, not aiohttp's 1MB default, decides.
    app = web.Application(
        middlewares=[_ingress_only, _allowed_users_only],
        client_max_size=MAX_UPLOAD_BYTES + 1024 * 1024,
    )
    app[CONFIG_KEY] = config
    app[COORDINATOR_KEY] = coordinator
    app[SERVICES_KEY] = services
    app[SESSION_KEY] = session
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
    app.router.add_post("/api/upload/photo", upload_photo)
    app.router.add_post("/api/upload/document", upload_document)
    app.router.add_post("/api/upload/diagram_image", upload_diagram_image)
    app.router.add_post("/api/scan_ammo_box", scan_ammo_box_view)
    app.router.add_post("/api/lookup_ammo_barcode", lookup_ammo_barcode)
    app.router.add_post("/api/estimate_value", estimate_value)
    app.router.add_static("/uploads", config.uploads_dir)
    if (config.static_dir / "assets").is_dir():
        app.router.add_static("/assets", config.static_dir / "assets")
    return app
