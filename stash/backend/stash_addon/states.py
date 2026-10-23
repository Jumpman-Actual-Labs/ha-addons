"""The panel's read model - a `hass.states`-shaped snapshot of the household.

Under the integration, the panel read everything from the sensor entities'
attributes (scanning `hass.states` for the `finance_key`/`member_id`/
`bill_id`/`category_id` marker attributes - see the frontend's ha-api.ts).
These functions build exactly those same entity payloads straight from the
coordinator's public data, so the frontend's whole parsing layer carries
over unchanged: web.py serves the result at `api/states` and pushes a fresh
one over `api/websocket` on every change.

Each function here corresponds 1:1 to a sensor class in the integration's
old sensor.py - keep their attribute shapes in sync with what ha-api.ts
parses. Entity ids don't matter to the panel (it never looks them up by
id), so they're keyed by record id rather than the slugified names Home
Assistant generated.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from .logic import is_payment_late, next_pay_dates, next_pay_dates_for_source
from .models import Bill, Category, IncomeSource, Member

Entity = dict[str, Any]
Data = dict[str, Any]


def _entity(entity_id: str, state: Any, attributes: dict[str, Any]) -> Entity:
    # Home Assistant always stringifies state (None becomes "unknown") -
    # ha-api.ts parses state with that in mind, so mirror it.
    return {
        "entity_id": entity_id,
        "state": "unknown" if state is None else str(state),
        "attributes": attributes,
    }


def income_source_attrs(source: IncomeSource) -> dict[str, Any]:
    upcoming = next_pay_dates_for_source(source, date.today(), count=1)
    return {
        "id": source.id,
        "name": source.name,
        "amount": round(source.amount, 2),
        "pay_frequency": source.pay_frequency.value,
        "pay_days": source.pay_days,
        "pay_anchor_date": source.pay_anchor_date,
        "next_pay_date": upcoming[0].isoformat() if upcoming else None,
    }


# --------------------------------------------------------------- fixed sensors


def summary_value(data: Data, key: str) -> Entity:
    return _entity(
        f"sensor.stash_{key}", round(data["summary"][key], 2), {"finance_key": key}
    )


def count(data: Data, key: str) -> Entity:
    attrs: dict[str, Any] = {"finance_key": key}
    if key == "upcoming_this_pay_period":
        attrs["next_payday"] = data.get("next_payday")
        attrs["payday_after_next"] = data.get("payday_after_next")
        attrs["next_period_bills_total"] = round(data.get("next_period_bills_total", 0.0), 2)
    return _entity(f"sensor.stash_{key}", len(data[key]), attrs)


def mode(data: Data) -> Entity:
    return _entity(
        "sensor.stash_finance_mode",
        data["mode"],
        {"finance_key": "mode", "responsibility_method": data["responsibility_method"]},
    )


def savings(data: Data) -> Entity:
    return _entity(
        "sensor.stash_savings",
        round(data["savings_amount"], 2),
        {
            "finance_key": "savings",
            "savings_type": data["savings_type"],
            "savings_value": data["savings_value"],
            "savings_goal_amount": round(data["savings_goal_amount"], 2),
            "savings_plan_contributions": round(data["savings_plan_contributions"], 2),
            "savings_per_period": round(data["savings_per_period"], 2),
            "savings_deposited_month": round(data["savings_deposited_month"], 2),
            "savings_deposited_period": round(data["savings_deposited_period"], 2),
            "breakdown": {
                member_id: {"pct": round(v["pct"], 2), "amount": round(v["amount"], 2)}
                for member_id, v in data["savings_breakdown"].items()
            },
        },
    )


def cash_infusions(data: Data) -> Entity:
    return _entity(
        "sensor.stash_cash_infusions",
        round(data["cash_infusions_total_month"], 2),
        {
            "finance_key": "cash_infusions",
            "infusions": [
                {
                    "id": infusion.id,
                    "date": infusion.date,
                    "amount": round(infusion.amount, 2),
                    "source": infusion.source,
                    "contributions": [
                        {"member_id": c.member_id, "amount": round(c.amount, 2)}
                        for c in infusion.contributions
                    ],
                    "repayment_bill_id": infusion.repayment_bill_id,
                }
                for infusion in data["cash_infusions"]
            ],
        },
    )


# ------------------------------------------------------------ dynamic sensors


def member_attributes(data: Data, member: Member) -> dict[str, Any]:
    settlement = data["settlement"]
    balance = next((b for b in settlement.member_balances if b.member_id == member.id), None)
    automatic_pcts: dict[str, float] = {}
    if data["members"]:
        total_income = sum(m.current_income() for m in data["members"])
        if total_income > 0:
            automatic_pcts = {
                m.id: (m.current_income() / total_income) * 100.0 for m in data["members"]
            }
    upcoming = next_pay_dates(member, date.today(), count=1)
    return {
        "member_id": member.id,
        "name": member.name,
        "notes": member.notes,
        "income": member.current_income(),
        "income_sources": [income_source_attrs(s) for s in member.income_sources],
        "responsibility_pct": round(automatic_pcts.get(member.id, 0.0), 2),
        "budget_responsible_amount": round(
            data["budget_responsibility_totals"].get(member.id, 0.0), 2
        ),
        "budget_responsible_amount_excluding_repayments": round(
            data["budget_responsibility_totals_excluding_repayments"].get(member.id, 0.0), 2
        ),
        "responsible_amount": round(data["responsibility_totals"].get(member.id, 0.0), 2),
        "responsible_amount_excluding_repayments": round(
            data["responsibility_totals_excluding_repayments"].get(member.id, 0.0), 2
        ),
        "actually_paid": round(data["contributed_totals"].get(member.id, 0.0), 2),
        "settlement_balance": round(balance.difference, 2) if balance else 0.0,
        "pay_frequency": member.pay_frequency.value,
        "pay_days": member.pay_days,
        "pay_anchor_date": member.pay_anchor_date,
        "next_pay_date": upcoming[0].isoformat() if upcoming else None,
        "ha_user_id": member.ha_user_id,
    }


def member(data: Data, m: Member) -> Entity:
    return _entity(
        f"sensor.stash_member_{m.id}", round(m.current_income(), 2), member_attributes(data, m)
    )


def category_attributes(data: Data, category: Category) -> dict[str, Any]:
    recommendation_info = data["category_recommendations"].get(category.id, {})
    return {
        "category_id": category.id,
        "name": category.name,
        "planned_budget": round(category.planned_budget, 2),
        "budget_recommendation": recommendation_info.get("recommendation", "maintain"),
        "historical_average_spend": recommendation_info.get("historical_average_spend", 0.0),
        "last_month_spend": recommendation_info.get("last_month_spend", 0.0),
        "expenses": [
            {
                "id": expense.id,
                "name": expense.name,
                "amount": round(expense.amount, 2),
                "date": expense.date,
                "notes": expense.notes,
            }
            for expense in data["category_expenses"]
            if expense.category_id == category.id
        ],
    }


def category(data: Data, c: Category) -> Entity:
    return _entity(
        f"sensor.stash_category_{c.id}",
        round(data["category_totals"].get(c.id, 0.0), 2),
        category_attributes(data, c),
    )


def bill(data: Data, b: Bill) -> Entity:
    # The integration's sensor asked the coordinator for these three; the
    # coordinator publishes them per bill in its public data instead so this
    # stays a pure function of `data`.
    plan = data["savings_plans_by_bill"].get(b.id)
    proposed = data["proposed_savings_plans_by_bill"].get(b.id, [])
    responsibility = data["responsibility_by_bill"].get(b.id, {})
    bill_payments = sorted((p for p in data["payments"] if p.bill_id == b.id), key=lambda p: p.date)
    return _entity(
        f"sensor.stash_bill_{b.id}",
        b.status.value,
        {
            "bill_id": b.id,
            "name": b.name,
            "amount": round(b.total_amount, 2),
            "base_amount": round(b.amount, 2),
            "late_fee": round(b.late_fee, 2),
            "responsible_member_id": b.responsible_member_id,
            "due_date": b.due_date,
            "responsibility": {
                member_id: round(breakdown["amount"], 2)
                for member_id, breakdown in responsibility.items()
            },
            "payments": [
                {
                    "id": p.id,
                    "date": p.date,
                    "type": p.type.value,
                    "notes": p.notes,
                    # Normal payments have no per-member contribution breakdown -
                    # they cover the bill's full amount by definition.
                    "total": round(p.total, 2) if p.contributions else round(b.total_amount, 2),
                    "contributions": [
                        {"member_id": c.member_id, "amount": round(c.amount, 2)}
                        for c in p.contributions
                    ],
                    "is_late": is_payment_late(b.due_date, p.date),
                }
                for p in bill_payments
            ],
            # Named bill_category_id (not category_id) deliberately: the frontend
            # discovers category entities by "which sensors have a category_id
            # attribute", and this is a foreign-key reference, not a category's
            # own identity - reusing the same key name previously made every
            # bill sensor look like a category too.
            "bill_category_id": b.category_id,
            "frequency": b.frequency.value,
            "bill_type": b.bill_type.value,
            "month": b.month,
            "notes": b.notes,
            "pay_to": b.pay_to,
            "deferred_until": b.deferred_until,
            "recurring_parent_id": b.recurring_parent_id,
            "savings_plan": [e.to_dict() for e in plan.entries] if plan else [],
            "proposed_savings_plan": [e.to_dict() for e in proposed],
        },
    )


# ------------------------------------------------------------------- snapshot

SUMMARY_KEYS = ("total_income", "total_bills", "paid", "remaining", "cash_remaining")
COUNT_KEYS = ("upcoming_this_pay_period", "overdue", "deferred")


def build_states(data: Data) -> dict[str, Entity]:
    """Every entity the panel reads, keyed by entity_id like `hass.states`.
    A deleted member/category/bill simply isn't in here any more - so the
    integration's orphaned-entity cleanup has no counterpart."""
    if not data:
        return {}
    entities = [summary_value(data, k) for k in SUMMARY_KEYS]
    entities += [count(data, k) for k in COUNT_KEYS]
    entities += [mode(data), savings(data), cash_infusions(data)]
    entities += [member(data, m) for m in data["members"]]
    entities += [category(data, c) for c in data["categories"]]
    entities += [bill(data, b) for b in data["bills"]]
    return {e["entity_id"]: e for e in entities}
