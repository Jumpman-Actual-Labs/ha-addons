"""Real coordinator paths with synthetic athletes and adversarial providers."""

import asyncio
import copy
import json

import pytest

from gains_addon.ai import AIProviderError
from gains_addon.exercises import EXERCISE_LIBRARY
from gains_addon.load_policy import load_ladder
from gains_addon.models import GainsData, GymProfile
from tests.inventory_fixtures import equip
from tests.test_coordinator import FakeAIProvider
from tests.test_coordinator import coordinator as base_coordinator


@pytest.fixture(name="coordinator")
async def engine_coordinator():
    return await base_coordinator.__wrapped__()


REQUEST = {
    "type": "program",
    "source": "wizard",
    "answers": {
        "lifting_days": 5,
        "running_days": 0,
        "split": "Custom Split",
        "duration": 45,
        "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        "custom_split_days": (
            "Chest/Triceps | Back/Biceps | Legs | Chest/Biceps Isolation | Arms/Forearms/Grip"
        ),
    },
}
SQUAT = {
    "name": "Chest",
    "exercises": [{"exercise_id": "barbell_back_squat", "sets": [{"reps": 8, "weight": 100}]}],
}
CATALOG = {e["id"]: e for e in EXERCISE_LIBRARY}


@pytest.mark.parametrize("count", [0, 1, 5, 6])
async def test_five_authored_days_survive_generation_acceptance_and_roundtrip(coordinator, count):
    await coordinator.async_ensure_profile("u", "Synthetic")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    coordinator.ai_provider = FakeAIProvider(
        reply=json.dumps(
            {
                "proposal": {
                    "name": "Bad AI",
                    "weeks": [
                        {
                            "sessions": [
                                {
                                    "day": i % 7,
                                    "type": "workout",
                                    "name": "Squat",
                                    "prescription": SQUAT,
                                }
                                for i in range(count)
                            ]
                        }
                    ],
                }
            }
        )
    )
    proposal = await coordinator.async_build_training("u", copy.deepcopy(REQUEST))
    sessions = proposal["payload"]["weeks"][0]["sessions"]
    assert len(sessions) == 5
    targets = [
        {"pectoralis_major", "triceps_brachii"},
        {"latissimus_dorsi", "rhomboids", "biceps_brachii"},
        {"quadriceps", "hamstrings", "gluteals", "calves"},
        {"pectoralis_major", "biceps_brachii"},
        {"biceps_brachii", "triceps_brachii", "forearms"},
    ]
    for session, muscles in zip(sessions, targets, strict=True):
        assert all(
            set(CATALOG[e["exercise_id"]]["muscles"]["primary"]) & muscles
            for e in session["prescription"]["exercises"]
        )
    wire_payload = json.loads(json.dumps(proposal['payload']))
    accepted = await coordinator.async_accept_training("u", proposal["id"], wire_payload)
    assert (
        await coordinator.async_accept_training("u", proposal["id"], proposal["payload"])
        == accepted
    )
    restored = GainsData.from_dict(coordinator.data.to_dict())
    assert restored.programs[0].origin_request["answers"]["lifting_days"] == 5
    assert restored.programs[0].weeks == coordinator.data.programs[0].weeks


async def test_builder_and_chat_reject_valid_but_wrong_muscles(coordinator):
    await coordinator.async_ensure_profile("u", "Synthetic")
    coordinator.ai_provider = FakeAIProvider(reply=json.dumps({"proposal": SQUAT}))
    proposal = await coordinator.async_build_training(
        "u",
        {
            "type": "workout",
            "source": "wizard",
            "answers": {"focus": "Specific Muscle Group", "muscle": "Chest"},
        },
    )
    assert all(
        "pectoralis_major" in CATALOG[e["exercise_id"]]["muscles"]["primary"]
        for e in proposal["payload"]["exercises"]
    )
    coordinator.ai_provider = FakeAIProvider(
        reply=json.dumps({"reply": "Review", "proposed_workouts": [SQUAT]})
    )
    reply = await coordinator.async_ai_chat("u", "Build a chest workout for 15 minutes")
    assert reply.proposed_workouts
    assert all(
        "pectoralis_major" in CATALOG[e["exercise_id"]]["muscles"]["primary"]
        for e in reply.proposed_workouts[0]["exercises"]
    )
    assert reply.proposed_workouts[0]["planning"]["estimated_duration_minutes"] <= 15


async def test_authored_geoffrey_days_prefill_the_same_five_day_contract(coordinator):
    await coordinator.async_ensure_profile("u", "Synthetic")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    coordinator.ai_provider = FakeAIProvider(
        reply=json.dumps({"reply": "Review", "proposed_workouts": [SQUAT]})
    )
    reply = await coordinator.async_ai_chat(
        "u",
        "Day 1: Chest/Triceps | Day 2: Back/Biceps | Day 3: Legs | "
        "Day 4: Chest/Biceps isolation with dumbbell floor press | "
        "Day 5: Arms/Forearms/Grip; 45 minutes",
    )
    assert not reply.proposed_workouts
    action = reply.actions[0]
    assert action['builder'] == 'program'
    assert action["prefill"]["lifting_days"] == 5
    proposal = await coordinator.async_build_training(
        "u", {"type": "program", "source": "geoffrey", "answers": action["prefill"]}
    )
    assert len(proposal["payload"]["weeks"][0]["sessions"]) == 5
    assert proposal["payload"]["weeks"][0]["sessions"][3]["prescription"]["planning"]["intent"][
        "preferred"
    ] == ["single_arm_dumbbell_floor_press"]


async def test_outage_falls_back_without_permission_or_approval_bypass(coordinator):
    await coordinator.async_ensure_profile("u", "Synthetic")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    coordinator.ai_provider = FakeAIProvider(error=AIProviderError("outage"))
    proposal = await coordinator.async_build_training("u", copy.deepcopy(REQUEST))
    assert len(proposal["payload"]["weeks"][0]["sessions"]) == 5
    assert not coordinator.data.workouts and not coordinator.data.programs


async def test_stale_context_and_cancelled_generation(coordinator):
    profile = await coordinator.async_ensure_profile("u", "Synthetic")
    ready, release = asyncio.Event(), asyncio.Event()

    class WaitingProvider:
        async def complete(self, prompt, messages):
            ready.set()
            await release.wait()
            return json.dumps({"proposal": SQUAT})

    coordinator.ai_provider = WaitingProvider()
    request = {"type": "workout", "source": "wizard", "answers": {"focus": "Chest"}}
    task = asyncio.create_task(coordinator.async_build_training("u", request))
    await ready.wait()
    with pytest.raises(ValueError, match="progress"):
        await coordinator.async_build_training("u", request)
    profile.rest_timer_seconds = 90
    release.set()
    with pytest.raises(ValueError, match="context changed"):
        await task
    assert not coordinator.data.training_proposals


async def test_real_logging_progresses_with_feasible_plates(coordinator):
    profile = await coordinator.async_ensure_profile("u", "Synthetic")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    profile.units = "metric"
    gym = GymProfile(
        id="g",
        name="Synthetic",
        inventory_units="metric",
        equipment={
            "olympic_barbell": [20],
            "plates": [20, 20, 20, 20, 1, 1],
            "flat_bench": [None],
            "power_rack": [None],
        },
    )
    coordinator.data.gym_profiles.append(gym)
    profile.gym_profile_id = gym.id
    workout = await coordinator.async_create_workout(
        "u",
        "Chest",
        [
            {
                "exercise_id": "barbell_bench_press",
                "sets": [{"reps": 10, "weight": 100} for _ in range(3)],
            }
        ],
    )
    await coordinator.async_start_workout("u", workout.id)
    for index in range(3):
        await coordinator.async_log_set("u", workout.id, 0, index, 12, 100)
    await coordinator.async_log_exercise_effort("u", workout.id, 0, "easy")
    await coordinator.async_complete_workout("u", workout.id)
    proposal = await coordinator.async_build_training(
        "u", {"type": "workout", "source": "wizard", "answers": {"focus": "Chest"}}
    )
    bench = next(
        e for e in proposal["payload"]["exercises"] if e["exercise_id"] == "barbell_bench_press"
    )
    assert bench["sets"][0]["weight"] == 102
    assert bench["sets"][0]["reps"] == 8
    assert 102 in load_ladder(CATALOG["barbell_bench_press"], profile, coordinator.data)


async def test_rotation_advances_without_rewriting_opened_workouts(coordinator):
    await coordinator.async_ensure_profile("u", "Synthetic")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    request = {
        "type": "program",
        "source": "wizard",
        "answers": {
            "sequencing_policy": "calendar",
            "lifting_days": 3,
            "split": "PHUL",
            "days": ["Monday", "Wednesday", "Friday"],
        },
    }
    p = await coordinator.async_build_training("u", request)
    await coordinator.async_accept_training("u", p["id"], p["payload"])
    program = coordinator.data.programs[0]
    opened = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "week-2:w1s1"}
    )
    before = copy.deepcopy(coordinator.get_workout(opened["id"]).to_dict())
    await coordinator.async_program_action("u", program.id, "generate_week", {"week_number": 2})
    assert coordinator.get_workout(opened["id"]).to_dict() == before
    assert program.generated_weeks["2"]["sessions"][1]["name"] == "Power Upper Training"
    assert await coordinator.async_program_action(
        "u", program.id, "generate_week", {"week_number": 2}
    ) == {"week_number": 2, "generated": False}

@pytest.mark.parametrize("policy", ["calendar", "completion"])
async def test_profile_sequencing_default_is_owned_persisted_and_frozen_per_program(
    coordinator, policy
):
    athlete = await coordinator.async_ensure_profile('u', 'Synthetic')
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    other = await coordinator.async_ensure_profile('other', 'Other')
    await coordinator.async_update_profile('u', preferred_sequencing_policy=policy)
    assert other.preferred_sequencing_policy == "completion"
    assert (
        GainsData.from_dict(coordinator.data.to_dict()).profiles[0].preferred_sequencing_policy
        == policy
    )
    coordinator.ai_provider = None
    proposal = await coordinator.async_build_training('u', copy.deepcopy(REQUEST))
    assert proposal['request']['answers']['sequencing_policy'] == policy
    accepted = await coordinator.async_accept_training('u', proposal['id'], proposal['payload'])
    program = next(p for p in coordinator.data.programs if p.id == accepted["id"])
    await coordinator.async_update_profile(
        "u", preferred_sequencing_policy="completion" if policy == "calendar" else "calendar"
    )
    assert program.sequencing_policy == policy
    explicit = copy.deepcopy(REQUEST)
    explicit['answers']['sequencing_policy'] = policy
    proposal = await coordinator.async_build_training('u', explicit)
    assert proposal['request']['answers']['sequencing_policy'] == policy
    assert athlete.preferred_sequencing_policy != policy


async def test_invalid_profile_sequencing_rejected_before_profile_mutation(coordinator):
    athlete = await coordinator.async_ensure_profile('u', 'Synthetic')
    with pytest.raises(ValueError, match="sequencing"):
        await coordinator.async_update_profile(
            "u", display_name="Changed", preferred_sequencing_policy="invalid"
        )
    assert athlete.display_name == 'Synthetic'
