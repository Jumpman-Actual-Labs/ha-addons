"""Static gym-equipment catalog ("Home Gym" / equipment you have).

Not user-editable and not stored in GainsStore -- a fixed lookup table
shipped with the integration, mirrored by hand in ha-gains-frontend's
types.ts (same convention as exercises.py's EXERCISE_LIBRARY, since there's
no shared schema between the two repos).

This is deliberately a separate, more granular catalog than
exercises.py's broad `equipment` tags (barbell/dumbbell/kettlebell/
machine/cable/bodyweight/bands/box/other) -- an athlete checks off named
machines/items here ("Lat Pulldown Cable", "Olympic Barbell"), and each
item's `equipment_category` maps back to that same broad tag set so
logic.available_equipment_categories can tell the AI Coach which broad
categories of exercise the athlete can actually do.

`default_weight` is the machine's/bar's own resting weight (e.g. an empty
Olympic Barbell is 45 lb) shown as a starting point the athlete can edit
-- not a target working weight. Cable stations deliberately use None:
their load comes from either plates or a selectorized stack and is modeled
separately in GymProfile.equipment_config.
"""

from __future__ import annotations

from typing import Any

EQUIPMENT_CATALOG: list[dict[str, Any]] = [
    # -- machines --
    {
        "id": "ab_crunch_machine",
        "name": "Ab Crunch Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "abductor_machine",
        "name": "Abductor Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "adductor_machine",
        "name": "Adductor Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "assisted_weight_machine",
        "name": "Assisted Weight Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "bench_press_machine",
        "name": "Bench Press Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "bicep_curl_machine",
        "name": "Bicep Curl Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "calf_raise_machine",
        "name": "Calf Raise Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "fly_machine",
        "name": "Fly Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "leg_curl_machine",
        "name": "Leg Curl Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "leg_extension_machine",
        "name": "Leg Extension Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "leg_press_machine",
        "name": "Leg Press Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "incline_chest_press_machine",
        "name": "Incline Chest Press Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "decline_chest_press_machine",
        "name": "Decline Chest Press Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "hack_squat_machine",
        "name": "Hack Squat Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "glute_machine",
        "name": "Glute Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "hip_thrust_machine",
        "name": "Hip Thrust Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "pec_deck_machine",
        "name": "Pec Deck Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "preacher_curl_machine",
        "name": "Preacher Curl Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "rear_delt_machine",
        "name": "Rear Delt Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "torso_rotation_machine",
        "name": "Torso Rotation Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 10,
    },
    {
        "id": "smith_machine",
        "name": "Smith Machine",
        "category": "machines",
        "equipment_category": "machine",
        "default_weight": 15,
    },
    # -- cable machines --
    {
        "id": "crossover_cable",
        "name": "Crossover Cable",
        "category": "cable_machines",
        "equipment_category": "cable",
        "default_weight": None,
    },
    {
        "id": "hi_lo_pull_cable",
        "name": "Hi Lo Pull Cable",
        "category": "cable_machines",
        "equipment_category": "cable",
        "default_weight": None,
    },
    {
        "id": "lat_pulldown_cable",
        "name": "Lat Pulldown Cable",
        "category": "cable_machines",
        "equipment_category": "cable",
        "default_weight": None,
    },
    {
        "id": "row_cable",
        "name": "Row Cable",
        "category": "cable_machines",
        "equipment_category": "cable",
        "default_weight": None,
    },
    {
        "id": "cable_tower",
        "name": "Cable Tower",
        "category": "cable_machines",
        "equipment_category": "cable",
        "default_weight": None,
    },
    # -- plate-loaded machines --
    {
        "id": "plate_loaded_t_bar",
        "name": "Plate-Loaded T Bar Machine",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 22,
    },
    {
        "id": "plate_loaded_lat_pulldown",
        "name": "Plate-Loaded Lat Pulldown Machine",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 22,
    },
    {
        "id": "plate_loaded_chest_press",
        "name": "Plate-Loaded Chest Press Machine",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 12,
    },
    {
        "id": "plate_loaded_preacher",
        "name": "Plate-Loaded Preacher Machine",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 11,
    },
    {
        "id": "plate_loaded_seated_calf",
        "name": "Plate-Loaded Seated Calf Machine",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 11,
    },
    {
        "id": "plate_loaded_glute",
        "name": "Plate-Loaded Glute Machine",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 22,
    },
    {
        "id": "plate_loaded_hip_thrust",
        "name": "Plate-Loaded Hip Thrust Machine",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 22,
    },
    {
        "id": "plate_loaded_chest_supported_t_bar",
        "name": "Plate-Loaded Chest Supported T Bar",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 22,
    },
    {
        "id": "plate_loaded_ab_crunch",
        "name": "Plate-Loaded Ab Crunch Machine",
        "category": "plate_loaded_machines",
        "equipment_category": "machine",
        "default_weight": 11,
    },
    # -- bars and plates --
    {
        "id": "olympic_barbell",
        "name": "Olympic Barbell",
        "category": "bars_and_plates",
        "equipment_category": "barbell",
        "default_weight": 45,
    },
    {
        "id": "ez_bar",
        "name": "EZ Bar",
        "category": "bars_and_plates",
        "equipment_category": "barbell",
        "default_weight": 22,
    },
    {
        "id": "trap_bar",
        "name": "Trap Bar",
        "category": "bars_and_plates",
        "equipment_category": "barbell",
        "default_weight": 55,
    },
    {
        "id": "short_bar",
        "name": "Short Bar",
        "category": "bars_and_plates",
        "equipment_category": "barbell",
        "default_weight": 20,
    },
    {
        "id": "safety_squat_bar",
        "name": "Safety Squat Bar",
        "category": "bars_and_plates",
        "equipment_category": "barbell",
        "default_weight": 60,
    },
    {
        "id": "landmine",
        "name": "Landmine",
        "category": "bars_and_plates",
        "equipment_category": "barbell",
        "default_weight": None,
    },
    {
        "id": "plates",
        "name": "Plates",
        "category": "bars_and_plates",
        "equipment_category": "barbell",
        "default_weight": None,
    },
    # -- small weights --
    {
        "id": "dumbbells",
        "name": "Dumbbells",
        "category": "small_weights",
        "equipment_category": "dumbbell",
        "default_weight": None,
    },
    {
        "id": "kettlebells",
        "name": "Kettlebells",
        "category": "small_weights",
        "equipment_category": "kettlebell",
        "default_weight": None,
    },
    {
        "id": "wrist_ankle_weights",
        "name": "Wrist/Ankle Weights",
        "category": "small_weights",
        "equipment_category": "other",
        "default_weight": None,
    },
    # -- racks and benches --
    {
        "id": "squat_rack",
        "name": "Squat Rack",
        "category": "racks_and_benches",
        "equipment_category": "barbell",
        "default_weight": None,
    },
    {
        "id": "power_rack",
        "name": "Power Rack",
        "category": "racks_and_benches",
        "equipment_category": "barbell",
        "default_weight": None,
    },
    {
        "id": "flat_bench",
        "name": "Flat Bench",
        "category": "racks_and_benches",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "incline_bench",
        "name": "Incline Bench",
        "category": "racks_and_benches",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "decline_bench",
        "name": "Decline Bench",
        "category": "racks_and_benches",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "vertical_bench",
        "name": "Vertical Bench",
        "category": "racks_and_benches",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "dip_station",
        "name": "Dip Station",
        "category": "racks_and_benches",
        "equipment_category": "bodyweight",
        "default_weight": None,
    },
    {
        "id": "pull_up_bar",
        "name": "Pull-Up Bar",
        "category": "racks_and_benches",
        "equipment_category": "bodyweight",
        "default_weight": None,
    },
    # -- balls and accessories --
    {
        "id": "ab_wheel",
        "name": "Ab Wheel",
        "category": "balls_and_accessories",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "box",
        "name": "Box",
        "category": "balls_and_accessories",
        "equipment_category": "box",
        "default_weight": None,
    },
    {
        "id": "medicine_ball",
        "name": "Medicine Ball",
        "category": "balls_and_accessories",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "stability_ball",
        "name": "Stability Ball",
        "category": "balls_and_accessories",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "tire",
        "name": "Tire",
        "category": "balls_and_accessories",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "trx",
        "name": "TRX",
        "category": "balls_and_accessories",
        "equipment_category": "bodyweight",
        "default_weight": None,
    },
    {
        "id": "foam_roller",
        "name": "Foam Roller",
        "category": "balls_and_accessories",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "resistance_bands",
        "name": "Resistance Bands",
        "category": "balls_and_accessories",
        "equipment_category": "bands",
        "default_weight": None,
    },
    # -- rope --
    {
        "id": "battle_ropes",
        "name": "Battle Ropes",
        "category": "rope",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "skipping_rope",
        "name": "Skipping Rope",
        "category": "rope",
        "equipment_category": "bodyweight",
        "default_weight": None,
    },
    # -- cardio --
    {
        "id": "treadmill",
        "name": "Treadmill",
        "category": "cardio",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "stationary_bike",
        "name": "Stationary Bike",
        "category": "cardio",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "rowing_machine",
        "name": "Rowing Machine",
        "category": "cardio",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "elliptical",
        "name": "Elliptical",
        "category": "cardio",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "stair_climber",
        "name": "Stair Climber",
        "category": "cardio",
        "equipment_category": "other",
        "default_weight": None,
    },
    {
        "id": "assault_bike",
        "name": "Assault Bike",
        "category": "cardio",
        "equipment_category": "other",
        "default_weight": None,
    },
]

for _id, _name in {
    "ankle_cable_strap": "Ankle Cable Strap",
    "lat_bar": "Lat Pulldown Bar", "close_grip_handle": "Close Grip Cable Handle",
    "straight_cable_bar": "Straight Cable Bar", "rope_attachment": "Cable Rope Attachment",
    "cable_handle": "Single Cable Handle", "dip_belt": "Dip Belt",
    "neutral_grip_pull_up_bar": "Neutral Grip Pull-Up Bar",
    "preacher_bench": "Preacher Bench", "back_extension_bench": "Back Extension Bench",
    "lifting_platform": "Deficit Lifting Platform", "yoke": "Yoke",
    "lateral_raise_machine": "Lateral Raise Machine",
}.items():
    EQUIPMENT_CATALOG.append({"id": _id, "name": _name, "category": "balls_and_accessories",
                              "equipment_category": "other", "default_weight": None})

EQUIPMENT_IDS: frozenset[str] = frozenset(e["id"] for e in EQUIPMENT_CATALOG)


def get_equipment_item(equipment_id: str) -> dict[str, Any] | None:
    for item in EQUIPMENT_CATALOG:
        if item["id"] == equipment_id:
            return item
    return None
