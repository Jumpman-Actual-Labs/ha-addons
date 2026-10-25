"""One versioned JSON document on disk, in the same envelope Home
Assistant's `Store` helper writes (`{"version", "minor_version", "key",
"data"}`) - so the integration's `.storage/hustle_data_<entry_id>` file can
be imported byte-for-byte (see migrate.py) and the migration hook below
keeps working exactly as it did under `Store._async_migrate_func`.

Add new top-level keys for future modules rather than changing existing key
shapes - bump `STORAGE_VERSION` and add a migration in
`HustleStore._async_migrate_func` if a shape must change."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from .const import _GRADE_SORT_ORDER, DEFAULT_GRADE_VALUES_CENTS, STORAGE_KEY, STORAGE_VERSION
from .models import GradeScaleEntry


def default_data() -> dict[str, Any]:
    return {
        "version": STORAGE_VERSION,
        "household": None,
        "payroll_config": None,
        "members": [],
        "chore_definitions": [],
        "chore_assignments": [],
        "bounties": [],
        "subjects": [],
        "grade_scale": [
            GradeScaleEntry(
                letter=letter, value_cents=value_cents, sort_order=_GRADE_SORT_ORDER.get(letter, 99)
            ).to_dict()
            for letter, value_cents in DEFAULT_GRADE_VALUES_CENTS.items()
        ],
        "grade_entries": [],
        "behavior_types": [],
        "behavior_entries": [],
        "pay_periods": [],
        "paychecks": [],
        "earnings_reset_at": None,
        "recent_activity": [],
        "calendar_settings": default_calendar_settings(),
        "event_tags": {},
        "grocery_list": {"categories": [], "generated_at": None},
        "recipes": [],
    }


def default_calendar_settings() -> dict[str, Any]:
    """Which Home Assistant entities the add-on uses: `calendar.*` ones
    (none until a parent picks them in the panel, or the Household import
    fills in the dinners calendar - see migrate.py) and the `todo.*` list
    behind the Shopping tab."""
    return {
        # Shown on the Calendar tab's week grid.
        "family_calendars": [],
        # Where events added from the panel go.
        "default_calendar": None,
        # The Meals tab's dinner board (Household's `calendar_entity`).
        "dinners_calendar": None,
        # Dinners also show on the Calendar tab's all-day row.
        "show_dinners": True,
        # The Shopping tab - Home Assistant's own Shopping List integration
        # unless a parent picks another to-do list.
        "shopping_list": "todo.shopping_list",
    }


class HustleStore:
    """Versioned storage for Hustle data, with a migration hook for future schema changes."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = asyncio.Lock()

    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict
    ) -> dict:
        # No migrations needed yet - this is schema version 1.
        return old_data

    async def async_load(self) -> dict | None:
        envelope = await asyncio.to_thread(self._read)
        if envelope is None:
            return None
        data = envelope.get("data")
        version = envelope.get("version", STORAGE_VERSION)
        if version != STORAGE_VERSION:
            data = await self._async_migrate_func(
                version, envelope.get("minor_version", 1), data
            )
            await self.async_save(data)
        return data

    async def async_save(self, data: dict) -> None:
        envelope = {
            "version": STORAGE_VERSION,
            "minor_version": 1,
            "key": STORAGE_KEY,
            "data": data,
        }
        async with self._lock:
            await asyncio.to_thread(self._write, envelope)

    def _read(self) -> dict | None:
        if not self.path.is_file():
            return None
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _write(self, envelope: dict) -> None:
        # Write-then-rename so a crash mid-write can never leave a truncated
        # document behind - the previous version stays intact until the new
        # one is fully on disk.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(envelope, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)
