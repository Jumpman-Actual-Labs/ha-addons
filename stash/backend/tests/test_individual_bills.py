from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from stash_addon.const import (
    BillStatus,
    BillType,
    Frequency,
    PaymentType,
    ResponsibilityMethod,
)
from stash_addon.coordinator import FinanceCoordinator
from stash_addon.logic import (
    bill_responsibility,
    bill_responsibility_totals,
    compute_settlement,
    contributed_totals,
)
from stash_addon.models import Bill, Contribution, IncomeEntry, Member, Payment
from stash_addon.services import SCHEMAS, SERVICE_ADD_BILL, SERVICE_EDIT_BILL


def members():
    return [
        Member(id="a", name="Jordan", income_history=[IncomeEntry("2026-09", 6000)]),
        Member(id="b", name="Alex", income_history=[IncomeEntry("2026-09", 4000)]),
    ]


def bill(**changes):
    return Bill(
        **(
            dict(
                id="personal",
                name="Car",
                amount=100,
                late_fee=25,
                category_id="cars",
                due_date="2026-09-20",
                frequency=Frequency.MONTHLY,
                bill_type=BillType.FIXED,
                month="2026-09",
                responsible_member_id="a",
            )
            | changes
        )
    )


def coordinator():
    c = object.__new__(FinanceCoordinator)
    c.members = members()
    c.bills = [bill()]
    c.payments = []
    c._async_save = AsyncMock()
    return c


@pytest.mark.parametrize("method", list(ResponsibilityMethod))
def test_owner_overrides_shared_and_manual_percentages(method):
    personal = bill(manual_responsibility={"a": 10, "b": 90})
    shares = bill_responsibility(personal, members(), method)
    assert shares["a"] == {"pct": 100, "amount": 125}
    assert shares["b"] == {"pct": 0, "amount": 0}
    totals = bill_responsibility_totals(
        [personal, bill(id="shared", responsible_member_id=None)],
        members(),
        ResponsibilityMethod.AUTOMATIC,
    )
    assert totals == {"a": 200, "b": 50}


@pytest.mark.parametrize(
    "payment_type", [PaymentType.INDIVIDUAL, PaymentType.PARTIAL, PaymentType.NORMAL]
)
def test_personal_payments_never_create_household_debt(payment_type):
    contributions = [] if payment_type == PaymentType.NORMAL else [Contribution("a", 40)]
    p = Payment("p", "personal", "2026-09-22", payment_type, contributions)
    settlement = compute_settlement(
        "2026-09", [bill()], [p], members(), ResponsibilityMethod.AUTOMATIC
    )
    assert all(
        m.difference == 0 and m.responsible == 0 and m.paid == 0 for m in settlement.member_balances
    )
    assert contributed_totals("2026-09", [p]).get("a", 0) == (40 if contributions else 0)


def test_shared_reimbursement_unchanged_and_personal_payment_isolated():
    shared = bill(id="shared", responsible_member_id=None, amount=100, late_fee=0)
    payments = [
        Payment("s", "shared", "2026-09-22", PaymentType.INDIVIDUAL, [Contribution("a", 100)]),
        Payment("p", "personal", "2026-09-22", PaymentType.INDIVIDUAL, [Contribution("a", 125)]),
    ]
    settlement = compute_settlement(
        "2026-09", [bill(), shared], payments, members(), ResponsibilityMethod.AUTOMATIC
    )
    assert {m.member_id: m.difference for m in settlement.member_balances} == {"a": 40, "b": -40}
    assert contributed_totals("2026-09", payments) == {"a": 225}


def test_legacy_storage_and_deleted_owner_do_not_redistribute_personal_bills():
    saved = bill().to_dict()
    assert Bill.from_dict(saved).responsible_member_id == "a"
    del saved["responsible_member_id"]
    assert Bill.from_dict(saved).responsible_member_id is None
    assert (
        bill_responsibility(bill(), [members()[1]], ResponsibilityMethod.AUTOMATIC)["b"]["amount"]
        == 0
    )


def test_owner_edit_clear_validation_and_recurring_inheritance():
    async def run():
        c = coordinator()
        original = Payment(
            "p", "personal", "2026-09-22", PaymentType.INDIVIDUAL, [Contribution("a", 125)]
        )
        c.payments.append(original)
        await c.async_edit_bill("personal", responsible_member_id="b")
        assert c.bills[0].responsible_member_id == "b"
        with pytest.raises(ValueError):
            await c.async_edit_bill("personal", responsible_member_id="unknown")
        assert c.bills[0].responsible_member_id == "b"
        assert c.payments == [original]
        c.bills[0].status = BillStatus.PAID
        await c._maybe_generate_recurring(c.bills[0])
        assert c.bills[1].responsible_member_id == "b"
        assert c.bills[1].late_fee == 0
        await c.async_edit_bill("personal", responsible_member_id="")
        assert c.bills[0].responsible_member_id is None
        before = len(c.bills)
        with pytest.raises(ValueError):
            await c.async_add_bill(
                "Invalid",
                10,
                "cars",
                "2026-09-20",
                Frequency.MONTHLY,
                BillType.FIXED,
                responsible_member_id="unknown",
            )
        assert len(c.bills) == before

    asyncio.run(run())


def test_service_owner_field_and_explicit_shared_reset():
    assert (
        SCHEMAS[SERVICE_EDIT_BILL]({"bill_id": "personal", "responsible_member_id": ""})[
            "responsible_member_id"
        ]
        == ""
    )
    data = {
        "name": "Car",
        "amount": 100,
        "category_id": "cars",
        "due_date": "2026-09-20",
        "frequency": "monthly",
        "bill_type": "fixed",
        "responsible_member_id": "a",
    }
    assert SCHEMAS[SERVICE_ADD_BILL](data)["responsible_member_id"] == "a"
