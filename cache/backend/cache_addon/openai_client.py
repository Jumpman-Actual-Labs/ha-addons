"""Ammo box photo scanning via OpenAI's vision-capable chat completions API.

Plain aiohttp REST calls rather than the `openai` pip package, to avoid
adding a new dependency for a single endpoint. The API key comes from
the add-on's own `openai_api_key` option, then an `openai_api_key` entry in
Home Assistant's secrets.yaml, then the key carried over from the old
integration's config entry (see migrate.py) - this module never sends the
key anywhere but to OpenAI, and never returns it to a caller.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from pathlib import Path

import aiohttp
import yaml

from .config import AddonConfig
from .const import (
    OPENAI_CHAT_COMPLETIONS_URL,
    OPENAI_IMAGE_MODEL,
    OPENAI_IMAGES_EDIT_URL,
    OPENAI_VISION_MODEL,
)

_LOGGER = logging.getLogger(__name__)

_SECRETS_KEY = "openai_api_key"

_EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "caliber": {"type": ["string", "null"]},
        "manufacturer": {"type": ["string", "null"]},
        "product_name": {"type": ["string", "null"]},
        "bullet_weight": {"type": ["string", "null"]},
        "bullet_type": {"type": ["string", "null"]},
        "muzzle_velocity": {"type": ["string", "null"]},
        "rounds_per_box": {"type": ["integer", "null"]},
    },
    "required": [
        "caliber",
        "manufacturer",
        "product_name",
        "bullet_weight",
        "bullet_type",
        "muzzle_velocity",
        "rounds_per_box",
    ],
    "additionalProperties": False,
}

_FIELD_LIST = (
    "- caliber (e.g. '9mm', '.223 Remington', '300 BLK')\n"
    "- manufacturer (the brand, e.g. 'Federal', 'Hornady')\n"
    "- product_name (the specific product line, e.g. 'Gold Medal Match', "
    "'American Eagle')\n"
    "- bullet_weight (e.g. '124gr')\n"
    "- bullet_type (e.g. 'FMJ', 'JHP', 'TAP')\n"
    "- muzzle_velocity (e.g. '1150 fps', only if stated)\n"
    "- rounds_per_box (the quantity of rounds in this box, as an integer)"
)

_IMAGE_PROMPT = (
    "You are reading a photo of an ammunition box. Extract these fields "
    "exactly as printed on the box, using null for anything not clearly "
    "legible - do not guess:\n" + _FIELD_LIST
)

_TEXT_PROMPT = (
    "You are reading a barcode product-database listing for a box of "
    "ammunition. Extract these fields from the listing text below, using "
    "null for anything not clearly stated - do not guess, and do not "
    "invent values the listing doesn't actually contain:\n" + _FIELD_LIST + "\n\nListing:\n"
)

_BACKGROUND_REMOVAL_PROMPT = (
    "Remove the background completely so only the firearm remains, "
    "centered, on a fully transparent background. Leave a generous "
    "empty margin - at least 12% of the canvas width and height - "
    "between the firearm and every edge of the image; do not crop or "
    "frame it tightly against the canvas bounds. Preserve the firearm's "
    "exact appearance, angle, proportions, color, and details - do not "
    "alter, redraw, restyle, or add/remove any parts."
)


class OpenAIError(Exception):
    """Raised for any failure calling or parsing the OpenAI API - the http
    view catches this and returns it as a 502 with a user-facing message."""


def _parse_secrets_yaml(text: str) -> str | None:
    """Pulled out from get_openai_api_key so the parsing logic (as opposed
    to the file read, which needs a real filesystem/executor job) is
    unit-testable without HA."""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    value = data.get(_SECRETS_KEY)
    return str(value) if value else None


def _read_secrets_file_key(path: Path) -> str | None:
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return _parse_secrets_yaml(text)


def _read_imported_key(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get(_SECRETS_KEY)
    except (OSError, ValueError, AttributeError):
        return None
    return str(value) if value else None


async def get_openai_api_key(config: AddonConfig) -> str | None:
    """The add-on option takes priority if the user has explicitly set one
    (Settings > Add-ons > Cache > Configuration); otherwise falls back to an
    `openai_api_key` entry in secrets.yaml, for users who already have one
    for another integration/automation, and finally to the key the old
    integration had in its config entry options, if migrate.py imported
    one."""
    if config.openai_api_key:
        return config.openai_api_key

    def _fallbacks() -> str | None:
        return _read_secrets_file_key(
            config.ha_config_dir / "secrets.yaml"
        ) or _read_imported_key(config.imported_secrets_path)

    return await asyncio.to_thread(_fallbacks)


async def _extract_fields(session: aiohttp.ClientSession, api_key: str, content: list) -> dict:
    """Shared request/response handling for both extraction paths - `content`
    is an OpenAI chat "content parts" list (text, and optionally an
    image_url part)."""
    payload = {
        "model": OPENAI_VISION_MODEL,
        "messages": [{"role": "user", "content": content}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "ammo_box_fields",
                "strict": True,
                "schema": _EXTRACTION_SCHEMA,
            },
        },
        "max_tokens": 500,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    try:
        async with session.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            body = await resp.json()
            if resp.status != 200:
                message = (body.get("error") or {}).get("message", f"HTTP {resp.status}")
                raise OpenAIError(f"OpenAI request failed: {message}")
    except aiohttp.ClientError as err:
        raise OpenAIError(f"Could not reach OpenAI: {err}") from err

    try:
        message_content = body["choices"][0]["message"]["content"]
        return json.loads(message_content)
    except (KeyError, IndexError, json.JSONDecodeError) as err:
        _LOGGER.error("Unexpected OpenAI response shape: %s", body)
        raise OpenAIError("OpenAI returned an unexpected response") from err


async def scan_ammo_box(
    session: aiohttp.ClientSession, api_key: str, image_bytes: bytes, content_type: str
) -> dict:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    content = [
        {"type": "text", "text": _IMAGE_PROMPT},
        {"type": "image_url", "image_url": {"url": f"data:{content_type};base64,{b64}"}},
    ]
    return await _extract_fields(session, api_key, content)


async def extract_ammo_fields_from_text(
    session: aiohttp.ClientSession, api_key: str, listing_text: str
) -> dict:
    """Same structured extraction as scan_ammo_box, but from a barcode
    lookup's product listing text (title/brand/description) instead of a
    photo - see http.py's CacheLookupAmmoBarcodeView."""
    content = [{"type": "text", "text": _TEXT_PROMPT + listing_text}]
    return await _extract_fields(session, api_key, content)


async def remove_background(
    session: aiohttp.ClientSession, api_key: str, image_bytes: bytes, content_type: str
) -> bytes:
    """Sends a firearm/part photo to OpenAI's image edit endpoint to isolate
    it on a transparent background (see http.py's CacheUploadPhotoView).
    Returns the resulting PNG bytes; a transparent background always comes
    back as PNG regardless of the input format."""
    form = aiohttp.FormData()
    form.add_field("model", OPENAI_IMAGE_MODEL)
    form.add_field("image", image_bytes, filename="upload", content_type=content_type)
    form.add_field("prompt", _BACKGROUND_REMOVAL_PROMPT)
    form.add_field("background", "transparent")
    form.add_field("size", "auto")
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with session.post(
            OPENAI_IMAGES_EDIT_URL,
            data=form,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=60),
        ) as resp:
            body = await resp.json()
            if resp.status != 200:
                message = (body.get("error") or {}).get("message", f"HTTP {resp.status}")
                raise OpenAIError(f"OpenAI request failed: {message}")
    except aiohttp.ClientError as err:
        raise OpenAIError(f"Could not reach OpenAI: {err}") from err

    try:
        b64 = body["data"][0]["b64_json"]
        return base64.b64decode(b64)
    except (KeyError, IndexError, ValueError) as err:
        _LOGGER.error("Unexpected OpenAI image response shape: %s", body)
        raise OpenAIError("OpenAI returned an unexpected response") from err
