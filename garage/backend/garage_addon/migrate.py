"""One-time import from the old `garage` integration.

On first start (no /data/garage.json yet), copies the integration's data
out of the read-only Home Assistant config mount:
- `.storage/garage_data_<entry_id>` - the Store document. Same envelope and
  schema version the add-on's GarageStore uses; only the upload paths
  inside it change (see `rewrite_upload_path`).
- `www/garage_documents/<vehicle_id>/*` and `www/garage_vehicles/<vehicle_id>/*`
  - uploaded documents and vehicle photos, into /data/uploads/documents/
  and /data/uploads/vehicles/.

Nothing under the Home Assistant config dir is modified or deleted - the
integration's copy stays put until the user removes the integration. The
OpenAI key needs no import: the integration only ever read it from
secrets.yaml, which the add-on falls back to as well.
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any

from .config import AddonConfig
from .const import STORAGE_KEY

_LOGGER = logging.getLogger(__name__)

# integration www/ subdirectory -> add-on uploads/ subdirectory
LEGACY_UPLOAD_DIRS = {"garage_documents": "documents", "garage_vehicles": "vehicles"}


def rewrite_upload_path(path: str | None) -> str | None:
    """`/local/garage_vehicles/<id>/photo.jpg?v=1` ->
    `uploads/vehicles/<id>/photo.jpg?v=1`. Anything else is left alone."""
    if not path:
        return path
    for legacy, current in LEGACY_UPLOAD_DIRS.items():
        prefix = f"/local/{legacy}/"
        if path.startswith(prefix):
            return f"uploads/{current}/{path.removeprefix(prefix)}"
    return path


def rewrite_store(envelope: dict[str, Any]) -> dict[str, Any]:
    data = envelope.get("data") or {}
    for vehicle in data.get("vehicles", []):
        vehicle["photo_path"] = rewrite_upload_path(vehicle.get("photo_path"))
    for document in data.get("documents", []):
        document["path"] = rewrite_upload_path(document.get("path"))
    return envelope


def _newest_store_file(storage_dir: Path) -> Path | None:
    # A removed-and-re-added integration leaves the old entry's file behind
    # too. The most recently written one is the live one.
    candidates = [p for p in storage_dir.glob(f"{STORAGE_KEY}_*") if p.is_file()]
    return max(candidates, key=lambda p: p.stat().st_mtime, default=None)


def _copy_tree(source: Path, dest: Path) -> int:
    if not source.is_dir():
        return 0
    copied = 0
    for path in source.rglob("*"):
        target = dest / path.relative_to(source)
        if path.is_file() and not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            copied += 1
    return copied


def migrate_from_integration(config: AddonConfig) -> bool:
    """Returns True if an import happened. Idempotent: once garage.json
    exists this never runs again, even if the integration's files are still
    there. The store is written last, so a crash partway through just
    retries the whole import on the next start."""
    if config.store_path.exists():
        return False

    storage_dir = config.ha_config_dir / ".storage"
    store_file = _newest_store_file(storage_dir) if storage_dir.is_dir() else None
    if store_file is None:
        return False

    envelope = json.loads(store_file.read_text(encoding="utf-8"))
    config.data_dir.mkdir(parents=True, exist_ok=True)
    copied = sum(
        _copy_tree(config.ha_config_dir / "www" / legacy, config.uploads_dir / current)
        for legacy, current in LEGACY_UPLOAD_DIRS.items()
    )
    tmp = config.store_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(rewrite_store(envelope), indent=2), encoding="utf-8")
    tmp.replace(config.store_path)

    _LOGGER.info(
        "Imported Garage integration data from %s (%d uploaded files). Remove "
        "the Garage integration from Settings > Devices & Services once you've "
        "confirmed everything is here.",
        store_file.name,
        copied,
    )
    return True
