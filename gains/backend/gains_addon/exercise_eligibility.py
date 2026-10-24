"""Explicit all-of / any-of equipment requirements for the full exercise library.

Unknown equipment is unavailable, never an implicit match to a broad category.
"""

from __future__ import annotations

from .equipment import EQUIPMENT_CATALOG

BAR = {"olympic_barbell", "short_bar"}
RACK = {"power_rack", "squat_rack"}
BENCH = {"flat_bench", "incline_bench"}
CABLE = {"hi_lo_pull_cable", "cable_tower", "crossover_cable"}
NAMES = {e["id"]: e["name"] for e in EQUIPMENT_CATALOG}

# Additional required components, each group is an alternative, all groups required.
EXTRA = {
    "barbell_bench_press": (BENCH, RACK),
    "incline_barbell_bench_press": ({"incline_bench"}, RACK),
    "decline_bench_press": ({"decline_bench"}, RACK),
    "close_grip_bench_press": (BENCH, RACK),
    "barbell_back_squat": (RACK,),
    "barbell_front_squat": (RACK,),
    "safety_bar_squat": (RACK,),
    "box_squat": (RACK, {"box"}),
    "pin_squat": (RACK,),
    "zercher_squat": (RACK,),
    "good_morning": (RACK,),
    "rack_pull": (RACK,),
    "barbell_good_morning_seated": (RACK, BENCH),
    "hip_thrust": (BENCH,),
    "dumbbell_bench_press": (BENCH,),
    "incline_dumbbell_bench_press": ({"incline_bench"},),
    "dumbbell_fly": (BENCH,),
    "skull_crusher": (BENCH,),
    "chest_supported_row": ({"incline_bench"},),
    "incline_dumbbell_rear_delt_raise": ({"incline_bench"},),
    "seated_dumbbell_press": (BENCH,),
    "bulgarian_split_squat": (BENCH,),
    "step_up": ({"box"},),
    "preacher_curl": ({"preacher_bench"},),
    "smith_machine_flat_press": (BENCH,),
    "smith_machine_incline_press": ({"incline_bench"},),
    "rear_foot_elevated_split_squat": (BENCH,),
    "landmine_squat": ({"landmine"},),
    "landmine_press": ({"landmine"},),
    "single_arm_landmine_press": ({"landmine"},),
    "meadows_row": ({"landmine"},),
    "deficit_deadlift": ({"lifting_platform"},),
}
SPECIFIC = {
    "leg_extension": {"leg_extension_machine"},
    "seated_leg_curl": {"leg_curl_machine"},
    "lying_leg_curl": {"leg_curl_machine"},
    "standing_calf_raise": {"calf_raise_machine"},
    "seated_calf_raise": {"plate_loaded_seated_calf"},
    "hip_abduction_machine": {"abductor_machine"},
    "hip_adduction_machine": {"adductor_machine"},
    "battle_ropes": {"battle_ropes"},
    "jump_rope": {"skipping_rope"},
    "rowing_machine": {"rowing_machine"},
    "assault_bike": {"stationary_bike"},
    "hack_squat": {"hack_squat_machine"},
    "leg_press": {"leg_press_machine"},
    "single_leg_press": {"leg_press_machine"},
    "smith_machine_squat": {"smith_machine"},
    "pec_deck": {"pec_deck_machine", "fly_machine"},
    "t_bar_row": {"plate_loaded_t_bar"},
    "assisted_pull_up": {"assisted_weight_machine"},
    "back_extension": {"back_extension_bench"},
    "machine_lateral_raise": {"lateral_raise_machine"},
    "ab_wheel_rollout": {"ab_wheel"},
    "yoke_walk": {"yoke"},
    "pull_up": {"pull_up_bar"},
    "chin_up": {"pull_up_bar"},
    "neutral_grip_pull_up": {"neutral_grip_pull_up_bar"},
    "weighted_pull_up": {"pull_up_bar"},
    "hanging_leg_raise": {"pull_up_bar"},
    "hanging_knee_raise": {"pull_up_bar"},
    "dip": {"dip_station"},
    "dips": {"dip_station"},
    "inverted_row": {"trx", "power_rack", "squat_rack"},
    "incline_push_up": BENCH,
    "decline_push_up": BENCH,
    "dragon_flag": BENCH,
}
# Attachments are separately recorded items: a cable station alone is insufficient.
ATTACHMENTS = {
    "lat_pulldown": "lat_bar",
    "close_grip_lat_pulldown": "close_grip_handle",
    "straight_arm_pulldown": "straight_cable_bar",
    "cable_row": "close_grip_handle",
    "glute_kickback": "ankle_cable_strap",
    "wide_grip_cable_row": "straight_cable_bar",
    "neutral_grip_lat_pulldown": "close_grip_handle",
    "underhand_lat_pulldown": "lat_bar",
    "face_pull": "rope_attachment",
    "cable_pull_through": "rope_attachment",
    "tricep_pushdown": "straight_cable_bar",
    "cable_curl": "straight_cable_bar",
    "cable_crunch": "rope_attachment",
    "kneeling_cable_crunch": "rope_attachment",
}
SINGLE_DUMBBELL = {
    "goblet_squat",
    "dumbbell_row",
    "concentration_curl",
    "overhead_tricep_extension",
    "weighted_situp",
    "weighted_dead_bug",
    "single_arm_dumbbell_floor_press",
    "suitcase_carry",
    "dumbbell_suitcase_carry",
    "single_arm_overhead_carry",
    "overhead_carry",
    "lateral_lunge",
}


def requirements(exercise: dict) -> tuple[set[str], ...]:
    eid, category = exercise["id"], exercise["equipment"]
    required = exercise.get("requires_equipment_id")
    if category == "barbell":
        groups = ({required} if required and required != "landmine" else BAR,)
    elif category in {"dumbbell", "kettlebell", "bands", "box"}:
        groups = (
            {
                {
                    "dumbbell": "dumbbells",
                    "kettlebell": "kettlebells",
                    "bands": "resistance_bands",
                    "box": "box",
                }[category]
            },
        )
    elif category == "cable":
        stations = (
            {required}
            if required
            else {"lat_pulldown_cable", *CABLE}
            if "pulldown" in eid
            else {"row_cable", *CABLE}
            if eid == "cable_row"
            else CABLE
        )
        attachment = ATTACHMENTS.get(eid, "cable_handle")
        groups = (stations, {attachment})
    elif required:
        groups = ({required},)
    elif eid in SPECIFIC:
        groups = (SPECIFIC[eid],)
    elif category == "bodyweight":
        groups = ()
    else:
        groups = ({f"unverified_{eid}"},)
    if eid == "weighted_pull_up":
        groups += ({"dip_belt"}, {"plates"})
    return groups + EXTRA.get(eid, ())


def missing_equipment(exercise: dict, equipment: dict) -> list[str]:
    reasons = [
        "Missing " + " or ".join(NAMES.get(i, i.replace("_", " ")) for i in sorted(group))
        for group in requirements(exercise)
        if not any(equipment.get(i) for i in group)
    ]

    if exercise["id"] in {
        "cable_fly",
        "high_to_low_cable_fly",
        "low_to_high_cable_fly",
        "standing_cable_chest_press",
    }:
        if not equipment.get("crossover_cable") and len(equipment.get("cable_tower", [])) < 2:
            reasons.append("Missing crossover station or two cable towers for simultaneous arms")
        if len(equipment.get("cable_handle", [])) < 2:
            reasons.append("Missing two cable handles (quantity 2)")
    return reasons
