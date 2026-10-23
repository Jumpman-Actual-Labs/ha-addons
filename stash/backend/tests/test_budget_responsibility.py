from __future__ import annotations

from datetime import date
from unittest.mock import Mock

import pytest

from stash_addon.const import BillStatus, BillType, Frequency, ResponsibilityMethod
from stash_addon.coordinator import FinanceCoordinator
from stash_addon.logic import budget_responsibility_totals
from stash_addon.models import (
    Bill,
    CashInfusion,
    Category,
    CategoryExpense,
    IncomeEntry,
    Member,
)
from stash_addon.states import member_attributes


def members():
    return [
        Member("a", "A", income_history=[IncomeEntry("2026-10", 600)]),
        Member("b", "B", income_history=[IncomeEntry("2026-10", 400)]),
    ]


def bill(**changes):
    return Bill(
        **(
            dict(
                id="bill",
                name="Bill",
                amount=100,
                category_id="home",
                due_date="2026-10-01",
                month="2026-10",
                frequency=Frequency.MONTHLY,
                bill_type=BillType.FIXED,
            )
            | changes
        )
    )


def expense(amount=50, category_id="home"):
    return CategoryExpense("e", category_id, "Shopping", amount, "2026-10-02", month="2026-10")


def test_budget_without_bills_and_no_double_counting_actuals():
    categories = [
        Category("home", "Home", planned_budget=300),
        Category("food", "Food", planned_budget=200),
    ]
    assert budget_responsibility_totals(
        [bill()], [expense()], categories, members(), ResponsibilityMethod.AUTOMATIC
    ) == {"a": 300, "b": 200}
    # Overspending and expenses in an unbudgeted/deleted category are still covered.
    assert budget_responsibility_totals(
        [bill()],
        [expense(250), expense(50, "deleted")],
        categories,
        members(),
        ResponsibilityMethod.AUTOMATIC,
    ) == {"a": 360, "b": 240}


@pytest.mark.parametrize("status", [BillStatus.PAID, BillStatus.UNPAID, BillStatus.DEFERRED])
def test_personal_and_manual_bill_shares_preserved_with_budget_remainder(status):
    bills = [
        bill(responsible_member_id="b", late_fee=20, status=status),
        bill(id="manual", manual_responsibility={"a": 20, "b": 80}),
    ]
    assert budget_responsibility_totals(
        bills,
        [],
        [Category("home", "Home", planned_budget=320)],
        members(),
        ResponsibilityMethod.MANUAL,
    ) == {"a": 80, "b": 240}


@pytest.mark.parametrize("planned", [0, 300])
def test_excluded_repayment_does_not_reappear_as_shared_budget(planned):
    bills = [bill(id="loan", amount=200, responsible_member_id="b"), bill()]
    assert budget_responsibility_totals(
        bills,
        [expense()],
        [Category("home", "Home", planned_budget=planned)],
        members(),
        ResponsibilityMethod.AUTOMATIC,
        excluded_bill_ids={"loan"},
    ) == {"a": 90, "b": 60}


def test_zero_income_and_empty_members():
    categories = [Category("home", "Home", planned_budget=100)]
    assert budget_responsibility_totals(
        [], [], categories, [Member("a", "A"), Member("b", "B")], ResponsibilityMethod.AUTOMATIC
    ) == {"a": 50, "b": 50}
    assert (
        budget_responsibility_totals([], [], categories, [], ResponsibilityMethod.AUTOMATIC) == {}
    )


def test_coordinator_filters_month_and_member_state_exposes_additive_contract():
    c = FinanceCoordinator(Mock())
    month = date.today().strftime("%Y-%m")
    c.members = members()
    c.categories = [Category("home", "Home", planned_budget=300)]
    c.bills = [
        bill(month=month),
        bill(id="loan", amount=100, month=month),
        bill(id="old", amount=900, month="2000-01"),
    ]
    c.category_expenses = [expense(900)]
    c.category_expenses[0].month = "2000-01"
    c.cash_infusions = [
        CashInfusion("loan", date.today().isoformat(), 100, repayment_bill_id="loan")
    ]
    c.data = c._build_public_data()
    attrs = member_attributes(c.data, c.members[0])
    assert attrs["responsible_amount"] == 120
    assert attrs["responsible_amount_excluding_repayments"] == 60
    assert attrs["budget_responsible_amount"] == 180
    assert attrs["budget_responsible_amount_excluding_repayments"] == 120
