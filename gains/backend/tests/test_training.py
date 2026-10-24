"""Training generation, compatibility and explicit coaching authorization."""

from __future__ import annotations

import copy
import json
from datetime import date

import pytest

from gains_addon import training
from gains_addon.models import GainsData, TrainingProgram
from tests.inventory_fixtures import equip
from tests.test_coordinator import FakeAIProvider
from tests.test_coordinator import coordinator as base_coordinator


@pytest.fixture(name="coordinator")
async def training_coordinator():
    return await base_coordinator.__wrapped__()


WORKOUT = {
    "name": "Bodyweight",
    "exercises": [{"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}]}],
}
RUN = {
    "name": "Intervals",
    "run_type": "intervals",
    "segments": [
        {"phase": "warmup", "label": "Easy", "duration_seconds": 600},
        {
            "phase": "main",
            "label": "400s",
            "distance_m": 400,
            "repetitions": 6,
            "recovery_seconds": 90,
        },
        {"phase": "cooldown", "label": "Easy", "duration_seconds": 600},
    ],
}
# Use the integration's actual enum for interval prescriptions.
RUN["run_type"] = (
    "interval"
    if "interval" in training.RUN_TYPES
    else "speed"
    if "speed" in training.RUN_TYPES
    else "easy"
)
PROGRAM = {
    "name": "Four weeks",
    "goal": "Consistency",
    "start_date": "2026-09-14",
    "weeks": [
        {
            "focus": "Build gradually",
            "sessions": [
                {"day": 0, "name": "Strength", "type": "workout", "prescription": WORKOUT},
                {"day": 2, "name": "Run", "type": "run", "prescription": RUN},
                {"day": 6, "name": "Rest", "type": "rest", "prescription": {}},
            ],
        }
        for _ in range(4)
    ],
}


async def family(coord):
    coach = await coord.async_ensure_profile("coach-user", "Jordan")
    athlete = await coord.async_ensure_profile("athlete-user", "June")
    await coord.async_link_account("coach-user", athlete.id)
    workout = await coord.async_create_workout("athlete-user", **WORKOUT)
    await coord.async_start_workout("athlete-user", workout.id)
    return coach, athlete, workout


async def grant(coord, coach, permissions=None):
    await coord.async_set_coach_permissions(
        "athlete-user", coach.id, permissions or dict.fromkeys(training.PERMISSIONS, True)
    )


@pytest.mark.parametrize("kind,payload", [("workout", WORKOUT), ("run", RUN), ("program", PROGRAM)])
async def test_shared_structured_generation_and_acceptance(coordinator, kind, payload):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    coordinator.ai_provider = FakeAIProvider(reply=json.dumps({"proposal": payload}))
    p = await coordinator.async_build_training(
        "u", {"type": kind, "source": "wizard", "answers": {"duration": 45}}
    )
    assert p["profile_id"] == athlete.id
    assert (
        not coordinator.data.workouts
        and not coordinator.data.runs
        and not coordinator.data.programs
    )
    prompt, messages = coordinator.ai_provider.calls[0]
    assert "ATHLETE CONTEXT" in prompt
    assert "training_build_request" in json.loads(messages[0]["content"])
    accepted = await coordinator.async_accept_training("u", p["id"], p["payload"])
    assert await coordinator.async_accept_training("u", p["id"], p["payload"]) == accepted
    restored = GainsData.from_dict(coordinator.data.to_dict())
    if kind == "program":
        assert restored.programs[0].weeks[0]["sessions"][0]["id"] == "w1s1"
        assert restored.programs[0].id == accepted["id"]
        assert not restored.workouts
    elif kind == "run":
        assert restored.runs[0].segments[1]["recovery_seconds"] == 90


async def test_coaching_requires_directional_grant_not_link_or_admin(coordinator):
    coach, athlete, workout = await family(coordinator)
    assert coach.is_admin
    with pytest.raises(ValueError):
        await coordinator.async_training_state("coach-user", athlete.id)
    with pytest.raises(ValueError):
        await coordinator.async_session_action(
            "coach-user",
            athlete.id,
            "log_set",
            {
                "workout_id": workout.id,
                "exercise_index": 0,
                "set_index": 0,
                "reps": 10,
                "weight": 0,
            },
        )
    # Original self-only path stays self-only.
    assert await coordinator.async_log_set("coach-user", workout.id, 0, 0, 10, 0) is None
    with pytest.raises(ValueError):
        await coordinator.async_set_coach_permissions(
            "coach-user", "arbitrary", {"coach_workouts": True}
        )
    assert not workout.exercises[0].sets[0].completed


async def test_coaching_grant_does_not_require_linking(coordinator):
    coach = await coordinator.async_ensure_profile("coach-user", "Jordan")
    athlete = await coordinator.async_ensure_profile("athlete-user", "June")
    # Deliberately no async_link_account call.
    assert coach.id not in athlete.linked_profile_ids

    await coordinator.async_set_coach_permissions(
        "athlete-user", coach.id, dict.fromkeys(training.PERMISSIONS, True)
    )
    snapshot = await coordinator.async_training_state("coach-user", athlete.id)
    assert snapshot["active_profile_id"] == athlete.id


async def test_kids_are_auto_coachable_by_non_kid_profiles_without_a_grant(coordinator):
    await coordinator.async_ensure_profile("parent-user", "Jordan")
    await coordinator.async_update_profile("parent-user", experience_level="intermediate")
    kid = await coordinator.async_ensure_profile("kid-user", "June")
    await coordinator.async_update_profile("kid-user", experience_level="kids")
    # Deliberately no link and no async_set_coach_permissions call.

    snapshot = await coordinator.async_training_state("parent-user", kid.id)
    assert snapshot["active_profile_id"] == kid.id
    assert snapshot["permissions"] == dict.fromkeys(training.PERMISSIONS, True)
    assert kid.id in [c["profile_id"] for c in snapshot["coachable_profiles"]]

    workout = await coordinator.async_create_workout("kid-user", **WORKOUT)
    await coordinator.async_start_workout("kid-user", workout.id)
    logged = await coordinator.async_session_action(
        "parent-user",
        kid.id,
        "log_set",
        {"workout_id": workout.id, "exercise_index": 0, "set_index": 0, "reps": 8, "weight": 0},
    )
    assert logged is not None


async def test_kid_cannot_auto_coach_a_non_kid_profile(coordinator):
    await coordinator.async_ensure_profile("kid-user", "June")
    await coordinator.async_update_profile("kid-user", experience_level="kids")
    adult = await coordinator.async_ensure_profile("adult-user", "Jordan")

    with pytest.raises(ValueError):
        await coordinator.async_training_state("kid-user", adult.id)


async def test_kids_can_create_plan_and_log_weighted_sets(coordinator):
    await coordinator.async_ensure_profile("parent-user", "Jordan")
    kid = await coordinator.async_ensure_profile("kid-user", "June")
    await coordinator.async_update_profile("kid-user", experience_level="kids")

    workout = await coordinator.async_create_workout(
        "kid-user",
        name="Youth Bench",
        exercises=[
            {
                "exercise_id": "barbell_bench_press",
                "sets": [{"reps": 8, "weight": 20}],
            }
        ],
    )
    assert workout.exercises[0].sets[0].planned_weight == 20

    await coordinator.async_start_workout("kid-user", workout.id)
    planned = await coordinator.async_session_action(
        "parent-user",
        kid.id,
        "plan_set",
        {
            "workout_id": workout.id,
            "exercise_index": 0,
            "set_index": 0,
            "reps": 8,
            "weight": 25,
        },
    )
    assert planned["saved"] is True
    assert workout.exercises[0].sets[0].planned_weight == 25

    logged = await coordinator.async_session_action(
        "parent-user",
        kid.id,
        "log_set",
        {
            "workout_id": workout.id,
            "exercise_index": 0,
            "set_index": 0,
            "reps": 8,
            "weight": 25,
        },
    )
    assert logged["saved"] is True
    assert workout.exercises[0].sets[0].actual_weight == 25


async def test_session_can_select_a_configured_bar_for_plate_math(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    gym = await coordinator.async_create_gym_profile(
        "u",
        "Home Gym",
        {
            "olympic_barbell": [45.0],
            "short_bar": [20.0, 5.0],
            "plates": [45.0, 25.0, 10.0, 5.0, 2.5],
        },
    )
    await coordinator.async_select_gym_profile("u", gym.id)
    workout = await coordinator.async_create_workout(
        "u",
        name="Squat",
        exercises=[
            {
                "exercise_id": "barbell_back_squat",
                "sets": [{"reps": 8, "weight": 45}],
            }
        ],
    )
    assert workout.exercises[0].selected_bar_equipment_id == "olympic_barbell"
    assert workout.exercises[0].selected_bar_weight == 45
    await coordinator.async_start_workout("u", workout.id)

    result = await coordinator.async_session_action(
        "u",
        None,
        "set_bar",
        {
            "workout_id": workout.id,
            "exercise_index": 0,
            "equipment_id": "short_bar",
            "bar_weight": 20,
        },
    )
    assert result["saved"] is True
    assert workout.exercises[0].selected_bar_equipment_id == "short_bar"
    assert workout.exercises[0].selected_bar_weight == 20
    assert athlete.last_bar_by_exercise["barbell_back_squat"] == {
        "equipment_id": "short_bar",
        "weight": 20,
    }

    next_workout = await coordinator.async_create_workout(
        "u",
        name="Squat again",
        exercises=[
            {
                "exercise_id": "barbell_back_squat",
                "sets": [{"reps": 8, "weight": 65}],
            }
        ],
    )
    assert next_workout.exercises[0].selected_bar_equipment_id == "short_bar"
    assert next_workout.exercises[0].selected_bar_weight == 20

    with pytest.raises(ValueError, match="not configured"):
        await coordinator.async_session_action(
            "u",
            None,
            "set_bar",
            {
                "workout_id": workout.id,
                "exercise_index": 0,
                "equipment_id": "short_bar",
                "bar_weight": 15,
            },
        )

    assert athlete.gym_profile_id == gym.id


async def test_coach_mode_share_workout_acts_on_behalf_of_the_kid(coordinator):
    await coordinator.async_ensure_profile("parent-user", "Jordan")
    kid = await coordinator.async_ensure_profile("kid-user", "June")
    await coordinator.async_update_profile("kid-user", experience_level="kids")
    recipient = await coordinator.async_ensure_profile("friend-user", "Alex")
    workout = await coordinator.async_create_workout("kid-user", **WORKOUT)

    request = await coordinator.async_share_workout(
        "parent-user", workout.id, recipient.id, acting_profile_id=kid.id
    )
    assert request is not None
    assert request.from_profile_id == kid.id
    assert request.to_profile_id == recipient.id

    # A parent cannot share their own item while claiming to act as the kid.
    other_workout = await coordinator.async_create_workout("parent-user", **WORKOUT)
    assert (
        await coordinator.async_share_workout(
            "parent-user", other_workout.id, recipient.id, acting_profile_id=kid.id
        )
        is None
    )


async def test_coach_mode_share_requires_permission_without_kid_auto_grant(coordinator):
    coach = await coordinator.async_ensure_profile("coach-user", "Jordan")
    athlete = await coordinator.async_ensure_profile("athlete-user", "June")
    friend = await coordinator.async_ensure_profile("friend-user", "Alex")
    workout = await coordinator.async_create_workout("athlete-user", **WORKOUT)

    with pytest.raises(ValueError):
        await coordinator.async_share_workout(
            "coach-user", workout.id, friend.id, acting_profile_id=athlete.id
        )

    await coordinator.async_set_coach_permissions(
        "athlete-user", coach.id, {"coach_workouts": True}
    )
    request = await coordinator.async_share_workout(
        "coach-user", workout.id, friend.id, acting_profile_id=athlete.id
    )
    assert request is not None
    assert request.from_profile_id == athlete.id


async def test_coach_mode_respond_share_accepts_on_behalf_of_the_kid(coordinator):
    await coordinator.async_ensure_profile("parent-user", "Jordan")
    kid = await coordinator.async_ensure_profile("kid-user", "June")
    await coordinator.async_update_profile("kid-user", experience_level="kids")
    await coordinator.async_ensure_profile("friend-user", "Alex")
    workout = await coordinator.async_create_workout("friend-user", **WORKOUT)
    request = await coordinator.async_share_workout("friend-user", workout.id, kid.id)

    accepted = await coordinator.async_respond_share(
        "parent-user", request.id, True, acting_profile_id=kid.id
    )
    assert accepted is not None
    assert accepted.profile_id == kid.id


async def test_coach_snapshot_exposes_athletes_real_share_targets_and_incoming_shares(coordinator):
    parent = await coordinator.async_ensure_profile("parent-user", "Jordan")
    kid = await coordinator.async_ensure_profile("kid-user", "June")
    await coordinator.async_update_profile("kid-user", experience_level="kids")
    friend = await coordinator.async_ensure_profile("friend-user", "Alex")
    workout = await coordinator.async_create_workout("friend-user", **WORKOUT)
    await coordinator.async_share_workout("friend-user", workout.id, kid.id)

    snapshot = await coordinator.async_training_state("parent-user", kid.id)
    attrs = snapshot["attributes"]
    assert {p["profile_id"] for p in attrs["share_targets"]} == {parent.id, friend.id}
    assert len(attrs["incoming_shares"]) == 1
    assert attrs["incoming_shares"][0]["from_display_name"] == "Alex"


async def test_read_only_grant_cannot_log_or_view_history(coordinator):
    coach, athlete, workout = await family(coordinator)
    await grant(coordinator, coach, {"view_workouts": True})
    snapshot = await coordinator.async_training_state("coach-user", athlete.id)
    assert snapshot["attributes"]["workouts"][0]["id"] == workout.id
    assert snapshot["attributes"]["personal_records"] == {}
    assert "muscle_recovery" not in snapshot["attributes"]
    with pytest.raises(ValueError):
        await coordinator.async_session_action(
            "coach-user", athlete.id, "complete_workout", {"workout_id": workout.id}
        )


async def test_authorized_log_attribution_wrong_target_and_revision(coordinator):
    coach, athlete, workout = await family(coordinator)
    await grant(coordinator, coach)
    await coordinator.async_session_action(
        "coach-user",
        athlete.id,
        "plan_set",
        {
            "workout_id": workout.id,
            "exercise_index": 0,
            "set_index": 0,
            "reps": 12,
            "weight": 5,
            "expected_revision": workout.revision,
        },
    )
    assert workout.exercises[0].sets[0].planned_reps == 12
    assert workout.exercises[0].sets[0].planned_weight == 5
    fields = {
        "workout_id": workout.id,
        "exercise_index": 0,
        "set_index": 0,
        "reps": 12,
        "weight": 5,
        "expected_revision": workout.revision,
    }
    await coordinator.async_session_action("coach-user", athlete.id, "log_set", fields)
    s = workout.exercises[0].sets[0]
    assert s.recorded_by_profile_id == coach.id and s.recorded_at
    assert workout.profile_id == athlete.id
    with pytest.raises(ValueError, match="changed"):
        await coordinator.async_session_action("coach-user", athlete.id, "log_set", fields)
    other = await coordinator.async_create_workout("coach-user", **WORKOUT)
    with pytest.raises(ValueError, match="belong"):
        await coordinator.async_session_action(
            "coach-user", athlete.id, "log_set", {**fields, "workout_id": other.id}
        )
    await coordinator.async_set_coach_permissions("athlete-user", coach.id, {})
    with pytest.raises(ValueError):
        await coordinator.async_training_state("coach-user", athlete.id)


async def test_unlink_revokes_and_relink_does_not_restore_grant(coordinator):
    coach, athlete, _ = await family(coordinator)
    await grant(coordinator, coach)
    await coordinator.async_unlink_account("athlete-user", coach.id)
    await coordinator.async_link_account("athlete-user", coach.id)
    with pytest.raises(ValueError):
        await coordinator.async_training_state("coach-user", athlete.id)


async def test_legacy_storage_additive_defaults_and_sharing(coordinator):
    coach, athlete, workout = await family(coordinator)
    raw = coordinator.data.to_dict()
    for p in raw["profiles"]:
        p.pop("coach_grants", None)
    raw.pop("programs", None)
    raw.pop("training_proposals", None)
    raw.pop("share_requests", None)
    restored = GainsData.from_dict(raw)
    assert not restored.programs
    assert not restored.share_requests
    assert all(not p.coach_grants for p in restored.profiles)
    assert restored.profiles[0].linked_profile_ids == [athlete.id]
    shared = await coordinator.async_share_workout("athlete-user", workout.id, coach.id)
    assert shared.to_profile_id == coach.id
    accepted = await coordinator.async_respond_share("coach-user", shared.id, True)
    assert accepted.profile_id == coach.id
    assert not accepted.exercises[0].sets[0].completed


async def test_geoffrey_actions_and_coach_context_do_not_leak_private_chat(coordinator):
    coach, athlete, workout = await family(coordinator)
    await grant(coordinator, coach)
    coordinator.ai_provider = FakeAIProvider(
        reply=json.dumps(
            {
                "reply": "Let's build a hybrid program",
                "actions": [
                    {
                        "type": "start_builder",
                        "builder": "program",
                        "prefill": {"race_distance": "10K", "lifting_days": 4},
                    }
                ],
            }
        )
    )
    reply = await coordinator.async_ai_chat(
        "coach-user", "Help him train", target_profile_id=athlete.id
    )
    assert reply.actions[0]["prefill"]["lifting_days"] == 4
    assert not athlete.ai_conversation
    snapshot = await coordinator.async_training_state("coach-user", athlete.id)
    assert snapshot["attributes"]["ai_conversation"][-1]["content"] == reply.content
    context = training.athlete_context(athlete, coordinator.data, coach)
    assert context["athlete"]["id"] == athlete.id and context["viewer"]["id"] == coach.id
    assert context["recent_workouts"][0]["id"] == workout.id


async def test_revocation_during_generation_rejected(coordinator):
    coach, athlete, _ = await family(coordinator)
    await grant(coordinator, coach)

    class RevokingProvider:
        async def complete(self, prompt, messages):
            await coordinator.async_set_coach_permissions("athlete-user", coach.id, {})
            return json.dumps({"proposal": WORKOUT})

    coordinator.ai_provider = RevokingProvider()
    with pytest.raises(ValueError):
        await coordinator.async_build_training(
            "coach-user", {"type": "workout", "source": "wizard", "answers": {}}, athlete.id
        )
    assert not coordinator.data.training_proposals


async def test_program_materialization_is_idempotent_and_linked(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    valid = training.validate_program(PROGRAM, athlete, coordinator.data)
    program = TrainingProgram(id="p", profile_id=athlete.id, **valid)
    coordinator.data.programs.append(program)
    first = await coordinator.async_program_action("u", "p", "open_session", {"session_id": "w1s1"})
    second = await coordinator.async_program_action(
        "u", "p", "open_session", {"session_id": "w1s1"}
    )
    assert first == second
    assert len(coordinator.data.workouts) == 1
    assert coordinator.data.workouts[0].program_id == "p"
    assert coordinator.data.workouts[0].program_session_id == "w1s1"


async def test_program_preview_repairs_deleted_workout_reference(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="p", profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    first = await coordinator.async_program_action("u", "p", "open_session", {"session_id": "w1s1"})
    await coordinator.async_delete_workout("u", first["id"])
    second = await coordinator.async_program_action(
        "u", "p", "open_session", {"session_id": "w1s1", "start_now": False}
    )
    state = await coordinator.async_training_state("u")
    workout = next(w for w in state["attributes"]["workouts"] if w["id"] == second["id"])
    assert workout["status"] == "planned"
    assert workout["exercises"][0]["exercise_id"] == "push_up"
    assert second["id"] != first["id"]
    again = await coordinator.async_program_action(
        "u", "p", "open_session", {"session_id": "w1s1"}
    )
    assert again == second


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -1, True, False])
async def test_invalid_numeric_proposals_rejected(coordinator, bad):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    p = copy.deepcopy(WORKOUT)
    p["exercises"][0]["sets"][0]["weight"] = bad
    with pytest.raises(ValueError):
        training.validate_workout(p, athlete, coordinator.data)


async def test_kids_can_use_weighted_exercises_and_loads(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "June")
    athlete.experience_level = "kids"
    weighted = copy.deepcopy(WORKOUT)
    weighted["exercises"][0]["exercise_id"] = "barbell_bench_press"
    weighted["exercises"][0]["sets"][0]["weight"] = 10

    validated = training.validate_workout(weighted, athlete, coordinator.data)

    assert validated["exercises"][0]["exercise_id"] == "barbell_bench_press"
    assert validated["exercises"][0]["sets"][0]["weight"] == 10


async def test_incomplete_ai_program_uses_valid_ongoing_fallback(coordinator):
    await coordinator.async_ensure_profile("u", "Jordan")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    short = copy.deepcopy(PROGRAM)
    short["weeks"].append(copy.deepcopy(short["weeks"][0]))
    coordinator.ai_provider = FakeAIProvider(reply=json.dumps({"proposal": short}))
    proposal = await coordinator.async_build_training(
        "u",
        {
            "type": "program",
            "source": "wizard",
            "answers": {
                "lifting_days": 4,
                "running_days": 2,
                "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Sunday"],
            },
        },
    )
    assert len(proposal["payload"]["weeks"]) == 1
    assert len(proposal["payload"]["weeks"][0]["sessions"]) == 6
    assert len(coordinator.ai_provider.calls) == 2
    assert len(coordinator.data.training_proposals) == 1


async def test_builder_accepts_direct_structured_proposal_shape(coordinator):
    await coordinator.async_ensure_profile("u", "Jordan")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    coordinator.ai_provider = FakeAIProvider(reply=json.dumps(WORKOUT))
    proposal = await coordinator.async_build_training(
        "u", {"type": "workout", "source": "wizard", "answers": {}}
    )
    assert proposal['payload']['planning']['session_spec']['focus'] == 'full body'
    assert proposal['payload']['exercises']


async def test_builder_accepts_named_program_envelope(coordinator):
    await coordinator.async_ensure_profile("u", "Jordan")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    coordinator.ai_provider = FakeAIProvider(reply=json.dumps({"program": PROGRAM}))
    proposal = await coordinator.async_build_training(
        "u", {"type": "program", "source": "wizard", "answers": {}}
    )
    assert proposal["payload"]["name"] == PROGRAM["name"]


async def test_program_normalizes_nested_workouts_before_validation(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    proposed = copy.deepcopy(PROGRAM)
    proposed["weeks"][0]["sessions"][0]["prescription"]["exercises"].insert(
        0, {"exercise_id": "invented_machine", "sets": [{"reps": 8, "weight": 50}]}
    )
    normalized = training.normalize_generated("program", proposed, athlete, coordinator.data)
    assert normalized["weeks"][0]["sessions"][0]["prescription"]["exercises"] == [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0.0}]}
    ]


async def test_malformed_builder_response_is_retried_and_validated(coordinator):
    await coordinator.async_ensure_profile("u", "Jordan")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)

    class RepairingProvider:
        def __init__(self):
            self.calls = []

        async def complete(self, prompt, messages):
            self.calls.append((prompt, list(messages)))
            if len(self.calls) == 1:
                return '{"proposal": {"name": "broken"'
            return json.dumps({"proposal": WORKOUT})

    provider = RepairingProvider()
    coordinator.ai_provider = provider
    proposal = await coordinator.async_build_training(
        "u", {"type": "workout", "source": "wizard", "answers": {}}
    )
    assert proposal['payload']['planning']['session_spec']['focus'] == 'full body'
    assert len(provider.calls) == 2
    assert "previous response was invalid" in provider.calls[1][1][-1]["content"]


def test_program_requests_are_ongoing_and_ignore_legacy_duration_answer():
    request = training.build_request(
        {
            "type": "program",
            "source": "wizard",
            "answers": {"weeks": "Other", "weeks_other": "Unlimited", "lifting_days": 4},
        }
    )
    assert request["answers"] == {"lifting_days": 4, "schedule_model": "ongoing", "cycle_weeks": 1}


async def test_paused_program_cannot_materialize_and_open_increments_revision(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="p",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    program.status = "paused"
    with pytest.raises(ValueError, match="Activate"):
        await coordinator.async_program_action("u", "p", "open_session", {"session_id": "w1s1"})
    assert not coordinator.data.workouts
    program.status = "active"
    revision = program.revision
    await coordinator.async_program_action("u", "p", "open_session", {"session_id": "w1s1"})
    assert program.revision == revision + 1


async def test_ongoing_program_cycle_creates_distinct_weekly_occurrences(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="ongoing",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    first = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-1:w1s1"}
    )
    next_cycle = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-5:w1s1"}
    )
    assert first["id"] != next_cycle["id"]
    assert len(coordinator.data.workouts) == 2
    assert coordinator.data.workouts[1].program_session_id == "week-5:w1s1"
    assert set(program.occurrences) == {"week-1:w1s1", "week-5:w1s1"}
    await coordinator.async_program_action("u", program.id, "delete", {})
    assert not coordinator.data.programs
    assert len(coordinator.data.workouts) == 2


async def test_upcoming_program_sessions_can_start_before_scheduled_day(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    raw = copy.deepcopy(PROGRAM)
    raw["start_date"] = date.today().isoformat()
    program = TrainingProgram(
        id="flexible",
        profile_id=athlete.id,
        **training.validate_program(raw, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    state = training.program_state(program, coordinator.data)
    assert 1 <= len(state["upcoming_sessions"]) <= 8
    future_workout = next(
        session
        for session in state["upcoming_sessions"]
        if session["type"] == "workout" and session["scheduled_date"] >= date.today().isoformat()
    )
    result = await coordinator.async_program_action(
        "u",
        program.id,
        "open_session",
        {"session_id": future_workout["id"], "start_now": True},
    )
    workout = next(item for item in coordinator.data.workouts if item.id == result["id"])
    assert workout.status == "active"
    assert workout.program_session_id == future_workout["id"]


async def test_revocation_during_failed_chat_does_not_save_coach_conversation(coordinator):
    from gains_addon.ai import AIProviderError

    coach, athlete, _ = await family(coordinator)
    await grant(coordinator, coach)

    class FailingProvider:
        async def complete(self, prompt, messages):
            await coordinator.async_set_coach_permissions("athlete-user", coach.id, {})
            raise AIProviderError("Unavailable")

    coordinator.ai_provider = FailingProvider()
    with pytest.raises(ValueError):
        await coordinator.async_ai_chat("coach-user", "Help", target_profile_id=athlete.id)
    assert not athlete.coaching_conversations


async def test_self_mode_attribution_and_live_snapshot(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    w = await coordinator.async_create_workout("u", **WORKOUT)
    await coordinator.async_start_workout("u", w.id)
    await coordinator.async_session_action(
        "u",
        None,
        "log_set",
        {"workout_id": w.id, "exercise_index": 0, "set_index": 0, "reps": 8, "weight": 0},
    )
    snapshot = await coordinator.async_training_state("u")
    assert snapshot["mode"] == "self"
    assert (
        snapshot["attributes"]["workouts"][0]["exercises"][0]["sets"][0]["recorded_by_profile_id"]
        == athlete.id
    )


async def test_progress_state_reflects_own_data(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    await coordinator.async_update_profile("u", bodyweight=180)
    athlete.personal_records["barbell_bench_press"] = 180

    result = await coordinator.async_progress_state("u")
    assert result["strength_score"]["overall_score"] == 100
    assert result["streak_days"] == 0
    assert result["this_month"]["workouts_completed"] == 0


async def test_progress_state_requires_view_progress_permission_for_a_coach(coordinator):
    coach, athlete, _ = await family(coordinator)
    with pytest.raises(ValueError):
        await coordinator.async_progress_state("coach-user", athlete.id)

    await grant(coordinator, coach, {"view_progress": True})
    result = await coordinator.async_progress_state("coach-user", athlete.id)
    assert result["strength_score"] is not None


async def test_progress_state_kids_are_auto_viewable_by_a_non_kid_coach(coordinator):
    await coordinator.async_ensure_profile("parent-user", "Jordan")
    await coordinator.async_update_profile("parent-user", experience_level="intermediate")
    kid = await coordinator.async_ensure_profile("kid-user", "June")
    await coordinator.async_update_profile("kid-user", experience_level="kids")

    result = await coordinator.async_progress_state("parent-user", kid.id)
    assert result["this_month"]["workouts_completed"] == 0


async def test_builder_recovers_invalid_workout_for_requested_chest_and_triceps(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    coordinator.ai_provider = FakeAIProvider(
        reply=json.dumps({
            "proposal": {
                "name": "Broken",
                "exercises": [{"exercise_id": "made_up_exercise", "sets": [{"reps": 8}]}],
            }
        })
    )
    proposal = await coordinator.async_build_training(
        "u",
        {"type": "workout", "source": "wizard",
         "answers": {"focus": "Other", "focus_other": "Chest and triceps"}},
    )
    assert proposal["payload"]["exercises"]
    assert all(
        exercise["exercise_id"] in training.allowed_exercises(athlete, coordinator.data)
        for exercise in proposal["payload"]["exercises"]
    )


async def test_generated_workout_repairs_known_exercise_name(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    exercise = next(
        item for item in training.EXERCISE_LIBRARY
        if item["id"] == "push_up"
    )
    raw = {
        "name": "Push",
        "exercises": [{"name": exercise["name"], "sets": [{"reps": 8, "weight": 0}]}],
    }
    normalized = training.normalize_generated("workout", raw, athlete, coordinator.data)
    assert normalized["exercises"][0]["exercise_id"] == "push_up"


async def test_future_program_workout_adapts_to_completed_previous_week(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="adaptive",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    first = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-1:w1s1"}
    )
    workout = coordinator.get_workout(first["id"])
    workout.status = "completed"
    workout.exercises[0].sets[0].completed = True
    workout.exercises[0].sets[0].actual_reps = 8
    workout.exercises[0].sets[0].actual_weight = 15
    later = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-5:w1s1"}
    )
    progressed = coordinator.get_workout(later["id"])
    assert progressed.exercises[0].sets[0].planned_reps == 9
    assert progressed.exercises[0].sets[0].planned_weight == 15
    assert workout.exercises[0].sets[0].planned_reps == 8


async def test_adaptive_program_ignores_uncompleted_workout(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="adaptive-unfinished",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    first = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-1:w1s1"}
    )
    workout = coordinator.get_workout(first["id"])
    workout.exercises[0].sets[0].actual_weight = 50
    later = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-5:w1s1"}
    )
    next_workout = coordinator.get_workout(later["id"])
    assert next_workout.exercises[0].sets[0].planned_weight != 50


async def test_program_schedule_previews_adapted_targets(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="preview-adaptive",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    first = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-1:w1s1"}
    )
    workout = coordinator.get_workout(first["id"])
    workout.status = "completed"
    workout.exercises[0].sets[0].completed = True
    workout.exercises[0].sets[0].actual_reps = 8
    workout.exercises[0].sets[0].actual_weight = 20
    program.start_date = date.today().isoformat()
    state = training.program_state(program, coordinator.data)
    next_session = next(
        session for session in state["upcoming_sessions"]
        if session["id"] == "week-5:w1s1"
    )
    assert next_session["prescription"]["exercises"][0]["sets"][0]["reps"] == 9
    assert next_session["prescription"]["exercises"][0]["sets"][0]["weight"] == 20


async def test_adaptive_targets_respect_high_exertion(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="effort-aware",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    first = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-1:w1s1"}
    )
    workout = coordinator.get_workout(first["id"])
    workout.status = "completed"
    exercise = workout.exercises[0]
    exercise.effort = "very hard"
    exercise.sets[0].completed = True
    exercise.sets[0].actual_reps = 8
    exercise.sets[0].actual_weight = 20
    exercise.sets[0].rpe = 9.5
    adapted = training.adapt_program_session(
        program, program.weeks[0]["sessions"][0], 5, coordinator.data
    )
    target = adapted["prescription"]["exercises"][0]["sets"][0]
    assert target["reps"] == 8
    assert target["weight"] == 20


async def test_adaptive_targets_progress_low_exertion(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="low-effort-aware",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    first = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-1:w1s1"}
    )
    workout = coordinator.get_workout(first["id"])
    workout.status = "completed"
    exercise = workout.exercises[0]
    exercise.sets[0].completed = True
    exercise.sets[0].actual_reps = 8
    exercise.sets[0].actual_weight = 20
    exercise.sets[0].rpe = 6
    adapted = training.adapt_program_session(
        program, program.weeks[0]["sessions"][0], 5, coordinator.data
    )
    target = adapted["prescription"]["exercises"][0]["sets"][0]
    assert target["reps"] == 9
    assert target["weight"] == 20


async def test_generated_week_storage_roundtrip_and_schedule(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="generated-week",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    week = copy.deepcopy(program.weeks[0])
    week["week_number"] = 5
    week["focus"] = "Recovery and progression"
    program.generated_weeks["5"] = week
    restored = TrainingProgram.from_dict(program.to_dict())
    assert restored.generated_weeks["5"]["focus"] == "Recovery and progression"
    assert training.program_week(restored, 5, coordinator.data)["focus"] == (
        "Recovery and progression"
    )
    assert training.program_week(restored, 1, coordinator.data)["week_number"] == 1


async def test_generated_week_preserves_original_template(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="generated-preserve",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    original = copy.deepcopy(program.weeks[0])
    new_week = copy.deepcopy(original)
    new_week["sessions"][0]["name"] = "Fresh strength session"
    program.generated_weeks["5"] = new_week
    resolved = training.program_week(program, 5, coordinator.data)
    assert resolved["sessions"][0]["name"] == "Fresh strength session"
    assert program.weeks[0] == original


async def test_generate_week_action_persists_ai_week_and_is_idempotent(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    program = TrainingProgram(
        id="ai-week",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    coordinator.ai_provider = FakeAIProvider(reply=json.dumps({"proposal": PROGRAM}))
    generated = await coordinator.async_program_action(
        "u", program.id, "generate_week", {"week_number": 5}
    )
    assert generated == {"week_number": 5, "generated": True}
    assert program.generated_weeks["5"]["week_number"] == 5
    assert program.generated_weeks["5"]["sessions"][0]["id"] == "w1s1"
    assert await coordinator.async_program_action(
        "u", program.id, "generate_week", {"week_number": 5}
    ) == {"week_number": 5, "generated": False}
    assert len(coordinator.ai_provider.calls) == 1


async def test_fallback_workout_avoids_recently_repeated_exercises(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    request = {"answers": {"focus": "Chest and triceps"}}
    first = training.fallback_workout(request, athlete, coordinator.data)
    ids = [exercise["exercise_id"] for exercise in first["exercises"]]
    assert len(ids) >= 3
    for exercise_id in ids:
        from gains_addon.exercises import get_exercise
        from gains_addon.load_policy import load_ladder
        ladder = load_ladder(get_exercise(exercise_id), athlete, coordinator.data)
        load = min(ladder) if ladder else 0
        workout = await coordinator.async_create_workout(
            "u", "Recent", [
                {"exercise_id": exercise_id, "sets": [{"reps": 8, "weight": load}]}
            ]
        )
        assert workout
        await coordinator.async_start_workout('u', workout.id)
        await coordinator.async_log_set('u', workout.id, 0, 0, 8, load)
        await coordinator.async_complete_workout('u', workout.id)
    second = training.fallback_workout(request, athlete, coordinator.data)
    next_ids = [exercise["exercise_id"] for exercise in second["exercises"]]
    assert next_ids != ids
    assert len(next_ids) == len(set(next_ids))


async def test_workout_builder_resolves_common_shorthand(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    raw = {"name": "Upper", "exercises": [
        {"name": "DB Bench", "sets": [{"reps": 8, "weight": 10}]},
        {"exercise": "lat pull-down", "sets": [{"reps": 10, "weight": 20}]},
        {"exercise_name": "seated cable row", "sets": [{"reps": 10, "weight": 20}]},
    ]}
    repaired = training.repair_workout_exercises(raw, athlete, coordinator.data)
    assert [item["exercise_id"] for item in repaired["exercises"]] == [
        "dumbbell_bench_press", "lat_pulldown", "cable_row"
    ]


def test_strength_double_progression_requires_rep_ceiling_and_safe_load_jump():
    from gains_addon.workout_planner import next_strength_targets

    assert next_strength_targets(8, 8, 20, 6) == (9, 20)
    assert next_strength_targets(8, 12, 20, 6) == (12, 20)
    assert next_strength_targets(8, 12, 100, 6) == (8, 102.5)
    assert next_strength_targets(8, 8, 100, 9.5) == (8, 100)
    assert next_strength_targets(8, 6, 100, 8) == (6, 100)
    assert next_strength_targets(8, 12, 100, None) == (12, 100)


async def test_missed_muscle_priorities_excludes_completed_sessions(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="missing-session",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    missing = training.missed_training_priorities(program, 1, coordinator.data)
    assert missing
    first = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-1:w1s1"}
    )
    workout = coordinator.get_workout(first["id"])
    workout.status = "completed"
    assert not training.missed_training_priorities(program, 1, coordinator.data)


async def test_missed_muscle_priorities_ignore_invalid_week(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Jordan")
    program = TrainingProgram(
        id="invalid-week",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    assert training.missed_training_priorities(program, 0, coordinator.data) == {}



@pytest.mark.asyncio
async def test_regenerate_program_session_keeps_occurrence_and_targets(coordinator):
    athlete = await coordinator.async_ensure_profile("u", "Athlete")
    equip(athlete, coordinator.data)
    payload = training.generated_workout(
        {"answers": {"focus": "Legs"}}, athlete, coordinator.data
    )
    authored = copy.deepcopy(PROGRAM)
    authored["weeks"][0]["sessions"][0]["name"] = "Legs Training"
    authored["weeks"][0]["sessions"][0]["prescription"] = payload
    program = TrainingProgram(
        id="regen-test",
        profile_id=athlete.id,
        **training.validate_program(authored, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    before = copy.deepcopy(program.weeks)
    opened = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-1:w1s1"}
    )
    await coordinator.async_program_action(
        "u", program.id, "regenerate_session", {"session_id": "week-1:w1s1"}
    )
    revised = program.generated_weeks["1"]["sessions"][0]["prescription"]
    assert {e["exercise_id"] for e in revised["exercises"]} != {
        e["exercise_id"] for e in payload["exercises"]
    }
    assert (
        revised["planning"]["session_spec"]["targets"]
        == payload["planning"]["session_spec"]["targets"]
    )
    assert program.weeks == before
    linked = coordinator.get_workout(opened["id"])
    assert [e.exercise_id for e in linked.exercises] == [
        e["exercise_id"] for e in revised["exercises"]
    ]
    linked.status = "active"
    with pytest.raises(ValueError, match="unstarted"):
        await coordinator.async_program_action(
            "u", program.id, "regenerate_session", {"session_id": "week-1:w1s1"}
        )


@pytest.mark.asyncio
async def test_regeneration_failure_preserves_program_and_rejects_other_athlete(
    coordinator, monkeypatch
):
    athlete = await coordinator.async_ensure_profile("u", "Athlete")
    program = TrainingProgram(
        id="regen-failure",
        profile_id=athlete.id,
        **training.validate_program(PROGRAM, athlete, coordinator.data),
    )
    coordinator.data.programs.append(program)
    before = copy.deepcopy(program.to_dict())

    def unavailable(*args):
        raise ValueError("No different workout is available")

    monkeypatch.setattr(training, "regenerate_session", unavailable)
    with pytest.raises(ValueError, match="No different"):
        await coordinator.async_program_action(
            "u", program.id, "regenerate_session", {"session_id": "week-1:w1s1"}
        )
    assert program.to_dict() == before
    await coordinator.async_ensure_profile("other", "Other")
    with pytest.raises(ValueError):
        await coordinator.async_program_action(
            "other", program.id, "regenerate_session", {"session_id": "week-1:w1s1"}
        )
    assert program.to_dict() == before
