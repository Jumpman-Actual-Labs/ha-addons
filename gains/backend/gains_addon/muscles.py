"""Versioned display metadata for the original Gains muscle maps."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_CATALOG: dict[str, Any] = json.loads(Path(__file__).with_name("muscles.json").read_text())
MUSCLE_CATALOG_VERSION: str = _CATALOG["catalogVersion"]
MUSCLE_DICTIONARY: dict[str, dict[str, str]] = _CATALOG["muscles"]
MUSCLES_BY_EXERCISE: dict[str, dict[str, list[str]]] = _CATALOG["exercises"]
