"""Explicit supported resistance-training splits and session progression."""
from __future__ import annotations

SPLITS: dict[str, tuple[str, ...]] = {
    "full body": ("Full Body",),
    "upper/lower": ("Upper", "Lower"),
    "upper/lower/push/pull": ("Upper", "Lower", "Push", "Pull"),
    "push/pull/legs": ("Push", "Pull", "Legs"),
    "arnold": ("Chest/Back", "Shoulders/Arms", "Legs"),
    "body part": ("Chest", "Back", "Shoulders", "Legs", "Arms"),
    "phul": ("Power Upper", "Power Lower", "Hypertrophy Upper", "Hypertrophy Lower"),
    "phat": (
        "Power Upper", "Power Lower", "Hypertrophy Back/Shoulders",
        "Hypertrophy Legs", "Hypertrophy Chest/Arms",
    ),
    "ppl+upper/lower": ("Push", "Pull", "Legs", "Upper", "Lower"),
    "strength+conditioning": ("Full Body", "Upper", "Lower"),
    "powerlifting hybrid": (
        "Chest/Triceps", "Back/Biceps", "Legs",
        "Chest/Biceps Isolation", "Arms/Forearms/Grip",
    ),
}

ALIASES = {
    "upper / lower": "upper/lower",
    "upper lower": "upper/lower",
    "push / pull / legs": "push/pull/legs",
    "ppl": "push/pull/legs",
    "arnold split": "arnold",
    "bro split": "body part",
    "body-part split": "body part",
    "body part split": "body part",
    "ppl / upper / lower": "ppl+upper/lower",
    "upper / lower / push / pull": "upper/lower/push/pull",
    "hybrid ppl + upper/lower": "ppl+upper/lower",
    "strength-focused": "strength+conditioning",
    "strength + conditioning": "strength+conditioning",
    "powerlifting hybrid split": "powerlifting hybrid",
    "chest/tri back/bi legs chest/bi arms": "powerlifting hybrid",
}


def normalize_split(value: str | None, lifting_days: int) -> str:
    """Resolve declared split, or choose a predictable frequency-based default."""
    raw = (value or "").strip().lower()
    raw = ALIASES.get(raw, raw)
    if raw in SPLITS:
        return raw
    if raw and raw not in {"geoffrey decide", "other"}:
        raise ValueError(f"Unsupported training split: {value}")
    if lifting_days <= 2:
        return "full body"
    if lifting_days == 3:
        return "push/pull/legs"
    return "upper/lower"


def custom_split_focuses(value: object, lifting_days: int) -> list[str]:
    """Validate a user-defined ordered rotation of lifting session focuses."""
    if not isinstance(value, str):
        raise ValueError("Enter the custom split's workout days")
    days = [part.strip() for part in value.split("|")]
    if len(days) != lifting_days or not 1 <= len(days) <= 7:
        raise ValueError("Custom split must have one focus per lifting day")
    if any(not day or len(day) > 60 for day in days):
        raise ValueError("Each custom split day needs a focus of up to 60 characters")
    supported = {
        "full body", "upper", "lower", "push", "pull", "legs",
        "chest", "back", "shoulders", "arms", "biceps", "triceps",
        "forearms", "grip", "power", "hypertrophy", "isolation",
        "focused", "strength", "core",
    }
    for day in days:
        tokens = [
            token
            for token in day.lower()
            .replace("full body", "full_body")
            .replace("/", " ")
            .replace("&", " ")
            .replace("-", " ")
            .split()
            if token not in {"and", "day", "training"}
        ]
        if not tokens or any(token not in supported | {"full_body"} for token in tokens):
            raise ValueError(f"Unsupported custom split focus: {day}")
    return days


def split_focuses(
    split: str | None,
    lifting_days: int,
    offset: int = 0,
) -> list[str]:
    """Cycle through split focuses without skipping any phase."""
    normalized = normalize_split(split, lifting_days)
    cycle = SPLITS[normalized]
    return [cycle[(offset + index) % len(cycle)] for index in range(lifting_days)]


def session_focus(value: str) -> str:
    """Read a program's persisted focus names, including power/hypertrophy variants."""
    focus = value.strip().lower()
    if "grip" in focus or "forearm" in focus:
        return "arms/grip"
    if "chest" in focus and ("isolation" in focus or "focused" in focus):
        return "chest/biceps isolation" if "bi" in focus else "chest isolation"
    if "chest" in focus and ("tricep" in focus or "tri" in focus):
        return "chest/triceps"
    if "back" in focus and ("bicep" in focus or "bi" in focus):
        return "back/biceps"
    if "chest" in focus and "back" in focus:
        return "chest/back"
    if "shoulders" in focus and "arms" in focus:
        return "shoulders/arms"
    if "chest" in focus and "arms" in focus:
        return "chest/arms"
    if "back" in focus and "shoulders" in focus:
        return "back/shoulders"
    if "biceps" in focus and "triceps" in focus:
        return "arms/grip"
    if "upper" in focus:
        return "upper"
    if "lower" in focus:
        return "lower"
    if "chest" in focus and "biceps" in focus:
        return "chest/biceps"
    for token in ("biceps", "triceps", "core"):
        if token in focus:
            return token
    for token in ("push", "pull", "legs", "chest", "back", "shoulders", "arms"):
        if token in focus:
            return token
    return "full body"
