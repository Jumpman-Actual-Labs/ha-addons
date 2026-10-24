"""One-time import from the old `gains` integration.

On first start (no /data/gains.json yet), copies the integration's data out
of the read-only Home Assistant config mount:
- `.storage/gains_data` - the Store document. Same envelope and schema
  version the add-on's GainsStore uses, so it's copied as-is: profile,
  workout and program ids don't change, and every athlete keeps the Home
  Assistant user id their profile is keyed by.
- the AI provider settings from the config entry's options (provider, API
  keys, models), if any were set there, so Ask Geoffrey keeps working
  without re-entering a key. config.py uses them for any add-on option left
  blank.

Nothing under the Home Assistant config dir is modified or deleted - the
integration's copy stays put until the user removes the integration.
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from .config import AI_SETTING_KEYS, AddonConfig
from .const import DOMAIN, STORAGE_KEY

_LOGGER = logging.getLogger(__name__)


def _import_ai_settings(storage_dir: Path, dest: Path) -> bool:
    entries_file = storage_dir / "core.config_entries"
    if not entries_file.is_file():
        return False
    try:
        entries = json.loads(entries_file.read_text(encoding="utf-8"))["data"]["entries"]
    except (OSError, ValueError, KeyError, TypeError):
        return False
    for entry in entries:
        if entry.get("domain") != DOMAIN:
            continue
        options = entry.get("options") or {}
        settings = {key: options[key] for key in AI_SETTING_KEYS if options.get(key)}
        if settings:
            dest.write_text(json.dumps(settings), encoding="utf-8")
            return True
    return False


def migrate_from_integration(config: AddonConfig) -> bool:
    """Returns True if an import happened. Idempotent: once gains.json
    exists this never runs again, even if the integration's files are still
    there. The store is copied last, so a crash partway through just
    retries the whole import on the next start."""
    if config.store_path.exists():
        return False

    storage_dir = config.ha_config_dir / ".storage"
    # Gains was single-instance and its Store key has no entry id suffix.
    store_file = storage_dir / STORAGE_KEY
    if not store_file.is_file():
        return False

    config.data_dir.mkdir(parents=True, exist_ok=True)
    settings_imported = _import_ai_settings(storage_dir, config.imported_settings_path)
    shutil.copy2(store_file, config.store_path)

    _LOGGER.info(
        "Imported Gains integration data from %s%s. Remove the Gains integration "
        "from Settings > Devices & Services (and its panel_custom entry from "
        "configuration.yaml) once you've confirmed everything is here.",
        store_file.name,
        " (and its AI provider settings)" if settings_imported else "",
    )
    return True
