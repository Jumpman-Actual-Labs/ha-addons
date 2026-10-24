"""Dataclasses for the Hustle integration, ported from `hustle/db/models.py`.

Conventions:
- `new_id()` returns a UUID4 hex string (Stash's convention), replacing the
  original backend's hyphenated `str(uuid.uuid4())` - no migration needed
  since this is a fresh install.
- Monetary amounts stay signed integer cents (`*_cents`), same as the
  source backend.
- `created_at`/`updated_at` are kept as ISO datetime strings (unlike Stash,
  which skips them) because the dashboard/activity feed needs row-order
  sorting.
- Two relationship changes vs. the original schema:
  - `ChoreDefinition.prerequisite_ids` replaces the `chore_prerequisite`
    join table.
  - `Bounty.acceptances` and `Paycheck.line_items` nest their children
    rather than living in separate top-level lists. `BountyAcceptance` no
    longer has its own `id` - once nested it's addressed by the compound
    key (bounty_id, member_id) instead of a freestanding acceptance_id.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .const import (
    AcceptanceStatus,
    BehaviorCategory,
    BountyStatus,
    ChoreAssignmentStatus,
    MemberRole,
    OverdueAction,
    PaycheckStatus,
    PayPeriodStatus,
    PayrollRecurrence,
    PermissionLevel,
    RecurrenceType,
    SplitRule,
)


def new_id() -> str:
    return uuid.uuid4().hex


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


# --------------------------------------------------------------- household


@dataclass
class Household:
    id: str
    name: str
    currency: str = "USD"
    timezone: str = "UTC"
    setup_completed: bool = False
    notify_service: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "currency": self.currency,
            "timezone": self.timezone,
            "setup_completed": self.setup_completed,
            "notify_service": self.notify_service,
        }

    @staticmethod
    def from_dict(data: dict) -> Household:
        return Household(
            id=data["id"],
            name=data["name"],
            currency=data.get("currency", "USD"),
            timezone=data.get("timezone", "UTC"),
            setup_completed=data.get("setup_completed", False),
            notify_service=data.get("notify_service"),
        )


@dataclass
class PaydayRule:
    type: str  # "weekly" | "biweekly" | "monthly"
    day_of_week: str | None = None  # "MON".."SUN" - weekly/biweekly
    anchor_date: str | None = None  # "YYYY-MM-DD" - fixes biweekly parity
    day_of_month: int | None = None  # 1-28 - monthly

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "day_of_week": self.day_of_week,
            "anchor_date": self.anchor_date,
            "day_of_month": self.day_of_month,
        }

    @staticmethod
    def from_dict(data: dict) -> PaydayRule:
        return PaydayRule(
            type=data["type"],
            day_of_week=data.get("day_of_week"),
            anchor_date=data.get("anchor_date"),
            day_of_month=data.get("day_of_month"),
        )


@dataclass
class PayrollConfig:
    payday_rule: PaydayRule
    recurrence: PayrollRecurrence = PayrollRecurrence.WEEKLY
    requires_parent_approval: bool = True
    approval_threshold_cents: int | None = None
    auto_generate: bool = True
    pay_parents_too: bool = False
    default_initiative_bonus_pct: int = 30

    def to_dict(self) -> dict:
        return {
            "payday_rule": self.payday_rule.to_dict(),
            "recurrence": self.recurrence.value,
            "requires_parent_approval": self.requires_parent_approval,
            "approval_threshold_cents": self.approval_threshold_cents,
            "auto_generate": self.auto_generate,
            "pay_parents_too": self.pay_parents_too,
            "default_initiative_bonus_pct": self.default_initiative_bonus_pct,
        }

    @staticmethod
    def from_dict(data: dict) -> PayrollConfig:
        return PayrollConfig(
            payday_rule=PaydayRule.from_dict(data["payday_rule"]),
            recurrence=PayrollRecurrence(data.get("recurrence", PayrollRecurrence.WEEKLY.value)),
            requires_parent_approval=data.get("requires_parent_approval", True),
            approval_threshold_cents=data.get("approval_threshold_cents"),
            auto_generate=data.get("auto_generate", True),
            pay_parents_too=data.get("pay_parents_too", False),
            default_initiative_bonus_pct=data.get("default_initiative_bonus_pct", 30),
        )


# ------------------------------------------------------------------ member


@dataclass
class Member:
    id: str
    ha_user_id: str
    ha_display_name: str
    role: MemberRole
    permission_level: PermissionLevel | None = None
    active: bool = True
    date_of_birth: str | None = None  # "YYYY-MM-DD"
    avatar_color: str | None = None
    managed_child_ids: list[str] = field(default_factory=list)
    notify_target: str | None = None  # e.g. "notify.mobile_app_x"
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "ha_user_id": self.ha_user_id,
            "ha_display_name": self.ha_display_name,
            "role": self.role.value,
            "permission_level": self.permission_level.value if self.permission_level else None,
            "active": self.active,
            "date_of_birth": self.date_of_birth,
            "avatar_color": self.avatar_color,
            "managed_child_ids": self.managed_child_ids,
            "notify_target": self.notify_target,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> Member:
        permission_level = data.get("permission_level")
        return Member(
            id=data["id"],
            ha_user_id=data["ha_user_id"],
            ha_display_name=data["ha_display_name"],
            role=MemberRole(data["role"]),
            permission_level=PermissionLevel(permission_level) if permission_level else None,
            active=data.get("active", True),
            date_of_birth=data.get("date_of_birth"),
            avatar_color=data.get("avatar_color"),
            managed_child_ids=data.get("managed_child_ids", []),
            notify_target=data.get("notify_target"),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


# -------------------------------------------------------------------- chore


@dataclass
class ChoreDefinition:
    id: str
    household_id: str
    title: str
    description: str | None = None
    category: str | None = None
    payout_cents: int = 0
    recurrence_type: RecurrenceType = RecurrenceType.NONE
    recurrence_config: dict[str, Any] = field(default_factory=dict)
    is_bounty: bool = False  # each occurrence posts as an open bounty, never assigned to one child
    is_repeatable: bool = False  # only meaningful when is_bounty - see coordinator.py
    is_rotating: bool = False
    rotation_order: list[str] = field(default_factory=list)
    default_assignee_ids: list[str] = field(default_factory=list)
    age_min: int | None = None
    age_max: int | None = None
    requires_approval: bool = True
    active: bool = True
    prerequisite_ids: list[str] = field(default_factory=list)
    due_time: str | None = None  # "HH:MM"
    available_from_time: str | None = None  # "HH:MM" - unset means no lower bound
    available_until_time: str | None = None  # "HH:MM" - unset means no upper bound
    overdue_action: OverdueAction | None = None
    overdue_deduction_cents: int | None = None
    overdue_bounty_hours: int | None = None  # UI defaults to 5 when convert_to_bounty is picked
    overdue_penalty_pct: int | None = -50
    image_path: str | None = None  # "/local/hustle/<id>.png" once generated
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "household_id": self.household_id,
            "title": self.title,
            "description": self.description,
            "category": self.category,
            "payout_cents": self.payout_cents,
            "recurrence_type": self.recurrence_type.value,
            "recurrence_config": self.recurrence_config,
            "is_bounty": self.is_bounty,
            "is_repeatable": self.is_repeatable,
            "is_rotating": self.is_rotating,
            "rotation_order": self.rotation_order,
            "default_assignee_ids": self.default_assignee_ids,
            "age_min": self.age_min,
            "age_max": self.age_max,
            "requires_approval": self.requires_approval,
            "active": self.active,
            "prerequisite_ids": self.prerequisite_ids,
            "due_time": self.due_time,
            "available_from_time": self.available_from_time,
            "available_until_time": self.available_until_time,
            "overdue_action": self.overdue_action.value if self.overdue_action else None,
            "overdue_deduction_cents": self.overdue_deduction_cents,
            "overdue_bounty_hours": self.overdue_bounty_hours,
            "overdue_penalty_pct": self.overdue_penalty_pct,
            "image_path": self.image_path,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> ChoreDefinition:
        overdue_action = data.get("overdue_action")
        return ChoreDefinition(
            id=data["id"],
            household_id=data["household_id"],
            title=data["title"],
            description=data.get("description"),
            category=data.get("category"),
            payout_cents=data.get("payout_cents", 0),
            recurrence_type=RecurrenceType(data.get("recurrence_type", RecurrenceType.NONE.value)),
            recurrence_config=data.get("recurrence_config", {}),
            is_bounty=data.get("is_bounty", False),
            is_repeatable=data.get("is_repeatable", False),
            is_rotating=data.get("is_rotating", False),
            rotation_order=data.get("rotation_order", []),
            default_assignee_ids=data.get("default_assignee_ids", []),
            age_min=data.get("age_min"),
            age_max=data.get("age_max"),
            requires_approval=data.get("requires_approval", True),
            active=data.get("active", True),
            prerequisite_ids=data.get("prerequisite_ids", []),
            due_time=data.get("due_time"),
            available_from_time=data.get("available_from_time"),
            available_until_time=data.get("available_until_time"),
            overdue_action=OverdueAction(overdue_action) if overdue_action else None,
            overdue_deduction_cents=data.get("overdue_deduction_cents"),
            overdue_bounty_hours=data.get("overdue_bounty_hours"),
            overdue_penalty_pct=data.get("overdue_penalty_pct", -50),
            image_path=data.get("image_path"),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


@dataclass
class ChoreAssignment:
    id: str
    chore_definition_id: str
    member_id: str
    due_date: str  # "YYYY-MM-DD"
    payout_cents: int
    status: ChoreAssignmentStatus = ChoreAssignmentStatus.ASSIGNED
    due_time: str | None = None  # "HH:MM", snapshotted from definition at assignment time
    available_from_time: str | None = None  # "HH:MM", snapshotted from definition
    available_until_time: str | None = None  # "HH:MM", snapshotted from definition
    submitted_at: str | None = None
    approved_by_member_id: str | None = None
    approved_at: str | None = None
    rejection_reason: str | None = None
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "chore_definition_id": self.chore_definition_id,
            "member_id": self.member_id,
            "due_date": self.due_date,
            "payout_cents": self.payout_cents,
            "status": self.status.value,
            "due_time": self.due_time,
            "available_from_time": self.available_from_time,
            "available_until_time": self.available_until_time,
            "submitted_at": self.submitted_at,
            "approved_by_member_id": self.approved_by_member_id,
            "approved_at": self.approved_at,
            "rejection_reason": self.rejection_reason,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> ChoreAssignment:
        return ChoreAssignment(
            id=data["id"],
            chore_definition_id=data["chore_definition_id"],
            member_id=data["member_id"],
            due_date=data["due_date"],
            payout_cents=data["payout_cents"],
            status=ChoreAssignmentStatus(data.get("status", ChoreAssignmentStatus.ASSIGNED.value)),
            due_time=data.get("due_time"),
            available_from_time=data.get("available_from_time"),
            available_until_time=data.get("available_until_time"),
            submitted_at=data.get("submitted_at"),
            approved_by_member_id=data.get("approved_by_member_id"),
            approved_at=data.get("approved_at"),
            rejection_reason=data.get("rejection_reason"),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


# ------------------------------------------------------------------ bounty


@dataclass
class BountyAcceptance:
    """Nested under Bounty.acceptances - no standalone id.

    Addressed by the compound key (bounty_id, member_id). Flag for the
    frontend phase: this is a breaking shape change vs. the original API,
    which exposed a freestanding acceptance_id.
    """

    member_id: str
    status: AcceptanceStatus = AcceptanceStatus.ACCEPTED
    accepted_at: str = field(default_factory=now_iso)
    submitted_at: str | None = None
    completed_at: str | None = None
    approved_by_member_id: str | None = None
    payout_cents: int | None = None

    def to_dict(self) -> dict:
        return {
            "member_id": self.member_id,
            "status": self.status.value,
            "accepted_at": self.accepted_at,
            "submitted_at": self.submitted_at,
            "completed_at": self.completed_at,
            "approved_by_member_id": self.approved_by_member_id,
            "payout_cents": self.payout_cents,
        }

    @staticmethod
    def from_dict(data: dict) -> BountyAcceptance:
        return BountyAcceptance(
            member_id=data["member_id"],
            status=AcceptanceStatus(data.get("status", AcceptanceStatus.ACCEPTED.value)),
            accepted_at=data.get("accepted_at", now_iso()),
            submitted_at=data.get("submitted_at"),
            completed_at=data.get("completed_at"),
            approved_by_member_id=data.get("approved_by_member_id"),
            payout_cents=data.get("payout_cents"),
        )


@dataclass
class Bounty:
    id: str
    household_id: str
    title: str
    payout_cents: int
    available_at: str  # ISO datetime
    deadline_at: str  # ISO datetime
    created_by_member_id: str
    description: str | None = None
    source_chore_definition_id: str | None = None
    initiative_bonus_pct: int = 30
    estimated_minutes: int | None = None
    requires_approval: bool = True
    split_rule: SplitRule = SplitRule.FIRST_COME
    status: BountyStatus = BountyStatus.OPEN
    acceptances: list[BountyAcceptance] = field(default_factory=list)
    original_assignee_member_id: str | None = None
    overdue_penalty_pct: int | None = None
    # When a repeatable bounty gets its first completion, it closes like any
    # other and a fresh clone (same fields, empty acceptances) opens in its
    # place - see coordinator._respawn_repeatable_bounty - so the same or a
    # different kid can complete it again, e.g. "Read a book" once per book.
    is_repeatable: bool = False
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "household_id": self.household_id,
            "title": self.title,
            "description": self.description,
            "source_chore_definition_id": self.source_chore_definition_id,
            "payout_cents": self.payout_cents,
            "initiative_bonus_pct": self.initiative_bonus_pct,
            "available_at": self.available_at,
            "deadline_at": self.deadline_at,
            "estimated_minutes": self.estimated_minutes,
            "requires_approval": self.requires_approval,
            "split_rule": self.split_rule.value,
            "status": self.status.value,
            "created_by_member_id": self.created_by_member_id,
            "acceptances": [a.to_dict() for a in self.acceptances],
            "original_assignee_member_id": self.original_assignee_member_id,
            "overdue_penalty_pct": self.overdue_penalty_pct,
            "is_repeatable": self.is_repeatable,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> Bounty:
        return Bounty(
            id=data["id"],
            household_id=data["household_id"],
            title=data["title"],
            description=data.get("description"),
            source_chore_definition_id=data.get("source_chore_definition_id"),
            payout_cents=data["payout_cents"],
            initiative_bonus_pct=data.get("initiative_bonus_pct", 30),
            available_at=data["available_at"],
            deadline_at=data["deadline_at"],
            estimated_minutes=data.get("estimated_minutes"),
            requires_approval=data.get("requires_approval", True),
            split_rule=SplitRule(data.get("split_rule", SplitRule.FIRST_COME.value)),
            status=BountyStatus(data.get("status", BountyStatus.OPEN.value)),
            created_by_member_id=data["created_by_member_id"],
            acceptances=[BountyAcceptance.from_dict(a) for a in data.get("acceptances", [])],
            original_assignee_member_id=data.get("original_assignee_member_id"),
            overdue_penalty_pct=data.get("overdue_penalty_pct"),
            is_repeatable=data.get("is_repeatable", False),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


# ------------------------------------------------------------------ grades


@dataclass
class Subject:
    id: str
    household_id: str
    name: str
    active: bool = True
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "household_id": self.household_id,
            "name": self.name,
            "active": self.active,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> Subject:
        return Subject(
            id=data["id"],
            household_id=data["household_id"],
            name=data["name"],
            active=data.get("active", True),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


@dataclass
class GradeScaleEntry:
    letter: str
    value_cents: int
    sort_order: int = 0

    def to_dict(self) -> dict:
        return {
            "letter": self.letter,
            "value_cents": self.value_cents,
            "sort_order": self.sort_order,
        }

    @staticmethod
    def from_dict(data: dict) -> GradeScaleEntry:
        return GradeScaleEntry(
            letter=data["letter"],
            value_cents=data["value_cents"],
            sort_order=data.get("sort_order", 0),
        )


@dataclass
class GradeEntry:
    id: str
    subject_id: str
    member_id: str
    grade_letter: str
    grade_value_cents: int
    period_label: str
    entered_by_member_id: str
    note: str | None = None
    entered_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "subject_id": self.subject_id,
            "member_id": self.member_id,
            "grade_letter": self.grade_letter,
            "grade_value_cents": self.grade_value_cents,
            "period_label": self.period_label,
            "note": self.note,
            "entered_by_member_id": self.entered_by_member_id,
            "entered_at": self.entered_at,
        }

    @staticmethod
    def from_dict(data: dict) -> GradeEntry:
        return GradeEntry(
            id=data["id"],
            subject_id=data["subject_id"],
            member_id=data["member_id"],
            grade_letter=data["grade_letter"],
            grade_value_cents=data["grade_value_cents"],
            period_label=data["period_label"],
            note=data.get("note"),
            entered_by_member_id=data["entered_by_member_id"],
            entered_at=data.get("entered_at", now_iso()),
        )


# ---------------------------------------------------------------- behavior


@dataclass
class BehaviorType:
    id: str
    household_id: str
    label: str
    category: BehaviorCategory
    default_amount_cents: int
    icon: str | None = None
    active: bool = True
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "household_id": self.household_id,
            "label": self.label,
            "category": self.category.value,
            "default_amount_cents": self.default_amount_cents,
            "icon": self.icon,
            "active": self.active,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> BehaviorType:
        return BehaviorType(
            id=data["id"],
            household_id=data["household_id"],
            label=data["label"],
            category=BehaviorCategory(data["category"]),
            default_amount_cents=data["default_amount_cents"],
            icon=data.get("icon"),
            active=data.get("active", True),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


@dataclass
class BehaviorEntry:
    id: str
    behavior_type_id: str
    member_id: str
    amount_cents: int  # signed - deductions are negative
    recorded_by_member_id: str
    note: str | None = None
    recorded_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "behavior_type_id": self.behavior_type_id,
            "member_id": self.member_id,
            "amount_cents": self.amount_cents,
            "note": self.note,
            "recorded_by_member_id": self.recorded_by_member_id,
            "recorded_at": self.recorded_at,
        }

    @staticmethod
    def from_dict(data: dict) -> BehaviorEntry:
        return BehaviorEntry(
            id=data["id"],
            behavior_type_id=data["behavior_type_id"],
            member_id=data["member_id"],
            amount_cents=data["amount_cents"],
            note=data.get("note"),
            recorded_by_member_id=data["recorded_by_member_id"],
            recorded_at=data.get("recorded_at", now_iso()),
        )


# ----------------------------------------------------------------- payroll


@dataclass
class PayPeriod:
    id: str
    household_id: str
    start_date: str  # "YYYY-MM-DD"
    end_date: str
    payday_date: str
    status: PayPeriodStatus = PayPeriodStatus.OPEN
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "household_id": self.household_id,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "payday_date": self.payday_date,
            "status": self.status.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> PayPeriod:
        return PayPeriod(
            id=data["id"],
            household_id=data["household_id"],
            start_date=data["start_date"],
            end_date=data["end_date"],
            payday_date=data["payday_date"],
            status=PayPeriodStatus(data.get("status", PayPeriodStatus.OPEN.value)),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


@dataclass
class PaycheckLineItem:
    """Nested under Paycheck.line_items - no standalone id, addressed only
    through its parent paycheck (mirrors how the original backend only ever
    accessed these via paycheck_service.list_line_items)."""

    earning_source_type: str
    source_ref_id: str
    description: str
    amount_cents: int
    line_metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "earning_source_type": self.earning_source_type,
            "source_ref_id": self.source_ref_id,
            "description": self.description,
            "amount_cents": self.amount_cents,
            "line_metadata": self.line_metadata,
        }

    @staticmethod
    def from_dict(data: dict) -> PaycheckLineItem:
        return PaycheckLineItem(
            earning_source_type=data["earning_source_type"],
            source_ref_id=data["source_ref_id"],
            description=data["description"],
            amount_cents=data["amount_cents"],
            line_metadata=data.get("line_metadata", {}),
        )


@dataclass
class Paycheck:
    id: str
    pay_period_id: str
    member_id: str
    gross_cents: int = 0
    net_cents: int = 0
    status: PaycheckStatus = PaycheckStatus.DRAFT
    approved_by_member_id: str | None = None
    approved_at: str | None = None
    paid_at: str | None = None
    line_items: list[PaycheckLineItem] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "pay_period_id": self.pay_period_id,
            "member_id": self.member_id,
            "gross_cents": self.gross_cents,
            "net_cents": self.net_cents,
            "status": self.status.value,
            "approved_by_member_id": self.approved_by_member_id,
            "approved_at": self.approved_at,
            "paid_at": self.paid_at,
            "line_items": [li.to_dict() for li in self.line_items],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> Paycheck:
        return Paycheck(
            id=data["id"],
            pay_period_id=data["pay_period_id"],
            member_id=data["member_id"],
            gross_cents=data.get("gross_cents", 0),
            net_cents=data.get("net_cents", 0),
            status=PaycheckStatus(data.get("status", PaycheckStatus.DRAFT.value)),
            approved_by_member_id=data.get("approved_by_member_id"),
            approved_at=data.get("approved_at"),
            paid_at=data.get("paid_at"),
            line_items=[PaycheckLineItem.from_dict(li) for li in data.get("line_items", [])],
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


# --------------------------------------------------------------- activity


@dataclass
class ActivityEntry:
    """One entry in the capped recent_activity ring buffer - replaces
    `notification_log`'s append-forever table (see storage.py schema notes)."""

    id: str
    event_type: str
    title: str
    message: str
    member_id: str | None = None
    amount_cents: int | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    occurred_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "event_type": self.event_type,
            "title": self.title,
            "message": self.message,
            "member_id": self.member_id,
            "amount_cents": self.amount_cents,
            "payload": self.payload,
            "occurred_at": self.occurred_at,
        }

    @staticmethod
    def from_dict(data: dict) -> ActivityEntry:
        return ActivityEntry(
            id=data["id"],
            event_type=data["event_type"],
            title=data["title"],
            message=data["message"],
            member_id=data.get("member_id"),
            amount_cents=data.get("amount_cents"),
            payload=data.get("payload", {}),
            occurred_at=data.get("occurred_at", now_iso()),
        )
