"""One versioned JSON document on disk, in the same envelope Home
Assistant's `Store` helper writes (`{"version", "minor_version", "key",
"data"}`) - so the integration's `.storage/garage_data_<entry_id>` file can
be imported byte-for-byte (see migrate.py) and the migration hook below
keeps working exactly as it did under `Store._async_migrate_func`."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from .const import (
    DEFAULT_MAINTENANCE_TEMPLATES,
    LOW_FUEL_THRESHOLD_DEFAULT,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .models import MaintenanceTemplate, new_id


def default_data() -> dict[str, Any]:
    return {
        "version": STORAGE_VERSION,
        "vehicles": [],
        "drivers": [],
        "fuel_entries": [],
        "maintenance_templates": [
            MaintenanceTemplate(
                id=new_id(),
                name=t["name"],
                basis=t["basis"].value,
                interval_miles=t["interval_miles"],
                interval_months=t["interval_months"],
                is_custom=False,
            ).to_dict()
            for t in DEFAULT_MAINTENANCE_TEMPLATES
        ],
        "maintenance_records": [],
        "documents": [],
        "settings": {
            "low_fuel_threshold": LOW_FUEL_THRESHOLD_DEFAULT,
            "finance_sync_enabled": False,
            "finance_category_name": "Transportation",
        },
        "archive": {},
    }


class GarageStore:
    """Versioned storage for Garage data, with a migration hook for future schema changes."""

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
