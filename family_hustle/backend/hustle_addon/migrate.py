"""One-time import from the old `hustle` and `household` integrations.

On first start (no /data/hustle.json yet), copies their data out of the
read-only Home Assistant config mount:
- Hustle: `.storage/hustle_data_<entry_id>` - the Store document, same
  envelope and schema version HustleStore uses; only chore image paths
  change (`/local/hustle_images/<id>.png` -> `images/<id>.png`), and the
  images themselves are copied from `www/hustle_images/` to /data/images/.
- Household: the last grocery list (`.storage/household_grocery_list`) and
  the Dinners calendar its config entry pointed at (`calendar_entity` in
  `.storage/core.config_entries`), which becomes the Meals tab's
  `dinners_calendar`. Its AI keys aren't copied - they were config-entry
  options, and the add-on reads its own options or secrets.yaml instead
  (see meals.py).

Nothing under the Home Assistant config dir is modified or deleted - each
integration's copy stays put until the user removes it.
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any

from .config import AddonConfig
from .const import STORAGE_KEY, STORAGE_VERSION
from .storage import default_data

_LOGGER = logging.getLogger(__name__)

LEGACY_IMAGE_PREFIX = "/local/hustle_images/"
HOUSEHOLD_GROCERY_STORE = "household_grocery_list"


def rewrite_image_path(path: str | None) -> str | None:
    """`/local/hustle_images/<id>.png` -> `images/<id>.png`. Anything else is
    left alone (coordinator.async_load already clears the even older
    `/local/hustle/` paths)."""
    if path and path.startswith(LEGACY_IMAGE_PREFIX):
        return f"images/{path.removeprefix(LEGACY_IMAGE_PREFIX)}"
    return path


def rewrite_store(envelope: dict[str, Any]) -> dict[str, Any]:
    data = envelope.get("data") or {}
    for definition in data.get("chore_definitions", []):
        definition["image_path"] = rewrite_image_path(definition.get("image_path"))
    return envelope


def _newest_store_file(storage_dir: Path) -> Path | None:
    # A removed-and-re-added integration leaves the old entry's file behind
    # too. The most recently written one is the live one.
    candidates = [p for p in storage_dir.glob(f"{STORAGE_KEY}_*") if p.is_file()]
    return max(candidates, key=lambda p: p.stat().st_mtime, default=None)


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        _LOGGER.warning("Couldn't read %s - skipping it", path.name)
        return None


def _household_calendar(storage_dir: Path) -> str | None:
    entries = _read_json(storage_dir / "core.config_entries") or {}
    for entry in (entries.get("data") or {}).get("entries", []):
        if entry.get("domain") == "household":
            calendar = (entry.get("data") or {}).get("calendar_entity")
            if calendar:
                return str(calendar)
    return None


def _household_grocery_list(storage_dir: Path) -> dict[str, Any] | None:
    envelope = _read_json(storage_dir / HOUSEHOLD_GROCERY_STORE) or {}
    data = envelope.get("data") or {}
    if not data.get("categories"):
        return None
    return {"categories": data["categories"], "generated_at": data.get("generated_at")}


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


def migrate_from_integrations(config: AddonConfig) -> bool:
    """Returns True if an import happened. Idempotent: once hustle.json
    exists this never runs again, even if the integrations' files are still
    there. The store is written last, so a crash partway through just
    retries the whole import on the next start."""
    if config.store_path.exists():
        return False
    storage_dir = config.ha_config_dir / ".storage"
    if not storage_dir.is_dir():
        return False

    store_file = _newest_store_file(storage_dir)
    dinners_calendar = _household_calendar(storage_dir)
    grocery_list = _household_grocery_list(storage_dir)
    if store_file is None and dinners_calendar is None and grocery_list is None:
        return False

    if store_file is not None:
        envelope = rewrite_store(json.loads(store_file.read_text(encoding="utf-8")))
    else:
        envelope = {
            "version": STORAGE_VERSION,
            "minor_version": 1,
            "key": STORAGE_KEY,
            "data": default_data(),
        }
    data = envelope.setdefault("data", {})
    if dinners_calendar:
        settings = data.setdefault("calendar_settings", {})
        settings["dinners_calendar"] = settings.get("dinners_calendar") or dinners_calendar
    if grocery_list:
        data["grocery_list"] = grocery_list

    config.data_dir.mkdir(parents=True, exist_ok=True)
    copied = _copy_tree(config.ha_config_dir / "www" / "hustle_images", config.images_dir)
    tmp = config.store_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(envelope, indent=2), encoding="utf-8")
    tmp.replace(config.store_path)

    imported = []
    if store_file is not None:
        imported.append(f"Hustle data from {store_file.name} ({copied} chore images)")
    if dinners_calendar:
        imported.append(f"Household's Dinners calendar ({dinners_calendar})")
    if grocery_list:
        imported.append("Household's grocery list")
    _LOGGER.info(
        "Imported %s. Remove the Hustle and Household integrations from Settings > "
        "Devices & Services once you've confirmed everything is here.",
        ", ".join(imported),
    )
    return True
