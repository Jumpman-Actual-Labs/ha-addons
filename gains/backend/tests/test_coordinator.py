"""Coordinator lifecycle tests - call `coordinator.async_*` methods directly
against an in-memory `GainsCoordinator`, no HTTP layer, no file-backed store.
"""

from __future__ import annotations

from datetime import date

import pytest

from gains_addon import logic
from gains_addon.coordinator import GainsCoordinator
from gains_addon.models import GainsData, TrainingProgram, WorkoutSet
from tests.inventory_fixtures import equip


class FakeStore:
    """In-memory stand-in for GainsStore - nothing written to disk."""

    def __init__(self):
        self._data = GainsData()

    async def async_load(self):
        return self._data

    async def async_save(self, data):
        self._data = data


class FakeAIProvider:
    """Returns a canned reply (or raises) instead of calling a real API."""

    def __init__(self, reply: str | None = None, error: Exception | None = None):
        self.reply = reply
        self.error = error
        self.calls: list[tuple[str, list[dict]]] = []

    async def complete(self, system_prompt: str, messages: list[dict]) -> str:
        self.calls.append((system_prompt, messages))
        if self.error is not None:
            raise self.error
        return self.reply or ""


@pytest.fixture
async def coordinator():
    coord = GainsCoordinator(FakeStore())
    await coord.async_load()
    return coord


async def test_ensure_profile_creates_new_profile(coordinator):
    profile = await coordinator.async_ensure_profile("user-1", "Jordan")
    assert profile.ha_user_id == "user-1"
    assert profile.display_name == "Jordan"
    assert profile in coordinator.profiles


async def test_ensure_profile_is_idempotent(coordinator):
    first = await coordinator.async_ensure_profile("user-1", "Jordan")
    second = await coordinator.async_ensure_profile("user-1", "Different Name")
    assert first.id == second.id
    assert second.display_name == "Jordan"  # not overwritten by a second call
    assert len(coordinator.profiles) == 1


async def test_first_profile_is_admin(coordinator):
    profile = await coordinator.async_ensure_profile("user-1", "Jordan")
    assert profile.is_admin is True


async def test_second_profile_is_not_admin(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    second = await coordinator.async_ensure_profile("user-2", "Alex")
    assert second.is_admin is False


async def test_ensure_profile_falls_back_to_default_name(coordinator):
    profile = await coordinator.async_ensure_profile("user-1234567890", None)
    assert profile.display_name == "Athlete user-123"


async def test_update_profile_changes_own_fields(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    updated = await coordinator.async_update_profile(
        "user-1", units="metric", experience_level="advanced", rest_timer_seconds=90
    )
    assert updated is not None
    assert updated.units == "metric"
    assert updated.experience_level == "advanced"
    assert updated.rest_timer_seconds == 90


async def test_update_profile_returns_none_when_no_profile_exists(coordinator):
    result = await coordinator.async_update_profile("nonexistent-user", units="metric")
    assert result is None


async def test_update_profile_cannot_touch_another_users_profile(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")

    await coordinator.async_update_profile("user-1", display_name="Changed")

    user_2_profile = coordinator.get_profile_by_user_id("user-2")
    assert user_2_profile is not None
    assert user_2_profile.display_name == "Alex"


async def test_create_gym_profile_adds_it_to_shared_list(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    gym = await coordinator.async_create_gym_profile(
        "user-1", "Home Gym", {"olympic_barbell": [45.0]}
    )
    assert gym is not None
    assert gym.equipment == {"olympic_barbell": [45.0]}
    assert gym in coordinator.gym_profiles


async def test_gym_profile_persists_cable_load_configuration(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    gym = await coordinator.async_create_gym_profile(
        "user-1",
        "Home Gym",
        {"cable_tower": [None]},
        {
            "cable_tower": {
                "load_type": "plate_loaded",
                "pulley_ratio": 2.0,
            }
        },
    )
    assert gym is not None
    assert gym.equipment_config["cable_tower"] == {
        "load_type": "plate_loaded",
        "pulley_ratio": 2.0,
    }

    updated = await coordinator.async_update_gym_profile(
        "user-1",
        gym.id,
        equipment_config={
            "cable_tower": {
                "load_type": "weight_stack",
                "pulley_ratio": 1.0,
                "stack_max": 200.0,
                "stack_increment": 10.0,
            }
        },
    )
    assert updated is not None
    assert updated.equipment_config["cable_tower"]["load_type"] == "weight_stack"
    assert updated.equipment_config["cable_tower"]["stack_max"] == 200.0


async def test_create_gym_profile_returns_none_without_a_profile(coordinator):
    result = await coordinator.async_create_gym_profile("nonexistent-user", "Home Gym")
    assert result is None


async def test_update_gym_profile_is_editable_by_any_user(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    gym = await coordinator.async_create_gym_profile("user-1", "Home Gym")

    # Gym profiles are shared instance-wide -- user-2 didn't create this
    # one but can still edit it.
    updated = await coordinator.async_update_gym_profile(
        "user-2", gym.id, equipment={"dumbbells": [None]}
    )
    assert updated is not None
    assert updated.equipment == {"dumbbells": [None]}

    # A second update wholesale-replaces rather than merges.
    replaced = await coordinator.async_update_gym_profile(
        "user-2", gym.id, equipment={"kettlebells": [None]}
    )
    assert replaced.equipment == {"kettlebells": [None]}


async def test_update_gym_profile_returns_none_for_unknown_gym(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    result = await coordinator.async_update_gym_profile("user-1", "nonexistent-gym", name="X")
    assert result is None


async def test_select_gym_profile_sets_own_selection(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    gym = await coordinator.async_create_gym_profile("user-1", "Home Gym")

    updated = await coordinator.async_select_gym_profile("user-1", gym.id)
    assert updated is not None
    assert updated.gym_profile_id == gym.id


async def test_select_gym_profile_shared_across_users(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    gym = await coordinator.async_create_gym_profile("user-1", "Home Gym")

    # A gym created by user-1 is immediately selectable by user-2.
    selected = await coordinator.async_select_gym_profile("user-2", gym.id)
    assert selected is not None
    assert selected.gym_profile_id == gym.id


async def test_select_gym_profile_rejects_unknown_gym_id(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    result = await coordinator.async_select_gym_profile("user-1", "nonexistent-gym")
    assert result is None


async def test_select_gym_profile_none_clears_selection(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    gym = await coordinator.async_create_gym_profile("user-1", "Home Gym")
    await coordinator.async_select_gym_profile("user-1", gym.id)

    cleared = await coordinator.async_select_gym_profile("user-1", None)
    assert cleared is not None
    assert cleared.gym_profile_id is None


async def test_delete_gym_profile_clears_selection_on_athletes_who_had_it(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    gym = await coordinator.async_create_gym_profile("user-1", "Home Gym")
    await coordinator.async_select_gym_profile("user-1", gym.id)
    await coordinator.async_select_gym_profile("user-2", gym.id)

    deleted = await coordinator.async_delete_gym_profile("user-1", gym.id)
    assert deleted is True
    assert gym not in coordinator.gym_profiles

    assert coordinator.get_profile_by_user_id("user-1").gym_profile_id is None
    assert coordinator.get_profile_by_user_id("user-2").gym_profile_id is None


async def test_delete_gym_profile_returns_false_for_unknown_gym(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    result = await coordinator.async_delete_gym_profile("user-1", "nonexistent-gym")
    assert result is False


async def test_link_account_is_symmetric(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")

    result = await coordinator.async_link_account("user-1", jamie.id)
    assert result is not None
    assert jamie.id in result.linked_profile_ids

    jamie_after = coordinator.get_profile_by_user_id("user-2")
    assert jordan.id in jamie_after.linked_profile_ids


async def test_link_account_is_idempotent(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")

    await coordinator.async_link_account("user-1", jamie.id)
    result = await coordinator.async_link_account("user-1", jamie.id)
    assert result.linked_profile_ids.count(jamie.id) == 1

    jamie_after = coordinator.get_profile_by_user_id("user-2")
    assert jamie_after.linked_profile_ids.count(jordan.id) == 1


async def test_link_account_rejects_self_and_unknown_target(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")

    assert await coordinator.async_link_account("user-1", jordan.id) is None
    assert await coordinator.async_link_account("user-1", "nonexistent-id") is None
    assert await coordinator.async_link_account("nonexistent-user", "any-id") is None


async def test_unlink_account_removes_both_sides(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    await coordinator.async_link_account("user-1", jamie.id)

    result = await coordinator.async_unlink_account("user-1", jamie.id)
    assert result is not None
    assert jamie.id not in result.linked_profile_ids

    jamie_after = coordinator.get_profile_by_user_id("user-2")
    assert jordan.id not in jamie_after.linked_profile_ids


async def test_save_persists_through_store(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    reloaded = await coordinator._store.async_load()
    assert len(reloaded.profiles) == 1
    assert reloaded.profiles[0].ha_user_id == "user-1"


async def test_get_profile_by_id(coordinator):
    created = await coordinator.async_ensure_profile("user-1", "Jordan")
    found = coordinator.get_profile(created.id)
    assert found is not None
    assert found.ha_user_id == "user-1"


def _push_workout(exercise_id="barbell_back_squat", reps=5, weight=135.0):
    return [{"exercise_id": exercise_id, "sets": [{"reps": reps, "weight": weight}]}]


async def test_create_workout_for_own_profile(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    assert workout is not None
    assert workout.status == "planned"
    assert workout.exercises[0].exercise_id == "barbell_back_squat"
    assert workout in coordinator.workouts


async def test_create_workout_returns_none_without_a_profile(coordinator):
    result = await coordinator.async_create_workout("nonexistent-user", "Leg Day", _push_workout())
    assert result is None


async def test_start_workout_sets_active_and_started_at(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    started = await coordinator.async_start_workout("user-1", created.id)
    assert started is not None
    assert started.status == "active"
    assert started.started_at != ""


async def test_log_set_records_actuals_and_marks_completed(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    await coordinator.async_start_workout("user-1", created.id)

    result = await coordinator.async_log_set(
        "user-1", created.id, 0, 0, reps=5, weight=135.0
    )
    assert result is not None
    logged_set = result.exercises[0].sets[0]
    assert logged_set.actual_reps == 5
    assert logged_set.actual_weight == 135.0
    assert logged_set.completed is True


async def test_log_set_updates_personal_record(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())

    await coordinator.async_log_set("user-1", created.id, 0, 0, reps=5, weight=135.0)
    profile = coordinator.get_profile_by_user_id("user-1")
    first_pr = profile.personal_records["barbell_back_squat"]
    assert first_pr == pytest.approx(135.0 * (1 + 5 / 30))
    first_set = created.exercises[0].sets[0]
    assert first_set.is_personal_record is True
    assert first_set.personal_record_value == pytest.approx(first_pr)
    assert first_set.previous_personal_record is None

    # A lower estimated 1RM afterwards shouldn't overwrite the existing PR.
    await coordinator.async_log_set("user-1", created.id, 0, 0, reps=5, weight=100.0)
    assert profile.personal_records["barbell_back_squat"] == first_pr
    assert first_set.is_personal_record is False


async def test_log_set_can_hit_pr_with_lighter_weight_and_more_reps(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout(
        "user-1",
        "Leg Day",
        [{
            "exercise_id": "barbell_back_squat",
            "sets": [
                {"reps": 5, "weight": 135.0},
                {"reps": 8, "weight": 125.0},
            ],
        }],
    )

    await coordinator.async_log_set("user-1", created.id, 0, 0, reps=5, weight=135.0)
    first_pr = 135.0 * (1 + 5 / 30)
    await coordinator.async_log_set("user-1", created.id, 0, 1, reps=8, weight=125.0)

    second_set = created.exercises[0].sets[1]
    second_pr = 125.0 * (1 + 8 / 30)
    assert second_pr > first_pr
    assert second_set.is_personal_record is True
    assert second_set.personal_record_value == pytest.approx(second_pr)
    assert second_set.previous_personal_record == pytest.approx(first_pr)
    assert coordinator.get_profile_by_user_id("user-1").personal_records[
        "barbell_back_squat"
    ] == pytest.approx(second_pr)


async def test_log_set_skips_pr_math_for_a_timed_hold(coordinator):
    # "reps" on a timed exercise is actually seconds held -- estimate_one_
    # rep_max(weight, seconds) would be nonsense, so no personal record
    # should be recorded at all even when a weight is present (e.g. a
    # weighted plank).
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout(
        "user-1", "Core Day", _push_workout(exercise_id="plank", reps=60, weight=25.0)
    )
    await coordinator.async_log_set("user-1", created.id, 0, 0, reps=60, weight=25.0)
    profile = coordinator.get_profile_by_user_id("user-1")
    assert "plank" not in profile.personal_records


async def test_log_set_returns_none_for_out_of_range_indexes(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    assert await coordinator.async_log_set("user-1", created.id, 5, 0, 5, 135.0) is None
    assert await coordinator.async_log_set("user-1", created.id, 0, 5, 5, 135.0) is None


async def test_log_exercise_effort_sets_effort_on_exercise(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())

    result = await coordinator.async_log_exercise_effort("user-1", created.id, 0, "hard")
    assert result is not None
    assert result.exercises[0].effort == "hard"


async def test_log_exercise_effort_returns_none_for_out_of_range_index(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    assert await coordinator.async_log_exercise_effort("user-1", created.id, 5, "hard") is None


async def test_remove_exercise_drops_only_that_exercise(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout(
        "user-1",
        "Leg Day",
        [
            {"exercise_id": "barbell_back_squat", "sets": [{"reps": 5, "weight": 135.0}]},
            {"exercise_id": "leg_press", "sets": [{"reps": 8, "weight": 200.0}]},
        ],
    )

    result = await coordinator.async_remove_exercise("user-1", created.id, 0)
    assert result is not None
    assert len(result.exercises) == 1
    assert result.exercises[0].exercise_id == "leg_press"


async def test_remove_exercise_returns_none_for_out_of_range_index(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    assert await coordinator.async_remove_exercise("user-1", created.id, 5) is None


async def test_remove_exercise_cannot_touch_another_users_workout(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())

    assert await coordinator.async_remove_exercise("user-2", workout.id, 0) is None
    assert len(coordinator.get_workout(workout.id).exercises) == 1


async def test_replace_exercise_preserves_logged_sets_and_prescribes_remaining(coordinator):
    profile = await coordinator.async_ensure_profile("user-1", "Jordan")
    equip(profile, coordinator.data)
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    created.exercises[0].sets.append(WorkoutSet(planned_reps=5))
    await coordinator.async_log_set("user-1", created.id, 0, 0, reps=5, weight=135.0)
    await coordinator.async_log_exercise_effort("user-1", created.id, 0, "hard")
    original = created.exercises[0].sets[0].to_dict()
    result = await coordinator.async_replace_exercise("user-1", created.id, 0, "goblet_squat")
    assert result.exercises[0].exercise_id == "barbell_back_squat"
    assert result.exercises[0].effort == "hard"
    assert result.exercises[0].sets[0].to_dict() == original
    replacement = result.exercises[1]
    assert replacement.exercise_id == "goblet_squat"
    assert replacement.sets[0].planned_weight in [2, 5, 10, 20]
    assert replacement.sets[0].planned_reps == 5
    assert not replacement.sets[0].completed


async def test_replace_exercise_returns_none_for_out_of_range_index(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    assert await coordinator.async_replace_exercise("user-1", created.id, 5, "leg_press") is None


async def test_replace_exercise_cannot_touch_another_users_workout(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())

    assert await coordinator.async_replace_exercise("user-2", workout.id, 0, "leg_press") is None
    assert coordinator.get_workout(workout.id).exercises[0].exercise_id == "barbell_back_squat"


async def test_complete_workout_sets_completed_status(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    completed = await coordinator.async_complete_workout("user-1", created.id)
    assert completed is not None
    assert completed.status == "completed"
    assert completed.completed_at != ""


async def test_skip_workout_sets_skipped_status(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    skipped = await coordinator.async_skip_workout("user-1", created.id)
    assert skipped is not None
    assert skipped.status == "skipped"


async def test_delete_workout_removes_it_regardless_of_status(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())

    deleted = await coordinator.async_delete_workout("user-1", created.id)
    assert deleted is True
    assert coordinator.get_workout(created.id) is None


async def test_delete_workout_returns_false_for_unknown_workout(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    assert await coordinator.async_delete_workout("user-1", "nonexistent-id") is False


async def test_workout_actions_cannot_touch_another_users_workout(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    user_1_workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())

    assert await coordinator.async_start_workout("user-2", user_1_workout.id) is None
    assert await coordinator.async_complete_workout("user-2", user_1_workout.id) is None
    assert await coordinator.async_skip_workout("user-2", user_1_workout.id) is None
    assert (
        await coordinator.async_log_set("user-2", user_1_workout.id, 0, 0, 5, 135.0) is None
    )
    assert (
        await coordinator.async_log_exercise_effort("user-2", user_1_workout.id, 0, "hard")
        is None
    )
    assert await coordinator.async_delete_workout("user-2", user_1_workout.id) is False

    unchanged = coordinator.get_workout(user_1_workout.id)
    assert unchanged.status == "planned"
    assert unchanged.exercises[0].effort is None


async def test_share_workout_creates_pending_request_without_requiring_link(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    # Deliberately no async_link_account call -- sharing works between any
    # two profiles on the instance now.

    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    await coordinator.async_log_set("user-1", workout.id, 0, 0, reps=5, weight=135.0)

    request = await coordinator.async_share_workout("user-1", workout.id, jamie.id)
    assert request is not None
    assert request.status == "pending"
    assert request.kind == "workout"
    assert request.from_profile_id == jordan.id
    assert request.to_profile_id == jamie.id
    assert request.name == "Leg Day"
    assert request.payload["exercises"][0]["exercise_id"] == "barbell_back_squat"
    assert request.payload["exercises"][0]["sets"][0]["planned_reps"] == 5
    assert request.payload["exercises"][0]["sets"][0]["planned_weight"] == 135.0
    # Nothing lands in Jamie's workouts until they accept.
    assert coordinator.workouts_for_profile(jamie.id) == []

    # The source workout is untouched.
    source = coordinator.get_workout(workout.id)
    assert source.profile_id == jordan.id
    assert source.exercises[0].sets[0].completed is True


async def test_share_workout_rejects_unknown_target(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())

    result = await coordinator.async_share_workout("user-1", workout.id, "no-such-profile")
    assert result is None


async def test_share_workout_rejects_sharing_with_self(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())

    result = await coordinator.async_share_workout("user-1", workout.id, jordan.id)
    assert result is None


async def test_share_workout_cannot_share_another_users_workout(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    other_workout = await coordinator.async_create_workout("user-2", "Push Day", _push_workout())

    result = await coordinator.async_share_workout("user-1", other_workout.id, jamie.id)
    assert result is None


async def test_respond_share_accept_copies_workout_into_recipients_data(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    request = await coordinator.async_share_workout("user-1", workout.id, jamie.id)

    accepted = await coordinator.async_respond_share("user-2", request.id, True)
    assert accepted is not None
    assert accepted.profile_id == jamie.id
    assert accepted.name == "Leg Day"
    assert accepted.status == "planned"
    assert accepted.exercises[0].exercise_id == "barbell_back_squat"
    assert coordinator.workouts_for_profile(jamie.id) == [accepted]

    resolved = next(r for r in coordinator.data.share_requests if r.id == request.id)
    assert resolved.status == "accepted"
    assert resolved.responded_at is not None


async def test_respond_share_decline_leaves_recipient_workouts_untouched(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    request = await coordinator.async_share_workout("user-1", workout.id, jamie.id)

    declined = await coordinator.async_respond_share("user-2", request.id, False)
    assert declined is not None
    assert declined.status == "declined"
    assert coordinator.workouts_for_profile(jamie.id) == []


async def test_respond_share_rejects_someone_elses_share(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    intruder = await coordinator.async_ensure_profile("user-3", "Alex")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    request = await coordinator.async_share_workout("user-1", workout.id, jamie.id)

    result = await coordinator.async_respond_share("user-3", request.id, True)
    assert result is None
    assert coordinator.workouts_for_profile(intruder.id) == []
    assert coordinator.workouts_for_profile(intruder.id) == []


async def test_respond_share_rejects_already_resolved_request(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    request = await coordinator.async_share_workout("user-1", workout.id, jamie.id)
    await coordinator.async_respond_share("user-2", request.id, True)

    result = await coordinator.async_respond_share("user-2", request.id, True)
    assert result is None
    assert len(coordinator.workouts_for_profile(jamie.id)) == 1


async def test_share_run_creates_pending_request_without_requiring_link(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")

    run = await coordinator.async_create_run(
        "user-1", "Sunday Long Run", "long", 10.0, 60, "bring water"
    )
    await coordinator.async_log_run(
        "user-1", run.id, actual_distance=10.5, actual_duration_minutes=58
    )

    request = await coordinator.async_share_run("user-1", run.id, jamie.id)
    assert request is not None
    assert request.status == "pending"
    assert request.kind == "run"
    assert request.from_profile_id == jordan.id
    assert request.payload["target_distance"] == 10.0
    assert request.payload["target_duration_minutes"] == 60
    assert request.payload["notes"] == "bring water"
    assert coordinator.runs_for_profile(jamie.id) == []

    # The source run is untouched.
    source = coordinator.get_run(run.id)
    assert source.profile_id == jordan.id
    assert source.status == "completed"


async def test_share_run_rejects_unknown_target(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    run = await coordinator.async_create_run("user-1", "Run", "easy", None, None, "")

    result = await coordinator.async_share_run("user-1", run.id, "no-such-profile")
    assert result is None


async def test_share_run_cannot_share_another_users_run(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    other_run = await coordinator.async_create_run("user-2", "Run", "easy", None, None, "")

    result = await coordinator.async_share_run("user-1", other_run.id, jamie.id)
    assert result is None


async def test_respond_share_accept_copies_run_into_recipients_data(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    run = await coordinator.async_create_run(
        "user-1", "Sunday Long Run", "long", 10.0, 60, "bring water"
    )
    request = await coordinator.async_share_run("user-1", run.id, jamie.id)

    accepted = await coordinator.async_respond_share("user-2", request.id, True)
    assert accepted is not None
    assert accepted.profile_id == jamie.id
    assert accepted.name == "Sunday Long Run"
    assert accepted.status == "planned"
    assert accepted.target_distance == 10.0


def _sample_program(profile_id: str, program_id: str = "prog-1") -> TrainingProgram:
    return TrainingProgram(
        id=program_id,
        profile_id=profile_id,
        name="Push Pull Legs",
        goal="Get stronger",
        start_date="2020-01-01",
        weeks=[
            {
                "week_number": 1,
                "focus": "Strength",
                "sessions": [
                    {
                        "id": "w1s1",
                        "day": 0,
                        "type": "workout",
                        "name": "Push Day",
                        "prescription": {"name": "Push Day", "exercises": []},
                        "notes": "",
                        "actual_id": "some-workout-id",
                        "completed_at": "2020-01-02T00:00:00+00:00",
                    }
                ],
            }
        ],
        status="paused",
        revision=5,
        occurrences={"w1s1": {"actual_id": "some-workout-id"}},
    )


async def test_share_program_creates_pending_request_with_stripped_actuals(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    program = _sample_program(jordan.id)
    coordinator.data.programs.append(program)

    request = await coordinator.async_share_program("user-1", program.id, jamie.id)
    assert request is not None
    assert request.status == "pending"
    assert request.kind == "program"
    assert request.from_profile_id == jordan.id
    assert request.payload["name"] == "Push Pull Legs"
    assert request.payload["goal"] == "Get stronger"
    payload_session = request.payload["weeks"][0]["sessions"][0]
    assert payload_session["id"] == "w1s1"
    assert "actual_id" not in payload_session
    assert "completed_at" not in payload_session
    assert [p for p in coordinator.data.programs if p.profile_id == jamie.id] == []

    # The source program is untouched.
    source = next(p for p in coordinator.data.programs if p.id == program.id)
    assert source.status == "paused"
    assert source.occurrences == {"w1s1": {"actual_id": "some-workout-id"}}


async def test_share_program_rejects_unknown_target(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    program = _sample_program(jordan.id)
    coordinator.data.programs.append(program)

    result = await coordinator.async_share_program("user-1", program.id, "no-such-profile")
    assert result is None


async def test_share_program_cannot_share_another_users_program(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    other_program = _sample_program(jamie.id, "prog-2")
    coordinator.data.programs.append(other_program)

    result = await coordinator.async_share_program("user-1", other_program.id, jamie.id)
    assert result is None


async def test_respond_share_accept_copies_program_fresh_for_recipient(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    program = _sample_program(jordan.id)
    coordinator.data.programs.append(program)
    request = await coordinator.async_share_program("user-1", program.id, jamie.id)

    accepted = await coordinator.async_respond_share("user-2", request.id, True)
    assert accepted is not None
    assert accepted.profile_id == jamie.id
    assert accepted.name == "Push Pull Legs"
    assert accepted.status == "active"
    assert accepted.revision == 0
    assert accepted.occurrences == {}
    assert accepted.start_date == date.today().isoformat()
    assert "actual_id" not in accepted.weeks[0]["sessions"][0]


async def test_incoming_share_summaries_lists_only_pending_offers_to_this_profile(coordinator):
    jordan = await coordinator.async_ensure_profile("user-1", "Jordan")
    jamie = await coordinator.async_ensure_profile("user-2", "Jamie")
    workout = await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    request = await coordinator.async_share_workout("user-1", workout.id, jamie.id)
    all_profiles = [jordan, jamie]
    share_requests = coordinator.data.share_requests

    incoming = logic.incoming_share_summaries(jamie, share_requests, all_profiles)
    assert len(incoming) == 1
    assert incoming[0]["id"] == request.id
    assert incoming[0]["kind"] == "workout"
    assert incoming[0]["name"] == "Leg Day"
    assert incoming[0]["from_display_name"] == "Jordan"

    # Jordan (the sender) sees no incoming offers -- it's outbound for them.
    assert logic.incoming_share_summaries(jordan, share_requests, all_profiles) == []

    await coordinator.async_respond_share("user-2", request.id, True)
    # Resolved shares drop out of "incoming" once responded to.
    assert logic.incoming_share_summaries(jamie, share_requests, all_profiles) == []


async def test_workouts_for_profile_scopes_by_profile(coordinator):
    p1 = await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    await coordinator.async_create_workout("user-1", "Leg Day", _push_workout())
    await coordinator.async_create_workout("user-2", "Push Day", _push_workout())

    result = coordinator.workouts_for_profile(p1.id)
    assert len(result) == 1
    assert result[0].name == "Leg Day"


async def test_create_run_for_own_profile(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    run = await coordinator.async_create_run("user-1", "Easy Run", "easy", 3.0, 30, "")
    assert run is not None
    assert run.status == "planned"
    assert run.name == "Easy Run"
    assert run in coordinator.runs


async def test_create_run_returns_none_without_a_profile(coordinator):
    result = await coordinator.async_create_run(
        "nonexistent-user", "Easy Run", "easy", None, None, ""
    )
    assert result is None


async def test_log_run_records_actuals_and_marks_completed(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_run("user-1", "Easy Run", "easy", 3.0, 30, "")

    result = await coordinator.async_log_run("user-1", created.id, 3.1, 32)
    assert result is not None
    assert result.status == "completed"
    assert result.actual_distance == 3.1
    assert result.actual_duration_minutes == 32
    assert result.completed_at != ""


async def test_skip_run_sets_skipped_status(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    created = await coordinator.async_create_run("user-1", "Easy Run", "easy", None, None, "")
    skipped = await coordinator.async_skip_run("user-1", created.id)
    assert skipped is not None
    assert skipped.status == "skipped"


async def test_run_actions_cannot_touch_another_users_run(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    user_1_run = await coordinator.async_create_run("user-1", "Easy Run", "easy", None, None, "")

    assert await coordinator.async_log_run("user-2", user_1_run.id, 3.0, 30) is None
    assert await coordinator.async_skip_run("user-2", user_1_run.id) is None

    unchanged = coordinator.get_run(user_1_run.id)
    assert unchanged.status == "planned"


async def test_runs_for_profile_scopes_by_profile(coordinator):
    p1 = await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")
    await coordinator.async_create_run("user-1", "Easy Run", "easy", None, None, "")
    await coordinator.async_create_run("user-2", "Tempo Run", "tempo", None, None, "")

    result = coordinator.runs_for_profile(p1.id)
    assert len(result) == 1
    assert result[0].name == "Easy Run"


async def test_ai_chat_returns_none_without_a_profile(coordinator):
    assert await coordinator.async_ai_chat("nonexistent-user", "hi") is None


async def test_ai_chat_without_a_provider_returns_explanatory_reply(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    result = await coordinator.async_ai_chat("user-1", "hi coach")
    assert result is not None
    assert "isn't configured" in result.content

    profile = coordinator.get_profile_by_user_id("user-1")
    assert [m.content for m in profile.ai_conversation] == ["hi coach", result.content]


async def test_ai_chat_applies_sanitized_profile_updates(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    coordinator.ai_provider = FakeAIProvider(
        reply=(
            '{"reply": "Got it, beginner it is!", '
            '"profile_updates": {"experience_level": "beginner", "units": "not-a-real-unit"}, '
            '"proposed_workouts": [], "proposed_runs": []}'
        )
    )

    result = await coordinator.async_ai_chat("user-1", "I'm just starting out")
    assert result.content == "Got it, beginner it is!"
    assert result.proposed_workouts == []
    assert result.proposed_runs == []

    profile = coordinator.get_profile_by_user_id("user-1")
    assert profile.experience_level == "beginner"
    assert profile.units == "imperial"  # invalid enum value was dropped, not applied


async def test_ai_chat_validates_proposed_workouts_against_the_library(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    coordinator.ai_provider = FakeAIProvider(
        reply=(
            '{"reply": "Here is a leg day.", "profile_updates": null, '
            '"proposed_workouts": [{"name": "Leg Day", "exercises": '
            '[{"exercise_id": "barbell_back_squat", "sets": [{"reps": 8, "weight": 135}]}, '
            '{"exercise_id": "hallucinated_exercise", "sets": []}]}], '
            '"proposed_runs": []}'
        )
    )

    result = await coordinator.async_ai_chat("user-1", "build me a leg day")
    assert len(result.proposed_workouts) == 1
    plan = result.proposed_workouts[0]
    assert plan['planning']['session_spec']['focus'] == 'legs'
    assert all(e['exercise_id'] != 'hallucinated_exercise' for e in plan['exercises'])



async def test_ai_chat_validates_a_multi_day_plan_with_workouts_and_runs(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    equip(coordinator.get_profile_by_user_id('user-1'), coordinator.data)
    coordinator.ai_provider = FakeAIProvider(
        reply=(
            '{"reply": "Here is your 5-day plan.", "profile_updates": null, '
            '"proposed_workouts": ['
            '{"name": "Push", "exercises": [{"exercise_id": "barbell_bench_press", "sets": []}]}, '
            '{"name": "Pull", "exercises": [{"exercise_id": "barbell_back_squat", "sets": []}]}'
            '], '
            '"proposed_runs": ['
            '{"name": "Easy Run", "run_type": "easy", "target_distance": 3}, '
            '{"name": "Long Run", "run_type": "long", "target_duration_minutes": 60}'
            ']}'
        )
    )

    result = await coordinator.async_ai_chat("user-1", "build me a 5 day plan")
    assert len(result.proposed_workouts) == 2
    assert len(result.proposed_runs) == 2
    assert result.proposed_runs[0]["run_type"] == "easy"
    assert result.proposed_runs[1]["target_duration_minutes"] == 60


async def test_ai_chat_falls_back_to_raw_text_when_provider_reply_is_not_json(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    coordinator.ai_provider = FakeAIProvider(reply="Sure, tell me about your goals!")

    result = await coordinator.async_ai_chat("user-1", "hey")
    assert result.content == "Sure, tell me about your goals!"
    assert result.proposed_workouts == []
    assert result.proposed_runs == []


async def test_ai_chat_surfaces_provider_errors_without_raising(coordinator):
    from gains_addon.ai import AIProviderError

    await coordinator.async_ensure_profile("user-1", "Jordan")
    coordinator.ai_provider = FakeAIProvider(error=AIProviderError("rate limited"))

    result = await coordinator.async_ai_chat("user-1", "hey")
    assert result is not None
    assert "rate limited" in result.content


async def test_ai_chat_conversations_are_scoped_per_profile(coordinator):
    await coordinator.async_ensure_profile("user-1", "Jordan")
    await coordinator.async_ensure_profile("user-2", "Alex")

    await coordinator.async_ai_chat("user-1", "hi from jordan")
    await coordinator.async_ai_chat("user-2", "hi from alex")

    jordan = coordinator.get_profile_by_user_id("user-1")
    alex = coordinator.get_profile_by_user_id("user-2")
    assert [m.content for m in jordan.ai_conversation][0] == "hi from jordan"
    assert [m.content for m in alex.ai_conversation][0] == "hi from alex"
