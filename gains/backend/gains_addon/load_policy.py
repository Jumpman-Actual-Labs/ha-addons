"""Feasible external loads from Gains inventory, never proprietary tables."""

from __future__ import annotations

from collections import Counter
from math import isfinite

from .equipment import EQUIPMENT_CATALOG
from .exercise_eligibility import SINGLE_DUMBBELL, missing_equipment, requirements
from .inventory_units import convert_weight
from .models import AthleteProfile, GainsData, GymProfile

EQUIPMENT = {i["id"]: i for i in EQUIPMENT_CATALOG}

WEIGHTED = {"barbell", "dumbbell", "kettlebell", "machine", "cable"}


def load_bearing(exercise: dict) -> bool:
    return (
        exercise["equipment"] in WEIGHTED
        and exercise["id"] not in {"assault_bike", "rowing_machine"}
        or exercise["id"] in {"weighted_pull_up", "yoke_walk", "sled_push", "sled_pull"}
    )


def gym_for(profile: AthleteProfile, data: GainsData) -> GymProfile | None:
    return next((g for g in data.gym_profiles if g.id == profile.gym_profile_id), None)


def feasible_ids(
    catalog: list[dict], allowed: set[str], profile: AthleteProfile, data: GainsData
) -> set[str]:
    return {
        e["id"]
        for e in catalog
        if e["id"] in allowed and exercise_availability(e, profile, data)["feasible"]
    }


def exercise_availability(exercise: dict, profile: AthleteProfile, data: GainsData) -> dict:
    gym = gym_for(profile, data)
    reasons = missing_equipment(exercise, gym.equipment if gym else {})
    selectable = not reasons
    ladder = load_ladder(exercise, profile, data)
    if load_bearing(exercise) and not ladder:
        reasons.append(
            "Load inventory unverified: record weights, quantities, units and machine settings"
        )
    if ladder and load_bearing(exercise) and profile.experience_level == "kids":
        own = [
            s.actual_weight
            for w in data.workouts
            if w.profile_id == profile.id and w.status == "completed"
            for e in w.exercises
            if e.exercise_id == exercise["id"]
            for s in e.sets
            if s.completed and s.actual_weight is not None
        ]
        limit = max(own) if own else convert_weight(2, "metric", profile.units)
        if min(ladder) > limit:
            reasons.append("No verified child starting load; review a lighter option")
            selectable = False
    bars = {}
    if gym and exercise["equipment"] == "barbell":
        for key in requirements(exercise)[0]:
            for value in gym.equipment.get(key, []):
                default = EQUIPMENT.get(key, {}).get("default_weight")
                if value is None and default is None:
                    continue
                weight = (
                    convert_weight(default, "imperial", profile.units)
                    if value is None
                    else convert_weight(value, gym.inventory_units or profile.units, profile.units)
                )
                bars[f"{key}:{weight:.12g}"] = load_ladder(
                    exercise, profile, data, {"equipment_id": key, "weight": weight}
                )
    return {
        "feasible": not reasons, "selectable": selectable,
        "reasons": reasons, "loads": ladder, "bars": bars,
    }


def inventory_policy(profile: AthleteProfile, data: GainsData) -> dict:
    from .exercises import EXERCISE_LIBRARY

    return {e["id"]: exercise_availability(e, profile, data) for e in EXERCISE_LIBRARY}


def snap_load(target: float | None, ladder: list[float], *, lower: bool = False) -> float | None:
    if target is None or not ladder:
        return None
    candidates = (
        [v for v in ladder if v < target - 0.001]
        if lower
        else [v for v in ladder if v <= target + 0.001]
    )
    return max(candidates) if candidates else (None if lower else min(ladder))


def load_ladder(
    exercise: dict, profile: AthleteProfile, data: GainsData, selected_bar: dict | None = None
) -> list[float]:
    if not load_bearing(exercise):
        return [0.0]
    gym = gym_for(profile, data)
    if gym is None or gym.inventory_units not in {"imperial", "metric"}:
        return []
    category = exercise["equipment"]

    def values(key: str) -> list[float]:
        default = EQUIPMENT.get(key, {}).get("default_weight")
        return [
            convert_weight(default, "imperial", profile.units)
            if v is None
            else convert_weight(v, gym.inventory_units or profile.units, profile.units)
            for v in gym.equipment.get(key, [])
            if isinstance(default if v is None else v, (int, float))
            and not isinstance(default if v is None else v, bool)
            and isfinite(default if v is None else v)
            and (default if v is None else v) > 0
        ]

    if exercise["id"] == "weighted_pull_up":
        return plate_totals(values("plates"), 1)
    if category in {"dumbbell", "kettlebell"}:
        weights = values("dumbbells" if category == "dumbbell" else "kettlebells")
        paired = category == "dumbbell" and exercise["id"] not in SINGLE_DUMBBELL
        return sorted(w for w, quantity in Counter(weights).items() if not paired or quantity >= 2)
    if category in {"machine", "cable"}:
        stations = next(iter(requirements(exercise)), set())
        ladders = []
        for equipment_id in sorted(stations):
            if not gym.equipment.get(equipment_id):
                continue
            config = gym.equipment_config.get(equipment_id, {})
            step, limit = config.get("stack_increment"), config.get("stack_max")
            minimum = config.get("stack_min", step)
            if (
                config.get("load_type") == "weight_stack"
                and type(step) in {int, float}
                and type(limit) in {int, float}
                and type(minimum) in {int, float}
                and isfinite(minimum)
                and 0 <= minimum <= limit
                and isfinite(step)
                and isfinite(limit)
                and 0 < step <= limit <= 2000
            ):
                # Nominal stack labels: pulley ratio is not a second weight conversion.
                ladders.append(
                    [
                        convert_weight(minimum + step * n, gym.inventory_units, profile.units)
                        for n in range(min(1000, int((limit - minimum) / step + 1e-8)) + 1)
                    ]
                )
            elif config.get("load_type") == "plate_loaded":
                # Explicit settings distinguish single loading pin from two balanced horns.
                horns = config.get("loading_points")
                base = config.get("base_weight")
                if horns in {1, 2} and type(base) in {int, float} and isfinite(base) and base >= 0:
                    totals = plate_totals(values("plates"), horns)
                    base = convert_weight(base, gym.inventory_units, profile.units)
                    ladders.append([round(base + total, 4) for total in totals])
        return sorted(set(v for ladder in ladders for v in ladder))
    if category != "barbell":
        return []
    bars = [
        (key, weight)
        for key in gym.equipment
        if EQUIPMENT.get(key, {}).get("category") == "bars_and_plates"
        and key not in {"plates", "landmine"}
        for weight in values(key)
    ]
    required_bar = exercise.get("requires_equipment_id")
    compatible = requirements(exercise)[0]
    bars = [(key, weight) for key, weight in bars if key in compatible]
    if required_bar and required_bar != "landmine":
        bars = [(key, weight) for key, weight in bars if key == required_bar]
    remembered = selected_bar or profile.last_bar_by_exercise.get(exercise["id"], {})
    if remembered:
        matching = [
            (key, weight)
            for key, weight in bars
            if key == remembered.get("equipment_id")
            and abs(weight - (remembered.get("weight") or 0)) < 0.001
        ]
        if not matching:
            return []
        bars = matching
    if not bars:
        return []
    totals = plate_totals(
        values("plates"),
        1 if "landmine" in exercise["id"] or exercise["id"] == "meadows_row" else 2,
    )
    if profile.experience_level == "kids":
        bars = [min(bars, key=lambda b: b[1])]
    else:
        bars = [next((b for b in bars if b[0] == "olympic_barbell"), bars[0])]
    return sorted(
        {round(bar + total, 2) for _, bar in bars for total in totals if bar + total <= 2000}
    )


def plate_totals(weights: list[float], loading_points: int) -> list[float]:
    """Each saved plate entry is a pair, as shown in the equipment editor."""
    totals = {0.0}
    for weight, quantity in Counter(weights).items():
        totals = {
            round(total + weight * loading_points * count, 4)
            for total in totals
            for count in range((quantity * 2) // loading_points + 1)
        }
        if len(totals) > 20000:
            return []
    return sorted(totals)

