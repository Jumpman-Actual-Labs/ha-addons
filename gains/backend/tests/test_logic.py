"""Pure-function tests -- no HA, no coordinator, no storage."""

from __future__ import annotations

from gains_addon import logic
from gains_addon.models import (
    AthleteProfile,
    GymProfile,
    Run,
    Workout,
    WorkoutExercise,
    WorkoutSet,
)


def test_default_display_name_uses_person_name():
    assert logic.default_display_name("Jordan", "abc123") == "Jordan"


def test_default_display_name_strips_whitespace():
    assert logic.default_display_name("  Jordan  ", "abc123") == "Jordan"


def test_default_display_name_falls_back_to_user_id():
    assert logic.default_display_name(None, "abcdef1234567890") == "Athlete abcdef12"


def test_default_display_name_falls_back_on_blank_string():
    assert logic.default_display_name("   ", "abcdef1234567890") == "Athlete abcdef12"


def test_new_profile_is_admin_when_no_existing_profiles():
    assert logic.new_profile_is_admin([]) is True


def test_new_profile_is_not_admin_when_profiles_exist():
    existing = [AthleteProfile(id="1", ha_user_id="u1", display_name="First")]
    assert logic.new_profile_is_admin(existing) is False


def test_find_profile_by_user_id_matches():
    profiles = [
        AthleteProfile(id="1", ha_user_id="u1", display_name="First"),
        AthleteProfile(id="2", ha_user_id="u2", display_name="Second"),
    ]
    found = logic.find_profile_by_user_id(profiles, "u2")
    assert found is not None
    assert found.id == "2"


def test_find_profile_by_user_id_returns_none_when_missing():
    profiles = [AthleteProfile(id="1", ha_user_id="u1", display_name="First")]
    assert logic.find_profile_by_user_id(profiles, "unknown") is None


def test_find_profile_by_id_matches():
    profiles = [AthleteProfile(id="1", ha_user_id="u1", display_name="First")]
    found = logic.find_profile_by_id(profiles, "1")
    assert found is not None
    assert found.ha_user_id == "u1"


def test_find_workout_by_id_matches():
    workouts = [
        Workout(id="w1", profile_id="p1", name="A"),
        Workout(id="w2", profile_id="p1", name="B"),
    ]
    found = logic.find_workout_by_id(workouts, "w2")
    assert found is not None
    assert found.name == "B"


def test_find_workout_by_id_returns_none_when_missing():
    workouts = [Workout(id="w1", profile_id="p1", name="A")]
    assert logic.find_workout_by_id(workouts, "unknown") is None


def test_workouts_for_profile_filters_by_profile_id():
    workouts = [
        Workout(id="w1", profile_id="p1", name="A"),
        Workout(id="w2", profile_id="p2", name="B"),
        Workout(id="w3", profile_id="p1", name="C"),
    ]
    result = logic.workouts_for_profile(workouts, "p1")
    assert [w.id for w in result] == ["w1", "w3"]


def test_find_run_by_id_matches():
    runs = [Run(id="r1", profile_id="p1", name="A"), Run(id="r2", profile_id="p1", name="B")]
    found = logic.find_run_by_id(runs, "r2")
    assert found is not None
    assert found.name == "B"


def test_find_run_by_id_returns_none_when_missing():
    runs = [Run(id="r1", profile_id="p1", name="A")]
    assert logic.find_run_by_id(runs, "unknown") is None


def test_runs_for_profile_filters_by_profile_id():
    runs = [
        Run(id="r1", profile_id="p1", name="A"),
        Run(id="r2", profile_id="p2", name="B"),
        Run(id="r3", profile_id="p1", name="C"),
    ]
    result = logic.runs_for_profile(runs, "p1")
    assert [r.id for r in result] == ["r1", "r3"]


def test_estimate_one_rep_max_single_rep_is_just_the_weight():
    assert logic.estimate_one_rep_max(225, 1) == 225


def test_estimate_one_rep_max_uses_epley_formula():
    # Epley: weight * (1 + reps / 30)
    assert logic.estimate_one_rep_max(200, 5) == 200 * (1 + 5 / 30)


def test_is_new_personal_record_true_when_no_existing_record():
    assert logic.is_new_personal_record({}, "barbell_back_squat", 225) is True


def test_is_new_personal_record_true_when_improved():
    records = {"barbell_back_squat": 200}
    assert logic.is_new_personal_record(records, "barbell_back_squat", 225) is True


def test_is_new_personal_record_false_when_not_improved():
    records = {"barbell_back_squat": 250}
    assert logic.is_new_personal_record(records, "barbell_back_squat", 225) is False


def test_profile_extra_attributes_includes_every_editable_field():
    # Regression test: experience_level was previously left out of the
    # sensor's extra_state_attributes entirely, so the frontend (which
    # reads experience_level from attributes, not entity.state) always
    # rendered it as unset even right after a successful
    # gains.update_profile call. Every field update_profile can change
    # must round-trip through here.
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        units="metric",
        experience_level="advanced",
        activity_level="active",
        preferred_duration_minutes=60,
        rest_timer_seconds=90,
        onboarding_complete=True,
        personal_records={"barbell_back_squat": 225.0},
    )
    attributes = logic.profile_extra_attributes(profile, workouts=[], runs=[])
    assert attributes["display_name"] == "Jordan"
    assert attributes["units"] == "metric"
    assert attributes["experience_level"] == "advanced"
    assert attributes["activity_level"] == "active"
    assert attributes["preferred_duration_minutes"] == 60
    assert attributes["rest_timer_seconds"] == 90
    assert attributes["onboarding_complete"] is True
    assert attributes["personal_records"] == {"barbell_back_squat": 225.0}


def test_profile_extra_attributes_includes_profiles_own_workouts():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan")
    workout = Workout(id="w1", profile_id="1", name="Leg Day")
    attributes = logic.profile_extra_attributes(profile, workouts=[workout], runs=[])
    assert attributes["workouts"] == [workout.to_dict()]


def test_profile_extra_attributes_includes_profiles_own_runs():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan")
    run = Run(id="r1", profile_id="1", name="Easy Run")
    attributes = logic.profile_extra_attributes(profile, workouts=[], runs=[run])
    assert attributes["runs"] == [run.to_dict()]


def test_profile_extra_attributes_includes_gym_profiles():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan", gym_profile_id="g1")
    gym = GymProfile(id="g1", name="Home Gym", equipment={"dumbbells": [None]})
    attributes = logic.profile_extra_attributes(profile, workouts=[], runs=[], gym_profiles=[gym])
    assert attributes["gym_profile_id"] == "g1"
    assert attributes["gym_profiles"] == [gym.to_dict()]


def test_available_equipment_categories_always_includes_bodyweight():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan")
    assert logic.available_equipment_categories(profile, []) == {"bodyweight"}


def test_available_equipment_categories_maps_checked_items():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan", gym_profile_id="g1")
    gym = GymProfile(
        id="g1",
        name="Home Gym",
        equipment={
            "olympic_barbell": [45.0],
            "dumbbells": [None],
            "lat_pulldown_cable": [None],
        },
    )
    categories = logic.available_equipment_categories(profile, [gym])
    assert categories == {"bodyweight", "barbell", "dumbbell", "cable"}


def test_available_equipment_categories_counts_multiple_units_of_the_same_item_once():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan", gym_profile_id="g1")
    gym = GymProfile(id="g1", name="Home Gym", equipment={"short_bar": [20.0, 5.0]})
    assert logic.available_equipment_categories(profile, [gym]) == {"bodyweight", "barbell"}


def test_available_equipment_categories_ignores_unknown_equipment_ids():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan", gym_profile_id="g1")
    gym = GymProfile(id="g1", name="Home Gym", equipment={"not_a_real_item": [None]})
    assert logic.available_equipment_categories(profile, [gym]) == {"bodyweight"}


def test_available_equipment_categories_falls_back_to_bodyweight_when_gym_not_found():
    profile = AthleteProfile(
        id="1", ha_user_id="u1", display_name="Jordan", gym_profile_id="missing"
    )
    assert logic.available_equipment_categories(profile, []) == {"bodyweight"}


def test_profile_extra_attributes_includes_ai_conversation():
    from gains_addon.models import AICoachMessage

    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        ai_conversation=[AICoachMessage(role="user", content="hi")],
    )
    attributes = logic.profile_extra_attributes(profile, workouts=[], runs=[])
    assert attributes["ai_conversation"] == [
        {
            "role": "user",
            "content": "hi",
            "created_at": "",
            "proposed_workouts": [],
            "proposed_runs": [],
        }
    ]


# -- AI Coach (partial Phase 8): parse_ai_reply / sanitize_profile_updates /
# validate_proposed_workouts / validate_proposed_runs -- the deterministic
# validation layer between whatever the AI provider returned and what
# actually gets applied/offered.


def test_parse_ai_reply_valid_json():
    raw = (
        '{"reply": "Hi!", "profile_updates": {"units": "metric"}, '
        '"proposed_workouts": [], "proposed_runs": []}'
    )
    result = logic.parse_ai_reply(raw)
    assert result == {
        "reply": "Hi!",
        "profile_updates": {"units": "metric"},
        "proposed_workouts": [],
        "proposed_runs": [],
    }


def test_parse_ai_reply_strips_markdown_code_fence():
    raw = (
        '```json\n{"reply": "Hi!", "profile_updates": null, '
        '"proposed_workouts": [], "proposed_runs": []}\n```'
    )
    result = logic.parse_ai_reply(raw)
    assert result["reply"] == "Hi!"


def test_parse_ai_reply_falls_back_to_raw_text_when_not_json():
    raw = "Sure, tell me more about your goals!"
    result = logic.parse_ai_reply(raw)
    assert result == {
        "reply": raw,
        "profile_updates": None,
        "proposed_workouts": [],
        "proposed_runs": [],
    }


def test_parse_ai_reply_falls_back_when_json_is_not_an_object():
    result = logic.parse_ai_reply("[1, 2, 3]")
    assert result == {
        "reply": "[1, 2, 3]",
        "profile_updates": None,
        "proposed_workouts": [],
        "proposed_runs": [],
    }


def test_parse_ai_reply_ignores_non_dict_profile_updates():
    raw = (
        '{"reply": "ok", "profile_updates": "not-a-dict", '
        '"proposed_workouts": [], "proposed_runs": []}'
    )
    result = logic.parse_ai_reply(raw)
    assert result["profile_updates"] is None


def test_parse_ai_reply_wraps_a_legacy_singular_proposed_workout():
    raw = (
        '{"reply": "ok", "profile_updates": null, '
        '"proposed_workout": {"name": "Leg Day", "exercises": []}}'
    )
    result = logic.parse_ai_reply(raw)
    assert result["proposed_workouts"] == [{"name": "Leg Day", "exercises": []}]


def test_parse_ai_reply_reads_multiple_proposed_workouts_and_runs():
    raw = (
        '{"reply": "Here is your week", "profile_updates": null, '
        '"proposed_workouts": [{"name": "Push", "exercises": []}, '
        '{"name": "Pull", "exercises": []}], '
        '"proposed_runs": [{"name": "Easy Run", "run_type": "easy"}]}'
    )
    result = logic.parse_ai_reply(raw)
    assert len(result["proposed_workouts"]) == 2
    assert len(result["proposed_runs"]) == 1


def test_sanitize_profile_updates_keeps_valid_fields():
    updates = {
        "units": "metric",
        "experience_level": "advanced",
        "activity_level": "active",
        "preferred_duration_minutes": 45,
        "display_name": "  Jordan  ",
    }
    assert logic.sanitize_profile_updates(updates) == {
        "units": "metric",
        "experience_level": "advanced",
        "activity_level": "active",
        "preferred_duration_minutes": 45,
        "display_name": "Jordan",
    }


def test_sanitize_profile_updates_drops_invalid_enum_values():
    updates = {"units": "furlongs", "experience_level": "expert"}
    assert logic.sanitize_profile_updates(updates) == {}


def test_sanitize_profile_updates_drops_out_of_range_duration():
    assert logic.sanitize_profile_updates({"preferred_duration_minutes": 500}) == {}
    assert logic.sanitize_profile_updates({"preferred_duration_minutes": 5}) == {}


def test_sanitize_profile_updates_handles_none():
    assert logic.sanitize_profile_updates(None) == {}


def _sample_exercise_library():
    return [
        {
            "id": "barbell_back_squat",
            "name": "Barbell Back Squat",
            "category": "squat",
            "equipment": "barbell",
        },
        {
            "id": "barbell_bench_press",
            "name": "Barbell Bench Press",
            "category": "push",
            "equipment": "barbell",
        },
        {
            "id": "bodyweight_squat",
            "name": "Bodyweight Squat",
            "category": "squat",
            "equipment": "bodyweight",
        },
    ]


def _sample_profile(personal_records=None, experience_level=None):
    return AthleteProfile(
        id="p1",
        ha_user_id="u1",
        display_name="Jordan",
        personal_records=personal_records or {},
        experience_level=experience_level,
    )


def test_validate_proposed_workouts_keeps_valid_exercises():
    valid_ids = frozenset({"barbell_back_squat", "barbell_bench_press"})
    proposed = [
        {
            "name": "Leg Day",
            "exercises": [
                {"exercise_id": "barbell_back_squat", "sets": [{"reps": 8, "weight": 135}]},
                {"exercise_id": "not_a_real_exercise", "sets": [{"reps": 5, "weight": 100}]},
            ],
        }
    ]
    result = logic.validate_proposed_workouts(
        proposed, valid_ids, _sample_exercise_library(), _sample_profile()
    )
    assert result == [
        {
            "name": "Leg Day",
            "exercises": [
                {"exercise_id": "barbell_back_squat", "sets": [{"reps": 8, "weight": 135}]}
            ],
        }
    ]


def test_validate_proposed_workouts_drops_days_with_no_valid_exercises_but_keeps_others():
    valid_ids = frozenset({"barbell_back_squat"})
    proposed = [
        {"name": "Bad", "exercises": [{"exercise_id": "hallucinated_exercise", "sets": []}]},
        {"name": "Good", "exercises": [{"exercise_id": "barbell_back_squat", "sets": []}]},
    ]
    result = logic.validate_proposed_workouts(
        proposed, valid_ids, _sample_exercise_library(), _sample_profile()
    )
    assert len(result) == 1
    assert result[0]["name"] == "Good"


def test_validate_proposed_workouts_handles_none_and_empty():
    assert logic.validate_proposed_workouts(None, frozenset(), [], _sample_profile()) == []
    assert logic.validate_proposed_workouts([], frozenset(), [], _sample_profile()) == []


def test_validate_proposed_workouts_fills_in_a_default_weight_when_missing():
    valid_ids = frozenset({"barbell_back_squat"})
    proposed = [{"name": "Leg Day", "exercises": [{"exercise_id": "barbell_back_squat"}]}]
    result = logic.validate_proposed_workouts(
        proposed, valid_ids, _sample_exercise_library(), _sample_profile()
    )
    # No personal record on file -- falls back to the equipment-appropriate
    # static default (barbell) rather than leaving weight null.
    assert result[0]["exercises"][0]["sets"] == [{"reps": None, "weight": 45.0}]


def test_validate_proposed_workouts_gives_kids_a_lighter_default_not_an_adult_one():
    # Kids may use loaded exercises, but a missing weight must still get a
    # youth-appropriate fallback rather than an adult-sized 45lb barbell
    # default (and not a blank field either -- a parent logging this
    # manually needs a real starting number).
    valid_ids = frozenset({"barbell_back_squat"})
    proposed = [{"name": "Leg Day", "exercises": [{"exercise_id": "barbell_back_squat"}]}]
    result = logic.validate_proposed_workouts(
        proposed,
        valid_ids,
        _sample_exercise_library(),
        _sample_profile(experience_level="kids"),
    )
    assert result[0]["exercises"][0]["sets"] == [{"reps": None, "weight": 11.0}]


def test_validate_proposed_workouts_ignores_1rm_for_kids():
    # Even if a kids profile somehow has a personal record on file, the
    # 70%-of-1RM math is an adult-strength-training concept that doesn't
    # apply to a young child -- the fixed lighter default wins instead.
    valid_ids = frozenset({"barbell_back_squat"})
    proposed = [{"name": "Leg Day", "exercises": [{"exercise_id": "barbell_back_squat"}]}]
    profile = _sample_profile(
        personal_records={"barbell_back_squat": 200.0}, experience_level="kids"
    )
    result = logic.validate_proposed_workouts(
        proposed, valid_ids, _sample_exercise_library(), profile
    )
    assert result[0]["exercises"][0]["sets"] == [{"reps": None, "weight": 11.0}]


def test_validate_proposed_workouts_prefers_estimated_1rm_over_static_default():
    valid_ids = frozenset({"barbell_back_squat"})
    proposed = [
        {
            "name": "Leg Day",
            "exercises": [
                {"exercise_id": "barbell_back_squat", "sets": [{"reps": 8, "weight": None}]}
            ],
        }
    ]
    profile = _sample_profile(personal_records={"barbell_back_squat": 200.0})
    result = logic.validate_proposed_workouts(
        proposed, valid_ids, _sample_exercise_library(), profile
    )
    # 70% of a 200 estimated 1RM is 140 -- already a multiple of 5, no rounding drift.
    assert result[0]["exercises"][0]["sets"][0]["weight"] == 140.0


def test_validate_proposed_workouts_leaves_bodyweight_weight_null():
    valid_ids = frozenset({"bodyweight_squat"})
    proposed = [
        {
            "name": "Leg Day",
            "exercises": [{"exercise_id": "bodyweight_squat", "sets": [{"reps": 12}]}],
        }
    ]
    result = logic.validate_proposed_workouts(
        proposed, valid_ids, _sample_exercise_library(), _sample_profile()
    )
    assert result[0]["exercises"][0]["sets"][0]["weight"] is None


def test_validate_proposed_workouts_defaults_missing_name():
    valid_ids = frozenset({"barbell_back_squat"})
    proposed = [{"exercises": [{"exercise_id": "barbell_back_squat", "sets": [{"reps": 5}]}]}]
    result = logic.validate_proposed_workouts(
        proposed, valid_ids, _sample_exercise_library(), _sample_profile()
    )
    assert result[0]["name"] == "AI-Suggested Workout"


def test_validate_proposed_runs_normalizes_fields():
    proposed = [
        {
            "name": "Easy Run",
            "run_type": "easy",
            "target_distance": 3,
            "target_duration_minutes": 30,
        }
    ]
    result = logic.validate_proposed_runs(proposed)
    assert result == [
        {
            "name": "Easy Run",
            "run_type": "easy",
            "target_distance": 3,
            "target_duration_minutes": 30,
        }
    ]


def test_validate_proposed_runs_defaults_invalid_run_type():
    proposed = [{"name": "Run", "run_type": "sprint"}]
    result = logic.validate_proposed_runs(proposed)
    assert result[0]["run_type"] == "easy"


def test_validate_proposed_runs_defaults_missing_name():
    result = logic.validate_proposed_runs([{"run_type": "tempo"}])
    assert result[0]["name"] == "AI-Suggested Run"


def test_validate_proposed_runs_handles_none_and_empty():
    assert logic.validate_proposed_runs(None) == []
    assert logic.validate_proposed_runs([]) == []


def test_validate_proposed_runs_keeps_multiple_entries():
    proposed = [{"name": "Tue Run"}, {"name": "Thu Run"}]
    result = logic.validate_proposed_runs(proposed)
    assert len(result) == 2


def test_build_ai_system_prompt_includes_exercise_ids_and_profile_state():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan", units="metric")
    library = [
        {
            "id": "barbell_back_squat",
            "name": "Barbell Back Squat",
            "category": "squat",
            "equipment": "barbell",
        }
    ]
    prompt = logic.build_ai_system_prompt(profile, library)
    assert "barbell_back_squat" in prompt
    assert "units=metric" in prompt
    assert "experience_level=unset" in prompt


def test_build_ai_system_prompt_sizes_workout_to_preferred_duration():
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        preferred_duration_minutes=45,
    )
    prompt = logic.build_ai_system_prompt(profile, [])
    assert "45" in prompt
    # 45 minutes should translate into a multi-exercise guideline, not a
    # workout that could be satisfied by one exercise -- the whole point
    # of this instruction existing.
    assert "one or two exercises is too short" in prompt


def test_build_ai_system_prompt_includes_experience_level_guidance():
    profile = AthleteProfile(
        id="1", ha_user_id="u1", display_name="Jordan", experience_level="beginner"
    )
    prompt = logic.build_ai_system_prompt(profile, [])
    assert "beginner" in prompt
    assert "avoid olympic-category lifts" in prompt


def test_build_ai_system_prompt_includes_full_library_when_no_equipment_set():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan")
    library = [
        {
            "id": "barbell_back_squat",
            "name": "Barbell Back Squat",
            "category": "squat",
            "equipment": "barbell",
        },
        {
            "id": "bodyweight_squat",
            "name": "Bodyweight Squat",
            "category": "squat",
            "equipment": "bodyweight",
        },
    ]
    prompt = logic.build_ai_system_prompt(profile, library)
    assert "barbell_back_squat" in prompt
    assert "bodyweight_squat" in prompt


def test_build_ai_system_prompt_filters_library_by_checked_equipment():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan", gym_profile_id="g1")
    gym = GymProfile(id="g1", name="Home Gym", equipment={"dumbbells": [None]})
    library = [
        {
            "id": "barbell_back_squat",
            "name": "Barbell Back Squat",
            "category": "squat",
            "equipment": "barbell",
        },
        {
            "id": "goblet_squat",
            "name": "Goblet Squat",
            "category": "squat",
            "equipment": "dumbbell",
        },
        {
            "id": "bodyweight_squat",
            "name": "Bodyweight Squat",
            "category": "squat",
            "equipment": "bodyweight",
        },
    ]
    prompt = logic.build_ai_system_prompt(profile, library, gym_profiles=[gym])
    assert "barbell_back_squat" not in prompt
    assert "goblet_squat" in prompt
    assert "bodyweight_squat" in prompt


def test_build_ai_system_prompt_excludes_specialty_bar_exercise_without_that_specific_bar():
    # A checked Olympic Barbell unlocks the broad "barbell" category, but
    # Trap Bar Deadlift needs an actual trap bar -- requires_equipment_id
    # should gate it even though its equipment tag matches.
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan", gym_profile_id="g1")
    gym = GymProfile(id="g1", name="Home Gym", equipment={"olympic_barbell": [45.0]})
    library = [
        {
            "id": "barbell_back_squat",
            "name": "Barbell Back Squat",
            "category": "squat",
            "equipment": "barbell",
        },
        {
            "id": "trap_bar_deadlift",
            "name": "Trap Bar Deadlift",
            "category": "hinge",
            "equipment": "barbell",
            "requires_equipment_id": "trap_bar",
        },
    ]
    prompt = logic.build_ai_system_prompt(profile, library, gym_profiles=[gym])
    assert "barbell_back_squat" in prompt
    assert "trap_bar_deadlift" not in prompt


def test_build_ai_system_prompt_includes_specialty_bar_exercise_when_that_bar_is_checked():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan", gym_profile_id="g1")
    gym = GymProfile(id="g1", name="Home Gym", equipment={"trap_bar": [55.0]})
    library = [
        {
            "id": "trap_bar_deadlift",
            "name": "Trap Bar Deadlift",
            "category": "hinge",
            "equipment": "barbell",
            "requires_equipment_id": "trap_bar",
        },
    ]
    prompt = logic.build_ai_system_prompt(profile, library, gym_profiles=[gym])
    assert "trap_bar_deadlift" in prompt


def test_build_ai_system_prompt_includes_kids_guidance():
    profile = AthleteProfile(
        id="1", ha_user_id="u1", display_name="Jamie", experience_level="kids"
    )
    prompt = logic.build_ai_system_prompt(profile, [])
    assert "kids/youth athlete" in prompt
    assert "Normal strength movements are allowed" in prompt
    assert "lighter kids defaults rather than adult starting loads" in prompt


def test_build_ai_system_prompt_allows_weighted_exercises_for_kids_with_equipment():
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jamie",
        experience_level="kids",
        gym_profile_id="g1",
    )
    gym = GymProfile(id="g1", name="Home Gym", equipment={"olympic_barbell": [45.0]})
    library = [
        {
            "id": "barbell_back_squat",
            "name": "Barbell Back Squat",
            "category": "squat",
            "equipment": "barbell",
        },
        {
            "id": "bodyweight_squat",
            "name": "Bodyweight Squat",
            "category": "squat",
            "equipment": "bodyweight",
        },
    ]
    prompt = logic.build_ai_system_prompt(profile, library, gym_profiles=[gym])
    assert "barbell_back_squat" in prompt
    assert "bodyweight_squat" in prompt


def test_build_strength_summary_includes_last_set_effort_and_pr():
    profile = AthleteProfile(
        id="p1",
        ha_user_id="u1",
        display_name="Jordan",
        personal_records={"barbell_back_squat": 157.5},
    )
    workout = Workout(
        id="w1",
        profile_id="p1",
        name="Leg Day",
        status="completed",
        exercises=[
            WorkoutExercise(
                exercise_id="barbell_back_squat",
                sets=[
                    WorkoutSet(actual_reps=5, actual_weight=135.0, completed=True),
                    WorkoutSet(actual_reps=5, actual_weight=140.0, completed=True),
                ],
                effort="moderate",
            )
        ],
    )
    summary = logic.build_strength_summary(profile, [workout])
    assert "barbell_back_squat" in summary
    assert "5 reps @ 140.0" in summary
    assert "felt moderate" in summary
    assert "est. 1RM 157.5" in summary


def test_build_strength_summary_empty_when_nothing_logged():
    profile = AthleteProfile(id="p1", ha_user_id="u1", display_name="Jordan")
    assert logic.build_strength_summary(profile, []) == ""


def test_build_strength_summary_ignores_other_athletes_workouts():
    profile = AthleteProfile(id="p1", ha_user_id="u1", display_name="Jordan")
    other_workout = Workout(
        id="w1",
        profile_id="someone-else",
        name="Leg Day",
        status="completed",
        exercises=[
            WorkoutExercise(
                exercise_id="barbell_back_squat",
                sets=[WorkoutSet(actual_reps=5, actual_weight=135.0, completed=True)],
                effort="hard",
            )
        ],
    )
    assert logic.build_strength_summary(profile, [other_workout]) == ""


def test_build_ai_system_prompt_includes_plate_loaded_cable_setup():
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        gym_profile_id="g1",
    )
    gym = GymProfile(
        id="g1",
        name="Home Gym",
        equipment={"cable_tower": [None]},
        equipment_config={
            "cable_tower": {
                "load_type": "plate_loaded",
                "pulley_ratio": 2.0,
            }
        },
    )
    prompt = logic.build_ai_system_prompt(profile, [], gym_profiles=[gym])
    assert "Cable Tower: plate loaded" in prompt
    assert "pulley ratio 2.0:1" in prompt
    assert "selectorized stack" in prompt


def test_build_ai_system_prompt_includes_configured_bar_weights():
    profile = AthleteProfile(
        id="1",
        ha_user_id="u1",
        display_name="Jordan",
        gym_profile_id="g1",
    )
    gym = GymProfile(
        id="g1",
        name="Home Gym",
        equipment={
            "olympic_barbell": [45.0],
            "short_bar": [20.0, 5.0],
        },
    )
    prompt = logic.build_ai_system_prompt(profile, [], gym_profiles=[gym])
    assert "Olympic Barbell: 45 lb" in prompt
    assert "Short Bar: 5 lb, 20 lb" in prompt
    assert "TOTAL lifted weight including the bar" in prompt
    assert "Never prescribe a total below" in prompt


def test_build_ai_system_prompt_requires_specific_weights():
    profile = AthleteProfile(id="1", ha_user_id="u1", display_name="Jordan")
    prompt = logic.build_ai_system_prompt(profile, [])
    assert "never null" in prompt


def test_build_ai_system_prompt_includes_strength_summary():
    profile = AthleteProfile(id="p1", ha_user_id="u1", display_name="Jordan")
    workout = Workout(
        id="w1",
        profile_id="p1",
        name="Leg Day",
        status="completed",
        exercises=[
            WorkoutExercise(
                exercise_id="barbell_back_squat",
                sets=[WorkoutSet(actual_reps=5, actual_weight=135.0, completed=True)],
                effort="easy",
            )
        ],
    )
    prompt = logic.build_ai_system_prompt(profile, [], [workout])
    assert "felt easy" in prompt
    assert "Known strength" in prompt


def test_linked_profile_summaries_returns_display_names():
    jordan = AthleteProfile(
        id="p1", ha_user_id="u1", display_name="Jordan", linked_profile_ids=["p2"]
    )
    jamie = AthleteProfile(id="p2", ha_user_id="u2", display_name="Jamie")
    result = logic.linked_profile_summaries(jordan, [jordan, jamie])
    assert result == [{"profile_id": "p2", "display_name": "Jamie"}]


def test_linked_profile_summaries_drops_stale_ids():
    jordan = AthleteProfile(
        id="p1", ha_user_id="u1", display_name="Jordan", linked_profile_ids=["deleted-id"]
    )
    assert logic.linked_profile_summaries(jordan, [jordan]) == []


def test_linkable_profile_summaries_excludes_self_and_already_linked():
    jordan = AthleteProfile(
        id="p1", ha_user_id="u1", display_name="Jordan", linked_profile_ids=["p2"]
    )
    jamie = AthleteProfile(id="p2", ha_user_id="u2", display_name="Jamie")
    alex = AthleteProfile(id="p3", ha_user_id="u3", display_name="Alex")
    result = logic.linkable_profile_summaries(jordan, [jordan, jamie, alex])
    assert result == [{"profile_id": "p3", "display_name": "Alex"}]


def test_profile_extra_attributes_includes_linked_and_linkable_profiles():
    jordan = AthleteProfile(
        id="p1", ha_user_id="u1", display_name="Jordan", linked_profile_ids=["p2"]
    )
    jamie = AthleteProfile(id="p2", ha_user_id="u2", display_name="Jamie")
    alex = AthleteProfile(id="p3", ha_user_id="u3", display_name="Alex")
    attrs = logic.profile_extra_attributes(jordan, [], [], [jordan, jamie, alex])
    assert attrs["linked_profiles"] == [{"profile_id": "p2", "display_name": "Jamie"}]
    assert attrs["linkable_profiles"] == [{"profile_id": "p3", "display_name": "Alex"}]


def test_estimate_exercise_count_scales_with_duration():
    short_low, short_high = logic._estimate_exercise_count(20)
    long_low, long_high = logic._estimate_exercise_count(90)
    assert short_low < long_low
    assert short_high < long_high


def test_estimate_exercise_count_defaults_when_unset():
    low, high = logic._estimate_exercise_count(None)
    assert low >= 3
    assert high > low
