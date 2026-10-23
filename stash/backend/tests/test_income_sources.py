from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from stash_addon.const import PayFrequency
from stash_addon.coordinator import FinanceCoordinator
from stash_addon.models import IncomeEntry, IncomeSource, Member


def make_member(**changes):
    fields = dict(id="jordan", name="Jordan")
    return Member(**(fields | changes))


def coordinator(members):
    instance = object.__new__(FinanceCoordinator)
    instance.members = members
    instance._async_save = AsyncMock()
    return instance


def test_current_income_falls_back_to_history_when_no_sources():
    member = make_member(income_history=[IncomeEntry(month="2026-08", amount=1000)])
    assert member.current_income() == 1000


def test_current_income_sums_sources_when_present():
    member = make_member(
        income_history=[IncomeEntry(month="2026-08", amount=1000)],
        income_sources=[
            IncomeSource(id="a", name="Main job", amount=3000),
            IncomeSource(id="b", name="Side gig", amount=450.5),
        ],
    )
    # Sources take priority over the legacy single-figure history once set.
    assert member.current_income() == 3450.5


def test_member_to_dict_from_dict_round_trip_keeps_sources():
    member = make_member(
        income_sources=[
            IncomeSource(id="a", name="Main job", amount=3000, pay_frequency=PayFrequency.BIWEEKLY)
        ]
    )
    restored = Member.from_dict(member.to_dict())
    assert restored.income_sources == [
        IncomeSource(id="a", name="Main job", amount=3000, pay_frequency=PayFrequency.BIWEEKLY)
    ]
    assert restored.current_income() == 3000


def test_income_source_defaults_to_monthly_pay_frequency():
    source = IncomeSource(id="a", name="Main job", amount=3000)
    assert source.pay_frequency == PayFrequency.MONTHLY


def test_income_source_from_dict_without_pay_frequency_key_defaults_to_monthly():
    source = IncomeSource.from_dict({"id": "a", "name": "Main job", "amount": 3000})
    assert source.pay_frequency == PayFrequency.MONTHLY


def test_old_data_without_income_sources_key_still_loads():
    legacy = make_member(income_history=[IncomeEntry(month="2026-08", amount=1000)]).to_dict()
    del legacy["income_sources"]
    restored = Member.from_dict(legacy)
    assert restored.income_sources == []
    assert restored.current_income() == 1000


def test_add_income_source():
    member = make_member()
    instance = coordinator([member])

    source = asyncio.run(instance.async_add_income_source("jordan", "Main job", 3000))

    assert source.name == "Main job"
    assert source.amount == 3000
    assert source.pay_frequency == PayFrequency.MONTHLY
    assert member.income_sources == [source]
    instance._async_save.assert_called()


def test_add_income_source_with_pay_frequency():
    member = make_member()
    instance = coordinator([member])

    source = asyncio.run(
        instance.async_add_income_source("jordan", "Side gig", 450, PayFrequency.BIWEEKLY)
    )

    assert source.pay_frequency == PayFrequency.BIWEEKLY


def test_add_income_source_with_schedule():
    member = make_member()
    instance = coordinator([member])

    source = asyncio.run(
        instance.async_add_income_source(
            "jordan", "Side gig", 450, PayFrequency.BIWEEKLY, pay_anchor_date="2026-06-19"
        )
    )

    assert source.pay_anchor_date == "2026-06-19"

    source2 = asyncio.run(
        instance.async_add_income_source(
            "jordan", "VA Comp", 2900, PayFrequency.SEMI_MONTHLY, pay_days=[1, 15]
        )
    )

    assert source2.pay_days == [1, 15]


def test_edit_income_source():
    member = make_member(income_sources=[IncomeSource(id="a", name="Main job", amount=3000)])
    instance = coordinator([member])

    asyncio.run(instance.async_edit_income_source("jordan", "a", amount=3200))

    assert member.income_sources[0].amount == 3200
    assert member.income_sources[0].name == "Main job"  # untouched fields stay as-is


def test_edit_income_source_pay_frequency_converts_to_enum():
    member = make_member(income_sources=[IncomeSource(id="a", name="Main job", amount=3000)])
    instance = coordinator([member])

    asyncio.run(instance.async_edit_income_source("jordan", "a", pay_frequency="biweekly"))

    assert member.income_sources[0].pay_frequency == PayFrequency.BIWEEKLY


def test_edit_income_source_updates_schedule():
    member = make_member(
        income_sources=[
            IncomeSource(id="a", name="Side gig", amount=900, pay_frequency=PayFrequency.BIWEEKLY)
        ]
    )
    instance = coordinator([member])

    asyncio.run(
        instance.async_edit_income_source("jordan", "a", pay_anchor_date="2026-06-19")
    )

    assert member.income_sources[0].pay_anchor_date == "2026-06-19"


def test_edit_income_source_unknown_id_raises():
    member = make_member(income_sources=[IncomeSource(id="a", name="Main job", amount=3000)])
    instance = coordinator([member])
    with pytest.raises(ValueError):
        asyncio.run(instance.async_edit_income_source("jordan", "missing", amount=1))


def test_delete_income_source():
    member = make_member(
        income_sources=[
            IncomeSource(id="a", name="Main job", amount=3000),
            IncomeSource(id="b", name="Side gig", amount=450),
        ]
    )
    instance = coordinator([member])

    asyncio.run(instance.async_delete_income_source("jordan", "a"))

    assert [s.id for s in member.income_sources] == ["b"]


def test_delete_income_source_unknown_id_raises():
    member = make_member(income_sources=[IncomeSource(id="a", name="Main job", amount=3000)])
    instance = coordinator([member])
    with pytest.raises(ValueError):
        asyncio.run(instance.async_delete_income_source("jordan", "missing"))
