"""Static seed exercise library for Phase 2 (Strength MVP).

Not user-editable yet and not stored in GainsStore -- it's a fixed lookup
table shipped with the integration, mirrored by hand in ha-gains-frontend's
types.ts (same convention as UNITS/EXPERIENCE_LEVELS/ACTIVITY_LEVELS being
duplicated rather than fetched, since there's no shared schema between the
two repos). A later phase can move this into storage with admin editing;
until then gains.create_workout validates exercise_id against this list.

`equipment` is a single primary-equipment tag (not a full equipment list)
used to power the frontend's exercise-picker equipment filter alongside
`category`, which doubles as a rough muscle-group filter until a real
per-exercise muscle taxonomy exists.

`requires_equipment_id` is an optional, more specific gate on top of
`equipment`, only present on the handful of exercises named after a
specific piece of gear rather than the broad category it belongs to (e.g.
Trap Bar Deadlift needs an actual trap bar, not just "some barbell") --
see logic.build_ai_system_prompt for how it narrows the AI Coach's
usable-exercise filtering beyond the coarse equipment_category match.

`is_timed` marks an isometric hold (Plank, Wall Sit, ...) whose sets are
logged as seconds held rather than reps -- WorkoutSet.planned_reps/
actual_reps still hold the raw number (a duration in seconds) since
adding a parallel duration field to every set would be a bigger model
change than this handful of exercises justifies; `is_timed` just tells
the frontend to label/pick that number as a time instead of a rep count.
Omitted (falsy) for every normal rep-based exercise.
"""

from __future__ import annotations

from typing import Any

from .muscles import MUSCLES_BY_EXERCISE

EXERCISE_LIBRARY: list[dict[str, Any]] = [
    # -- squat --
    {
        "id": "barbell_back_squat",
        "name": "Barbell Back Squat",
        "category": "squat",
        "equipment": "barbell",
    },
    {
        "id": "barbell_front_squat",
        "name": "Barbell Front Squat",
        "category": "squat",
        "equipment": "barbell",
    },
    {"id": "goblet_squat", "name": "Goblet Squat", "category": "squat", "equipment": "dumbbell"},
    {
        "id": "bodyweight_squat",
        "name": "Bodyweight Squat",
        "category": "squat",
        "equipment": "bodyweight",
    },
    {"id": "box_squat", "name": "Box Squat", "category": "squat", "equipment": "barbell"},
    {
        "id": "safety_bar_squat",
        "name": "Safety Bar Squat",
        "category": "squat",
        "equipment": "barbell",
        "requires_equipment_id": "safety_squat_bar",
    },
    {"id": "zercher_squat", "name": "Zercher Squat", "category": "squat", "equipment": "barbell"},
    {
        "id": "overhead_squat",
        "name": "Overhead Squat",
        "category": "squat",
        "equipment": "barbell",
    },
    {
        "id": "hack_squat",
        "name": "Hack Squat (Machine)",
        "category": "squat",
        "equipment": "machine",
    },
    {"id": "leg_press", "name": "Leg Press", "category": "squat", "equipment": "machine"},
    {
        "id": "smith_machine_squat",
        "name": "Smith Machine Squat",
        "category": "squat",
        "equipment": "machine",
    },
    {"id": "sumo_squat", "name": "Sumo Squat", "category": "squat", "equipment": "barbell"},
    {
        "id": "landmine_squat",
        "name": "Landmine Squat",
        "category": "squat",
        "equipment": "barbell",
        "requires_equipment_id": "landmine",
    },
    {"id": "jump_squat", "name": "Jump Squat", "category": "squat", "equipment": "bodyweight"},
    {
        "id": "wall_sit",
        "name": "Wall Sit",
        "category": "squat",
        "equipment": "bodyweight",
        "is_timed": True,
    },
    {"id": "spanish_squat", "name": "Spanish Squat", "category": "squat", "equipment": "bands"},
    {"id": "pin_squat", "name": "Pin Squat", "category": "squat", "equipment": "barbell"},
    # -- hinge --
    {
        "id": "barbell_deadlift",
        "name": "Barbell Deadlift",
        "category": "hinge",
        "equipment": "barbell",
    },
    {
        "id": "romanian_deadlift",
        "name": "Romanian Deadlift",
        "category": "hinge",
        "equipment": "barbell",
    },
    {
        "id": "sumo_deadlift",
        "name": "Sumo Deadlift",
        "category": "hinge",
        "equipment": "barbell",
    },
    {
        "id": "deficit_deadlift",
        "name": "Deficit Deadlift",
        "category": "hinge",
        "equipment": "barbell",
    },
    {
        "id": "stiff_leg_deadlift",
        "name": "Stiff-Leg Deadlift",
        "category": "hinge",
        "equipment": "barbell",
    },
    {
        "id": "trap_bar_deadlift",
        "name": "Trap Bar Deadlift",
        "category": "hinge",
        "equipment": "barbell",
        "requires_equipment_id": "trap_bar",
    },
    {
        "id": "single_leg_rdl",
        "name": "Single-Leg Romanian Deadlift",
        "category": "hinge",
        "equipment": "dumbbell",
    },
    {"id": "good_morning", "name": "Good Morning", "category": "hinge", "equipment": "barbell"},
    {
        "id": "kettlebell_swing",
        "name": "Kettlebell Swing",
        "category": "hinge",
        "equipment": "kettlebell",
    },
    {
        "id": "hip_thrust",
        "name": "Barbell Hip Thrust",
        "category": "hinge",
        "equipment": "barbell",
    },
    {"id": "glute_bridge", "name": "Glute Bridge", "category": "hinge", "equipment": "bodyweight"},
    {"id": "back_extension", "name": "Back Extension", "category": "hinge", "equipment": "machine"},
    {
        "id": "cable_pull_through",
        "name": "Cable Pull-Through",
        "category": "hinge",
        "equipment": "cable",
    },
    {
        "id": "snatch_grip_deadlift",
        "name": "Snatch-Grip Deadlift",
        "category": "hinge",
        "equipment": "barbell",
    },
    {"id": "rack_pull", "name": "Rack Pull", "category": "hinge", "equipment": "barbell"},
    # -- push --
    {
        "id": "barbell_bench_press",
        "name": "Barbell Bench Press",
        "category": "push",
        "equipment": "barbell",
    },
    {
        "id": "dumbbell_bench_press",
        "name": "Dumbbell Bench Press",
        "category": "push",
        "equipment": "dumbbell",
    },
    {
        "id": "incline_barbell_bench_press",
        "name": "Incline Barbell Bench Press",
        "category": "push",
        "equipment": "barbell",
    },
    {
        "id": "incline_dumbbell_bench_press",
        "name": "Incline Dumbbell Bench Press",
        "category": "push",
        "equipment": "dumbbell",
    },
    {
        "id": "decline_bench_press",
        "name": "Decline Bench Press",
        "category": "push",
        "equipment": "barbell",
    },
    {
        "id": "close_grip_bench_press",
        "name": "Close-Grip Bench Press",
        "category": "push",
        "equipment": "barbell",
    },
    {"id": "floor_press", "name": "Floor Press", "category": "push", "equipment": "barbell"},
    {"id": "push_up", "name": "Push-Up", "category": "push", "equipment": "bodyweight"},
    {
        "id": "incline_push_up",
        "name": "Incline Push-Up",
        "category": "push",
        "equipment": "bodyweight",
    },
    {
        "id": "decline_push_up",
        "name": "Decline Push-Up",
        "category": "push",
        "equipment": "bodyweight",
    },
    {
        "id": "diamond_push_up",
        "name": "Diamond Push-Up",
        "category": "push",
        "equipment": "bodyweight",
    },
    {"id": "wide_push_up", "name": "Wide Push-Up", "category": "push", "equipment": "bodyweight"},
    {
        "id": "archer_push_up",
        "name": "Archer Push-Up",
        "category": "push",
        "equipment": "bodyweight",
    },
    {"id": "plyo_push_up", "name": "Plyo Push-Up", "category": "push", "equipment": "bodyweight"},
    {"id": "dumbbell_fly", "name": "Dumbbell Fly", "category": "push", "equipment": "dumbbell"},
    {"id": "cable_fly", "name": "Cable Fly", "category": "push", "equipment": "cable"},
    {"id": "pec_deck", "name": "Pec Deck", "category": "push", "equipment": "machine"},
    {
        "id": "overhead_press",
        "name": "Barbell Overhead Press",
        "category": "push",
        "equipment": "barbell",
    },
    {
        "id": "dumbbell_shoulder_press",
        "name": "Dumbbell Shoulder Press",
        "category": "push",
        "equipment": "dumbbell",
    },
    {"id": "push_press", "name": "Push Press", "category": "push", "equipment": "barbell"},
    {"id": "arnold_press", "name": "Arnold Press", "category": "push", "equipment": "dumbbell"},
    {
        "id": "landmine_press",
        "name": "Landmine Press",
        "category": "push",
        "equipment": "barbell",
        "requires_equipment_id": "landmine",
    },
    {"id": "pike_push_up", "name": "Pike Push-Up", "category": "push", "equipment": "bodyweight"},
    {
        "id": "handstand_push_up",
        "name": "Handstand Push-Up",
        "category": "push",
        "equipment": "bodyweight",
    },
    {
        "id": "seated_dumbbell_press",
        "name": "Seated Dumbbell Press",
        "category": "push",
        "equipment": "dumbbell",
    },
    # -- pull --
    {"id": "barbell_row", "name": "Barbell Row", "category": "pull", "equipment": "barbell"},
    {"id": "pendlay_row", "name": "Pendlay Row", "category": "pull", "equipment": "barbell"},
    {"id": "dumbbell_row", "name": "Dumbbell Row", "category": "pull", "equipment": "dumbbell"},
    {"id": "cable_row", "name": "Seated Cable Row", "category": "pull", "equipment": "cable"},
    {
        "id": "chest_supported_row",
        "name": "Chest-Supported Row",
        "category": "pull",
        "equipment": "dumbbell",
    },
    {"id": "t_bar_row", "name": "T-Bar Row", "category": "pull", "equipment": "machine"},
    {"id": "meadows_row", "name": "Meadows Row", "category": "pull", "equipment": "barbell"},
    {
        "id": "inverted_row",
        "name": "Inverted Row",
        "category": "pull",
        "equipment": "bodyweight",
    },
    {"id": "pull_up", "name": "Pull-Up", "category": "pull", "equipment": "bodyweight"},
    {"id": "chin_up", "name": "Chin-Up", "category": "pull", "equipment": "bodyweight"},
    {
        "id": "weighted_pull_up",
        "name": "Weighted Pull-Up",
        "category": "pull",
        "equipment": "bodyweight",
    },
    {
        "id": "neutral_grip_pull_up",
        "name": "Neutral-Grip Pull-Up",
        "category": "pull",
        "equipment": "bodyweight",
    },
    {
        "id": "assisted_pull_up",
        "name": "Assisted Pull-Up",
        "category": "pull",
        "equipment": "machine",
    },
    {"id": "lat_pulldown", "name": "Lat Pulldown", "category": "pull", "equipment": "cable"},
    {
        "id": "close_grip_lat_pulldown",
        "name": "Close-Grip Lat Pulldown",
        "category": "pull",
        "equipment": "cable",
    },
    {
        "id": "straight_arm_pulldown",
        "name": "Straight-Arm Pulldown",
        "category": "pull",
        "equipment": "cable",
    },
    {"id": "face_pull", "name": "Face Pull", "category": "pull", "equipment": "cable"},
    # -- single_leg --
    {
        "id": "walking_lunge",
        "name": "Walking Lunge",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {
        "id": "reverse_lunge",
        "name": "Reverse Lunge",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {
        "id": "forward_lunge",
        "name": "Forward Lunge",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {
        "id": "lateral_lunge",
        "name": "Lateral Lunge",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {
        "id": "curtsy_lunge",
        "name": "Curtsy Lunge",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {
        "id": "bulgarian_split_squat",
        "name": "Bulgarian Split Squat",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {"id": "step_up", "name": "Step-Up", "category": "single_leg", "equipment": "dumbbell"},
    {
        "id": "pistol_squat",
        "name": "Pistol Squat",
        "category": "single_leg",
        "equipment": "bodyweight",
    },
    {
        "id": "skater_squat",
        "name": "Skater Squat",
        "category": "single_leg",
        "equipment": "bodyweight",
    },
    {
        "id": "single_leg_press",
        "name": "Single-Leg Press",
        "category": "single_leg",
        "equipment": "machine",
    },
    # -- core --
    {
        "id": "plank",
        "name": "Plank",
        "category": "core",
        "equipment": "bodyweight",
        "is_timed": True,
    },
    {
        "id": "side_plank",
        "name": "Side Plank",
        "category": "core",
        "equipment": "bodyweight",
        "is_timed": True,
    },
    {
        "id": "hanging_leg_raise",
        "name": "Hanging Leg Raise",
        "category": "core",
        "equipment": "bodyweight",
    },
    {
        "id": "hanging_knee_raise",
        "name": "Hanging Knee Raise",
        "category": "core",
        "equipment": "bodyweight",
    },
    {
        "id": "ab_wheel_rollout",
        "name": "Ab Wheel Rollout",
        "category": "core",
        "equipment": "other",
    },
    {"id": "cable_crunch", "name": "Cable Crunch", "category": "core", "equipment": "cable"},
    {"id": "sit_up", "name": "Sit-Up", "category": "core", "equipment": "bodyweight"},
    {
        "id": "weighted_situp",
        "name": "Weighted Sit-Up",
        "category": "core",
        "equipment": "dumbbell",
    },
    {"id": "russian_twist", "name": "Russian Twist", "category": "core", "equipment": "bodyweight"},
    {
        "id": "hollow_hold",
        "name": "Hollow Hold",
        "category": "core",
        "equipment": "bodyweight",
        "is_timed": True,
    },
    {"id": "dead_bug", "name": "Dead Bug", "category": "core", "equipment": "bodyweight"},
    {"id": "bird_dog", "name": "Bird Dog", "category": "core", "equipment": "bodyweight"},
    {
        "id": "mountain_climber",
        "name": "Mountain Climber",
        "category": "core",
        "equipment": "bodyweight",
    },
    {"id": "v_up", "name": "V-Up", "category": "core", "equipment": "bodyweight"},
    {"id": "dragon_flag", "name": "Dragon Flag", "category": "core", "equipment": "bodyweight"},
    {"id": "pallof_press", "name": "Pallof Press", "category": "core", "equipment": "cable"},
    # -- carry --
    {"id": "farmers_carry", "name": "Farmer's Carry", "category": "carry", "equipment": "dumbbell"},
    {
        "id": "suitcase_carry",
        "name": "Suitcase Carry",
        "category": "carry",
        "equipment": "dumbbell",
    },
    {
        "id": "overhead_carry",
        "name": "Overhead Carry",
        "category": "carry",
        "equipment": "dumbbell",
    },
    {
        "id": "front_rack_carry",
        "name": "Front-Rack Carry",
        "category": "carry",
        "equipment": "kettlebell",
    },
    {"id": "yoke_walk", "name": "Yoke Walk", "category": "carry", "equipment": "other"},
    # -- olympic --
    {"id": "power_clean", "name": "Power Clean", "category": "olympic", "equipment": "barbell"},
    {"id": "hang_clean", "name": "Hang Clean", "category": "olympic", "equipment": "barbell"},
    {"id": "clean", "name": "Clean", "category": "olympic", "equipment": "barbell"},
    {
        "id": "power_snatch",
        "name": "Power Snatch",
        "category": "olympic",
        "equipment": "barbell",
    },
    {"id": "hang_snatch", "name": "Hang Snatch", "category": "olympic", "equipment": "barbell"},
    {"id": "snatch", "name": "Snatch", "category": "olympic", "equipment": "barbell"},
    {
        "id": "clean_and_jerk",
        "name": "Clean and Jerk",
        "category": "olympic",
        "equipment": "barbell",
    },
    {"id": "high_pull", "name": "High Pull", "category": "olympic", "equipment": "barbell"},
    # -- arms --
    {"id": "barbell_curl", "name": "Barbell Curl", "category": "arms", "equipment": "barbell"},
    {"id": "dumbbell_curl", "name": "Dumbbell Curl", "category": "arms", "equipment": "dumbbell"},
    {"id": "hammer_curl", "name": "Hammer Curl", "category": "arms", "equipment": "dumbbell"},
    {"id": "preacher_curl", "name": "Preacher Curl", "category": "arms", "equipment": "barbell"},
    {
        "id": "concentration_curl",
        "name": "Concentration Curl",
        "category": "arms",
        "equipment": "dumbbell",
    },
    {"id": "cable_curl", "name": "Cable Curl", "category": "arms", "equipment": "cable"},
    {
        "id": "overhead_tricep_extension",
        "name": "Overhead Tricep Extension",
        "category": "arms",
        "equipment": "dumbbell",
    },
    {"id": "skull_crusher", "name": "Skull Crusher", "category": "arms", "equipment": "barbell"},
    {"id": "tricep_pushdown", "name": "Tricep Pushdown", "category": "arms", "equipment": "cable"},
    {
        "id": "tricep_kickback",
        "name": "Tricep Kickback",
        "category": "arms",
        "equipment": "dumbbell",
    },
    {
        "id": "close_grip_pushup",
        "name": "Close-Grip Push-Up",
        "category": "arms",
        "equipment": "bodyweight",
    },
    {"id": "dip", "name": "Dip (Triceps)", "category": "arms", "equipment": "bodyweight"},
    # -- shoulders --
    {
        "id": "lateral_raise",
        "name": "Lateral Raise",
        "category": "shoulders",
        "equipment": "dumbbell",
    },
    {"id": "front_raise", "name": "Front Raise", "category": "shoulders", "equipment": "dumbbell"},
    {
        "id": "rear_delt_fly",
        "name": "Rear Delt Fly",
        "category": "shoulders",
        "equipment": "dumbbell",
    },
    {"id": "upright_row", "name": "Upright Row", "category": "shoulders", "equipment": "barbell"},
    {
        "id": "barbell_shrug",
        "name": "Barbell Shrug",
        "category": "shoulders",
        "equipment": "barbell",
    },
    {
        "id": "dumbbell_shrug",
        "name": "Dumbbell Shrug",
        "category": "shoulders",
        "equipment": "dumbbell",
    },
    {
        "id": "cable_lateral_raise",
        "name": "Cable Lateral Raise",
        "category": "shoulders",
        "equipment": "cable",
    },
    # -- legs (isolation) --
    {"id": "leg_extension", "name": "Leg Extension", "category": "legs", "equipment": "machine"},
    {
        "id": "seated_leg_curl",
        "name": "Seated Leg Curl",
        "category": "legs",
        "equipment": "machine",
    },
    {"id": "lying_leg_curl", "name": "Lying Leg Curl", "category": "legs", "equipment": "machine"},
    {
        "id": "standing_calf_raise",
        "name": "Standing Calf Raise",
        "category": "legs",
        "equipment": "machine",
    },
    {
        "id": "seated_calf_raise",
        "name": "Seated Calf Raise",
        "category": "legs",
        "equipment": "machine",
    },
    {
        "id": "hip_abduction_machine",
        "name": "Hip Abduction Machine",
        "category": "legs",
        "equipment": "machine",
    },
    {
        "id": "hip_adduction_machine",
        "name": "Hip Adduction Machine",
        "category": "legs",
        "equipment": "machine",
    },
    {"id": "glute_kickback", "name": "Glute Kickback", "category": "legs", "equipment": "cable"},
    # -- conditioning --
    {"id": "burpee", "name": "Burpee", "category": "conditioning", "equipment": "bodyweight"},
    {"id": "box_jump", "name": "Box Jump", "category": "conditioning", "equipment": "box"},
    {
        "id": "battle_ropes",
        "name": "Battle Ropes",
        "category": "conditioning",
        "equipment": "other",
    },
    {"id": "sled_push", "name": "Sled Push", "category": "conditioning", "equipment": "other"},
    {"id": "sled_pull", "name": "Sled Pull", "category": "conditioning", "equipment": "other"},
    {
        "id": "assault_bike",
        "name": "Assault Bike",
        "category": "conditioning",
        "equipment": "machine",
    },
    {"id": "jump_rope", "name": "Jump Rope", "category": "conditioning", "equipment": "other"},
    {
        "id": "rowing_machine",
        "name": "Rowing Machine (Erg)",
        "category": "conditioning",
        "equipment": "machine",
    },
    # -- mobility --
    {"id": "cat_cow", "name": "Cat-Cow", "category": "mobility", "equipment": "bodyweight"},
    {
        "id": "worlds_greatest_stretch",
        "name": "World's Greatest Stretch",
        "category": "mobility",
        "equipment": "bodyweight",
    },
    {"id": "hip_circles", "name": "Hip Circles", "category": "mobility", "equipment": "bodyweight"},
    {"id": "arm_circles", "name": "Arm Circles", "category": "mobility", "equipment": "bodyweight"},
    {
        "id": "band_pull_apart",
        "name": "Band Pull-Apart",
        "category": "mobility",
        "equipment": "bands",
    },
    {
        "id": "thoracic_rotation",
        "name": "Thoracic Rotation",
        "category": "mobility",
        "equipment": "bodyweight",
    },
    {
        "id": "couch_stretch",
        "name": "Couch Stretch",
        "category": "mobility",
        "equipment": "bodyweight",
    },
    # -- extended curated library --
    {
        "id": "smith_machine_incline_press",
        "name": "Smith Machine Incline Press",
        "category": "push",
        "equipment": "machine",
        "requires_equipment_id": "smith_machine",
    },
    {
        "id": "smith_machine_flat_press",
        "name": "Smith Machine Bench Press",
        "category": "push",
        "equipment": "machine",
        "requires_equipment_id": "smith_machine",
    },
    {
        "id": "incline_machine_chest_press",
        "name": "Incline Chest Press Machine",
        "category": "push",
        "equipment": "machine",
        "requires_equipment_id": "incline_chest_press_machine",
    },
    {
        "id": "decline_machine_chest_press",
        "name": "Decline Chest Press Machine",
        "category": "push",
        "equipment": "machine",
        "requires_equipment_id": "decline_chest_press_machine",
    },
    {
        "id": "single_arm_cable_chest_press",
        "name": "Single-Arm Cable Chest Press",
        "category": "push",
        "equipment": "cable",
    },
    {
        "id": "standing_cable_chest_press",
        "name": "Standing Cable Chest Press",
        "category": "push",
        "equipment": "cable",
    },
    {
        "id": "low_to_high_cable_fly",
        "name": "Low-to-High Cable Fly",
        "category": "push",
        "equipment": "cable",
    },
    {
        "id": "high_to_low_cable_fly",
        "name": "High-to-Low Cable Fly",
        "category": "push",
        "equipment": "cable",
    },
    {
        "id": "dumbbell_squeeze_press",
        "name": "Dumbbell Squeeze Press",
        "category": "push",
        "equipment": "dumbbell",
    },
    {
        "id": "single_arm_dumbbell_floor_press",
        "name": "Single-Arm Dumbbell Floor Press",
        "category": "push",
        "equipment": "dumbbell",
    },
    {
        "id": "kneeling_single_arm_lat_pulldown",
        "name": "Kneeling Single-Arm Lat Pulldown",
        "category": "pull",
        "equipment": "cable",
    },
    {
        "id": "neutral_grip_lat_pulldown",
        "name": "Neutral-Grip Lat Pulldown",
        "category": "pull",
        "equipment": "cable",
    },
    {
        "id": "underhand_lat_pulldown",
        "name": "Underhand Lat Pulldown",
        "category": "pull",
        "equipment": "cable",
    },
    {
        "id": "wide_grip_cable_row",
        "name": "Wide-Grip Seated Cable Row",
        "category": "pull",
        "equipment": "cable",
    },
    {
        "id": "single_arm_cable_row",
        "name": "Single-Arm Cable Row",
        "category": "pull",
        "equipment": "cable",
    },
    {
        "id": "chest_supported_t_bar_row",
        "name": "Chest-Supported T-Bar Row",
        "category": "pull",
        "equipment": "machine",
        "requires_equipment_id": "plate_loaded_chest_supported_t_bar",
    },
    {
        "id": "iso_lateral_machine_row",
        "name": "Iso-Lateral Machine Row",
        "category": "pull",
        "equipment": "machine",
    },
    {
        "id": "dumbbell_meadows_row",
        "name": "Meadows-Style Dumbbell Row",
        "category": "pull",
        "equipment": "dumbbell",
    },
    {
        "id": "reverse_grip_barbell_row",
        "name": "Reverse-Grip Barbell Row",
        "category": "pull",
        "equipment": "barbell",
    },
    {
        "id": "incline_dumbbell_row",
        "name": "Incline Bench Dumbbell Row",
        "category": "pull",
        "equipment": "dumbbell",
    },
    {
        "id": "smith_machine_split_squat",
        "name": "Smith Machine Split Squat",
        "category": "single_leg",
        "equipment": "machine",
        "requires_equipment_id": "smith_machine",
    },
    {
        "id": "rear_foot_elevated_split_squat",
        "name": "Rear-Foot-Elevated Split Squat",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {
        "id": "dumbbell_step_down",
        "name": "Dumbbell Step-Down",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {
        "id": "lateral_lunge_dumbbell",
        "name": "Dumbbell Lateral Lunge",
        "category": "single_leg",
        "equipment": "dumbbell",
    },
    {
        "id": "walking_barbell_lunge",
        "name": "Barbell Walking Lunge",
        "category": "single_leg",
        "equipment": "barbell",
    },
    {
        "id": "reverse_hack_squat",
        "name": "Reverse Hack Squat",
        "category": "squat",
        "equipment": "machine",
        "requires_equipment_id": "hack_squat_machine",
    },
    {
        "id": "heel_elevated_goblet_squat",
        "name": "Heel-Elevated Goblet Squat",
        "category": "squat",
        "equipment": "dumbbell",
    },
    {
        "id": "cyclist_squat",
        "name": "Cyclist Squat",
        "category": "squat",
        "equipment": "bodyweight",
    },
    {
        "id": "dumbbell_sumo_squat",
        "name": "Dumbbell Sumo Squat",
        "category": "squat",
        "equipment": "dumbbell",
    },
    {
        "id": "single_leg_leg_press",
        "name": "Single-Leg Leg Press",
        "category": "legs",
        "equipment": "machine",
        "requires_equipment_id": "leg_press_machine",
    },
    {
        "id": "single_leg_leg_extension",
        "name": "Single-Leg Leg Extension",
        "category": "legs",
        "equipment": "machine",
        "requires_equipment_id": "leg_extension_machine",
    },
    {
        "id": "single_leg_seated_leg_curl",
        "name": "Single-Leg Seated Leg Curl",
        "category": "legs",
        "equipment": "machine",
        "requires_equipment_id": "leg_curl_machine",
    },
    {
        "id": "single_leg_lying_leg_curl",
        "name": "Single-Leg Lying Leg Curl",
        "category": "legs",
        "equipment": "machine",
        "requires_equipment_id": "leg_curl_machine",
    },
    {
        "id": "dumbbell_staggered_stance_rdl",
        "name": "Staggered-Stance Dumbbell RDL",
        "category": "hinge",
        "equipment": "dumbbell",
    },
    {
        "id": "single_leg_dumbbell_rdl",
        "name": "Single-Leg Dumbbell Romanian Deadlift",
        "category": "hinge",
        "equipment": "dumbbell",
    },
    {
        "id": "smith_machine_romanian_deadlift",
        "name": "Smith Machine Romanian Deadlift",
        "category": "hinge",
        "equipment": "machine",
        "requires_equipment_id": "smith_machine",
    },
    {
        "id": "barbell_good_morning_seated",
        "name": "Seated Barbell Good Morning",
        "category": "hinge",
        "equipment": "barbell",
    },
    {
        "id": "machine_lateral_raise",
        "name": "Lateral Raise Machine",
        "category": "shoulders",
        "equipment": "machine",
    },
    {
        "id": "leaning_cable_lateral_raise",
        "name": "Leaning Cable Lateral Raise",
        "category": "shoulders",
        "equipment": "cable",
    },
    {
        "id": "single_arm_cable_rear_delt_fly",
        "name": "Single-Arm Cable Rear Delt Fly",
        "category": "shoulders",
        "equipment": "cable",
    },
    {
        "id": "incline_dumbbell_rear_delt_raise",
        "name": "Incline Dumbbell Rear Delt Raise",
        "category": "shoulders",
        "equipment": "dumbbell",
    },
    {
        "id": "single_arm_landmine_press",
        "name": "Single-Arm Landmine Press",
        "category": "shoulders",
        "equipment": "barbell",
    },
    {
        "id": "bayesian_cable_curl",
        "name": "Bayesian Cable Curl",
        "category": "arms",
        "equipment": "cable",
    },
    {
        "id": "cross_body_hammer_curl",
        "name": "Cross-Body Hammer Curl",
        "category": "arms",
        "equipment": "dumbbell",
    },
    {
        "id": "machine_preacher_curl",
        "name": "Machine Preacher Curl",
        "category": "arms",
        "equipment": "machine",
        "requires_equipment_id": "preacher_curl_machine",
    },
    {
        "id": "single_arm_cable_triceps_extension",
        "name": "Single-Arm Cable Triceps Extension",
        "category": "arms",
        "equipment": "cable",
    },
    {
        "id": "cross_body_cable_triceps_extension",
        "name": "Cross-Body Cable Triceps Extension",
        "category": "arms",
        "equipment": "cable",
    },
    {
        "id": "dumbbell_tate_press",
        "name": "Dumbbell Tate Press",
        "category": "arms",
        "equipment": "dumbbell",
    },
    {
        "id": "weighted_dead_bug",
        "name": "Weighted Dead Bug",
        "category": "core",
        "equipment": "dumbbell",
    },
    {
        "id": "cable_pallof_press",
        "name": "Cable Pallof Press",
        "category": "core",
        "equipment": "cable",
    },
    {
        "id": "kneeling_cable_crunch",
        "name": "Kneeling Cable Crunch",
        "category": "core",
        "equipment": "cable",
    },
    {
        "id": "hollow_body_rock",
        "name": "Hollow-Body Rock",
        "category": "core",
        "equipment": "bodyweight",
    },
    {
        "id": "dumbbell_suitcase_carry",
        "name": "Dumbbell Suitcase Carry",
        "category": "carry",
        "equipment": "dumbbell",
    },
    {
        "id": "single_arm_overhead_carry",
        "name": "Single-Arm Dumbbell Overhead Carry",
        "category": "carry",
        "equipment": "dumbbell",
    },
]

# Additive, presentation-only anatomy metadata. Existing exercise IDs and
# service validation remain unchanged; older clients ignore this field.

for _exercise in EXERCISE_LIBRARY:
    if _exercise["id"] in MUSCLES_BY_EXERCISE:
        _exercise["muscles"] = MUSCLES_BY_EXERCISE[_exercise["id"]]

EXERCISE_IDS: frozenset[str] = frozenset(e["id"] for e in EXERCISE_LIBRARY)


def get_exercise(exercise_id: str) -> dict[str, Any] | None:
    for exercise in EXERCISE_LIBRARY:
        if exercise["id"] == exercise_id:
            return exercise
    return None

