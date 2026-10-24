"""Unit snapshots for shared inventory; legacy unknown units stay readable."""
from __future__ import annotations

import copy

from .models import AthleteProfile, GainsData, GymProfile


def convert_weight(value: float, source: str, target: str) -> float:
    if source == target:
        return float(value)
    return round(value / 2.2046226218 if target == 'metric' else value * 2.2046226218, 4)


def gym_as_units(gym: GymProfile, target: str) -> dict:
    raw = copy.deepcopy(gym.to_dict())
    source = gym.inventory_units
    if source in {"metric", "imperial"} and source != target:
        raw["equipment"] = {
            key: [convert_weight(v, source, target) if v is not None else None for v in values]
            for key, values in raw["equipment"].items()
        }
        for config in raw['equipment_config'].values():
            for key in ('stack_increment', 'stack_max', 'stack_min', 'base_weight'):
                if config.get(key) is not None:
                    config[key] = convert_weight(config[key], source, target)
    raw['inventory_units'] = target if source else None
    return raw


def performance_context(profile: AthleteProfile, data: GainsData) -> dict:
    return {
        "units": profile.units,
        "gym_id": profile.gym_profile_id,
        "inventory": next(
            (
                copy.deepcopy(g.to_dict())
                for g in data.gym_profiles
                if g.id == profile.gym_profile_id
            ),
            None,
        ),
    }
