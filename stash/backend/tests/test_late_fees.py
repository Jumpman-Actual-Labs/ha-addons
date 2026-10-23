from __future__ import annotations

import asyncio
from datetime import date
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
    bills_total_between,
    category_totals,
    household_summary,
    status_after_late_fee,
    validate_late_fee,
)
from stash_addon.models import Bill, Contribution, IncomeEntry, Member, Payment
from stash_addon.services import SCHEMAS, SERVICE_SET_BILL_LATE_FEE


def make_bill(**changes):
    fields = dict(
        id="b1",
        name="Internet",
        amount=100,
        category_id="utilities",
        due_date="2026-09-10",
        frequency=Frequency.MONTHLY,
        bill_type=BillType.FIXED,
        month="2026-09",
        late_fee=25,
    )
    return Bill(**(fields | changes))


def coordinator(bill):
    instance = object.__new__(FinanceCoordinator)
    instance.bills = [bill]
    instance.payments = []
    instance._async_save = AsyncMock()
    return instance


def test_storage_round_trip_and_old_data():
    bill = make_bill()
    restored = Bill.from_dict(bill.to_dict())
    assert restored.amount == 100
    assert restored.late_fee == 25
    assert restored.total_amount == 125
    legacy = bill.to_dict()
    del legacy["late_fee"]
    assert Bill.from_dict(legacy).total_amount == 100


@pytest.mark.parametrize("amount", [-1, float("nan"), float("inf"), -float("inf")])
def test_reject_invalid_fees(amount):
    with pytest.raises(ValueError):
        validate_late_fee(amount)


def test_fee_rounding_and_removal():
    assert validate_late_fee(12.346) == 12.35
    assert validate_late_fee(0) == 0


def test_totals_and_responsibility_include_fees():
    bill = make_bill()
    members = [Member(id="m", name="Member", income_history=[IncomeEntry("2026-09", 1000)])]
    assert household_summary([bill], members)["total_bills"] == 125
    assert category_totals([bill])["utilities"] == 125
    assert bills_total_between([bill], date(2026, 9, 1), date(2026, 10, 1)) == 125
    assert bill_responsibility(bill, members, ResponsibilityMethod.AUTOMATIC)["m"]["amount"] == 125


def test_partial_payment_and_deferral_status():
    bill = make_bill(due_date="2026-09-20")
    assert status_after_late_fee(bill, 100, date(2026, 9, 16)) == BillStatus.PARTIALLY_PAID
    assert status_after_late_fee(bill, 125, date(2026, 9, 16)) == BillStatus.PAID
    bill.status = BillStatus.DEFERRED
    assert status_after_late_fee(bill, 100, date(2026, 9, 16)) == BillStatus.DEFERRED
    assert status_after_late_fee(bill, 125, date(2026, 9, 16)) == BillStatus.PAID


def test_set_fee_is_idempotent_and_saves_without_altering_history():
    bill = make_bill(late_fee=0)
    instance = coordinator(bill)
    payment = Payment(
        id="p",
        bill_id="b1",
        date="2026-09-09",
        type=PaymentType.PARTIAL,
        contributions=[Contribution("m", 50)],
    )
    instance.payments = [payment]
    before = payment.to_dict()
    asyncio.run(instance.async_set_bill_late_fee("b1", 25))
    asyncio.run(instance.async_set_bill_late_fee("b1", 25))
    assert bill.total_amount == 125
    assert instance.payments[0].to_dict() == before
    assert instance._async_save.await_count == 2
    assert len(instance.bills) == 1


def test_cannot_change_paid_bill_or_mutate_on_invalid_fee():
    bill = make_bill(status=BillStatus.PAID)
    instance = coordinator(bill)
    with pytest.raises(ValueError):
        asyncio.run(instance.async_set_bill_late_fee("b1", 30))
    bill.status = BillStatus.UNPAID
    with pytest.raises(ValueError):
        asyncio.run(instance.async_set_bill_late_fee("b1", float("nan")))
    assert bill.late_fee == 25
    instance._async_save.assert_not_awaited()


def test_partial_payment_must_cover_fees_and_recurrence_resets_them():
    bill = make_bill()
    instance = coordinator(bill)
    asyncio.run(
        instance.async_mark_paid_partial("b1", [{"member_id": "m", "amount": 100}], "2026-09-16")
    )
    assert bill.status == BillStatus.PARTIALLY_PAID
    assert len(instance.bills) == 1
    asyncio.run(
        instance.async_mark_paid_partial("b1", [{"member_id": "m", "amount": 25}], "2026-09-16")
    )
    assert bill.status == BillStatus.PAID
    assert instance.bills[1].amount == 100
    assert instance.bills[1].late_fee == 0


def test_removing_fee_can_complete_partially_paid_bill():
    bill = make_bill(status=BillStatus.PARTIALLY_PAID)
    instance = coordinator(bill)
    instance.payments = [
        Payment(
            id="p",
            bill_id="b1",
            date="2026-09-09",
            type=PaymentType.PARTIAL,
            contributions=[Contribution("m", 100)],
        )
    ]
    asyncio.run(instance.async_set_bill_late_fee("b1", 0))
    assert bill.status == BillStatus.PAID
    assert len(instance.bills) == 2
    assert instance.bills[1].total_amount == 100


def test_service_contract():
    assert SCHEMAS[SERVICE_SET_BILL_LATE_FEE]({"bill_id": "b1", "amount": "25"}) == {
        "bill_id": "b1",
        "amount": 25.0,
    }
