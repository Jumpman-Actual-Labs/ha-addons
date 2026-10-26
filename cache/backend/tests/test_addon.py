"""The add-on-specific layers around the ported coordinator: the
`hass.states`-shaped snapshot (states.py), MQTT discovery payloads
(mqtt.py), the one-time integration import (migrate.py), the file-backed
store (storage.py), and the HTTP API the panel calls (web.py)."""
from __future__ import annotations

import json
from ipaddress import ip_address

import aiohttp
import pytest

from cache_addon import mqtt, web
from cache_addon.config import AddonConfig, load_config
from cache_addon.coordinator import CacheCoordinator
from cache_addon.migrate import migrate_from_integration
from cache_addon.services import build_service_context
from cache_addon.states import build_states
from cache_addon.storage import CacheStore
from cache_addon.web import create_app


@pytest.fixture
def config(tmp_path) -> AddonConfig:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>cache</html>")
    return AddonConfig(
        data_dir=tmp_path / "data",
        ha_config_dir=tmp_path / "homeassistant",
        static_dir=static,
    )


@pytest.fixture
async def coordinator(config) -> CacheCoordinator:
    coord = CacheCoordinator(CacheStore(config.store_path))
    await coord.async_load()
    return coord


async def _populate(coordinator: CacheCoordinator) -> None:
    location = await coordinator.async_add_storage_location("Main Safe")
    firearm = await coordinator.async_add_firearm(
        custom_name="Test AR", firearm_type="Rifle", caliber="5.56", storage_location_id=location.id
    )
    await coordinator.async_add_ammunition(caliber="5.56", quantity=10)
    item = await coordinator.async_add_inventory_item(
        custom_name="EOTech", category="Optic", part_type="Optic"
    )
    await coordinator.async_install_item(firearm.id, item.id, "Optic")


# ------------------------------------------------------------------ states


async def test_states_snapshot_has_every_marker_attribute_the_panel_scans_for(coordinator):
    await _populate(coordinator)
    states = build_states(coordinator.data)

    cache_keys = {e["attributes"].get("cache_key") for e in states.values()} - {None}
    assert cache_keys == {
        "dashboard_stats",
        "storage_locations",
        "settings",
        "ammo_alert_rules",
        "range_sessions",
        "cleaning_due_count",
        "low_ammo_count",
        "range_schedules",
        "training_plans",
        "training_due_count",
        "training_ammo_alert_count",
    }
    assert sum("firearm_id" in e["attributes"] for e in states.values()) == 1
    assert sum("inventory_item_id" in e["attributes"] for e in states.values()) == 1
    assert sum("ammunition_id" in e["attributes"] for e in states.values()) == 1
    assert all(e["entity_id"].startswith("sensor.") for e in states.values())
    # Must survive the trip over the websocket.
    json.dumps(states)


async def test_states_firearm_entity_matches_old_sensor_shape(coordinator):
    await _populate(coordinator)
    states = build_states(coordinator.data)
    firearm = next(e for e in states.values() if "firearm_id" in e["attributes"])

    assert firearm["state"] == "0"  # lifetime round count, stringified like HA
    assert firearm["attributes"]["storage_location_name"] == "Main Safe"
    assert [i["custom_name"] for i in firearm["attributes"]["installed_items"]] == ["EOTech"]
    assert "photos" in firearm["attributes"]


async def test_deleted_firearm_disappears_from_states(coordinator):
    firearm = await coordinator.async_add_firearm(custom_name="Gone", firearm_type="Rifle")
    await coordinator.async_delete_firearm(firearm.id)
    states = build_states(coordinator.data)
    assert not any("firearm_id" in e["attributes"] for e in states.values())


# -------------------------------------------------------------------- mqtt


async def test_mqtt_low_ammo_flag_and_items(coordinator):
    await coordinator.async_add_ammunition(caliber="9mm", quantity=5)  # below default 50
    messages = mqtt.build_messages(coordinator.data)

    assert messages["cache/binary_sensor/low_ammunition/state"] == "ON"
    assert messages["cache/sensor/low_ammunition/state"] == "1"
    attrs = json.loads(messages["cache/sensor/low_ammunition/attributes"])
    assert attrs == {"items": ["9mm (5 left)"]}
    assert messages["cache/binary_sensor/cleaning_due/state"] == "OFF"


def test_mqtt_discovery_keeps_the_integrations_entity_ids():
    by_key = {(e.component, e.key): e for e in mqtt.ENTITIES}
    for component, key, entity_id in [
        ("binary_sensor", "cleaning_due", "binary_sensor.cache_cleaning_due"),
        ("binary_sensor", "low_ammunition", "binary_sensor.cache_low_ammunition"),
        ("binary_sensor", "training_due", "binary_sensor.cache_training_due"),
        ("binary_sensor", "training_ammo_alert", "binary_sensor.cache_training_ammo_alert"),
        ("sensor", "dashboard_stats", "sensor.cache_dashboard_stats"),
    ]:
        topic, discovery = by_key[(component, key)].discovery()
        assert discovery["default_entity_id"] == entity_id
        assert topic == f"homeassistant/{component}/{entity_id.split('.')[1]}/config"
        assert discovery["availability_topic"] == mqtt.AVAILABILITY_TOPIC

    unique_ids = [e.discovery()[1]["unique_id"] for e in mqtt.ENTITIES]
    assert len(unique_ids) == len(set(unique_ids))


# ------------------------------------------------------------------ storage


async def test_store_round_trips_and_writes_ha_store_envelope(config):
    store = CacheStore(config.store_path)
    assert await store.async_load() is None
    await store.async_save({"firearms": [{"id": "f1"}]})

    envelope = json.loads(config.store_path.read_text())
    assert envelope["version"] == 2
    assert envelope["data"] == {"firearms": [{"id": "f1"}]}
    assert await store.async_load() == {"firearms": [{"id": "f1"}]}


async def test_store_migrates_version_1_document_on_load(config):
    config.data_dir.mkdir()
    config.store_path.write_text(
        json.dumps(
            {
                "version": 1,
                "key": "cache_data",
                "data": {"inventory_items": [{"id": "i1", "category": "Optic Mount"}]},
            }
        )
    )
    data = await CacheStore(config.store_path).async_load()
    assert data["inventory_items"][0]["part_type"] == "Optic Mount"
    assert json.loads(config.store_path.read_text())["version"] == 2


# ------------------------------------------------------------------ migrate


def _write_integration_files(config: AddonConfig, key: str | None = "sk-old") -> None:
    storage = config.ha_config_dir / ".storage"
    storage.mkdir(parents=True)
    (storage / "cache_data_abc123").write_text(
        json.dumps({"version": 2, "key": "cache_data_abc123", "data": {"firearms": []}})
    )
    entries = [{"domain": "cache", "options": {"openai_api_key": key} if key else {}}]
    (storage / "core.config_entries").write_text(json.dumps({"data": {"entries": entries}}))
    uploads = config.ha_config_dir / "www" / "cache_uploads"
    uploads.mkdir(parents=True)
    (uploads / "photo.png").write_bytes(b"png")


def test_migrate_imports_store_uploads_and_key(config):
    _write_integration_files(config)
    assert migrate_from_integration(config) is True

    assert json.loads(config.store_path.read_text())["data"] == {"firearms": []}
    assert (config.uploads_dir / "photo.png").read_bytes() == b"png"
    assert json.loads(config.imported_secrets_path.read_text()) == {"openai_api_key": "sk-old"}


def test_migrate_runs_only_once(config):
    _write_integration_files(config)
    migrate_from_integration(config)
    config.store_path.write_text('{"version": 2, "data": {"firearms": [{"id": "new"}]}}')
    assert migrate_from_integration(config) is False
    assert "new" in config.store_path.read_text()


def test_migrate_noop_without_integration(config):
    assert migrate_from_integration(config) is False
    assert not config.store_path.exists()


# --------------------------------------------------------------------- web


@pytest.fixture
async def client(aiohttp_client, config, coordinator, monkeypatch):
    monkeypatch.setenv("CACHE_ALLOW_ANY_CLIENT", "1")
    async with aiohttp.ClientSession() as session:
        services = build_service_context(coordinator, config, session)
        yield await aiohttp_client(create_app(config, coordinator, services, session))


async def test_service_call_returns_response_and_attributes_actor(client, coordinator):
    resp = await client.post(
        "/api/services/add_ammunition",
        json={"caliber": "9mm", "quantity": "100"},
        headers={"X-Remote-User-Display-Name": "Jordan"},
    )
    assert resp.status == 200
    assert (await resp.json()) == {"response": None}
    assert coordinator.ammunition[0].quantity == 100  # coerced by the schema
    assert coordinator.ammunition[0].transactions[0].created_by == "Jordan"

    resp = await client.post(
        "/api/services/add_firearm", json={"custom_name": "AR", "firearm_type": "Rifle"}
    )
    body = await resp.json()
    assert body["response"]["firearm_id"] == coordinator.firearms[0].id


async def test_service_call_validation_errors_are_400_with_message(client):
    resp = await client.post("/api/services/add_firearm", json={"bogus": "x"})
    assert resp.status == 400
    assert "error" in await resp.json()

    resp = await client.post(
        "/api/services/add_firearm", json={"custom_name": "X", "firearm_type": "Laser Cannon"}
    )
    assert (await resp.json()) == {"error": "Invalid firearm type"}

    resp = await client.post("/api/services/not_a_service", json={})
    assert resp.status == 400


async def test_states_endpoint_and_websocket_push(client, coordinator):
    resp = await client.get("/api/states", headers={"X-Remote-User-Name": "jordan"})
    body = await resp.json()
    assert body["user"]["name"] == "jordan"
    assert "sensor.cache_settings" in body["states"]

    ws = await client.ws_connect("/api/websocket")
    first = await ws.receive_json()
    assert first["type"] == "states"
    await client.post("/api/services/add_storage_location", json={"name": "Closet"})
    pushed = await ws.receive_json(timeout=5)
    locations = pushed["states"]["sensor.cache_storage_locations"]["attributes"]["locations"]
    assert [loc["name"] for loc in locations] == ["Closet"]
    await ws.close()


async def test_photo_saved_as_is_without_openai_key(client, coordinator, config):
    firearm = await coordinator.async_add_firearm(custom_name="AR", firearm_type="Rifle")
    form = aiohttp.FormData()
    form.add_field("entity_type", "firearm")
    form.add_field("entity_id", firearm.id)
    form.add_field("file", b"jpeg-bytes", filename="ar.jpg", content_type="image/jpeg")

    resp = await client.post("/api/upload/photo", data=form)
    assert resp.status == 200
    body = await resp.json()
    assert body["filename"].endswith(".jpg")
    assert body["is_primary"] is True
    assert (config.uploads_dir / body["filename"]).read_bytes() == b"jpeg-bytes"
    assert coordinator.firearms[0].photos[0].filename == body["filename"]


async def test_photo_upload_still_fails_when_configured_key_errors(
    client, coordinator, config, monkeypatch
):
    from cache_addon import web
    from cache_addon.openai_client import OpenAIError

    async def _fail(*_args):
        raise OpenAIError("OpenAI is down")

    config.openai_api_key = "sk-test"
    monkeypatch.setattr(web, "remove_background", _fail)
    firearm = await coordinator.async_add_firearm(custom_name="AR", firearm_type="Rifle")
    form = aiohttp.FormData()
    form.add_field("entity_type", "firearm")
    form.add_field("entity_id", firearm.id)
    form.add_field("file", b"jpeg-bytes", filename="ar.jpg", content_type="image/jpeg")

    resp = await client.post("/api/upload/photo", data=form)
    assert resp.status == 502
    assert (await resp.json()) == {"error": "OpenAI is down"}
    assert coordinator.firearms[0].photos == []


async def test_estimate_value_returns_openai_estimate(client, config, monkeypatch):
    from cache_addon import web

    seen = {}

    async def _estimate(_session, api_key, description):
        seen["args"] = (api_key, description)
        return {"estimated_low": 450, "estimated_high": 550, "confidence": "medium"}

    resp = await client.post("/api/estimate_value", json={"description": "Glock 19"})
    assert resp.status == 400  # no key configured yet

    config.openai_api_key = "sk-test"
    monkeypatch.setattr(web, "estimate_used_value", _estimate)
    resp = await client.post("/api/estimate_value", json={"description": "  Glock 19 "})
    assert (await resp.json())["estimated_high"] == 550
    assert seen["args"] == ("sk-test", "Glock 19")

    resp = await client.post("/api/estimate_value", json={"description": ""})
    assert resp.status == 400


async def test_index_served_without_caching(client):
    resp = await client.get("/")
    assert resp.status == 200
    assert resp.headers["Cache-Control"] == "no-cache"


async def test_requests_outside_ingress_are_refused(aiohttp_client, config, coordinator):
    async with aiohttp.ClientSession() as session:
        services = build_service_context(coordinator, config, session)
        client = await aiohttp_client(create_app(config, coordinator, services, session))
        resp = await client.get("/api/states")
        assert resp.status == 403


async def test_is_nfa_round_trips_through_services_and_states(client, coordinator):
    resp = await client.post(
        "/api/services/add_firearm",
        json={"custom_name": "M16", "firearm_type": "Rifle", "is_nfa": True},
    )
    firearm_id = (await resp.json())["response"]["firearm_id"]
    states = build_states(coordinator.data)
    assert states[f"sensor.cache_firearm_{firearm_id}"]["attributes"]["is_nfa"] is True
    assert coordinator.data["dashboard_stats"]["nfa_items"] == 1

    await client.post(
        "/api/services/update_firearm", json={"firearm_id": firearm_id, "is_nfa": False}
    )
    assert coordinator.data["dashboard_stats"]["nfa_items"] == 0


# ------------------------------------------------------------ allowed users


@pytest.fixture
def through_ingress(monkeypatch):
    """Makes the test client (127.0.0.1) look like Supervisor's ingress proxy,
    so _allowed_users_only runs the way it does in the add-on."""
    monkeypatch.delenv("CACHE_ALLOW_ANY_CLIENT", raising=False)
    monkeypatch.setattr(web, "_INGRESS_PROXY", ip_address("127.0.0.1"))


@pytest.fixture
async def allowed_client(aiohttp_client, config, coordinator, through_ingress):
    async with aiohttp.ClientSession() as session:
        app = create_app(
            config, coordinator, build_service_context(coordinator, config, session), session
        )
        yield await aiohttp_client(app), config


async def test_empty_allowed_users_lets_everyone_in(allowed_client):
    client, config = allowed_client
    assert config.allowed_users == ()
    assert (await client.get("/", headers={"X-Remote-User-Name": "guest"})).status == 200


async def test_requests_without_a_user_are_refused(allowed_client):
    client, _config = allowed_client
    resp = await client.get("/")
    assert resp.status == 403
    assert "You don't have access to this add-on" in await resp.text()


async def test_allowed_users_restricts_every_route(allowed_client):
    client, config = allowed_client
    config.allowed_users = ("jordan",)
    for headers in ({"X-Remote-User-Name": " Jordan "}, {"X-Remote-User-Id": "JORDAN"}):
        assert (await client.get("/", headers=headers)).status == 200
    # The username decides when there is one - the id is only a fallback.
    guest = {"X-Remote-User-Name": "guest", "X-Remote-User-Id": "jordan"}
    for path in ("/", "/api/states", "/api/websocket", "/uploads/photo.jpg"):
        resp = await client.get(path, headers=guest)
        assert resp.status == 403
        assert resp.content_type == "text/html"
    assert (await client.post("/api/services/x", json={}, headers=guest)).status == 403


def test_allowed_users_option_is_normalised(tmp_path, monkeypatch):
    options = {"allowed_users": [" Jordan ", "", "kim"]}
    (tmp_path / "options.json").write_text(json.dumps(options))
    monkeypatch.setenv("CACHE_DATA_DIR", str(tmp_path))
    assert load_config().allowed_users == ("jordan", "kim")
