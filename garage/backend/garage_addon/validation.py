"""The three `homeassistant.helpers.config_validation` validators services.py
uses, reimplemented with the same behavior so its schemas carry over from
the integration unchanged (imported there as `cv`)."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

_TRUE = {"1", "true", "yes", "on", "enable"}
_FALSE = {"0", "false", "no", "off", "disable"}


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
        normalized = value.lower().strip()
        if normalized in _TRUE:
            return True
        if normalized in _FALSE:
            return False
    elif isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    raise vol.Invalid(f"invalid boolean value {value}")


def ensure_list(value: Any) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]
