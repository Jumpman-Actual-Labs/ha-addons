"""Dataclass to_dict/from_dict round-trip + tolerant-of-bad-data tests."""

from __future__ import annotations

from gains_addon.models import (
    AICoachMessage,
    AthleteProfile,
    GainsData,
    GymProfile,
    Run,
    Workout,
    WorkoutExercise,
    WorkoutSet,
)


def test_athlete_profile_round_trip():
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        units="metric",
        experience_level="intermediate",
        activity_level="active",
        preferred_duration_minutes=45,
        rest_timer_seconds=90,
        is_admin=True,
        onboarding_complete=True,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-02T00:00:00+00:00",
        last_bar_by_exercise={
            "barbell_back_squat": {"equipment_id": "short_bar", "weight": 20.0}
        },
    )
    restored = AthleteProfile.from_dict(profile.to_dict())
    assert restored == profile


def test_athlete_profile_from_dict_tolerates_missing_fields():
    profile = AthleteProfile.from_dict({"id": "1", "ha_user_id": "u1"})
    assert profile.display_name == "Athlete"
    assert profile.units == "imperial"
    assert profile.experience_level is None
    assert profile.is_admin is False
    assert profile.rest_timer_seconds == 60


def test_athlete_profile_from_dict_tolerates_bad_types():
    # A stray non-numeric value already sitting in an existing Store
    # shouldn't crash the whole integration on load -- it just becomes
    # None, matching Cache's from_dict coercion convention.
    profile = AthleteProfile.from_dict(
        {
            "id": "1",
            "ha_user_id": "u1",
            "preferred_duration_minutes": "not-a-number",
            "rest_timer_seconds": "not-a-number",
        }
    )
    assert profile.preferred_duration_minutes is None
    assert profile.rest_timer_seconds == 60


def test_gains_data_round_trip():
    data = GainsData(
        profiles=[
            AthleteProfile(id="1", ha_user_id="u1", display_name="A"),
            AthleteProfile(id="2", ha_user_id="u2", display_name="B"),
        ]
    )
    restored = GainsData.from_dict(data.to_dict())
    assert restored == data


def test_gains_data_from_dict_handles_none():
    assert GainsData.from_dict(None) == GainsData()


def test_gains_data_from_dict_skips_non_dict_entries():
    restored = GainsData.from_dict({"profiles": [{"id": "1", "ha_user_id": "u1"}, "garbage", None]})
    assert len(restored.profiles) == 1


def test_athlete_profile_personal_records_round_trip():
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        personal_records={"barbell_back_squat": 185.5},
    )
    restored = AthleteProfile.from_dict(profile.to_dict())
    assert restored == profile


def test_athlete_profile_personal_records_tolerates_bad_types():
    profile = AthleteProfile.from_dict(
        {
            "id": "1",
            "ha_user_id": "u1",
            "personal_records": {"barbell_back_squat": "not-a-number", "ok": 100, 5: 50},
        }
    )
    assert profile.personal_records == {"ok": 100.0}


def test_athlete_profile_gym_profile_id_round_trip():
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        gym_profile_id="gym-1",
    )
    restored = AthleteProfile.from_dict(profile.to_dict())
    assert restored == profile


def test_athlete_profile_gym_profile_id_defaults_to_none():
    profile = AthleteProfile.from_dict({"id": "1", "ha_user_id": "u1"})
    assert profile.gym_profile_id is None


def test_gym_profile_round_trip():
    gym = GymProfile(
        id="gym-1",
        name="Home Gym",
        equipment={"olympic_barbell": [45.0], "short_bar": [20.0, 5.0], "dumbbells": [None]},
        equipment_config={
            "cable_tower": {"load_type": "plate_loaded", "pulley_ratio": 2.0}
        },
        created_by_profile_id="1",
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-02T00:00:00+00:00",
    )
    restored = GymProfile.from_dict(gym.to_dict())
    assert restored == gym


def test_gym_profile_from_dict_tolerates_bad_equipment_types():
    gym = GymProfile.from_dict(
        {
            "id": "gym-1",
            "name": "Home Gym",
            "equipment": {
                "olympic_barbell": "not-a-list",
                "dumbbells": [None],
                "kettlebells": [30, "not-a-number"],
                "ez_bar": [],
                5: [1],
            },
        }
    )
    assert gym.equipment == {"dumbbells": [None], "kettlebells": [30.0]}


def test_gains_data_from_dict_migrates_legacy_athlete_equipment_to_gym_profile():
    # Pre-refactor storage documents have equipment nested directly under
    # the athlete profile -- from_dict must synthesize a personal
    # GymProfile from that data so upgrading doesn't silently lose it.
    restored = GainsData.from_dict(
        {
            "profiles": [
                {
                    "id": "1",
                    "ha_user_id": "u1",
                    "display_name": "Jordan",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "equipment": {"olympic_barbell": [45.0]},
                }
            ]
        }
    )
    assert len(restored.gym_profiles) == 1
    migrated_gym = restored.gym_profiles[0]
    assert migrated_gym.equipment == {"olympic_barbell": [45.0]}
    assert restored.profiles[0].gym_profile_id == migrated_gym.id


def test_gains_data_from_dict_skips_migration_when_no_legacy_equipment():
    restored = GainsData.from_dict(
        {"profiles": [{"id": "1", "ha_user_id": "u1", "display_name": "Jordan"}]}
    )
    assert restored.gym_profiles == []
    assert restored.profiles[0].gym_profile_id is None


def test_workout_set_round_trip():
    workout_set = WorkoutSet(
        planned_reps=5,
        planned_weight=135.0,
        actual_reps=5,
        actual_weight=140.0,
        completed=True,
        is_personal_record=True,
        personal_record_value=163.3,
        previous_personal_record=157.5,
    )
    assert WorkoutSet.from_dict(workout_set.to_dict()) == workout_set


def test_workout_exercise_effort_round_trip():
    exercise = WorkoutExercise(
        exercise_id="barbell_bench_press",
        sets=[WorkoutSet(planned_reps=8, planned_weight=135.0)],
        notes="warm up first",
        effort="hard",
        selected_bar_equipment_id="short_bar",
        selected_bar_weight=20.0,
    )
    assert WorkoutExercise.from_dict(exercise.to_dict()) == exercise


def test_workout_round_trip():
    workout = Workout(
        id="w1",
        profile_id="p1",
        name="Push Day",
        status="active",
        exercises=[
            WorkoutExercise(
                exercise_id="barbell_bench_press",
                sets=[WorkoutSet(planned_reps=8, planned_weight=135.0)],
                notes="warm up first",
            )
        ],
        notes="felt good",
        created_at="2026-01-01T00:00:00+00:00",
        started_at="2026-01-01T00:05:00+00:00",
    )
    restored = Workout.from_dict(workout.to_dict())
    assert restored == workout


def test_workout_from_dict_tolerates_missing_fields():
    workout = Workout.from_dict({"id": "w1", "profile_id": "p1"})
    assert workout.name == "Workout"
    assert workout.status == "planned"
    assert workout.exercises == []


def test_workout_from_dict_skips_non_dict_exercises():
    workout = Workout.from_dict(
        {"id": "w1", "profile_id": "p1", "exercises": [{"exercise_id": "x"}, "garbage", None]}
    )
    assert len(workout.exercises) == 1


def test_run_round_trip():
    run = Run(
        id="r1",
        profile_id="p1",
        name="Easy Run",
        run_type="easy",
        status="completed",
        target_distance=3.0,
        target_duration_minutes=30,
        actual_distance=3.1,
        actual_duration_minutes=32,
        notes="felt good",
        created_at="2026-01-01T00:00:00+00:00",
        completed_at="2026-01-01T00:32:00+00:00",
    )
    restored = Run.from_dict(run.to_dict())
    assert restored == run


def test_run_from_dict_tolerates_missing_fields():
    run = Run.from_dict({"id": "r1", "profile_id": "p1"})
    assert run.name == "Run"
    assert run.run_type == "easy"
    assert run.status == "planned"
    assert run.target_distance is None


def test_gains_data_workouts_and_runs_round_trip():
    data = GainsData(
        profiles=[AthleteProfile(id="1", ha_user_id="u1", display_name="A")],
        workouts=[Workout(id="w1", profile_id="1", name="Leg Day")],
        runs=[Run(id="r1", profile_id="1", name="Easy Run")],
    )
    restored = GainsData.from_dict(data.to_dict())
    assert restored == data


def test_gains_data_from_dict_tolerates_missing_runs_key():
    # Older stored data won't have a "runs" key at all -- must not crash.
    data = GainsData.from_dict({"profiles": [], "workouts": []})
    assert data.runs == []


def test_ai_coach_message_round_trip():
    message = AICoachMessage(
        role="assistant",
        content="Here's your week.",
        created_at="2026-01-01T00:00:00+00:00",
        proposed_workouts=[
            {
                "name": "Leg Day",
                "exercises": [
                    {"exercise_id": "barbell_back_squat", "sets": [{"reps": 8, "weight": None}]}
                ],
            }
        ],
        proposed_runs=[{"name": "Easy Run", "run_type": "easy"}],
    )
    restored = AICoachMessage.from_dict(message.to_dict())
    assert restored == message


def test_ai_coach_message_from_dict_tolerates_missing_fields():
    message = AICoachMessage.from_dict({})
    assert message.role == "user"
    assert message.content == ""
    assert message.proposed_workouts == []
    assert message.proposed_runs == []


def test_ai_coach_message_from_dict_tolerates_non_list_proposed_fields():
    message = AICoachMessage.from_dict(
        {"role": "assistant", "proposed_workouts": "garbage", "proposed_runs": "garbage"}
    )
    assert message.proposed_workouts == []
    assert message.proposed_runs == []


def test_ai_coach_message_from_dict_tolerates_old_stored_shape_without_proposed_fields():
    # A message saved before this feature existed only has role/content/
    # created_at -- must not crash on load.
    message = AICoachMessage.from_dict(
        {"role": "user", "content": "hi", "created_at": "2026-01-01T00:00:00+00:00"}
    )
    assert message.proposed_workouts == []
    assert message.proposed_runs == []


def test_athlete_profile_ai_conversation_round_trip():
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        ai_conversation=[
            AICoachMessage(role="user", content="hi"),
            AICoachMessage(role="assistant", content="hello"),
        ],
    )
    restored = AthleteProfile.from_dict(profile.to_dict())
    assert restored == profile


def test_athlete_profile_ai_conversation_skips_non_dict_entries():
    profile = AthleteProfile.from_dict(
        {
            "id": "1",
            "ha_user_id": "u1",
            "ai_conversation": [{"role": "user", "content": "hi"}, "garbage"],
        }
    )
    assert len(profile.ai_conversation) == 1


def test_profile_sequencing_tolerates_missing_or_invalid_legacy_values():
    for value in (None, 'invalid', [], 42):
        profile = AthleteProfile.from_dict({'id': 'p', 'preferred_sequencing_policy': value})
        assert profile.preferred_sequencing_policy == 'completion'
    assert AthleteProfile.from_dict({'id': 'p'}).preferred_sequencing_policy == 'completion'



def test_legacy_gym_units_recover_without_changing_plate_counts():
    raw = {
        'profiles': [{'id': 'p', 'units': 'imperial', 'gym_profile_id': 'g'}],
        'gym_profiles': [{'id': 'g', 'created_by_profile_id': 'p',
                          'equipment': {'olympic_barbell': [45], 'plates': [2.5, 2.5, 45, 45]}}],
    }
    restored = GainsData.from_dict(raw)
    gym = restored.gym_profiles[0]
    assert gym.inventory_units == 'imperial'
    assert gym.equipment == raw['gym_profiles'][0]['equipment']
    from gains_addon.exercises import get_exercise
    from gains_addon.load_policy import exercise_availability
    assert exercise_availability(get_exercise('stiff_leg_deadlift'),
                                 restored.profiles[0], restored)['feasible']
    assert GainsData.from_dict(restored.to_dict()).gym_profiles[0] == gym


def test_legacy_gym_unit_recovery_preserves_explicit_units_and_ambiguous_records():
    raw = {
        'profiles': [{'id': 'p', 'units': 'metric', 'gym_profile_id': 'g'},
                     {'id': 'q', 'units': 'imperial', 'gym_profile_id': 'g'}],
        'gym_profiles': [{'id': 'g', 'equipment': {'plates': [10, 10]}}],
    }
    assert GainsData.from_dict(raw).gym_profiles[0].inventory_units is None
    raw['gym_profiles'][0]['inventory_units'] = 'metric'
    assert GainsData.from_dict(raw).gym_profiles[0].inventory_units == 'metric'
    raw['profiles'] = []
    del raw['gym_profiles'][0]['inventory_units']
    assert GainsData.from_dict(raw).gym_profiles[0].inventory_units is None
