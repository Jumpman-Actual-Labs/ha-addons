"""One-time import from the old `cache` integration.

On first start (no /data/cache.json yet), copies the integration's data out
of the read-only Home Assistant config mount:
- `.storage/cache_data_<entry_id>` - the Store document. Same envelope and
  schema version the add-on's CacheStore uses, so it's copied as-is.
- `www/cache_uploads/*` - every uploaded photo/document/diagram image.
- the OpenAI API key from the config entry's options, if one was set there
  (so photo uploads keep working without re-entering it).

Nothing under the Home Assistant config dir is modified or deleted - the
integration's copy stays put until the user removes the integration.
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from .config import AddonConfig
from .const import DOMAIN, LEGACY_UPLOADS_SUBPATH, STORAGE_KEY

_LOGGER = logging.getLogger(__name__)


def _newest_store_file(storage_dir: Path) -> Path | None:
    # Cache was single-instance, so there should only ever be one - but a
    # removed-and-re-added integration leaves the old entry's file behind
    # too. The most recently written one is the live one.
    candidates = [p for p in storage_dir.glob(f"{STORAGE_KEY}_*") if p.is_file()]
    return max(candidates, key=lambda p: p.stat().st_mtime, default=None)


def _copy_uploads(source: Path, dest: Path) -> int:
    if not source.is_dir():
        return 0
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
    for path in source.iterdir():
        target = dest / path.name
        if path.is_file() and not target.exists():
            shutil.copy2(path, target)
            copied += 1
    return copied


def _import_openai_key(storage_dir: Path, dest: Path) -> bool:
    entries_file = storage_dir / "core.config_entries"
    if not entries_file.is_file():
        return False
    try:
        entries = json.loads(entries_file.read_text(encoding="utf-8"))["data"]["entries"]
    except (OSError, ValueError, KeyError, TypeError):
        return False
    for entry in entries:
        if entry.get("domain") == DOMAIN:
            key = (entry.get("options") or {}).get("openai_api_key")
            if key:
                dest.write_text(json.dumps({"openai_api_key": key}), encoding="utf-8")
                return True
    return False


def migrate_from_integration(config: AddonConfig) -> bool:
    """Returns True if an import happened. Idempotent: once cache.json
    exists this never runs again, even if the integration's files are still
    there. The store is copied last, so a crash partway through just
    retries the whole import on the next start."""
    if config.store_path.exists():
        return False

    storage_dir = config.ha_config_dir / ".storage"
    store_file = _newest_store_file(storage_dir) if storage_dir.is_dir() else None
    if store_file is None:
        return False

    config.data_dir.mkdir(parents=True, exist_ok=True)
    legacy_uploads = config.ha_config_dir.joinpath(*LEGACY_UPLOADS_SUBPATH)
    copied = _copy_uploads(legacy_uploads, config.uploads_dir)
    key_imported = _import_openai_key(storage_dir, config.imported_secrets_path)
    shutil.copy2(store_file, config.store_path)

    _LOGGER.info(
        "Imported Cache integration data from %s (%d uploaded files%s). "
        "Remove the Cache integration from Settings > Devices & Services once "
        "you've confirmed everything is here.",
        store_file.name,
        copied,
        ", OpenAI key" if key_imported else "",
    )
    return True
