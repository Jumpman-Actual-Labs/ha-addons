"""_parse_secrets_yaml and get_openai_api_key's priority logic (add-on
option first, then secrets.yaml, then the key imported from the old
integration) are the deterministic pieces of openai_client.py - the network
call itself is out of scope for these fast unit tests."""
from __future__ import annotations

import json

from cache_addon.config import AddonConfig
from cache_addon.openai_client import _parse_secrets_yaml, get_openai_api_key


def _config(tmp_path, option="", secrets_text=None, imported_key=None) -> AddonConfig:
    ha_config = tmp_path / "homeassistant"
    ha_config.mkdir()
    if secrets_text is not None:
        (ha_config / "secrets.yaml").write_text(secrets_text)
    config = AddonConfig(
        data_dir=tmp_path / "data",
        ha_config_dir=ha_config,
        static_dir=tmp_path / "static",
        openai_api_key=option,
    )
    if imported_key is not None:
        config.data_dir.mkdir()
        config.imported_secrets_path.write_text(json.dumps({"openai_api_key": imported_key}))
    return config


def test_parse_secrets_yaml_extracts_key():
    assert _parse_secrets_yaml("openai_api_key: sk-abc123\nother: value\n") == "sk-abc123"


def test_parse_secrets_yaml_none_when_key_missing():
    assert _parse_secrets_yaml("other: value\n") is None


def test_parse_secrets_yaml_none_for_invalid_yaml():
    assert _parse_secrets_yaml("not: valid: yaml: [") is None


def test_parse_secrets_yaml_none_for_non_mapping():
    assert _parse_secrets_yaml("- just\n- a\n- list\n") is None


async def test_get_openai_api_key_none_when_nothing_configured(tmp_path):
    assert await get_openai_api_key(_config(tmp_path)) is None


async def test_get_openai_api_key_prefers_option_over_everything(tmp_path):
    config = _config(
        tmp_path,
        option="sk-from-option",
        secrets_text="openai_api_key: sk-from-secrets\n",
        imported_key="sk-imported",
    )
    assert await get_openai_api_key(config) == "sk-from-option"


async def test_get_openai_api_key_falls_back_to_secrets_yaml(tmp_path):
    config = _config(
        tmp_path, secrets_text="openai_api_key: sk-from-secrets\n", imported_key="sk-imported"
    )
    assert await get_openai_api_key(config) == "sk-from-secrets"


async def test_get_openai_api_key_falls_back_to_imported_key(tmp_path):
    config = _config(tmp_path, secrets_text="other_key: value\n", imported_key="sk-imported")
    assert await get_openai_api_key(config) == "sk-imported"


async def test_get_openai_api_key_none_when_secrets_yaml_lacks_key(tmp_path):
    config = _config(tmp_path, secrets_text="other_key: value\n")
    assert await get_openai_api_key(config) is None
