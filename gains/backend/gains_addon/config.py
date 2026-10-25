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

from .const import (
    AI_PROVIDERS,
    CONF_AI_PROVIDER,
    CONF_ANTHROPIC_API_KEY,
    CONF_ANTHROPIC_MODEL,
    CONF_OPENAI_API_KEY,
    CONF_OPENAI_MODEL,
    DEFAULT_AI_PROVIDER,
    DEFAULT_ANTHROPIC_MODEL,
    DEFAULT_OPENAI_MODEL,
)

AI_SETTING_KEYS = (
    CONF_AI_PROVIDER,
    CONF_ANTHROPIC_API_KEY,
    CONF_ANTHROPIC_MODEL,
    CONF_OPENAI_API_KEY,
    CONF_OPENAI_MODEL,
)


@dataclass
class AddonConfig:
    data_dir: Path
    # The Home Assistant config directory, mapped read-only into the
    # container (config.yaml's `homeassistant_config:ro`) - read only by
    # migrate.py's one-time import.
    ha_config_dir: Path
    static_dir: Path
    port: int = 8099
    ai_provider: str = DEFAULT_AI_PROVIDER
    anthropic_api_key: str = ""
    anthropic_model: str = DEFAULT_ANTHROPIC_MODEL
    openai_api_key: str = ""
    openai_model: str = DEFAULT_OPENAI_MODEL
    mqtt_enabled: bool = True
    log_level: str = "info"
    supervisor_token: str = ""
    # Supervisor's proxy to Home Assistant Core (config.yaml's
    # `homeassistant_api: true`) - used only for account pictures.
    core_api_url: str = "http://supervisor/core"

    @property
    def store_path(self) -> Path:
        return self.data_dir / "gains.json"

    @property
    def imported_settings_path(self) -> Path:
        """The old integration's AI options, if migrate.py found any."""
        return self.data_dir / "imported_settings.json"


def _read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def load_config() -> AddonConfig:
    data_dir = Path(os.environ.get("GAINS_DATA_DIR", "/data"))
    options = _read_json(data_dir / "options.json")
    imported = _read_json(data_dir / "imported_settings.json")

    def setting(key: str, default: str) -> str:
        # An option set in the add-on's Configuration tab wins; otherwise
        # whatever the integration's options flow had, so Ask Geoffrey keeps
        # working after the move without re-entering a key.
        return str(options.get(key) or imported.get(key) or default)

    provider = setting(CONF_AI_PROVIDER, DEFAULT_AI_PROVIDER)
    return AddonConfig(
        data_dir=data_dir,
        ha_config_dir=Path(os.environ.get("GAINS_HA_CONFIG_DIR", "/homeassistant")),
        static_dir=Path(os.environ.get("GAINS_STATIC_DIR", "/app/static")),
        port=int(os.environ.get("GAINS_PORT", "8099")),
        ai_provider=provider if provider in AI_PROVIDERS else DEFAULT_AI_PROVIDER,
        anthropic_api_key=setting(CONF_ANTHROPIC_API_KEY, ""),
        anthropic_model=setting(CONF_ANTHROPIC_MODEL, DEFAULT_ANTHROPIC_MODEL),
        openai_api_key=setting(CONF_OPENAI_API_KEY, ""),
        openai_model=setting(CONF_OPENAI_MODEL, DEFAULT_OPENAI_MODEL),
        mqtt_enabled=bool(options.get("mqtt_enabled", True)),
        log_level=str(options.get("log_level") or "info"),
        supervisor_token=os.environ.get("SUPERVISOR_TOKEN", ""),
        core_api_url=os.environ.get("GAINS_CORE_API_URL", "http://supervisor/core"),
    )
