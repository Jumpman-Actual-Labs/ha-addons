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
    # Chore images use OpenAI; meal planning uses whichever of OpenAI or
    # Anthropic has a key (`ai_provider` picks when both do). Blank falls
    # back to the same-named secrets.yaml entries - see meals.py.
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    ai_provider: str = "openai"
    mqtt_enabled: bool = True
    log_level: str = "info"
    supervisor_token: str = ""
    # Supervisor's proxy to Home Assistant Core (config.yaml's
    # `homeassistant_api: true`) - used for member notifications,
    # `hustle_*` events and the HA user list.
    core_api_url: str = "http://supervisor/core"
    # Dev runs only (HUSTLE_ALLOW_ANY_CLIENT): who the viewer is, since
    # there are no ingress headers. Must match a member's ha_user_id to use
    # the panel.
    dev_user_id: str = ""
    # This container's hostname on Supervisor's add-on network,
    # `<repository hash>-family-hustle` - Gains' is the same with `-gains`
    # (see workouts.py).
    hostname: str = ""
    # Dev runs only: the Gains add-on's address, since there's no add-on
    # network to find it on (HUSTLE_GAINS_URL).
    gains_url: str = ""

    @property
    def store_path(self) -> Path:
        return self.data_dir / "hustle.json"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"


def load_config() -> AddonConfig:
    data_dir = Path(os.environ.get("HUSTLE_DATA_DIR", "/data"))
    options: dict = {}
    options_path = data_dir / "options.json"
    if options_path.is_file():
        options = json.loads(options_path.read_text(encoding="utf-8"))

    return AddonConfig(
        data_dir=data_dir,
        ha_config_dir=Path(os.environ.get("HUSTLE_HA_CONFIG_DIR", "/homeassistant")),
        static_dir=Path(os.environ.get("HUSTLE_STATIC_DIR", "/app/static")),
        port=int(os.environ.get("HUSTLE_PORT", "8099")),
        openai_api_key=str(options.get("openai_api_key") or ""),
        anthropic_api_key=str(options.get("anthropic_api_key") or ""),
        ai_provider=str(options.get("ai_provider") or "openai"),
        mqtt_enabled=bool(options.get("mqtt_enabled", True)),
        log_level=str(options.get("log_level") or "info"),
        supervisor_token=os.environ.get("SUPERVISOR_TOKEN", ""),
        core_api_url=os.environ.get("HUSTLE_CORE_API_URL", "http://supervisor/core"),
        dev_user_id=os.environ.get("HUSTLE_DEV_USER_ID", ""),
        hostname=os.environ.get("HOSTNAME", ""),
        gains_url=os.environ.get("HUSTLE_GAINS_URL", ""),
    )
