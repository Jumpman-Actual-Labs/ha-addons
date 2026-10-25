"""The add-on-specific layers around the ported coordinator: the per-viewer
`hass.states`-shaped snapshot (states.py), MQTT discovery payloads
(mqtt.py), the one-time integration import (migrate.py), options
(config.py), the file-backed store (storage.py), the weekly plan job
(weekly.py) and the HTTP API the panel calls (web.py)."""
from __future__ import annotations

import json
from datetime import UTC, datetime, time

import pytest

from gains_addon import mqtt, web
from gains_addon.config import AddonConfig, load_config
from gains_addon.const import STORAGE_KEY, STORAGE_VERSION
from gains_addon.coordinator import GainsCoordinator
from gains_addon.migrate import migrate_from_integration
from gains_addon.services import ServiceError, async_call_service, build_handlers
from gains_addon.states import PROFILE_COUNT_ENTITY_ID, build_states, profile_entity_id
from gains_addon.storage import GainsStore
from gains_addon.web import create_app
from gains_addon.weekly import SUNDAY, seconds_until_next

PUSH_UP = {
    "exercise_id": "push_up",
    "rest_seconds": 90,
    "sets": [{"reps": 10, "weight": 0, "set_type": "working"}],
}


@pytest.fixture
def config(tmp_path) -> AddonConfig:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>gains</html>")
    return AddonConfig(
        data_dir=tmp_path / "data",
        ha_config_dir=tmp_path / "homeassistant",
        static_dir=static,
    )


@pytest.fixture
async def coordinator(config) -> GainsCoordinator:
    coord = GainsCoordinator(GainsStore(config.store_path))
    await coord.async_load()
    return coord


async def _seed(coordinator: GainsCoordinator):
    jordan = await coordinator.async_ensure_profile("user-jordan", "Jordan")
    sam = await coordinator.async_ensure_profile("user-sam", "Sam's")
    await coordinator.async_create_workout("user-jordan", "Chest", [PUSH_UP])
    return jordan, sam


# ---------------------------------------------------------------- services


async def test_service_schema_and_store_roundtrip(coordinator, config):
    """Was test_engine_ha.py's real-Home-Assistant test: the same calls,
    validated by the same schemas, persisted to disk."""
    handlers = build_handlers(coordinator)
    user = "synthetic-user"
    await async_call_service(handlers, "ensure_profile", user, {"display_name": "Synthetic"})
    await async_call_service(
        handlers, "update_profile", user, {"preferred_sequencing_policy": "calendar"}
    )
    await async_call_service(
        handlers, "create_workout", user, {"name": "Synthetic Chest", "exercises": [PUSH_UP]}
    )
    workout = coordinator.data.workouts[0]
    await async_call_service(handlers, "start_workout", user, {"workout_id": workout.id})
    await async_call_service(
        handlers,
        "log_set",
        user,
        {"workout_id": workout.id, "exercise_index": 0, "set_index": 0, "reps": 12, "weight": 0},
    )
    await async_call_service(
        handlers,
        "log_exercise_effort",
        user,
        {"workout_id": workout.id, "exercise_index": 0, "effort": "easy"},
    )

    restored = await GainsStore(config.store_path).async_load()
    exercise = restored.workouts[0].exercises[0]
    assert exercise.sets[0].actual_reps == 12
    assert exercise.rest_seconds == 90
    assert exercise.sets[0].set_type == "working"
    assert exercise.effort == "easy"
    assert restored.profiles[0].preferred_sequencing_policy == "calendar"


async def test_service_errors(coordinator):
    handlers = build_handlers(coordinator)
    with pytest.raises(ServiceError, match="Unknown service"):
        await async_call_service(handlers, "nope", "user-1", {})
    with pytest.raises(ServiceError, match="authenticated"):
        await async_call_service(handlers, "ensure_profile", "", {})
    with pytest.raises(ServiceError, match="extra keys"):
        await async_call_service(handlers, "ensure_profile", "user-1", {"profile_id": "x"})
    with pytest.raises(ServiceError, match="Unknown exercise_id"):
        await async_call_service(
            handlers, "create_workout", "user-1", {"name": "W", "exercises": [{"exercise_id": "?"}]}
        )
    await async_call_service(handlers, "ensure_profile", "user-1", {})
    with pytest.raises(ServiceError, match="only available in your own account"):
        # A handler's own ValueError, not the schema's.
        await async_call_service(
            handlers, "joint_session_action", "user-1", {"target_profile_id": "someone"}
        )
    # Only response services answer with data.
    assert await async_call_service(handlers, "ensure_profile", "user-1", {}) is None
    snapshot = await async_call_service(handlers, "training_state", "user-1", {})
    assert isinstance(snapshot, dict)


# ------------------------------------------------------------------ states


async def test_states_give_each_viewer_only_their_own_athlete_data(coordinator):
    jordan, sam = await _seed(coordinator)
    states = build_states(coordinator, "user-jordan")

    assert states[PROFILE_COUNT_ENTITY_ID]["state"] == "2"
    mine = states[profile_entity_id(jordan)]["attributes"]
    assert mine["ha_user_id"] == "user-jordan"
    assert len(mine["workouts"]) == 1
    assert "inventory_policy" in mine and "joint_targets" in mine
    theirs = states[profile_entity_id(sam)]["attributes"]
    assert theirs == {
        "profile_id": sam.id,
        "ha_user_id": "user-sam",
        "display_name": "Sam's",
        "onboarding_complete": False,
    }
    assert states[profile_entity_id(jordan)]["state"] == "unset"
    json.dumps(states)  # everything the websocket sends must serialize

    # Nobody's full data without a viewer.
    anonymous = build_states(coordinator, None)
    assert "workouts" not in anonymous[profile_entity_id(jordan)]["attributes"]


# -------------------------------------------------------------------- mqtt


async def test_mqtt_entities_keep_the_integrations_entity_ids(coordinator):
    jordan, sam = await _seed(coordinator)
    messages = mqtt.build_messages(coordinator)

    count = json.loads(messages[mqtt.discovery_topic("profile_count")])
    assert count["default_entity_id"] == "sensor.gains_profile_count"
    assert messages[count["state_topic"]] == "2"

    config = json.loads(messages[mqtt.discovery_topic(f"profile_{jordan.id}")])
    assert config["default_entity_id"] == "sensor.gains_jordan"
    assert messages[config["state_topic"]] == "unset"
    attributes = json.loads(messages[config["json_attributes_topic"]])
    assert attributes["profile_id"] == jordan.id
    assert attributes["workouts_completed"] == 0
    # Lists and dicts stay in the panel - see mqtt.py.
    assert "workouts" not in attributes and "ai_conversation" not in attributes
    assert not any(isinstance(v, (list, dict)) for v in attributes.values())

    sam_config = json.loads(messages[mqtt.discovery_topic(f"profile_{sam.id}")])
    assert sam_config["default_entity_id"] == "sensor.gains_sams"


async def test_mqtt_stale_profiles_are_cleared(coordinator):
    jordan, _ = await _seed(coordinator)
    published = {f"profile_{jordan.id}", "profile_gone", "profile_count"}
    assert mqtt.stale_dynamic_keys(published, coordinator) == {"profile_gone"}


# ----------------------------------------------------------------- migrate


def _write_integration_files(config: AddonConfig, options: dict | None = None) -> None:
    storage = config.ha_config_dir / ".storage"
    storage.mkdir(parents=True)
    envelope = {
        "version": STORAGE_VERSION,
        "minor_version": 1,
        "key": STORAGE_KEY,
        "data": {"profiles": [{"id": "p1", "ha_user_id": "u1", "display_name": "Jordan"}]},
    }
    (storage / STORAGE_KEY).write_text(json.dumps(envelope))
    entries = [
        {"domain": "cache", "options": {"anthropic_api_key": "not-ours"}},
        {"domain": "gains", "options": options or {}},
    ]
    (storage / "core.config_entries").write_text(json.dumps({"data": {"entries": entries}}))


async def test_migrate_imports_store_and_ai_settings_once(config, monkeypatch):
    _write_integration_files(
        config, {"ai_provider": "openai", "openai_api_key": "sk-old", "anthropic_api_key": ""}
    )
    assert migrate_from_integration(config) is True
    assert migrate_from_integration(config) is False  # never twice

    data = await GainsStore(config.store_path).async_load()
    assert data.profiles[0].id == "p1"
    assert json.loads(config.imported_settings_path.read_text()) == {
        "ai_provider": "openai",
        "openai_api_key": "sk-old",
    }

    # The imported settings fill in blank options; set options win.
    monkeypatch.setenv("GAINS_DATA_DIR", str(config.data_dir))
    loaded = load_config()
    assert (loaded.ai_provider, loaded.openai_api_key) == ("openai", "sk-old")
    (config.data_dir / "options.json").write_text(
        json.dumps(
            {"ai_provider": "anthropic", "anthropic_api_key": "sk-new", "openai_api_key": ""}
        )
    )
    loaded = load_config()
    assert (loaded.ai_provider, loaded.anthropic_api_key) == ("anthropic", "sk-new")
    assert loaded.openai_api_key == "sk-old"


def test_migrate_without_integration_data_does_nothing(config):
    assert migrate_from_integration(config) is False
    assert not config.store_path.exists()


# ----------------------------------------------------------------- storage


async def test_store_writes_home_assistants_envelope(config, coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    envelope = json.loads(config.store_path.read_text())
    assert envelope["key"] == STORAGE_KEY
    assert envelope["version"] == STORAGE_VERSION
    assert envelope["data"]["profiles"][0]["ha_user_id"] == "user-1"


# ------------------------------------------------------------------ weekly


def test_weekly_job_waits_for_sunday_2350():
    friday_noon = datetime(2026, 10, 23, 12, 0, tzinfo=UTC)
    assert seconds_until_next(friday_noon, time(23, 50), SUNDAY) == (2 * 24 + 11) * 3600 + 3000
    sunday_late = datetime(2026, 10, 25, 23, 55, tzinfo=UTC)
    assert seconds_until_next(sunday_late, time(23, 50), SUNDAY) == 7 * 24 * 3600 - 300


# --------------------------------------------------------------------- web


@pytest.fixture
async def client(aiohttp_client, config, coordinator, monkeypatch):
    monkeypatch.setenv("GAINS_ALLOW_ANY_CLIENT", "1")
    return await aiohttp_client(create_app(config, coordinator, build_handlers(coordinator)))


def _as(user_id: str, name: str = "") -> dict[str, str]:
    return {"X-Remote-User-Id": user_id, "X-Remote-User-Display-Name": name}


async def test_only_ingress_may_connect(aiohttp_client, config, coordinator, monkeypatch):
    monkeypatch.delenv("GAINS_ALLOW_ANY_CLIENT", raising=False)
    client = await aiohttp_client(create_app(config, coordinator, build_handlers(coordinator)))
    resp = await client.get("/api/states", headers=_as("user-1"))
    assert resp.status == 403


async def test_services_act_as_the_ingress_user(client, coordinator):
    resp = await client.post(
        "/api/services/ensure_profile", json={"display_name": "Jordan"}, headers=_as("user-1")
    )
    assert resp.status == 200
    assert await resp.json() == {"response": None}
    assert coordinator.get_profile_by_user_id("user-1").display_name == "Jordan"

    resp = await client.post(
        "/api/services/training_state", json={}, headers=_as("user-1")
    )
    assert "response" in await resp.json()

    resp = await client.post(
        "/api/services/ensure_profile", json={"bogus": 1}, headers=_as("user-1")
    )
    assert resp.status == 400
    assert "extra keys" in (await resp.json())["error"]


async def test_dev_run_has_a_stand_in_viewer(client):
    body = await (await client.get("/api/states")).json()
    assert body["user"] == {"id": web.DEV_USER_ID, "name": "Developer"}


async def test_websocket_pushes_each_viewer_their_own_snapshot(client, coordinator):
    jordan, sam = await _seed(coordinator)
    ws_jordan = await client.ws_connect("/api/websocket", headers=_as("user-jordan", "Jordan"))
    ws_sam = await client.ws_connect("/api/websocket", headers=_as("user-sam"))

    first = await ws_jordan.receive_json()
    assert first["user"] == {"id": "user-jordan", "name": "Jordan"}
    assert "workouts" in first["states"][profile_entity_id(jordan)]["attributes"]
    assert "workouts" not in first["states"][profile_entity_id(sam)]["attributes"]
    await ws_sam.receive_json()

    await coordinator.async_create_workout("user-sam", "Legs", [PUSH_UP])
    pushed_jordan = await ws_jordan.receive_json()
    pushed_sam = await ws_sam.receive_json()
    assert "user" not in pushed_jordan
    assert "workouts" not in pushed_jordan["states"][profile_entity_id(sam)]["attributes"]
    assert len(pushed_sam["states"][profile_entity_id(sam)]["attributes"]["workouts"]) == 1
    await ws_jordan.close()
    await ws_sam.close()


async def test_index_is_never_cached(client):
    resp = await client.get("/")
    assert resp.headers["Cache-Control"] == "no-cache"
    assert "gains" in await resp.text()


# ------------------------------------------------------- runs switched off


async def test_runs_off_rejects_the_run_builder_and_run_services(coordinator):
    from gains_addon import training

    with pytest.raises(ValueError, match="workout or program"):
        training.build_request({"type": "run", "source": "wizard", "answers": {}})
    handlers = build_handlers(coordinator)
    for name in ("create_run", "log_run", "skip_run", "share_run"):
        assert name not in handlers
    assert training.actions(
        [
            {"type": "start_builder", "builder": "run"},
            {"type": "start_builder", "builder": "workout"},
        ]
    ) == [{"type": "start_builder", "builder": "workout", "prefill": {}}]


async def test_runs_off_programs_get_no_run_days(coordinator):
    from gains_addon import training
    from tests.inventory_fixtures import equip

    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    equip(athlete, coordinator.data)
    request = training.build_request(
        {"type": "program", "source": "wizard", "answers": {"lifting_days": 3, "running_days": 2}}
    )
    assert request["answers"]["running_days"] == 0
    program = training.fallback_program(request, athlete, coordinator.data)
    kinds = {s["type"] for week in program["weeks"] for s in week["sessions"]}
    assert "run" not in kinds


async def test_runs_off_geoffrey_is_told_and_run_proposals_are_dropped(coordinator):
    from gains_addon import training
    from tests.test_coordinator import FakeAIProvider

    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    assert training.RUNS_OFF_PROMPT in training.system_prompt(athlete, coordinator.data, athlete)
    coordinator.ai_provider = FakeAIProvider(
        reply='{"reply": "Go run.", "proposed_workouts": [], '
        '"proposed_runs": [{"name": "Easy Run", "run_type": "easy"}]}'
    )
    result = await coordinator.async_ai_chat("u", "plan a run")
    assert result.proposed_runs == []


# ---------------------------------------------------------------- pictures


async def test_coach_athletes_carry_their_home_assistant_picture(coordinator):
    from gains_addon.ha_client import person_pictures

    pictures = person_pictures(
        [
            {
                "entity_id": "person.june",
                "attributes": {"user_id": "user-june", "entity_picture": "/api/image/j"},
            },
            {"entity_id": "person.nouser", "attributes": {"entity_picture": "/x.png"}},
            {"entity_id": "sensor.other", "attributes": {"user_id": "u", "entity_picture": "/y"}},
        ]
    )
    assert pictures == {"user-june": "/api/image/j"}

    coach = await coordinator.async_ensure_profile("user-coach", "Coach")
    june = await coordinator.async_ensure_profile("user-june", "June")
    jody = await coordinator.async_ensure_profile("user-jody", "jody")
    for athlete in (june, jody):
        await coordinator.async_set_coach_permissions(
            athlete.ha_user_id, coach.id, {"view_workouts": True}, "coach"
        )

    async def source() -> dict[str, str]:
        return pictures

    snapshot = await async_call_service(
        build_handlers(coordinator, source), "training_state", "user-coach", {}
    )
    by_name = {c["display_name"]: c["picture"] for c in snapshot["coachable_profiles"]}
    assert by_name == {"June": "/api/image/j", "jody": None}


async def test_internal_schedule_is_only_for_family_hustle(
    aiohttp_client, config, coordinator, monkeypatch
):
    from gains_addon.web import sibling_hostname

    assert sibling_hostname("a1b2c3d4-gains", "family-hustle") == "a1b2c3d4-family-hustle"
    assert sibling_hostname("localhost", "family-hustle") is None
    monkeypatch.delenv("GAINS_ALLOW_ANY_CLIENT", raising=False)
    client = await aiohttp_client(create_app(config, coordinator, build_handlers(coordinator)))
    resp = await client.get("/internal/schedule?start=2026-10-01&end=2026-10-08")
    assert resp.status == 403


async def test_internal_schedule_answers(client):
    resp = await client.get("/internal/schedule?start=2026-10-01&end=2026-10-08")
    assert resp.status == 200
    assert await resp.json() == {"workouts": []}
    resp = await client.get("/internal/schedule?start=2026-10-01&end=2027-10-08")
    assert resp.status == 400
