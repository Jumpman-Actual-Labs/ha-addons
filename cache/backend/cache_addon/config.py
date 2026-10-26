"""Where the add-on keeps things, and its Supervisor-provided options.

Every path is overridable by environment variable so the backend runs (and
is testable) outside the add-on container - nothing here assumes it's
actually inside Supervisor.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class AddonConfig:
    data_dir: Path
    # The Home Assistant config directory, mapped read-only into the
    # container (config.yaml's `homeassistant_config:ro`) - read only by
    # migrate.py's one-time import and the secrets.yaml key fallback.
    ha_config_dir: Path
    static_dir: Path
    port: int = 8099
    openai_api_key: str = ""
    mqtt_enabled: bool = True
    log_level: str = "info"
    # The Configuration tab's Allowed users, stripped and casefolded so
    # web.py can compare them as-is. Empty means everyone.
    allowed_users: tuple[str, ...] = ()
    supervisor_token: str = ""

    @property
    def store_path(self) -> Path:
        return self.data_dir / "cache.json"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def imported_secrets_path(self) -> Path:
        return self.data_dir / "imported_secrets.json"


def load_config() -> AddonConfig:
    data_dir = Path(os.environ.get("CACHE_DATA_DIR", "/data"))
    options: dict = {}
    options_path = data_dir / "options.json"
    if options_path.is_file():
        options = json.loads(options_path.read_text(encoding="utf-8"))

    return AddonConfig(
        data_dir=data_dir,
        ha_config_dir=Path(os.environ.get("CACHE_HA_CONFIG_DIR", "/homeassistant")),
        static_dir=Path(os.environ.get("CACHE_STATIC_DIR", "/app/static")),
        port=int(os.environ.get("CACHE_PORT", "8099")),
        openai_api_key=str(options.get("openai_api_key") or ""),
        mqtt_enabled=bool(options.get("mqtt_enabled", True)),
        log_level=str(options.get("log_level") or "info"),
        allowed_users=tuple(
            str(name).strip().casefold()
            for name in options.get("allowed_users") or []
            if str(name).strip()
        ),
        supervisor_token=os.environ.get("SUPERVISOR_TOKEN", ""),
    )
