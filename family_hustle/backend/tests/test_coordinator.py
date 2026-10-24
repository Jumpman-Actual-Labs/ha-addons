"""Coordinator lifecycle + permission-gating tests.

Redesigned per the plan from the old FastAPI AsyncClient-based test suite
(test_chores.py, test_bounties.py, test_members.py, test_grades.py,
test_behavior.py, test_payroll.py, test_auth.py) to call
`coordinator.async_*` methods directly against an in-memory
`HustleCoordinator`, with no HTTP layer and no SQLite fixture. Permission
gating (parent vs child, admin vs standard) is enforced in services.py in
the real integration; here we exercise the coordinator methods themselves
(which trust their caller) and separately assert the guard logic that
services.py layers on top, calling the same `_require_parent`/
`_require_parent_admin` helpers services.py uses.
"""
from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta

import pytest

from hustle_addon.const import (
    AcceptanceStatus,
    BountyStatus,
    ChoreAssignmentStatus,
    OverdueAction,
    PaycheckStatus,
    PermissionLevel,
)
from hustle_addon.coordinator import HustleCoordinator
from hustle_addon.models import ChoreDefinition
from hustle_addon.services import HomeAssistantError, _require_parent_admin
from hustle_addon.storage import default_data


class FakeStore:
    """In-memory stand-in for HustleStore - no real HA Store needed."""

    def __init__(self):
        self._data = None

    async def async_load(self):
        return self._data

    async def async_save(self, data):
        self._data = data


class FakeBus:
    def __init__(self):
        self.fired = []

    def async_fire(self, event_type, payload):
        self.fired.append((event_type, payload))


class FakeServices:
    """Stand-in for hass.services - records calls, never actually dispatches
    anything (there's no real notify.* platform in these unit tests)."""

    def __init__(self):
        self.calls = []

    def async_call(self, domain, service, data):
        self.calls.append((domain, service, data))


class FakeHass:
    def __init__(self):
        self.bus = FakeBus()
        self.services = FakeServices()

    def async_create_task(self, coro):
        # Real hass.async_create_task schedules on the running loop without
        # the caller awaiting it - image generation is fire-and-forget from
        # the coordinator's perspective, so tests do the same.
        return asyncio.ensure_future(coro)


class FakeCall:
    """Stand-in for homeassistant.core.ServiceCall, carrying just what
    services.py's guard helpers need: .data and .context.user_id."""

    def __init__(self, user_id: str | None, **data):
        self.data = data
        self.context = type("Context", (), {"user_id": user_id})()


@pytest.fixture
async def coordinator():
    coord = HustleCoordinator.__new__(HustleCoordinator)
    # Bypass DataUpdateCoordinator.__init__ (stubbed under conftest) - set
    # only what our code actually touches.
    coord.hass = FakeHass()
    coord.store = FakeStore()
    coord.openai_api_key = None
    coord.household = None
    coord.payroll_config = None
    coord.members = []
    coord.chore_definitions = []
    coord.chore_assignments = []
    coord.bounties = []
    coord.subjects = []
    coord.grade_scale = []
    coord.grade_entries = []
    coord.behavior_types = []
    coord.behavior_entries = []
    coord.pay_periods = []
    coord.paychecks = []
    coord.recent_activity = []
    coord._listeners = {}

    # async_set_updated_data / data property are provided by the real
    # DataUpdateCoordinator; the conftest stub's _GenericStubBase doesn't
    # implement them, so patch in a minimal working version.
    coord.data = None

    def _set_updated_data(value):
        coord.data = value

    coord.async_set_updated_data = _set_updated_data

    await coord.async_load()
    return coord


async def _setup_household(coordinator, requires_parent_approval=True, pay_parents_too=False):
    await coordinator.async_setup_household(
        name="The Smiths",
        payday_rule={"type": "weekly", "day_of_week": "FRI"},
        recurrence="weekly",
        requires_parent_approval=requires_parent_approval,
    )
    if pay_parents_too:
        await coordinator.async_update_payroll_config(pay_parents_too=True)
    return coordinator.household


async def _add_parent(coordinator, ha_user_id="ha-parent-1", name="Pat Parent"):
    # Leave permission_level unset so next_permission_level's
    # first-parent-becomes-admin auto-computation kicks in (mirrors real
    # usage - callers only pass an explicit level to override that default).
    return await coordinator.async_add_member(
        ha_user_id=ha_user_id, ha_display_name=name, role="parent"
    )


async def _add_child(coordinator, ha_user_id="ha-child-1", name="Charlie Child"):
    return await coordinator.async_add_member(
        ha_user_id=ha_user_id, ha_display_name=name, role="child"
    )


# ---------------------------------------------------------------------------
# Household / setup
# ---------------------------------------------------------------------------


class TestHouseholdSetup:
    async def test_setup_creates_household_and_payroll_config(self, coordinator):
        household = await _setup_household(coordinator)
        assert household.name == "The Smiths"
        assert coordinator.payroll_config is not None
        assert coordinator.payroll_config.recurrence.value == "weekly"

    async def test_setup_seeds_default_grade_scale(self, coordinator):
        await _setup_household(coordinator)
        letters = {g.letter for g in coordinator.grade_scale}
        assert letters == {"A", "B", "C", "D", "F"}

    async def test_double_setup_after_completion_raises(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        await coordinator.async_complete_setup()
        with pytest.raises(ValueError):
            await _setup_household(coordinator)

    async def test_complete_setup_requires_a_parent(self, coordinator):
        await _setup_household(coordinator)
        with pytest.raises(ValueError):
            await coordinator.async_complete_setup()

    async def test_load_migrates_stale_image_paths(self, coordinator):
        # /local/hustle/ is where ha-hustle-frontend's rsync --delete
        # deploys the panel JS bundle - any chore image saved there before
        # image_gen.py moved to /local/hustle_images/ is now permanently
        # gone. Loading should clear those stale references (falls back to
        # the placeholder icon) without touching genuinely current ones.
        stale = ChoreDefinition(
            id="chore-1",
            household_id="hh-1",
            title="Dishes",
            image_path="/local/hustle/chore-1.png",
        )
        fresh = ChoreDefinition(
            id="chore-2",
            household_id="hh-1",
            title="Trash",
            image_path="/local/hustle_images/chore-2.png",
        )
        coordinator.store._data = {
            **default_data(),
            "chore_definitions": [stale.to_dict(), fresh.to_dict()],
        }
        await coordinator.async_load()

        reloaded = {d.id: d for d in coordinator.chore_definitions}
        assert reloaded["chore-1"].image_path is None
        assert reloaded["chore-2"].image_path == "/local/hustle_images/chore-2.png"


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


class TestMembers:
    async def test_first_parent_becomes_admin(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        assert parent.permission_level == PermissionLevel.ADMIN

    async def test_second_parent_also_becomes_admin(self, coordinator):
        # Every new parent defaults to admin now - managed_child_ids is what
        # actually restricts a parent to a subset of children, not
        # standard/admin permission level.
        await _setup_household(coordinator)
        await _add_parent(coordinator, "ha-parent-1", "Pat")
        second = await _add_parent(coordinator, "ha-parent-2", "Sam")
        assert second.permission_level == PermissionLevel.ADMIN

    async def test_duplicate_ha_user_link_raises(self, coordinator):
        await _setup_household(coordinator)
        await _add_child(coordinator, "ha-child-1", "Charlie")
        with pytest.raises(ValueError):
            await _add_child(coordinator, "ha-child-1", "Duplicate")

    async def test_deactivate_member(self, coordinator):
        await _setup_household(coordinator)
        child = await _add_child(coordinator)
        await coordinator.async_deactivate_member(child.id)
        assert coordinator._get_member(child.id).active is False

    async def test_child_cannot_create_member_via_service_guard(self, coordinator):
        await _setup_household(coordinator)
        _parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        call = FakeCall(user_id=child.ha_user_id)
        with pytest.raises(HomeAssistantError):
            _require_parent_admin(coordinator, call)

    async def test_parent_admin_passes_guard(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        call = FakeCall(user_id=parent.ha_user_id)
        resolved = _require_parent_admin(coordinator, call)
        assert resolved.id == parent.id

    async def test_standard_parent_fails_admin_guard(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator, "ha-parent-1", "Pat")
        standard_parent = await coordinator.async_add_member(
            ha_user_id="ha-parent-2",
            ha_display_name="Sam",
            role="parent",
            permission_level="standard",
        )
        assert standard_parent.permission_level == PermissionLevel.STANDARD
        call = FakeCall(user_id=standard_parent.ha_user_id)
        with pytest.raises(HomeAssistantError):
            _require_parent_admin(coordinator, call)


# ---------------------------------------------------------------------------
# Chores
# ---------------------------------------------------------------------------


class TestChoreLifecycle:
    async def test_create_and_assign_chore(self, coordinator):
        await _setup_household(coordinator)
        _parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Take out trash", payout_cents=200
        )

        due = date.today().isoformat()
        assignments = await coordinator.async_assign_chore(definition.id, [child.id], due)
        assert len(assignments) == 1
        assert assignments[0].member_id == child.id
        assert assignments[0].payout_cents == 200
        assert assignments[0].status == ChoreAssignmentStatus.ASSIGNED

    async def test_assigning_recurring_chore_syncs_default_assignees(self, coordinator):
        # A manual assign on a recurring chore should keep
        # default_assignee_ids in sync, so the next scheduler tick's
        # auto-generation keeps producing occurrences without a parent
        # having to separately edit the chore's settings.
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Brush teeth", payout_cents=100, recurrence_type="daily"
        )
        assert definition.default_assignee_ids == []

        due = date.today().isoformat()
        await coordinator.async_assign_chore(definition.id, [child.id], due)

        updated = next(d for d in coordinator.chore_definitions if d.id == definition.id)
        assert updated.default_assignee_ids == [child.id]

    async def test_assigning_rotating_chore_does_not_set_default_assignees(self, coordinator):
        # is_rotating chores compute their own assignee each occurrence via
        # rotation - default_assignee_ids stays empty and unused for these.
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Take out trash",
            payout_cents=100,
            recurrence_type="daily",
            is_rotating=True,
        )

        due = date.today().isoformat()
        await coordinator.async_assign_chore(definition.id, [child.id], due)

        updated = next(d for d in coordinator.chore_definitions if d.id == definition.id)
        assert updated.default_assignee_ids == []

    async def test_duplicate_assignment_is_idempotent(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)
        due = date.today().isoformat()

        first = await coordinator.async_assign_chore(definition.id, [child.id], due)
        second = await coordinator.async_assign_chore(definition.id, [child.id], due)
        assert len(first) == 1
        assert len(second) == 0

    async def test_multi_assign_still_assigns_others_when_one_already_assigned(
        self, coordinator
    ):
        # Regression: one child already having this occurrence (e.g. from
        # auto-generation beating a manual multi-select assign to it)
        # shouldn't silently drop only that child with no record of why -
        # the others in the same batch should still go through, and the
        # skip should show up in recent_activity.
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        first_child = await _add_child(coordinator, "ha-child-1", "June")
        second_child = await _add_child(coordinator, "ha-child-2", "Jodeci")
        definition = await coordinator.async_add_chore_definition(
            title="Empty the small trashcans", payout_cents=75
        )
        due = date.today().isoformat()

        await coordinator.async_assign_chore(definition.id, [first_child.id], due)
        batch = await coordinator.async_assign_chore(
            definition.id, [first_child.id, second_child.id], due
        )

        assert len(batch) == 1
        assert batch[0].member_id == second_child.id
        assert any(
            a.chore_definition_id == definition.id and a.member_id == first_child.id
            for a in coordinator.chore_assignments
        )
        assert any(
            entry.event_type == "chore_assign_skipped" and entry.member_id == first_child.id
            for entry in coordinator.recent_activity
        )

    async def test_reassign_after_approval_on_same_date_is_allowed(self, coordinator):
        # Regression: an *approved* (done, historical) assignment for a
        # given chore+child+date must not block a fresh manual assignment
        # for that same date - e.g. right after a parent uses "Unassign
        # all chores" (which deliberately preserves approved records) and
        # then tries to re-assign the same chore for today.
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Empty the small trashcans", payout_cents=75, requires_approval=False
        )
        due = date.today().isoformat()

        first = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]
        await coordinator.async_submit_chore(first.id, child)
        assert coordinator._get_assignment(first.id).status == ChoreAssignmentStatus.APPROVED

        await coordinator.async_unassign_all_chores()
        assert any(a.id == first.id for a in coordinator.chore_assignments)

        second = await coordinator.async_assign_chore(definition.id, [child.id], due)

        assert len(second) == 1
        assert second[0].id != first.id
        assert not any(
            entry.event_type == "chore_assign_skipped" for entry in coordinator.recent_activity
        )
        _ = parent

    async def test_child_cannot_submit_others_chore(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator, "ha-child-1", "Charlie")
        other_child = await _add_child(coordinator, "ha-child-2", "Casey")
        definition = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)
        due = date.today().isoformat()
        assignments = await coordinator.async_assign_chore(definition.id, [child.id], due)

        with pytest.raises(ValueError):
            await coordinator.async_submit_chore(assignments[0].id, other_child)

    async def test_approve_reject_resubmit_flow(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]

        await coordinator.async_submit_chore(assignment.id, child)
        rejected = await coordinator.async_reject_chore(
            assignment.id, "Not done well enough", parent
        )
        assert rejected.status == ChoreAssignmentStatus.REJECTED

        resubmitted = await coordinator.async_submit_chore(assignment.id, child)
        assert resubmitted.status == ChoreAssignmentStatus.SUBMITTED

        approved = await coordinator.async_approve_chore(assignment.id, parent)
        assert approved.status == ChoreAssignmentStatus.APPROVED
        assert approved.approved_by_member_id == parent.id

    async def test_auto_approve_when_not_requiring_approval(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Dishes", payout_cents=200, requires_approval=False
        )
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]

        submitted = await coordinator.async_submit_chore(assignment.id, child)
        assert submitted.status == ChoreAssignmentStatus.APPROVED

    async def test_submit_blocked_before_availability_window_opens(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Dishes", payout_cents=200, available_from_time="23:59"
        )
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]

        with pytest.raises(ValueError):
            await coordinator.async_submit_chore(assignment.id, child)

    async def test_submit_blocked_after_availability_window_closes(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Dishes", payout_cents=200, available_until_time="00:01"
        )
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]

        with pytest.raises(ValueError):
            await coordinator.async_submit_chore(assignment.id, child)

    async def test_submit_allowed_within_availability_window(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Dishes",
            payout_cents=200,
            available_from_time="00:00",
            available_until_time="23:59",
        )
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]

        submitted = await coordinator.async_submit_chore(assignment.id, child)
        assert submitted.status == ChoreAssignmentStatus.SUBMITTED
        assert submitted.available_from_time == "00:00"
        assert submitted.available_until_time == "23:59"

    async def test_prerequisite_blocks_assignment(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        prereq = await coordinator.async_add_chore_definition(title="Make bed", payout_cents=50)
        dependent = await coordinator.async_add_chore_definition(
            title="Get allowance bonus", payout_cents=100, prerequisite_ids=[prereq.id]
        )
        due = date.today().isoformat()

        # Skipped, not raised - a batch assign to multiple children
        # shouldn't lose everyone else's assignment just because one
        # child hasn't met the prerequisite yet.
        blocked = await coordinator.async_assign_chore(dependent.id, [child.id], due)
        assert blocked == []

        prereq_assignment = (await coordinator.async_assign_chore(prereq.id, [child.id], due))[0]
        await coordinator.async_submit_chore(prereq_assignment.id, child)
        await coordinator.async_approve_chore(prereq_assignment.id, parent)

        assignments = await coordinator.async_assign_chore(dependent.id, [child.id], due)
        assert len(assignments) == 1

    async def test_rotation_alternates_between_children(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator, "ha-child-1", "Charlie")
        other_child = await _add_child(coordinator, "ha-child-2", "Casey")
        definition = await coordinator.async_add_chore_definition(
            title="Wash dishes",
            payout_cents=100,
            is_rotating=True,
            rotation_order=[child.id, other_child.id],
        )
        due1 = date.today().isoformat()
        due2 = (date.today() + timedelta(days=1)).isoformat()

        first = await coordinator.async_assign_chore(definition.id, None, due1)
        second = await coordinator.async_assign_chore(definition.id, None, due2)
        assert first[0].member_id == child.id
        assert second[0].member_id == other_child.id

    async def test_generate_due_occurrences_for_daily_chore(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        await coordinator.async_add_chore_definition(
            title="Feed the dog",
            payout_cents=50,
            recurrence_type="daily",
            default_assignee_ids=[child.id],
        )

        # Chore assignments default to a same-day-only lookahead (unlike
        # bounties, which keep a week-long one) - only today's occurrence
        # exists until tomorrow's own scheduler tick creates that one.
        created = await coordinator.async_generate_due_chore_occurrences()
        assert len(created) == 1
        assert created[0].due_date == date.today().isoformat()

        created_again = await coordinator.async_generate_due_chore_occurrences()
        assert created_again == []

        tomorrow = await coordinator.async_generate_due_chore_occurrences(
            as_of=date.today() + timedelta(days=1)
        )
        assert len(tomorrow) == 1
        assert tomorrow[0].due_date == (date.today() + timedelta(days=1)).isoformat()

    async def test_is_bounty_chore_posts_bounties_instead_of_assignments(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Mow the lawn",
            payout_cents=500,
            recurrence_type="daily",
            is_bounty=True,
        )

        created = await coordinator.async_generate_due_chore_occurrences()
        assert created == []  # no assignments - is_bounty chores never get one
        assert len(coordinator.bounties) == 8  # today + 7 day lookahead, inclusive
        assert all(b.source_chore_definition_id == definition.id for b in coordinator.bounties)
        assert all(b.payout_cents == 500 for b in coordinator.bounties)

        # Idempotent, same as regular chore occurrence generation.
        await coordinator.async_generate_due_chore_occurrences()
        assert len(coordinator.bounties) == 8

    async def test_cancelling_a_wrong_auto_generated_bounty_allows_regeneration(
        self, coordinator
    ):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        await coordinator.async_add_chore_definition(
            title="Mow the lawn", payout_cents=500, recurrence_type="daily", is_bounty=True
        )
        await coordinator.async_generate_due_chore_occurrences()
        assert len(coordinator.bounties) == 8

        wrong = coordinator.bounties[0]
        await coordinator.async_cancel_bounty(wrong.id)

        # The cancelled slot should be free to regenerate a fresh bounty for
        # the same due date, not permanently blocked.
        await coordinator.async_generate_due_chore_occurrences()
        assert len(coordinator.bounties) == 9
        assert wrong.status == BountyStatus.CANCELLED

    async def test_is_bounty_occurrences_are_only_available_on_their_own_due_date(
        self, coordinator
    ):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        await coordinator.async_add_chore_definition(
            title="Mow the lawn", payout_cents=500, recurrence_type="daily", is_bounty=True
        )
        await coordinator.async_generate_due_chore_occurrences()

        by_deadline = sorted(coordinator.bounties, key=lambda b: b.deadline_at)
        today_bounty = by_deadline[0]
        future_bounty = by_deadline[-1]

        def _aware(iso: str) -> datetime:
            dt = datetime.fromisoformat(iso)
            return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)

        now = datetime.now(UTC)
        assert _aware(today_bounty.available_at) <= now
        assert _aware(future_bounty.available_at) > now

    async def test_is_bounty_chore_clears_overdue_but_keeps_availability_window(
        self, coordinator
    ):
        # Overdue handling is meaningless for is_bounty chores (no
        # assignment ever exists to be overdue), so it's cleared. The
        # availability window is different - it still means something,
        # doubling as the auto-posted bounty's available_at/deadline_at
        # time-of-day (see the occurrence-generation test below).
        await _setup_household(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Mow the lawn",
            payout_cents=500,
            is_bounty=True,
            overdue_action="deduct",
            overdue_deduction_cents=100,
            available_from_time="06:00",
            available_until_time="09:00",
        )
        assert definition.overdue_action is None
        assert definition.overdue_deduction_cents is None
        assert definition.overdue_bounty_hours is None
        assert definition.overdue_penalty_pct is None
        assert definition.available_from_time == "06:00"
        assert definition.available_until_time == "09:00"

        # Switching an existing chore to is_bounty clears any overdue
        # config it had from before, but leaves the availability window.
        with_overdue = await coordinator.async_add_chore_definition(
            title="Dishes",
            payout_cents=200,
            overdue_action="deduct",
            overdue_deduction_cents=50,
            available_from_time="06:00",
            available_until_time="09:00",
        )
        assert with_overdue.overdue_action == OverdueAction.DEDUCT
        updated = await coordinator.async_update_chore_definition(with_overdue.id, is_bounty=True)
        assert updated.overdue_action is None
        assert updated.overdue_deduction_cents is None
        assert updated.available_from_time == "06:00"
        assert updated.available_until_time == "09:00"

    async def test_is_bounty_occurrences_use_availability_window_for_timing(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        await coordinator.async_add_chore_definition(
            title="Mow the lawn",
            payout_cents=500,
            recurrence_type="daily",
            is_bounty=True,
            available_from_time="06:00",
            available_until_time="09:00",
        )
        await coordinator.async_generate_due_chore_occurrences()

        assert len(coordinator.bounties) == 8
        for bounty in coordinator.bounties:
            assert bounty.available_at.endswith("06:00:00")
            assert bounty.deadline_at.endswith("09:00:00")

    async def test_is_bounty_chore_skipped_without_a_parent_to_attribute_to(self, coordinator):
        await _setup_household(coordinator)
        await coordinator.async_add_chore_definition(
            title="Mow the lawn", payout_cents=500, recurrence_type="daily", is_bounty=True
        )
        created = await coordinator.async_generate_due_chore_occurrences()
        assert created == []
        assert coordinator.bounties == []

    async def test_one_time_repeatable_bounty_chore_posts_immediately(self, coordinator):
        # recurrence_type=none chores are always skipped by
        # async_generate_due_chore_occurrences (no due date to derive a
        # window from) - a one-time "Read a book" style repeatable bounty
        # chore would otherwise never post anything at all, so chore
        # creation itself posts a single opening bounty.
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Read a book", payout_cents=200, is_bounty=True, is_repeatable=True
        )

        matching = [
            b for b in coordinator.bounties if b.source_chore_definition_id == definition.id
        ]
        assert len(matching) == 1
        assert matching[0].is_repeatable is True
        assert matching[0].status == BountyStatus.OPEN

        # Doesn't duplicate on a later edit while the bounty's still open.
        await coordinator.async_update_chore_definition(definition.id, payout_cents=250)
        matching_after = [
            b for b in coordinator.bounties if b.source_chore_definition_id == definition.id
        ]
        assert len(matching_after) == 1

    async def test_one_time_non_repeatable_bounty_chore_never_posts(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Read a book", payout_cents=200, is_bounty=True
        )
        assert coordinator.bounties == []
        _ = definition

    async def test_switching_chore_off_bounty_clears_is_repeatable(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Read a book", payout_cents=200, is_bounty=True, is_repeatable=True
        )
        assert definition.is_repeatable is True

        updated = await coordinator.async_update_chore_definition(definition.id, is_bounty=False)
        assert updated.is_repeatable is False


# ---------------------------------------------------------------------------
# Bounties
# ---------------------------------------------------------------------------


class TestChoreImageGeneration:
    async def test_add_chore_schedules_image_generation(self, coordinator):
        calls = []

        async def _fake_generate(definition_id, **_kwargs):
            calls.append(definition_id)

        coordinator.async_generate_chore_image = _fake_generate
        await _setup_household(coordinator)
        definition = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)
        await asyncio.sleep(0)
        assert calls == [definition.id]

    async def test_update_skips_generation_when_image_already_set(self, coordinator):
        await _setup_household(coordinator)
        definition = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)
        definition.image_path = "/local/hustle/existing.png"

        calls = []

        async def _fake_generate(definition_id, **_kwargs):
            calls.append(definition_id)

        coordinator.async_generate_chore_image = _fake_generate
        await coordinator.async_update_chore_definition(definition.id, title="Wash dishes")
        await asyncio.sleep(0)
        assert calls == []

    async def test_update_regenerates_when_image_missing(self, coordinator):
        await _setup_household(coordinator)
        definition = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)

        calls = []

        async def _fake_generate(definition_id, **_kwargs):
            calls.append(definition_id)

        coordinator.async_generate_chore_image = _fake_generate
        await coordinator.async_update_chore_definition(definition.id, title="Wash dishes")
        await asyncio.sleep(0)
        assert calls == [definition.id]

    async def test_regenerate_clears_image_path_and_reschedules(self, coordinator):
        await _setup_household(coordinator)
        definition = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)
        definition.image_path = "/local/hustle/existing.png"

        calls = []

        async def _fake_generate(definition_id, **_kwargs):
            calls.append(definition_id)

        coordinator.async_generate_chore_image = _fake_generate
        updated = await coordinator.async_regenerate_chore_image(definition.id)
        assert updated.image_path is None
        await asyncio.sleep(0)
        assert calls == [definition.id]


def _window(available_delta=-1, deadline_delta=7):
    now = datetime.now(UTC)
    return (
        (now + timedelta(hours=available_delta)).isoformat(),
        (now + timedelta(days=deadline_delta)).isoformat(),
    )


class TestBountyLifecycle:
    async def test_default_initiative_bonus_applied(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        available_at, deadline_at = _window()
        bounty = await coordinator.async_add_bounty(
            title="Wash the car",
            payout_cents=1000,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
        )
        assert bounty.initiative_bonus_pct == 30

    async def test_create_bounty_from_chore(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        chore = await coordinator.async_add_chore_definition(
            title="Clean garage", payout_cents=500
        )
        available_at, deadline_at = _window()
        bounty = await coordinator.async_add_bounty_from_chore(
            chore_definition_id=chore.id,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
        )
        assert bounty.title == "Clean garage"
        assert bounty.payout_cents == 500
        assert bounty.source_chore_definition_id == chore.id

    async def test_accept_never_removes_from_board(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator, "ha-child-1", "Charlie")
        other_child = await _add_child(coordinator, "ha-child-2", "Casey")
        available_at, deadline_at = _window()
        bounty = await coordinator.async_add_bounty(
            title="Wash the car",
            payout_cents=1000,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
        )

        bounty = await coordinator.async_accept_bounty(bounty.id, child)
        assert bounty.status == BountyStatus.OPEN
        assert len(bounty.acceptances) == 1

        with pytest.raises(ValueError):
            await coordinator.async_accept_bounty(bounty.id, child)

        bounty = await coordinator.async_accept_bounty(bounty.id, other_child)
        assert bounty.status == BountyStatus.OPEN
        assert len(bounty.acceptances) == 2

    async def test_repeatable_bounty_respawns_on_completion_same_child_again(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        available_at, deadline_at = _window()
        original = await coordinator.async_add_bounty(
            title="Read a book",
            payout_cents=200,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
            requires_approval=False,
            is_repeatable=True,
        )

        accepted = await coordinator.async_accept_bounty(original.id, child)
        await coordinator.async_submit_bounty_acceptance(original.id, child.id, child)

        closed = coordinator._get_bounty(original.id)
        assert closed.status == BountyStatus.CLOSED
        assert closed.acceptances[0].status == AcceptanceStatus.COMPLETED

        fresh = [
            b
            for b in coordinator.bounties
            if b.title == "Read a book" and b.id != original.id and b.status == BountyStatus.OPEN
        ]
        assert len(fresh) == 1
        assert fresh[0].acceptances == []
        assert fresh[0].is_repeatable is True
        assert fresh[0].deadline_at == original.deadline_at

        # The same child can accept the fresh instance - the point of
        # "repeatable" is exactly that they weren't permanently blocked.
        reaccepted = await coordinator.async_accept_bounty(fresh[0].id, child)
        assert len(reaccepted.acceptances) == 1
        assert reaccepted.acceptances[0].member_id == child.id
        _ = accepted

    async def test_repeatable_bounty_does_not_respawn_past_deadline(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        available_at, deadline_at = _window()
        bounty = await coordinator.async_add_bounty(
            title="Read a book",
            payout_cents=200,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
            requires_approval=False,
            is_repeatable=True,
        )
        await coordinator.async_accept_bounty(bounty.id, child)

        # Simulate the deadline passing between acceptance and completion,
        # directly rather than a real sleep.
        bounty.deadline_at = (datetime.now(UTC) - timedelta(hours=1)).isoformat()

        await coordinator.async_submit_bounty_acceptance(bounty.id, child.id, child)

        fresh = [b for b in coordinator.bounties if b.id != bounty.id]
        assert fresh == []

    async def test_non_repeatable_bounty_still_closes_permanently(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        available_at, deadline_at = _window()
        bounty = await coordinator.async_add_bounty(
            title="Wash the car",
            payout_cents=200,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
            requires_approval=False,
        )
        await coordinator.async_accept_bounty(bounty.id, child)
        await coordinator.async_submit_bounty_acceptance(bounty.id, child.id, child)

        assert coordinator._get_bounty(bounty.id).status == BountyStatus.CLOSED
        assert len(coordinator.bounties) == 1

    async def test_accept_outside_availability_window_raises(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        available_at, deadline_at = _window(available_delta=2)
        bounty = await coordinator.async_add_bounty(
            title="Future bounty",
            payout_cents=1000,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
        )
        with pytest.raises(ValueError):
            await coordinator.async_accept_bounty(bounty.id, child)

    async def test_first_come_split_auto_closes_and_pays_first_only(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator, "ha-child-1", "Charlie")
        other_child = await _add_child(coordinator, "ha-child-2", "Casey")
        available_at, deadline_at = _window()
        bounty = await coordinator.async_add_bounty(
            title="Wash the car",
            payout_cents=1000,
            initiative_bonus_pct=0,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
            split_rule="first_come",
        )
        await coordinator.async_accept_bounty(bounty.id, child)
        await coordinator.async_accept_bounty(bounty.id, other_child)

        await coordinator.async_submit_bounty_acceptance(bounty.id, child.id, child)
        bounty = await coordinator.async_complete_bounty_acceptance(bounty.id, child.id, parent)
        assert bounty.status == BountyStatus.CLOSED
        child_acceptance = next(a for a in bounty.acceptances if a.member_id == child.id)
        assert child_acceptance.payout_cents == 1000

        await coordinator.async_submit_bounty_acceptance(bounty.id, other_child.id, other_child)
        bounty = await coordinator.async_complete_bounty_acceptance(
            bounty.id, other_child.id, parent
        )
        other_acceptance = next(a for a in bounty.acceptances if a.member_id == other_child.id)
        assert other_acceptance.payout_cents == 0

    async def test_equal_split_divides_evenly_on_close(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator, "ha-child-1", "Charlie")
        other_child = await _add_child(coordinator, "ha-child-2", "Casey")
        available_at, deadline_at = _window()
        bounty = await coordinator.async_add_bounty(
            title="Wash the car",
            payout_cents=1000,
            initiative_bonus_pct=0,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
            split_rule="equal_split",
        )
        await coordinator.async_accept_bounty(bounty.id, child)
        await coordinator.async_accept_bounty(bounty.id, other_child)

        for member in (child, other_child):
            await coordinator.async_submit_bounty_acceptance(bounty.id, member.id, member)
            await coordinator.async_complete_bounty_acceptance(bounty.id, member.id, parent)

        bounty = await coordinator.async_close_bounty(bounty.id)
        payouts = {a.member_id: a.payout_cents for a in bounty.acceptances}
        assert payouts[child.id] == 500
        assert payouts[other_child.id] == 500

    async def test_parent_decides_split_requires_finalize_before_close(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        available_at, deadline_at = _window()
        bounty = await coordinator.async_add_bounty(
            title="Wash the car",
            payout_cents=1000,
            initiative_bonus_pct=0,
            available_at=available_at,
            deadline_at=deadline_at,
            creator=parent,
            split_rule="parent_decides",
        )
        await coordinator.async_accept_bounty(bounty.id, child)
        await coordinator.async_submit_bounty_acceptance(bounty.id, child.id, child)
        await coordinator.async_complete_bounty_acceptance(bounty.id, child.id, parent)

        with pytest.raises(ValueError):
            await coordinator.async_close_bounty(bounty.id)

        bounty = await coordinator.async_finalize_bounty_split(bounty.id, {child.id: 900})
        assert bounty.acceptances[0].payout_cents == 900

        bounty = await coordinator.async_close_bounty(bounty.id)
        assert bounty.status == BountyStatus.CLOSED

    async def test_expire_stale_bounties(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        now = datetime.now(UTC)
        bounty = await coordinator.async_add_bounty(
            title="Old bounty", payout_cents=100,
            available_at=(now - timedelta(days=5)).isoformat(),
            deadline_at=(now - timedelta(days=1)).isoformat(),
            creator=parent,
        )
        expired = await coordinator.async_expire_stale_bounties()
        assert bounty.id in {b.id for b in expired}
        assert coordinator._get_bounty(bounty.id).status == BountyStatus.EXPIRED

    async def test_expire_stale_bounties_refreshes_listeners_even_with_nothing_stale(
        self, coordinator
    ):
        # Closed (claimed) bounties stay on the board until their deadline
        # passes without any bounty field changing - the scheduler tick
        # still needs to nudge listeners so sensor.py re-evaluates board
        # visibility purely off wall-clock time.
        await _setup_household(coordinator)
        coordinator.data = None
        expired = await coordinator.async_expire_stale_bounties()
        assert expired == []
        assert coordinator.data is not None


# ---------------------------------------------------------------------------
# Grades
# ---------------------------------------------------------------------------


DEFAULT_SCALE = [
    {"letter": "A", "value_cents": 500, "sort_order": 0},
    {"letter": "B", "value_cents": 300, "sort_order": 1},
    {"letter": "C", "value_cents": 100, "sort_order": 2},
    {"letter": "D", "value_cents": 0, "sort_order": 3},
    {"letter": "F", "value_cents": 0, "sort_order": 4},
]


class TestGrades:
    async def test_update_grade_scale_upserts_and_removes(self, coordinator):
        await _setup_household(coordinator)
        await coordinator.async_update_grade_scale(DEFAULT_SCALE)
        letters = {g.letter for g in coordinator.grade_scale}
        assert letters == {"A", "B", "C", "D", "F"}

        trimmed = [e for e in DEFAULT_SCALE if e["letter"] != "F"]
        trimmed[0] = {"letter": "A", "value_cents": 600, "sort_order": 0}
        await coordinator.async_update_grade_scale(trimmed)

        scale = {g.letter: g.value_cents for g in coordinator.grade_scale}
        assert scale == {"A": 600, "B": 300, "C": 100, "D": 0}
        assert "F" not in scale

    async def test_record_grade_snapshots_value_and_rejects_unknown_letter(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        await coordinator.async_update_grade_scale(DEFAULT_SCALE)
        subject = await coordinator.async_add_subject("Math")

        entry = await coordinator.async_record_grade(subject.id, child.id, "A", "Q1 2026", parent)
        assert entry.grade_value_cents == 500

        with pytest.raises(ValueError):
            await coordinator.async_record_grade(subject.id, child.id, "Z", "Q1 2026", parent)

    async def test_scale_change_does_not_rewrite_historical_grade(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        await coordinator.async_update_grade_scale(DEFAULT_SCALE)
        subject = await coordinator.async_add_subject("Math")

        entry = await coordinator.async_record_grade(subject.id, child.id, "A", "Q1", parent)
        assert entry.grade_value_cents == 500

        updated_scale = [
            {**e, "value_cents": 999} if e["letter"] == "A" else e for e in DEFAULT_SCALE
        ]
        await coordinator.async_update_grade_scale(updated_scale)

        unchanged = coordinator._get_grade_entry(entry.id)
        assert unchanged.grade_value_cents == 500


# ---------------------------------------------------------------------------
# Behavior
# ---------------------------------------------------------------------------


class TestBehavior:
    async def test_bonus_type_stores_positive_default(self, coordinator):
        await _setup_household(coordinator)
        behavior_type = await coordinator.async_add_behavior_type("Good attitude", "bonus", 150)
        assert behavior_type.default_amount_cents == 150

    async def test_deduction_type_stores_negative_default(self, coordinator):
        await _setup_household(coordinator)
        behavior_type = await coordinator.async_add_behavior_type("Left toys out", "deduction", 200)
        assert behavior_type.default_amount_cents == -200

    async def test_entry_inherits_signed_default(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        behavior_type = await coordinator.async_add_behavior_type("Broke curfew", "deduction", 300)
        entry = await coordinator.async_record_behavior_entry(behavior_type.id, child.id, parent)
        assert entry.amount_cents == -300

    async def test_entry_override_amount_respects_sign(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        behavior_type = await coordinator.async_add_behavior_type("Extra chores", "bonus", 100)
        entry = await coordinator.async_record_behavior_entry(
            behavior_type.id, child.id, parent, amount_cents=250
        )
        assert entry.amount_cents == 250


# ---------------------------------------------------------------------------
# Payroll
# ---------------------------------------------------------------------------


class TestPayroll:
    async def _setup_full_earnings(self, coordinator, parent, child):
        chore = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(chore.id, [child.id], due))[0]
        await coordinator.async_submit_chore(assignment.id, child)
        await coordinator.async_approve_chore(assignment.id, parent)

        now = datetime.now(UTC)
        bounty = await coordinator.async_add_bounty(
            title="Wash car", payout_cents=1000, initiative_bonus_pct=0,
            available_at=(now - timedelta(hours=1)).isoformat(),
            deadline_at=(now + timedelta(days=1)).isoformat(),
            creator=parent,
        )
        await coordinator.async_accept_bounty(bounty.id, child)
        await coordinator.async_submit_bounty_acceptance(bounty.id, child.id, child)
        await coordinator.async_complete_bounty_acceptance(bounty.id, child.id, parent)

        await coordinator.async_update_grade_scale(
            [{"letter": "A", "value_cents": 500, "sort_order": 0}]
        )
        subject = await coordinator.async_add_subject("Math")
        await coordinator.async_record_grade(subject.id, child.id, "A", "Q1", parent)

        bonus_type = await coordinator.async_add_behavior_type("Great attitude", "bonus", 100)
        deduction_type = await coordinator.async_add_behavior_type(
            "Missed curfew", "deduction", 150
        )
        await coordinator.async_record_behavior_entry(bonus_type.id, child.id, parent)
        await coordinator.async_record_behavior_entry(deduction_type.id, child.id, parent)

        # chore 200 + bounty 1000 + grade 500 + behavior bonus 100 - deduction 150
        # gross (positives only) = 1800, net = 1650
        return {"gross_cents": 1800, "net_cents": 1650}

    async def test_generate_payroll_sums_all_earning_sources(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        expected = await self._setup_full_earnings(coordinator, parent, child)

        period = await coordinator.async_get_or_create_current_period()
        paychecks = await coordinator.async_generate_pay_period(period.id)
        assert len(paychecks) == 1
        paycheck = paychecks[0]
        assert paycheck.member_id == child.id
        assert paycheck.gross_cents == expected["gross_cents"]
        assert paycheck.net_cents == expected["net_cents"]
        assert paycheck.status == PaycheckStatus.PENDING_APPROVAL

        source_types = {li.earning_source_type for li in paycheck.line_items}
        assert source_types == {"chore", "bounty", "grade", "behavior"}

    async def test_double_generate_without_regenerate_raises(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        await _add_child(coordinator)
        period = await coordinator.async_get_or_create_current_period()
        await coordinator.async_generate_pay_period(period.id)

        with pytest.raises(ValueError):
            await coordinator.async_generate_pay_period(period.id)

    async def test_regenerate_replaces_paychecks(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        await _add_child(coordinator)
        period = await coordinator.async_get_or_create_current_period()
        first = await coordinator.async_generate_pay_period(period.id)

        second = await coordinator.async_generate_pay_period(period.id, regenerate=True)
        assert len(second) == len(first)
        assert second[0].id != first[0].id

    async def test_approve_and_mark_paid_flow(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        await _add_child(coordinator)
        period = await coordinator.async_get_or_create_current_period()
        paychecks = await coordinator.async_generate_pay_period(period.id)
        paycheck_id = paychecks[0].id

        with pytest.raises(ValueError):
            await coordinator.async_mark_paycheck_paid(paycheck_id)

        approved = await coordinator.async_approve_paycheck(paycheck_id, parent)
        assert approved.status == PaycheckStatus.APPROVED

        paid = await coordinator.async_mark_paycheck_paid(paycheck_id)
        assert paid.status == PaycheckStatus.PAID

    async def test_auto_approve_when_household_does_not_require_approval(self, coordinator):
        await _setup_household(coordinator, requires_parent_approval=False)
        await _add_parent(coordinator)
        await _add_child(coordinator)
        period = await coordinator.async_get_or_create_current_period()
        paychecks = await coordinator.async_generate_pay_period(period.id)
        assert paychecks[0].status == PaycheckStatus.APPROVED

    async def test_pay_parents_too_includes_parent_in_eligible_members(self, coordinator):
        await _setup_household(coordinator, pay_parents_too=True)
        parent = await _add_parent(coordinator)
        await _add_child(coordinator)
        period = await coordinator.async_get_or_create_current_period()
        paychecks = await coordinator.async_generate_pay_period(period.id)
        member_ids = {p.member_id for p in paychecks}
        assert parent.id in member_ids


# ---------------------------------------------------------------------------
# Auth / identity resolution
# ---------------------------------------------------------------------------


class TestMemberForContext:
    async def test_resolves_linked_member(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        context = type("Context", (), {"user_id": parent.ha_user_id})()
        resolved = coordinator._member_for_context(context)
        assert resolved.id == parent.id

    async def test_unlinked_user_resolves_to_none(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        context = type("Context", (), {"user_id": "someone-not-in-household"})()
        assert coordinator._member_for_context(context) is None

    async def test_missing_context_resolves_to_none(self, coordinator):
        await _setup_household(coordinator)
        context = type("Context", (), {"user_id": None})()
        assert coordinator._member_for_context(context) is None

    async def test_inactive_member_does_not_resolve(self, coordinator):
        await _setup_household(coordinator)
        _parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        await coordinator.async_deactivate_member(child.id)
        context = type("Context", (), {"user_id": child.ha_user_id})()
        assert coordinator._member_for_context(context) is None


# ---------------------------------------------------------------------------
# Permission defaults + managed-children storage (new per the privacy-scoping
# feature batch)
# ---------------------------------------------------------------------------


class TestPermissionDefaults:
    async def test_every_new_parent_is_admin(self, coordinator):
        await _setup_household(coordinator)
        first = await _add_parent(coordinator, "ha-parent-1", "Pat")
        second = await _add_parent(coordinator, "ha-parent-2", "Sam")
        third = await _add_parent(coordinator, "ha-parent-3", "Jo")
        assert first.permission_level == PermissionLevel.ADMIN
        assert second.permission_level == PermissionLevel.ADMIN
        assert third.permission_level == PermissionLevel.ADMIN


class TestManagedChildrenStorage:
    async def test_add_member_stores_managed_child_ids_and_notify_target(self, coordinator):
        await _setup_household(coordinator)
        child = await _add_child(coordinator)
        parent = await coordinator.async_add_member(
            ha_user_id="ha-parent-1",
            ha_display_name="Pat",
            role="parent",
            managed_child_ids=[child.id],
            notify_target="notify.mobile_app_pat",
        )
        assert parent.managed_child_ids == [child.id]
        assert parent.notify_target == "notify.mobile_app_pat"

    async def test_add_member_defaults_managed_child_ids_to_empty(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        assert parent.managed_child_ids == []
        assert parent.notify_target is None

    async def test_update_member_sets_managed_child_ids_and_notify_target(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        updated = await coordinator.async_update_member(
            parent.id, managed_child_ids=[child.id], notify_target="notify.mobile_app_pat"
        )
        assert updated.managed_child_ids == [child.id]
        assert updated.notify_target == "notify.mobile_app_pat"


# ---------------------------------------------------------------------------
# Bounty-from-assignment conversion (new per the overdue-handling batch)
# ---------------------------------------------------------------------------


class TestConvertAssignmentToBounty:
    async def test_removes_assignment_and_creates_bounty(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Clean garage", payout_cents=500, overdue_penalty_pct=-50
        )
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]

        available_at, deadline_at = _window()
        bounty = await coordinator.async_convert_assignment_to_bounty(
            assignment.id, available_at=available_at, deadline_at=deadline_at, creator=parent
        )

        assert bounty.title == "Clean garage"
        assert bounty.payout_cents == 500
        assert bounty.created_by_member_id == parent.id
        assert bounty.original_assignee_member_id == child.id
        assert bounty.overdue_penalty_pct == -50
        assert all(a.id != assignment.id for a in coordinator.chore_assignments)

    async def test_fires_converted_to_bounty_event(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Clean garage", payout_cents=500
        )
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]

        available_at, deadline_at = _window()
        bounty = await coordinator.async_convert_assignment_to_bounty(
            assignment.id, available_at=available_at, deadline_at=deadline_at, creator=parent
        )

        fired = [
            e for e in coordinator.hass.bus.fired if e[0] == "hustle_chore_converted_to_bounty"
        ]
        assert len(fired) == 1
        _event_type, payload = fired[0]
        assert payload["member_id"] == child.id
        assert payload["chore_title"] == "Clean garage"
        assert payload["bounty_id"] == bounty.id

    async def test_notification_failure_does_not_raise(self, coordinator):
        # _notify_member must be best-effort: a broken notify_target should
        # never break the conversion itself.
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await coordinator.async_add_member(
            ha_user_id="ha-child-1",
            ha_display_name="Charlie",
            role="child",
            notify_target="not-a-valid-target",
        )
        definition = await coordinator.async_add_chore_definition(
            title="Clean garage", payout_cents=500
        )
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]

        available_at, deadline_at = _window()
        # Should not raise even though notify_target has no "." separator.
        bounty = await coordinator.async_convert_assignment_to_bounty(
            assignment.id, available_at=available_at, deadline_at=deadline_at, creator=parent
        )
        assert bounty.original_assignee_member_id == child.id


# ---------------------------------------------------------------------------
# Overdue chore processing (new per the overdue-handling batch)
# ---------------------------------------------------------------------------


class TestProcessOverdueChores:
    async def _overdue_assignment(self, coordinator, child, **definition_overrides):
        definition = await coordinator.async_add_chore_definition(
            title="Take out trash", payout_cents=200, **definition_overrides
        )
        yesterday = (date.today() - timedelta(days=2)).isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], yesterday))[
            0
        ]
        return definition, assignment

    async def test_remove_action_deletes_overdue_assignment(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        _definition, assignment = await self._overdue_assignment(
            coordinator, child, overdue_action="remove"
        )

        await coordinator.async_process_overdue_chores()

        assert all(a.id != assignment.id for a in coordinator.chore_assignments)

    async def test_convert_to_bounty_action_creates_bounty(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        _definition, assignment = await self._overdue_assignment(
            coordinator,
            child,
            overdue_action="convert_to_bounty",
            overdue_bounty_hours=5,
            overdue_penalty_pct=-50,
        )

        await coordinator.async_process_overdue_chores()

        assert all(a.id != assignment.id for a in coordinator.chore_assignments)
        matching = [
            b for b in coordinator.bounties if b.original_assignee_member_id == child.id
        ]
        assert len(matching) == 1
        assert matching[0].overdue_penalty_pct == -50

    async def test_deduct_action_records_behavior_entry_and_removes_assignment(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        _definition, assignment = await self._overdue_assignment(
            coordinator, child, overdue_action="deduct", overdue_deduction_cents=100
        )

        await coordinator.async_process_overdue_chores()

        assert all(a.id != assignment.id for a in coordinator.chore_assignments)
        matching = [e for e in coordinator.behavior_entries if e.member_id == child.id]
        assert len(matching) == 1
        assert matching[0].amount_cents == -100

    async def test_no_overdue_action_leaves_assignment_untouched(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        _definition, assignment = await self._overdue_assignment(coordinator, child)

        await coordinator.async_process_overdue_chores()

        assert any(a.id == assignment.id for a in coordinator.chore_assignments)

    async def test_not_yet_overdue_assignment_is_untouched(self, coordinator):
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Take out trash", payout_cents=200, overdue_action="remove"
        )
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], tomorrow))[0]

        await coordinator.async_process_overdue_chores()

        assert any(a.id == assignment.id for a in coordinator.chore_assignments)

    async def test_submitted_assignment_is_not_processed(self, coordinator):
        # SUBMITTED assignments are mid-review, not neglected - only ASSIGNED
        # ones are eligible for overdue processing.
        await _setup_household(coordinator)
        await _add_parent(coordinator)
        child = await _add_child(coordinator)
        _definition, assignment = await self._overdue_assignment(
            coordinator, child, overdue_action="remove"
        )
        await coordinator.async_submit_chore(assignment.id, child)

        await coordinator.async_process_overdue_chores()


class TestUnassignAllChores:
    async def test_removes_unapproved_leaves_approved(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(title="Dishes", payout_cents=200)
        due = date.today().isoformat()

        assigned = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]
        submitted_def = await coordinator.async_add_chore_definition(
            title="Trash", payout_cents=100
        )
        submitted = (await coordinator.async_assign_chore(submitted_def.id, [child.id], due))[0]
        await coordinator.async_submit_chore(submitted.id, child)
        approved_def = await coordinator.async_add_chore_definition(
            title="Laundry", payout_cents=150, requires_approval=False
        )
        approved = (await coordinator.async_assign_chore(approved_def.id, [child.id], due))[0]
        await coordinator.async_submit_chore(approved.id, child)

        removed = await coordinator.async_unassign_all_chores()

        assert removed == 2
        remaining_ids = {a.id for a in coordinator.chore_assignments}
        assert assigned.id not in remaining_ids
        assert submitted.id not in remaining_ids
        assert approved.id in remaining_ids
        _ = parent


class TestRemoveAllBounties:
    async def test_cancels_open_leaves_closed(self, coordinator):
        await _setup_household(coordinator)
        parent = await _add_parent(coordinator)
        now = datetime.now(UTC)
        open_bounty = await coordinator.async_add_bounty(
            title="Wash car",
            payout_cents=300,
            available_at=(now - timedelta(hours=1)).isoformat(),
            deadline_at=(now + timedelta(days=1)).isoformat(),
            creator=parent,
        )
        closed_bounty = await coordinator.async_add_bounty(
            title="Rake leaves",
            payout_cents=300,
            available_at=(now - timedelta(hours=1)).isoformat(),
            deadline_at=(now + timedelta(days=1)).isoformat(),
            creator=parent,
        )
        await coordinator.async_close_bounty(closed_bounty.id)

        removed = await coordinator.async_remove_all_bounties()

        assert removed == 1
        assert coordinator._get_bounty(open_bounty.id).status == BountyStatus.CANCELLED
        assert coordinator._get_bounty(closed_bounty.id).status == BountyStatus.CLOSED


class TestResetCurrentPeriodPaychecks:
    async def test_zeroes_child_paychecks_leaves_parent(self, coordinator):
        await _setup_household(coordinator, pay_parents_too=True)
        parent = await _add_parent(coordinator)
        child = await _add_child(coordinator)
        definition = await coordinator.async_add_chore_definition(
            title="Dishes", payout_cents=500, requires_approval=False
        )
        due = date.today().isoformat()
        assignment = (await coordinator.async_assign_chore(definition.id, [child.id], due))[0]
        await coordinator.async_submit_chore(assignment.id, child)

        period = await coordinator.async_get_or_create_current_period()
        await coordinator.async_generate_pay_period(period.id)
        child_paycheck = next(
            p
            for p in coordinator.paychecks
            if p.member_id == child.id and p.pay_period_id == period.id
        )
        assert child_paycheck.net_cents == 500

        reset_count = await coordinator.async_reset_current_period_paychecks()

        assert reset_count == 1
        reset_paycheck = next(p for p in coordinator.paychecks if p.id == child_paycheck.id)
        assert reset_paycheck.net_cents == 0
        assert reset_paycheck.gross_cents == 0
        assert reset_paycheck.line_items == []
        assert reset_paycheck.status == PaycheckStatus.DRAFT
        _ = parent

        assert any(a.id == assignment.id for a in coordinator.chore_assignments)


async def test_payday_countdown_uses_home_assistant_date(coordinator, monkeypatch):
    """The countdown must use the same local date as period selection."""
    monkeypatch.setattr(
        "hustle_addon.coordinator._today", lambda: date(2026, 1, 1)
    )
    await _setup_household(coordinator)
    period = await coordinator.async_get_or_create_current_period()
    expected = (date.fromisoformat(period.payday_date) - date(2026, 1, 1)).days
    assert coordinator._build_public_data()["days_until_payday"] == expected

async def test_reset_all_earnings_preserves_setup_and_survives_reload(coordinator):
    await _setup_household(coordinator, pay_parents_too=True)
    parent = await _add_parent(coordinator)
    child = await _add_child(coordinator)
    await TestPayroll()._setup_full_earnings(coordinator, parent, child)
    await TestPayroll()._setup_full_earnings(coordinator, parent, parent)
    pending_definition = await coordinator.async_add_chore_definition(
        title="Still to do", payout_cents=325
    )
    pending = (await coordinator.async_assign_chore(
        pending_definition.id, [child.id], date.today().isoformat()
    ))[0]
    period = await coordinator.async_get_or_create_current_period()
    paychecks = await coordinator.async_generate_pay_period(period.id)
    assert all(p.net_cents > 0 for p in paychecks)
    for paycheck in paychecks:
        await coordinator.async_approve_paycheck(paycheck.id, parent)
        await coordinator.async_mark_paycheck_paid(paycheck.id)
    profiles = [m.to_dict() for m in coordinator.members]
    definitions = [d.to_dict() for d in coordinator.chore_definitions]
    config = coordinator.payroll_config.to_dict()

    await coordinator.async_reset_account_earnings()
    assert coordinator.paychecks == []
    assert coordinator.pay_periods == []
    assert coordinator.store._data["paychecks"] == []
    assert coordinator.store._data["earnings_reset_at"]
    assert [m.to_dict() for m in coordinator.members] == profiles
    assert [d.to_dict() for d in coordinator.chore_definitions] == definitions
    assert coordinator.payroll_config.to_dict() == config
    assert pending.payout_cents == 325
    assert pending.status == ChoreAssignmentStatus.ASSIGNED

    await coordinator.async_load()
    period = await coordinator.async_get_or_create_current_period()
    # Restoring an old source amount must not resurrect pre-reset earnings.
    coordinator.grade_entries[0].grade_value_cents = 9999
    regenerated = await coordinator.async_generate_pay_period(period.id)
    assert all(p.net_cents == 0 and not p.line_items for p in regenerated)
    child = next(m for m in coordinator.members if m.id == child.id)
    # Windows' clock ticks coarsely enough that an approval right after the
    # reset can share its timestamp - and earnings must come strictly after.
    await asyncio.sleep(0.05)
    await coordinator.async_submit_chore(pending.id, child)
    await coordinator.async_approve_chore(pending.id, parent)
    regenerated = await coordinator.async_generate_pay_period(period.id, regenerate=True)
    assert next(p for p in regenerated if p.member_id == child.id).net_cents == 325
    await coordinator.async_reset_account_earnings()
    assert coordinator.paychecks == []


async def test_reset_service_requires_confirmed_parent_admin(coordinator):
    from hustle_addon.services import HomeAssistantError, build_handlers

    await _setup_household(coordinator)
    admin = await _add_parent(coordinator)
    standard = await coordinator.async_add_member(
        ha_user_id="standard", ha_display_name="Standard", role="parent",
        permission_level="standard",
    )
    child = await _add_child(coordinator)
    reset = build_handlers(coordinator)["reset_account_earnings"]
    for user in [standard.ha_user_id, child.ha_user_id, "unlinked"]:
        with pytest.raises(HomeAssistantError):
            await reset(FakeCall(user, confirm=True))
    with pytest.raises(HomeAssistantError):
        await reset(FakeCall(admin.ha_user_id, confirm=False))
    assert coordinator.earnings_reset_at is None
    await reset(FakeCall(admin.ha_user_id, confirm=True))
    assert coordinator.earnings_reset_at is not None
