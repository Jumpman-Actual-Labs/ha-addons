"""Best-effort AI image generation for chore definitions.

Chore images are cosmetic - a slow or failed call to OpenAI must never
block chore creation/editing. Every public function here swallows its own
errors and returns None on failure; callers fire these from a background
task (`hass.async_create_task`) rather than awaiting them inline.

`hass` is the add-on's bridge (bridge.py): its `session` and `images_dir`
replace HA's shared client session and `config/www/hustle_images/`.
"""

from __future__ import annotations

import asyncio
import base64
import logging

import aiohttp

from .bridge import HassBridge

_LOGGER = logging.getLogger(__name__)

_OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations"
_IMAGE_MODEL = "gpt-image-1"
_IMAGE_SIZE = "1024x1024"
_REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=60)


def _build_prompt(title: str, description: str | None) -> str:
    parts = [
        f"A minimalist modern flat-vector icon representing the household "
        f"chore '{title}', in the style of a clean app icon: one simple "
        f"centered subject, bold simple shapes, no gradients, no shading, "
        f"no outlines/line-art, generous negative space, on a solid pure "
        f"black background (#000000, no gradient, no vignette, no texture). "
        f"Choose whatever color palette best suits the subject itself."
    ]
    if description:
        parts.append(f"Context (do not depict literally, just for subject matter): {description}.")
    parts.append("No text, letters, numbers, or words anywhere in the image. Not photorealistic.")
    return " ".join(parts)


async def async_generate_chore_image_bytes(
    hass: HassBridge, api_key: str, title: str, description: str | None
) -> bytes | None:
    """Calls OpenAI's image generation API and returns raw PNG bytes, or
    None if the call fails for any reason."""
    session = hass.session
    if session is None:
        return None
    try:
        response = await session.post(
            _OPENAI_IMAGES_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": _IMAGE_MODEL,
                "prompt": _build_prompt(title, description),
                "size": _IMAGE_SIZE,
                "n": 1,
            },
            timeout=_REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        payload = await response.json()
        b64 = payload["data"][0]["b64_json"]
        return base64.b64decode(b64)
    except Exception:  # noqa: BLE001 - best-effort, must never raise
        _LOGGER.exception("Failed to generate chore image for %r", title)
        return None


async def async_save_chore_image(hass: HassBridge, chore_id: str, image_bytes: bytes) -> str:
    """Writes the image to /data/images/ (served by web.py at `images/`)
    and returns its relative URL path - relative because ingress serves the
    panel under a per-session prefix. The panel appends `?v=<updated_at>`,
    so a regenerated image isn't served stale from the browser cache."""
    directory = hass.images_dir
    file_path = directory / f"{chore_id}.png"

    def _write() -> None:
        directory.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(image_bytes)

    await asyncio.to_thread(_write)
    return f"images/{chore_id}.png"
