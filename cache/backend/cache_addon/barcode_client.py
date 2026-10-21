"""UPC/EAN barcode lookup via UPCitemdb's free trial endpoint (no API key -
see https://www.upcitemdb.com/wp/docs/main/development/trial-api/, rate
limited to 100 lookups/day, 1 per 5s, per IP)."""
from __future__ import annotations

import aiohttp

from .const import UPCITEMDB_TRIAL_URL


class UpcLookupError(Exception):
    """Raised for a genuine request failure (network, rate limit, bad
    response shape) - distinct from UpcNotFoundError so the http view can
    return a more specific message for "barcode isn't in the database"."""


class UpcNotFoundError(Exception):
    """Raised when the barcode isn't in UPCitemdb's database."""


async def lookup_upc(session: aiohttp.ClientSession, barcode: str) -> dict:
    """Returns the raw first matching item (title/brand/description/etc,
    shape defined by UPCitemdb) - turning that into our structured ammo
    fields is the caller's job (see http.py), not this module's."""
    try:
        async with session.get(
            UPCITEMDB_TRIAL_URL,
            params={"upc": barcode},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            # content_type=None: UPCitemdb doesn't always set an
            # application/json Content-Type header, which aiohttp would
            # otherwise treat as an error before we get a chance to parse it.
            body = await resp.json(content_type=None)
    except (aiohttp.ClientError, ValueError) as err:
        raise UpcLookupError(f"Could not reach the barcode lookup service: {err}") from err

    if not isinstance(body, dict):
        raise UpcLookupError("Barcode lookup service returned an unexpected response")
    if body.get("code") != "OK" or not body.get("items"):
        raise UpcNotFoundError(f"No product found for barcode {barcode}")

    return body["items"][0]


def listing_text(item: dict) -> str:
    """Concatenates whatever descriptive fields UPCitemdb returned into one
    blob for openai_client.extract_ammo_fields_from_text to parse."""
    parts = [item.get("title"), item.get("brand"), item.get("description")]
    return " - ".join(str(p) for p in parts if p)


def fallback_fields(item: dict) -> dict:
    """Used when no OpenAI key is configured (or the extraction call
    fails) - a plain field-for-field mapping instead of LLM-parsed
    structured data. Better than nothing: manufacturer/product_name still
    prefill, everything else is left for the user to fill in."""
    return {
        "caliber": None,
        "manufacturer": item.get("brand") or None,
        "product_name": item.get("title") or None,
        "bullet_weight": None,
        "bullet_type": None,
        "muzzle_velocity": None,
        "rounds_per_box": None,
    }
