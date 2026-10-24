"""Independent Gains planning contracts; additive and serializable."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from hashlib import sha256
from typing import Any

ENGINE_VERSION = 1


@dataclass(frozen=True)
class PlanningContext:
    athlete_id: str
    actor_id: str
    digest: str
    calculated_at: str
    seed: int
    engine_version: int = ENGINE_VERSION

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class PlanningIntent:
    focus: str = "Full Body"
    goal: str = "General Fitness"
    duration_minutes: int = 45
    intensity: str = "Moderate"
    variety: str = "balanced"
    seed: int = 0
    required: tuple[str, ...] = ()
    excluded: tuple[str, ...] = ()
    preferred: tuple[str, ...] = ()
    provenance: str = "default"

    def to_dict(self) -> dict:
        result = asdict(self)
        for key in ('required', 'excluded', 'preferred'):
            result[key] = list(result[key])
        return result


@dataclass(frozen=True)
class SessionSpec:
    id: str
    focus: str
    targets: tuple[str, ...]
    policy: str = "hypertrophy"
    movements: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {'id': self.id, 'focus': self.focus, 'targets': list(self.targets),
                'policy': self.policy, 'movements': list(self.movements)}


class PlanningError(ValueError):
    def __init__(self, reason_code: str, details: object) -> None:
        self.reason_code = reason_code
        self.details = details
        message = {
            "missing_session_roles": "The equipment cannot cover every requested muscle role.",
            "missing_movement_slot": "The selected equipment cannot cover every required movement.",
            "duration_budget": "The time budget cannot cover the required roles and warmup.",
        }.get(reason_code, reason_code.replace("_", " "))
        super().__init__('No feasible plan: ' + message)

    def to_dict(self) -> dict:
        return {
            "status": "no_feasible_plan",
            "reason_code": self.reason_code,
            "details": self.details,
        }


def effective_answers(answers: dict, *, run_duration: bool = False) -> dict:
    result = dict(answers)
    for key, value in list(answers.items()):
        if value == "Other" and answers.get(key + "_other") not in (None, ""):
            result[key] = answers[key + "_other"]
    for key, low, high in (
        ("duration", 0.1 if run_duration else 5, 3000 if run_duration else 180),
        ("lifting_days", 0, 7),
        ("running_days", 0, 7),
        ("hiit", 0, 7),
        ("seed", 0, 2147483647),
        ('deload_every', 0, 26),
    ):
        value = result.get(key)
        if value is None or value == "Geoffrey Decide":
            result.pop(key, None)
            continue
        try:
            numeric = float(value)
            fractional = run_duration and key == "duration"
            if (
                isinstance(value, bool)
                or not low <= numeric <= high
                or (not fractional and int(numeric) != numeric)
            ):
                raise ValueError
            result[key] = numeric if fractional else int(numeric)
        except (ValueError, TypeError, OverflowError) as err:
            raise ValueError(f"Choose a valid {key.replace('_', ' ')}") from err
    return result


def intent_from_answers(answers: dict, profile: Any) -> PlanningIntent:
    answers = effective_answers(answers)
    if str(answers.get("variety") or "balanced").lower() not in {
        "consistency",
        "balanced",
        "variety",
    }:
        raise ValueError('Choose consistency, balanced or variety')
    focus = answers.get("focus") or "Full Body"
    if focus == "Specific Muscle Group":
        focus = answers.get("muscle") or "Full Body"
    if focus == "Geoffrey Decide":
        focus = "Full Body"
    from .training_splits import custom_split_focuses

    custom_split_focuses(
        str(focus).replace("Body", "").strip()
        if str(focus) in {"Upper Body", "Lower Body"}
        else str(focus),
        1,
    )

    def ids(key: str) -> tuple[str, ...]:
        value = answers.get(key, [])
        if not isinstance(value, list) or any(not isinstance(i, str) for i in value):
            raise ValueError(f"{key} must be exercise IDs")
        return tuple(dict.fromkeys(value))

    return PlanningIntent(
        focus=str(focus),
        goal=str(answers.get("goal") or "General Fitness"),
        duration_minutes=answers.get("duration")
        if isinstance(answers.get("duration"), int)
        else profile.preferred_duration_minutes or 45,
        intensity=str(answers.get("intensity") or "Moderate"),
        variety=str(answers.get("variety") or "balanced").lower(),
        seed=answers.get("seed", 0),
        required=ids("required_exercises"),
        excluded=ids("excluded_exercises"),
        preferred=ids("preferred_exercises"),
        provenance="explicit" if answers.get("focus") else "default",
    )


def normalize_session_preferences(value: object) -> dict:
    if not isinstance(value, dict) or len(value) > 7:
        raise ValueError('Session preferences must be keyed by ordered day number')
    normalized = {}
    allowed = {
        "required_exercises",
        "preferred_exercises",
        "excluded_exercises",
        "intensity",
        "duration",
    }
    for key, overrides in value.items():
        if (
            key not in {str(i) for i in range(1, 8)}
            or not isinstance(overrides, dict)
            or set(overrides) - allowed
        ):
            raise ValueError('Unsupported session preference')
        for field in ("required_exercises", "preferred_exercises", "excluded_exercises"):
            if field in overrides and (
                not isinstance(overrides[field], list)
                or any(not isinstance(i, str) for i in overrides[field])
            ):
                raise ValueError('Exercise preferences must be lists of IDs')
        normalized[key] = effective_answers(overrides)
    return normalized


def context_digest(profile: Any, data: Any) -> str:
    """Exclude private conversations/keys; include all mutable planning inputs."""
    profile_data = profile.to_dict()
    for key in ("ai_conversation", "coaching_conversations"):
        profile_data.pop(key, None)
    gym = next((g.to_dict() for g in data.gym_profiles if g.id == profile.gym_profile_id), None)
    payload = {
        "version": ENGINE_VERSION,
        "athlete": profile_data,
        "gym": gym,
        "history": [w.to_dict() for w in data.workouts if w.profile_id == profile.id],
    }
    return sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def chat_answers(message: str, fallback_focus: str = "Full Body") -> dict:
    """Bounded explicit text extraction; never retain the private chat in metadata."""
    from .workout_planner import focus_name

    recognized = re.findall(
        r"\b(chest|back|biceps|triceps|legs?|shoulders|arms|core|forearms|grip|"
        r"upper|lower|push|pull|full body)\b",
        message.lower(),
    )
    recognized = ["legs" if token == "leg" else token for token in recognized]
    answers = {
        "focus": " / ".join(dict.fromkeys(recognized))
        + (" isolation" if "isolation" in message.lower() else "")
        if recognized
        else focus_name(fallback_focus)
    }
    duration = re.search(r"\b(\d{1,3})\s*(?:minutes?|mins?)\b", message.lower())
    if duration:
        answers["duration"] = int(duration.group(1))
    if "stronger" in message.lower() or "strength" in message.lower():
        answers["goal"] = "Get Stronger"
    if "floor press" in message.lower():
        answers["preferred_exercises"] = [
            "single_arm_dumbbell_floor_press"
            if "dumbbell" in message.lower()
            else "floor_press"
        ]
        if re.search(r'\b(must|required|include)\b.{0,30}floor press', message.lower()):
            answers['required_exercises'] = answers.pop('preferred_exercises')
    return answers


def authored_chat_program(message: str) -> dict | None:
    """Explicit ordered days become a program contract rather than one loose focus."""
    parts = re.split(r'\bday\s*[1-7]\s*[:.\-]?\s*', message, flags=re.IGNORECASE)[1:]
    if not 2 <= len(parts) <= 7:
        return None
    focuses = []
    preferences = {}
    for index, part in enumerate(parts, 1):
        answers = chat_answers(part)
        if answers['focus'] == 'full body' and 'full body' not in part.lower():
            return None
        focuses.append(answers["focus"])
        preferences[str(index)] = {
            key: answers[key]
            for key in ("preferred_exercises", "required_exercises")
            if key in answers
        }
    prefill = {'split': 'Custom Split', 'custom_split_days': ' | '.join(focuses),
               'lifting_days': len(focuses), 'running_days': 0, 'session_preferences': preferences}
    duration = re.search(r'\b(\d{1,3})\s*(?:minutes?|mins?)\b', message.lower())
    if duration:
        prefill['duration'] = int(duration.group(1))
    return {'type': 'start_builder', 'builder': 'program', 'prefill': prefill}
