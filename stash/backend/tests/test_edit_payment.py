from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from stash_addon.const import BillStatus, BillType, Frequency, PaymentType
from stash_addon.coordinator import FinanceCoordinator
from stash_addon.models import Bill, Contribution, Payment


def make_bill(**changes):
    fields = dict(
        id="rent",
        name="Rent",
        amount=1000,
        category_id="housing",
        due_date="2099-01-01",  # far future, so status math stays simple
        frequency=Frequency.MONTHLY,
        bill_type=BillType.FIXED,
        status=BillStatus.PAID,
        month="2099-01",
    )
    return Bill(**(fields | changes))


def coordinator(bills, payments):
    instance = object.__new__(FinanceCoordinator)
    instance.bills = bills
    instance.payments = payments
    instance._async_save = AsyncMock()
    return instance


def test_edit_payment_date_and_notes():
    payment = Payment(id="p1", bill_id="rent", date="2099-01-01", type=PaymentType.NORMAL)
    instance = coordinator([make_bill()], [payment])

    asyncio.run(
        instance.async_edit_payment("p1", payment_date="2099-01-02", notes="oops, wrong day")
    )

    assert payment.date == "2099-01-02"
    assert payment.notes == "oops, wrong day"
    instance._async_save.assert_called()


def test_edit_payment_rejects_contributions_on_normal_payment():
    payment = Payment(id="p1", bill_id="rent", date="2099-01-01", type=PaymentType.NORMAL)
    instance = coordinator([make_bill()], [payment])

    with pytest.raises(ValueError):
        asyncio.run(
            instance.async_edit_payment(
                "p1", contributions=[{"member_id": "a", "amount": 1000}]
            )
        )


def test_editing_contributions_recomputes_bill_status():
    payment = Payment(
        id="p1",
        bill_id="rent",
        date="2099-01-01",
        type=PaymentType.INDIVIDUAL,
        contributions=[Contribution(member_id="a", amount=1000)],
    )
    bill = make_bill(status=BillStatus.PAID)
    instance = coordinator([bill], [payment])

    # Correcting the amount down to a partial payment should drop the bill
    # out of PAID.
    asyncio.run(
        instance.async_edit_payment("p1", contributions=[{"member_id": "a", "amount": 400}])
    )
    assert bill.status == BillStatus.PARTIALLY_PAID

    # Correcting it back up to the full amount should restore PAID.
    asyncio.run(
        instance.async_edit_payment("p1", contributions=[{"member_id": "a", "amount": 1000}])
    )
    assert bill.status == BillStatus.PAID


def test_edit_payment_unknown_id_raises():
    instance = coordinator([make_bill()], [])
    with pytest.raises(ValueError):
        asyncio.run(instance.async_edit_payment("missing", notes="x"))


def test_delete_payment_removes_it_and_recomputes_status():
    payment = Payment(id="p1", bill_id="rent", date="2099-01-01", type=PaymentType.NORMAL)
    bill = make_bill(status=BillStatus.PAID)
    instance = coordinator([bill], [payment])

    asyncio.run(instance.async_delete_payment("p1"))

    assert instance.payments == []
    assert bill.status == BillStatus.UNPAID
    instance._async_save.assert_called()


def test_delete_payment_leaves_other_payments_on_the_bill_intact():
    p1 = Payment(
        id="p1", bill_id="rent", date="2099-01-01", type=PaymentType.PARTIAL,
        contributions=[Contribution(member_id="a", amount=400)],
    )
    p2 = Payment(
        id="p2", bill_id="rent", date="2099-01-02", type=PaymentType.PARTIAL,
        contributions=[Contribution(member_id="a", amount=600)],
    )
    bill = make_bill(status=BillStatus.PAID)
    instance = coordinator([bill], [p1, p2])

    asyncio.run(instance.async_delete_payment("p2"))

    assert instance.payments == [p1]
    assert bill.status == BillStatus.PARTIALLY_PAID


def test_delete_payment_unknown_id_raises():
    instance = coordinator([make_bill()], [])
    with pytest.raises(ValueError):
        asyncio.run(instance.async_delete_payment("missing"))
