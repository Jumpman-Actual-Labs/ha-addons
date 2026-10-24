from __future__ import annotations

from datetime import date, datetime

import pytest

from hustle_addon.const import (
    AcceptanceStatus,
    BehaviorCategory,
    ChoreAssignmentStatus,
    MemberRole,
    PermissionLevel,
    RecurrenceType,
    SplitRule,
)
from hustle_addon.logic import (
    active_chores_count,
    aggregate_paycheck,
    check_prerequisites,
    collect_behavior_earnings,
    collect_bounty_earnings,
    collect_chore_earnings,
    collect_grade_earnings,
    compute_period,
    due_dates_for,
    earnings_by_child,
    earnings_by_pay_period,
    effective_due_datetime,
    highest_paying_chores,
    is_overdue,
    most_completed_chores,
    next_permission_level,
    next_rotation_assignee,
    pending_bounty_approvals_count,
    pending_chore_approvals_count,
    period_datetime_bounds,
    reliability,
    requires_paycheck_approval,
    resolve_overdue_bounty_payout,
    resolve_payout,
    total_payout_cents,
)
from hustle_addon.models import (
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


def make_member(member_id: str, name: str, role: MemberRole = MemberRole.CHILD) -> Member:
    return Member(id=member_id, ha_user_id=f"ha-{member_id}", ha_display_name=name, role=role)


def make_period(start: str, end: str, payday: str, period_id: str = "period-1") -> PayPeriod:
    return PayPeriod(
        id=period_id, household_id="hh-1", start_date=start, end_date=end, payday_date=payday
    )


def make_definition(**overrides) -> ChoreDefinition:
    defaults = dict(id="def-1", household_id="hh-1", title="Dishes", payout_cents=200)
    defaults.update(overrides)
    return ChoreDefinition(**defaults)


def make_bounty(**overrides) -> Bounty:
    defaults = dict(
        id="bounty-1",
        household_id="hh-1",
        title="Wash car",
        payout_cents=1000,
        available_at="2026-07-01T00:00:00",
        deadline_at="2026-07-10T00:00:00",
        created_by_member_id="parent-1",
    )
    defaults.update(overrides)
    return Bounty(**defaults)


# ---------------------------------------------------------------------------
# Pay period boundary math (ported 1:1 from test_payroll.py)
# ---------------------------------------------------------------------------


class TestComputePeriod:
    def test_weekly_period_computation(self):
        rule = PaydayRule(type="weekly", day_of_week="FRI")
        # Wednesday 2026-07-01 -> the upcoming Friday is 2026-07-03.
        as_of = date(2026, 7, 1)
        start, end, payday = compute_period(rule, "weekly", as_of)
        assert payday == date(2026, 7, 3)
        assert start == date(2026, 6, 27)
        assert end == date(2026, 7, 3)

    def test_monthly_period_computation(self):
        rule = PaydayRule(type="monthly", day_of_month=15)
        as_of = date(2026, 2, 3)
        start, end, payday = compute_period(rule, "monthly", as_of)
        assert start == date(2026, 2, 1)
        assert end == date(2026, 2, 28)
        assert payday == date(2026, 2, 15)

    def test_biweekly_period_computation(self):
        rule = PaydayRule(type="biweekly", day_of_week="FRI", anchor_date="2026-07-03")
        as_of = date(2026, 7, 3)
        start, end, payday = compute_period(rule, "biweekly", as_of)
        assert payday == date(2026, 7, 3)
        assert start == date(2026, 6, 20)
        assert end == date(2026, 7, 3)

    def test_biweekly_next_cycle(self):
        rule = PaydayRule(type="biweekly", day_of_week="FRI", anchor_date="2026-07-03")
        as_of = date(2026, 7, 10)
        start, end, payday = compute_period(rule, "biweekly", as_of)
        assert payday == date(2026, 7, 17)

    def test_unsupported_recurrence_raises(self):
        rule = PaydayRule(type="weekly")
        with pytest.raises(ValueError):
            compute_period(rule, "daily", date(2026, 7, 1))


class TestPeriodDatetimeBounds:
    def test_inclusive_range(self):
        period = make_period("2026-07-01", "2026-07-07", "2026-07-07")
        start, end = period_datetime_bounds(period)
        assert start.date() == date(2026, 7, 1)
        assert end.date() == date(2026, 7, 7)
        assert end.hour == 23


# ---------------------------------------------------------------------------
# Bounty split resolution (ported 1:1 from bounty_split_service behavior)
# ---------------------------------------------------------------------------


class TestTotalPayoutCents:
    def test_default_bonus(self):
        bounty = make_bounty(payout_cents=1000, initiative_bonus_pct=30)
        assert total_payout_cents(bounty) == 1300

    def test_zero_bonus(self):
        bounty = make_bounty(payout_cents=1000, initiative_bonus_pct=0)
        assert total_payout_cents(bounty) == 1000


class TestResolvePayout:
    def test_first_come_pays_first_only(self):
        bounty = make_bounty(
            payout_cents=1000, initiative_bonus_pct=0, split_rule=SplitRule.FIRST_COME
        )
        first = BountyAcceptance(
            member_id="child-1",
            status=AcceptanceStatus.COMPLETED,
            completed_at="2026-07-01T10:00:00",
        )
        second = BountyAcceptance(
            member_id="child-2",
            status=AcceptanceStatus.COMPLETED,
            completed_at="2026-07-01T11:00:00",
        )
        payouts = resolve_payout(bounty, [first, second])
        assert payouts == {"child-1": 1000, "child-2": 0}

    def test_equal_split_divides_evenly(self):
        bounty = make_bounty(
            payout_cents=1000, initiative_bonus_pct=0, split_rule=SplitRule.EQUAL_SPLIT
        )
        a = BountyAcceptance(member_id="child-1", status=AcceptanceStatus.COMPLETED)
        b = BountyAcceptance(member_id="child-2", status=AcceptanceStatus.COMPLETED)
        payouts = resolve_payout(bounty, [a, b])
        assert payouts == {"child-1": 500, "child-2": 500}

    def test_equal_split_remainder_goes_to_first_sorted_member(self):
        bounty = make_bounty(
            payout_cents=1001, initiative_bonus_pct=0, split_rule=SplitRule.EQUAL_SPLIT
        )
        a = BountyAcceptance(member_id="child-1", status=AcceptanceStatus.COMPLETED)
        b = BountyAcceptance(member_id="child-2", status=AcceptanceStatus.COMPLETED)
        payouts = resolve_payout(bounty, [a, b])
        assert sum(payouts.values()) == 1001
        assert payouts["child-1"] == 501  # sorted by member_id, remainder to first

    def test_parent_decides_returns_empty(self):
        bounty = make_bounty(split_rule=SplitRule.PARENT_DECIDES)
        a = BountyAcceptance(member_id="child-1", status=AcceptanceStatus.COMPLETED)
        assert resolve_payout(bounty, [a]) == {}

    def test_no_completions_returns_empty(self):
        bounty = make_bounty(split_rule=SplitRule.FIRST_COME)
        assert resolve_payout(bounty, []) == {}


# ---------------------------------------------------------------------------
# Recurrence date math (ported 1:1 from recurrence_service._due_dates_for)
# ---------------------------------------------------------------------------


class TestDueDatesFor:
    def test_daily_recurrence_generates_every_day(self):
        definition = make_definition(recurrence_type=RecurrenceType.DAILY)
        dates = due_dates_for(definition, date(2026, 7, 1), date(2026, 7, 8))
        assert len(dates) == 8  # today + 7 day lookahead, inclusive

    def test_weekly_recurrence_matches_configured_days(self):
        definition = make_definition(
            recurrence_type=RecurrenceType.WEEKLY,
            recurrence_config={"days_of_week": ["MON", "WED", "FRI"]},
        )
        # 2026-07-01 is a Wednesday.
        dates = due_dates_for(definition, date(2026, 7, 1), date(2026, 7, 7))
        weekdays = {d.strftime("%a").upper()[:3] for d in dates}
        assert weekdays <= {"MON", "WED", "FRI"}
        assert len(dates) == 3  # Wed 7/1, Fri 7/3, Mon 7/6

    def test_custom_cron_interval(self):
        definition = make_definition(
            recurrence_type=RecurrenceType.CUSTOM_CRON,
            recurrence_config={"interval_days": 3, "anchor_date": "2026-07-01"},
        )
        dates = due_dates_for(definition, date(2026, 7, 1), date(2026, 7, 10))
        assert dates == [date(2026, 7, 1), date(2026, 7, 4), date(2026, 7, 7), date(2026, 7, 10)]

    def test_none_recurrence_generates_nothing(self):
        definition = make_definition(recurrence_type=RecurrenceType.NONE)
        assert due_dates_for(definition, date(2026, 7, 1), date(2026, 7, 8)) == []

    def test_custom_cron_missing_config_generates_nothing(self):
        definition = make_definition(
            recurrence_type=RecurrenceType.CUSTOM_CRON, recurrence_config={}
        )
        assert due_dates_for(definition, date(2026, 7, 1), date(2026, 7, 8)) == []

    def test_biweekly_fires_every_14_days_from_anchor(self):
        definition = make_definition(
            recurrence_type=RecurrenceType.BIWEEKLY,
            recurrence_config={"anchor_date": "2026-07-01"},
        )
        dates = due_dates_for(definition, date(2026, 7, 1), date(2026, 7, 30))
        assert dates == [date(2026, 7, 1), date(2026, 7, 15), date(2026, 7, 29)]

    def test_biweekly_missing_anchor_generates_nothing(self):
        definition = make_definition(recurrence_type=RecurrenceType.BIWEEKLY, recurrence_config={})
        assert due_dates_for(definition, date(2026, 7, 1), date(2026, 7, 30)) == []

    def test_monthly_fires_on_day_of_month(self):
        definition = make_definition(
            recurrence_type=RecurrenceType.MONTHLY, recurrence_config={"day_of_month": 15}
        )
        dates = due_dates_for(definition, date(2026, 7, 1), date(2026, 8, 31))
        assert dates == [date(2026, 7, 15), date(2026, 8, 15)]

    def test_monthly_clamps_to_last_day_of_short_month(self):
        # day_of_month=31 in February (28 days in 2026, non-leap) clamps to
        # the 28th - mirrors PayrollConfig's monthly period clamping.
        definition = make_definition(
            recurrence_type=RecurrenceType.MONTHLY, recurrence_config={"day_of_month": 31}
        )
        dates = due_dates_for(definition, date(2026, 2, 1), date(2026, 2, 28))
        assert dates == [date(2026, 2, 28)]

    def test_monthly_missing_config_generates_nothing(self):
        definition = make_definition(recurrence_type=RecurrenceType.MONTHLY, recurrence_config={})
        assert due_dates_for(definition, date(2026, 7, 1), date(2026, 7, 31)) == []

    def test_quarterly_fires_every_3_months_on_anchor_day(self):
        definition = make_definition(
            recurrence_type=RecurrenceType.QUARTERLY,
            recurrence_config={"anchor_date": "2026-01-15"},
        )
        dates = due_dates_for(definition, date(2026, 1, 1), date(2026, 7, 31))
        assert dates == [date(2026, 1, 15), date(2026, 4, 15), date(2026, 7, 15)]

    def test_quarterly_clamps_to_last_day_of_short_month(self):
        # Anchored on the 31st: April/July only have 30/31 days respectively,
        # so a Jan 31 anchor clamps to Apr 30, then back to 31 in July.
        definition = make_definition(
            recurrence_type=RecurrenceType.QUARTERLY,
            recurrence_config={"anchor_date": "2026-01-31"},
        )
        dates = due_dates_for(definition, date(2026, 1, 1), date(2026, 7, 31))
        assert dates == [date(2026, 1, 31), date(2026, 4, 30), date(2026, 7, 31)]

    def test_quarterly_missing_anchor_generates_nothing(self):
        definition = make_definition(
            recurrence_type=RecurrenceType.QUARTERLY, recurrence_config={}
        )
        assert due_dates_for(definition, date(2026, 1, 1), date(2026, 7, 31)) == []


# ---------------------------------------------------------------------------
# Overdue chore handling (new per the overdue-handling feature batch)
# ---------------------------------------------------------------------------


class TestEffectiveDueDatetime:
    def test_defaults_to_end_of_day_when_no_time_set(self):
        result = effective_due_datetime("2026-07-01", None)
        assert result == datetime(2026, 7, 1, 23, 59)

    def test_combines_date_and_time(self):
        result = effective_due_datetime("2026-07-01", "08:30")
        assert result == datetime(2026, 7, 1, 8, 30)


class TestIsOverdue:
    def test_not_overdue_before_due_datetime(self):
        now = datetime(2026, 7, 1, 8, 0)
        assert is_overdue("2026-07-01", "08:30", now) is False

    def test_overdue_after_due_datetime(self):
        now = datetime(2026, 7, 1, 9, 0)
        assert is_overdue("2026-07-01", "08:30", now) is True

    def test_overdue_uses_end_of_day_when_no_time_set(self):
        now = datetime(2026, 7, 1, 23, 0)
        assert is_overdue("2026-07-01", None, now) is False
        later = datetime(2026, 7, 2, 0, 1)
        assert is_overdue("2026-07-01", None, later) is True


class TestResolveOverdueBountyPayout:
    def test_penalty_applied_only_to_original_assignee(self):
        bounty = make_bounty(
            payout_cents=1000,
            initiative_bonus_pct=0,
            split_rule=SplitRule.FIRST_COME,
            original_assignee_member_id="child-1",
        )
        completion = BountyAcceptance(
            member_id="child-1",
            status=AcceptanceStatus.COMPLETED,
            completed_at="2026-07-01T10:00:00",
        )
        payouts = resolve_overdue_bounty_payout(bounty, [completion], -50)
        assert payouts == {"child-1": -500}

    def test_other_completer_unaffected_by_penalty(self):
        # The original assignee didn't complete it (nonzero payout goes to
        # someone else) - her entry (0) is left alone, no penalty applied.
        bounty = make_bounty(
            payout_cents=1000,
            initiative_bonus_pct=0,
            split_rule=SplitRule.FIRST_COME,
            original_assignee_member_id="child-1",
        )
        first = BountyAcceptance(
            member_id="child-2",
            status=AcceptanceStatus.COMPLETED,
            completed_at="2026-07-01T09:00:00",
        )
        second = BountyAcceptance(
            member_id="child-1",
            status=AcceptanceStatus.COMPLETED,
            completed_at="2026-07-01T10:00:00",
        )
        payouts = resolve_overdue_bounty_payout(bounty, [first, second], -50)
        assert payouts == {"child-2": 1000, "child-1": 0}

    def test_no_original_assignee_behaves_like_normal_resolve_payout(self):
        bounty = make_bounty(payout_cents=1000, initiative_bonus_pct=0)
        completion = BountyAcceptance(
            member_id="child-1",
            status=AcceptanceStatus.COMPLETED,
            completed_at="2026-07-01T10:00:00",
        )
        payouts = resolve_overdue_bounty_payout(bounty, [completion], -50)
        assert payouts == {"child-1": 1000}


# ---------------------------------------------------------------------------
# Chore prerequisite / rotation logic
# ---------------------------------------------------------------------------


class TestCheckPrerequisites:
    def test_no_prerequisites_is_satisfied(self):
        definition = make_definition(prerequisite_ids=[])
        assert check_prerequisites(definition, "child-1", []) is True

    def test_unmet_prerequisite_blocks(self):
        definition = make_definition(prerequisite_ids=["prereq-1"])
        assert check_prerequisites(definition, "child-1", []) is False

    def test_met_prerequisite_allows(self):
        definition = make_definition(prerequisite_ids=["prereq-1"])
        assignments = [
            ChoreAssignment(
                id="a-1",
                chore_definition_id="prereq-1",
                member_id="child-1",
                due_date="2026-07-01",
                payout_cents=100,
                status=ChoreAssignmentStatus.APPROVED,
            )
        ]
        assert check_prerequisites(definition, "child-1", assignments) is True

    def test_prerequisite_completed_by_other_member_does_not_count(self):
        definition = make_definition(prerequisite_ids=["prereq-1"])
        assignments = [
            ChoreAssignment(
                id="a-1",
                chore_definition_id="prereq-1",
                member_id="other-child",
                due_date="2026-07-01",
                payout_cents=100,
                status=ChoreAssignmentStatus.APPROVED,
            )
        ]
        assert check_prerequisites(definition, "child-1", assignments) is False


class TestNextRotationAssignee:
    def test_alternates_between_children(self):
        definition = make_definition(is_rotating=True, rotation_order=["child-1", "child-2"])
        assert next_rotation_assignee(definition, []) == "child-1"
        one_assignment = [
            ChoreAssignment(
                id="a-1", chore_definition_id=definition.id, member_id="child-1",
                due_date="2026-07-01", payout_cents=200,
            )
        ]
        assert next_rotation_assignee(definition, one_assignment) == "child-2"

    def test_no_rotation_order_raises(self):
        definition = make_definition(is_rotating=True, rotation_order=[])
        with pytest.raises(ValueError):
            next_rotation_assignee(definition, [])


# ---------------------------------------------------------------------------
# Permission level (ported from member_service._next_permission_level)
# ---------------------------------------------------------------------------


class TestNextPermissionLevel:
    def test_child_has_no_permission_level(self):
        assert next_permission_level(MemberRole.CHILD, None, 0) is None

    def test_first_parent_becomes_admin(self):
        assert next_permission_level(MemberRole.PARENT, None, 0) == PermissionLevel.ADMIN

    def test_every_new_parent_becomes_admin(self):
        # Every new parent defaults to admin now, regardless of how many
        # parents already exist - managed_child_ids (not admin/standard) is
        # what actually restricts a parent's visibility.
        assert next_permission_level(MemberRole.PARENT, None, 1) == PermissionLevel.ADMIN

    def test_explicit_request_is_honored(self):
        assert (
            next_permission_level(MemberRole.PARENT, PermissionLevel.STANDARD, 0)
            == PermissionLevel.STANDARD
        )


# ---------------------------------------------------------------------------
# Payroll: earning collectors + aggregation (new tests per the plan)
# ---------------------------------------------------------------------------


class TestCollectChoreEarnings:
    def test_collects_approved_assignment_in_period(self):
        period = make_period("2026-07-01", "2026-07-07", "2026-07-07")
        definition = make_definition(title="Dishes")
        assignment = ChoreAssignment(
            id="a-1", chore_definition_id=definition.id, member_id="child-1",
            due_date="2026-07-02", payout_cents=200, status=ChoreAssignmentStatus.APPROVED,
            approved_at="2026-07-03T12:00:00",
        )
        lines = collect_chore_earnings([assignment], [definition], "child-1", period)
        assert len(lines) == 1
        assert lines[0]["amount_cents"] == 200
        assert lines[0]["source_type"] == "chore"

    def test_excludes_unapproved_assignment(self):
        period = make_period("2026-07-01", "2026-07-07", "2026-07-07")
        definition = make_definition()
        assignment = ChoreAssignment(
            id="a-1", chore_definition_id=definition.id, member_id="child-1",
            due_date="2026-07-02", payout_cents=200, status=ChoreAssignmentStatus.SUBMITTED,
        )
        assert collect_chore_earnings([assignment], [definition], "child-1", period) == []

    def test_excludes_outside_period(self):
        period = make_period("2026-07-01", "2026-07-07", "2026-07-07")
        definition = make_definition()
        assignment = ChoreAssignment(
            id="a-1", chore_definition_id=definition.id, member_id="child-1",
            due_date="2026-06-20", payout_cents=200, status=ChoreAssignmentStatus.APPROVED,
            approved_at="2026-06-20T12:00:00",
        )
        assert collect_chore_earnings([assignment], [definition], "child-1", period) == []


class TestCollectBountyEarnings:
    def test_collects_completed_acceptance_with_payout(self):
        period = make_period("2026-07-01", "2026-07-07", "2026-07-07")
        bounty = make_bounty(
            acceptances=[
                BountyAcceptance(
                    member_id="child-1", status=AcceptanceStatus.COMPLETED,
                    completed_at="2026-07-03T00:00:00", payout_cents=1000,
                )
            ]
        )
        lines = collect_bounty_earnings([bounty], "child-1", period)
        assert len(lines) == 1
        assert lines[0]["amount_cents"] == 1000

    def test_excludes_uncompleted_acceptance(self):
        period = make_period("2026-07-01", "2026-07-07", "2026-07-07")
        bounty = make_bounty(
            acceptances=[BountyAcceptance(member_id="child-1", status=AcceptanceStatus.ACCEPTED)]
        )
        assert collect_bounty_earnings([bounty], "child-1", period) == []


class TestCollectGradeEarnings:
    def test_collects_grade_in_period(self):
        period = make_period("2026-07-01", "2026-07-07", "2026-07-07")
        subject = Subject(id="sub-1", household_id="hh-1", name="Math")
        entry = GradeEntry(
            id="g-1", subject_id="sub-1", member_id="child-1", grade_letter="A",
            grade_value_cents=500, period_label="Q1", entered_by_member_id="parent-1",
            entered_at="2026-07-02T00:00:00",
        )
        lines = collect_grade_earnings([entry], [subject], "child-1", period)
        assert lines[0]["amount_cents"] == 500


class TestCollectBehaviorEarnings:
    def test_collects_bonus_and_deduction(self):
        period = make_period("2026-07-01", "2026-07-07", "2026-07-07")
        bonus_type = BehaviorType(
            id="bt-1", household_id="hh-1", label="Great attitude",
            category=BehaviorCategory.BONUS, default_amount_cents=100,
        )
        entry = BehaviorEntry(
            id="be-1", behavior_type_id="bt-1", member_id="child-1", amount_cents=100,
            recorded_by_member_id="parent-1", recorded_at="2026-07-02T00:00:00",
        )
        lines = collect_behavior_earnings([entry], [bonus_type], "child-1", period)
        assert lines[0]["amount_cents"] == 100


class TestAggregatePaycheck:
    def test_gross_excludes_deductions_net_includes(self):
        lines = [
            {"amount_cents": 200},
            {"amount_cents": 1000},
            {"amount_cents": 500},
            {"amount_cents": -150},
        ]
        gross, net = aggregate_paycheck(lines)
        assert gross == 1700
        assert net == 1550

    def test_full_earnings_scenario_matches_backend_test(self):
        # Mirrors test_payroll.py's _setup_full_earnings expected totals:
        # chore 200 + bounty 1000 + grade 500 + behavior bonus 100 - deduction 150
        lines = [
            {"amount_cents": 200}, {"amount_cents": 1000}, {"amount_cents": 500},
            {"amount_cents": 100}, {"amount_cents": -150},
        ]
        gross, net = aggregate_paycheck(lines)
        assert gross == 1800
        assert net == 1650


class TestRequiresPaycheckApproval:
    def test_requires_when_configured(self):
        config = PayrollConfig(
            payday_rule=PaydayRule(type="weekly"), requires_parent_approval=True
        )
        assert requires_paycheck_approval(config, 1000) is True

    def test_skips_when_not_configured(self):
        config = PayrollConfig(
            payday_rule=PaydayRule(type="weekly"), requires_parent_approval=False
        )
        assert requires_paycheck_approval(config, 1000) is False

    def test_threshold_exempts_small_amounts(self):
        config = PayrollConfig(
            payday_rule=PaydayRule(type="weekly"),
            requires_parent_approval=True,
            approval_threshold_cents=500,
        )
        assert requires_paycheck_approval(config, 100) is False
        assert requires_paycheck_approval(config, 501) is True


# ---------------------------------------------------------------------------
# Report aggregations
# ---------------------------------------------------------------------------


class TestEarningsByChild:
    def test_sums_net_cents_per_child(self):
        members = [
            make_member("child-1", "Charlie"),
            make_member("parent-1", "Pat", MemberRole.PARENT),
        ]
        paychecks = [
            Paycheck(id="p1", pay_period_id="pp1", member_id="child-1", net_cents=500),
            Paycheck(id="p2", pay_period_id="pp2", member_id="child-1", net_cents=300),
        ]
        result = earnings_by_child(members, paychecks)
        assert len(result) == 1  # parent excluded
        assert result[0]["total_cents"] == 800


class TestEarningsByPayPeriod:
    def test_orders_most_recent_first(self):
        periods = [
            make_period("2026-06-01", "2026-06-07", "2026-06-07", "pp1"),
            make_period("2026-07-01", "2026-07-07", "2026-07-07", "pp2"),
        ]
        paychecks = [
            Paycheck(
                id="p1", pay_period_id="pp2", member_id="child-1", gross_cents=100, net_cents=90
            )
        ]
        result = earnings_by_pay_period(periods, paychecks)
        assert result[0]["pay_period_id"] == "pp2"
        assert result[0]["total_net_cents"] == 90


class TestHighestPayingChores:
    def test_sums_and_sorts_by_total_paid(self):
        definitions = [
            make_definition(id="d1", title="Dishes"),
            make_definition(id="d2", title="Vacuum"),
        ]
        assignments = [
            ChoreAssignment(
                id="a1",
                chore_definition_id="d1",
                member_id="c1",
                due_date="2026-07-01",
                payout_cents=100,
                status=ChoreAssignmentStatus.APPROVED,
            ),
            ChoreAssignment(
                id="a2",
                chore_definition_id="d2",
                member_id="c1",
                due_date="2026-07-02",
                payout_cents=500,
                status=ChoreAssignmentStatus.APPROVED,
            ),
        ]
        result = highest_paying_chores(definitions, assignments)
        assert result[0]["chore_definition_id"] == "d2"

    def test_most_completed_sorts_by_count(self):
        definitions = [
            make_definition(id="d1", title="Dishes"),
            make_definition(id="d2", title="Vacuum"),
        ]
        assignments = [
            ChoreAssignment(
                id="a1",
                chore_definition_id="d1",
                member_id="c1",
                due_date="2026-07-01",
                payout_cents=100,
                status=ChoreAssignmentStatus.APPROVED,
            ),
            ChoreAssignment(
                id="a2",
                chore_definition_id="d1",
                member_id="c1",
                due_date="2026-07-02",
                payout_cents=100,
                status=ChoreAssignmentStatus.APPROVED,
            ),
            ChoreAssignment(
                id="a3",
                chore_definition_id="d2",
                member_id="c1",
                due_date="2026-07-03",
                payout_cents=500,
                status=ChoreAssignmentStatus.APPROVED,
            ),
        ]
        result = most_completed_chores(definitions, assignments)
        assert result[0]["chore_definition_id"] == "d1"


class TestReliability:
    def test_computes_pct_from_approved_vs_total(self):
        members = [make_member("child-1", "Charlie")]
        assignments = [
            ChoreAssignment(
                id="a1",
                chore_definition_id="d1",
                member_id="child-1",
                due_date="2026-07-01",
                payout_cents=100,
                status=ChoreAssignmentStatus.APPROVED,
            ),
            ChoreAssignment(
                id="a2",
                chore_definition_id="d1",
                member_id="child-1",
                due_date="2026-07-02",
                payout_cents=100,
                status=ChoreAssignmentStatus.REJECTED,
            ),
        ]
        result = reliability(members, assignments)
        assert result[0]["reliability_pct"] == 50.0


# ---------------------------------------------------------------------------
# Dashboard aggregations
# ---------------------------------------------------------------------------


class TestActiveChoresCount:
    def test_counts_assigned_and_submitted_only(self):
        assignments = [
            ChoreAssignment(
                id="a1",
                chore_definition_id="d1",
                member_id="c1",
                due_date="2026-07-01",
                payout_cents=100,
                status=ChoreAssignmentStatus.ASSIGNED,
            ),
            ChoreAssignment(
                id="a2",
                chore_definition_id="d1",
                member_id="c1",
                due_date="2026-07-02",
                payout_cents=100,
                status=ChoreAssignmentStatus.APPROVED,
            ),
        ]
        assert active_chores_count(assignments) == 1


class TestPendingApprovalCounts:
    def test_chore_approvals(self):
        assignments = [
            ChoreAssignment(
                id="a1",
                chore_definition_id="d1",
                member_id="c1",
                due_date="2026-07-01",
                payout_cents=100,
                status=ChoreAssignmentStatus.SUBMITTED,
            ),
        ]
        assert pending_chore_approvals_count(assignments) == 1

    def test_bounty_approvals(self):
        bounty = make_bounty(
            acceptances=[BountyAcceptance(member_id="c1", status=AcceptanceStatus.SUBMITTED)]
        )
        assert pending_bounty_approvals_count([bounty]) == 1
