"""Gains' single versioned JSON document on disk, in the same envelope Home
Assistant's `Store` helper writes (`{"version", "minor_version", "key",
"data"}`) - so the integration's `.storage/gains_data` file can be imported
byte-for-byte (see migrate.py) and the migration hook below keeps working
exactly as it did under `Store._async_migrate_func`.

One document for the whole instance (all athlete profiles). Add new
top-level keys for future modules rather than reshaping existing keys --
bump STORAGE_VERSION and add a step in _async_migrate_func if a shape must
change.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from .const import STORAGE_KEY, STORAGE_VERSION
from .models import GainsData


class GainsStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = asyncio.Lock()

    async def async_load(self) -> GainsData:
        envelope = await asyncio.to_thread(self._read)
        if envelope is None:
            return GainsData.from_dict(None)
        raw = envelope.get("data")
        version = envelope.get("version", STORAGE_VERSION)
        if version != STORAGE_VERSION:
            raw = await self._async_migrate_func(version, envelope.get("minor_version", 1), raw)
        return GainsData.from_dict(raw)

    async def async_save(self, data: GainsData) -> None:
        envelope = {
            "version": STORAGE_VERSION,
            "minor_version": 1,
            "key": STORAGE_KEY,
            "data": data.to_dict(),
        }
        async with self._lock:
            await asyncio.to_thread(self._write, envelope)

    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict[str, Any]
    ) -> dict[str, Any]:
        # No migrations yet -- STORAGE_VERSION is still 1. When a future
        # phase needs to reshape stored data, branch on old_major_version
        # here and return the migrated dict.
        return old_data

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
        tmp.write_text(json.dumps(envelope), encoding="utf-8")
        os.replace(tmp, self.path)
