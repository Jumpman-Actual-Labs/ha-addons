"""The one `homeassistant.helpers.config_validation` validator services.py
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
