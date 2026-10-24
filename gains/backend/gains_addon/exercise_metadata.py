"""Small independently reviewed planning pool. The full manual catalog is unchanged."""
from __future__ import annotations

METADATA_VERSION = 1
MOVEMENTS = {
    "horizontal_press": (
        "barbell_bench_press",
        "dumbbell_bench_press",
        "incline_barbell_bench_press",
        "incline_dumbbell_bench_press",
        "floor_press",
        "single_arm_dumbbell_floor_press",
        "push_up",
        "close_grip_pushup",
    ),
    "chest_isolation": (
        "cable_fly",
        "high_to_low_cable_fly",
        "low_to_high_cable_fly",
        "dumbbell_fly",
    ),
    "horizontal_pull": (
        "barbell_row",
        "dumbbell_row",
        "cable_row",
        "chest_supported_row",
        "inverted_row",
    ),
    "vertical_pull": (
        "pull_up",
        "chin_up",
        "lat_pulldown",
        "assisted_pull_up",
        "neutral_grip_pull_up",
    ),
    "squat": (
        "barbell_back_squat",
        "barbell_front_squat",
        "goblet_squat",
        "bodyweight_squat",
        "bulgarian_split_squat",
    ),
    "hinge": (
        "barbell_deadlift",
        "romanian_deadlift",
        "dumbbell_staggered_stance_rdl",
        "glute_bridge",
        "hip_thrust",
        "kettlebell_swing",
    ),
    "calf": ("standing_calf_raise", "seated_calf_raise"),
    "biceps": (
        "barbell_curl",
        "dumbbell_curl",
        "hammer_curl",
        "concentration_curl",
        "cable_curl",
        "bayesian_cable_curl",
    ),
    "triceps": (
        "skull_crusher",
        "overhead_tricep_extension",
        "tricep_pushdown",
        "tricep_kickback",
        "dip",
        "close_grip_pushup",
    ),
    "shoulder_press": (
        "overhead_press",
        "dumbbell_shoulder_press",
        "pike_push_up",
        "landmine_press",
    ),
    "shoulder_isolation": ("lateral_raise", "rear_delt_fly", "face_pull"),
    "grip": ("farmers_carry", "suitcase_carry"),
    "core": (
        "plank",
        "side_plank",
        "sit_up",
        "russian_twist",
        "hollow_hold",
        "dead_bug",
        "cable_crunch",
        "pallof_press",
    ),
}
METADATA = {
    exercise_id: {
        "movement": movement,
        "isolation": movement
        in {"chest_isolation", "biceps", "triceps", "calf", "shoulder_isolation"},
        "load_mode": "assistance" if exercise_id == "assisted_pull_up" else "external",
        "metadata_version": METADATA_VERSION,
    }
    for movement, ids in MOVEMENTS.items()
    for exercise_id in ids
}


for _exercise_id, _metadata in METADATA.items():
    if _exercise_id in {'dip', 'close_grip_pushup'}:
        _metadata['isolation'] = False
    _metadata['compound'] = not _metadata['isolation']
    _metadata['roles'] = ('accessory',) if _metadata['movement'] in {
        'chest_isolation', 'biceps', 'triceps', 'calf', 'shoulder_isolation', 'grip', 'core'
    } else ('main', 'accessory')


def movement_slots(focus: str) -> tuple[str, ...]:
    if focus == 'full body':
        return ('squat', 'horizontal_press', 'horizontal_pull', 'hinge')
    if focus in {'upper', 'chest/back'}:
        return ('horizontal_press', 'horizontal_pull')
    if focus in {'back', 'back/biceps', 'pull'}:
        return ('horizontal_pull', 'vertical_pull')
    if focus in {'legs', 'lower'}:
        return ('squat', 'hinge')
    if focus in {'chest', 'chest/triceps'}:
        return ('horizontal_press',)
    return ()
