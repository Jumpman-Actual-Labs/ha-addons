"""Explicit physical inventory for tests whose subject is generation, not missing gear."""

from gains_addon.models import GymProfile


def equip(profile, data):
    profile.gym_profile_id = "verified-" + profile.id
    data.gym_profiles.append(
        GymProfile(
            id=profile.gym_profile_id,
            name="Verified test gym",
            inventory_units=profile.units,
            equipment={
                "olympic_barbell": [20 if profile.units == "metric" else 45],
                "plates": [20, 20, 20, 20, 1, 1],
                "dumbbells": [2, 2, 5, 5, 10, 10, 20, 20],
                "flat_bench": [None],
                "incline_bench": [None],
                "power_rack": [None],
                "pull_up_bar": [None],
                "cable_tower": [None],
                "lat_bar": [None],
                "rope_attachment": [None],
                "cable_handle": [None],
                "straight_cable_bar": [None],
                "close_grip_handle": [None],
            },
            equipment_config={
                "cable_tower": {"load_type": "weight_stack", "stack_increment": 5, "stack_max": 100}
            },
        )
    )
    return profile
