"""The add-on-specific layers around the ported coordinator: the
`hass.states`-shaped snapshot (states.py), MQTT discovery payloads
(mqtt.py), the one-time integration import (migrate.py), the file-backed
store (storage.py), the daily rollover (rollover.py) and the HTTP API the
panel and Garage call (web.py)."""
from __future__ import annotations

import json
from datetime import UTC, datetime, time

import pytest

from stash_addon import mqtt, web
from stash_addon.config import AddonConfig
from stash_addon.const import STORAGE_KEY, STORAGE_VERSION, BillType, Frequency
from stash_addon.coordinator import FinanceCoordinator
from stash_addon.ha_client import is_admin
from stash_addon.migrate import migrate_from_integration
from stash_addon.rollover import seconds_until
from stash_addon.services import build_handlers
from stash_addon.states import build_states
from stash_addon.storage import FinanceStore
from stash_addon.web import create_app, sibling_hostname


@pytest.fixture
def config(tmp_path) -> AddonConfig:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>stash</html>")
    return AddonConfig(
        data_dir=tmp_path / "data",
        ha_config_dir=tmp_path / "homeassistant",
        static_dir=static,
    )


@pytest.fixture
async def coordinator(config) -> FinanceCoordinator:
    coord = FinanceCoordinator(FinanceStore(config.store_path))
    await coord.async_load()
    return coord


def _category_id(coordinator: FinanceCoordinator, name: str) -> str:
    return next(c.id for c in coordinator.categories if c.name == name)


async def _seed(coordinator: FinanceCoordinator):
    member = await coordinator.async_add_member("Kids' Mom", 5000)
    await coordinator.async_add_bill(
        name="Rent",
        amount=1200,
        category_id=_category_id(coordinator, "Housing"),
        due_date=f"{coordinator.data['current_month']}-01",
        frequency=Frequency.MONTHLY,
        bill_type=BillType.FIXED,
    )
    return member


# ------------------------------------------------------------------ states


async def test_states_snapshot_has_every_marker_attribute_the_panel_scans_for(coordinator):
    member = await _seed(coordinator)
    states = build_states(coordinator.data)

    finance_keys = {e["attributes"].get("finance_key") for e in states.values()} - {None}
    assert finance_keys == {
        "total_income",
        "total_bills",
        "paid",
        "remaining",
        "cash_remaining",
        "upcoming_this_pay_period",
        "overdue",
        "deferred",
        "mode",
        "savings",
        "cash_infusions",
    }
    assert states[f"sensor.stash_member_{member.id}"]["attributes"]["member_id"] == member.id
    categories = [e for e in states.values() if "category_id" in e["attributes"]]
    assert len(categories) == len(coordinator.categories)
    bills = [e for e in states.values() if "bill_id" in e["attributes"]]
    assert len(bills) == 1
    assert bills[0]["attributes"]["responsibility"] == {member.id: 1200}
    assert bills[0]["attributes"]["proposed_savings_plan"] is not None
    json.dumps(states)  # everything the websocket sends must serialize


async def test_deleted_member_disappears_from_states(coordinator):
    member = await coordinator.async_add_member("Jordan", 1000)
    await coordinator.async_delete_member(member.id)
    assert f"sensor.stash_member_{member.id}" not in build_states(coordinator.data)


# -------------------------------------------------------------------- mqtt


def test_mqtt_fixed_entities_keep_the_integrations_entity_ids():
    ids = {e.discovery()["default_entity_id"] for e in mqtt.FIXED_ENTITIES}
    assert ids == {
        "sensor.stash_total_income",
        "sensor.stash_total_bills",
        "sensor.stash_paid",
        "sensor.stash_remaining",
        "sensor.stash_cash_remaining",
        "sensor.stash_bills_due_this_pay_period",
        "sensor.stash_overdue_bills",
        "sensor.stash_deferred_bills",
        "sensor.stash_finance_mode",
        "sensor.stash_savings",
        "sensor.stash_cash_infusions",
    }


async def test_mqtt_member_and_category_entities(coordinator):
    member = await _seed(coordinator)
    messages = mqtt.build_messages(coordinator.data)

    config = json.loads(messages[mqtt.discovery_topic(f"member_{member.id}")])
    assert config["default_entity_id"] == "sensor.stash_kids_mom_finance_summary"
    assert float(messages[config["state_topic"]]) == 5000

    housing = _category_id(coordinator, "Housing")
    config = json.loads(messages[mqtt.discovery_topic(f"category_{housing}")])
    assert config["default_entity_id"] == "sensor.stash_housing_spending"
    assert float(messages[config["state_topic"]]) == 1200
    attributes = json.loads(messages[config["json_attributes_topic"]])
    assert attributes["category_id"] == housing
    assert "expenses" not in attributes

    overdue = json.loads(messages[mqtt.discovery_topic("overdue")])
    assert "unit_of_measurement" not in overdue
    # Bills aren't published - see mqtt.py.
    assert not any("/bill_" in topic for topic in messages)


async def test_mqtt_stale_dynamic_keys(coordinator):
    member = await _seed(coordinator)
    published = {f"member_{member.id}", "member_gone", "category_gone", "total_income"}
    assert mqtt.stale_dynamic_keys(published, coordinator.data) == {
        "member_gone",
        "category_gone",
    }


# ----------------------------------------------------------------- storage


async def test_store_round_trips_in_the_ha_store_envelope(config, coordinator):
    await coordinator.async_add_member("Jordan", 1000)
    envelope = json.loads(config.store_path.read_text())
    assert envelope["key"] == STORAGE_KEY
    assert envelope["version"] == STORAGE_VERSION
    assert envelope["data"]["members"][0]["name"] == "Jordan"

    reloaded = FinanceCoordinator(FinanceStore(config.store_path))
    await reloaded.async_load()
    assert [m.name for m in reloaded.members] == ["Jordan"]


# ----------------------------------------------------------------- migrate


def _write_integration_store(config: AddonConfig, name: str, members: list[dict]) -> None:
    storage = config.ha_config_dir / ".storage"
    storage.mkdir(parents=True, exist_ok=True)
    (storage / name).write_text(
        json.dumps(
            {
                "version": 1,
                "minor_version": 1,
                "key": name,
                "data": {"members": members, "categories": []},
            }
        )
    )


async def test_migrate_imports_the_integrations_store_once(config):
    _write_integration_store(config, f"{STORAGE_KEY}_entry1", [{"id": "m1", "name": "Jordan"}])
    assert migrate_from_integration(config) is True
    assert migrate_from_integration(config) is False  # stash.json now exists

    coordinator = FinanceCoordinator(FinanceStore(config.store_path))
    await coordinator.async_load()
    assert [m.id for m in coordinator.members] == ["m1"]


def test_migrate_without_an_integration_does_nothing(config):
    assert migrate_from_integration(config) is False
    assert not config.store_path.exists()


# ---------------------------------------------------------------- rollover


def test_seconds_until_rolls_to_tomorrow():
    now = datetime(2026, 10, 23, 0, 10, tzinfo=UTC)
    assert seconds_until(now, time(0, 5)) == 24 * 3600 - 5 * 60
    assert seconds_until(now, time(0, 15)) == 5 * 60


# --------------------------------------------------------------------- web


def test_sibling_hostname():
    assert sibling_hostname("a1b2c3d4-stash", "garage") == "a1b2c3d4-garage"
    assert sibling_hostname("local-stash", "garage") == "local-garage"
    assert sibling_hostname("my-laptop", "garage") is None
    assert sibling_hostname("", "garage") is None


def test_is_admin():
    assert is_admin({"group_ids": ["system-admin"]})
    assert is_admin({"is_owner": True, "group_ids": []})
    assert not is_admin({"group_ids": ["system-users"]})


def _app(config: AddonConfig, coordinator: FinanceCoordinator):
    return create_app(config, coordinator, build_handlers(coordinator), None)


@pytest.fixture
async def client(aiohttp_client, config, coordinator, monkeypatch):
    monkeypatch.setenv("STASH_ALLOW_ANY_CLIENT", "1")
    return await aiohttp_client(_app(config, coordinator))


async def test_index_and_states(client, coordinator):
    resp = await client.get("/")
    assert resp.status == 200
    assert resp.headers["Cache-Control"] == "no-cache"

    await coordinator.async_add_member("Jordan", 1000)
    body = await (await client.get("/api/states")).json()
    assert body["type"] == "states"
    assert body["user"]["is_admin"] is True  # dev run - nobody to ask
    assert any(e["attributes"].get("name") == "Jordan" for e in body["states"].values())


async def test_websocket_pushes_changes(client, coordinator):
    ws = await client.ws_connect("/api/websocket")
    first = await ws.receive_json()
    assert first["type"] == "states"
    await coordinator.async_add_member("Jordan", 1000)
    pushed = await ws.receive_json()
    assert any(e["attributes"].get("name") == "Jordan" for e in pushed["states"].values())
    await ws.close()


async def test_service_call_and_response(client, coordinator):
    resp = await client.post("/api/services/add_member", json={"name": "Jordan", "income": 10})
    assert resp.status == 200
    assert (await resp.json())["response"] is None

    resp = await client.post(
        "/api/services/add_category_expense",
        json={
            "category_id": _category_id(coordinator, "Food"),
            "name": "Groceries",
            "amount": 42,
            "expense_date": "2026-10-01",
        },
    )
    expense_id = (await resp.json())["response"]["expense_id"]
    assert [e.id for e in coordinator.category_expenses] == [expense_id]


async def test_set_mode_saves(client, coordinator):
    resp = await client.post("/api/services/set_mode", json={"mode": "shared"})
    assert resp.status == 200
    assert coordinator.data["mode"] == "shared"
    resp = await client.post("/api/services/set_mode", json={"mode": "nonsense"})
    assert resp.status == 400


async def test_service_errors(client):
    resp = await client.post("/api/services/nope", json={})
    assert resp.status == 400
    resp = await client.post("/api/services/add_member", json={"income": 10})
    assert "Invalid data" in (await resp.json())["error"]
    resp = await client.post("/api/services/delete_member", json={"member_id": "missing"})
    assert (await resp.json())["error"] == "Unknown member_id missing"


async def test_ha_users_without_home_assistant(client):
    assert await (await client.get("/api/ha_users")).json() == []


async def test_requests_outside_ingress_are_refused(aiohttp_client, config, coordinator):
    client = await aiohttp_client(_app(config, coordinator))
    assert (await client.get("/api/states")).status == 403
    assert (await client.get("/internal/categories")).status == 403


@pytest.fixture
async def garage_client(aiohttp_client, config, coordinator, monkeypatch):
    """A client whose address is what Garage's hostname resolves to."""
    config.hostname = "a1b2c3d4-stash"
    resolved: list[str] = []

    async def _resolve(hostname):
        resolved.append(hostname)
        return {"127.0.0.1", "::1"}

    monkeypatch.setattr(web, "_resolve", _resolve)
    client = await aiohttp_client(_app(config, coordinator))
    client.resolved = resolved
    return client


async def test_garage_can_sync_expenses(garage_client, coordinator):
    categories = await (await garage_client.get("/internal/categories")).json()
    assert garage_client.resolved[0] == "a1b2c3d4-garage"
    transportation = next(c["id"] for c in categories if c["name"] == "Transportation")

    resp = await garage_client.post(
        "/internal/services/add_category_expense",
        json={
            "category_id": transportation,
            "name": "Fuel - Truck",
            "amount": 50,
            "expense_date": "2026-10-01",
        },
    )
    expense_id = (await resp.json())["response"]["expense_id"]
    await garage_client.post(
        "/internal/services/edit_category_expense",
        json={"expense_id": expense_id, "amount": 55},
    )
    assert coordinator.category_expenses[0].amount == 55
    await garage_client.post(
        "/internal/services/delete_category_expense", json={"expense_id": expense_id}
    )
    assert coordinator.category_expenses == []


async def test_garage_cannot_reach_anything_else(garage_client):
    resp = await garage_client.post("/internal/services/delete_member", json={"member_id": "x"})
    assert resp.status == 404
    assert (await garage_client.get("/api/states")).status == 403


async def test_internal_api_refuses_other_addons(aiohttp_client, config, coordinator, monkeypatch):
    config.hostname = "a1b2c3d4-stash"

    async def _resolve(hostname):
        return {"172.30.33.9"}

    monkeypatch.setattr(web, "_resolve", _resolve)
    client = await aiohttp_client(_app(config, coordinator))
    assert (await client.get("/internal/categories")).status == 403
