"""Pure business logic for the Finance integration.

Deliberately free of any Home Assistant imports so it can be unit tested
in plain pytest, without the HA test harness.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from .const import BillStatus, Frequency, PayFrequency, ResponsibilityMethod, SavingsType
from .models import (
    Bill,
    CashInfusion,
    Category,
    CategoryExpense,
    Contribution,
    IncomeSource,
    Member,
    MemberSettlement,
    Payment,
    SavingsDeposit,
    SavingsPlan,
    SavingsPlanEntry,
    Settlement,
)


def add_months(d: date, months: int) -> date:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def next_due_date(due_date: date, frequency: Frequency) -> date | None:
    if frequency == Frequency.WEEKLY:
        return due_date + timedelta(days=7)
    if frequency == Frequency.BIWEEKLY:
        return due_date + timedelta(days=14)
    if frequency == Frequency.MONTHLY:
        return add_months(due_date, 1)
    if frequency == Frequency.QUARTERLY:
        return add_months(due_date, 3)
    if frequency == Frequency.YEARLY:
        return add_months(due_date, 12)
    return None  # ONE_TIME bills never recur


def automatic_percentages(members: list[Member]) -> dict[str, float]:
    """Responsibility % for each member, proportional to current income."""
    total_income = sum(m.current_income() for m in members)
    if total_income <= 0:
        if not members:
            return {}
        equal_share = 100.0 / len(members)
        return {m.id: equal_share for m in members}
    return {m.id: (m.current_income() / total_income) * 100.0 for m in members}


def bill_responsibility(
    bill: Bill,
    members: list[Member],
    responsibility_method: ResponsibilityMethod,
) -> dict[str, dict[str, float]]:
    """Return {member_id: {"pct": x, "amount": y}} for a single bill."""
    if bill.responsible_member_id:
        # Personal bills never enter the household percentage split, even
        # when the owner was removed from the current member roster.
        pct_by_member = {m.id: 0.0 for m in members}
        pct_by_member[bill.responsible_member_id] = 100.0
    elif responsibility_method == ResponsibilityMethod.MANUAL and bill.manual_responsibility:
        pct_by_member = bill.manual_responsibility
    else:
        pct_by_member = automatic_percentages(members)

    return {
        member_id: {"pct": pct, "amount": bill.total_amount * pct / 100.0}
        for member_id, pct in pct_by_member.items()
    }


def bill_responsibility_totals(
    bills: list[Bill], members: list[Member], responsibility_method: ResponsibilityMethod
) -> dict[str, float]:
    """Each member's ongoing share of every given bill (e.g. the current month's).

    This is a pure budget view - "what you're on the hook for" - and
    deliberately includes bills regardless of payment status or method.
    Contrast with compute_settlement's "responsible" figure, which only
    counts bills that have actually been split via individual/partial
    payments, since that one answers a different question ("who owes whom
    right now"). Use this one anywhere the UI shows "your share of bills."
    """
    totals: dict[str, float] = {m.id: 0.0 for m in members}
    for bill in bills:
        for member_id, breakdown in bill_responsibility(
            bill, members, responsibility_method
        ).items():
            totals[member_id] = totals.get(member_id, 0.0) + breakdown["amount"]
    return {member_id: round(total, 2) for member_id, total in totals.items()}


def budget_responsibility_totals(
    bills: list[Bill],
    expenses: list[CategoryExpense],
    categories: list[Category],
    members: list[Member],
    responsibility_method: ResponsibilityMethod,
    excluded_bill_ids: set[str] | None = None,
) -> dict[str, float]:
    """Allocate a month's category budgets without counting their bills twice.

    Existing bill ownership and manual splits take precedence. The remaining
    category allocation is shared by income, including categories with no bills.
    Actual bills plus non-bill spending form a floor when they exceed the plan.
    Excluded repayments consume their part of the plan but add no responsibility,
    so removing a loan cannot silently redistribute it to the household.
    Callers supply bills and expenses filtered to the same month.
    """
    excluded = excluded_bill_ids or set()
    totals = {m.id: 0.0 for m in members}
    bill_totals: dict[str, float] = {}
    for bill in bills:
        bill_totals[bill.category_id] = (
            bill_totals.get(bill.category_id, 0.0) + bill.total_amount
        )
        if bill.id in excluded:
            continue
        for member_id, share in bill_responsibility(
            bill, members, responsibility_method
        ).items():
            totals[member_id] = totals.get(member_id, 0.0) + share["amount"]

    expense_totals: dict[str, float] = {}
    for expense in expenses:
        expense_totals[expense.category_id] = (
            expense_totals.get(expense.category_id, 0.0) + expense.amount
        )
    planned = {c.id: c.planned_budget for c in categories}
    shared_remainder = sum(
        max(planned.get(category_id, 0.0) - bill_totals.get(category_id, 0.0),
            expense_totals.get(category_id, 0.0), 0.0)
        for category_id in planned.keys() | expense_totals.keys()
    )
    for member_id, pct in automatic_percentages(members).items():
        totals[member_id] += shared_remainder * pct / 100.0
    return {member_id: round(total, 2) for member_id, total in totals.items()}


def status_from_contribution_total(total_paid: float, bill_amount: float) -> BillStatus:
    if total_paid <= 0:
        return BillStatus.UNPAID
    if total_paid >= bill_amount:
        return BillStatus.PAID
    return BillStatus.PARTIALLY_PAID


def compute_overdue_status(bill: Bill, today: date, paid_total: float = 0.0) -> BillStatus:
    """Return the effective status of a bill, applying automatic overdue detection.

    Also reverts a bill back out of OVERDUE once its due date is no longer in
    the past (e.g. a recurring bill's due date rolled forward, or someone
    pushed it out via Edit Bill) - otherwise a bill that was overdue once
    stays flagged overdue forever, since nothing else clears that status.
    """
    if bill.status in (BillStatus.PAID, BillStatus.DEFERRED):
        return bill.status
    try:
        due = date.fromisoformat(bill.due_date)
    except ValueError:
        return bill.status
    if due < today:
        if bill.status in (BillStatus.UNPAID, BillStatus.PARTIALLY_PAID):
            return BillStatus.OVERDUE
        return bill.status
    if bill.status == BillStatus.OVERDUE:
        return status_from_contribution_total(paid_total, bill.total_amount)
    return bill.status


def next_household_payday(members: list[Member], from_date: date) -> date | None:
    """Soonest upcoming pay date across all members, or None if nobody has one configured."""
    candidates = []
    for member in members:
        dates = next_pay_dates(member, from_date, count=1)
        if dates:
            candidates.append(dates[0])
    return min(candidates) if candidates else None


def _household_round_complete(members: list[Member], period_start: date) -> date | None:
    """Furthest of each member's earliest payday on/after period_start.

    Once this date passes, everyone in the household has been paid at least
    once since the period began.
    """
    candidates = []
    for member in members:
        dates = next_pay_dates(member, period_start, count=1)
        if dates:
            candidates.append(dates[0])
    return max(candidates) if candidates else None


def household_pay_period_end(members: list[Member], today: date) -> date | None:
    """End of the pay period containing `today`.

    A pay period starts when someone gets paid and keeps collecting paydays
    until everyone's had at least one paycheck since it began (a "complete
    round" - see _household_round_complete). It then runs through whoever
    gets paid next; that payday starts the following period. With staggered
    pay schedules this makes periods vary in length as the cycles drift in
    and out of phase, rather than cutting a period short the moment the
    first household member gets paid again.

    Walks the chain of periods forward from the start of the current
    calendar month (a simple, predictable anchor) until it finds the one
    containing `today`. Edge case: a period that starts in the last day or
    two of a month gets recalculated from that later month's 1st if checked
    from the following month, which can shift its end by a day or so.
    """
    period_start = next_household_payday(members, today.replace(day=1))
    if period_start is None:
        return None
    for _ in range(60):  # safety bound; periods are at most a few weeks long
        round_complete = _household_round_complete(members, period_start)
        if round_complete is None:
            return None
        period_end = next_household_payday(members, round_complete + timedelta(days=1))
        if period_end is None:
            return None
        if today <= period_end:
            return period_end
        period_start = period_end
    return None


def is_due_this_pay_period(bill: Bill, today: date, next_payday: date | None) -> bool:
    """Whether a bill is due before the household's next payday.

    Replaces a fixed 7-day window: what matters for cash-flow planning is
    what's due before more income arrives, not an arbitrary calendar week.

    The next payday itself is excluded: current_pay_period_start treats a
    payday as the start of the period it opens, not the end of the one
    before it, so a bill due that same day is covered by the money that
    just arrived, not the money this period was covering.
    """
    if bill.status in (BillStatus.PAID, BillStatus.DEFERRED):
        return False
    if next_payday is None:
        return False
    try:
        due = date.fromisoformat(bill.due_date)
    except ValueError:
        return False
    return today <= due < next_payday


def bills_total_between(bills: list[Bill], start_inclusive: date, end_exclusive: date) -> float:
    """Sum of non-deferred bill amounts due on or after `start_inclusive`,
    up to (but not including) `end_exclusive`.

    Used to size up a future pay period's bill load (e.g. the period after
    the next payday), so the household can see a lumpy period coming and
    save toward it ahead of time. Mirrors is_due_this_pay_period's boundary:
    a bill due exactly on `start_inclusive` (a payday) belongs to the period
    that payday opens, and one due exactly on `end_exclusive` belongs to the
    period after that.
    """
    total = 0.0
    for bill in bills:
        if bill.status == BillStatus.DEFERRED:
            continue
        try:
            due = date.fromisoformat(bill.due_date)
        except ValueError:
            continue
        if start_inclusive <= due < end_exclusive:
            total += bill.total_amount
    return round(total, 2)


def should_reactivate_deferral(bill: Bill, today: date) -> bool:
    if bill.status != BillStatus.DEFERRED or not bill.deferred_until:
        return False
    try:
        deferred_until = date.fromisoformat(bill.deferred_until)
    except ValueError:
        return False
    return today >= deferred_until


def payments_total_for_bill(bill_id: str, payments: list[Payment]) -> float:
    return sum(p.total for p in payments if p.bill_id == bill_id)


def is_payment_late(due_date: str, payment_date: str) -> bool:
    """Whether a payment happened after the bill's due date."""
    try:
        return date.fromisoformat(payment_date) > date.fromisoformat(due_date)
    except ValueError:
        return False


def contributed_totals(month: str, payments: list[Payment]) -> dict[str, float]:
    """Keep recorded personal payments visible without treating them as debts."""
    totals: dict[str, float] = {}
    for payment in payments:
        if payment.date.startswith(month):
            for contribution in payment.contributions:
                totals[contribution.member_id] = (
                    totals.get(contribution.member_id, 0.0) + contribution.amount
                )
    return totals


def compute_settlement(
    month: str,
    bills: list[Bill],
    payments: list[Payment],
    members: list[Member],
    responsibility_method: ResponsibilityMethod,
) -> Settlement:
    """Compute each member's responsible-vs-paid balance for a given month.

    Only bills paid with per-member contributions ("Paid Individually" or
    "Partial Payment") count toward settlement. A bill marked "Paid Normally"
    has no contributor breakdown - there's nothing to reconcile, so it
    shouldn't create a phantom imbalance on either side.
    """
    personal_bill_ids = {b.id for b in bills if b.responsible_member_id}
    month_bills = [b for b in bills if b.month == month and b.id not in personal_bill_ids]
    month_payments = [
        p for p in payments if p.date.startswith(month) and p.bill_id not in personal_bill_ids
    ]
    bills_with_contributions = {p.bill_id for p in month_payments if p.contributions}

    responsible_totals: dict[str, float] = {m.id: 0.0 for m in members}
    paid_totals: dict[str, float] = {m.id: 0.0 for m in members}

    for bill in month_bills:
        if bill.id not in bills_with_contributions:
            continue
        for member_id, breakdown in bill_responsibility(
            bill, members, responsibility_method
        ).items():
            responsible_totals[member_id] = (
                responsible_totals.get(member_id, 0.0) + breakdown["amount"]
            )

    for payment in month_payments:
        for contribution in payment.contributions:
            paid_totals[contribution.member_id] = (
                paid_totals.get(contribution.member_id, 0.0) + contribution.amount
            )

    member_balances = [
        MemberSettlement(
            member_id=m.id,
            responsible=responsible_totals.get(m.id, 0.0),
            paid=paid_totals.get(m.id, 0.0),
            difference=paid_totals.get(m.id, 0.0) - responsible_totals.get(m.id, 0.0),
        )
        for m in members
    ]
    return Settlement(month=month, member_balances=member_balances)


def household_summary(
    bills: list[Bill], members: list[Member], cash_infusions_total: float = 0.0
) -> dict[str, float]:
    """Total income / bills / paid / remaining / cash remaining for the current month's bills.

    `cash_infusions_total` folds in one-time money (bonuses, gifts, refunds) on
    top of recurring income - it doesn't affect responsibility percentages,
    only how much cash is actually left over.
    """
    total_income = sum(m.current_income() for m in members)
    total_bills = sum(b.total_amount for b in bills)
    paid = sum(b.total_amount for b in bills if b.status == BillStatus.PAID)
    remaining = total_bills - paid
    return {
        "total_income": total_income,
        "total_bills": total_bills,
        "paid": paid,
        "remaining": remaining,
        "cash_remaining": total_income + cash_infusions_total - remaining,
    }


def cash_infusion_contributions_total(contributions: list[Contribution]) -> float:
    return round(sum(c.amount for c in contributions), 2)


def cash_infusion_matches_amount(contributions: list[Contribution], amount: float) -> bool:
    """Whether a contributor breakdown fully accounts for the infusion amount.

    An empty breakdown is valid (the infusion just isn't attributed to
    specific members yet); a non-empty one must sum to the total.
    """
    if not contributions:
        return True
    return abs(cash_infusion_contributions_total(contributions) - amount) < 0.01


def cash_infusions_total_for_month(infusions: list[CashInfusion], month: str) -> float:
    return round(sum(i.amount for i in infusions if i.date.startswith(month)), 2)


def category_name_taken(categories: list[Category], name: str) -> bool:
    """Whether a category with this name (trimmed, case-insensitive) already exists."""
    normalized = name.strip().lower()
    return any(c.name.strip().lower() == normalized for c in categories)


def category_totals(
    bills: list[Bill], expenses: list[CategoryExpense] | None = None
) -> dict[str, float]:
    """Budget totals per category for the month, folding in non-bill expenses too."""
    totals: dict[str, float] = {}
    for bill in bills:
        totals[bill.category_id] = totals.get(bill.category_id, 0.0) + bill.total_amount
    for expense in expenses or []:
        totals[expense.category_id] = totals.get(expense.category_id, 0.0) + expense.amount
    return totals


def category_spend_for_month(
    bills: list[Bill], expenses: list[CategoryExpense], category_id: str, month: str
) -> float:
    """A single category's actual spend (bills + non-bill items) for a given month."""
    total = sum(b.total_amount for b in bills if b.category_id == category_id and b.month == month)
    total += sum(e.amount for e in expenses if e.category_id == category_id and e.month == month)
    return round(total, 2)


def recent_months(before_month: str, count: int) -> list[str]:
    """The `count` distinct months immediately preceding `before_month` ("YYYY-MM").

    Oldest first.
    """
    year, mon = (int(part) for part in before_month.split("-"))
    start = date(year, mon, 1)
    return [add_months(start, -i).strftime("%Y-%m") for i in range(count, 0, -1)]


def category_budget_recommendation(planned_budget: float, historical_spend: list[float]) -> str:
    """"raise", "lower", or "maintain" a category's planned budget.

    Based on whether actual spend has consistently overshot or undershot the
    budget across the sampled past months (a majority, not just one outlier
    month). "maintain" is also the safe default with no budget set or not
    enough history yet to draw a conclusion.
    """
    if planned_budget <= 0 or not historical_spend:
        return "maintain"
    majority = len(historical_spend) / 2
    over_count = sum(1 for spend in historical_spend if spend > planned_budget)
    under_count = sum(1 for spend in historical_spend if spend < planned_budget * 0.8)
    if over_count > majority:
        return "raise"
    if under_count > majority:
        return "lower"
    return "maintain"


def _next_monthly_days(from_date: date, days: list[int], count: int) -> list[date]:
    """Next `count` dates on or after from_date, on any of the given days-of-month.

    Clamps to the last day of shorter months (e.g. day 31 in February).
    """
    results: list[date] = []
    sorted_days = sorted(days)
    month_offset = 0
    while len(results) < count and month_offset < 36:
        month_start = add_months(from_date.replace(day=1), month_offset)
        for day in sorted_days:
            clamped_day = min(day, calendar.monthrange(month_start.year, month_start.month)[1])
            candidate = date(month_start.year, month_start.month, clamped_day)
            if candidate >= from_date:
                results.append(candidate)
        month_offset += 1
    return sorted(results)[:count]


def _next_interval_dates(
    from_date: date, anchor: date, interval_days: int, count: int
) -> list[date]:
    """Next `count` dates on or after from_date, spaced interval_days apart from anchor."""
    first = anchor
    if first < from_date:
        days_since = (from_date - anchor).days
        first = anchor + timedelta(days=(days_since // interval_days) * interval_days)
        while first < from_date:
            first += timedelta(days=interval_days)
    return [first + timedelta(days=interval_days * i) for i in range(count)]


def _next_pay_dates_for_schedule(
    pay_frequency: PayFrequency,
    pay_days: list[int],
    pay_anchor_date: str | None,
    from_date: date,
    count: int,
) -> list[date]:
    if pay_frequency == PayFrequency.MONTHLY:
        days = pay_days or [1]
        return _next_monthly_days(from_date, days[:1], count)
    if pay_frequency == PayFrequency.SEMI_MONTHLY:
        days = pay_days or [1, 15]
        return _next_monthly_days(from_date, days, count)
    if pay_frequency in (PayFrequency.WEEKLY, PayFrequency.BIWEEKLY):
        if not pay_anchor_date:
            return []
        interval = 7 if pay_frequency == PayFrequency.WEEKLY else 14
        anchor = date.fromisoformat(pay_anchor_date)
        return _next_interval_dates(from_date, anchor, interval, count)
    return []


def next_pay_dates(member: Member, from_date: date, count: int = 1) -> list[date]:
    """Return the next `count` pay dates for a member, on or after from_date."""
    return _next_pay_dates_for_schedule(
        member.pay_frequency, member.pay_days, member.pay_anchor_date, from_date, count
    )


def next_pay_dates_for_source(source: IncomeSource, from_date: date, count: int = 1) -> list[date]:
    """Return the next `count` pay dates for a single income source.

    Informational only - these never feed into pay-period or bill-timing
    math, which stays driven solely by the member's own schedule (see
    next_pay_dates). This just lets a source with its own, possibly
    different, payday show when it's next expected.
    """
    return _next_pay_dates_for_schedule(
        source.pay_frequency, source.pay_days, source.pay_anchor_date, from_date, count
    )


def calculate_savings_amount(
    savings_type: SavingsType, savings_value: float, total_income: float, total_bills: float
) -> float:
    """Household savings target for the current month, per the configured rule."""
    if savings_type == SavingsType.PERCENT_OF_INCOME:
        return round(total_income * savings_value / 100.0, 2)
    if savings_type == SavingsType.PERCENT_OF_REMAINING:
        remaining = max(total_income - total_bills, 0.0)
        return round(remaining * savings_value / 100.0, 2)
    return round(savings_value, 2)  # FIXED_AMOUNT


def savings_responsibility(
    savings_amount: float, members: list[Member]
) -> dict[str, dict[str, float]]:
    """Each member's share of the savings goal, split proportionally by income.

    Always income-proportional, unlike bill_responsibility - there's no
    per-goal manual override concept for a single household-wide savings rule.
    """
    pct_by_member = automatic_percentages(members)
    return {
        member_id: {"pct": pct, "amount": round(savings_amount * pct / 100.0, 2)}
        for member_id, pct in pct_by_member.items()
    }


def savings_plan_contributions_for_month(
    plans: list[SavingsPlan], bills: list[Bill], month: str
) -> float:
    """Total of every bill's savings-plan installment scheduled for this month.

    Added on top of the household savings goal so the monthly savings target
    reflects money that also needs to be set aside for upcoming one-time bills.

    Excludes the installment for a bill whose due month is this same month:
    once a bill comes due, the money you'd saved for it is being spent to pay
    it off (already counted in that month's Bills), not still sitting in
    savings. Without this, the due month double-counts the same dollars as
    both "Savings" and "Bills".
    """
    bills_by_id = {b.id: b for b in bills}
    total = 0.0
    for plan in plans:
        bill = bills_by_id.get(plan.bill_id)
        due_month = bill.due_date[:7] if bill else None
        for entry in plan.entries:
            if entry.month == month and entry.month != due_month:
                total += entry.amount
    return round(total, 2)


def household_paydays_in_month(members: list[Member], month: str) -> list[date]:
    """Every distinct date within `month` (YYYY-MM) that any member gets paid."""
    year, mon = (int(part) for part in month.split("-"))
    start = date(year, mon, 1)
    end = add_months(start, 1)
    all_dates: set[date] = set()
    for member in members:
        for d in next_pay_dates(member, start, count=10):
            if d >= end:
                break
            all_dates.add(d)
    return sorted(all_dates)


def savings_amount_for_pay_period(savings_amount: float, paydays_this_month: int) -> float:
    """Prorated share of the monthly savings target for a single pay period."""
    if paydays_this_month <= 0:
        return round(savings_amount, 2)
    return round(savings_amount / paydays_this_month, 2)


def current_pay_period_start(members: list[Member], today: date) -> date:
    """Start of the household's current pay period.

    The most recent payday on or before today *within the current month*,
    across every member, or the first of the month if nobody has been paid
    yet this month (a payday from a prior month doesn't count).
    """
    month_start = today.replace(day=1)
    candidates: list[date] = []
    lookback = today - timedelta(days=45)
    for member in members:
        for d in next_pay_dates(member, lookback, count=20):
            if month_start <= d <= today:
                candidates.append(d)
    if candidates:
        return max(candidates)
    return month_start


def savings_deposited_for_month(deposits: list[SavingsDeposit], month: str) -> float:
    return round(sum(d.amount for d in deposits if d.date.startswith(month)), 2)


def savings_deposited_between(deposits: list[SavingsDeposit], start: date, end: date) -> float:
    total = 0.0
    for deposit in deposits:
        try:
            deposit_date = date.fromisoformat(deposit.date)
        except ValueError:
            continue
        if start <= deposit_date <= end:
            total += deposit.amount
    return round(total, 2)


def _months_between(start: date, end: date) -> list[str]:
    """List of "YYYY-MM" strings from start's month through end's month, inclusive."""
    months = []
    cursor = start.replace(day=1)
    end_month = end.replace(day=1)
    while cursor <= end_month:
        months.append(f"{cursor.year:04d}-{cursor.month:02d}")
        cursor = add_months(cursor, 1)
    return months


def calculate_default_savings_plan(bill: Bill, today: date) -> list[SavingsPlanEntry]:
    """Proposed even monthly savings plan to cover a one-time bill by its due date.

    Splits the amount evenly across every month from today through the due
    month; the last month absorbs the rounding remainder so the entries
    always sum to exactly the bill amount.
    """
    if bill.frequency != Frequency.ONE_TIME:
        return []
    try:
        due = date.fromisoformat(bill.due_date)
    except ValueError:
        return []
    if due <= today:
        return [
            SavingsPlanEntry(month=f"{today.year:04d}-{today.month:02d}", amount=bill.total_amount)
        ]

    months = _months_between(today, due)
    per_month = round(bill.total_amount / len(months), 2)
    entries = [SavingsPlanEntry(month=m, amount=per_month) for m in months[:-1]]
    remainder = round(bill.total_amount - sum(e.amount for e in entries), 2)
    entries.append(SavingsPlanEntry(month=months[-1], amount=remainder))
    return entries


def savings_plan_total(entries: list[SavingsPlanEntry]) -> float:
    return sum(e.amount for e in entries)


def savings_plan_meets_amount(entries: list[SavingsPlanEntry], amount: float) -> bool:
    """Whether a plan's total covers the amount, tolerating float rounding noise."""
    return savings_plan_total(entries) >= amount - 0.01

def validate_late_fee(amount: float) -> float:
    """Validate an explicitly entered per-occurrence fee, never auto-charge."""
    from math import isfinite

    if not isfinite(amount) or amount < 0:
        raise ValueError("Late fees must be a finite, non-negative amount")
    return round(amount, 2)


def status_after_late_fee(bill: Bill, total_paid: float, today: date) -> BillStatus:
    """Preserve deferrals unless payments cover the revised total."""
    status = status_from_contribution_total(total_paid, bill.total_amount)
    if status == BillStatus.PAID:
        return status
    if bill.status == BillStatus.DEFERRED:
        return BillStatus.DEFERRED
    if bill.due_date < today.isoformat():
        return BillStatus.OVERDUE
    return status
