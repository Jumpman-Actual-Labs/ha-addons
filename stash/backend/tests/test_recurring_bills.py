from __future__ import annotations

import asyncio
from datetime import date
from unittest.mock import AsyncMock

from stash_addon.const import BillStatus, BillType, Frequency
from stash_addon.coordinator import FinanceCoordinator
from stash_addon.models import Bill


def make_bill(**changes):
    fields = dict(
        id="rent",
        name="Rent",
        amount=2695,
        category_id="housing",
        due_date="2026-10-01",
        frequency=Frequency.MONTHLY,
        bill_type=BillType.FIXED,
        status=BillStatus.PAID,
        month="2026-10",
        recurring_parent_id=None,
    )
    return Bill(**(fields | changes))


def coordinator(bills, payments=None):
    instance = object.__new__(FinanceCoordinator)
    instance.bills = bills
    instance.payments = payments or []
    instance._async_save = AsyncMock()
    return instance


def test_paying_a_bill_generates_next_occurrence_even_with_same_day_siblings():
    # Rent and Internet are unrelated bills that both happen to be due the
    # 1st - neither has been regenerated before, so both start with
    # recurring_parent_id=None. Paying Rent must not be blocked by Internet
    # already sitting on the date Rent's next occurrence would land on.
    rent = make_bill()
    internet = Bill(
        id="internet",
        name="Internet",
        amount=84.17,
        category_id="utilities",
        due_date="2026-11-01",
        frequency=Frequency.MONTHLY,
        bill_type=BillType.FIXED,
        status=BillStatus.UNPAID,
        month="2026-11",
        recurring_parent_id=None,
    )
    instance = coordinator([rent, internet])

    asyncio.run(instance._maybe_generate_recurring(rent))

    generated = [b for b in instance.bills if b.id not in ("rent", "internet")]
    assert len(generated) == 1
    assert generated[0].due_date == "2026-11-01"
    assert generated[0].recurring_parent_id == "rent"
    assert generated[0].name == "Rent"


def test_does_not_duplicate_an_already_generated_next_occurrence():
    rent = make_bill()
    next_rent = make_bill(id="rent-2", due_date="2026-11-01", status=BillStatus.UNPAID,
                           recurring_parent_id="rent")
    instance = coordinator([rent, next_rent])

    asyncio.run(instance._maybe_generate_recurring(rent))

    assert len(instance.bills) == 2


def test_ensure_recurring_bills_catches_up_unpaid_overdue_bills():
    # Unpaid since June - three monthly cycles behind today (September).
    overdue_rent = make_bill(status=BillStatus.OVERDUE, due_date="2026-06-01", month="2026-06")
    instance = coordinator([overdue_rent])

    changed = asyncio.run(instance.async_ensure_recurring_bills(today=date(2026, 9, 24)))

    assert changed is True
    due_dates = sorted(b.due_date for b in instance.bills)
    # Catches all the way up to the occurrence still in the future (Sept 1
    # is also < the Sept 24 "today" used here, so it keeps going to Oct 1).
    assert due_dates == [
        "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01",
    ]
    instance._async_save.assert_called()


def test_ensure_recurring_bills_skips_one_time_and_future_bills():
    one_time = make_bill(
        id="onetime", frequency=Frequency.ONE_TIME, status=BillStatus.UNPAID, due_date="2020-01-01"
    )
    future = make_bill(id="future", status=BillStatus.UNPAID, due_date="2099-01-01")
    instance = coordinator([one_time, future])

    changed = asyncio.run(instance.async_ensure_recurring_bills(today=date(2026, 9, 24)))

    assert changed is False
    assert len(instance.bills) == 2


def test_next_occurrence_keeps_the_payee():
    power = make_bill(id="power", name="Power", pay_to="Duke Energy")
    instance = coordinator([power])

    asyncio.run(instance._maybe_generate_recurring(power))

    assert instance.bills[-1].pay_to == "Duke Energy"
