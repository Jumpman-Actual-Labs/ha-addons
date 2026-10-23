"""One versioned JSON document on disk, in the same envelope Home
Assistant's `Store` helper writes (`{"version", "minor_version", "key",
"data"}`) - so the integration's `.storage/finance_data_<entry_id>` file can
be imported byte-for-byte (see migrate.py) and the migration hook below
keeps working exactly as it did under `Store._async_migrate_func`.

Add new top-level keys for future modules rather than changing existing key
shapes - bump `STORAGE_VERSION` and add a migration in
`_async_migrate_func` if a shape must change."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from .const import (
    DEFAULT_CATEGORIES,
    STORAGE_KEY,
    STORAGE_VERSION,
    FinanceMode,
    ResponsibilityMethod,
    SavingsType,
)
from .models import Category, new_id


def default_data() -> dict[str, Any]:
    return {
        "version": STORAGE_VERSION,
        "mode": FinanceMode.SPLIT.value,
        "responsibility_method": ResponsibilityMethod.AUTOMATIC.value,
        "members": [],
        "categories": [
            Category(id=new_id(), name=name, is_custom=False).to_dict()
            for name in DEFAULT_CATEGORIES
        ],
        "bills": [],
        "payments": [],
        "settlements": [],
        "savings_type": SavingsType.FIXED_AMOUNT.value,
        "savings_value": 0.0,
        "savings_plans": [],
        "savings_deposits": [],
        "cash_infusions": [],
        "category_expenses": [],
        "archive": {},
    }


class FinanceStore:
    """Versioned storage for Stash data, with a migration hook for future schema changes."""

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
