"""The add-on layers around the integration's code: the services' user
context and first-run setup, the Calendar tab (tags, event bounds, create +
uid lookup), the Meals tab (dinner board, key resolution, scheduling), the
states read model, MQTT payloads, the one-time import, and the web server's
ingress gate."""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from hustle_addon import family_calendar, meals, migrate, mqtt, services, shopping, web
from hustle_addon.bridge import HassBridge
from hustle_addon.config import AddonConfig
from hustle_addon.coordinator import HustleCoordinator
from hustle_addon.family_calendar import FamilyCalendar, event_tag_key, normalize_event
from hustle_addon.ha_client import HomeAssistantError
from hustle_addon.shopping import ShoppingList
from hustle_addon.states import build_states
from hustle_addon.storage import HustleStore

PAYDAY = {"type": "weekly", "day_of_week": "FRI"}


class FakeHA:
    """Records calendar writes and serves events back like Core does."""

    def __init__(self) -> None:
        self.events: dict[str, list[dict]] = {}
        self.commands: list[dict] = []
        self.fired: list[tuple[str, dict]] = []
        self.service_calls: list[tuple[str, str, dict]] = []
        self.todo: dict[str, list[dict]] = {}

    async def get_calendars(self):
        return [{"entity_id": e, "name": e.split(".")[1].title()} for e in self.events]

    async def get_calendar_events(self, entity_id, start, end):
        if entity_id not in self.events:
            raise HomeAssistantError("not found")
        return self.events[entity_id]

    async def ws_command(self, message):
        self.commands.append(message)
        if message["type"] == "calendar/event/create":
            event = message["event"]
            key = "date" if len(event["dtstart"]) == 10 else "dateTime"
            self.events.setdefault(message["entity_id"], []).append(
                {
                    "summary": event["summary"],
                    "description": event.get("description"),
                    "start": {key: event["dtstart"]},
                    "end": {key: event["dtend"]},
                    "uid": f"uid-{len(self.commands)}",
                }
            )
        elif message["type"] == "calendar/event/delete":
            self.events[message["entity_id"]] = [
                e for e in self.events[message["entity_id"]] if e["uid"] != message["uid"]
            ]
        return None

    async def fire_event(self, event_type, data):
        self.fired.append((event_type, data))

    async def call_service(self, domain, service, data, return_response=False):
        self.service_calls.append((domain, service, data))
        if domain != "todo":
            return None
        items = self.todo.setdefault(data["entity_id"], [])
        if service == "get_items":
            return {data["entity_id"]: {"items": [dict(i) for i in items]}}
        if service == "add_item":
            uid = f"t{len(self.service_calls)}"
            items.append({"uid": uid, "summary": data["item"], "status": "needs_action"})
        elif service == "update_item":
            item = next(i for i in items if data["item"] in (i["uid"], i["summary"]))
            item["summary"] = data.get("rename", item["summary"])
            item["status"] = data.get("status", item["status"])
        elif service == "remove_item":
            self.todo[data["entity_id"]] = [i for i in items if i["uid"] not in data["item"]]
        elif service == "remove_completed_items":
            self.todo[data["entity_id"]] = [i for i in items if i["status"] != "completed"]
        return None

    async def get_states(self):
        return [
            {"entity_id": "todo.shopping_list", "attributes": {"friendly_name": "Shopping List"}},
            {"entity_id": "todo.costco", "attributes": {"friendly_name": "Costco"}},
            {"entity_id": "light.kitchen", "attributes": {}},
        ]


@pytest.fixture
def config(tmp_path: Path) -> AddonConfig:
    return AddonConfig(
        data_dir=tmp_path / "data",
        ha_config_dir=tmp_path / "ha",
        static_dir=tmp_path / "static",
    )


@pytest.fixture
async def setup(config):
    ha = FakeHA()
    coordinator = HustleCoordinator(
        HassBridge(ha, None, config.images_dir), HustleStore(config.store_path)
    )
    await coordinator.async_load()
    calendar = FamilyCalendar(ha, coordinator)
    schemas = {
        **services.SCHEMAS,
        **family_calendar.SCHEMAS,
        **meals.SCHEMAS,
        **shopping.SCHEMAS,
    }
    handlers = {
        **services.build_handlers(coordinator),
        **family_calendar.build_handlers(coordinator, calendar),
        **meals.build_handlers(coordinator, calendar, None, config),
        **shopping.build_handlers(coordinator, ShoppingList(ha, coordinator)),
    }

    async def call(name, data, user):
        return await services.async_call_service(schemas, handlers, name, data, user)

    return coordinator, ha, call


ADMIN = {"id": "ha-admin", "name": "Pat", "is_admin": True}
SETUP = {"name": "The Smiths", "display_name": "Pat", "payday_rule": PAYDAY}


async def _family(setup):
    coordinator, ha, call = setup
    await call("setup_family", SETUP, ADMIN)
    await call(
        "add_member",
        {"ha_user_id": "ha-kid", "ha_display_name": "Kim", "role": "child"},
        ADMIN,
    )
    kid = next(m for m in coordinator.members if m.ha_user_id == "ha-kid")
    return coordinator, ha, call, kid


# --------------------------------------------------------------- setup/guards


async def test_setup_family_makes_caller_parent_admin(setup):
    coordinator, _ha, call = setup
    await call("setup_family", SETUP, ADMIN)
    assert coordinator.household.name == "The Smiths"
    assert coordinator.household.setup_completed
    [parent] = coordinator.members
    assert (parent.ha_user_id, parent.role.value, parent.permission_level.value) == (
        "ha-admin",
        "parent",
        "admin",
    )


async def test_setup_family_needs_ha_admin_and_runs_once(setup):
    _coordinator, _ha, call = setup
    with pytest.raises(services.ServiceError, match="administrator"):
        await call("setup_family", SETUP, {"id": "someone", "is_admin": False})
    await call("setup_family", SETUP, ADMIN)
    with pytest.raises(services.ServiceError, match="already set up"):
        await call("setup_family", SETUP, {"id": "other-admin", "is_admin": True})


async def test_guards_use_the_ingress_user(setup):
    _coordinator, _ha, call, _kid = await _family(setup)
    kid_user = {"id": "ha-kid", "is_admin": False}
    with pytest.raises(services.ServiceError, match="parent"):
        await call("add_chore_definition", {"title": "Dishes"}, kid_user)
    with pytest.raises(services.ServiceError, match="No Hustle member"):
        await call("add_chore_definition", {"title": "Dishes"}, None)
    await call("add_chore_definition", {"title": "Dishes", "payout_cents": 200}, ADMIN)


async def test_unknown_service_and_bad_data(setup):
    _coordinator, _ha, call = setup
    with pytest.raises(services.ServiceError, match="Unknown service"):
        await call("nope", {}, ADMIN)
    with pytest.raises(services.ServiceError, match="Invalid data"):
        await call("setup_family", {"name": "x"}, ADMIN)


async def test_activity_events_reach_home_assistant(setup):
    coordinator, ha, call, kid = await _family(setup)
    await call("add_chore_definition", {"title": "Dishes", "payout_cents": 200}, ADMIN)
    [assignment] = await coordinator.async_assign_chore(
        coordinator.chore_definitions[0].id, [kid.id], date.today().isoformat()
    )
    await call("submit_chore", {"assignment_id": assignment.id}, {"id": "ha-kid"})
    for task in list(coordinator.hass._tasks):
        await task
    assert ha.fired, "coordinator activity should fire hustle_* events"
    assert all(event.startswith("hustle_") for event, _ in ha.fired)


# ------------------------------------------------------------------ calendar


def test_normalize_event_merges_tags_and_parses_dates():
    tags = {event_tag_key("calendar.family", "u1"): {"for_member_id": "m1", "attendee_ids": ["m2"]}}
    timed = normalize_event(
        {
            "summary": "Soccer",
            "start": {"dateTime": "2026-10-24T09:00:00-05:00"},
            "end": {"dateTime": "2026-10-24T10:00:00-05:00"},
            "uid": "u1",
        },
        "calendar.family",
        "Family",
        tags,
    )
    assert timed["all_day"] is False
    assert (timed["for_member_id"], timed["attendee_ids"]) == ("m1", ["m2"])
    all_day = normalize_event(
        {"summary": "Trip", "start": {"date": "2026-10-24"}, "end": {"date": "2026-10-26"}},
        "calendar.family",
        "Family",
        tags,
    )
    assert all_day["all_day"] is True and all_day["for_member_id"] is None
    assert normalize_event({"summary": "x"}, "calendar.family", "Family", tags) is None


def test_event_bounds():
    assert family_calendar._event_bounds({"all_day": True, "start": "2026-10-24"}) == (
        "2026-10-24",
        "2026-10-25",
    )
    start, end = family_calendar._event_bounds(
        {"all_day": False, "start": "2026-10-24T09:00:00-05:00"}
    )
    assert start == "2026-10-24T09:00:00-05:00"
    assert end == "2026-10-24T10:00:00-05:00"


async def test_create_event_tags_it_and_delete_drops_tags(setup):
    coordinator, ha, call, kid = await _family(setup)
    ha.events["calendar.family"] = []
    await call(
        "update_calendar_settings",
        {"family_calendars": ["calendar.family"], "default_calendar": "calendar.family"},
        ADMIN,
    )
    result = await call(
        "create_event",
        {
            "summary": "Dentist",
            "start": "2026-10-27T10:00:00-05:00",
            "end": "2026-10-27T11:00:00-05:00",
            "for_member_id": kid.id,
            "attendee_ids": [coordinator.members[0].id],
        },
        ADMIN,
    )
    key = event_tag_key("calendar.family", result["uid"])
    assert coordinator.event_tags[key]["for_member_id"] == kid.id

    calendar = FamilyCalendar(ha, coordinator)
    listed = await calendar.events(["calendar.family"], date(2026, 10, 26), date(2026, 11, 2))
    assert listed["events"][0]["for_member_id"] == kid.id

    await call("delete_event", {"entity_id": "calendar.family", "uid": result["uid"]}, ADMIN)
    assert key not in coordinator.event_tags
    assert ha.events["calendar.family"] == []


async def test_tagging_is_for_parents_and_known_members(setup):
    _coordinator, _ha, call, kid = await _family(setup)
    data = {"entity_id": "calendar.family", "uid": "u1", "for_member_id": kid.id}
    with pytest.raises(services.ServiceError):
        await call("tag_event", data, {"id": "ha-kid"})
    with pytest.raises(services.ServiceError, match="Unknown member"):
        await call("tag_event", {**data, "for_member_id": "ghost"}, ADMIN)
    await call("tag_event", data, ADMIN)


async def test_calendar_entity_validation(setup):
    _coordinator, _ha, call = setup
    with pytest.raises(services.ServiceError, match="Invalid data"):
        await call("update_calendar_settings", {"family_calendars": ["sensor.nope"]}, ADMIN)


async def test_one_unreadable_calendar_does_not_hide_others(setup):
    coordinator, ha, _call = setup
    ha.events["calendar.family"] = [
        {"summary": "Game", "start": {"date": "2026-10-24"}, "end": {"date": "2026-10-25"}}
    ]
    result = await FamilyCalendar(ha, coordinator).events(
        ["calendar.family", "calendar.gone"], date(2026, 10, 24), date(2026, 10, 25)
    )
    assert [e["summary"] for e in result["events"]] == ["Game"]
    assert len(result["errors"]) == 1


# --------------------------------------------------------------------- meals


def test_dinner_week_shapes_board_entries():
    today = date(2026, 10, 24)
    week = meals.dinner_week(
        [
            {
                "summary": "Tacos",
                "description": "",
                "start": "2026-10-25",
                "all_day": True,
                "uid": "b",
            },
            {
                "summary": "Pasta",
                "description": "Red sauce",
                "start": "2026-10-24",
                "all_day": True,
                "uid": "a",
            },
        ],
        today,
    )
    assert [w["dish"] for w in week] == ["Pasta", "Tacos"]
    assert week[0] == {
        "date": "2026-10-24",
        "dish": "Pasta",
        "notes": "Red sauce",
        "is_today": True,
        "uid": "a",
    }


async def test_resolve_provider_prefers_options_then_secrets(config):
    config.ha_config_dir.mkdir(parents=True)
    (config.ha_config_dir / "secrets.yaml").write_text("anthropic_api_key: sk-ant\n")
    assert await meals.resolve_provider_and_key(config) == ("anthropic", "sk-ant")
    config.openai_api_key = "sk-oai"
    assert await meals.resolve_provider_and_key(config) == ("openai", "sk-oai")
    config.ai_provider = "anthropic"
    assert await meals.resolve_provider_and_key(config) == ("anthropic", "sk-ant")


async def test_resolve_provider_without_keys(config):
    with pytest.raises(meals.AIError):
        await meals.resolve_provider_and_key(config)


def test_meal_prompts():
    prompt = meals._meal_plan_prompt("meal_prep", 4, 5, 5, "no pork", ["Chili"])
    assert "meal-prep" in prompt and "no pork" in prompt and "Chili" in prompt
    assert "Pasta" in meals._grocery_list_prompt([{"name": "Pasta"}], 4)


async def test_schedule_and_move_meals(setup):
    coordinator, ha, call, _kid = await _family(setup)
    ha.events["calendar.dinners"] = []
    with pytest.raises(services.ServiceError, match="Dinners calendar"):
        await call("schedule_meals", {"meals": []}, ADMIN)
    await call("update_calendar_settings", {"dinners_calendar": "calendar.dinners"}, ADMIN)
    await call(
        "schedule_meals",
        {"meals": [{"name": "Tacos", "date": "2026-10-24"}]},
        ADMIN,
    )
    [event] = ha.events["calendar.dinners"]
    assert (event["start"], event["end"]) == ({"date": "2026-10-24"}, {"date": "2026-10-25"})
    await call(
        "move_meal",
        {"uid": event["uid"], "name": "Tacos", "new_date": "2026-10-26"},
        ADMIN,
    )
    [moved] = ha.events["calendar.dinners"]
    assert moved["start"] == {"date": "2026-10-26"}
    with pytest.raises(services.ServiceError):
        await call("schedule_meals", {"meals": []}, {"id": "ha-kid"})


async def test_grocery_list_is_saved(setup, monkeypatch):
    coordinator, _ha, call, _kid = await _family(setup)

    async def fake_generate(session, config, meal_list, servings):
        return [{"category": "Produce", "items": ["Onions"]}]

    monkeypatch.setattr(meals, "generate_grocery_list", fake_generate)
    result = await call(
        "generate_grocery_list", {"meals": [{"name": "Tacos"}], "servings": 4}, ADMIN
    )
    assert result["categories"][0]["items"] == ["Onions"]
    assert coordinator.grocery_list["categories"] == result["categories"]
    states = build_states(coordinator.data)
    assert states["sensor.hustle_grocery_list"]["state"] == "1"


# ------------------------------------------------------------------ shopping


async def test_shopping_list_round_trip(setup):
    coordinator, ha, call, _kid = await _family(setup)
    kid_user = {"id": "ha-kid"}
    result = await call("shopping_add_items", {"items": ["Milk", " eggs ", "", "milk"]}, kid_user)
    assert result == {"added": 2}
    listing = await ShoppingList(ha, coordinator).items()
    assert listing["entity_id"] == "todo.shopping_list"
    assert [i["summary"] for i in listing["items"]] == ["Milk", "eggs"]

    milk, eggs = listing["items"]
    await call("shopping_update_item", {"uid": milk["uid"], "status": "completed"}, kid_user)
    # Re-sending a checked-off item adds it again; an unchecked one doesn't.
    assert (await call("shopping_add_items", {"items": ["Milk", "Eggs"]}, ADMIN)) == {"added": 1}
    await call("shopping_remove_items", {"uids": [eggs["uid"]]}, ADMIN)
    await call("shopping_clear_completed", {}, ADMIN)
    assert [i["summary"] for i in ha.todo["todo.shopping_list"]] == ["Milk"]


async def test_shopping_needs_a_member_and_parents_pick_the_list(setup):
    coordinator, ha, call, _kid = await _family(setup)
    with pytest.raises(services.ServiceError, match="No Hustle member"):
        await call("shopping_add_items", {"items": ["Milk"]}, {"id": "stranger"})
    with pytest.raises(services.ServiceError):
        await call("update_calendar_settings", {"shopping_list": "todo.costco"}, {"id": "ha-kid"})
    with pytest.raises(services.ServiceError, match="Invalid data"):
        await call("update_calendar_settings", {"shopping_list": "light.kitchen"}, ADMIN)
    await call("update_calendar_settings", {"shopping_list": "todo.costco"}, ADMIN)
    await call("shopping_add_items", {"items": ["Paper towels"]}, ADMIN)
    assert ha.todo["todo.costco"][0]["summary"] == "Paper towels"
    lists = await ShoppingList(ha, coordinator).list_lists()
    assert [entry["entity_id"] for entry in lists] == ["todo.costco", "todo.shopping_list"]


def test_shopping_defaults_to_home_assistants_list():
    from hustle_addon.storage import default_calendar_settings

    assert default_calendar_settings()["shopping_list"] == "todo.shopping_list"


# -------------------------------------------------------------- states/mqtt


async def test_states_carry_the_markers_the_panel_parses(setup):
    coordinator, _ha, call, kid = await _family(setup)
    await call("add_chore_definition", {"title": "Dishes", "payout_cents": 200}, ADMIN)
    definition = coordinator.chore_definitions[0]
    await call(
        "assign_chore",
        {
            "definition_id": definition.id,
            "member_ids": [kid.id],
            "due_date": date.today().isoformat(),
        },
        ADMIN,
    )
    states = build_states(coordinator.data)
    keys = {e["attributes"].get("hustle_key") for e in states.values()}
    assert {"member_roster", "household", "setup_status", "calendar_settings"} <= keys
    assert any("chore_definition_id" in e["attributes"] for e in states.values())
    assert any("chore_assignment_id" in e["attributes"] for e in states.values())
    progress = states["sensor.hustle_today_chore_progress"]["attributes"]["members"]
    assert progress[kid.id] == {"done": 0, "total": 1}


async def test_mqtt_keeps_integration_entity_ids(setup):
    coordinator, _ha, _call, kid = await _family(setup)
    messages = mqtt.build_messages(coordinator.data)
    configs = [
        json.loads(payload)
        for topic, payload in messages.items()
        if topic.endswith("/config")
    ]
    ids = {c["default_entity_id"] for c in configs}
    assert "sensor.hustle_pending_approvals_count" in ids
    assert "sensor.hustle_kim_pending_earnings" in ids
    assert all(c["device"]["name"] == "Family Hustle" for c in configs)
    stale = mqtt.stale_member_keys({"member_gone_pending_earnings"}, coordinator.data)
    assert stale == {"member_gone_pending_earnings"}
    assert not mqtt.stale_member_keys({f"member_{kid.id}_pending_earnings"}, coordinator.data)


# ------------------------------------------------------------------ migrate


def _write_store(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "minor_version": 1, "key": "k", "data": data}))


def test_migrate_imports_hustle_and_household(config):
    storage = config.ha_config_dir / ".storage"
    _write_store(
        storage / "hustle_data_abc",
        {
            "members": [],
            "chore_definitions": [{"id": "c1", "image_path": "/local/hustle_images/c1.png"}],
        },
    )
    _write_store(
        storage / "household_grocery_list",
        {"categories": [{"category": "Produce", "items": ["Kale"]}], "generated_at": "t"},
    )
    (storage / "core.config_entries").write_text(
        json.dumps(
            {
                "data": {
                    "entries": [
                        {"domain": "household", "data": {"calendar_entity": "calendar.dinners"}}
                    ]
                }
            }
        )
    )
    images = config.ha_config_dir / "www" / "hustle_images"
    images.mkdir(parents=True)
    (images / "c1.png").write_bytes(b"png")

    assert migrate.migrate_from_integrations(config)
    data = json.loads(config.store_path.read_text())["data"]
    assert data["chore_definitions"][0]["image_path"] == "images/c1.png"
    assert data["calendar_settings"]["dinners_calendar"] == "calendar.dinners"
    assert data["grocery_list"]["categories"][0]["items"] == ["Kale"]
    assert (config.images_dir / "c1.png").read_bytes() == b"png"
    assert not migrate.migrate_from_integrations(config)


def test_migrate_household_only_starts_a_fresh_store(config):
    storage = config.ha_config_dir / ".storage"
    storage.mkdir(parents=True)
    (storage / "core.config_entries").write_text(
        json.dumps(
            {
                "data": {
                    "entries": [{"domain": "household", "data": {"calendar_entity": "calendar.d"}}]
                }
            }
        )
    )
    assert migrate.migrate_from_integrations(config)
    data = json.loads(config.store_path.read_text())["data"]
    assert data["members"] == []
    assert data["calendar_settings"]["dinners_calendar"] == "calendar.d"


def test_migrate_nothing_to_import(config):
    assert not migrate.migrate_from_integrations(config)


# ---------------------------------------------------------------------- web


@pytest.fixture
async def client(setup, config, monkeypatch):
    coordinator, ha, _call = setup
    config.static_dir.mkdir(parents=True)
    (config.static_dir / "index.html").write_text("<html></html>")
    calendar = FamilyCalendar(ha, coordinator)
    shopping_list = ShoppingList(ha, coordinator)
    schemas = {
        **services.SCHEMAS,
        **family_calendar.SCHEMAS,
        **meals.SCHEMAS,
        **shopping.SCHEMAS,
    }
    handlers = {
        **services.build_handlers(coordinator),
        **family_calendar.build_handlers(coordinator, calendar),
        **shopping.build_handlers(coordinator, shopping_list),
    }
    # FakeHA isn't a HomeAssistantClient, so web.py treats this as a dev
    # run: the viewer is config.dev_user_id, an HA admin.
    config.dev_user_id = "ha-admin"
    app = web.create_app(config, coordinator, schemas, handlers, ha, calendar, shopping_list)
    async with TestClient(TestServer(app)) as test_client:
        yield test_client, coordinator, ha, monkeypatch


async def test_web_refuses_clients_other_than_ingress(client):
    test_client, *_ = client
    resp = await test_client.get("/api/states")
    assert resp.status == 403


async def test_web_services_states_and_calendar(client):
    test_client, coordinator, ha, monkeypatch = client
    monkeypatch.setenv("HUSTLE_ALLOW_ANY_CLIENT", "1")

    body = await (await test_client.get("/api/states")).json()
    assert body["user"] == {"id": "ha-admin", "name": "Developer", "is_admin": True}

    resp = await test_client.get("/api/calendar/events?start=2026-10-24&end=2026-10-31")
    assert resp.status == 400  # not a member yet

    resp = await test_client.post("/api/services/setup_family", json=SETUP)
    assert resp.status == 200, await resp.text()
    assert coordinator.members[0].ha_user_id == "ha-admin"

    ha.events["calendar.family"] = [
        {"summary": "Game", "start": {"date": "2026-10-25"}, "end": {"date": "2026-10-26"}}
    ]
    resp = await test_client.get(
        "/api/calendar/events?start=2026-10-24&end=2026-10-31&entity_id=calendar.family"
    )
    assert (await resp.json())["events"][0]["summary"] == "Game"

    start = date(2026, 1, 1)
    too_long = (start + timedelta(days=90)).isoformat()
    resp = await test_client.get(f"/api/calendar/events?start={start}&end={too_long}")
    assert resp.status == 400

    resp = await test_client.post("/api/services/nope", json={})
    assert resp.status == 400

    resp = await test_client.post("/api/services/shopping_add_items", json={"items": ["Bread"]})
    assert (await resp.json())["response"] == {"added": 1}
    items = await (await test_client.get("/api/shopping/items")).json()
    assert [i["summary"] for i in items["items"]] == ["Bread"]
    lists = await (await test_client.get("/api/shopping/lists")).json()
    assert {entry["name"] for entry in lists} == {"Shopping List", "Costco"}


# ------------------------------------------- repeats, admin-only settings


async def test_repeating_event_passes_its_rule_through(setup):
    coordinator, ha, call, kid = await _family(setup)
    ha.events["calendar.family"] = []
    await call("update_calendar_settings", {"default_calendar": "calendar.family"}, ADMIN)
    result = await call(
        "create_event",
        {
            "summary": "Soccer",
            "start": "2026-10-27T16:00:00-05:00",
            "end": "2026-10-27T17:30:00-05:00",
            "rrule": "rrule:freq=weekly;byday=tu,th;until=20261231",
            "for_member_id": kid.id,
        },
        ADMIN,
    )
    create = next(c for c in ha.commands if c["type"] == "calendar/event/create")
    assert create["event"]["rrule"] == "FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231"
    assert coordinator.event_tags[event_tag_key("calendar.family", result["uid"])]
    with pytest.raises(services.ServiceError, match="Invalid data"):
        await call(
            "create_event",
            {"summary": "x", "start": "2026-10-27T16:00:00", "rrule": "FREQ=HOURLY"},
            ADMIN,
        )


async def test_multi_day_timed_event_keeps_its_end(setup):
    _coordinator, ha, call, _kid = await _family(setup)
    ha.events["calendar.family"] = []
    await call("update_calendar_settings", {"default_calendar": "calendar.family"}, ADMIN)
    await call(
        "create_event",
        {
            "summary": "Camping",
            "start": "2026-10-30T15:00:00-05:00",
            "end": "2026-11-01T11:00:00-05:00",
        },
        ADMIN,
    )
    event = next(c for c in ha.commands if c["type"] == "calendar/event/create")["event"]
    assert (event["dtstart"], event["dtend"]) == (
        "2026-10-30T15:00:00-05:00",
        "2026-11-01T11:00:00-05:00",
    )


async def test_settings_are_for_admin_parents_only(setup):
    coordinator, _ha, call, _kid = await _family(setup)
    await call(
        "add_member",
        {
            "ha_user_id": "ha-standard",
            "ha_display_name": "Sam",
            "role": "parent",
            "permission_level": "standard",
        },
        ADMIN,
    )
    standard = {"id": "ha-standard"}
    with pytest.raises(services.ServiceError, match="admin"):
        await call("update_calendar_settings", {"show_dinners": False}, standard)
    # Standard parents still add and tag events.
    await call(
        "tag_event", {"entity_id": "calendar.family", "uid": "u1", "attendee_ids": []}, standard
    )
    await call("update_calendar_settings", {"show_dinners": False}, ADMIN)
    assert coordinator.calendar_settings["show_dinners"] is False


def test_event_bounds_without_offsets_use_local_time():
    start, end = family_calendar._event_bounds(
        {"all_day": False, "start": "2026-10-24T17:00:00", "end": "2026-10-24T18:00:00"}
    )
    assert start.startswith("2026-10-24T17:00:00") and end.startswith("2026-10-24T18:00:00")
    assert start[19:] == end[19:] != ""  # both got the same local offset
