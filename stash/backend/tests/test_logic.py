from datetime import date

import pytest

from stash_addon.const import (
    BillStatus,
    BillType,
    Frequency,
    PayFrequency,
    PaymentType,
    ResponsibilityMethod,
    SavingsType,
)
from stash_addon.logic import (
    add_months,
    automatic_percentages,
    bill_responsibility,
    bill_responsibility_totals,
    bills_total_between,
    calculate_default_savings_plan,
    calculate_savings_amount,
    cash_infusion_contributions_total,
    cash_infusion_matches_amount,
    cash_infusions_total_for_month,
    category_budget_recommendation,
    category_name_taken,
    category_spend_for_month,
    category_totals,
    compute_overdue_status,
    compute_settlement,
    current_pay_period_start,
    household_pay_period_end,
    household_paydays_in_month,
    household_summary,
    is_due_this_pay_period,
    is_payment_late,
    next_due_date,
    next_household_payday,
    next_pay_dates,
    next_pay_dates_for_source,
    payments_total_for_bill,
    recent_months,
    savings_amount_for_pay_period,
    savings_deposited_between,
    savings_deposited_for_month,
    savings_plan_contributions_for_month,
    savings_plan_meets_amount,
    savings_plan_total,
    savings_responsibility,
    should_reactivate_deferral,
    status_from_contribution_total,
)
from stash_addon.models import (
    Bill,
    CashInfusion,
    Category,
    CategoryExpense,
    Contribution,
    IncomeEntry,
    IncomeSource,
    Member,
    Payment,
    SavingsDeposit,
    SavingsPlan,
    SavingsPlanEntry,
)


def make_member(member_id: str, name: str, income: float, month: str = "2026-07") -> Member:
    return Member(id=member_id, name=name, income_history=[IncomeEntry(month=month, amount=income)])


def make_bill(**overrides) -> Bill:
    defaults = dict(
        id="bill-1",
        name="Mortgage",
        amount=2100.0,
        category_id="cat-housing",
        due_date="2026-07-15",
        frequency=Frequency.MONTHLY,
        bill_type=BillType.FIXED,
        status=BillStatus.UNPAID,
        month="2026-07",
    )
    defaults.update(overrides)
    return Bill(**defaults)


class TestAddMonths:
    def test_simple_increment(self):
        assert add_months(date(2026, 1, 15), 1) == date(2026, 2, 15)

    def test_month_end_clamping(self):
        assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)

    def test_leap_year(self):
        assert add_months(date(2027, 1, 31), 1) == date(2028, 2, 29) or add_months(
            date(2028, 1, 31), 1
        ) == date(2028, 2, 29)

    def test_year_rollover(self):
        assert add_months(date(2026, 12, 15), 1) == date(2027, 1, 15)


class TestNextDueDate:
    def test_weekly(self):
        assert next_due_date(date(2026, 7, 1), Frequency.WEEKLY) == date(2026, 7, 8)

    def test_biweekly(self):
        assert next_due_date(date(2026, 7, 1), Frequency.BIWEEKLY) == date(2026, 7, 15)

    def test_monthly(self):
        assert next_due_date(date(2026, 7, 15), Frequency.MONTHLY) == date(2026, 8, 15)

    def test_quarterly(self):
        assert next_due_date(date(2026, 1, 15), Frequency.QUARTERLY) == date(2026, 4, 15)

    def test_yearly(self):
        assert next_due_date(date(2026, 7, 15), Frequency.YEARLY) == date(2027, 7, 15)

    def test_one_time_has_no_next(self):
        assert next_due_date(date(2026, 7, 15), Frequency.ONE_TIME) is None


class TestAutomaticPercentages:
    def test_proportional_split(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        pcts = automatic_percentages([jordan, yazmin])
        assert pcts["jordan"] == pytest.approx(75.0)
        assert pcts["yazmin"] == pytest.approx(25.0)

    def test_no_income_splits_equally(self):
        a = make_member("a", "A", 0)
        b = make_member("b", "B", 0)
        pcts = automatic_percentages([a, b])
        assert pcts["a"] == pytest.approx(50.0)
        assert pcts["b"] == pytest.approx(50.0)

    def test_empty_members(self):
        assert automatic_percentages([]) == {}


class TestBillResponsibility:
    def test_automatic_method(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        bill = make_bill(amount=2100.0)
        breakdown = bill_responsibility(bill, [jordan, yazmin], ResponsibilityMethod.AUTOMATIC)
        assert breakdown["jordan"]["amount"] == pytest.approx(1575.0)
        assert breakdown["yazmin"]["amount"] == pytest.approx(525.0)

    def test_manual_method_uses_bill_override(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        bill = make_bill(amount=1000.0, manual_responsibility={"jordan": 60.0, "yazmin": 40.0})
        breakdown = bill_responsibility(bill, [jordan, yazmin], ResponsibilityMethod.MANUAL)
        assert breakdown["jordan"]["amount"] == pytest.approx(600.0)
        assert breakdown["yazmin"]["amount"] == pytest.approx(400.0)

    def test_manual_method_falls_back_without_override(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        bill = make_bill(amount=2100.0, manual_responsibility=None)
        breakdown = bill_responsibility(bill, [jordan, yazmin], ResponsibilityMethod.MANUAL)
        assert breakdown["jordan"]["amount"] == pytest.approx(1575.0)


class TestBillResponsibilityTotals:
    def test_sums_across_all_bills_regardless_of_payment_status(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        rent = make_bill(id="rent", amount=2000.0, status=BillStatus.UNPAID)
        power = make_bill(id="power", amount=100.0, status=BillStatus.PAID)
        totals = bill_responsibility_totals(
            [rent, power], [jordan, yazmin], ResponsibilityMethod.AUTOMATIC
        )
        # Jordan is 75% of income, so 75% of (2000 + 100).
        assert totals["jordan"] == pytest.approx(1575.0)
        assert totals["yazmin"] == pytest.approx(525.0)

    def test_unpaid_bill_with_no_contributions_still_counts(self):
        # This is the bug this function exists to fix: a bill nobody has paid
        # a cent toward yet must still count as part of what you're on the
        # hook for, unlike compute_settlement's contribution-scoped figure.
        jordan = make_member("jordan", "Jordan", 3000)
        rent = make_bill(id="rent", amount=2000.0, status=BillStatus.UNPAID)
        totals = bill_responsibility_totals([rent], [jordan], ResponsibilityMethod.AUTOMATIC)
        assert totals["jordan"] == pytest.approx(2000.0)

    def test_no_bills_returns_zero_for_every_member(self):
        jordan = make_member("jordan", "Jordan", 3000)
        totals = bill_responsibility_totals([], [jordan], ResponsibilityMethod.AUTOMATIC)
        assert totals["jordan"] == pytest.approx(0.0)


class TestStatusFromContributionTotal:
    def test_unpaid_when_zero(self):
        assert status_from_contribution_total(0, 100) == BillStatus.UNPAID

    def test_partially_paid_when_less_than_amount(self):
        assert status_from_contribution_total(30, 100) == BillStatus.PARTIALLY_PAID

    def test_paid_when_equal(self):
        assert status_from_contribution_total(100, 100) == BillStatus.PAID

    def test_paid_when_over(self):
        assert status_from_contribution_total(150, 100) == BillStatus.PAID


class TestOverdueDetection:
    def test_becomes_overdue_when_past_due(self):
        bill = make_bill(due_date="2026-07-01", status=BillStatus.UNPAID)
        assert compute_overdue_status(bill, date(2026, 7, 10)) == BillStatus.OVERDUE

    def test_not_overdue_when_due_in_future(self):
        bill = make_bill(due_date="2026-07-20", status=BillStatus.UNPAID)
        assert compute_overdue_status(bill, date(2026, 7, 10)) == BillStatus.UNPAID

    def test_paid_bills_never_overdue(self):
        bill = make_bill(due_date="2026-07-01", status=BillStatus.PAID)
        assert compute_overdue_status(bill, date(2026, 7, 10)) == BillStatus.PAID

    def test_deferred_bills_never_overdue(self):
        bill = make_bill(due_date="2026-07-01", status=BillStatus.DEFERRED)
        assert compute_overdue_status(bill, date(2026, 7, 10)) == BillStatus.DEFERRED

    def test_partially_paid_can_become_overdue(self):
        bill = make_bill(due_date="2026-07-01", status=BillStatus.PARTIALLY_PAID)
        assert compute_overdue_status(bill, date(2026, 7, 10)) == BillStatus.OVERDUE

    def test_reverts_to_unpaid_once_due_date_moves_to_future(self):
        # A recurring bill's due date rolled forward (or someone edited it via
        # Edit Bill) after it had already been flagged overdue - it shouldn't
        # stay stuck as overdue forever.
        bill = make_bill(due_date="2026-07-15", status=BillStatus.OVERDUE)
        assert compute_overdue_status(bill, date(2026, 7, 3)) == BillStatus.UNPAID

    def test_reverts_to_partially_paid_once_due_date_moves_to_future(self):
        bill = make_bill(due_date="2026-07-15", status=BillStatus.OVERDUE, amount=100)
        assert (
            compute_overdue_status(bill, date(2026, 7, 3), paid_total=40)
            == BillStatus.PARTIALLY_PAID
        )

    def test_reverts_to_paid_once_due_date_moves_to_future_and_fully_paid(self):
        bill = make_bill(due_date="2026-07-15", status=BillStatus.OVERDUE, amount=100)
        assert (
            compute_overdue_status(bill, date(2026, 7, 3), paid_total=100) == BillStatus.PAID
        )


class TestNextHouseholdPayday:
    def test_soonest_across_members(self):
        jordan = Member(
            id="jordan", name="Jordan", pay_frequency=PayFrequency.SEMI_MONTHLY, pay_days=[1, 15]
        )
        yazmin = Member(
            id="yazmin",
            name="Yazmin",
            pay_frequency=PayFrequency.BIWEEKLY,
            pay_anchor_date="2026-06-19",
        )
        # Jordan's next payday from 2026-07-10 is 2026-07-15; Yazmin's biweekly
        # cycle from that anchor lands on 2026-07-17. Soonest is Jordan's.
        payday = next_household_payday([jordan, yazmin], date(2026, 7, 10))
        assert payday == date(2026, 7, 15)

    def test_no_members_returns_none(self):
        assert next_household_payday([], date(2026, 7, 10)) is None

    def test_member_without_configured_cycle_is_skipped(self):
        # Weekly/biweekly with no anchor date produces no candidate dates.
        member = Member(id="m", name="M", pay_frequency=PayFrequency.BIWEEKLY)
        assert next_household_payday([member], date(2026, 7, 10)) is None


class TestHouseholdPayPeriodEnd:
    def _household(self) -> list[Member]:
        # Jordan: semi-monthly on the 1st and 15th. Yazmin: biweekly, anchored
        # so her paydays land on the 3rd, 17th, and 31st.
        jordan = Member(
            id="jordan", name="Jordan", pay_frequency=PayFrequency.SEMI_MONTHLY, pay_days=[1, 15]
        )
        yazmin = Member(
            id="yazmin",
            name="Yazmin",
            pay_frequency=PayFrequency.BIWEEKLY,
            pay_anchor_date="2026-07-03",
        )
        return [jordan, yazmin]

    def test_period_runs_through_the_next_payday_after_everyone_is_paid(self):
        # Round completes on Yazmin's 3rd (everyone's been paid since the 1st);
        # the next payday after that is Jordan's 15th, so period 1 = 1st-14th.
        period_end = household_pay_period_end(self._household(), date(2026, 7, 5))
        assert period_end == date(2026, 7, 15)

    def test_next_period_absorbs_an_extra_payday_before_ending(self):
        # Round completes on Yazmin's 17th (everyone's been paid since the
        # 15th); the next payday after that is Yazmin's own 31st (Jordan's
        # isn't until the following month), so period 2 = 15th-30th.
        period_end = household_pay_period_end(self._household(), date(2026, 7, 20))
        assert period_end == date(2026, 7, 31)

    def test_no_members_returns_none(self):
        assert household_pay_period_end([], date(2026, 7, 10)) is None

    def test_member_without_configured_cycle_is_skipped(self):
        member = Member(id="m", name="M", pay_frequency=PayFrequency.BIWEEKLY)
        assert household_pay_period_end([member], date(2026, 7, 10)) is None


class TestDueThisPayPeriod:
    def test_due_before_next_payday(self):
        bill = make_bill(due_date="2026-07-15", status=BillStatus.UNPAID)
        assert is_due_this_pay_period(bill, date(2026, 7, 10), date(2026, 7, 20)) is True

    def test_due_after_next_payday(self):
        bill = make_bill(due_date="2026-07-25", status=BillStatus.UNPAID)
        assert is_due_this_pay_period(bill, date(2026, 7, 10), date(2026, 7, 20)) is False

    def test_due_on_next_payday_belongs_to_next_period(self):
        bill = make_bill(due_date="2026-07-20", status=BillStatus.UNPAID)
        assert is_due_this_pay_period(bill, date(2026, 7, 10), date(2026, 7, 20)) is False

    def test_past_due_excluded(self):
        bill = make_bill(due_date="2026-07-01", status=BillStatus.UNPAID)
        assert is_due_this_pay_period(bill, date(2026, 7, 10), date(2026, 7, 20)) is False

    def test_paid_bill_excluded(self):
        bill = make_bill(due_date="2026-07-15", status=BillStatus.PAID)
        assert is_due_this_pay_period(bill, date(2026, 7, 10), date(2026, 7, 20)) is False

    def test_no_next_payday_excludes_everything(self):
        bill = make_bill(due_date="2026-07-15", status=BillStatus.UNPAID)
        assert is_due_this_pay_period(bill, date(2026, 7, 10), None) is False


class TestBillsTotalBetween:
    def test_sums_bills_on_or_after_start_up_to_end(self):
        # This models "next pay period": due on or after the upcoming
        # payday, up to (but not including) the payday after that.
        in_range = make_bill(id="b1", due_date="2026-07-20", amount=500.0)
        on_start_boundary = make_bill(id="b2", due_date="2026-07-15", amount=300.0)
        on_end_boundary = make_bill(id="b3", due_date="2026-07-31", amount=999.0)
        after_end = make_bill(id="b4", due_date="2026-08-05", amount=999.0)
        total = bills_total_between(
            [in_range, on_start_boundary, on_end_boundary, after_end],
            date(2026, 7, 15),
            date(2026, 7, 31),
        )
        assert total == pytest.approx(800.0)

    def test_end_boundary_is_exclusive(self):
        bill = make_bill(due_date="2026-07-31", amount=100.0)
        assert bills_total_between([bill], date(2026, 7, 15), date(2026, 7, 31)) == pytest.approx(
            0.0
        )

    def test_deferred_bills_excluded(self):
        bill = make_bill(due_date="2026-07-20", amount=500.0, status=BillStatus.DEFERRED)
        assert bills_total_between([bill], date(2026, 7, 15), date(2026, 7, 31)) == pytest.approx(
            0.0
        )

    def test_no_bills_returns_zero(self):
        assert bills_total_between([], date(2026, 7, 15), date(2026, 7, 31)) == pytest.approx(0.0)


class TestDeferralReactivation:
    def test_reactivates_once_date_passed(self):
        bill = make_bill(status=BillStatus.DEFERRED, deferred_until="2026-07-01")
        assert should_reactivate_deferral(bill, date(2026, 7, 5)) is True

    def test_stays_deferred_before_date(self):
        bill = make_bill(status=BillStatus.DEFERRED, deferred_until="2026-07-10")
        assert should_reactivate_deferral(bill, date(2026, 7, 5)) is False

    def test_non_deferred_bill_ignored(self):
        bill = make_bill(status=BillStatus.UNPAID)
        assert should_reactivate_deferral(bill, date(2026, 7, 5)) is False


class TestSettlement:
    def test_spec_example(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        bill = make_bill(amount=2100.0, month="2026-07")
        payment = Payment(
            id="p1",
            bill_id="bill-1",
            date="2026-07-05",
            type=PaymentType.INDIVIDUAL,
            contributions=[Contribution(member_id="jordan", amount=2100.0)],
        )
        settlement = compute_settlement(
            "2026-07", [bill], [payment], [jordan, yazmin], ResponsibilityMethod.AUTOMATIC
        )
        by_member = {b.member_id: b for b in settlement.member_balances}
        assert by_member["jordan"].responsible == pytest.approx(1575.0)
        assert by_member["jordan"].paid == pytest.approx(2100.0)
        assert by_member["jordan"].difference == pytest.approx(525.0)
        assert by_member["yazmin"].responsible == pytest.approx(525.0)
        assert by_member["yazmin"].paid == pytest.approx(0.0)
        assert by_member["yazmin"].difference == pytest.approx(-525.0)

    def test_ignores_bills_outside_month(self):
        jordan = make_member("jordan", "Jordan", 3000)
        bill = make_bill(month="2026-06")
        settlement = compute_settlement(
            "2026-07", [bill], [], [jordan], ResponsibilityMethod.AUTOMATIC
        )
        assert settlement.member_balances[0].responsible == 0.0

    def test_bill_paid_normally_excluded_from_settlement(self):
        # A bill paid via "Paid Normally" has no per-member contributions -
        # there's nothing to reconcile, so it shouldn't create a phantom
        # imbalance on either side of the settlement.
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        bill = make_bill(amount=2100.0, month="2026-07")
        payment = Payment(
            id="p1",
            bill_id="bill-1",
            date="2026-07-05",
            type=PaymentType.NORMAL,
            contributions=[],
        )
        settlement = compute_settlement(
            "2026-07", [bill], [payment], [jordan, yazmin], ResponsibilityMethod.AUTOMATIC
        )
        for balance in settlement.member_balances:
            assert balance.responsible == 0.0
            assert balance.paid == 0.0
            assert balance.difference == 0.0

    def test_mixes_normal_and_individual_bills_in_same_month(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        normal_bill = make_bill(id="bill-normal", amount=500.0, month="2026-07")
        individual_bill = make_bill(id="bill-individual", amount=2100.0, month="2026-07")
        normal_payment = Payment(
            id="p1", bill_id="bill-normal", date="2026-07-01", type=PaymentType.NORMAL
        )
        individual_payment = Payment(
            id="p2",
            bill_id="bill-individual",
            date="2026-07-05",
            type=PaymentType.INDIVIDUAL,
            contributions=[Contribution(member_id="jordan", amount=2100.0)],
        )
        settlement = compute_settlement(
            "2026-07",
            [normal_bill, individual_bill],
            [normal_payment, individual_payment],
            [jordan, yazmin],
            ResponsibilityMethod.AUTOMATIC,
        )
        by_member = {b.member_id: b for b in settlement.member_balances}
        # Only the individually-paid $2,100 bill should factor in, not the
        # normally-paid $500 one.
        assert by_member["jordan"].responsible == pytest.approx(1575.0)
        assert by_member["yazmin"].responsible == pytest.approx(525.0)


class TestPaymentsTotalForBill:
    def test_sums_only_matching_bill(self):
        p1 = Payment(id="p1", bill_id="bill-1", date="2026-07-01", type=PaymentType.NORMAL,
                     contributions=[Contribution(member_id="jordan", amount=100.0)])
        p2 = Payment(id="p2", bill_id="bill-2", date="2026-07-01", type=PaymentType.NORMAL,
                     contributions=[Contribution(member_id="jordan", amount=999.0)])
        assert payments_total_for_bill("bill-1", [p1, p2]) == pytest.approx(100.0)


class TestIsPaymentLate:
    def test_paid_after_due_date_is_late(self):
        assert is_payment_late("2026-07-01", "2026-07-06") is True

    def test_paid_on_due_date_is_not_late(self):
        assert is_payment_late("2026-07-01", "2026-07-01") is False

    def test_paid_before_due_date_is_not_late(self):
        assert is_payment_late("2026-07-15", "2026-07-01") is False

    def test_invalid_date_defaults_to_not_late(self):
        assert is_payment_late("2026-07-01", "not-a-date") is False


class TestHouseholdSummary:
    def test_totals(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        paid_bill = make_bill(id="b1", amount=500.0, status=BillStatus.PAID)
        unpaid_bill = make_bill(id="b2", amount=300.0, status=BillStatus.UNPAID)
        summary = household_summary([paid_bill, unpaid_bill], [jordan, yazmin])
        assert summary["total_income"] == pytest.approx(4000.0)
        assert summary["total_bills"] == pytest.approx(800.0)
        assert summary["paid"] == pytest.approx(500.0)
        assert summary["remaining"] == pytest.approx(300.0)
        assert summary["cash_remaining"] == pytest.approx(3700.0)

    def test_cash_infusions_add_to_cash_remaining_only(self):
        jordan = make_member("jordan", "Jordan", 3000)
        paid_bill = make_bill(id="b1", amount=500.0, status=BillStatus.PAID)
        summary = household_summary([paid_bill], [jordan], cash_infusions_total=1000.0)
        assert summary["total_income"] == pytest.approx(3000.0)
        assert summary["cash_remaining"] == pytest.approx(4000.0)


class TestCategoryNameTaken:
    def test_exact_match(self):
        categories = [Category(id="c1", name="Auto")]
        assert category_name_taken(categories, "Auto") is True

    def test_case_insensitive_match(self):
        categories = [Category(id="c1", name="Auto")]
        assert category_name_taken(categories, "AUTO") is True

    def test_ignores_surrounding_whitespace(self):
        categories = [Category(id="c1", name="Auto")]
        assert category_name_taken(categories, "  auto  ") is True

    def test_no_match(self):
        categories = [Category(id="c1", name="Auto")]
        assert category_name_taken(categories, "Housing") is False

    def test_empty_categories(self):
        assert category_name_taken([], "Auto") is False


class TestCategoryTotals:
    def test_groups_by_category(self):
        b1 = make_bill(id="b1", category_id="cat-a", amount=100.0)
        b2 = make_bill(id="b2", category_id="cat-a", amount=50.0)
        b3 = make_bill(id="b3", category_id="cat-b", amount=25.0)
        totals = category_totals([b1, b2, b3])
        assert totals["cat-a"] == pytest.approx(150.0)
        assert totals["cat-b"] == pytest.approx(25.0)

    def test_folds_in_non_bill_expenses(self):
        b1 = make_bill(id="b1", category_id="cat-a", amount=100.0)
        gas = CategoryExpense(
            id="e1",
            category_id="cat-a",
            name="Gas",
            amount=45.0,
            date="2026-07-10",
            month="2026-07",
        )
        groceries = CategoryExpense(
            id="e2",
            category_id="cat-c",
            name="Groceries",
            amount=60.0,
            date="2026-07-11",
            month="2026-07",
        )
        totals = category_totals([b1], [gas, groceries])
        assert totals["cat-a"] == pytest.approx(145.0)
        assert totals["cat-c"] == pytest.approx(60.0)

    def test_no_expenses_matches_bills_only_behavior(self):
        b1 = make_bill(id="b1", category_id="cat-a", amount=100.0)
        assert category_totals([b1], None) == category_totals([b1])


class TestCategorySpendForMonth:
    def test_sums_bills_and_expenses_for_that_category_and_month(self):
        b1 = make_bill(id="b1", category_id="cat-a", amount=100.0, month="2026-06")
        b2 = make_bill(id="b2", category_id="cat-a", amount=999.0, month="2026-07")
        gas = CategoryExpense(
            id="e1", category_id="cat-a", name="Gas", amount=45.0, date="2026-06-10",
            month="2026-06",
        )
        other_category = CategoryExpense(
            id="e2", category_id="cat-b", name="Other", amount=60.0, date="2026-06-11",
            month="2026-06",
        )
        total = category_spend_for_month([b1, b2], [gas, other_category], "cat-a", "2026-06")
        assert total == pytest.approx(145.0)


class TestRecentMonths:
    def test_returns_preceding_months_oldest_first(self):
        assert recent_months("2026-07", 3) == ["2026-04", "2026-05", "2026-06"]

    def test_crosses_year_boundary(self):
        assert recent_months("2026-02", 3) == ["2025-11", "2025-12", "2026-01"]


class TestCategoryBudgetRecommendation:
    def test_no_budget_set_maintains(self):
        assert category_budget_recommendation(0, [500, 600, 700]) == "maintain"

    def test_no_history_maintains(self):
        assert category_budget_recommendation(200, []) == "maintain"

    def test_consistently_over_recommends_raise(self):
        assert category_budget_recommendation(200, [250, 300, 220]) == "raise"

    def test_consistently_under_recommends_lower(self):
        assert category_budget_recommendation(200, [50, 100, 90]) == "lower"

    def test_mixed_spending_maintains(self):
        assert category_budget_recommendation(200, [250, 100, 190]) == "maintain"

    def test_single_outlier_month_does_not_trigger_raise(self):
        # Only 1 of 3 months over budget - not a majority.
        assert category_budget_recommendation(200, [250, 190, 180]) == "maintain"


class TestNextPayDates:
    def test_semi_monthly_1st_and_15th(self):
        # Jordan: paid on the 1st and the 15th of every month.
        jordan = Member(
            id="jordan",
            name="Jordan",
            pay_frequency=PayFrequency.SEMI_MONTHLY,
            pay_days=[1, 15],
        )
        dates = next_pay_dates(jordan, date(2026, 7, 5), count=3)
        assert dates == [date(2026, 7, 15), date(2026, 8, 1), date(2026, 8, 15)]

    def test_semi_monthly_on_pay_day_itself(self):
        jordan = Member(
            id="jordan", name="Jordan", pay_frequency=PayFrequency.SEMI_MONTHLY, pay_days=[1, 15]
        )
        dates = next_pay_dates(jordan, date(2026, 7, 1), count=1)
        assert dates == [date(2026, 7, 1)]

    def test_biweekly(self):
        # Yazmin: paid every 2 weeks, last known payday 2026-06-19.
        yazmin = Member(
            id="yazmin",
            name="Yazmin",
            pay_frequency=PayFrequency.BIWEEKLY,
            pay_anchor_date="2026-06-19",
        )
        dates = next_pay_dates(yazmin, date(2026, 7, 2), count=2)
        assert dates == [date(2026, 7, 3), date(2026, 7, 17)]

    def test_weekly(self):
        member = Member(
            id="m", name="M", pay_frequency=PayFrequency.WEEKLY, pay_anchor_date="2026-07-03"
        )
        dates = next_pay_dates(member, date(2026, 7, 1), count=2)
        assert dates == [date(2026, 7, 3), date(2026, 7, 10)]

    def test_monthly_clamps_short_months(self):
        member = Member(
            id="m", name="M", pay_frequency=PayFrequency.MONTHLY, pay_days=[31]
        )
        dates = next_pay_dates(member, date(2026, 2, 1), count=1)
        assert dates == [date(2026, 2, 28)]

    def test_interval_without_anchor_returns_empty(self):
        member = Member(id="m", name="M", pay_frequency=PayFrequency.BIWEEKLY)
        assert next_pay_dates(member, date(2026, 7, 1)) == []


class TestNextPayDatesForSource:
    def test_source_has_its_own_schedule_independent_of_member(self):
        # A side gig paid biweekly, while the member's own schedule (not
        # used here) might be something else entirely - these never mix.
        side_gig = IncomeSource(
            id="s1",
            name="Side gig",
            amount=900,
            pay_frequency=PayFrequency.BIWEEKLY,
            pay_anchor_date="2026-06-19",
        )
        dates = next_pay_dates_for_source(side_gig, date(2026, 7, 2), count=2)
        assert dates == [date(2026, 7, 3), date(2026, 7, 17)]

    def test_source_semi_monthly_days(self):
        source = IncomeSource(
            id="s1",
            name="VA Compensation",
            amount=2900,
            pay_frequency=PayFrequency.SEMI_MONTHLY,
            pay_days=[1, 15],
        )
        dates = next_pay_dates_for_source(source, date(2026, 7, 5), count=1)
        assert dates == [date(2026, 7, 15)]

    def test_source_interval_without_anchor_returns_empty(self):
        source = IncomeSource(
            id="s1", name="Side gig", amount=900, pay_frequency=PayFrequency.WEEKLY
        )
        assert next_pay_dates_for_source(source, date(2026, 7, 1)) == []


class TestCalculateSavingsAmount:
    def test_percent_of_income(self):
        amount = calculate_savings_amount(SavingsType.PERCENT_OF_INCOME, 20.0, 4000.0, 2800.0)
        assert amount == pytest.approx(800.0)

    def test_percent_of_remaining(self):
        # Remaining = 4000 - 2800 = 1200; 20% of that = 240.
        amount = calculate_savings_amount(SavingsType.PERCENT_OF_REMAINING, 20.0, 4000.0, 2800.0)
        assert amount == pytest.approx(240.0)

    def test_percent_of_remaining_clamps_at_zero_when_bills_exceed_income(self):
        amount = calculate_savings_amount(SavingsType.PERCENT_OF_REMAINING, 20.0, 1000.0, 1500.0)
        assert amount == pytest.approx(0.0)

    def test_fixed_amount(self):
        amount = calculate_savings_amount(SavingsType.FIXED_AMOUNT, 200.0, 4000.0, 2800.0)
        assert amount == pytest.approx(200.0)


class TestSavingsResponsibility:
    def test_splits_by_income_proportionally(self):
        jordan = make_member("jordan", "Jordan", 3000)
        yazmin = make_member("yazmin", "Yazmin", 1000)
        breakdown = savings_responsibility(800.0, [jordan, yazmin])
        assert breakdown["jordan"]["amount"] == pytest.approx(600.0)
        assert breakdown["yazmin"]["amount"] == pytest.approx(200.0)


class TestCalculateDefaultSavingsPlan:
    def test_non_one_time_bill_returns_empty(self):
        bill = make_bill(frequency=Frequency.MONTHLY, amount=1200.0, due_date="2026-10-15")
        assert calculate_default_savings_plan(bill, date(2026, 7, 1)) == []

    def test_due_date_in_the_past_saves_full_amount_this_month(self):
        bill = make_bill(frequency=Frequency.ONE_TIME, amount=600.0, due_date="2026-06-01")
        entries = calculate_default_savings_plan(bill, date(2026, 7, 10))
        assert len(entries) == 1
        assert entries[0].month == "2026-07"
        assert entries[0].amount == pytest.approx(600.0)

    def test_due_later_this_same_month(self):
        bill = make_bill(frequency=Frequency.ONE_TIME, amount=300.0, due_date="2026-07-25")
        entries = calculate_default_savings_plan(bill, date(2026, 7, 10))
        assert entries == [SavingsPlanEntry(month="2026-07", amount=300.0)]

    def test_splits_evenly_across_months_with_remainder_last(self):
        # $1000 due in 3 months from now: July, August, September.
        bill = make_bill(frequency=Frequency.ONE_TIME, amount=1000.0, due_date="2026-09-15")
        entries = calculate_default_savings_plan(bill, date(2026, 7, 1))
        assert [e.month for e in entries] == ["2026-07", "2026-08", "2026-09"]
        assert entries[0].amount == pytest.approx(333.33)
        assert entries[1].amount == pytest.approx(333.33)
        # Last month absorbs the rounding remainder so the total is exact.
        assert entries[2].amount == pytest.approx(333.34)
        assert savings_plan_total(entries) == pytest.approx(1000.0)


class TestSavingsPlanValidation:
    def test_total_sums_entries(self):
        entries = [
            SavingsPlanEntry(month="2026-07", amount=100.0),
            SavingsPlanEntry(month="2026-08", amount=50.0),
        ]
        assert savings_plan_total(entries) == pytest.approx(150.0)

    def test_meets_amount_true_when_equal_or_over(self):
        entries = [SavingsPlanEntry(month="2026-07", amount=500.0)]
        assert savings_plan_meets_amount(entries, 500.0) is True
        assert savings_plan_meets_amount(entries, 499.0) is True

    def test_meets_amount_false_when_under(self):
        entries = [SavingsPlanEntry(month="2026-07", amount=400.0)]
        assert savings_plan_meets_amount(entries, 500.0) is False

    def test_meets_amount_tolerates_float_rounding(self):
        entries = [
            SavingsPlanEntry(month="2026-07", amount=333.33),
            SavingsPlanEntry(month="2026-08", amount=333.34),
        ]
        # Sums to 666.67, just under 666.67 due to no actual rounding here,
        # but confirms exact totals are accepted.
        assert savings_plan_meets_amount(entries, 666.67) is True


class TestSavingsPlanContributionsForMonth:
    def test_sums_entries_for_the_given_month_across_plans(self):
        plans = [
            SavingsPlan(
                bill_id="bill-1",
                entries=[
                    SavingsPlanEntry(month="2026-07", amount=100.0),
                    SavingsPlanEntry(month="2026-08", amount=100.0),
                ],
            ),
            SavingsPlan(
                bill_id="bill-2",
                entries=[SavingsPlanEntry(month="2026-07", amount=50.0)],
            ),
        ]
        assert savings_plan_contributions_for_month(plans, [], "2026-07") == pytest.approx(150.0)

    def test_ignores_months_that_dont_match(self):
        plans = [
            SavingsPlan(bill_id="bill-1", entries=[SavingsPlanEntry(month="2026-08", amount=100.0)])
        ]
        assert savings_plan_contributions_for_month(plans, [], "2026-07") == pytest.approx(0.0)

    def test_no_plans_returns_zero(self):
        assert savings_plan_contributions_for_month([], [], "2026-07") == pytest.approx(0.0)

    def test_excludes_installment_for_the_bill_s_own_due_month(self):
        # The bill is due 2026-09; its last installment lands that same month.
        # That money is being spent to pay the now-due bill (already counted
        # in Bills), so it shouldn't also still count as Savings.
        bill = make_bill(id="roof", due_date="2026-09-15", month="2026-09")
        plan = SavingsPlan(
            bill_id="roof",
            entries=[
                SavingsPlanEntry(month="2026-07", amount=200.0),
                SavingsPlanEntry(month="2026-08", amount=200.0),
                SavingsPlanEntry(month="2026-09", amount=200.0),
            ],
        )
        assert savings_plan_contributions_for_month([plan], [bill], "2026-07") == pytest.approx(
            200.0
        )
        assert savings_plan_contributions_for_month([plan], [bill], "2026-08") == pytest.approx(
            200.0
        )
        assert savings_plan_contributions_for_month([plan], [bill], "2026-09") == pytest.approx(
            0.0
        )


class TestHouseholdPaydaysInMonth:
    def test_semi_monthly_gives_two_paydays(self):
        jordan = Member(
            id="jordan", name="Jordan", pay_frequency=PayFrequency.SEMI_MONTHLY, pay_days=[1, 15]
        )
        paydays = household_paydays_in_month([jordan], "2026-07")
        assert paydays == [date(2026, 7, 1), date(2026, 7, 15)]

    def test_biweekly_can_give_two_or_three_paydays(self):
        yazmin = Member(
            id="yazmin",
            name="Yazmin",
            pay_frequency=PayFrequency.BIWEEKLY,
            pay_anchor_date="2026-06-19",
        )
        # Biweekly from 2026-06-19: ... 2026-07-03, 2026-07-17, 2026-07-31.
        paydays = household_paydays_in_month([yazmin], "2026-07")
        assert paydays == [date(2026, 7, 3), date(2026, 7, 17), date(2026, 7, 31)]

    def test_union_across_members_deduplicates_same_day(self):
        jordan = Member(
            id="jordan", name="Jordan", pay_frequency=PayFrequency.MONTHLY, pay_days=[1]
        )
        yazmin = Member(
            id="yazmin", name="Yazmin", pay_frequency=PayFrequency.MONTHLY, pay_days=[1]
        )
        paydays = household_paydays_in_month([jordan, yazmin], "2026-07")
        assert paydays == [date(2026, 7, 1)]

    def test_no_members_returns_empty(self):
        assert household_paydays_in_month([], "2026-07") == []


class TestSavingsAmountForPayPeriod:
    def test_splits_evenly_across_paydays(self):
        assert savings_amount_for_pay_period(600.0, 3) == pytest.approx(200.0)

    def test_zero_paydays_returns_full_amount(self):
        assert savings_amount_for_pay_period(600.0, 0) == pytest.approx(600.0)


class TestCurrentPayPeriodStart:
    def test_uses_most_recent_past_payday(self):
        jordan = Member(
            id="jordan", name="Jordan", pay_frequency=PayFrequency.SEMI_MONTHLY, pay_days=[1, 15]
        )
        assert current_pay_period_start([jordan], date(2026, 7, 20)) == date(2026, 7, 15)

    def test_falls_back_to_start_of_month_when_no_payday_yet(self):
        jordan = Member(
            id="jordan", name="Jordan", pay_frequency=PayFrequency.SEMI_MONTHLY, pay_days=[15, 28]
        )
        assert current_pay_period_start([jordan], date(2026, 7, 5)) == date(2026, 7, 1)

    def test_no_members_falls_back_to_start_of_month(self):
        assert current_pay_period_start([], date(2026, 7, 20)) == date(2026, 7, 1)


class TestSavingsDeposits:
    def test_deposited_for_month_sums_matching_dates(self):
        deposits = [
            SavingsDeposit(id="d1", date="2026-07-01", amount=100.0),
            SavingsDeposit(id="d2", date="2026-07-15", amount=50.0),
            SavingsDeposit(id="d3", date="2026-08-01", amount=999.0),
        ]
        assert savings_deposited_for_month(deposits, "2026-07") == pytest.approx(150.0)

    def test_deposited_between_filters_by_date_range(self):
        deposits = [
            SavingsDeposit(id="d1", date="2026-07-01", amount=100.0),
            SavingsDeposit(id="d2", date="2026-07-15", amount=50.0),
            SavingsDeposit(id="d3", date="2026-07-20", amount=25.0),
        ]
        total = savings_deposited_between(deposits, date(2026, 7, 15), date(2026, 7, 20))
        assert total == pytest.approx(75.0)

    def test_no_deposits_returns_zero(self):
        assert savings_deposited_for_month([], "2026-07") == pytest.approx(0.0)
        assert savings_deposited_between([], date(2026, 7, 1), date(2026, 7, 31)) == pytest.approx(
            0.0
        )


class TestCashInfusions:
    def test_contributions_total_sums_all_contributors(self):
        contributions = [
            Contribution(member_id="jordan", amount=600.0),
            Contribution(member_id="yazmin", amount=400.0),
        ]
        assert cash_infusion_contributions_total(contributions) == pytest.approx(1000.0)

    def test_matches_amount_true_for_single_contributor(self):
        contributions = [Contribution(member_id="jordan", amount=500.0)]
        assert cash_infusion_matches_amount(contributions, 500.0) is True

    def test_matches_amount_true_for_multiple_contributors(self):
        contributions = [
            Contribution(member_id="jordan", amount=300.0),
            Contribution(member_id="yazmin", amount=200.0),
        ]
        assert cash_infusion_matches_amount(contributions, 500.0) is True

    def test_matches_amount_false_when_short(self):
        contributions = [Contribution(member_id="jordan", amount=300.0)]
        assert cash_infusion_matches_amount(contributions, 500.0) is False

    def test_empty_contributions_always_matches(self):
        assert cash_infusion_matches_amount([], 500.0) is True

    def test_total_for_month_sums_matching_dates(self):
        infusions = [
            CashInfusion(id="i1", date="2026-07-04", amount=1000.0),
            CashInfusion(id="i2", date="2026-07-20", amount=200.0),
            CashInfusion(id="i3", date="2026-08-01", amount=999.0),
        ]
        assert cash_infusions_total_for_month(infusions, "2026-07") == pytest.approx(1200.0)

    def test_total_for_month_with_no_infusions_is_zero(self):
        assert cash_infusions_total_for_month([], "2026-07") == pytest.approx(0.0)
