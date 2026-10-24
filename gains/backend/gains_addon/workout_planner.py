"""Deterministic, equipment-aware exercise ranking for Geoffrey.

Exercise selection is an auditable recommendation step, not a free-form AI guess.
IDs are chosen only from the athlete's allowed catalog. No saved workouts mutate.
"""
from __future__ import annotations

import random
import re
from collections import Counter
from datetime import UTC, datetime
from typing import Any

from .exercise_metadata import METADATA, movement_slots

FOCUS_CATEGORIES: dict[str, tuple[str, ...]] = {
    "push": ("push", "shoulders", "arms"),
    "pull": ("pull", "arms", "hinge"),
    "legs": ("squat", "hinge", "single_leg", "legs"),
    "upper": ("push", "pull", "shoulders", "arms"),
    "lower": ("squat", "hinge", "single_leg", "legs"),
    "full body": ("squat", "push", "pull", "hinge", "core"),
    "chest": ("push",),
    "back": ("pull",),
    "shoulders": ("shoulders",),
    "arms": ("arms",),
    "chest/back": ("push", "pull"),
    "shoulders/arms": ("shoulders", "arms"),
    "chest/arms": ("push", "arms"),
    "back/shoulders": ("pull", "shoulders"),
    "chest/triceps": ("push", "arms"),
    "back/biceps": ("pull", "arms"),
    "chest/biceps isolation": ("push", "arms"),
    "chest isolation": ("push",),
    "arms/grip": ("arms", "carry"),
}

# In addition to broad categories, muscles ensure variants are not treated as
# unrelated simply because the equipment or name differs.
FOCUS_MUSCLES: dict[str, frozenset[str]] = {
    "push": frozenset({"pectoralis_major", "triceps_brachii", "anterior_deltoid"}),
    "pull": frozenset({"latissimus_dorsi", "rhomboids", "biceps_brachii"}),
    "legs": frozenset({"quadriceps", "hamstrings", "gluteus_maximus", "gastrocnemius"}),
    "upper": frozenset({
        "pectoralis_major", "latissimus_dorsi", "rhomboids",
        "triceps_brachii", "biceps_brachii", "lateral_deltoid",
    }),
    "lower": frozenset({
        "quadriceps", "hamstrings", "gluteus_maximus", "gastrocnemius",
    }),
    "full body": frozenset({
        "pectoralis_major", "latissimus_dorsi", "quadriceps",
        "hamstrings", "gluteals",
    }),
    "chest": frozenset({"pectoralis_major"}),
    "back": frozenset({"latissimus_dorsi", "rhomboids", "trapezius"}),
    "shoulders": frozenset({
        "anterior_deltoid", "lateral_deltoid", "posterior_deltoid",
    }),
    "arms": frozenset({"biceps_brachii", "triceps_brachii", "forearms"}),
    "chest/back": frozenset({"pectoralis_major", "latissimus_dorsi", "rhomboids"}),
    "shoulders/arms": frozenset({
        "anterior_deltoid", "lateral_deltoid", "posterior_deltoid",
        "biceps_brachii", "triceps_brachii",
    }),
    "chest/arms": frozenset({
        "pectoralis_major", "biceps_brachii", "triceps_brachii",
    }),
    "back/shoulders": frozenset({
        "latissimus_dorsi", "rhomboids", "lateral_deltoid", "posterior_deltoid",
    }),
    "chest/triceps": frozenset({"pectoralis_major", "triceps_brachii"}),
    "back/biceps": frozenset({"latissimus_dorsi", "rhomboids", "biceps_brachii"}),
    "chest/biceps isolation": frozenset({"pectoralis_major", "biceps_brachii"}),
    "chest isolation": frozenset({"pectoralis_major"}),
    "arms/grip": frozenset({"biceps_brachii", "triceps_brachii", "forearms"}),
}

# Canonical anatomy IDs, with targeted sessions kept distinct from full body.
FOCUS_CATEGORIES.update({"biceps": ("arms",), "triceps": ("arms", "push"),
                         "core": ("core",), "chest/biceps": ("push", "arms")})
FOCUS_MUSCLES.update({"biceps": frozenset({"biceps_brachii"}),
                     "triceps": frozenset({"triceps_brachii"}),
                     "core": frozenset({"rectus_abdominis", "obliques"}),
                     "chest/biceps": frozenset({"pectoralis_major", "biceps_brachii"})})
for _focus, _muscles in list(FOCUS_MUSCLES.items()):
    FOCUS_MUSCLES[_focus] = frozenset(
        {"gluteus_maximus": "gluteals", "gastrocnemius": "calves"}.get(m, m)
        for m in _muscles
    )


def exercise_family(item: dict) -> str:
    """Reviewed movements use shared families; unknown entries stay distinct."""
    name = item['id']
    for family, tokens in {
        'press': ('bench_press', 'floor_press', 'push_up', 'pushup'),
        'fly': ('fly',), 'curl': ('curl',), 'triceps': ('triceps', 'skull_crusher'),
        'row': ('row',), 'vertical_pull': ('pulldown', 'pull_up', 'chin_up'),
        'squat': ('squat',), 'hinge': ('deadlift', 'rdl'),
        'carry': ('carry',), 'calf': ('calf',),
    }.items():
        if any(token in name for token in tokens):
            return family
    return name


STAPLES = {
    'chest': 'barbell_bench_press', 'chest/triceps': 'barbell_bench_press',
    'back': 'barbell_row', 'back/biceps': 'barbell_row',
    'legs': 'barbell_back_squat', 'lower': 'barbell_back_squat',
    'upper': 'barbell_bench_press', 'full body': 'barbell_back_squat',
    'push': 'barbell_bench_press', 'pull': 'barbell_row',
}


def role_groups(focus: str) -> list[set[str]]:
    """Required semantic roles; no generic arms or carry filler."""
    groups = {
        "upper": [{"pectoralis_major"}, {"latissimus_dorsi", "rhomboids"}],
        "push": [
            {"pectoralis_major"},
            {"triceps_brachii"},
            {"anterior_deltoid", "lateral_deltoid"},
        ],
        "pull": [{"latissimus_dorsi", "rhomboids"}, {"biceps_brachii"}],
        "chest/back": [{"pectoralis_major"}, {"latissimus_dorsi", "rhomboids"}],
        "shoulders/arms": [
            {"anterior_deltoid", "lateral_deltoid", "posterior_deltoid"},
            {"biceps_brachii"},
            {"triceps_brachii"},
        ],
        "chest/arms": [{"pectoralis_major"}, {"biceps_brachii"}, {"triceps_brachii"}],
        "back/shoulders": [
            {"latissimus_dorsi", "rhomboids"},
            {"lateral_deltoid", "posterior_deltoid"},
        ],
        "arms": [{"biceps_brachii"}, {"triceps_brachii"}],
        "chest/triceps": [{"pectoralis_major"}, {"triceps_brachii"}],
        "back/biceps": [{"latissimus_dorsi", "rhomboids"}, {"biceps_brachii"}],
        "chest/biceps": [{"pectoralis_major"}, {"biceps_brachii"}],
        "chest/biceps isolation": [{"pectoralis_major"}, {"biceps_brachii"}],
        "arms/grip": [{"biceps_brachii"}, {"triceps_brachii"}, {"forearms"}],
        "legs": [{"quadriceps"}, {"hamstrings", "gluteals"}],
        "lower": [{"quadriceps"}, {"hamstrings", "gluteals"}],
        "full body": [
            {"quadriceps", "gluteals"},
            {"pectoralis_major"},
            {"latissimus_dorsi", "rhomboids"},
        ],
    }
    return groups.get(focus, [set(FOCUS_MUSCLES[focus])])


def focus_constraints(description: str) -> tuple[frozenset[str], list[set[str]]]:
    focus = focus_name(description)
    muscles = set(FOCUS_MUSCLES[focus])
    roles = role_groups(focus)
    if focus == 'arms' and not re.search(r'\barms\b', description.lower()):
        muscles = {'biceps_brachii', 'triceps_brachii'}
    for label, groups in {
        'biceps': [{'biceps_brachii'}], 'triceps': [{'triceps_brachii'}],
        'shoulders': [{'anterior_deltoid', 'lateral_deltoid', 'posterior_deltoid'}],
        'core': [{'rectus_abdominis', 'obliques'}], 'forearms': [{'forearms'}],
        'arms': [{'biceps_brachii'}, {'triceps_brachii'}],
        'legs': [{'quadriceps'}, {'hamstrings', 'gluteals'}],
    }.items():
        if re.search(r'\b' + label + r'\b', description.lower()):
            for group in groups:
                if not group & muscles:
                    muscles.update(group)
                    roles.append(group)
    return frozenset(muscles), roles


def focus_name(description: str) -> str:
    """Normalize explicit split sessions before interpreting loose goal text."""
    from .training_splits import session_focus

    return session_focus(description)



def recovery_penalties(
    catalog: list[dict[str, Any]], recent_workouts: list[Any], now: datetime
) -> Counter[str]:
    """Estimate muscle recovery from completed workouts within the last 72 hours.

    This is a planning heuristic, not a medical recovery estimate; missing
    timestamps or non-completed workouts do not introduce artificial fatigue.
    """
    from .recovery import muscle_recovery

    penalties: Counter[str] = Counter()
    profile_ids = {w.profile_id for w in recent_workouts if hasattr(w, 'profile_id')}
    for profile_id in profile_ids:
        snapshot = muscle_recovery(recent_workouts, profile_id, now)
        for muscle, state in snapshot['muscles'].items():
            penalties[muscle] = 100 - state['recovery_percent']
    return penalties


def select_exercises(
    catalog: list[dict[str, Any]],
    allowed_ids: set[str],
    recent_workouts: list[Any],
    focus: str,
    count: int = 6,
    as_of: datetime | None = None,
    seed: int = 0,
    variety: str = "balanced",
    reservations: set[str] | None = None,
    required: tuple[str, ...] = (),
    excluded: tuple[str, ...] = (),
    preferred: tuple[str, ...] = (),
) -> list[str]:
    """Rank eligible exercises for coverage, novelty and nonredundant patterns.

    Scores use fixed coefficients for deterministic ordering. Selection chooses
    strong compounds first, fills uncovered muscle patterns, and penalizes
    repeating an identical or very similar exercise within a workout.
    """
    if count <= 0:
        return []
    muscles, roles = focus_constraints(focus)
    focus = focus_name(focus)
    categories = FOCUS_CATEGORIES[focus]
    eligible = [
        item for item in catalog
        if item["id"] in allowed_ids and item["id"] not in excluded
        and item['id'] in METADATA
        and set(item.get("muscles", {}).get("primary", [])) & muscles
    ]
    if not eligible:
        return []
    now = as_of or datetime.now(UTC)
    fatigue = recovery_penalties(catalog, recent_workouts, now)
    rng = random.Random(seed)
    jitter = {
        i["id"]: rng.random()
        * (0 if variety == "consistency" else 8 if variety == "variety" else 3)
        for i in sorted(eligible, key=lambda e: e["id"])
    }
    used: Counter[str] = Counter()
    completed = sorted((w for w in recent_workouts if getattr(w, 'status', '') == 'completed'),
                       key=lambda w: getattr(w, 'completed_at', '') or '')[-12:]
    for workout in completed:
        for exercise in workout.exercises:
            if any(getattr(s, 'completed', False) for s in getattr(exercise, 'sets', [])):
                used[exercise.exercise_id] += 1

    def primary(item: dict[str, Any]) -> set[str]:
        return set(item.get("muscles", {}).get("primary", []))

    by_id = {i['id']: i for i in eligible}
    if any(i not in by_id for i in required):
        raise ValueError('Required exercise is unavailable or outside the session targets')
    chosen: list[dict[str, Any]] = [by_id[i] for i in required]
    staple = by_id.get(STAPLES.get(focus))
    if staple and staple not in chosen and len(chosen) < count:
        chosen.append(staple)
    covered: Counter[str] = Counter()
    category_uses: Counter[str] = Counter()
    for item in chosen:
        covered.update(primary(item))
    target_count = min(max(count, len(required)), len(eligible))
    while len(chosen) < target_count:
        best = None
        best_score = float("-inf")
        for item in eligible:
            if item in chosen:
                continue
            if sum(exercise_family(other) == exercise_family(item) for other in chosen) >= 2:
                continue
            muscles_hit = primary(item)
            overlap = sum(len(muscles_hit & primary(other)) for other in chosen)
            novel = sum(1 for muscle in muscles_hit if not covered[muscle])
            relevant = len(muscles_hit & muscles)
            unfilled = next((role for role in roles if not any(covered[m] for m in role)), None)
            if unfilled and not muscles_hit & unfilled:
                continue
            missing_movement = next(
                (
                    slot
                    for slot in movement_slots(focus)
                    if not any(METADATA[other["id"]]["movement"] == slot for other in chosen)
                ),
                None,
            )
            if (
                not unfilled
                and missing_movement
                and METADATA[item["id"]]["movement"] != missing_movement
            ):
                continue
            # Category diversity matters where anatomy metadata is absent.
            score = (
                8 * relevant + 4 * novel + 5 * (item["category"] in categories)
                - 7 * category_uses[item["category"]]
                - 6 * overlap - 4 * used[item["id"]]
                - sum(fatigue[muscle] for muscle in muscles_hit)
            )
            # Keep compound lifting ahead of accessories when priorities match.
            if item["category"] in ("squat", "hinge", "push", "pull"):
                score += 2
            family = exercise_family(item)
            score -= 8 * sum(exercise_family(other) == family for other in chosen)
            score -= 5 * (item['id'] in (reservations or set()))
            score += 15 * (item['id'] in preferred)
            score += jitter[item['id']]
            if 'isolation' in focus and family in {'fly', 'curl'}:
                score += 6
            if score > best_score or (score == best_score and (
                best is None or item["id"] < best["id"]
            )):
                best, best_score = item, score
        if best is None:
            break
        chosen.append(best)
        category_uses[best["category"]] += 1
        covered.update(primary(best))
    return [item["id"] for item in chosen]


def next_strength_targets(
    target: int,
    performed: int,
    weight: float | None,
    rpe: float | None,
    demanding: bool = False,
    increment: float = 2.5,
) -> tuple[int, float | None]:
    """Increase repetitions before load, using available practical increments."""
    baseline = max(1, min(30, int(target)))
    if performed < baseline or demanding or (rpe is not None and rpe >= 9):
        return max(1, min(30, performed)), weight
    ceiling = min(30, baseline + 4)
    if (
        performed >= ceiling
        and rpe is not None
        and rpe <= 7
        and weight is not None
        and weight > 0
        and increment <= weight * 0.05
    ):
        return baseline, round(weight + increment, 2)
    return min(ceiling, performed + 1), weight
