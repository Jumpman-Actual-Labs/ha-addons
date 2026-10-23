"""One-time import from the old `finance` (Stash) integration.

On first start (no /data/stash.json yet), copies the integration's Store
document - `.storage/finance_data_<entry_id>` - out of the read-only Home
Assistant config mount. Same envelope and schema version the add-on's
FinanceStore uses, so it's copied as-is: ids don't change, which keeps
Garage's links to expenses it synced into Stash working.

Nothing under the Home Assistant config dir is modified or deleted - the
integration's copy stays put until the user removes the integration. There
are no uploads or credentials to bring over.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .config import AddonConfig
from .const import STORAGE_KEY

_LOGGER = logging.getLogger(__name__)


def _newest_store_file(storage_dir: Path) -> Path | None:
    # A removed-and-re-added integration leaves the old entry's file behind
    # too. The most recently written one is the live one.
    candidates = [p for p in storage_dir.glob(f"{STORAGE_KEY}_*") if p.is_file()]
    return max(candidates, key=lambda p: p.stat().st_mtime, default=None)


def migrate_from_integration(config: AddonConfig) -> bool:
    """Returns True if an import happened. Idempotent: once stash.json
    exists this never runs again, even if the integration's file is still
    there."""
    if config.store_path.exists():
        return False

    storage_dir = config.ha_config_dir / ".storage"
    store_file = _newest_store_file(storage_dir) if storage_dir.is_dir() else None
    if store_file is None:
        return False

    envelope = json.loads(store_file.read_text(encoding="utf-8"))
    config.data_dir.mkdir(parents=True, exist_ok=True)
    tmp = config.store_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(envelope, indent=2), encoding="utf-8")
    tmp.replace(config.store_path)

    _LOGGER.info(
        "Imported Stash integration data from %s. Remove the Stash integration "
        "from Settings > Devices & Services (and its panel_custom entry from "
        "configuration.yaml) once you've confirmed everything is here.",
        store_file.name,
    )
    return True
