"""The panel's read model - a `hass.states`-shaped snapshot of the family.

Under the integration, the panel read everything from the sensor entities'
attributes (scanning `hass.states` for the `hustle_key`/`member_id`/
`chore_definition_id`/`chore_assignment_id`/`bounty_id` marker attributes -
see the frontend's ha-api.ts). These functions build exactly those same
entity payloads straight from the coordinator's public data, so the
frontend's whole parsing layer carries over unchanged: web.py serves the
result at `api/states` and pushes a fresh one over `api/websocket` on every
change.

Each function here corresponds 1:1 to a sensor class in the integration's
old sensor.py - keep their attribute shapes in sync with what ha-api.ts
parses. Entity ids only need to be unique (the panel never looks them up
by name), so the per-item ones use ids rather than slugified names. The
last three (`calendar_settings`, `grocery_list`, `today_chore_progress`)
are add-on additions for the Calendar and Meals tabs.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .const import BountyStatus, ChoreAssignmentStatus, PaycheckStatus

Entity = dict[str, Any]

OPEN_ASSIGNMENT_STATUSES = (
    ChoreAssignmentStatus.ASSIGNED,
    ChoreAssignmentStatus.SUBMITTED,
    ChoreAssignmentStatus.REJECTED,
)


def _entity(entity_id: str, state: Any, attributes: dict[str, Any]) -> Entity:
    # Home Assistant always stringifies state (None becomes "unknown") -
    # ha-api.ts parses state with that in mind, so mirror it.
    return {
        "entity_id": entity_id,
        "state": "unknown" if state is None else str(state),
        "attributes": attributes,
    }


def bounty_is_board_visible(bounty) -> bool:
    """Open bounties are always visible. Closed ones (claimed - first_come
    auto-closes on completion) stay visible until their deadline passes, so
    the frontend can show a "claimed" stamp instead of the bounty just
    vanishing the instant someone finishes it. Cancelled/expired bounties
    are never visible here - they only ever show up in bounty history."""
    if bounty.status == BountyStatus.OPEN:
        return True
    if bounty.status != BountyStatus.CLOSED:
        return False
    deadline_at = datetime.fromisoformat(bounty.deadline_at)
    if deadline_at.tzinfo is None:
        deadline_at = deadline_at.replace(tzinfo=UTC)
    return deadline_at >= datetime.now(UTC)


# ------------------------------------------------------------- fixed sensors


def _count(data: dict[str, Any], key: str) -> Entity:
    value = data.get(key)
    return _entity(
        f"sensor.hustle_{key}",
        len(value) if isinstance(value, list) else value,
        {"hustle_key": key},
    )


def _days_until_payday(data: dict[str, Any]) -> Entity:
    period = data.get("current_period")
    attributes: dict[str, Any] = {"hustle_key": "days_until_payday"}
    if period is not None:
        attributes.update(
            {
                "current_period_id": period.id,
                "start_date": period.start_date,
                "end_date": period.end_date,
                "payday_date": period.payday_date,
                "status": period.status.value,
            }
        )
    return _entity("sensor.hustle_days_until_payday", data.get("days_until_payday"), attributes)


def _setup_status(data: dict[str, Any]) -> Entity:
    household = data.get("household")
    if household is None:
        state = "not_started"
    else:
        state = "completed" if household.setup_completed else "in_progress"
    return _entity(
        "sensor.hustle_setup_status",
        state,
        {
            "hustle_key": "setup_status",
            "household_name": household.name if household else None,
            "member_count": len(data.get("members", [])),
        },
    )


def _recent_activity(data: dict[str, Any]) -> Entity:
    entries = data.get("recent_activity", [])
    return _entity(
        "sensor.hustle_recent_activity",
        len(entries),
        {"hustle_key": "recent_activity", "entries": [e.to_dict() for e in entries[:20]]},
    )


def _member_roster(data: dict[str, Any]) -> Entity:
    members = data.get("members", [])
    return _entity(
        "sensor.hustle_member_roster",
        len(members),
        {
            "hustle_key": "member_roster",
            "members": [
                {
                    "id": m.id,
                    "ha_display_name": m.ha_display_name,
                    "role": m.role.value,
                    "permission_level": m.permission_level.value if m.permission_level else None,
                    "ha_user_id": m.ha_user_id,
                    "active": m.active,
                    "avatar_color": m.avatar_color,
                    "date_of_birth": m.date_of_birth,
                    "managed_child_ids": m.managed_child_ids,
                    "notify_target": m.notify_target,
                }
                for m in members
            ],
        },
    )


def _household(data: dict[str, Any]) -> Entity:
    household = data.get("household")
    if household is None:
        return _entity("sensor.hustle_household", None, {"hustle_key": "household"})
    return _entity(
        "sensor.hustle_household",
        household.name,
        {
            "hustle_key": "household",
            "name": household.name,
            "currency": household.currency,
            "timezone": household.timezone,
            "setup_completed": household.setup_completed,
            "notify_service": household.notify_service,
        },
    )


def _payroll_config(data: dict[str, Any]) -> Entity:
    config = data.get("payroll_config")
    if config is None:
        return _entity("sensor.hustle_payroll_config", None, {"hustle_key": "payroll_config"})
    return _entity(
        "sensor.hustle_payroll_config",
        config.recurrence.value,
        {
            "hustle_key": "payroll_config",
            "recurrence": config.recurrence.value,
            "payday_rule": config.payday_rule.to_dict(),
            "requires_parent_approval": config.requires_parent_approval,
            "approval_threshold_cents": config.approval_threshold_cents,
            "auto_generate": config.auto_generate,
            "pay_parents_too": config.pay_parents_too,
            "default_initiative_bonus_pct": config.default_initiative_bonus_pct,
        },
    )


def _grade_catalog(data: dict[str, Any]) -> Entity:
    subjects = data.get("subjects", [])
    grade_scale = data.get("grade_scale", [])
    return _entity(
        "sensor.hustle_grade_catalog",
        len(subjects),
        {
            "hustle_key": "grade_catalog",
            "subjects": [{"id": s.id, "name": s.name, "active": s.active} for s in subjects],
            "grade_scale": [
                {"letter": g.letter, "value_cents": g.value_cents, "sort_order": g.sort_order}
                for g in sorted(grade_scale, key=lambda g: g.sort_order)
            ],
        },
    )


def _behavior_catalog(data: dict[str, Any]) -> Entity:
    behavior_types = data.get("behavior_types", [])
    return _entity(
        "sensor.hustle_behavior_catalog",
        len(behavior_types),
        {
            "hustle_key": "behavior_catalog",
            "behavior_types": [
                {
                    "id": t.id,
                    "label": t.label,
                    "category": t.category.value,
                    "default_amount_cents": t.default_amount_cents,
                    "icon": t.icon,
                    "active": t.active,
                }
                for t in behavior_types
            ],
        },
    )


def _reports(data: dict[str, Any]) -> Entity:
    return _entity(
        "sensor.hustle_reports",
        len(data.get("earnings_by_child", [])),
        {
            "hustle_key": "reports",
            "earnings_by_child": data.get("earnings_by_child", []),
            "earnings_by_pay_period": data.get("earnings_by_pay_period", []),
            "highest_paying_chores": data.get("highest_paying_chores", []),
            "most_completed_chores": data.get("most_completed_chores", []),
            "reliability": data.get("reliability", []),
        },
    )


def _recent_bounties_history(data: dict[str, Any]) -> Entity:
    # Anything still visible on the board (open, or closed but not past its
    # deadline yet) shouldn't also show up in history.
    closed = [b for b in data.get("bounties", []) if not bounty_is_board_visible(b)]
    recent = sorted(closed, key=lambda b: b.updated_at, reverse=True)[:20]
    return _entity(
        "sensor.hustle_recent_bounties_history",
        len(closed),
        {
            "hustle_key": "recent_bounties_history",
            "bounties": [
                {
                    "id": b.id,
                    "title": b.title,
                    "status": b.status.value,
                    "payout_cents": b.payout_cents,
                    "split_rule": b.split_rule.value,
                    "updated_at": b.updated_at,
                    "acceptances": [a.to_dict() for a in b.acceptances],
                }
                for b in recent
            ],
        },
    )


def _calendar_settings(data: dict[str, Any]) -> Entity:
    settings = data.get("calendar_settings") or {}
    return _entity(
        "sensor.hustle_calendar_settings",
        len(settings.get("family_calendars") or []),
        {"hustle_key": "calendar_settings", **settings},
    )


def _grocery_list(data: dict[str, Any]) -> Entity:
    grocery = data.get("grocery_list") or {}
    categories = grocery.get("categories") or []
    return _entity(
        "sensor.hustle_grocery_list",
        sum(len(c.get("items", [])) for c in categories),
        {
            "hustle_key": "grocery_list",
            "categories": categories,
            "generated_at": grocery.get("generated_at"),
        },
    )


def _today_chore_progress(data: dict[str, Any]) -> Entity:
    progress = data.get("today_chore_progress") or {}
    return _entity(
        "sensor.hustle_today_chore_progress",
        sum(p["done"] for p in progress.values()),
        {"hustle_key": "today_chore_progress", "members": progress},
    )


# --------------------------------------------------------- per-member sensors


def member_pending_cents(data: dict[str, Any], member_id: str) -> int:
    return sum(
        p.net_cents
        for p in data.get("paychecks", [])
        if p.member_id == member_id
        and p.status in (PaycheckStatus.PENDING_APPROVAL, PaycheckStatus.APPROVED)
    )


def member_lifetime_cents(data: dict[str, Any], member_id: str) -> int:
    return sum(
        p.net_cents
        for p in data.get("paychecks", [])
        if p.member_id == member_id and p.status in (PaycheckStatus.APPROVED, PaycheckStatus.PAID)
    )


def member_current_paycheck(data: dict[str, Any], member_id: str):
    period = data.get("current_period")
    if period is None:
        return None
    for p in data.get("paychecks", []):
        if p.pay_period_id == period.id and p.member_id == member_id:
            return p
    return None


def _member_pending_earnings(data: dict[str, Any], member_id: str) -> Entity:
    potential_by_member = data.get("potential_earnings_by_member", {})
    return _entity(
        f"sensor.hustle_member_{member_id}_pending_earnings",
        member_pending_cents(data, member_id),
        {
            "hustle_key": "pending_earnings",
            "member_id": member_id,
            "potential_cents": potential_by_member.get(member_id, 0),
            # Every actionable assignment for the member, so the panel never
            # depends on the per-assignment entities alone.
            "assignments": [
                a.to_dict()
                for a in data.get("chore_assignments", [])
                if a.member_id == member_id and a.status in OPEN_ASSIGNMENT_STATUSES
            ],
        },
    )


def _member_lifetime_earnings(data: dict[str, Any], member_id: str) -> Entity:
    return _entity(
        f"sensor.hustle_member_{member_id}_lifetime_earnings",
        member_lifetime_cents(data, member_id),
        {"hustle_key": "lifetime_earnings", "member_id": member_id},
    )


def _member_paycheck(data: dict[str, Any], member_id: str) -> Entity:
    paycheck = member_current_paycheck(data, member_id)
    history = sorted(
        (p for p in data.get("paychecks", []) if p.member_id == member_id),
        key=lambda p: p.created_at,
        reverse=True,
    )[:10]
    return _entity(
        f"sensor.hustle_paycheck_{member_id}",
        paycheck.net_cents if paycheck else None,
        {
            "member_id": member_id,
            "status": paycheck.status.value if paycheck else None,
            "gross_cents": paycheck.gross_cents if paycheck else None,
            "line_items": [li.to_dict() for li in paycheck.line_items] if paycheck else [],
            "paycheck_history": [
                {
                    "id": p.id,
                    "pay_period_id": p.pay_period_id,
                    "gross_cents": p.gross_cents,
                    "net_cents": p.net_cents,
                    "status": p.status.value,
                }
                for p in history
            ],
        },
    )


def _member_grades(data: dict[str, Any], member_id: str) -> Entity:
    subjects_by_id = {s.id: s.name for s in data.get("subjects", [])}
    entries = [e for e in data.get("grade_entries", []) if e.member_id == member_id]
    recent = sorted(entries, key=lambda e: e.entered_at, reverse=True)[:20]
    return _entity(
        f"sensor.hustle_member_{member_id}_grades",
        len(entries),
        {
            "member_id": member_id,
            "recent_grades": [
                {
                    "id": e.id,
                    "subject_id": e.subject_id,
                    "subject_name": subjects_by_id.get(e.subject_id, "Unknown"),
                    "grade_letter": e.grade_letter,
                    "grade_value_cents": e.grade_value_cents,
                    "period_label": e.period_label,
                    "entered_at": e.entered_at,
                }
                for e in recent
            ],
        },
    )


def _member_behavior(data: dict[str, Any], member_id: str) -> Entity:
    types_by_id = {t.id: t.label for t in data.get("behavior_types", [])}
    entries = [e for e in data.get("behavior_entries", []) if e.member_id == member_id]
    recent = sorted(entries, key=lambda e: e.recorded_at, reverse=True)[:20]
    return _entity(
        f"sensor.hustle_member_{member_id}_behavior",
        sum(e.amount_cents for e in entries),
        {
            "member_id": member_id,
            "recent_entries": [
                {
                    "id": e.id,
                    "behavior_type_id": e.behavior_type_id,
                    "behavior_type_label": types_by_id.get(e.behavior_type_id, "Unknown"),
                    "amount_cents": e.amount_cents,
                    "note": e.note,
                    "recorded_at": e.recorded_at,
                }
                for e in recent
            ],
        },
    )


# ------------------------------------------------------- dynamic item sensors


def _chore_definition(definition) -> Entity:
    return _entity(
        f"sensor.hustle_chore_definition_{definition.id}",
        definition.payout_cents,
        {
            "chore_definition_id": definition.id,
            "title": definition.title,
            "description": definition.description,
            "category": definition.category,
            "recurrence_type": definition.recurrence_type.value,
            "recurrence_config": definition.recurrence_config,
            "is_bounty": definition.is_bounty,
            "is_repeatable": definition.is_repeatable,
            "is_rotating": definition.is_rotating,
            "default_assignee_ids": definition.default_assignee_ids,
            "age_min": definition.age_min,
            "age_max": definition.age_max,
            "requires_approval": definition.requires_approval,
            "prerequisite_ids": definition.prerequisite_ids,
            "due_time": definition.due_time,
            "available_from_time": definition.available_from_time,
            "available_until_time": definition.available_until_time,
            "overdue_action": (
                definition.overdue_action.value if definition.overdue_action else None
            ),
            "overdue_deduction_cents": definition.overdue_deduction_cents,
            "overdue_bounty_hours": definition.overdue_bounty_hours,
            "overdue_penalty_pct": definition.overdue_penalty_pct,
            "image_path": definition.image_path,
            "updated_at": definition.updated_at,
        },
    )


def _chore_assignment(assignment) -> Entity:
    return _entity(
        f"sensor.hustle_chore_assignment_{assignment.id}",
        assignment.status.value,
        {
            "chore_assignment_id": assignment.id,
            "chore_definition_id": assignment.chore_definition_id,
            "member_id": assignment.member_id,
            "due_date": assignment.due_date,
            "due_time": assignment.due_time,
            "available_from_time": assignment.available_from_time,
            "available_until_time": assignment.available_until_time,
            "payout_cents": assignment.payout_cents,
            "submitted_at": assignment.submitted_at,
        },
    )


def _bounty(bounty) -> Entity:
    return _entity(
        f"sensor.hustle_bounty_{bounty.id}",
        bounty.payout_cents,
        {
            "bounty_id": bounty.id,
            "title": bounty.title,
            "status": bounty.status.value,
            "available_at": bounty.available_at,
            "deadline_at": bounty.deadline_at,
            "split_rule": bounty.split_rule.value,
            "requires_approval": bounty.requires_approval,
            "original_assignee_member_id": bounty.original_assignee_member_id,
            "overdue_penalty_pct": bounty.overdue_penalty_pct,
            "source_chore_definition_id": bounty.source_chore_definition_id,
            "is_repeatable": bounty.is_repeatable,
            "acceptances": [a.to_dict() for a in bounty.acceptances],
        },
    )


def build_states(data: dict[str, Any]) -> dict[str, Entity]:
    """entity_id -> entity, like `hass.states`. Only current/actionable
    items get per-item entities (active chore definitions, open assignments,
    board-visible bounties), as under the integration."""
    entities: list[Entity] = [
        _count(data, "pending_payroll_count"),
        _days_until_payday(data),
        _count(data, "active_chores_count"),
        _count(data, "active_bounties_count"),
        _count(data, "pending_approval_count"),
        _setup_status(data),
        _recent_activity(data),
        _member_roster(data),
        _household(data),
        _payroll_config(data),
        _grade_catalog(data),
        _behavior_catalog(data),
        _reports(data),
        _recent_bounties_history(data),
        _calendar_settings(data),
        _grocery_list(data),
        _today_chore_progress(data),
    ]
    for member in data.get("members", []):
        entities.extend(
            [
                _member_pending_earnings(data, member.id),
                _member_lifetime_earnings(data, member.id),
                _member_paycheck(data, member.id),
                _member_grades(data, member.id),
                _member_behavior(data, member.id),
            ]
        )
    entities.extend(_chore_definition(d) for d in data.get("chore_definitions", []) if d.active)
    entities.extend(
        _chore_assignment(a)
        for a in data.get("chore_assignments", [])
        if a.status in OPEN_ASSIGNMENT_STATUSES
    )
    entities.extend(_bounty(b) for b in data.get("bounties", []) if bounty_is_board_visible(b))
    return {e["entity_id"]: e for e in entities}
