"""Shared turn state never merges athlete performance or authorization."""

import asyncio
import copy

import pytest
import voluptuous as vol

from gains_addon.models import GainsData, GymProfile
from tests.test_coordinator import coordinator as base_coordinator


@pytest.fixture(name="coordinator")
async def joint_coordinator():
    return await base_coordinator.__wrapped__()


async def joined(c, device_mode="different_devices"):
    a = await c.async_ensure_profile("a", "Athlete A")
    b = await c.async_ensure_profile("b", "Athlete B")
    workout = await c.async_create_workout(
        "a", "Together", [{"exercise_id": "push_up", "sets": [
            {"reps": 8, "weight": 0}, {"reps": 8, "weight": 0}]}]
    )
    result = await c.async_joint_action("a", "join", {
        "workout_id": workout.id, "expected_revision": workout.revision,
        "partner_profile_id": b.id, "device_mode": device_mode})
    assert result["pending"]
    assert workout.status == "planned"
    assert c.workouts_for_profile(b.id) == []
    other = await c.async_respond_share("b", result["invite_id"], True)
    assert workout.joint_session["id"] == other.joint_session["id"]
    return a, b, workout, other


async def test_join_alternate_attribution_effort_and_roundtrip(coordinator):
    c = coordinator
    a, b, w, other = await joined(c)
    assert w.status == other.status == "active"
    assert w.joint_session["turn"]["profile_id"] == a.id
    with pytest.raises(ValueError, match="turn"):
        await c.async_log_set("b", other.id, 0, 0, 5, 20)
    assert not other.exercises[0].sets[0].completed
    for uid, workout, index, reps, weight, next_id in [
        ("a", w, 0, 8, 10, b.id), ("b", other, 0, 6, 20, a.id),
        ("a", w, 1, 7, 10, b.id), ("b", other, 1, 5, 20, None),
    ]:
        await c.async_log_set(uid, workout.id, 0, index, reps, weight)
        turn = w.joint_session["turn"]
        assert (turn["profile_id"] if turn else None) == next_id
        assert w.joint_session == other.joint_session
    await c.async_log_exercise_effort("a", w.id, 0, "easy")
    await c.async_log_exercise_effort("b", other.id, 0, "hard")
    assert w.exercises[0].effort == "easy"
    assert other.exercises[0].effort == "hard"
    assert w.exercises[0].sets[0].actual_reps == 8
    assert other.exercises[0].sets[0].actual_weight == 20
    assert w.exercises[0].sets[0].recorded_by_profile_id == a.id
    assert other.exercises[0].sets[0].recorded_by_profile_id == b.id
    assert a.personal_records != b.personal_records
    c.data = GainsData.from_dict(c.data.to_dict())
    w, other = c.get_workout(w.id), c.get_workout(other.id)
    assert w.joint_session == other.joint_session
    await c.async_complete_workout("a", w.id)
    assert other.status == "active"
    await c.async_complete_workout("b", other.id)
    assert w.joint_session["status"] == "completed"
    assert all(p["status"] == "completed" for p in w.joint_session["participants"])
    assert len(c.workouts_for_profile(a.id)) == len(c.workouts_for_profile(b.id)) == 1


async def test_permissions_and_structure_are_not_shared(coordinator):
    c = coordinator
    a, b, w, other = await joined(c)
    assert await c.async_log_set("b", w.id, 0, 0, 8, 0) is None
    with pytest.raises(ValueError, match="permission"):
        await c.async_session_action("b", a.id, "log_set", {
            "workout_id": w.id, "exercise_index": 0, "set_index": 0, "reps": 8})
    for action in ["delete_workout", "skip_workout", "start_workout"]:
        with pytest.raises(ValueError, match="Leave"):
            await getattr(c, "async_" + action)("a", w.id)
    with pytest.raises(ValueError, match="Leave"):
        await c.async_session_action("a", None, "add_set", {
            "workout_id": w.id, "exercise_index": 0})
    # A granted coach can record for the athlete, with the original coach attribution.
    coach = await c.async_ensure_profile("coach", "Coach")
    await c.async_set_coach_permissions("a", coach.id, {"coach_workouts": True})
    await c.async_session_action("coach", a.id, "log_set", {
        "workout_id": w.id, "exercise_index": 0, "set_index": 0, "reps": 8, "weight": 0})
    assert w.exercises[0].sets[0].recorded_by_profile_id == coach.id
    assert w.joint_session["turn"]["profile_id"] == b.id


@pytest.mark.parametrize("action", ["leave", "end"])
async def test_leave_end_and_solo_history(coordinator, action):
    c = coordinator
    a, b, w, other = await joined(c)
    await c.async_log_set("a", w.id, 0, 0, 8, 0)
    await c.async_joint_action("a", action, {
        "workout_id": w.id, "expected_revision": w.revision})
    frozen = copy.deepcopy(other.joint_session["participants"][0]["exercises"])
    assert w.exercises[0].sets[0].completed
    assert w.status == other.status == "active"
    assert w.joint_session == other.joint_session
    if action == "leave":
        assert w.joint_session["turn"]["profile_id"] == b.id
    else:
        assert w.joint_session["status"] == "ended"
        assert w.joint_session["turn"] is None
    await c.async_log_set("a", w.id, 0, 1, 9, 0)
    assert other.joint_session["participants"][0]["exercises"] == frozen
    await c.async_log_set("b", other.id, 0, 0, 6, 0)
    await c.async_complete_workout("a", w.id)
    assert other.status == "active"


async def test_stale_join_busy_units_and_invalid_partner(coordinator):
    c = coordinator
    a = await c.async_ensure_profile("a", "A")
    b = await c.async_ensure_profile("b", "B")
    w = await c.async_create_workout("a", "Workout", [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}]}])
    fields = {"workout_id": w.id, "expected_revision": w.revision,
              "partner_profile_id": b.id}
    before = copy.deepcopy(c.data.to_dict())
    for bad in [dict(fields, expected_revision=99), dict(fields, partner_profile_id=a.id),
                dict(fields, partner_profile_id="missing")]:
        with pytest.raises(ValueError):
            await c.async_joint_action("a", "join", bad)
        assert c.data.to_dict() == before
    b.units = "metric"
    results = await asyncio.gather(c.async_joint_action("a", "join", fields),
                                   c.async_joint_action("a", "join", fields))
    assert results[0]["invite_id"] == results[1]["invite_id"]
    assert c.workouts_for_profile(b.id) == []
    await c.async_respond_share("b", results[0]["invite_id"], True)
    assert len(c.workouts_for_profile(b.id)) == 1
    state = await c.async_training_state("b")
    assert state["attributes"]["workouts"][0]["joint_session"]["id"] == w.joint_session["id"]


async def test_early_finish_preserves_partner_work(coordinator):
    c = coordinator
    a, b, w, other = await joined(c)
    # An early finish removes A from rotation but keeps B's incomplete work available.
    await c.async_complete_workout("a", w.id)
    assert w.joint_session["turn"] == {"profile_id": b.id, "exercise_index": 0, "set_index": 0}
    await c.async_log_set("b", other.id, 0, 0, 6, 0)
    assert w.joint_session["turn"]["set_index"] == 1
    await c.async_log_set("b", other.id, 0, 1, 6, 0)
    await c.async_complete_workout("b", other.id)
    assert w.joint_session["status"] == "completed"
    assert not any(s.completed for e in w.exercises for s in e.sets)


async def test_exercise_order_corrections_and_stale_log(coordinator):
    c = coordinator
    a = await c.async_ensure_profile("a", "A")
    b = await c.async_ensure_profile("b", "B")
    w = await c.async_create_workout("a", "Two exercises", [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}]},
        {"exercise_id": "plank", "sets": [{"reps": 30, "weight": 0}]},
    ])
    invite = await c.async_joint_action("a", "join", {
        "workout_id": w.id, "expected_revision": w.revision, "partner_profile_id": b.id})
    other = await c.async_respond_share("b", invite["invite_id"], True)
    old_revision = other.revision
    await c.async_log_set("a", w.id, 0, 0, 8, 0)
    turn = copy.deepcopy(w.joint_session["turn"])
    await c.async_log_set("a", w.id, 0, 0, 9, 0)
    assert w.joint_session["turn"] == turn
    with pytest.raises(ValueError, match="changed"):
        await c.async_session_action("b", None, "log_set", {
            "workout_id": other.id, "expected_revision": old_revision,
            "exercise_index": 0, "set_index": 0, "reps": 8, "weight": 0})
    await c.async_log_set("b", other.id, 0, 0, 8, 0)
    assert w.joint_session["turn"] == {"profile_id": a.id, "exercise_index": 1, "set_index": 0}


async def test_any_profile_can_receive_and_accept_despite_gym_units_or_active_workout(coordinator):
    c = coordinator
    a = await c.async_ensure_profile("a", "A")
    b = await c.async_ensure_profile("b", "B")
    b.units = "metric"
    c.data.gym_profiles.append(GymProfile(id="bodyweight", name="Bodyweight only"))
    b.gym_profile_id = "bodyweight"
    w = await c.async_create_workout("a", "Barbell", [
        {"exercise_id": "barbell_back_squat", "sets": [{"reps": 8, "weight": 100}]}])
    solo = await c.async_create_workout("b", "Solo", [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}]}])
    await c.async_start_workout("b", solo.id)
    assert c.joint_targets(a) == [{"profile_id": b.id, "display_name": "B"}]
    invitation = await c.async_joint_action("a", "join", {
        "workout_id": w.id, "expected_revision": w.revision, "partner_profile_id": b.id})
    assert w.status == "planned" and not w.joint_session
    assert c.workouts_for_profile(b.id) == [solo]
    other = await c.async_respond_share("b", invitation["invite_id"], True)
    assert other.exercises[0].sets[0].planned_weight == pytest.approx(45.36)
    assert w.exercises[0].sets[0].planned_weight == 100
    assert w.joint_session["participants"][1]["units"] == "metric"
    assert solo.status == "active"
    assert w.status == other.status == "active"


async def test_bad_storage_does_not_break_workout_history(coordinator):
    c = coordinator
    a, b, w, other = await joined(c)
    for raw in [{}, {"id": "bad", "participants": [None]},
                dict(w.joint_session, turn={"profile_id": a.id, "exercise_index": "bad"})]:
        data = w.to_dict()
        data["joint_session"] = raw
        restored = type(w).from_dict(data)
        assert restored.joint_session is None
        assert restored.exercises[0].sets[0].planned_reps == 8


async def test_ended_session_does_not_invalidate_partner_solo_edits(coordinator):
    c = coordinator
    a, b, w, other = await joined(c)
    await c.async_joint_action("a", "end", {
        "workout_id": w.id, "expected_revision": w.revision})
    revision = other.revision
    await c.async_log_set("a", w.id, 0, 0, 8, 0)
    assert other.revision == revision


async def test_shared_device_logs_both_athletes_without_coach_grants(coordinator):
    c = coordinator
    a, b, w, other = await joined(c, "same_device")
    assert w.joint_session["device_mode"] == "same_device"
    assert w.joint_session["controller_profile_id"] == a.id
    for athlete, si, reps, weight, effort in [
        (a, 0, 8, 10, "easy"), (b, 0, 6, 20, "hard"),
        (a, 1, 7, 10, "easy"), (b, 1, 5, 20, "hard"),
    ]:
        await c.async_joint_action("a", "log_set", {
            "workout_id": w.id, "expected_revision": w.revision,
            "participant_profile_id": athlete.id, "exercise_index": 0,
            "set_index": si, "reps": reps, "weight": weight, "effort": effort})
    assert w.exercises[0].sets[0].actual_reps == 8
    assert other.exercises[0].sets[0].actual_reps == 6
    assert other.exercises[0].sets[0].actual_weight == 20
    assert other.exercises[0].sets[0].recorded_by_profile_id == a.id
    assert w.exercises[0].effort == "easy"
    assert other.exercises[0].effort == "hard"
    assert a.personal_records != b.personal_records
    restored = GainsData.from_dict(c.data.to_dict())
    assert restored.workouts[0].joint_session["device_mode"] == "same_device"
    for athlete in [a, b]:
        await c.async_joint_action("a", "complete_workout", {
            "workout_id": w.id, "expected_revision": w.revision,
            "participant_profile_id": athlete.id})
    assert w.status == other.status == "completed"
    assert w.joint_session["status"] == "completed"


async def test_shared_effort_preserves_set_values_and_turn(coordinator):
    c = coordinator
    a, b, w, other = await joined(c, "same_device")
    await c.async_joint_action("a", "log_set", {
        "workout_id": w.id, "expected_revision": w.revision,
        "participant_profile_id": a.id, "exercise_index": 0,
        "set_index": 0, "reps": 8, "weight": 10})
    before = copy.deepcopy(w.exercises[0].sets[0].to_dict())
    turn = copy.deepcopy(w.joint_session["turn"])
    for person, effort in [(a, "easy"), (b, "hard")]:
        await c.async_joint_action("a", "log_effort", {
            "workout_id": w.id, "expected_revision": w.revision,
            "participant_profile_id": person.id, "exercise_index": 0, "effort": effort})
    assert w.exercises[0].effort == "easy"
    assert other.exercises[0].effort == "hard"
    assert w.exercises[0].sets[0].to_dict() == before
    assert w.joint_session["turn"] == turn
    assert w.joint_session == other.joint_session


@pytest.mark.parametrize("mode", ["same_device", "different_devices"])
async def test_shared_effort_is_limited_to_controller_and_active_session(coordinator, mode):
    c = coordinator
    a, b, w, other = await joined(c, mode)
    fields = {"workout_id": w.id, "expected_revision": w.revision,
              "participant_profile_id": b.id, "exercise_index": 0, "effort": "hard"}
    before = copy.deepcopy(c.data.to_dict())
    with pytest.raises(ValueError):
        await c.async_joint_action("b", "log_effort", fields)
    with pytest.raises(ValueError):
        await c.async_joint_action("a", "log_effort", {**fields, "effort": "invalid"})
    if mode == "different_devices":
        with pytest.raises(ValueError):
            await c.async_joint_action("a", "log_effort", fields)
    assert c.data.to_dict() == before
    await c.async_joint_action("a", "end", {
        "workout_id": w.id, "expected_revision": w.revision})
    with pytest.raises(ValueError):
        await c.async_joint_action("a", "log_effort", {**fields, "expected_revision": w.revision})


@pytest.mark.parametrize("mode", ["same_device", "different_devices"])
async def test_shared_device_scope_and_turn_checks(coordinator, mode):
    c = coordinator
    a, b, w, other = await joined(c, mode)
    outsider = await c.async_ensure_profile("outsider", "Outside")
    fields = {"workout_id": w.id, "expected_revision": w.revision,
              "participant_profile_id": b.id, "exercise_index": 0,
              "set_index": 0, "reps": 8, "weight": 0}
    before = copy.deepcopy(c.data.to_dict())
    with pytest.raises(ValueError):
        await c.async_joint_action("a", "log_set", fields)
    assert c.data.to_dict() == before
    # The partner account cannot use the initiating account's control scope.
    with pytest.raises(ValueError):
        await c.async_joint_action("b", "log_set", {
            **fields, "workout_id": other.id, "expected_revision": other.revision,
            "participant_profile_id": a.id})
    with pytest.raises(ValueError):
        await c.async_joint_action("a", "complete_workout", {
            **fields, "participant_profile_id": outsider.id})
    # Choosing a shared device grants no unrelated coaching or direct partner access.
    assert await c.async_log_set("a", other.id, 0, 0, 8, 0) is None
    with pytest.raises(ValueError, match="permission"):
        await c.async_session_action("a", b.id, "log_set", fields)


async def test_shared_controller_stops_after_leaving_and_checks_invalid_inputs(coordinator):
    c = coordinator
    a, b, w, other = await joined(c, "same_device")
    fields = {"workout_id": w.id, "expected_revision": w.revision,
              "participant_profile_id": a.id, "exercise_index": 0,
              "set_index": 0, "reps": 8, "weight": 0}
    for bad in [dict(fields, reps=-1), dict(fields, weight=-1),
                dict(fields, effort="invalid"), dict(fields, expected_revision=-1)]:
        with pytest.raises(ValueError):
            await c.async_joint_action("a", "log_set", bad)
        assert not w.exercises[0].sets[0].completed
    await c.async_joint_action("a", "leave", {
        "workout_id": w.id, "expected_revision": w.revision})
    with pytest.raises(ValueError, match="left"):
        await c.async_joint_action("a", "log_set", {
            **fields, "expected_revision": w.revision, "participant_profile_id": b.id})


async def test_legacy_sessions_default_to_individual_devices(coordinator):
    c = coordinator
    a, b, w, other = await joined(c)
    payload = w.to_dict()
    payload["joint_session"].pop("device_mode")
    payload["joint_session"].pop("controller_profile_id")
    restored = type(w).from_dict(payload)
    assert restored.joint_session["device_mode"] == "different_devices"


async def test_invite_is_persistent_and_only_recipient_can_accept(coordinator):
    c = coordinator
    a = await c.async_ensure_profile("a", "A")
    b = await c.async_ensure_profile("b", "B")
    outsider = await c.async_ensure_profile("outside", "Outside")
    w = await c.async_create_workout("a", "Invite", [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}]}])
    sent = await c.async_joint_action("a", "join", {
        "workout_id": w.id, "expected_revision": w.revision,
        "partner_profile_id": b.id, "device_mode": "same_device"})
    c.data = GainsData.from_dict(c.data.to_dict())
    w = c.get_workout(w.id)
    state = await c.async_training_state("b")
    incoming = state["attributes"]["incoming_shares"][0]
    assert incoming["id"] == sent["invite_id"]
    assert incoming["kind"] == "joint_workout"
    assert incoming["device_mode"] == "same_device"
    assert w.status == "planned" and not w.joint_session
    assert not c.workouts_for_profile(b.id)
    assert await c.async_respond_share("a", sent["invite_id"], True) is None
    assert await c.async_respond_share("outside", sent["invite_id"], True) is None
    await c.async_set_coach_permissions("b", outsider.id, {"coach_workouts": True})
    with pytest.raises(ValueError, match="own account"):
        await c.async_respond_share("outside", sent["invite_id"], True, acting_profile_id=b.id)
    accepted = await c.async_respond_share("b", sent["invite_id"], True)
    assert accepted.profile_id == b.id
    assert w.joint_session["controller_profile_id"] == a.id
    assert await c.async_respond_share("b", sent["invite_id"], True) is None
    assert len(c.workouts_for_profile(b.id)) == 1


async def test_declining_joint_invite_changes_no_workout(coordinator):
    c = coordinator
    await c.async_ensure_profile("a", "A")
    b = await c.async_ensure_profile("b", "B")
    w = await c.async_create_workout("a", "Invite", [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}]}])
    sent = await c.async_joint_action("a", "join", {
        "workout_id": w.id, "expected_revision": w.revision, "partner_profile_id": b.id})
    before = copy.deepcopy(w.to_dict())
    declined = await c.async_respond_share("b", sent["invite_id"], False)
    assert declined.status == "declined"
    assert w.to_dict() == before
    assert not c.workouts_for_profile(b.id)


async def test_changed_source_cannot_activate_from_old_invite(coordinator):
    c = coordinator
    await c.async_ensure_profile("a", "A")
    b = await c.async_ensure_profile("b", "B")
    w = await c.async_create_workout("a", "Invite", [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}]}])
    sent = await c.async_joint_action("a", "join", {
        "workout_id": w.id, "expected_revision": w.revision, "partner_profile_id": b.id})
    await c.async_start_workout("a", w.id)
    with pytest.raises(ValueError, match="changed or started"):
        await c.async_respond_share("b", sent["invite_id"], True)
    assert not c.workouts_for_profile(b.id)
    assert c.data.share_requests[0].status == "pending"


async def joined_two_exercises(c, device_mode="different_devices"):
    a = await c.async_ensure_profile("a", "A")
    b = await c.async_ensure_profile("b", "B")
    w = await c.async_create_workout("a", "Two exercises", [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}, {"reps": 8, "weight": 0}]},
        {"exercise_id": "plank", "sets": [{"reps": 30, "weight": 0}]},
    ])
    invite = await c.async_joint_action("a", "join", {
        "workout_id": w.id, "expected_revision": w.revision,
        "partner_profile_id": b.id, "device_mode": device_mode})
    other = await c.async_respond_share("b", invite["invite_id"], True)
    return a, b, w, other


async def test_athletes_can_move_between_exercises_out_of_order(coordinator):
    c = coordinator
    a, b, w, other = await joined_two_exercises(c)
    # Jumping ahead to the second exercise is allowed and the turn follows.
    await c.async_log_set("a", w.id, 1, 0, 30, 0)
    assert w.joint_session["turn"] == {"profile_id": b.id, "exercise_index": 1, "set_index": 0}
    # Turns still alternate within an exercise.
    with pytest.raises(ValueError, match="turn"):
        await c.async_log_set("b", other.id, 0, 1, 8, 0)
    await c.async_log_set("b", other.id, 1, 0, 30, 0)
    # Back on the first exercise: A then B for each set, wrapping around.
    assert w.joint_session["turn"] == {"profile_id": a.id, "exercise_index": 0, "set_index": 0}
    await c.async_log_set("a", w.id, 0, 0, 8, 0)
    assert w.joint_session["turn"] == {"profile_id": b.id, "exercise_index": 0, "set_index": 0}
    # Focusing an exercise moves the shared turn there too.
    await c.async_session_action("b", None, "focus", {
        "workout_id": other.id, "exercise_index": 0, "set_index": 0})
    assert w.joint_session == other.joint_session


async def test_joint_add_and_remove_exercise_apply_to_every_athlete(coordinator):
    c = coordinator
    a, b, w, other = await joined_two_exercises(c)
    await c.async_session_action("a", None, "add_exercise", {
        "workout_id": w.id, "exercise_id": "bodyweight_squat", "sets": 2})
    assert [e.exercise_id for e in w.exercises] == [e.exercise_id for e in other.exercises]
    assert w.exercises[-1].exercise_id == "bodyweight_squat"
    assert len(other.exercises[-1].sets) == 2
    await c.async_log_set("a", w.id, 2, 0, 8, 0)
    assert w.joint_session["turn"] == {"profile_id": b.id, "exercise_index": 2, "set_index": 0}
    # Partner already logged on push-ups: removing it would delete their work.
    await c.async_log_set("a", w.id, 0, 0, 8, 0)
    await c.async_log_set("b", other.id, 0, 0, 8, 0)
    with pytest.raises(ValueError, match="already logged"):
        await c.async_session_action("a", None, "remove_exercise", {
            "workout_id": w.id, "exercise_index": 0})
    assert len(w.exercises) == len(other.exercises) == 3
    await c.async_session_action("b", None, "remove_exercise", {
        "workout_id": other.id, "exercise_index": 1})
    assert [e.exercise_id for e in w.exercises] == ["push_up", "bodyweight_squat"]
    assert [e.exercise_id for e in other.exercises] == ["push_up", "bodyweight_squat"]
    assert w.joint_session == other.joint_session
    # Set structure stays locked so set positions keep lining up.
    with pytest.raises(ValueError, match="Leave"):
        await c.async_session_action("a", None, "add_set", {
            "workout_id": w.id, "exercise_index": 0})


async def test_solo_add_exercise_validates_and_appends(coordinator):
    c = coordinator
    await c.async_ensure_profile("a", "A")
    w = await c.async_create_workout("a", "Solo", [
        {"exercise_id": "push_up", "sets": [{"reps": 8, "weight": 0}]}])
    await c.async_session_action("a", None, "add_exercise", {
        "workout_id": w.id, "exercise_id": "plank"})
    assert [e.exercise_id for e in w.exercises] == ["push_up", "plank"]
    assert len(w.exercises[1].sets) == 3
    assert w.exercises[1].sets[0].planned_reps == 30
    with pytest.raises((ValueError, vol.Invalid)):
        await c.async_session_action("a", None, "add_exercise", {
            "workout_id": w.id, "exercise_id": "not_a_real_exercise"})
    await c.async_complete_workout("a", w.id)
    with pytest.raises(ValueError, match="editable"):
        await c.async_session_action("a", None, "add_exercise", {
            "workout_id": w.id, "exercise_id": "plank"})


@pytest.mark.parametrize("mode", ["same_device", "different_devices"])
async def test_joint_athletes_can_switch_bars(coordinator, mode):
    c = coordinator
    await c.async_ensure_profile("a", "A")
    b = await c.async_ensure_profile("b", "B")
    for uid in ["a", "b"]:
        gym = await c.async_create_gym_profile(uid, f"{uid} gym", {
            "olympic_barbell": [45.0], "short_bar": [20.0], "plates": [45.0, 25.0, 10.0, 5.0]})
        await c.async_select_gym_profile(uid, gym.id)
    w = await c.async_create_workout("a", "Squat", [
        {"exercise_id": "barbell_back_squat", "sets": [{"reps": 8, "weight": 45}]}])
    invite = await c.async_joint_action("a", "join", {
        "workout_id": w.id, "expected_revision": w.revision,
        "partner_profile_id": b.id, "device_mode": mode})
    other = await c.async_respond_share("b", invite["invite_id"], True)
    await c.async_session_action("a", None, "set_bar", {
        "workout_id": w.id, "exercise_index": 0, "equipment_id": "short_bar", "bar_weight": 20})
    assert w.exercises[0].selected_bar_equipment_id == "short_bar"
    fields = {"workout_id": w.id, "expected_revision": w.revision,
              "participant_profile_id": b.id, "exercise_index": 0,
              "equipment_id": "short_bar", "bar_weight": 20}
    if mode == "same_device":
        await c.async_joint_action("a", "set_bar", fields)
        assert other.exercises[0].selected_bar_equipment_id == "short_bar"
        assert w.joint_session["participants"][1]["exercises"][0][
            "selected_bar_equipment_id"] == "short_bar"
        with pytest.raises(ValueError, match="not configured"):
            await c.async_joint_action("a", "set_bar", {
                **fields, "expected_revision": w.revision, "bar_weight": 15})
    else:
        with pytest.raises(ValueError, match="shared session device"):
            await c.async_joint_action("a", "set_bar", fields)
        await c.async_session_action("b", None, "set_bar", {
            "workout_id": other.id, "exercise_index": 0,
            "equipment_id": "short_bar", "bar_weight": 20})
        assert other.exercises[0].selected_bar_equipment_id == "short_bar"
