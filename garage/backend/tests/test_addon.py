"""The add-on-specific layers around the ported coordinator: the
`hass.states`-shaped snapshot (states.py), MQTT discovery payloads
(mqtt.py), the one-time integration import (migrate.py), the file-backed
store (storage.py), the daily reminders (reminders.py), the lookups'
pure helpers (lookups.py) and the HTTP API the panel calls (web.py)."""
from __future__ import annotations

import json
from datetime import UTC, date, datetime, time, timedelta
from ipaddress import ip_address

import aiohttp
import pytest

from garage_addon import mqtt, web
from garage_addon.config import AddonConfig, load_config
from garage_addon.coordinator import GarageCoordinator
from garage_addon.lookups import map_drivetrain, map_fuel_type
from garage_addon.migrate import migrate_from_integration, rewrite_upload_path
from garage_addon.reminders import async_send_reminders, seconds_until
from garage_addon.services import build_handlers
from garage_addon.states import build_states
from garage_addon.storage import GarageStore
from garage_addon.web import create_app


@pytest.fixture
def config(tmp_path) -> AddonConfig:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>garage</html>")
    return AddonConfig(
        data_dir=tmp_path / "data",
        ha_config_dir=tmp_path / "homeassistant",
        static_dir=static,
    )


@pytest.fixture
async def coordinator(config) -> GarageCoordinator:
    coord = GarageCoordinator(GarageStore(config.store_path))
    await coord.async_load()
    return coord


async def _add_vehicle(coordinator: GarageCoordinator, nickname: str = "Dad's F-150"):
    return await coordinator.async_add_vehicle(
        nickname=nickname, year=2020, make="Ford", model="F-150", current_mileage=1000
    )


class FakeHa:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []

    async def call_service(self, domain, service, data, *, return_response=False):
        self.calls.append((domain, service, data))


# ------------------------------------------------------------------ states


async def test_states_snapshot_has_every_marker_attribute_the_panel_scans_for(coordinator):
    vehicle = await _add_vehicle(coordinator)
    await coordinator.async_add_fuel_entry(vehicle.id, "2026-01-01", 1200, 40.0)
    states = build_states(coordinator.data)

    garage_keys = {e["attributes"].get("garage_key") for e in states.values()}
    assert garage_keys == {
        "total_monthly_fuel_spend",
        "total_monthly_maintenance_spend",
        "vehicles_needing_attention",
        "settings",
        "drivers",
        "maintenance_templates",
        "vehicle",
    }
    entity = states[f"sensor.garage_vehicle_{vehicle.id}"]
    assert entity["state"] == str(entity["attributes"]["health_score"])
    assert entity["attributes"]["vehicle_id"] == vehicle.id
    assert len(entity["attributes"]["fuel_entries"]) == 1
    json.dumps(states)  # everything the websocket sends must serialize


async def test_deleted_vehicle_disappears_from_states(coordinator):
    vehicle = await _add_vehicle(coordinator)
    await coordinator.async_delete_vehicle(vehicle.id)
    assert f"sensor.garage_vehicle_{vehicle.id}" not in build_states(coordinator.data)


# -------------------------------------------------------------------- mqtt


async def test_mqtt_vehicle_entity_keeps_the_integrations_entity_id(coordinator):
    vehicle = await _add_vehicle(coordinator)
    messages = mqtt.build_messages(coordinator.data)

    config = json.loads(messages[mqtt.discovery_topic(f"vehicle_{vehicle.id}")])
    assert config["default_entity_id"] == "sensor.garage_dad_s_f_150"
    assert config["unique_id"] == f"garage_addon_vehicle_{vehicle.id}"
    state_topic = config["state_topic"]
    assert messages[state_topic] == "100"
    attributes = json.loads(messages[config["json_attributes_topic"]])
    assert attributes["nickname"] == "Dad's F-150"
    assert "fuel_entries" not in attributes


def test_mqtt_fixed_entities_keep_the_integrations_entity_ids():
    ids = {e.discovery()["default_entity_id"] for e in mqtt.FIXED_ENTITIES}
    assert ids == {
        "sensor.garage_monthly_fuel_spending",
        "sensor.garage_monthly_maintenance_spending",
        "sensor.garage_vehicles_needing_attention",
    }


async def test_mqtt_stale_vehicle_keys(coordinator):
    vehicle = await _add_vehicle(coordinator)
    published = {f"vehicle_{vehicle.id}", "vehicle_gone", "monthly_fuel_spending"}
    assert mqtt.stale_vehicle_keys(published, coordinator.data) == {"vehicle_gone"}


# ------------------------------------------------------------------- store


async def test_store_round_trips_and_writes_ha_store_envelope(config, coordinator):
    await _add_vehicle(coordinator)
    envelope = json.loads(config.store_path.read_text())
    assert envelope["key"] == "garage_data"
    assert envelope["version"] == 1
    assert len(envelope["data"]["maintenance_templates"]) > 0

    reloaded = GarageCoordinator(GarageStore(config.store_path))
    await reloaded.async_load()
    assert [v.nickname for v in reloaded.vehicles] == ["Dad's F-150"]


# ----------------------------------------------------------------- migrate


def _write_integration(config: AddonConfig) -> None:
    storage = config.ha_config_dir / ".storage"
    storage.mkdir(parents=True)
    envelope = {
        "version": 1,
        "minor_version": 1,
        "key": "garage_data_abc",
        "data": {
            "vehicles": [
                {
                    "id": "v1",
                    "nickname": "Ram",
                    "year": 2022,
                    "make": "Ram",
                    "model": "1500",
                    "photo_path": "/local/garage_vehicles/v1/photo.jpg?v=123",
                }
            ],
            "documents": [
                {
                    "id": "d1",
                    "vehicle_id": "v1",
                    "category": "insurance",
                    "filename": "card.pdf",
                    "path": "/local/garage_documents/v1/card.pdf",
                    "uploaded_at": "2026-01-01",
                }
            ],
        },
    }
    (storage / "garage_data_abc").write_text(json.dumps(envelope))
    photo_dir = config.ha_config_dir / "www" / "garage_vehicles" / "v1"
    photo_dir.mkdir(parents=True)
    (photo_dir / "photo.jpg").write_bytes(b"jpg")
    doc_dir = config.ha_config_dir / "www" / "garage_documents" / "v1"
    doc_dir.mkdir(parents=True)
    (doc_dir / "card.pdf").write_bytes(b"pdf")


async def test_migrate_imports_store_and_uploads_and_rewrites_paths(config):
    _write_integration(config)
    assert migrate_from_integration(config) is True

    assert (config.uploads_dir / "vehicles" / "v1" / "photo.jpg").read_bytes() == b"jpg"
    assert (config.uploads_dir / "documents" / "v1" / "card.pdf").read_bytes() == b"pdf"

    coord = GarageCoordinator(GarageStore(config.store_path))
    await coord.async_load()
    assert coord.vehicles[0].photo_path == "uploads/vehicles/v1/photo.jpg?v=123"
    assert coord.documents[0].path == "uploads/documents/v1/card.pdf"
    # Built-in templates get reconciled in on load, like the integration did.
    assert any(t.name == "Oil Change" for t in coord.maintenance_templates)


def test_migrate_runs_only_once(config):
    _write_integration(config)
    assert migrate_from_integration(config) is True
    assert migrate_from_integration(config) is False


def test_migrate_noop_without_integration(config):
    assert migrate_from_integration(config) is False
    assert not config.store_path.exists()


def test_rewrite_upload_path_leaves_other_paths_alone():
    assert rewrite_upload_path(None) is None
    assert rewrite_upload_path("https://example.com/x.jpg") == "https://example.com/x.jpg"


# --------------------------------------------------------------- reminders


def test_seconds_until_rolls_to_tomorrow():
    tz = UTC
    assert seconds_until(datetime(2026, 1, 1, 7, 0, tzinfo=tz), time(8, 0)) == 3600
    assert seconds_until(datetime(2026, 1, 1, 9, 0, tzinfo=tz), time(8, 0)) == 23 * 3600


async def test_reminders_notify_the_primary_driver(coordinator):
    driver = await coordinator.async_add_driver("Sam", notify_target="notify.mobile_app_sam")
    vehicle = await _add_vehicle(coordinator)
    await coordinator.async_edit_vehicle(
        vehicle.id, primary_driver_id=driver.id, current_fuel_pct=0.1
    )
    ha = FakeHa()
    await async_send_reminders(coordinator, ha, date.today())
    assert ("notify", "mobile_app_sam") in {(c[0], c[1]) for c in ha.calls}
    assert any("10% fuel" in c[2]["message"] for c in ha.calls)


# ----------------------------------------------------------------- lookups


def test_map_drivetrain_variants():
    assert map_drivetrain("4WD/4-Wheel Drive/4x4") == "4wd"
    assert map_drivetrain("AWD/All-Wheel Drive") == "awd"
    assert map_drivetrain("RWD/Rear-Wheel Drive") == "rwd"
    assert map_drivetrain("FWD/Front-Wheel Drive") == "fwd"
    assert map_drivetrain("") is None
    assert map_drivetrain(None) is None
    assert map_drivetrain("Something Unrecognized") is None


def test_map_fuel_type_variants():
    assert map_fuel_type("Gasoline") == "gasoline"
    assert map_fuel_type("Diesel") == "diesel"
    assert map_fuel_type("Electric") == "electric"
    assert map_fuel_type("Hybrid/Gasoline") == "hybrid"
    assert map_fuel_type("Flexible Fuel Vehicle (FFV)") == "flex"
    assert map_fuel_type(None) is None
    assert map_fuel_type("Compressed Natural Gas (CNG)") is None


# --------------------------------------------------------------------- web


@pytest.fixture
async def client(aiohttp_client, config, coordinator, monkeypatch):
    monkeypatch.setenv("GARAGE_ALLOW_ANY_CLIENT", "1")
    async with aiohttp.ClientSession() as session:
        handlers = build_handlers(coordinator, config)
        yield await aiohttp_client(create_app(config, coordinator, handlers, session, None))


async def test_service_call_mutates_and_pushes_state(client, coordinator):
    async with client.ws_connect("/api/websocket") as ws:
        first = await ws.receive_json()
        assert first["type"] == "states"

        resp = await client.post(
            "/api/services/add_vehicle",
            json={"nickname": "Ram", "year": 2022, "make": "Ram", "model": "1500"},
        )
        assert resp.status == 200
        pushed = await ws.receive_json()

    vehicle_id = coordinator.vehicles[0].id
    assert f"sensor.garage_vehicle_{vehicle_id}" in pushed["states"]


async def test_service_call_errors_are_400_with_message(client):
    resp = await client.post("/api/services/add_vehicle", json={"nickname": "No year"})
    assert resp.status == 400
    assert "Invalid data for add_vehicle" in (await resp.json())["error"]

    resp = await client.post("/api/services/delete_vehicle", json={"vehicle_id": "nope"})
    assert resp.status == 400
    assert "Unknown vehicle_id" in (await resp.json())["error"]

    resp = await client.post("/api/services/not_a_service", json={})
    assert resp.status == 400


async def test_document_upload_served_and_deleted_with_its_file(client, coordinator, config):
    vehicle = await _add_vehicle(coordinator)
    form = aiohttp.FormData()
    form.add_field("vehicle_id", vehicle.id)
    form.add_field("category", "insurance")
    form.add_field("file", b"pdf-bytes", filename="card.pdf", content_type="application/pdf")
    resp = await client.post("/api/upload", data=form)
    assert resp.status == 200
    document = (await resp.json())["document"]
    assert document["path"] == f"uploads/documents/{vehicle.id}/card.pdf"

    served = await client.get(f"/{document['path']}")
    assert await served.read() == b"pdf-bytes"

    resp = await client.post("/api/services/delete_document", json={"document_id": document["id"]})
    assert resp.status == 200
    assert not (config.uploads_dir / "documents" / vehicle.id / ".._card.pdf").exists()


async def test_upload_rejects_unknown_vehicle(client, config):
    form = aiohttp.FormData()
    form.add_field("vehicle_id", "../../etc")
    form.add_field("file", b"x", filename="x.pdf", content_type="application/pdf")
    resp = await client.post("/api/upload", data=form)
    assert resp.status == 400
    assert not any(config.uploads_dir.rglob("x.pdf"))


async def test_vehicle_photo_replaces_previous_photo(client, coordinator, config):
    vehicle = await _add_vehicle(coordinator)
    for name in ("a.png", "b.jpg"):
        form = aiohttp.FormData()
        form.add_field("vehicle_id", vehicle.id)
        form.add_field("file", b"img", filename=name, content_type="image/jpeg")
        resp = await client.post("/api/vehicle_photo", data=form)
        assert resp.status == 200

    files = sorted(p.name for p in (config.uploads_dir / "vehicles" / vehicle.id).iterdir())
    assert files == ["photo.jpg"]
    photo_path = coordinator.vehicles[0].photo_path
    assert photo_path.startswith(f"uploads/vehicles/{vehicle.id}/photo.jpg?v=")


async def test_delete_vehicle_removes_its_uploads(client, coordinator, config):
    vehicle = await _add_vehicle(coordinator)
    form = aiohttp.FormData()
    form.add_field("vehicle_id", vehicle.id)
    form.add_field("file", b"img", filename="car.jpg", content_type="image/jpeg")
    await client.post("/api/vehicle_photo", data=form)

    resp = await client.post("/api/services/delete_vehicle", json={"vehicle_id": vehicle.id})
    assert resp.status == 200
    assert not (config.uploads_dir / "vehicles" / vehicle.id).exists()


async def test_fuel_photo_without_key_explains_how_to_add_one(client):
    form = aiohttp.FormData()
    form.add_field("file", b"img", filename="pump.jpg", content_type="image/jpeg")
    resp = await client.post("/api/analyze_fuel_photo", data=form)
    assert resp.status == 400
    assert "OpenAI" in (await resp.json())["error"]


async def test_decode_vin_uses_lookup(client, monkeypatch):
    async def _decode(session, vin, api_key):
        return {"year": 2020, "make": "Ford", "vin_seen": vin, "key": api_key}

    monkeypatch.setattr(web, "decode_vin", _decode)
    resp = await client.get("/api/decode_vin?vin=1ftfw1e")
    body = await resp.json()
    assert body["vin_seen"] == "1FTFW1E"
    assert body["key"] is None

    resp = await client.get("/api/decode_vin?vin=../x")
    assert resp.status == 400


async def test_ha_users_empty_without_home_assistant(client):
    resp = await client.get("/api/ha_users")
    assert await resp.json() == []


async def test_index_served_without_caching(client):
    resp = await client.get("/")
    assert resp.headers["Cache-Control"] == "no-cache"
    assert "garage" in await resp.text()


async def test_requests_outside_ingress_are_refused(aiohttp_client, config, coordinator):
    async with aiohttp.ClientSession() as session:
        app = create_app(config, coordinator, build_handlers(coordinator, config), session, None)
        client = await aiohttp_client(app)
        resp = await client.get("/api/states")
        assert resp.status == 403


# ------------------------------------------------------------ stash client


def test_stash_base_url():
    from garage_addon.stash_client import stash_base_url

    assert stash_base_url("a1b2c3d4-garage") == "http://a1b2c3d4-stash:8099"
    assert stash_base_url("my-laptop") is None
    assert stash_base_url("") is None


async def test_stash_client_against_a_stash_shaped_server(aiohttp_server):
    from aiohttp import web as aioweb

    from garage_addon.stash_client import StashClient, StashError, StashUnavailable

    calls = []

    async def categories(request):
        return aioweb.json_response([{"id": "c1", "name": "Transportation"}])

    async def service(request):
        calls.append((request.match_info["service"], await request.json()))
        if request.match_info["service"] == "delete_member":
            return aioweb.json_response({"error": "Unknown service"}, status=404)
        return aioweb.json_response({"response": {"expense_id": "e1"}})

    app = aioweb.Application()
    app.router.add_get("/internal/categories", categories)
    app.router.add_post("/internal/services/{service}", service)
    server = await aiohttp_server(app)

    async with aiohttp.ClientSession() as session:
        client = StashClient(session, str(server.make_url("/")))
        assert await client.find_category_id(" transportation ") == "c1"
        assert await client.find_category_id("Food") is None
        assert await client.call_service("add_category_expense", {"a": 1}) == {"expense_id": "e1"}
        assert calls == [("add_category_expense", {"a": 1})]
        with pytest.raises(StashError) as err:
            await client.call_service("delete_member", {})
        assert not isinstance(err.value, StashUnavailable)

        await server.close()
        with pytest.raises(StashUnavailable):
            await client.find_category_id("Transportation")


# ------------------------------------------------------------ allowed users


@pytest.fixture
def through_ingress(monkeypatch):
    """Makes the test client (127.0.0.1) look like Supervisor's ingress proxy,
    so _allowed_users_only runs the way it does in the add-on."""
    monkeypatch.delenv("GARAGE_ALLOW_ANY_CLIENT", raising=False)
    monkeypatch.setattr(web, "_INGRESS_PROXY", ip_address("127.0.0.1"))


@pytest.fixture
async def allowed_client(aiohttp_client, config, coordinator, through_ingress):
    async with aiohttp.ClientSession() as session:
        app = create_app(config, coordinator, build_handlers(coordinator, config), session, None)
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
    for path in ("/", "/api/states", "/api/websocket"):
        resp = await client.get(path, headers=guest)
        assert resp.status == 403
        assert resp.content_type == "text/html"
    assert (await client.post("/api/services/x", json={}, headers=guest)).status == 403


def test_allowed_users_option_is_normalised(tmp_path, monkeypatch):
    options = {"allowed_users": [" Jordan ", "", "kim"]}
    (tmp_path / "options.json").write_text(json.dumps(options))
    monkeypatch.setenv("GARAGE_DATA_DIR", str(tmp_path))
    assert load_config().allowed_users == ("jordan", "kim")


# ------------------------------------------------------------- live sensors


def _sensor(state, unit=""):
    return {"state": state, "attributes": {"unit_of_measurement": unit}}


def test_parse_odometer_units_and_bad_states():
    from garage_addon.obd import parse_odometer

    assert parse_odometer(_sensor("112341.61", "mi")) == 112342
    assert parse_odometer(_sensor("160934.4", "km")) == 100000
    for bad in ("unavailable", "unknown", "0", "-1", "nan"):
        assert parse_odometer(_sensor(bad, "mi")) is None
    assert parse_odometer(None) is None


def test_parse_fuel_level_percent_and_fraction():
    from garage_addon.obd import parse_fuel_level

    assert parse_fuel_level(_sensor("45.88", "%")) == 0.459
    assert parse_fuel_level(_sensor("0.5")) == 0.5
    assert parse_fuel_level(_sensor("0.5", "%")) == 0.005
    assert parse_fuel_level(_sensor("150", "%")) is None
    assert parse_fuel_level(_sensor("unavailable", "%")) is None


class FakeStatesHa:
    def __init__(self, states):
        self.states = states

    async def get_state(self, entity_id):
        return self.states.get(entity_id)


async def _linked_truck(coordinator):
    vehicle = await _add_vehicle(coordinator)
    await coordinator.async_edit_vehicle(
        vehicle.id,
        odometer_entity_id="sensor.wican_a6_odometer",
        fuel_level_entity_id="sensor.wican_2f_fueltanklevel",
    )
    return vehicle


def _at(minute: int) -> datetime:
    return datetime(2026, 10, 30, 12, 0, tzinfo=UTC) + timedelta(minutes=minute)


async def test_live_readings_take_fuel_only_while_driving(coordinator):
    from garage_addon.obd import LiveReadings

    vehicle = await _linked_truck(coordinator)
    states = {
        "sensor.wican_a6_odometer": _sensor("112341.61", "mi"),
        "sensor.wican_2f_fueltanklevel": _sensor("38", "%"),
    }
    readings = LiveReadings(coordinator, FakeStatesHa(states))

    # Parked on the driveway: odometer applies, the tilted fuel reading doesn't.
    await readings.poll_once(_at(0))
    assert vehicle.current_mileage == 112342
    assert vehicle.current_fuel_pct is None
    live = build_states(coordinator.data)[f"sensor.garage_vehicle_{vehicle.id}"]["attributes"][
        "live_sensors"
    ]
    assert live["odometer"]["status"] == "ok"
    assert live["fuel"]["status"] == "parked"

    # Driving: median of the trip's readings, so one slosh doesn't stick.
    for minute, (odo, fuel) in enumerate(
        [("112342.5", "46"), ("112343.4", "60"), ("112344.2", "45")], start=1
    ):
        states["sensor.wican_a6_odometer"] = _sensor(odo, "mi")
        states["sensor.wican_2f_fueltanklevel"] = _sensor(fuel, "%")
        await readings.poll_once(_at(minute))
    assert vehicle.current_mileage == 112344
    assert vehicle.current_fuel_pct == 0.46

    # Parks nose-up: odometer stops, fuel dips - the driving value stays.
    states["sensor.wican_2f_fueltanklevel"] = _sensor("30", "%")
    await readings.poll_once(_at(4))
    assert vehicle.current_fuel_pct == 0.46

    # Asleep: unavailable, nothing changes, mileage never rolls back.
    states["sensor.wican_a6_odometer"] = _sensor("unavailable", "mi")
    states["sensor.wican_2f_fueltanklevel"] = _sensor("unavailable", "%")
    await readings.poll_once(_at(5))
    assert (vehicle.current_mileage, vehicle.current_fuel_pct) == (112344, 0.46)
    assert coordinator.live_status[vehicle.id]["fuel"]["status"] == "unavailable"


async def test_live_readings_restart_the_window_after_a_fill_up(coordinator):
    from garage_addon.obd import LiveReadings

    vehicle = await _linked_truck(coordinator)
    states = {}
    readings = LiveReadings(coordinator, FakeStatesHa(states))
    # Three minutes of driving, a 6-minute stop at the pump, then driving on.
    for minute, odo, fuel in [
        (0, 1000.0, "20"), (1, 1000.5, "20"), (2, 1001.0, "21"), (3, 1001.5, "20"),
        (9, 1002.0, "95"), (10, 1002.5, "96"),
    ]:
        states["sensor.wican_a6_odometer"] = _sensor(str(odo), "mi")
        states["sensor.wican_2f_fueltanklevel"] = _sensor(fuel, "%")
        await readings.poll_once(_at(minute))
    assert vehicle.current_fuel_pct == 0.955


async def test_live_readings_report_missing_and_failing_sensors(coordinator, caplog):
    from garage_addon.ha_client import HomeAssistantError
    from garage_addon.obd import LiveReadings

    vehicle = await _linked_truck(coordinator)

    class BrokenHa:
        async def get_state(self, entity_id):
            if "odometer" in entity_id:
                raise HomeAssistantError("GET states/x failed (401): Unauthorized")
            return None

    readings = LiveReadings(coordinator, BrokenHa())
    await readings.poll_once(_at(0))
    await readings.poll_once(_at(1))
    status = coordinator.live_status[vehicle.id]
    assert status["odometer"]["status"].startswith("error")
    assert status["fuel"]["status"] == "missing"
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 2  # once per sensor, not every poll


async def test_fuel_without_odometer_link_is_smoothed_not_gated(coordinator):
    from garage_addon.obd import LiveReadings

    vehicle = await _add_vehicle(coordinator)
    await coordinator.async_edit_vehicle(vehicle.id, fuel_level_entity_id="sensor.fuel")
    states = {}
    readings = LiveReadings(coordinator, FakeStatesHa(states))
    for minute, fuel in enumerate(["50", "50", "30"]):
        states["sensor.fuel"] = _sensor(fuel, "%")
        await readings.poll_once(_at(minute))
    assert vehicle.current_fuel_pct == 0.5


async def test_edit_vehicle_service_accepts_sensor_links(client, coordinator):
    vehicle = await _add_vehicle(coordinator)
    resp = await client.post(
        "/api/services/edit_vehicle",
        json={
            "vehicle_id": vehicle.id,
            "odometer_entity_id": "sensor.x",
            "fuel_level_entity_id": "",
        },
    )
    assert resp.status == 200
    assert vehicle.odometer_entity_id == "sensor.x"


async def test_ha_sensors_empty_without_home_assistant(client):
    resp = await client.get("/api/ha_sensors")
    assert await resp.json() == []
