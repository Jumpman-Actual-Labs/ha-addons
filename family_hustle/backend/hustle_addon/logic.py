"""Pure business logic for the Hustle integration.

Deliberately free of any Home Assistant imports so it can be unit tested in
plain pytest, without the HA test harness. Ported from the FastAPI backend's
service-layer pure functions (pay_period_service._compute_period,
bounty_split_service.py, recurrence_service._due_dates_for,
chore_service.check_prerequisites/next_rotation_assignee,
member_service._next_permission_level, payroll/engine.py +
payroll/earning_sources/*.py, report_service.py) with DB queries replaced by
list comprehensions over in-memory dataclasses.
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, time, timedelta
from typing import Any

from .const import (
    WEEKDAY_CODES,
    AcceptanceStatus,
    BountyStatus,
    ChoreAssignmentStatus,
    MemberRole,
    PermissionLevel,
    RecurrenceType,
    SplitRule,
)
from .models import (
    BehaviorEntry,
    BehaviorType,
    Bounty,
    BountyAcceptance,
    ChoreAssignment,
    ChoreDefinition,
    GradeEntry,
    Member,
    Paycheck,
    PaydayRule,
    PayPeriod,
    PayrollConfig,
    Subject,
)

# ---------------------------------------------------------------------------
# Pay period boundary math (ported from pay_period_service._compute_period)
# ---------------------------------------------------------------------------


def compute_period(
    payday_rule: PaydayRule, recurrence: str, as_of: date
) -> tuple[date, date, date]:
    """Returns (start_date, end_date, payday_date) for the period containing as_of.

    Every period ends ON the payday (period = the stretch of work being
    paid for), consistent across all three recurrence types.
    """
    if recurrence == "weekly":
        weekday = WEEKDAY_CODES.index(payday_rule.day_of_week or "FRI")
        days_until = (weekday - as_of.weekday()) % 7
        payday = as_of + timedelta(days=days_until)
        return payday - timedelta(days=6), payday, payday

    if recurrence == "biweekly":
        weekday = WEEKDAY_CODES.index(payday_rule.day_of_week or "FRI")
        anchor = date.fromisoformat(payday_rule.anchor_date) if payday_rule.anchor_date else as_of
        # Normalize the anchor onto the configured weekday so cycles line up
        # even if the stored anchor isn't exactly on that weekday.
        anchor -= timedelta(days=(anchor.weekday() - weekday) % 7)

        delta_days = (as_of - anchor).days
        cycles = -(-delta_days // 14)  # ceil division, correct for negatives too
        payday = anchor + timedelta(days=cycles * 14)
        return payday - timedelta(days=13), payday, payday

    if recurrence == "monthly":
        day_of_month = payday_rule.day_of_month or 1
        last_day = calendar.monthrange(as_of.year, as_of.month)[1]
        payday = date(as_of.year, as_of.month, min(day_of_month, last_day))
        start = date(as_of.year, as_of.month, 1)
        end = date(as_of.year, as_of.month, last_day)
        return start, end, payday

    raise ValueError(f"Unsupported payroll recurrence: {recurrence}")


def period_datetime_bounds(period: PayPeriod) -> tuple[datetime, datetime]:
    """Converts a PayPeriod's date-only boundaries into an inclusive
    [start, end] naive datetime range for comparing against timestamped
    records like `approved_at`/`completed_at` (stored as ISO strings)."""
    start = datetime.combine(date.fromisoformat(period.start_date), time.min)
    end = datetime.combine(date.fromisoformat(period.end_date), time.max)
    return start, end


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    # Normalize both naive and offset-aware ISO strings to naive UTC-ish
    # values for simple range comparisons; callers only compare within the
    # same representation family (all produced by models.now_iso()).
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt


def _in_bounds(
    timestamp: str | None, start: datetime, end: datetime, since: str | None = None
) -> bool:
    parsed = _parse_iso(timestamp)
    cutoff = _parse_iso(since)
    return (
        parsed is not None and start <= parsed <= end
        and (cutoff is None or parsed > cutoff)
    )


# ---------------------------------------------------------------------------
# Bounty split resolution (ported from bounty_split_service.py)
# ---------------------------------------------------------------------------


def total_payout_cents(bounty: Bounty) -> int:
    bonus = (bounty.payout_cents * bounty.initiative_bonus_pct) // 100
    return bounty.payout_cents + bonus


def resolve_payout(bounty: Bounty, completions: list[BountyAcceptance]) -> dict[str, int]:
    """Returns {member_id: payout_cents} for members who should be paid.

    For `parent_decides`, returns {} - a parent must call the explicit
    finalize-split action instead.
    """
    if not completions:
        return {}

    total = total_payout_cents(bounty)

    if bounty.split_rule == SplitRule.FIRST_COME:
        first = min(completions, key=lambda c: c.completed_at or c.submitted_at or c.accepted_at)
        return {c.member_id: (total if c.member_id == first.member_id else 0) for c in completions}

    if bounty.split_rule == SplitRule.EQUAL_SPLIT:
        share, remainder = divmod(total, len(completions))
        ordered = sorted(completions, key=lambda c: c.member_id)
        return {c.member_id: share + (1 if i < remainder else 0) for i, c in enumerate(ordered)}

    return {}


# ---------------------------------------------------------------------------
# Recurrence date math (ported from recurrence_service._due_dates_for)
# ---------------------------------------------------------------------------


def due_dates_for(definition: ChoreDefinition, start: date, end: date) -> list[date]:
    dates: list[date] = []
    cursor = start

    if definition.recurrence_type == RecurrenceType.DAILY:
        while cursor <= end:
            dates.append(cursor)
            cursor += timedelta(days=1)

    elif definition.recurrence_type == RecurrenceType.WEEKLY:
        days_of_week = set(definition.recurrence_config.get("days_of_week", []))
        while cursor <= end:
            if WEEKDAY_CODES[cursor.weekday()] in days_of_week:
                dates.append(cursor)
            cursor += timedelta(days=1)

    elif definition.recurrence_type == RecurrenceType.CUSTOM_CRON:
        interval = definition.recurrence_config.get("interval_days")
        anchor = definition.recurrence_config.get("anchor_date")
        if interval and anchor:
            anchor_date = date.fromisoformat(anchor)
            while cursor <= end:
                if cursor >= anchor_date and (cursor - anchor_date).days % interval == 0:
                    dates.append(cursor)
                cursor += timedelta(days=1)

    elif definition.recurrence_type == RecurrenceType.BIWEEKLY:
        anchor = definition.recurrence_config.get("anchor_date")
        if anchor:
            anchor_date = date.fromisoformat(anchor)
            while cursor <= end:
                if cursor >= anchor_date and (cursor - anchor_date).days % 14 == 0:
                    dates.append(cursor)
                cursor += timedelta(days=1)

    elif definition.recurrence_type == RecurrenceType.MONTHLY:
        day_of_month = definition.recurrence_config.get("day_of_month")
        if day_of_month:
            while cursor <= end:
                last_day = calendar.monthrange(cursor.year, cursor.month)[1]
                if cursor.day == min(day_of_month, last_day):
                    dates.append(cursor)
                cursor += timedelta(days=1)

    elif definition.recurrence_type == RecurrenceType.QUARTERLY:
        anchor = definition.recurrence_config.get("anchor_date")
        if anchor:
            anchor_date = date.fromisoformat(anchor)
            day_of_month = anchor_date.day
            while cursor <= end:
                last_day = calendar.monthrange(cursor.year, cursor.month)[1]
                months_since_anchor = (cursor.year - anchor_date.year) * 12 + (
                    cursor.month - anchor_date.month
                )
                if (
                    cursor >= anchor_date
                    and months_since_anchor % 3 == 0
                    and cursor.day == min(day_of_month, last_day)
                ):
                    dates.append(cursor)
                cursor += timedelta(days=1)

    return dates


# ---------------------------------------------------------------------------
# Overdue chore handling (new per the overdue-handling feature batch)
# ---------------------------------------------------------------------------


def effective_due_datetime(due_date: str, due_time: str | None) -> datetime:
    """Combines a due date + optional "HH:MM" time into a single datetime,
    defaulting to end-of-day (23:59) when no time is set."""
    the_date = date.fromisoformat(due_date)
    if due_time:
        hour, minute = (int(part) for part in due_time.split(":"))
        return datetime.combine(the_date, time(hour, minute))
    return datetime.combine(the_date, time(23, 59))


def is_overdue(due_date: str, due_time: str | None, now: datetime) -> bool:
    due = effective_due_datetime(due_date, due_time)
    if now.tzinfo is not None:
        now = now.replace(tzinfo=None)
    return now > due


def is_within_availability_window(
    due_date: str,
    available_from_time: str | None,
    available_until_time: str | None,
    now: datetime,
) -> bool:
    """A chore assignment's availability window is time-of-day, applying on
    its own due_date - unset bounds mean no restriction on that side (e.g.
    only available_until_time set means "available any time up through
    that time on the due date")."""
    if now.tzinfo is not None:
        now = now.replace(tzinfo=None)
    if available_from_time:
        start = effective_due_datetime(due_date, available_from_time)
        if now < start:
            return False
    if available_until_time:
        end = effective_due_datetime(due_date, available_until_time)
        if now > end:
            return False
    return True


def resolve_overdue_bounty_payout(
    bounty: Bounty, completions: list[BountyAcceptance], penalty_pct: int
) -> dict[str, int]:
    """Thin wrapper around `resolve_payout`: normal split-rule math applies to
    everyone, except the original assignee (if she's the one who ended up
    completing it, i.e. she has a nonzero payout) gets her entry overridden
    to a penalty - `bounty.payout_cents * penalty_pct // 100` (negative)."""
    payouts = resolve_payout(bounty, completions)
    original_assignee = bounty.original_assignee_member_id
    if original_assignee is not None and payouts.get(original_assignee):
        payouts[original_assignee] = bounty.payout_cents * penalty_pct // 100
    return payouts


# ---------------------------------------------------------------------------
# Chore prerequisite / rotation logic (ported from chore_service.py)
# ---------------------------------------------------------------------------


def check_prerequisites(
    definition: ChoreDefinition, member_id: str, all_assignments: list[ChoreAssignment]
) -> bool:
    """Whether member_id has completed every prerequisite chore for definition.

    Returns True (satisfied) when there are no prerequisites.
    """
    if not definition.prerequisite_ids:
        return True
    completed_ids = {
        a.chore_definition_id
        for a in all_assignments
        if a.member_id == member_id and a.status == ChoreAssignmentStatus.APPROVED
    }
    return set(definition.prerequisite_ids) <= completed_ids


def next_rotation_assignee(
    definition: ChoreDefinition, all_assignments: list[ChoreAssignment]
) -> str:
    if not definition.rotation_order:
        raise ValueError(
            "This chore is marked as rotating but has no rotation order configured."
        )
    existing_count = sum(1 for a in all_assignments if a.chore_definition_id == definition.id)
    index = existing_count % len(definition.rotation_order)
    return definition.rotation_order[index]


# ---------------------------------------------------------------------------
# Permission level (ported from member_service._next_permission_level)
# ---------------------------------------------------------------------------


def next_permission_level(
    role: MemberRole, requested: PermissionLevel | None, existing_parent_count: int
) -> PermissionLevel | None:
    if role != MemberRole.PARENT:
        return None
    if requested:
        return requested
    return PermissionLevel.ADMIN


# ---------------------------------------------------------------------------
# Payroll: earning collectors (ported from payroll/earning_sources/*.py)
# ---------------------------------------------------------------------------


def collect_chore_earnings(
    assignments: list[ChoreAssignment],
    chore_definitions: list[ChoreDefinition],
    member_id: str,
    period: PayPeriod,
    since: str | None = None,
) -> list[dict[str, Any]]:
    start, end = period_datetime_bounds(period)
    definitions_by_id = {d.id: d for d in chore_definitions}
    lines = []
    for assignment in assignments:
        if assignment.member_id != member_id:
            continue
        if assignment.status != ChoreAssignmentStatus.APPROVED:
            continue
        if not _in_bounds(assignment.approved_at, start, end, since):
            continue
        definition = definitions_by_id.get(assignment.chore_definition_id)
        title = definition.title if definition else "Unknown chore"
        lines.append(
            {
                "source_type": "chore",
                "source_ref_id": assignment.id,
                "member_id": member_id,
                "description": f"Chore: {title} ({assignment.due_date})",
                "amount_cents": assignment.payout_cents,
                "metadata": {
                    "chore_definition_id": assignment.chore_definition_id,
                    "due_date": assignment.due_date,
                },
            }
        )
    return lines


def collect_bounty_earnings(
    bounties: list[Bounty], member_id: str, period: PayPeriod,
    since: str | None = None,
) -> list[dict[str, Any]]:
    start, end = period_datetime_bounds(period)
    lines = []
    for bounty in bounties:
        for acceptance in bounty.acceptances:
            if acceptance.member_id != member_id:
                continue
            if acceptance.status != AcceptanceStatus.COMPLETED:
                continue
            if acceptance.payout_cents is None:
                continue
            if not _in_bounds(acceptance.completed_at, start, end, since):
                continue
            lines.append(
                {
                    "source_type": "bounty",
                    "source_ref_id": f"{bounty.id}:{acceptance.member_id}",
                    "member_id": member_id,
                    "description": f"Bounty: {bounty.title}",
                    "amount_cents": acceptance.payout_cents or 0,
                    "metadata": {"bounty_id": bounty.id},
                }
            )
    return lines


def collect_grade_earnings(
    grade_entries: list[GradeEntry], subjects: list[Subject], member_id: str, period: PayPeriod,
    since: str | None = None,
) -> list[dict[str, Any]]:
    start, end = period_datetime_bounds(period)
    subjects_by_id = {s.id: s for s in subjects}
    lines = []
    for entry in grade_entries:
        if entry.member_id != member_id:
            continue
        if not _in_bounds(entry.entered_at, start, end, since):
            continue
        subject = subjects_by_id.get(entry.subject_id)
        subject_name = subject.name if subject else "Unknown subject"
        lines.append(
            {
                "source_type": "grade",
                "source_ref_id": entry.id,
                "member_id": member_id,
                "description": f"Grade: {subject_name} ({entry.grade_letter})",
                "amount_cents": entry.grade_value_cents,
                "metadata": {"subject_id": entry.subject_id, "period_label": entry.period_label},
            }
        )
    return lines


def collect_behavior_earnings(
    behavior_entries: list[BehaviorEntry],
    behavior_types: list[BehaviorType],
    member_id: str,
    period: PayPeriod,
    since: str | None = None,
) -> list[dict[str, Any]]:
    start, end = period_datetime_bounds(period)
    types_by_id = {t.id: t for t in behavior_types}
    lines = []
    for entry in behavior_entries:
        if entry.member_id != member_id:
            continue
        if not _in_bounds(entry.recorded_at, start, end, since):
            continue
        behavior_type = types_by_id.get(entry.behavior_type_id)
        label = behavior_type.label if behavior_type else "Unknown"
        lines.append(
            {
                "source_type": "behavior",
                "source_ref_id": entry.id,
                "member_id": member_id,
                "description": label,
                "amount_cents": entry.amount_cents,
                "metadata": {"behavior_type_id": entry.behavior_type_id},
            }
        )
    return lines


def aggregate_paycheck(lines: list[dict[str, Any]]) -> tuple[int, int]:
    """Returns (gross_cents, net_cents) - gross sums positive lines only,
    net sums everything (deductions are negative)."""
    gross_cents = sum(line["amount_cents"] for line in lines if line["amount_cents"] > 0)
    net_cents = sum(line["amount_cents"] for line in lines)
    return gross_cents, net_cents


def requires_paycheck_approval(config: PayrollConfig, net_cents: int) -> bool:
    return config.requires_parent_approval and (
        config.approval_threshold_cents is None or net_cents > config.approval_threshold_cents
    )


# ---------------------------------------------------------------------------
# Report aggregations (ported from report_service.py)
# ---------------------------------------------------------------------------


def earnings_by_child(members: list[Member], paychecks: list[Paycheck]) -> list[dict[str, Any]]:
    children = [m for m in members if m.role == MemberRole.CHILD]
    totals: dict[str, int] = {m.id: 0 for m in children}
    for paycheck in paychecks:
        if paycheck.member_id in totals:
            totals[paycheck.member_id] += paycheck.net_cents
    return [
        {"member_id": m.id, "member_name": m.ha_display_name, "total_cents": totals[m.id]}
        for m in sorted(children, key=lambda m: m.ha_display_name)
    ]


def earnings_by_pay_period(
    pay_periods: list[PayPeriod], paychecks: list[Paycheck], n_periods: int = 12
) -> list[dict[str, Any]]:
    ordered = sorted(pay_periods, key=lambda p: p.end_date, reverse=True)[:n_periods]
    results = []
    for period in ordered:
        period_paychecks = [p for p in paychecks if p.pay_period_id == period.id]
        results.append(
            {
                "pay_period_id": period.id,
                "start_date": period.start_date,
                "end_date": period.end_date,
                "payday_date": period.payday_date,
                "total_gross_cents": sum(p.gross_cents for p in period_paychecks),
                "total_net_cents": sum(p.net_cents for p in period_paychecks),
            }
        )
    return results


def highest_paying_chores(
    chore_definitions: list[ChoreDefinition], assignments: list[ChoreAssignment]
) -> list[dict[str, Any]]:
    approved = [a for a in assignments if a.status == ChoreAssignmentStatus.APPROVED]
    totals: dict[str, dict[str, Any]] = {}
    for assignment in approved:
        entry = totals.setdefault(
            assignment.chore_definition_id, {"completion_count": 0, "total_paid_cents": 0}
        )
        entry["completion_count"] += 1
        entry["total_paid_cents"] += assignment.payout_cents

    definitions_by_id = {d.id: d for d in chore_definitions}
    results = [
        {
            "chore_definition_id": definition_id,
            "title": (
                definitions_by_id[definition_id].title
                if definition_id in definitions_by_id
                else "Unknown"
            ),
            "completion_count": totals[definition_id]["completion_count"],
            "total_paid_cents": totals[definition_id]["total_paid_cents"],
        }
        for definition_id in totals
    ]
    return sorted(results, key=lambda r: r["total_paid_cents"], reverse=True)


def most_completed_chores(
    chore_definitions: list[ChoreDefinition], assignments: list[ChoreAssignment]
) -> list[dict[str, Any]]:
    entries = highest_paying_chores(chore_definitions, assignments)
    return sorted(entries, key=lambda e: e["completion_count"], reverse=True)


def reliability(members: list[Member], assignments: list[ChoreAssignment]) -> list[dict[str, Any]]:
    children = [m for m in members if m.role == MemberRole.CHILD]
    by_member: dict[str, dict[str, Any]] = {
        m.id: {
            "member_id": m.id,
            "member_name": m.ha_display_name,
            "approved_count": 0,
            "rejected_count": 0,
            "total_count": 0,
        }
        for m in children
    }
    for assignment in assignments:
        entry = by_member.get(assignment.member_id)
        if entry is None:
            continue
        entry["total_count"] += 1
        if assignment.status == ChoreAssignmentStatus.APPROVED:
            entry["approved_count"] += 1
        elif assignment.status == ChoreAssignmentStatus.REJECTED:
            entry["rejected_count"] += 1

    for entry in by_member.values():
        entry["reliability_pct"] = (
            round(100 * entry["approved_count"] / entry["total_count"], 1)
            if entry["total_count"]
            else 0.0
        )

    return sorted(by_member.values(), key=lambda e: e["member_name"])


def grade_history(
    grade_entries: list[GradeEntry],
    subjects: list[Subject],
    member_id: str,
    subject_id: str | None = None,
) -> list[dict[str, Any]]:
    subjects_by_id = {s.id: s for s in subjects}
    entries = [e for e in grade_entries if e.member_id == member_id]
    if subject_id:
        entries = [e for e in entries if e.subject_id == subject_id]
    entries = sorted(entries, key=lambda e: e.entered_at, reverse=True)
    return [
        {
            "subject_id": e.subject_id,
            "subject_name": (
                subjects_by_id[e.subject_id].name
                if e.subject_id in subjects_by_id
                else "Unknown"
            ),
            "grade_letter": e.grade_letter,
            "grade_value_cents": e.grade_value_cents,
            "period_label": e.period_label,
            "entered_at": e.entered_at,
        }
        for e in entries
    ]


def payroll_history(
    members: list[Member],
    pay_periods: list[PayPeriod],
    paychecks: list[Paycheck],
    n_periods: int = 12,
) -> list[dict[str, Any]]:
    periods_by_id = {p.id: p for p in pay_periods}
    members_by_id = {m.id: m for m in members}
    ordered = sorted(
        paychecks,
        key=lambda p: (
            periods_by_id[p.pay_period_id].end_date
            if p.pay_period_id in periods_by_id
            else ""
        ),
        reverse=True,
    )[: n_periods * 10]
    results = []
    for paycheck in ordered:
        period = periods_by_id.get(paycheck.pay_period_id)
        member = members_by_id.get(paycheck.member_id)
        results.append(
            {
                "paycheck_id": paycheck.id,
                "pay_period_id": paycheck.pay_period_id,
                "start_date": period.start_date if period else None,
                "end_date": period.end_date if period else None,
                "member_id": paycheck.member_id,
                "member_name": member.ha_display_name if member else "Unknown",
                "gross_cents": paycheck.gross_cents,
                "net_cents": paycheck.net_cents,
                "status": paycheck.status.value,
            }
        )
    return results


# ---------------------------------------------------------------------------
# Dashboard aggregations (ported from dashboard_service.py)
# ---------------------------------------------------------------------------


def active_chores_count(assignments: list[ChoreAssignment], member_id: str | None = None) -> int:
    active = [
        a
        for a in assignments
        if a.status in (ChoreAssignmentStatus.ASSIGNED, ChoreAssignmentStatus.SUBMITTED)
    ]
    if member_id:
        active = [a for a in active if a.member_id == member_id]
    return len(active)


def active_bounties_count(bounties: list[Bounty], now: datetime) -> int:
    if now.tzinfo is not None:
        now = now.replace(tzinfo=None)
    count = 0
    for bounty in bounties:
        if bounty.status != BountyStatus.OPEN:
            continue
        available_at = _parse_iso(bounty.available_at)
        deadline_at = _parse_iso(bounty.deadline_at)
        if available_at and deadline_at and available_at <= now <= deadline_at:
            count += 1
    return count


def pending_chore_approvals_count(assignments: list[ChoreAssignment]) -> int:
    return sum(1 for a in assignments if a.status == ChoreAssignmentStatus.SUBMITTED)


def pending_bounty_approvals_count(bounties: list[Bounty]) -> int:
    return sum(
        1
        for bounty in bounties
        for acceptance in bounty.acceptances
        if acceptance.status == AcceptanceStatus.SUBMITTED
    )

