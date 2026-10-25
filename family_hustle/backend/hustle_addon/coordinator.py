from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from . import logic
from .bridge import HassBridge
from .const import (
    _GRADE_SORT_ORDER,
    RECENT_ACTIVITY_LIMIT,
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
from .image_gen import async_generate_chore_image_bytes, async_save_chore_image
from .models import (
    ActivityEntry,
    BehaviorEntry,
    BehaviorType,
    Bounty,
    BountyAcceptance,
    ChoreAssignment,
    ChoreDefinition,
    GradeEntry,
    GradeScaleEntry,
    Household,
    Member,
    Paycheck,
    PaycheckLineItem,
    PaydayRule,
    PayPeriod,
    PayrollConfig,
    Subject,
    new_id,
    now_iso,
)
from .storage import HustleStore, default_calendar_settings, default_data

_LOGGER = logging.getLogger(__name__)

_EARNING_COLLECTORS_ORDER = ("chore", "bounty", "grade", "behavior")


def _local_now() -> datetime:
    # Supervisor sets the container's TZ to Home Assistant's configured time
    # zone, so local time here is the household's (what the integration got
    # from _local_now()).
    return datetime.now().astimezone()


def _today() -> date:
    # Local, not UTC - chore-occurrence generation only looks ahead one day
    # at a time (see async_generate_due_chore_occurrences), so a timezone
    # mismatch could otherwise skip "today" entirely.
    return _local_now().date()


class HustleCoordinator:
    """Central state holder for the Hustle integration.

    Push-based - state changes are made by services.py/the scheduler calling
    the mutation methods below, each of which persists to storage and
    notifies listeners (web.py's websocket push and mqtt.py's publisher).
    `hass` is the add-on's bridge to Home Assistant (see bridge.py).
    """

    def __init__(self, hass: HassBridge, store: HustleStore) -> None:
        self.hass = hass
        self.data: dict[str, Any] | None = None
        self._listeners: list[Callable[[], None]] = []
        self.store = store
        self.openai_api_key: str | None = None
        self.household: Household | None = None
        self.payroll_config: PayrollConfig | None = None
        self.members: list[Member] = []
        self.chore_definitions: list[ChoreDefinition] = []
        self.chore_assignments: list[ChoreAssignment] = []
        self.bounties: list[Bounty] = []
        self.subjects: list[Subject] = []
        self.grade_scale: list[GradeScaleEntry] = []
        self.grade_entries: list[GradeEntry] = []
        self.behavior_types: list[BehaviorType] = []
        self.behavior_entries: list[BehaviorEntry] = []
        self.pay_periods: list[PayPeriod] = []
        self.paychecks: list[Paycheck] = []
        self.recent_activity: list[ActivityEntry] = []
        self.earnings_reset_at: str | None = None
        # Add-on additions (the integration had no calendar or meals) - see
        # the "family calendar + meals" section at the bottom.
        self.calendar_settings: dict[str, Any] = default_calendar_settings()
        self.event_tags: dict[str, dict[str, Any]] = {}
        self.grocery_list: dict[str, Any] = {"categories": [], "generated_at": None}
        self.recipes: list[dict[str, Any]] = []

    # ----------------------------------------------------------- listeners
    # Stands in for DataUpdateCoordinator's push API from the integration
    # days - same two method names, so everything below is unchanged.

    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def async_set_updated_data(self, data: dict[str, Any]) -> None:
        self.data = data
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:  # one bad listener mustn't block the rest
                _LOGGER.exception("Hustle listener failed")

    # ---------------------------------------------------------------- load

    async def async_load(self) -> None:
        raw = await self.store.async_load()
        if raw is None:
            raw = default_data()
            await self.store.async_save(raw)

        self.household = Household.from_dict(raw["household"]) if raw.get("household") else None
        self.payroll_config = (
            PayrollConfig.from_dict(raw["payroll_config"]) if raw.get("payroll_config") else None
        )
        self.members = [Member.from_dict(m) for m in raw.get("members", [])]
        self.chore_definitions = [
            ChoreDefinition.from_dict(d) for d in raw.get("chore_definitions", [])
        ]
        migrated_stale_images = False
        for definition in self.chore_definitions:
            if definition.image_path and definition.image_path.startswith("/local/hustle/"):
                # Old storage path (config/www/hustle/) - permanently wiped by
                # every ha-hustle-frontend deploy's `rsync --delete` into that
                # same directory (see image_gen.py's comment). Clear it so the
                # UI falls back to the placeholder icon instead of a broken
                # <img>, and so the next edit naturally regenerates it under
                # the new non-colliding location.
                definition.image_path = None
                migrated_stale_images = True
        self.chore_assignments = [
            ChoreAssignment.from_dict(a) for a in raw.get("chore_assignments", [])
        ]
        self.bounties = [Bounty.from_dict(b) for b in raw.get("bounties", [])]
        self.subjects = [Subject.from_dict(s) for s in raw.get("subjects", [])]
        self.grade_scale = [GradeScaleEntry.from_dict(g) for g in raw.get("grade_scale", [])]
        self.grade_entries = [GradeEntry.from_dict(g) for g in raw.get("grade_entries", [])]
        self.behavior_types = [BehaviorType.from_dict(t) for t in raw.get("behavior_types", [])]
        self.behavior_entries = [
            BehaviorEntry.from_dict(e) for e in raw.get("behavior_entries", [])
        ]
        self.pay_periods = [PayPeriod.from_dict(p) for p in raw.get("pay_periods", [])]
        self.paychecks = [Paycheck.from_dict(p) for p in raw.get("paychecks", [])]
        self.earnings_reset_at = raw.get("earnings_reset_at")
        defaults = default_calendar_settings()
        stored_settings = raw.get("calendar_settings") or {}
        self.calendar_settings = {
            **defaults,
            # Settings an older version had but this one doesn't are dropped.
            **{k: v for k, v in stored_settings.items() if k in defaults},
        }
        self.event_tags = dict(raw.get("event_tags") or {})
        self.grocery_list = raw.get("grocery_list") or {"categories": [], "generated_at": None}
        self.recipes = list(raw.get("recipes") or [])
        self.recent_activity = [ActivityEntry.from_dict(a) for a in raw.get("recent_activity", [])]

        if migrated_stale_images:
            await self._async_save()
        else:
            self.async_set_updated_data(self._build_public_data())

    # --------------------------------------------------------------- save

    async def _async_save(self) -> None:
        data = {
            "version": 1,
            "household": self.household.to_dict() if self.household else None,
            "payroll_config": self.payroll_config.to_dict() if self.payroll_config else None,
            "members": [m.to_dict() for m in self.members],
            "chore_definitions": [d.to_dict() for d in self.chore_definitions],
            "chore_assignments": [a.to_dict() for a in self.chore_assignments],
            "bounties": [b.to_dict() for b in self.bounties],
            "subjects": [s.to_dict() for s in self.subjects],
            "grade_scale": [g.to_dict() for g in self.grade_scale],
            "grade_entries": [g.to_dict() for g in self.grade_entries],
            "behavior_types": [t.to_dict() for t in self.behavior_types],
            "behavior_entries": [e.to_dict() for e in self.behavior_entries],
            "pay_periods": [p.to_dict() for p in self.pay_periods],
            "paychecks": [p.to_dict() for p in self.paychecks],
            "recent_activity": [a.to_dict() for a in self.recent_activity],
            "earnings_reset_at": self.earnings_reset_at,
            "calendar_settings": self.calendar_settings,
            "event_tags": self.event_tags,
            "grocery_list": self.grocery_list,
            "recipes": self.recipes,
        }
        await self.store.async_save(data)
        self.async_set_updated_data(self._build_public_data())

    def _record_activity(
        self,
        event_type: str,
        title: str,
        message: str,
        member_id: str | None = None,
        amount_cents: int | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        entry = ActivityEntry(
            id=new_id(),
            event_type=event_type,
            title=title,
            message=message,
            member_id=member_id,
            amount_cents=amount_cents,
            payload=payload or {},
        )
        self.recent_activity.insert(0, entry)
        del self.recent_activity[RECENT_ACTIVITY_LIMIT:]
        if self.hass is not None:
            event_payload = {
                "household_id": self.household.id if self.household else None,
                "member_id": member_id,
                "title": title,
                "message": message,
                **(payload or {}),
            }
            self.hass.bus.async_fire(f"hustle_{event_type}", event_payload)

    def _build_public_data(self) -> dict[str, Any]:
        now = datetime.now(UTC)
        pending_chore_approvals = logic.pending_chore_approvals_count(self.chore_assignments)
        pending_bounty_approvals = logic.pending_bounty_approvals_count(self.bounties)
        current_period = self._current_period_ready()
        days_until_payday = None
        pending_payroll_count = 0
        if current_period is not None:
            days_until_payday = (date.fromisoformat(current_period.payday_date) - _today()).days
            pending_payroll_count = sum(
                1
                for p in self.paychecks
                if p.pay_period_id == current_period.id
                and p.status in (PaycheckStatus.PENDING_APPROVAL, PaycheckStatus.APPROVED)
            )
        return {
            "household": self.household,
            "payroll_config": self.payroll_config,
            "members": self.members,
            "chore_definitions": self.chore_definitions,
            "chore_assignments": self.chore_assignments,
            "bounties": self.bounties,
            "subjects": self.subjects,
            "grade_scale": self.grade_scale,
            "grade_entries": self.grade_entries,
            "behavior_types": self.behavior_types,
            "behavior_entries": self.behavior_entries,
            "pay_periods": self.pay_periods,
            "paychecks": self.paychecks,
            "recent_activity": self.recent_activity,
            "current_period": current_period,
            "days_until_payday": days_until_payday,
            "pending_payroll_count": pending_payroll_count,
            "active_chores_count": logic.active_chores_count(self.chore_assignments),
            "active_bounties_count": logic.active_bounties_count(self.bounties, now),
            "pending_approval_count": (
                pending_chore_approvals + pending_bounty_approvals + pending_payroll_count
            ),
            "earnings_by_child": logic.earnings_by_child(self.members, self.paychecks),
            "earnings_by_pay_period": logic.earnings_by_pay_period(
                self.pay_periods, self.paychecks
            ),
            "highest_paying_chores": logic.highest_paying_chores(
                self.chore_definitions, self.chore_assignments
            ),
            "most_completed_chores": logic.most_completed_chores(
                self.chore_definitions, self.chore_assignments
            ),
            "reliability": logic.reliability(self.members, self.chore_assignments),
            "potential_earnings_by_member": self._potential_earnings_by_member(),
            "today_chore_progress": self._today_chore_progress(),
            "calendar_settings": self.calendar_settings,
            "grocery_list": self.grocery_list,
            "recipes": self.recipes,
        }

    def _potential_earnings_by_member(self) -> dict[str, int]:
        """Sum of payout_cents for each member's current ASSIGNED/SUBMITTED
        chore assignments (not yet paid) - "potential to earn" for the
        dashboard, exposed via MemberPendingEarningsSensor's potential_cents
        attribute."""
        totals: dict[str, int] = {}
        for assignment in self.chore_assignments:
            if assignment.status not in (
                ChoreAssignmentStatus.ASSIGNED,
                ChoreAssignmentStatus.SUBMITTED,
            ):
                continue
            totals[assignment.member_id] = (
                totals.get(assignment.member_id, 0) + assignment.payout_cents
            )
        return totals

    def _current_period_ready(self) -> PayPeriod | None:
        """Best-effort lookup of the current period without creating one -
        used only for read-side dashboard aggregates so building public data
        never itself mutates/persists state."""
        if self.payroll_config is None:
            return None
        start, end, _payday = logic.compute_period(
            self.payroll_config.payday_rule, self.payroll_config.recurrence.value, _today()
        )
        for period in self.pay_periods:
            if period.start_date == start.isoformat() and period.end_date == end.isoformat():
                return period
        return None

    # ------------------------------------------------------- household/setup

    async def async_setup_household(
        self,
        name: str,
        payday_rule: dict[str, Any],
        recurrence: str = "weekly",
        currency: str = "USD",
        timezone: str = "UTC",
        requires_parent_approval: bool = True,
        default_initiative_bonus_pct: int = 30,
        grade_values_cents: dict[str, int] | None = None,
    ) -> Household:
        if self.household is not None and self.household.setup_completed:
            raise ValueError("Setup has already been completed for this household.")

        if self.household is None:
            self.household = Household(id=new_id(), name=name, currency=currency, timezone=timezone)
        else:
            self.household.name = name
            self.household.currency = currency
            self.household.timezone = timezone

        self.payroll_config = PayrollConfig(
            payday_rule=PaydayRule.from_dict(payday_rule),
            recurrence=PayrollRecurrence(recurrence),
            requires_parent_approval=requires_parent_approval,
            default_initiative_bonus_pct=default_initiative_bonus_pct,
        )

        values = grade_values_cents or {}
        by_letter = {g.letter: g for g in self.grade_scale}
        for letter, value_cents in values.items():
            if letter in by_letter:
                by_letter[letter].value_cents = value_cents
            else:
                entry = GradeScaleEntry(
                    letter=letter,
                    value_cents=value_cents,
                    sort_order=_GRADE_SORT_ORDER.get(letter, 99),
                )
                self.grade_scale.append(entry)
                by_letter[letter] = entry

        await self._async_save()
        return self.household

    async def async_update_household(self, **fields: Any) -> Household:
        if self.household is None:
            raise ValueError("Household has not been set up yet.")
        for key, value in fields.items():
            if value is not None and hasattr(self.household, key):
                setattr(self.household, key, value)
        await self._async_save()
        return self.household

    async def async_complete_setup(self) -> Household:
        if self.household is None:
            raise ValueError("Household has not been set up yet.")
        parent_count = sum(1 for m in self.members if m.role == MemberRole.PARENT)
        if not parent_count:
            raise ValueError("Add at least one parent before completing setup.")
        self.household.setup_completed = True
        await self._async_save()
        return self.household

    async def async_update_payroll_config(self, **fields: Any) -> PayrollConfig:
        if self.payroll_config is None:
            raise ValueError("Payroll has not been configured for this household yet.")
        if "payday_rule" in fields and fields["payday_rule"] is not None:
            fields["payday_rule"] = PaydayRule.from_dict(fields["payday_rule"])
        if "recurrence" in fields and fields["recurrence"] is not None:
            fields["recurrence"] = PayrollRecurrence(fields["recurrence"])
        for key, value in fields.items():
            if value is not None and hasattr(self.payroll_config, key):
                setattr(self.payroll_config, key, value)
        await self._async_save()
        return self.payroll_config

    # ------------------------------------------------------------- members

    def _get_member(self, member_id: str) -> Member:
        for member in self.members:
            if member.id == member_id:
                return member
        raise ValueError(f"Unknown member_id {member_id}")

    def _member_for_context(self, context: Any) -> Member | None:
        """Resolves the Member linked to the HA user who initiated a service
        call, via `context.user_id` -> `Member.ha_user_id`. Returns None if
        unresolvable; callers should raise ServiceValidationError."""
        if not context or not context.user_id:
            return None
        for member in self.members:
            if member.ha_user_id == context.user_id and member.active:
                return member
        return None

    async def async_add_member(
        self,
        ha_user_id: str,
        ha_display_name: str,
        role: str,
        permission_level: str | None = None,
        date_of_birth: str | None = None,
        avatar_color: str | None = None,
        managed_child_ids: list[str] | None = None,
        notify_target: str | None = None,
    ) -> Member:
        if any(m.ha_user_id == ha_user_id for m in self.members):
            raise ValueError("This Home Assistant user is already linked to this household.")

        role_enum = MemberRole(role)
        requested_level = PermissionLevel(permission_level) if permission_level else None
        existing_parent_count = sum(1 for m in self.members if m.role == MemberRole.PARENT)
        resolved_level = logic.next_permission_level(
            role_enum, requested_level, existing_parent_count
        )

        member = Member(
            id=new_id(),
            ha_user_id=ha_user_id,
            ha_display_name=ha_display_name,
            role=role_enum,
            permission_level=resolved_level,
            date_of_birth=date_of_birth,
            avatar_color=avatar_color,
            managed_child_ids=managed_child_ids or [],
            notify_target=notify_target,
        )
        self.members.append(member)
        await self._async_save()
        return member

    async def async_update_member(self, member_id: str, **fields: Any) -> Member:
        member = self._get_member(member_id)
        if "role" in fields and fields["role"] is not None:
            fields["role"] = MemberRole(fields["role"])
        if "permission_level" in fields and fields["permission_level"] is not None:
            fields["permission_level"] = PermissionLevel(fields["permission_level"])
        for key, value in fields.items():
            if value is not None and hasattr(member, key):
                setattr(member, key, value)
        member.updated_at = now_iso()
        await self._async_save()
        return member

    async def async_deactivate_member(self, member_id: str) -> Member:
        member = self._get_member(member_id)
        member.active = False
        member.updated_at = now_iso()
        await self._async_save()
        return member

    # -------------------------------------------------------------- chores

    def _get_chore_definition(self, definition_id: str) -> ChoreDefinition:
        for definition in self.chore_definitions:
            if definition.id == definition_id:
                return definition
        raise ValueError(f"Unknown chore_definition_id {definition_id}")

    def _get_assignment(self, assignment_id: str) -> ChoreAssignment:
        for assignment in self.chore_assignments:
            if assignment.id == assignment_id:
                return assignment
        raise ValueError(f"Unknown chore_assignment_id {assignment_id}")

    async def async_add_chore_definition(
        self,
        title: str,
        payout_cents: int = 0,
        description: str | None = None,
        category: str | None = None,
        recurrence_type: str = "none",
        recurrence_config: dict[str, Any] | None = None,
        is_bounty: bool = False,
        is_repeatable: bool = False,
        is_rotating: bool = False,
        rotation_order: list[str] | None = None,
        default_assignee_ids: list[str] | None = None,
        age_min: int | None = None,
        age_max: int | None = None,
        requires_approval: bool = True,
        prerequisite_ids: list[str] | None = None,
        due_time: str | None = None,
        available_from_time: str | None = None,
        available_until_time: str | None = None,
        overdue_action: str | None = None,
        overdue_deduction_cents: int | None = None,
        overdue_bounty_hours: int | None = None,
        overdue_penalty_pct: int | None = -50,
    ) -> ChoreDefinition:
        definition = ChoreDefinition(
            id=new_id(),
            household_id=self.household.id if self.household else "",
            title=title,
            description=description,
            category=category,
            payout_cents=payout_cents,
            recurrence_type=RecurrenceType(recurrence_type),
            recurrence_config=recurrence_config or {},
            is_bounty=is_bounty,
            is_repeatable=is_repeatable if is_bounty else False,
            is_rotating=is_rotating,
            rotation_order=rotation_order or [],
            default_assignee_ids=default_assignee_ids or [],
            age_min=age_min,
            age_max=age_max,
            requires_approval=requires_approval,
            prerequisite_ids=prerequisite_ids or [],
            due_time=due_time,
            # For a regular chore this gates async_submit_chore. For an
            # is_bounty chore there's no assignment to gate - instead
            # async_generate_due_chore_occurrences uses these to compute
            # each posted bounty's available_at/deadline_at time-of-day.
            available_from_time=available_from_time,
            available_until_time=available_until_time,
            # Overdue handling only applies to assignments - is_bounty
            # chores never get one (each occurrence posts straight as a
            # bounty), so an overdue_action would be silently inert. A
            # missed bounty just doesn't get claimed; the next occurrence
            # posts on its own schedule regardless.
            overdue_action=(
                OverdueAction(overdue_action) if overdue_action and not is_bounty else None
            ),
            overdue_deduction_cents=None if is_bounty else overdue_deduction_cents,
            overdue_bounty_hours=(
                None
                if is_bounty
                else (
                    overdue_bounty_hours
                    if overdue_bounty_hours is not None
                    else (5 if overdue_action == "convert_to_bounty" else None)
                )
            ),
            overdue_penalty_pct=None if is_bounty else overdue_penalty_pct,
        )
        self.chore_definitions.append(definition)
        await self._async_save()
        self.hass.async_create_task(self.async_generate_chore_image(definition.id))
        await self._post_initial_bounty_if_needed(definition)
        return definition

    async def async_update_chore_definition(
        self, definition_id: str, **fields: Any
    ) -> ChoreDefinition:
        definition = self._get_chore_definition(definition_id)
        needs_image = definition.image_path is None
        if "recurrence_type" in fields and fields["recurrence_type"] is not None:
            fields["recurrence_type"] = RecurrenceType(fields["recurrence_type"])
        if "overdue_action" in fields and fields["overdue_action"] is not None:
            fields["overdue_action"] = OverdueAction(fields["overdue_action"])
        for key, value in fields.items():
            if value is not None and hasattr(definition, key):
                setattr(definition, key, value)
        if definition.is_bounty:
            # Same rationale as async_add_chore_definition - clear out
            # whatever overdue config might be left over from before this
            # chore was switched to a bounty. available_from/until_time
            # stay - they still mean something for is_bounty chores (see
            # async_generate_due_chore_occurrences).
            definition.overdue_action = None
            definition.overdue_deduction_cents = None
            definition.overdue_bounty_hours = None
            definition.overdue_penalty_pct = None
        else:
            # is_repeatable only means something for a bounty-type chore.
            definition.is_repeatable = False
        definition.updated_at = now_iso()
        await self._async_save()
        if needs_image:
            self.hass.async_create_task(self.async_generate_chore_image(definition.id))
        await self._post_initial_bounty_if_needed(definition)
        return definition

    async def _post_initial_bounty_if_needed(self, definition: ChoreDefinition) -> None:
        """A recurring is_bounty chore gets a fresh bounty per due date via
        async_generate_due_chore_occurrences, but recurrence_type=NONE is
        always skipped there - there's no due date to derive an
        availability window from. A one-time is_bounty + is_repeatable
        chore (e.g. "Read a book") would otherwise never post anything at
        all, so it gets a single opening bounty here instead, with a long
        default deadline since there's no natural end date - the parent
        can always cancel it manually (or edit the chore back off
        is_repeatable) when they're done with it."""
        if not (definition.is_bounty and definition.is_repeatable):
            return
        if definition.recurrence_type != RecurrenceType.NONE:
            return  # recurring ones get a fresh bounty each due date instead
        already_open = any(
            b.source_chore_definition_id == definition.id and b.status == BountyStatus.OPEN
            for b in self.bounties
        )
        if already_open:
            return
        creator_id = self._default_bounty_creator_id()
        if creator_id is None:
            return
        now = datetime.now(UTC)
        self.bounties.append(
            Bounty(
                id=new_id(),
                household_id=self.household.id if self.household else "",
                source_chore_definition_id=definition.id,
                title=definition.title,
                description=definition.description,
                payout_cents=definition.payout_cents,
                initiative_bonus_pct=self._default_initiative_bonus_pct(),
                available_at=now.isoformat(),
                deadline_at=(now + timedelta(days=3650)).isoformat(),
                requires_approval=definition.requires_approval,
                created_by_member_id=creator_id,
                is_repeatable=True,
            )
        )
        await self._async_save()

    async def async_generate_chore_image(self, definition_id: str) -> None:
        """Background job: generate and attach an AI illustration for a
        chore. Best-effort - a slow/failed OpenAI call must never block chore
        creation or edits, so this is fired via `hass.async_create_task`
        rather than awaited by the callers above."""
        if not self.openai_api_key:
            return
        try:
            definition = self._get_chore_definition(definition_id)
        except ValueError:
            return
        image_bytes = await async_generate_chore_image_bytes(
            self.hass, self.openai_api_key, definition.title, definition.description
        )
        if image_bytes is None:
            return
        definition.image_path = await async_save_chore_image(self.hass, definition.id, image_bytes)
        definition.updated_at = now_iso()
        await self._async_save()

    async def async_regenerate_chore_image(self, definition_id: str) -> ChoreDefinition:
        """Parent-triggered re-roll: clears the existing image so
        `async_update_chore_definition`'s "only if missing" rule doesn't
        skip it, then fires generation same as a fresh chore would."""
        definition = self._get_chore_definition(definition_id)
        definition.image_path = None
        definition.updated_at = now_iso()
        await self._async_save()
        self.hass.async_create_task(self.async_generate_chore_image(definition.id))
        return definition

    async def async_assign_chore(
        self, definition_id: str, member_ids: list[str] | None = None, due_date: str | None = None
    ) -> list[ChoreAssignment]:
        definition = self._get_chore_definition(definition_id)
        if not definition.active:
            raise ValueError("Cannot assign an inactive chore.")
        if due_date is None:
            raise ValueError("due_date is required.")

        ids = list(member_ids or [])
        if not ids and definition.is_rotating:
            ids = [logic.next_rotation_assignee(definition, self.chore_assignments)]
        if not ids:
            raise ValueError("Select at least one child to assign this chore to.")

        created: list[ChoreAssignment] = []
        skipped = False
        for member_id in ids:
            member = next((m for m in self.members if m.id == member_id), None)
            already_assigned = any(
                a.chore_definition_id == definition.id
                and a.member_id == member_id
                and a.due_date == due_date
                and a.status != ChoreAssignmentStatus.APPROVED
                for a in self.chore_assignments
            )
            if already_assigned:
                # Idempotent - already assigned (and still open: assigned,
                # submitted, or rejected) for this occurrence, e.g. an
                # earlier manual assign or auto-generation beat this call to
                # it. An *approved* assignment for the same date doesn't
                # block this - that one's done and historical (same
                # definition of "still active" as async_unassign_all_chores
                # uses), so a parent can deliberately re-assign a chore for
                # a date it was already completed on, e.g. right after using
                # the Settings page to reset everything. Logged, not
                # silent, so a multi-select assign that only partly "took"
                # is visible in Recent Activity instead of just quietly
                # doing nothing for that one child.
                skipped = True
                self._record_activity(
                    "chore_assign_skipped",
                    title="Chore already assigned",
                    message=(
                        f'{member.ha_display_name if member else member_id} already had '
                        f'"{definition.title}" assigned for {due_date}.'
                    ),
                    member_id=member_id,
                )
                continue

            if not logic.check_prerequisites(definition, member_id, self.chore_assignments):
                # Skip this one child rather than aborting the whole batch -
                # a previous version raised here, which meant one child
                # failing prerequisites could silently drop assignments
                # already made earlier in the same call for other children
                # (never persisted, since the save only ran after the loop
                # completed without raising).
                skipped = True
                self._record_activity(
                    "chore_assign_skipped",
                    title="Chore not assigned",
                    message=(
                        f"{member.ha_display_name if member else member_id} hasn't completed "
                        f'the prerequisite chore(s) for "{definition.title}" yet, so it '
                        "wasn't assigned."
                    ),
                    member_id=member_id,
                )
                continue

            assignment = ChoreAssignment(
                id=new_id(),
                chore_definition_id=definition.id,
                member_id=member_id,
                due_date=due_date,
                payout_cents=definition.payout_cents,
                due_time=definition.due_time,
                available_from_time=definition.available_from_time,
                available_until_time=definition.available_until_time,
            )
            self.chore_assignments.append(assignment)
            created.append(assignment)
            self._record_activity(
                "chore_assigned",
                title="New chore assigned",
                message=(
                    f"{member.ha_display_name if member else member_id} "
                    f"was assigned: {definition.title}"
                ),
                member_id=member_id,
            )

        # A manual assign on a recurring chore is the natural moment a
        # parent expresses "this kid does this chore" - reuse it to keep
        # default_assignee_ids (what auto-generation assigns future
        # occurrences to) in sync, so recurrence doesn't silently stop
        # producing new occurrences the moment nobody remembers to also
        # edit the chore's settings. Not for is_rotating (rotation picks
        # its own assignee each time) or is_bounty (never assigned, only
        # posted open).
        needs_save = bool(created or skipped)
        if (
            not definition.is_bounty
            and not definition.is_rotating
            and definition.recurrence_type != RecurrenceType.NONE
            and set(definition.default_assignee_ids) != set(ids)
        ):
            definition.default_assignee_ids = ids
            needs_save = True

        if needs_save:
            await self._async_save()
        return created

    async def async_submit_chore(self, assignment_id: str, actor: Member) -> ChoreAssignment:
        assignment = self._get_assignment(assignment_id)
        if actor.role == MemberRole.CHILD and assignment.member_id != actor.id:
            raise ValueError("You can only submit your own chores.")
        resubmittable = (ChoreAssignmentStatus.ASSIGNED, ChoreAssignmentStatus.REJECTED)
        if assignment.status not in resubmittable:
            raise ValueError(f"Cannot submit a chore in status '{assignment.status.value}'.")
        if not logic.is_within_availability_window(
            assignment.due_date,
            assignment.available_from_time,
            assignment.available_until_time,
            _local_now(),
        ):
            raise ValueError("This chore isn't within its availability window right now.")

        definition = self._get_chore_definition(assignment.chore_definition_id)

        now = now_iso()
        assignment.submitted_at = now
        assignment.rejection_reason = None

        if definition.requires_approval:
            assignment.status = ChoreAssignmentStatus.SUBMITTED
            self._record_activity(
                "chore_needs_approval",
                title="Chore ready for review",
                message=f'{actor.ha_display_name} submitted "{definition.title}" for approval.',
                member_id=assignment.member_id,
            )
        else:
            assignment.status = ChoreAssignmentStatus.APPROVED
            assignment.approved_at = now

        assignment.updated_at = now
        await self._async_save()
        return assignment

    async def async_approve_chore(self, assignment_id: str, approver: Member) -> ChoreAssignment:
        assignment = self._get_assignment(assignment_id)
        if assignment.status != ChoreAssignmentStatus.SUBMITTED:
            raise ValueError(f"Cannot approve a chore in status '{assignment.status.value}'.")
        assignment.status = ChoreAssignmentStatus.APPROVED
        assignment.approved_by_member_id = approver.id
        assignment.approved_at = now_iso()
        assignment.updated_at = now_iso()
        await self._async_save()
        return assignment

    async def async_reject_chore(
        self, assignment_id: str, reason: str, approver: Member
    ) -> ChoreAssignment:
        assignment = self._get_assignment(assignment_id)
        if assignment.status != ChoreAssignmentStatus.SUBMITTED:
            raise ValueError(f"Cannot reject a chore in status '{assignment.status.value}'.")
        assignment.status = ChoreAssignmentStatus.REJECTED
        assignment.rejection_reason = reason
        assignment.approved_by_member_id = approver.id
        assignment.updated_at = now_iso()
        await self._async_save()
        return assignment

    def _default_bounty_creator_id(self) -> str | None:
        """Attribution for bounties an is_bounty chore's recurrence posts
        automatically - there's no human actor in that path, so the first
        active parent stands in, same rationale as the overdue-conversion
        job's creator_id (see _create_bounty_from_assignment)."""
        parent = next((m for m in self.members if m.role == MemberRole.PARENT and m.active), None)
        return parent.id if parent else None

    async def async_generate_due_chore_occurrences(
        self, as_of: date | None = None, lookahead_days: int = 7, chore_lookahead_days: int = 0
    ) -> list[ChoreAssignment]:
        """Bounties keep a week-long lookahead (`lookahead_days`) so the open
        board always shows a run of upcoming ones to plan around - that's a
        real feature of bounties-view.ts, not clutter. Regular chore
        assignments default to `chore_lookahead_days=0`: only the occurrence
        actually due `as_of` gets created, so a recurring chore's next
        assignment appears exactly when it comes due (picked up by the next
        5-minute scheduler tick) instead of pre-populating a child's list
        with a week of future rows."""
        as_of = as_of or _today()
        end = as_of + timedelta(days=lookahead_days)
        chore_end = as_of + timedelta(days=chore_lookahead_days)

        created: list[ChoreAssignment] = []
        created_bounties: list[Bounty] = []
        for definition in self.chore_definitions:
            if not definition.active or definition.recurrence_type == RecurrenceType.NONE:
                continue
            due_dates = logic.due_dates_for(
                definition, as_of, end if definition.is_bounty else chore_end
            )
            if not due_dates:
                continue

            if definition.is_bounty:
                creator_id = self._default_bounty_creator_id()
                if creator_id is None:
                    continue  # no parent to attribute the bounty to yet - skip silently
                for due_date in due_dates:
                    due_iso = due_date.isoformat()
                    # Cancelled doesn't block regeneration - a parent
                    # cancelling a wrongly-configured auto-generated bounty
                    # (e.g. to pick up a fix to the chore's own settings)
                    # should free up that due date for a fresh, correct one
                    # on the next generation pass. Expired does block it -
                    # that's just "missed," not "wrong."
                    already = any(
                        b.source_chore_definition_id == definition.id
                        and b.deadline_at.startswith(due_iso)
                        and b.status != BountyStatus.CANCELLED
                        for b in self.bounties
                    )
                    if already:
                        continue
                    # available_from/until_time double as the bounty's
                    # available_at/deadline_at time-of-day when set -
                    # otherwise fall back to midnight / due_time (or
                    # 23:59), same as before this option existed.
                    deadline_at = logic.effective_due_datetime(
                        due_iso, definition.available_until_time or definition.due_time
                    )
                    if definition.available_from_time:
                        available_at = logic.effective_due_datetime(
                            due_iso, definition.available_from_time
                        )
                    else:
                        # Midnight of the occurrence's own due date, not
                        # "now" - these are all generated up to
                        # lookahead_days ahead of time, so an available_at
                        # of "now" would make every future day's bounty
                        # show as available immediately too. Board
                        # visibility (bounties-view.ts) hides anything
                        # before its available_at from kids.
                        available_at = datetime.combine(due_date, time.min)
                    bounty = Bounty(
                        id=new_id(),
                        household_id=self.household.id if self.household else "",
                        source_chore_definition_id=definition.id,
                        title=definition.title,
                        description=definition.description,
                        payout_cents=definition.payout_cents,
                        initiative_bonus_pct=self._default_initiative_bonus_pct(),
                        available_at=available_at.isoformat(),
                        deadline_at=deadline_at.isoformat(),
                        requires_approval=definition.requires_approval,
                        created_by_member_id=creator_id,
                        is_repeatable=definition.is_repeatable,
                    )
                    self.bounties.append(bounty)
                    created_bounties.append(bounty)
                continue

            for due_date in due_dates:
                occurrence_assignees = definition.default_assignee_ids
                if definition.is_rotating:
                    occurrence_assignees = [
                        logic.next_rotation_assignee(definition, self.chore_assignments)
                    ]
                if not occurrence_assignees:
                    continue

                for member_id in occurrence_assignees:
                    due_iso = due_date.isoformat()
                    already = any(
                        a.chore_definition_id == definition.id
                        and a.member_id == member_id
                        and a.due_date == due_iso
                        for a in self.chore_assignments
                    )
                    if already:
                        continue
                    if not logic.check_prerequisites(definition, member_id, self.chore_assignments):
                        continue  # prerequisites unmet - skip silently, runs unattended

                    assignment = ChoreAssignment(
                        id=new_id(),
                        chore_definition_id=definition.id,
                        member_id=member_id,
                        due_date=due_iso,
                        payout_cents=definition.payout_cents,
                        due_time=definition.due_time,
                        available_from_time=definition.available_from_time,
                        available_until_time=definition.available_until_time,
                    )
                    self.chore_assignments.append(assignment)
                    created.append(assignment)

        if created or created_bounties:
            await self._async_save()
        return created

    # ------------------------------------------------------------ bounties

    def _get_bounty(self, bounty_id: str) -> Bounty:
        for bounty in self.bounties:
            if bounty.id == bounty_id:
                return bounty
        raise ValueError(f"Unknown bounty_id {bounty_id}")

    def _get_acceptance(self, bounty: Bounty, member_id: str) -> BountyAcceptance:
        for acceptance in bounty.acceptances:
            if acceptance.member_id == member_id:
                return acceptance
        raise ValueError(f"No acceptance for member_id {member_id} on bounty {bounty.id}")

    def _default_initiative_bonus_pct(self) -> int:
        return self.payroll_config.default_initiative_bonus_pct if self.payroll_config else 30

    async def async_add_bounty(
        self,
        title: str,
        payout_cents: int,
        available_at: str,
        deadline_at: str,
        creator: Member,
        description: str | None = None,
        initiative_bonus_pct: int | None = None,
        estimated_minutes: int | None = None,
        requires_approval: bool = True,
        split_rule: str = "first_come",
        is_repeatable: bool = False,
    ) -> Bounty:
        bounty = Bounty(
            id=new_id(),
            household_id=self.household.id if self.household else "",
            title=title,
            description=description,
            payout_cents=payout_cents,
            initiative_bonus_pct=(
                initiative_bonus_pct
                if initiative_bonus_pct is not None
                else self._default_initiative_bonus_pct()
            ),
            available_at=available_at,
            deadline_at=deadline_at,
            estimated_minutes=estimated_minutes,
            requires_approval=requires_approval,
            split_rule=SplitRule(split_rule),
            created_by_member_id=creator.id,
            is_repeatable=is_repeatable,
        )
        self.bounties.append(bounty)
        await self._async_save()
        return bounty

    async def async_add_bounty_from_chore(
        self,
        chore_definition_id: str,
        available_at: str,
        deadline_at: str,
        creator: Member,
        payout_cents: int | None = None,
        initiative_bonus_pct: int | None = None,
        estimated_minutes: int | None = None,
        split_rule: str = "first_come",
        is_repeatable: bool = False,
    ) -> Bounty:
        definition = self._get_chore_definition(chore_definition_id)
        bounty = Bounty(
            id=new_id(),
            household_id=self.household.id if self.household else "",
            source_chore_definition_id=definition.id,
            title=definition.title,
            description=definition.description,
            payout_cents=payout_cents if payout_cents is not None else definition.payout_cents,
            initiative_bonus_pct=(
                initiative_bonus_pct
                if initiative_bonus_pct is not None
                else self._default_initiative_bonus_pct()
            ),
            available_at=available_at,
            deadline_at=deadline_at,
            estimated_minutes=estimated_minutes,
            requires_approval=definition.requires_approval,
            split_rule=SplitRule(split_rule),
            created_by_member_id=creator.id,
            is_repeatable=is_repeatable,
        )
        self.bounties.append(bounty)
        await self._async_save()
        return bounty

    def _notify_member(self, member: Member | None, message: str, title: str | None = None) -> None:
        """Best-effort push notification via a member's `notify_target`
        (e.g. "notify.mobile_app_x" -> domain "notify", service "mobile_app_x").
        Never lets a notification failure break the calling mutation."""
        if member is None or not member.notify_target or self.hass is None:
            return
        try:
            domain, _, service = member.notify_target.partition(".")
            if not domain or not service:
                _LOGGER.warning(
                    "Invalid notify_target %r for member %s", member.notify_target, member.id
                )
                return
            data: dict[str, Any] = {"message": message}
            if title:
                data["title"] = title
            self.hass.services.async_call(domain, service, data)
        except Exception:  # noqa: BLE001 - best-effort, must never raise
            _LOGGER.exception("Failed to notify member %s via %s", member.id, member.notify_target)

    def _create_bounty_from_assignment(
        self,
        assignment: ChoreAssignment,
        definition: ChoreDefinition,
        available_at: str,
        deadline_at: str,
        creator_id: str,
        initiative_bonus_pct: int | None = None,
        split_rule: str = "first_come",
        is_repeatable: bool = False,
    ) -> Bounty:
        """Shared by `async_convert_assignment_to_bounty` and the
        CONVERT_TO_BOUNTY branch of `async_process_overdue_chores` - builds
        the Bounty, removes the source assignment, fires the
        `hustle_chore_converted_to_bounty` event, and sends notifications.
        Does not save - callers persist via `_async_save`.

        `creator_id` is who gets attributed as `created_by_member_id`: the
        acting parent for a manual conversion, or the original assignee's id
        for the automatic overdue job (there's no human actor in that path,
        so attributing it to whoever's chore triggered it is the closest
        equivalent) - never assumed to be the original assignee by default."""
        bounty = Bounty(
            id=new_id(),
            household_id=self.household.id if self.household else "",
            source_chore_definition_id=definition.id,
            title=definition.title,
            description=definition.description,
            payout_cents=definition.payout_cents,
            initiative_bonus_pct=(
                initiative_bonus_pct
                if initiative_bonus_pct is not None
                else self._default_initiative_bonus_pct()
            ),
            available_at=available_at,
            deadline_at=deadline_at,
            requires_approval=definition.requires_approval,
            split_rule=SplitRule(split_rule),
            created_by_member_id=creator_id,
            original_assignee_member_id=assignment.member_id,
            overdue_penalty_pct=definition.overdue_penalty_pct,
            is_repeatable=is_repeatable,
        )
        self.bounties.append(bounty)
        self.chore_assignments = [a for a in self.chore_assignments if a.id != assignment.id]

        original_member = next(
            (m for m in self.members if m.id == assignment.member_id), None
        )
        if self.hass is not None:
            self.hass.bus.async_fire(
                "hustle_chore_converted_to_bounty",
                {
                    "member_id": assignment.member_id,
                    "chore_title": definition.title,
                    "bounty_id": bounty.id,
                },
            )
        self._notify_member(
            original_member,
            f'Your chore "{definition.title}" is overdue and is now open as a bounty.',
            title="Chore converted to bounty",
        )
        for candidate in self.members:
            if (
                candidate.role == MemberRole.CHILD
                and candidate.active
                and candidate.id != assignment.member_id
            ):
                self._notify_member(
                    candidate,
                    f'A new bounty is available: "{definition.title}".',
                    title="New bounty available",
                )
        return bounty

    async def async_convert_assignment_to_bounty(
        self,
        assignment_id: str,
        available_at: str,
        deadline_at: str,
        creator: Member,
        initiative_bonus_pct: int | None = None,
        split_rule: str = "first_come",
        is_repeatable: bool = False,
    ) -> Bounty:
        assignment = self._get_assignment(assignment_id)
        definition = self._get_chore_definition(assignment.chore_definition_id)
        bounty = self._create_bounty_from_assignment(
            assignment,
            definition,
            available_at,
            deadline_at,
            creator_id=creator.id,
            initiative_bonus_pct=initiative_bonus_pct,
            split_rule=split_rule,
            is_repeatable=is_repeatable,
        )
        await self._async_save()
        return bounty

    async def async_update_bounty(self, bounty_id: str, **fields: Any) -> Bounty:
        bounty = self._get_bounty(bounty_id)
        if "split_rule" in fields and fields["split_rule"] is not None:
            fields["split_rule"] = SplitRule(fields["split_rule"])
        for key, value in fields.items():
            if value is not None and hasattr(bounty, key):
                setattr(bounty, key, value)
        bounty.updated_at = now_iso()
        await self._async_save()
        return bounty

    async def async_cancel_bounty(self, bounty_id: str) -> Bounty:
        bounty = self._get_bounty(bounty_id)
        if bounty.status != BountyStatus.OPEN:
            raise ValueError(f"Cannot cancel a bounty in status '{bounty.status.value}'.")
        bounty.status = BountyStatus.CANCELLED
        bounty.updated_at = now_iso()
        await self._async_save()
        return bounty

    def _recompute_payouts(self, bounty: Bounty) -> None:
        if bounty.split_rule == SplitRule.PARENT_DECIDES:
            return
        completions = [a for a in bounty.acceptances if a.status == AcceptanceStatus.COMPLETED]
        if bounty.original_assignee_member_id is not None:
            payouts = logic.resolve_overdue_bounty_payout(
                bounty, completions, bounty.overdue_penalty_pct or 0
            )
        else:
            payouts = logic.resolve_payout(bounty, completions)
        for acceptance in completions:
            acceptance.payout_cents = payouts.get(acceptance.member_id, 0)

    def _finalize_bounty_completion(self, bounty: Bounty) -> None:
        """Called right after an acceptance transitions to COMPLETED, from
        both async_submit_bounty_acceptance (auto-approve) and
        async_complete_bounty_acceptance (parent-approved). A repeatable
        bounty always closes this instance and spawns a fresh one - same
        or a different kid can complete it again - regardless of
        split_rule; a non-repeatable bounty keeps the existing rule of only
        first_come auto-closing on completion."""
        if bounty.is_repeatable:
            bounty.status = BountyStatus.CLOSED
            self._respawn_repeatable_bounty(bounty)
        elif bounty.split_rule == SplitRule.FIRST_COME:
            bounty.status = BountyStatus.CLOSED

    def _respawn_repeatable_bounty(self, source: Bounty) -> None:
        """Clones a just-closed repeatable bounty into a fresh, empty-
        acceptances instance so it can be accepted/completed again, as long
        as the original campaign's deadline hasn't already passed."""
        now = datetime.now(UTC)
        deadline = datetime.fromisoformat(source.deadline_at)
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=UTC)
        if deadline <= now:
            return  # campaign's over - don't spawn an already-expired bounty
        self.bounties.append(
            Bounty(
                id=new_id(),
                household_id=source.household_id,
                title=source.title,
                description=source.description,
                source_chore_definition_id=source.source_chore_definition_id,
                payout_cents=source.payout_cents,
                initiative_bonus_pct=source.initiative_bonus_pct,
                available_at=now.isoformat(),
                deadline_at=source.deadline_at,
                estimated_minutes=source.estimated_minutes,
                requires_approval=source.requires_approval,
                split_rule=source.split_rule,
                created_by_member_id=source.created_by_member_id,
                is_repeatable=True,
            )
        )

    async def async_close_bounty(self, bounty_id: str) -> Bounty:
        bounty = self._get_bounty(bounty_id)
        if bounty.status != BountyStatus.OPEN:
            raise ValueError(f"Cannot close a bounty in status '{bounty.status.value}'.")
        if bounty.split_rule == SplitRule.PARENT_DECIDES:
            completed = [a for a in bounty.acceptances if a.status == AcceptanceStatus.COMPLETED]
            if any(a.payout_cents is None for a in completed):
                raise ValueError("Finalize the payout split before closing this bounty.")
        else:
            self._recompute_payouts(bounty)
        bounty.status = BountyStatus.CLOSED
        if bounty.is_repeatable:
            self._respawn_repeatable_bounty(bounty)
        bounty.updated_at = now_iso()
        await self._async_save()
        return bounty

    async def async_accept_bounty(self, bounty_id: str, member: Member) -> Bounty:
        bounty = self._get_bounty(bounty_id)
        if bounty.status != BountyStatus.OPEN:
            raise ValueError("This bounty is no longer open for acceptance.")
        now = datetime.now(UTC)
        available_at = datetime.fromisoformat(bounty.available_at)
        deadline_at = datetime.fromisoformat(bounty.deadline_at)
        if available_at.tzinfo is None:
            available_at = available_at.replace(tzinfo=UTC)
        if deadline_at.tzinfo is None:
            deadline_at = deadline_at.replace(tzinfo=UTC)
        if now < available_at or now > deadline_at:
            raise ValueError("This bounty is not currently available to accept.")

        if any(a.member_id == member.id for a in bounty.acceptances):
            raise ValueError("You've already accepted this bounty.")

        bounty.acceptances.append(BountyAcceptance(member_id=member.id))
        bounty.updated_at = now_iso()
        await self._async_save()
        return bounty

    async def async_submit_bounty_acceptance(
        self, bounty_id: str, member_id: str, actor: Member
    ) -> Bounty:
        bounty = self._get_bounty(bounty_id)
        acceptance = self._get_acceptance(bounty, member_id)
        if actor.role == MemberRole.CHILD and acceptance.member_id != actor.id:
            raise ValueError("You can only submit your own bounty work.")
        if acceptance.status != AcceptanceStatus.ACCEPTED:
            raise ValueError(
                f"Cannot submit a bounty acceptance in status '{acceptance.status.value}'."
            )

        now = now_iso()
        acceptance.submitted_at = now

        if bounty.requires_approval:
            acceptance.status = AcceptanceStatus.SUBMITTED
        else:
            acceptance.status = AcceptanceStatus.COMPLETED
            acceptance.completed_at = now
            self._recompute_payouts(bounty)
            self._finalize_bounty_completion(bounty)
            self._record_activity(
                "bounty_completed",
                title="Bounty completed",
                message=f'{actor.ha_display_name} completed the bounty "{bounty.title}".',
                member_id=member_id,
                amount_cents=acceptance.payout_cents,
            )

        bounty.updated_at = now
        await self._async_save()
        return bounty

    async def async_complete_bounty_acceptance(
        self, bounty_id: str, member_id: str, approver: Member
    ) -> Bounty:
        bounty = self._get_bounty(bounty_id)
        acceptance = self._get_acceptance(bounty, member_id)
        if acceptance.status != AcceptanceStatus.SUBMITTED:
            raise ValueError(
                f"Cannot complete a bounty acceptance in status '{acceptance.status.value}'."
            )

        acceptance.status = AcceptanceStatus.COMPLETED
        acceptance.completed_at = now_iso()
        acceptance.approved_by_member_id = approver.id
        self._recompute_payouts(bounty)
        self._finalize_bounty_completion(bounty)

        member = next((m for m in self.members if m.id == member_id), None)
        self._record_activity(
            "bounty_completed",
            title="Bounty completed",
            message=(
                f"{member.ha_display_name if member else member_id} "
                f'completed the bounty "{bounty.title}".'
            ),
            member_id=member_id,
            amount_cents=acceptance.payout_cents,
        )

        bounty.updated_at = now_iso()
        await self._async_save()
        return bounty

    async def async_finalize_bounty_split(
        self, bounty_id: str, allocations: dict[str, int]
    ) -> Bounty:
        bounty = self._get_bounty(bounty_id)
        if bounty.split_rule != SplitRule.PARENT_DECIDES:
            raise ValueError(
                "Only bounties with split_rule='parent_decides' support manual split "
                "finalization."
            )

        max_total = logic.total_payout_cents(bounty)
        if sum(allocations.values()) > max_total:
            raise ValueError(f"Allocations exceed the bounty's total payout of {max_total} cents.")

        completions = {
            a.member_id: a for a in bounty.acceptances if a.status == AcceptanceStatus.COMPLETED
        }
        for member_id, cents in allocations.items():
            if member_id not in completions:
                raise ValueError(f"Member {member_id} has not completed this bounty.")
            completions[member_id].payout_cents = cents

        bounty.updated_at = now_iso()
        await self._async_save()
        return bounty

    async def async_expire_stale_bounties(self) -> list[Bounty]:
        now = datetime.now(UTC)
        stale = []
        for bounty in self.bounties:
            if bounty.status != BountyStatus.OPEN:
                continue
            deadline_at = datetime.fromisoformat(bounty.deadline_at)
            if deadline_at.tzinfo is None:
                deadline_at = deadline_at.replace(tzinfo=UTC)
            if deadline_at < now:
                bounty.status = BountyStatus.EXPIRED
                bounty.updated_at = now_iso()
                stale.append(bounty)
        if stale:
            await self._async_save()
        else:
            # Closed (claimed) bounties stay on the board until their
            # deadline passes without any status field changing - nudge
            # listeners so sensor.py's dynamic-entity sync re-evaluates
            # board visibility purely off the current time, even when
            # there's nothing new to persist.
            self.async_set_updated_data(self._build_public_data())
        return stale

    async def async_process_overdue_chores(self) -> None:
        """Scans ASSIGNED (not SUBMITTED - those are mid-review) assignments
        whose due datetime has passed and whose definition has an
        overdue_action configured, applying that action."""
        now = datetime.now(UTC)
        now_local = _local_now()
        changed = False
        for assignment in list(self.chore_assignments):
            if assignment.status != ChoreAssignmentStatus.ASSIGNED:
                continue
            definition = next(
                (d for d in self.chore_definitions if d.id == assignment.chore_definition_id),
                None,
            )
            if definition is None or definition.overdue_action is None:
                continue
            if not logic.is_overdue(assignment.due_date, assignment.due_time, now_local):
                continue

            if definition.overdue_action == OverdueAction.REMOVE:
                self.chore_assignments = [
                    a for a in self.chore_assignments if a.id != assignment.id
                ]
                changed = True

            elif definition.overdue_action == OverdueAction.CONVERT_TO_BOUNTY:
                due = logic.effective_due_datetime(assignment.due_date, assignment.due_time)
                if due.tzinfo is None:
                    due = due.replace(tzinfo=UTC)
                bounty_hours = definition.overdue_bounty_hours or 5
                self._create_bounty_from_assignment(
                    assignment,
                    definition,
                    available_at=now.isoformat(),
                    deadline_at=(due + timedelta(hours=bounty_hours)).isoformat(),
                    # No human actor triggers this - the scheduler is the
                    # "creator." Attributing to the original assignee is the
                    # closest equivalent to what created_by_member_id means
                    # for a manual conversion.
                    creator_id=assignment.member_id,
                )
                changed = True

            elif definition.overdue_action == OverdueAction.DEDUCT:
                deduction_cents = definition.overdue_deduction_cents or 0
                behavior_entry = BehaviorEntry(
                    id=new_id(),
                    behavior_type_id="",
                    member_id=assignment.member_id,
                    amount_cents=-abs(deduction_cents),
                    recorded_by_member_id=assignment.member_id,
                    note=f"Overdue chore: {definition.title}",
                )
                self.behavior_entries.append(behavior_entry)
                self.chore_assignments = [
                    a for a in self.chore_assignments if a.id != assignment.id
                ]
                changed = True

        if changed:
            await self._async_save()

    async def async_unassign_all_chores(self) -> int:
        """Household-wide reset: removes every chore assignment not yet
        approved (assigned, submitted, rejected). Approved assignments are
        historical/paid-eligible and are never touched. Returns the count
        removed."""
        before = len(self.chore_assignments)
        self.chore_assignments = [
            a for a in self.chore_assignments if a.status == ChoreAssignmentStatus.APPROVED
        ]
        removed = before - len(self.chore_assignments)
        if removed:
            await self._async_save()
        return removed

    async def async_remove_all_bounties(self) -> int:
        """Household-wide reset: cancels every open bounty (same status
        flip as async_cancel_bounty, applied in bulk). Closed/expired/
        already-cancelled bounties are historical and never touched.
        Returns the count cancelled."""
        count = 0
        for bounty in self.bounties:
            if bounty.status == BountyStatus.OPEN:
                bounty.status = BountyStatus.CANCELLED
                bounty.updated_at = now_iso()
                count += 1
        if count:
            await self._async_save()
        return count

    async def async_reset_account_earnings(self) -> None:
        """Clear financial history, retaining accounts, catalogs and unfinished work."""
        self.earnings_reset_at = now_iso()
        self.paychecks.clear()
        self.pay_periods.clear()
        for assignment in self.chore_assignments:
            if assignment.status == ChoreAssignmentStatus.APPROVED:
                assignment.payout_cents = 0
        for bounty in self.bounties:
            for acceptance in bounty.acceptances:
                if acceptance.status == AcceptanceStatus.COMPLETED:
                    acceptance.payout_cents = 0
        for entry in self.grade_entries:
            entry.grade_value_cents = 0
        for entry in self.behavior_entries:
            entry.amount_cents = 0
        self.recent_activity = [
            entry for entry in self.recent_activity
            if entry.amount_cents is None and not entry.event_type.startswith("pay")
        ]
        self._record_activity(
            "account_earnings_reset", title="Earnings history reset",
            message="All account earnings and paycheck history were reset.",
        )
        await self._async_save()

    async def async_reset_current_period_paychecks(self) -> int:
        """Zeroes out every child's paycheck for the current pay period -
        a blank-slate reset that discards whatever's been computed/
        approved so far this week, regardless of what's actually on
        record (that's what async_generate_pay_period(regenerate=True) is
        for - a recompute, not a reset). Parents' paychecks are untouched.
        Returns the count reset."""
        period = await self.async_get_or_create_current_period()
        child_ids = {m.id for m in self.members if m.role == MemberRole.CHILD}
        count = 0
        for paycheck in self.paychecks:
            if paycheck.pay_period_id != period.id or paycheck.member_id not in child_ids:
                continue
            paycheck.gross_cents = 0
            paycheck.net_cents = 0
            paycheck.line_items = []
            paycheck.status = PaycheckStatus.DRAFT
            paycheck.approved_by_member_id = None
            paycheck.approved_at = None
            paycheck.paid_at = None
            paycheck.updated_at = now_iso()
            count += 1
        if count:
            await self._async_save()
        return count

    # -------------------------------------------------------------- grades

    def _get_subject(self, subject_id: str) -> Subject:
        for subject in self.subjects:
            if subject.id == subject_id:
                return subject
        raise ValueError(f"Unknown subject_id {subject_id}")

    async def async_add_subject(self, name: str) -> Subject:
        subject = Subject(
            id=new_id(), household_id=self.household.id if self.household else "", name=name
        )
        self.subjects.append(subject)
        await self._async_save()
        return subject

    async def async_update_subject(self, subject_id: str, **fields: Any) -> Subject:
        subject = self._get_subject(subject_id)
        for key, value in fields.items():
            if value is not None and hasattr(subject, key):
                setattr(subject, key, value)
        subject.updated_at = now_iso()
        await self._async_save()
        return subject

    async def async_update_grade_scale(
        self, entries: list[dict[str, Any]]
    ) -> list[GradeScaleEntry]:
        by_letter = {g.letter: g for g in self.grade_scale}
        seen_letters = set()
        for entry_data in entries:
            letter = entry_data["letter"]
            seen_letters.add(letter)
            if letter in by_letter:
                by_letter[letter].value_cents = entry_data["value_cents"]
                by_letter[letter].sort_order = entry_data.get("sort_order", 0)
            else:
                new_entry = GradeScaleEntry(
                    letter=letter,
                    value_cents=entry_data["value_cents"],
                    sort_order=entry_data.get("sort_order", 0),
                )
                self.grade_scale.append(new_entry)
                by_letter[letter] = new_entry

        self.grade_scale = [g for g in self.grade_scale if g.letter in seen_letters]
        await self._async_save()
        return self.grade_scale

    def _grade_value_lookup(self) -> dict[str, int]:
        return {g.letter: g.value_cents for g in self.grade_scale}

    async def async_record_grade(
        self,
        subject_id: str,
        member_id: str,
        grade_letter: str,
        period_label: str,
        recorder: Member,
        note: str | None = None,
    ) -> GradeEntry:
        values = self._grade_value_lookup()
        if grade_letter not in values:
            raise ValueError(
                f"'{grade_letter}' is not a configured grade in this household's scale."
            )
        self._get_subject(subject_id)  # raises if unknown

        entry = GradeEntry(
            id=new_id(),
            subject_id=subject_id,
            member_id=member_id,
            grade_letter=grade_letter,
            grade_value_cents=values[grade_letter],
            period_label=period_label,
            note=note,
            entered_by_member_id=recorder.id,
        )
        self.grade_entries.append(entry)
        await self._async_save()
        return entry

    def _get_grade_entry(self, entry_id: str) -> GradeEntry:
        for entry in self.grade_entries:
            if entry.id == entry_id:
                return entry
        raise ValueError(f"Unknown grade_entry_id {entry_id}")

    async def async_update_grade_entry(self, entry_id: str, **fields: Any) -> GradeEntry:
        entry = self._get_grade_entry(entry_id)
        if "grade_letter" in fields and fields["grade_letter"] is not None:
            values = self._grade_value_lookup()
            if fields["grade_letter"] not in values:
                raise ValueError(
                    f"'{fields['grade_letter']}' is not a configured grade "
                    "in this household's scale."
                )
            entry.grade_value_cents = values[fields["grade_letter"]]
        for key, value in fields.items():
            if value is not None and hasattr(entry, key):
                setattr(entry, key, value)
        await self._async_save()
        return entry

    async def async_delete_grade_entry(self, entry_id: str) -> None:
        self.grade_entries = [e for e in self.grade_entries if e.id != entry_id]
        await self._async_save()

    # ------------------------------------------------------------ behavior

    def _get_behavior_type(self, type_id: str) -> BehaviorType:
        for behavior_type in self.behavior_types:
            if behavior_type.id == type_id:
                return behavior_type
        raise ValueError(f"Unknown behavior_type_id {type_id}")

    @staticmethod
    def _signed(amount: int, category: str) -> int:
        magnitude = abs(amount)
        return -magnitude if category == "deduction" else magnitude

    async def async_add_behavior_type(
        self, label: str, category: str, default_amount_cents: int, icon: str | None = None
    ) -> BehaviorType:
        behavior_type = BehaviorType(
            id=new_id(),
            household_id=self.household.id if self.household else "",
            label=label,
            category=BehaviorCategory(category),
            default_amount_cents=self._signed(default_amount_cents, category),
            icon=icon,
        )
        self.behavior_types.append(behavior_type)
        await self._async_save()
        return behavior_type

    async def async_update_behavior_type(self, type_id: str, **fields: Any) -> BehaviorType:
        behavior_type = self._get_behavior_type(type_id)
        if "default_amount_cents" in fields and fields["default_amount_cents"] is not None:
            fields["default_amount_cents"] = self._signed(
                fields["default_amount_cents"], behavior_type.category.value
            )
        for key, value in fields.items():
            if value is not None and hasattr(behavior_type, key):
                setattr(behavior_type, key, value)
        behavior_type.updated_at = now_iso()
        await self._async_save()
        return behavior_type

    async def async_record_behavior_entry(
        self,
        behavior_type_id: str,
        member_id: str,
        recorder: Member,
        amount_cents: int | None = None,
        note: str | None = None,
    ) -> BehaviorEntry:
        behavior_type = self._get_behavior_type(behavior_type_id)
        amount = (
            self._signed(amount_cents, behavior_type.category.value)
            if amount_cents is not None
            else behavior_type.default_amount_cents
        )
        entry = BehaviorEntry(
            id=new_id(),
            behavior_type_id=behavior_type.id,
            member_id=member_id,
            amount_cents=amount,
            note=note,
            recorded_by_member_id=recorder.id,
        )
        self.behavior_entries.append(entry)
        self._record_activity(
            "behavior_recorded",
            title=behavior_type.label,
            message=behavior_type.label,
            member_id=member_id,
            amount_cents=amount,
        )
        await self._async_save()
        return entry

    async def async_delete_behavior_entry(self, entry_id: str) -> None:
        self.behavior_entries = [e for e in self.behavior_entries if e.id != entry_id]
        await self._async_save()

    # ------------------------------------------------------------- payroll

    async def async_get_or_create_current_period(self, as_of: date | None = None) -> PayPeriod:
        if self.payroll_config is None:
            raise ValueError("Payroll has not been configured for this household yet.")
        as_of = as_of or _today()
        start, end, payday = logic.compute_period(
            self.payroll_config.payday_rule, self.payroll_config.recurrence.value, as_of
        )
        for period in self.pay_periods:
            if period.start_date == start.isoformat() and period.end_date == end.isoformat():
                return period

        period = PayPeriod(
            id=new_id(),
            household_id=self.household.id if self.household else "",
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            payday_date=payday.isoformat(),
        )
        self.pay_periods.append(period)
        await self._async_save()
        return period

    def _get_period(self, period_id: str) -> PayPeriod:
        for period in self.pay_periods:
            if period.id == period_id:
                return period
        raise ValueError(f"Unknown pay_period_id {period_id}")

    def _eligible_members(self) -> list[Member]:
        pay_parents_too = self.payroll_config.pay_parents_too if self.payroll_config else False
        members = [m for m in self.members if m.active]
        if not pay_parents_too:
            members = [m for m in members if m.role == MemberRole.CHILD]
        return members

    async def async_generate_pay_period(
        self, period_id: str, regenerate: bool = False
    ) -> list[Paycheck]:
        if self.payroll_config is None:
            raise ValueError("Payroll has not been configured for this household yet.")
        period = self._get_period(period_id)

        existing = [p for p in self.paychecks if p.pay_period_id == period.id]
        if existing:
            if not regenerate:
                raise ValueError("Payroll has already been generated for this pay period.")
            existing_ids = {p.id for p in existing}
            self.paychecks = [p for p in self.paychecks if p.id not in existing_ids]

        members = self._eligible_members()
        now = now_iso()
        created: list[Paycheck] = []
        for member in members:
            lines: list[dict[str, Any]] = []
            lines.extend(
                logic.collect_chore_earnings(
                    self.chore_assignments, self.chore_definitions, member.id, period,
                    since=self.earnings_reset_at
                )
            )
            lines.extend(logic.collect_bounty_earnings(
                self.bounties, member.id, period, since=self.earnings_reset_at
            ))
            lines.extend(
                logic.collect_grade_earnings(self.grade_entries, self.subjects, member.id, period,
                    since=self.earnings_reset_at)
            )
            lines.extend(
                logic.collect_behavior_earnings(
                    self.behavior_entries, self.behavior_types, member.id, period,
                    since=self.earnings_reset_at
                )
            )

            gross_cents, net_cents = logic.aggregate_paycheck(lines)
            requires_approval = logic.requires_paycheck_approval(self.payroll_config, net_cents)

            paycheck = Paycheck(
                id=new_id(),
                pay_period_id=period.id,
                member_id=member.id,
                gross_cents=gross_cents,
                net_cents=net_cents,
                status=(
                    PaycheckStatus.PENDING_APPROVAL
                    if requires_approval
                    else PaycheckStatus.APPROVED
                ),
                approved_at=None if requires_approval else now,
                line_items=[
                    PaycheckLineItem(
                        earning_source_type=line["source_type"],
                        source_ref_id=line["source_ref_id"],
                        description=line["description"],
                        amount_cents=line["amount_cents"],
                        line_metadata=line["metadata"],
                    )
                    for line in lines
                ],
            )
            self.paychecks.append(paycheck)
            created.append(paycheck)

        period.status = PayPeriodStatus.GENERATED
        period.updated_at = now
        self._record_activity(
            "payroll_generated",
            title="Payroll generated",
            message=f"Payroll for {period.start_date} to {period.end_date} is ready for review.",
        )
        await self._async_save()
        return created

    def _recompute_period_status(self, pay_period_id: str) -> None:
        paychecks = [p for p in self.paychecks if p.pay_period_id == pay_period_id]
        if not paychecks:
            return
        period = self._get_period(pay_period_id)
        if all(p.status == PaycheckStatus.PAID for p in paychecks):
            period.status = PayPeriodStatus.PAID
        elif all(p.status in (PaycheckStatus.APPROVED, PaycheckStatus.PAID) for p in paychecks):
            period.status = PayPeriodStatus.APPROVED
        else:
            period.status = PayPeriodStatus.GENERATED

    def _get_paycheck(self, paycheck_id: str) -> Paycheck:
        for paycheck in self.paychecks:
            if paycheck.id == paycheck_id:
                return paycheck
        raise ValueError(f"Unknown paycheck_id {paycheck_id}")

    async def async_approve_paycheck(self, paycheck_id: str, approver: Member) -> Paycheck:
        paycheck = self._get_paycheck(paycheck_id)
        if paycheck.status != PaycheckStatus.PENDING_APPROVAL:
            raise ValueError(f"Cannot approve a paycheck in status '{paycheck.status.value}'.")
        paycheck.status = PaycheckStatus.APPROVED
        paycheck.approved_by_member_id = approver.id
        paycheck.approved_at = now_iso()
        self._recompute_period_status(paycheck.pay_period_id)
        await self._async_save()
        return paycheck

    async def async_mark_paycheck_paid(self, paycheck_id: str) -> Paycheck:
        paycheck = self._get_paycheck(paycheck_id)
        if paycheck.status != PaycheckStatus.APPROVED:
            raise ValueError(
                f"Cannot mark a paycheck paid from status '{paycheck.status.value}'; "
                "it must be approved first."
            )
        paycheck.status = PaycheckStatus.PAID
        paycheck.paid_at = now_iso()
        self._recompute_period_status(paycheck.pay_period_id)
        await self._async_save()
        return paycheck


    # ------------------------------------------- family calendar + meals
    # Add-on additions, not from the integration. Calendar events live in
    # Home Assistant's calendars (Google Calendar via its integration - see
    # family_calendar.py); Hustle only keeps which calendars to use and who
    # each event is for/who's attending, keyed by event_tag_key(). The
    # grocery list is the Household integration's GroceryListStore, now a
    # top-level key here.

    def _today_chore_progress(self) -> dict[str, dict[str, int]]:
        """Per member, today's chores done vs total - the calendar header's
        progress bars (Skylight's "Dad 1/5")."""
        today = _today().isoformat()
        progress: dict[str, dict[str, int]] = {}
        for assignment in self.chore_assignments:
            if assignment.due_date != today:
                continue
            entry = progress.setdefault(assignment.member_id, {"done": 0, "total": 0})
            entry["total"] += 1
            if assignment.status in (
                ChoreAssignmentStatus.SUBMITTED,
                ChoreAssignmentStatus.APPROVED,
            ):
                entry["done"] += 1
        return progress

    async def async_update_calendar_settings(self, **fields: Any) -> dict[str, Any]:
        for key, value in fields.items():
            if key not in self.calendar_settings:
                raise ValueError(f"Unknown calendar setting {key}")
            self.calendar_settings[key] = value
        await self._async_save()
        return self.calendar_settings

    async def async_set_event_tags(
        self,
        key: str,
        for_member_id: str | None,
        attendee_ids: list[str],
    ) -> dict[str, Any]:
        known = {m.id for m in self.members}
        for member_id in [for_member_id, *attendee_ids]:
            if member_id and member_id not in known:
                raise ValueError(f"Unknown member_id {member_id}")
        if not for_member_id and not attendee_ids:
            self.event_tags.pop(key, None)
            await self._async_save()
            return {}
        tags = {
            "for_member_id": for_member_id or None,
            "attendee_ids": list(dict.fromkeys(attendee_ids)),
            "updated_at": now_iso(),
        }
        self.event_tags[key] = tags
        await self._async_save()
        return tags

    async def async_remove_event_tags(self, key: str) -> None:
        if self.event_tags.pop(key, None) is not None:
            await self._async_save()

    async def async_save_grocery_list(self, categories: list[dict[str, Any]]) -> None:
        self.grocery_list = {"categories": categories, "generated_at": now_iso()}
        await self._async_save()

    # ------------------------------------------------------------ recipes
    # The Meals tab's recipe box. Plain dicts in the RECIPE_FIELDS shape -
    # recipes.py validates them; there's no business logic to put in a
    # model. Dinners link to a recipe by title (calendar events can't carry
    # an id), so titles are kept unique, case-insensitively.

    def _get_recipe(self, recipe_id: str) -> dict[str, Any]:
        for recipe in self.recipes:
            if recipe["id"] == recipe_id:
                return recipe
        raise ValueError(f"Unknown recipe_id {recipe_id}")

    def _check_recipe_title(self, title: str, recipe_id: str | None = None) -> str:
        title = title.strip()
        if not title:
            raise ValueError("A recipe needs a name.")
        for recipe in self.recipes:
            if recipe["id"] != recipe_id and recipe["title"].strip().lower() == title.lower():
                raise ValueError(f'There\'s already a recipe called "{recipe["title"]}".')
        return title

    async def async_add_recipe(
        self, created_by: str | None = None, **fields: Any
    ) -> dict[str, Any]:
        now = now_iso()
        recipe = {
            **fields,
            "id": new_id(),
            "title": self._check_recipe_title(fields["title"]),
            "created_by": created_by,
            "created_at": now,
            "updated_at": now,
        }
        self.recipes.append(recipe)
        self.recipes.sort(key=lambda r: r["title"].lower())
        await self._async_save()
        return recipe

    async def async_update_recipe(self, recipe_id: str, **fields: Any) -> dict[str, Any]:
        recipe = self._get_recipe(recipe_id)
        if "title" in fields:
            fields["title"] = self._check_recipe_title(fields["title"], recipe_id)
        recipe.update(fields)
        recipe["updated_at"] = now_iso()
        self.recipes.sort(key=lambda r: r["title"].lower())
        await self._async_save()
        return recipe

    async def async_move_event_tags(self, old_key: str, new_key: str) -> None:
        """An event re-created under a new uid keeps its tags."""
        tags = self.event_tags.pop(old_key, None)
        if tags is not None:
            self.event_tags[new_key] = tags
            await self._async_save()

    async def async_delete_recipe(self, recipe_id: str) -> None:
        self._get_recipe(recipe_id)
        self.recipes = [r for r in self.recipes if r["id"] != recipe_id]
        await self._async_save()
