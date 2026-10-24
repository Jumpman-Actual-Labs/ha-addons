from __future__ import annotations

from enum import StrEnum

DOMAIN = "hustle"
STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}_data"

SIGNAL_HUSTLE_UPDATED = f"{DOMAIN}_updated"

SCHEDULER_INTERVAL_MINUTES = 5

# Ring buffer cap for recent_activity (replaces notification_log's
# append-forever table - see storage.py schema notes).
RECENT_ACTIVITY_LIMIT = 200

# Fixed chore category list (frontend dropdown + service validation).
# ChoreDefinition.category stays a plain str on the model (not an enum) so
# chores created before this list existed, or with a category later removed
# from the list, still load fine - only new writes are validated against it.
CHORE_CATEGORIES: list[str] = [
    "Bedroom",
    "Kitchen",
    "Bathroom",
    "Living Areas",
    "Laundry",
    "Trash & Recycling",
    "Yard Work",
    "School & Homework",
    "Playroom",
    "Maintenance",
    "Errands",
    "Personal Responsibility",
    "Seasonal",
    "Special Projects",
]


class MemberRole(StrEnum):
    PARENT = "parent"
    CHILD = "child"


class PermissionLevel(StrEnum):
    ADMIN = "admin"
    STANDARD = "standard"


class RecurrenceType(StrEnum):
    NONE = "none"
    DAILY = "daily"
    WEEKLY = "weekly"
    CUSTOM_CRON = "custom_cron"
    BIWEEKLY = "biweekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"


class OverdueAction(StrEnum):
    REMOVE = "remove"
    CONVERT_TO_BOUNTY = "convert_to_bounty"
    DEDUCT = "deduct"


class ChoreAssignmentStatus(StrEnum):
    ASSIGNED = "assigned"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"


class SplitRule(StrEnum):
    FIRST_COME = "first_come"
    EQUAL_SPLIT = "equal_split"
    PARENT_DECIDES = "parent_decides"


class BountyStatus(StrEnum):
    OPEN = "open"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    CLOSED = "closed"


class AcceptanceStatus(StrEnum):
    ACCEPTED = "accepted"
    SUBMITTED = "submitted"
    COMPLETED = "completed"
    ABANDONED = "abandoned"


class BehaviorCategory(StrEnum):
    BONUS = "bonus"
    DEDUCTION = "deduction"


class PayrollRecurrence(StrEnum):
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    MONTHLY = "monthly"


class PayPeriodStatus(StrEnum):
    OPEN = "open"
    GENERATED = "generated"
    APPROVED = "approved"
    PAID = "paid"


class PaycheckStatus(StrEnum):
    DRAFT = "draft"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    PAID = "paid"


DEFAULT_GRADE_VALUES_CENTS: dict[str, int] = {"A": 500, "B": 300, "C": 100, "D": 0, "F": 0}
_GRADE_SORT_ORDER = {"A": 0, "B": 1, "C": 2, "D": 3, "F": 4}

WEEKDAY_CODES: list[str] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
