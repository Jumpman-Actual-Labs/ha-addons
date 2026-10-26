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
    # Supervisor's proxy to Home Assistant Core (config.yaml's
    # `homeassistant_api: true`) - used for Stash sync, driver
    # notifications and the HA user list.
    core_api_url: str = "http://supervisor/core"
    # This container's hostname on Supervisor's add-on network,
    # `<repository hash>-garage` - the Stash add-on's is the same with
    # `-stash` (see stash_client.py).
    hostname: str = ""

    @property
    def store_path(self) -> Path:
        return self.data_dir / "garage.json"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"


def load_config() -> AddonConfig:
    data_dir = Path(os.environ.get("GARAGE_DATA_DIR", "/data"))
    options: dict = {}
    options_path = data_dir / "options.json"
    if options_path.is_file():
        options = json.loads(options_path.read_text(encoding="utf-8"))

    return AddonConfig(
        data_dir=data_dir,
        ha_config_dir=Path(os.environ.get("GARAGE_HA_CONFIG_DIR", "/homeassistant")),
        static_dir=Path(os.environ.get("GARAGE_STATIC_DIR", "/app/static")),
        port=int(os.environ.get("GARAGE_PORT", "8099")),
        openai_api_key=str(options.get("openai_api_key") or ""),
        mqtt_enabled=bool(options.get("mqtt_enabled", True)),
        log_level=str(options.get("log_level") or "info"),
        allowed_users=tuple(
            str(name).strip().casefold()
            for name in options.get("allowed_users") or []
            if str(name).strip()
        ),
        supervisor_token=os.environ.get("SUPERVISOR_TOKEN", ""),
        core_api_url=os.environ.get("GARAGE_CORE_API_URL", "http://supervisor/core"),
        hostname=os.environ.get("HOSTNAME", ""),
    )
