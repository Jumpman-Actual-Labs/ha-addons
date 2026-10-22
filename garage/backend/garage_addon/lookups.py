"""The integration's two read-only helper lookups, ported from its http.py:
- `analyze_fuel_photo` reads a fuel pump display photo via OpenAI's vision
  API, to pre-fill the Add Fuel form (never writes a fuel entry itself).
- `decode_vin` asks NHTSA's free vPIC decoder for year/make/model/trim/
  drivetrain/fuel type and, when an OpenAI key is configured, OpenAI for
  tank/oil capacity (not in any regulatory database - a best-effort guess
  to verify, silently skipped without a key).

Plain aiohttp REST rather than the `openai` pip package. The OpenAI key
comes from the add-on's `openai_api_key` option, falling back to an
`openai_api_key` entry in Home Assistant's secrets.yaml (where the
integration read it from) - never logged, never returned to a caller.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging

import aiohttp
import yaml

from .config import AddonConfig

_LOGGER = logging.getLogger(__name__)

OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_MODEL = "gpt-4o-mini"
OPENAI_SECRET_KEY = "openai_api_key"
NHTSA_DECODE_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json"

FUEL_PHOTO_PROMPT = (
    'You are reading a fuel pump\'s digital display from a photo. Extract the '
    'total dollar amount charged (labeled "This Sale" or similar) and the '
    "number of gallons dispensed. Respond with strict JSON only, no markdown, "
    'matching this shape: {"amount_dollars": number or null, '
    '"gallons": number or null, "price_per_gallon": number or null}. If a '
    "field cannot be read, use null."
)

CAPACITY_LOOKUP_PROMPT_TEMPLATE = (
    "For a {year} {make} {model} {trim}, what is the fuel tank capacity in "
    "US gallons and the engine oil capacity in US quarts (including the "
    "filter)? These are typically not in regulatory databases, so answer "
    "from general automotive spec knowledge. Respond with strict JSON only, "
    'no markdown, matching this shape: {{"tank_capacity_gal": number or '
    'null, "oil_capacity_qt": number or null}}. Use null if you are not '
    "reasonably confident."
)


class LookupFailed(Exception):
    """A lookup failed - `status` is the HTTP status web.py should answer with."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def _read_secrets_key(config: AddonConfig) -> str | None:
    secrets_path = config.ha_config_dir / "secrets.yaml"
    if not secrets_path.is_file():
        return None
    try:
        secrets = yaml.safe_load(secrets_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        _LOGGER.warning("Couldn't read secrets.yaml for an OpenAI key")
        return None
    value = secrets.get(OPENAI_SECRET_KEY) if isinstance(secrets, dict) else None
    return str(value).strip() if value else None


async def get_openai_api_key(config: AddonConfig) -> str | None:
    """Read fresh on every call, so changing either source takes effect on
    the next lookup without restarting the add-on."""
    if config.openai_api_key.strip():
        return config.openai_api_key.strip()
    return await asyncio.to_thread(_read_secrets_key, config)


def map_drivetrain(value: str | None) -> str | None:
    if not value:
        return None
    text = value.upper()
    if "4WD" in text or "4X4" in text or "4-WHEEL" in text:
        return "4wd"
    if "AWD" in text or "ALL-WHEEL" in text or "ALL WHEEL" in text:
        return "awd"
    if "RWD" in text or "REAR-WHEEL" in text or "REAR WHEEL" in text:
        return "rwd"
    if "FWD" in text or "FRONT-WHEEL" in text or "FRONT WHEEL" in text:
        return "fwd"
    return None


def map_fuel_type(value: str | None) -> str | None:
    if not value:
        return None
    text = value.lower()
    if "hybrid" in text:
        return "hybrid"
    if "electric" in text:
        return "electric"
    if "diesel" in text:
        return "diesel"
    if "flex" in text:
        return "flex"
    if "gasoline" in text:
        return "gasoline"
    return None


async def analyze_fuel_photo(
    session: aiohttp.ClientSession, api_key: str, image: bytes, content_type: str
) -> dict:
    data_url = f"data:{content_type};base64,{base64.b64encode(image).decode()}"
    try:
        async with session.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": OPENAI_MODEL,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": FUEL_PHOTO_PROMPT},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    }
                ],
                "max_tokens": 200,
            },
            timeout=aiohttp.ClientTimeout(total=30),
        ) as response:
            payload = await response.json(content_type=None)
            if response.status != 200:
                error_message = (payload.get("error") or {}).get(
                    "message", "OpenAI request failed"
                )
                _LOGGER.warning("OpenAI fuel photo analysis failed: %s", error_message)
                raise LookupFailed(error_message)
    except (TimeoutError, aiohttp.ClientError, ValueError) as err:
        _LOGGER.exception("Failed to reach OpenAI for fuel photo analysis")
        raise LookupFailed("Failed to reach OpenAI") from err

    try:
        parsed = json.loads(payload["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError, ValueError) as err:
        _LOGGER.warning("Unexpected OpenAI response shape: %s", payload)
        raise LookupFailed("Could not parse OpenAI response") from err

    return {
        "amount_dollars": parsed.get("amount_dollars"),
        "gallons": parsed.get("gallons"),
        "price_per_gallon": parsed.get("price_per_gallon"),
    }


async def _lookup_capacities_via_openai(
    session: aiohttp.ClientSession,
    api_key: str,
    year: int | None,
    make: str | None,
    model: str | None,
    trim: str | None,
) -> dict:
    """Best-effort supplement to the NHTSA decode - tank/oil capacity aren't
    in any free regulatory database, but a general-knowledge model has often
    seen the spec sheet. Treat as a starting guess to verify, not a source of
    truth: never blocks the rest of decode_vin if it fails.
    """
    if not (year and make and model):
        _LOGGER.warning(
            "Skipping capacity lookup - missing year/make/model from NHTSA "
            "(year=%s make=%s model=%s)",
            year,
            make,
            model,
        )
        return {}
    prompt = CAPACITY_LOOKUP_PROMPT_TEMPLATE.format(
        year=year, make=make, model=model, trim=trim or ""
    )
    try:
        async with session.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": OPENAI_MODEL,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 100,
            },
            timeout=aiohttp.ClientTimeout(total=20),
        ) as response:
            if response.status != 200:
                _LOGGER.warning(
                    "OpenAI capacity lookup got HTTP %s: %s",
                    response.status,
                    await response.text(),
                )
                return {}
            payload = await response.json(content_type=None)
        parsed = json.loads(payload["choices"][0]["message"]["content"])
    except Exception:
        _LOGGER.warning("OpenAI capacity lookup failed, leaving fields blank", exc_info=True)
        return {}

    tank = parsed.get("tank_capacity_gal")
    oil = parsed.get("oil_capacity_qt")
    if tank is None and oil is None:
        # Valid JSON came back (response_format only guarantees that, not our
        # exact key names), but neither expected key had a usable value -
        # this fails silently otherwise, indistinguishable from "no key
        # configured" from the frontend's point of view.
        _LOGGER.warning("OpenAI capacity lookup returned no usable values: %s", parsed)
    return {"tank_capacity_gal": tank, "oil_capacity_qt": oil}


async def decode_vin(session: aiohttp.ClientSession, vin: str, api_key: str | None) -> dict:
    try:
        async with session.get(
            NHTSA_DECODE_URL.format(vin=vin), timeout=aiohttp.ClientTimeout(total=15)
        ) as response:
            if response.status != 200:
                raise LookupFailed("VIN decode request failed")
            payload = await response.json(content_type=None)
    except (TimeoutError, aiohttp.ClientError, ValueError) as err:
        _LOGGER.exception("Failed to reach NHTSA VIN decoder")
        raise LookupFailed("Failed to reach the VIN decoder service") from err

    results = payload.get("Results") or []
    if not results:
        raise LookupFailed("No decode results for this VIN")
    data = results[0]

    # ErrorCode "0" is a clean decode; a handful of others are minor
    # check-digit/model-year warnings that still come with usable data,
    # so only reject when NHTSA itself couldn't make sense of the VIN.
    error_code = str(data.get("ErrorCode") or "0")
    if error_code not in ("0", "1", "6", "11", "14"):
        raise LookupFailed(data.get("ErrorText") or "VIN could not be decoded", status=422)

    year_str = data.get("ModelYear")
    year = int(year_str) if year_str and year_str.isdigit() else None
    make = data.get("Make") or None
    model = data.get("Model") or None
    trim = data.get("Trim") or data.get("Series") or None

    capacities: dict = {}
    if api_key:
        capacities = await _lookup_capacities_via_openai(
            session, api_key, year, make, model, trim
        )

    return {
        "year": year,
        "make": make,
        "model": model,
        "trim": trim,
        "drivetrain": map_drivetrain(data.get("DriveType")),
        "fuel_type": map_fuel_type(data.get("FuelTypePrimary")),
        "tank_capacity_gal": capacities.get("tank_capacity_gal"),
        "oil_capacity_qt": capacities.get("oil_capacity_qt"),
    }
