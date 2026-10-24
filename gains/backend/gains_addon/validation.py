"""The two `homeassistant.helpers.config_validation` validators services.py
uses, reimplemented with the same behavior so its schemas carry over from
the integration unchanged (imported there as `cv`)."""
from __future__ import annotations

from typing import Any

import voluptuous as vol


def string(value: Any) -> str:
    if value is None:
        raise vol.Invalid("string value is None")
    if isinstance(value, (list, dict)):
        raise vol.Invalid("value should be a string")
    return str(value)


def boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.lower().strip()
        if lowered in ("1", "true", "yes", "on", "enable"):
            return True
        if lowered in ("0", "false", "no", "off", "disable"):
            return False
    elif isinstance(value, (int, float)):
        return bool(value)
    raise vol.Invalid(f"invalid boolean value {value}")
