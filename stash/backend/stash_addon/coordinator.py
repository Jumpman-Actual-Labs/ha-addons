from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

from .const import (
    BillStatus,
    BillType,
    FinanceMode,
    Frequency,
    PayFrequency,
    PaymentType,
    ResponsibilityMethod,
    SavingsType,
)
from .logic import (
    bill_responsibility,
    bill_responsibility_totals,
    bills_total_between,
    budget_responsibility_totals,
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
    contributed_totals,
    current_pay_period_start,
    household_pay_period_end,
    household_paydays_in_month,
    household_summary,
    is_due_this_pay_period,
    next_due_date,
    next_pay_dates,
    payments_total_for_bill,
    recent_months,
    savings_amount_for_pay_period,
    savings_deposited_between,
    savings_deposited_for_month,
    savings_plan_contributions_for_month,
    savings_plan_meets_amount,
    savings_responsibility,
    should_reactivate_deferral,
    status_after_late_fee,
    status_from_contribution_total,
    validate_late_fee,
)
from .models import (
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
    new_id,
)
from .storage import FinanceStore, default_data

_LOGGER = logging.getLogger(__name__)


def _current_month(today: date) -> str:
    return f"{today.year:04d}-{today.month:02d}"


class FinanceCoordinator:
    """Central state holder for Stash.

    Not polling-based - state changes are pushed in by services.py calling
    the mutation methods below, each of which persists to storage and
    notifies listeners (web.py's websocket push and mqtt.py's publisher).
    """

    def __init__(self, store: FinanceStore) -> None:
        self.data: dict[str, Any] | None = None
        self._listeners: list[Callable[[], None]] = []
        self.store = store
        self.mode: FinanceMode = FinanceMode.SPLIT
        self.responsibility_method: ResponsibilityMethod = ResponsibilityMethod.AUTOMATIC
        self.members: list[Member] = []
        self.categories: list[Category] = []
        self.bills: list[Bill] = []
        self.payments: list[Payment] = []
        self.savings_type: SavingsType = SavingsType.FIXED_AMOUNT
        self.savings_value: float = 0.0
        self.savings_plans: list[SavingsPlan] = []
        self.savings_deposits: list[SavingsDeposit] = []
        self.cash_infusions: list[CashInfusion] = []
        self.category_expenses: list[CategoryExpense] = []
        self.archive: dict[str, Any] = {}

    # ----------------------------------------------------------- listeners
    # Stands in for DataUpdateCoordinator's push API from the integration
    # days - same two method names, so everything below is unchanged.

    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def async_set_updated_data(self, data: dict[str, Any]) -> None:
        self.data = data
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:  # one bad listener mustn't block the rest
                _LOGGER.exception("Stash listener failed")

    def async_refresh(self) -> None:
        """Rebuilds the read model without a mutation - overdue status,
        "this pay period" and the current month all move with the date
        alone (see rollover.py)."""
        self.async_set_updated_data(self._build_public_data())

    # ---------------------------------------------------------------- load

    async def async_load(self) -> None:
        raw = await self.store.async_load()
        if raw is None:
            raw = default_data()
            await self.store.async_save(raw)

        self.mode = FinanceMode(raw.get("mode", FinanceMode.SPLIT.value))
        self.responsibility_method = ResponsibilityMethod(
            raw.get("responsibility_method", ResponsibilityMethod.AUTOMATIC.value)
        )
        self.members = [Member.from_dict(m) for m in raw.get("members", [])]
        self.categories = [Category.from_dict(c) for c in raw.get("categories", [])]
        self.bills = [Bill.from_dict(b) for b in raw.get("bills", [])]
        self.payments = [Payment.from_dict(p) for p in raw.get("payments", [])]
        self.savings_type = SavingsType(raw.get("savings_type", SavingsType.FIXED_AMOUNT.value))
        self.savings_value = raw.get("savings_value", 0.0)
        self.savings_plans = [SavingsPlan.from_dict(p) for p in raw.get("savings_plans", [])]
        self.savings_deposits = [
            SavingsDeposit.from_dict(d) for d in raw.get("savings_deposits", [])
        ]
        self.cash_infusions = [
            CashInfusion.from_dict(i) for i in raw.get("cash_infusions", [])
        ]
        self.category_expenses = [
            CategoryExpense.from_dict(e) for e in raw.get("category_expenses", [])
        ]
        self.archive = raw.get("archive", {})

        await self.async_ensure_recurring_bills()
        self.async_set_updated_data(self._build_public_data())

    # --------------------------------------------------------------- save

    async def _async_save(self) -> None:
        data = {
            "version": 1,
            "mode": self.mode.value,
            "responsibility_method": self.responsibility_method.value,
            "members": [m.to_dict() for m in self.members],
            "categories": [c.to_dict() for c in self.categories],
            "bills": [b.to_dict() for b in self.bills],
            "payments": [p.to_dict() for p in self.payments],
            "settlements": [],
            "savings_type": self.savings_type.value,
            "savings_value": self.savings_value,
            "savings_plans": [p.to_dict() for p in self.savings_plans],
            "savings_deposits": [d.to_dict() for d in self.savings_deposits],
            "cash_infusions": [i.to_dict() for i in self.cash_infusions],
            "category_expenses": [e.to_dict() for e in self.category_expenses],
            "archive": self.archive,
        }
        await self.store.async_save(data)
        self.async_set_updated_data(self._build_public_data())

    def _apply_dynamic_status(self, today: date) -> None:
        for bill in self.bills:
            if should_reactivate_deferral(bill, today):
                bill.status = BillStatus.UNPAID
                bill.deferred_until = None
                bill.deferred_reason = None
            paid_total = payments_total_for_bill(bill.id, self.payments)
            bill.status = compute_overdue_status(bill, today, paid_total)

    def _build_public_data(self) -> dict[str, Any]:
        today = date.today()
        # Bills can drift into or out of "overdue" purely from the passage of
        # time (no mutation involved), so re-check every time data is rebuilt
        # rather than only at startup/rollover - otherwise a bill whose due
        # date moved into the future stays flagged overdue indefinitely.
        self._apply_dynamic_status(today)
        month = _current_month(today)
        month_bills = [b for b in self.bills if b.month == month]
        month_expenses = [e for e in self.category_expenses if e.month == month]
        cash_infusions_month = cash_infusions_total_for_month(self.cash_infusions, month)
        summary = household_summary(month_bills, self.members, cash_infusions_month)
        savings_goal_amount = calculate_savings_amount(
            self.savings_type, self.savings_value, summary["total_income"], summary["total_bills"]
        )
        savings_plan_contributions = savings_plan_contributions_for_month(
            self.savings_plans, self.bills, month
        )
        savings_amount = round(savings_goal_amount + savings_plan_contributions, 2)
        paydays_this_month = household_paydays_in_month(self.members, month)
        savings_per_period = savings_amount_for_pay_period(savings_amount, len(paydays_this_month))
        period_start = current_pay_period_start(self.members, today)
        savings_deposited_month = savings_deposited_for_month(self.savings_deposits, month)
        savings_deposited_period = savings_deposited_between(
            self.savings_deposits, period_start, today
        )
        next_payday = household_pay_period_end(self.members, today)
        payday_after_next = (
            household_pay_period_end(self.members, next_payday + timedelta(days=1))
            if next_payday
            else None
        )
        next_period_bills_total = (
            bills_total_between(self.bills, next_payday, payday_after_next)
            if next_payday and payday_after_next
            else 0.0
        )
        responsibility_totals = bill_responsibility_totals(
            month_bills, self.members, self.responsibility_method
        )
        repayment_bill_ids = {
            i.repayment_bill_id for i in self.cash_infusions if i.repayment_bill_id
        }
        month_bills_excluding_repayments = [
            b for b in month_bills if b.id not in repayment_bill_ids
        ]
        responsibility_totals_excluding_repayments = bill_responsibility_totals(
            month_bills_excluding_repayments, self.members, self.responsibility_method
        )
        budget_totals = budget_responsibility_totals(
            month_bills, month_expenses, self.categories, self.members,
            self.responsibility_method,
        )
        budget_totals_excluding_repayments = budget_responsibility_totals(
            month_bills, month_expenses, self.categories, self.members,
            self.responsibility_method, excluded_bill_ids=repayment_bill_ids,
        )
        history_months = recent_months(month, 3)
        category_recommendations = {}
        for category in self.categories:
            historical_spend = [
                category_spend_for_month(self.bills, self.category_expenses, category.id, m)
                for m in history_months
            ]
            category_recommendations[category.id] = {
                "recommendation": category_budget_recommendation(
                    category.planned_budget, historical_spend
                ),
                "historical_average_spend": round(
                    sum(historical_spend) / len(historical_spend), 2
                )
                if historical_spend
                else 0.0,
                "last_month_spend": historical_spend[-1] if historical_spend else 0.0,
            }
        return {
            "mode": self.mode.value,
            "responsibility_method": self.responsibility_method.value,
            "members": self.members,
            "categories": self.categories,
            "bills": self.bills,
            "payments": self.payments,
            "savings_plans": self.savings_plans,
            # Per-bill lookups the integration's bill sensors asked the
            # coordinator for at render time - precomputed here so states.py
            # stays a pure function of this dict.
            "savings_plans_by_bill": {p.bill_id: p for p in self.savings_plans},
            "proposed_savings_plans_by_bill": {
                b.id: calculate_default_savings_plan(b, today) for b in self.bills
            },
            "responsibility_by_bill": {
                b.id: bill_responsibility(b, self.members, self.responsibility_method)
                for b in self.bills
            },
            "current_month": month,
            "summary": summary,
            "category_totals": category_totals(month_bills, month_expenses),
            "category_expenses": self.category_expenses,
            "category_recommendations": category_recommendations,
            "responsibility_totals": responsibility_totals,
            "budget_responsibility_totals": budget_totals,
            "budget_responsibility_totals_excluding_repayments": (
                budget_totals_excluding_repayments
            ),
            "contributed_totals": contributed_totals(month, self.payments),
            "responsibility_totals_excluding_repayments": (
                responsibility_totals_excluding_repayments
            ),
            "settlement": compute_settlement(
                month, self.bills, self.payments, self.members, self.responsibility_method
            ),
            "next_payday": next_payday.isoformat() if next_payday else None,
            "payday_after_next": payday_after_next.isoformat() if payday_after_next else None,
            "next_period_bills_total": next_period_bills_total,
            "upcoming_this_pay_period": [
                b for b in month_bills if is_due_this_pay_period(b, today, next_payday)
            ],
            "overdue": [b for b in self.bills if b.status == BillStatus.OVERDUE],
            "deferred": [b for b in self.bills if b.status == BillStatus.DEFERRED],
            "savings_type": self.savings_type.value,
            "savings_value": self.savings_value,
            "savings_amount": savings_amount,
            "savings_goal_amount": savings_goal_amount,
            "savings_plan_contributions": savings_plan_contributions,
            "savings_per_period": savings_per_period,
            "savings_deposits": self.savings_deposits,
            "savings_deposited_month": savings_deposited_month,
            "savings_deposited_period": savings_deposited_period,
            "savings_breakdown": savings_responsibility(savings_amount, self.members),
            "cash_infusions": self.cash_infusions,
            "cash_infusions_total_month": cash_infusions_month,
        }

    # ------------------------------------------------------------ members

    async def async_set_mode(self, mode: FinanceMode) -> None:
        self.mode = mode
        await self._async_save()

    async def async_set_responsibility_method(self, method: ResponsibilityMethod) -> None:
        self.responsibility_method = method
        await self._async_save()

    async def async_set_savings_goal(self, savings_type: SavingsType, value: float) -> None:
        self.savings_type = savings_type
        self.savings_value = value
        await self._async_save()

    async def async_add_member(
        self,
        name: str,
        income: float,
        notes: str = "",
        pay_frequency: PayFrequency = PayFrequency.MONTHLY,
        pay_days: list[int] | None = None,
        pay_anchor_date: str | None = None,
        ha_user_id: str | None = None,
    ) -> Member:
        member = Member(
            id=new_id(),
            name=name,
            notes=notes,
            income_history=[IncomeEntry(month=_current_month(date.today()), amount=income)],
            pay_frequency=pay_frequency,
            pay_days=pay_days or [],
            pay_anchor_date=pay_anchor_date,
            ha_user_id=ha_user_id,
        )
        self.members.append(member)
        await self._async_save()
        return member

    async def async_edit_member(self, member_id: str, **fields: Any) -> Member:
        member = self._get_member(member_id)
        if "pay_frequency" in fields and fields["pay_frequency"] is not None:
            fields["pay_frequency"] = PayFrequency(fields["pay_frequency"])
        for key, value in fields.items():
            if value is not None and hasattr(member, key):
                setattr(member, key, value)
        await self._async_save()
        return member

    async def async_update_income(self, member_id: str, month: str, amount: float) -> None:
        member = self._get_member(member_id)
        member.income_history = [e for e in member.income_history if e.month != month]
        member.income_history.append(IncomeEntry(month=month, amount=amount))
        await self._async_save()

    # ----------------------------------------------------- income sources

    async def async_add_income_source(
        self,
        member_id: str,
        name: str,
        amount: float,
        pay_frequency: PayFrequency = PayFrequency.MONTHLY,
        pay_days: list[int] | None = None,
        pay_anchor_date: str | None = None,
    ) -> IncomeSource:
        member = self._get_member(member_id)
        source = IncomeSource(
            id=new_id(),
            name=name,
            amount=amount,
            pay_frequency=pay_frequency,
            pay_days=pay_days or [],
            pay_anchor_date=pay_anchor_date,
        )
        member.income_sources.append(source)
        await self._async_save()
        return source

    def _get_income_source(self, member: Member, source_id: str) -> IncomeSource:
        for source in member.income_sources:
            if source.id == source_id:
                return source
        raise ValueError(f"Unknown income_source_id {source_id}")

    async def async_edit_income_source(
        self, member_id: str, source_id: str, **fields: Any
    ) -> IncomeSource:
        member = self._get_member(member_id)
        source = self._get_income_source(member, source_id)
        if "pay_frequency" in fields and fields["pay_frequency"] is not None:
            fields["pay_frequency"] = PayFrequency(fields["pay_frequency"])
        for key, value in fields.items():
            if value is not None and hasattr(source, key):
                setattr(source, key, value)
        await self._async_save()
        return source

    async def async_delete_income_source(self, member_id: str, source_id: str) -> None:
        member = self._get_member(member_id)
        self._get_income_source(member, source_id)  # raises on an unknown id
        member.income_sources = [s for s in member.income_sources if s.id != source_id]
        await self._async_save()

    async def async_delete_member(self, member_id: str) -> None:
        # Bills/payments/cash-infusion contributions referencing this member
        # just become an orphaned member_id, same as deleting a category
        # leaves bills uncategorized rather than blocking deletion.
        #
        # Raises on an unknown id (matching async_edit_member) rather than
        # silently doing nothing - a delete that quietly no-ops on a bad id
        # looks identical to a delete that succeeded, which made a stale
        # entity/id mismatch effectively undiagnosable from the UI.
        self._get_member(member_id)
        self.members = [m for m in self.members if m.id != member_id]
        await self._async_save()

    def _get_member(self, member_id: str) -> Member:
        for member in self.members:
            if member.id == member_id:
                return member
        raise ValueError(f"Unknown member_id {member_id}")

    def next_pay_dates_for_member(self, member_id: str, count: int = 1) -> list[str]:
        member = self._get_member(member_id)
        return [d.isoformat() for d in next_pay_dates(member, date.today(), count)]

    # ---------------------------------------------------------- categories

    async def async_add_category(self, name: str) -> Category:
        if category_name_taken(self.categories, name):
            raise ValueError(f'A category named "{name.strip()}" already exists')
        category = Category(id=new_id(), name=name, is_custom=True)
        self.categories.append(category)
        await self._async_save()
        return category

    async def async_delete_category(self, category_id: str) -> None:
        # Bills referencing a deleted category just show as uncategorized
        # ("-" in the frontend) rather than blocking deletion.
        self.categories = [c for c in self.categories if c.id != category_id]
        await self._async_save()

    async def async_set_category_budget(self, category_id: str, planned_budget: float) -> Category:
        category = next((c for c in self.categories if c.id == category_id), None)
        if category is None:
            raise ValueError(f"Unknown category_id {category_id}")
        category.planned_budget = planned_budget
        await self._async_save()
        return category

    async def async_add_category_expense(
        self, category_id: str, name: str, amount: float, expense_date: str, notes: str = ""
    ) -> CategoryExpense:
        expense = CategoryExpense(
            id=new_id(),
            category_id=category_id,
            name=name,
            amount=amount,
            date=expense_date,
            notes=notes,
            month=expense_date[:7],
        )
        self.category_expenses.append(expense)
        await self._async_save()
        return expense

    def _get_category_expense(self, expense_id: str) -> CategoryExpense:
        for expense in self.category_expenses:
            if expense.id == expense_id:
                return expense
        raise ValueError(f"Unknown expense_id {expense_id}")

    async def async_edit_category_expense(self, expense_id: str, **fields: Any) -> CategoryExpense:
        expense = self._get_category_expense(expense_id)
        for key, value in fields.items():
            if value is not None and hasattr(expense, key):
                setattr(expense, key, value)
        if "date" in fields and fields["date"] is not None:
            expense.month = expense.date[:7]
        await self._async_save()
        return expense

    async def async_delete_category_expense(self, expense_id: str) -> None:
        self.category_expenses = [e for e in self.category_expenses if e.id != expense_id]
        await self._async_save()

    # --------------------------------------------------------------- bills

    def _get_bill(self, bill_id: str) -> Bill:
        for bill in self.bills:
            if bill.id == bill_id:
                return bill
        raise ValueError(f"Unknown bill_id {bill_id}")

    async def async_add_bill(
        self,
        name: str,
        amount: float,
        category_id: str,
        due_date: str,
        frequency: Frequency,
        bill_type,
        notes: str = "",
        pay_to: str = "",
        manual_responsibility: dict[str, float] | None = None,
        responsible_member_id: str | None = None,
    ) -> Bill:
        if responsible_member_id:
            self._get_member(responsible_member_id)
        bill = Bill(
            id=new_id(),
            name=name,
            amount=amount,
            category_id=category_id,
            due_date=due_date,
            frequency=frequency,
            bill_type=bill_type,
            notes=notes,
            pay_to=pay_to,
            month=due_date[:7],
            manual_responsibility=manual_responsibility,
            responsible_member_id=responsible_member_id or None,
        )
        self.bills.append(bill)
        await self._async_save()
        return bill

    async def async_edit_bill(self, bill_id: str, **fields: Any) -> Bill:
        bill = self._get_bill(bill_id)
        if "responsible_member_id" in fields:
            owner = fields["responsible_member_id"]
            if owner:
                self._get_member(owner)
        if "frequency" in fields and fields["frequency"] is not None:
            fields["frequency"] = Frequency(fields["frequency"])
        if "bill_type" in fields and fields["bill_type"] is not None:
            fields["bill_type"] = BillType(fields["bill_type"])
        if "responsible_member_id" in fields:
            # Empty string explicitly restores a shared bill.
            bill.responsible_member_id = fields.pop("responsible_member_id") or None
        for key, value in fields.items():
            if value is not None and hasattr(bill, key):
                setattr(bill, key, value)
        if "due_date" in fields and fields["due_date"] is not None:
            bill.month = bill.due_date[:7]
        await self._async_save()
        return bill

    async def async_set_bill_late_fee(self, bill_id: str, amount: float) -> None:
        bill = self._get_bill(bill_id)
        if bill.status == BillStatus.PAID:
            raise ValueError("Late fees can only be changed on unpaid bills")
        bill.late_fee = validate_late_fee(amount)
        bill.status = status_after_late_fee(
            bill, payments_total_for_bill(bill_id, self.payments), date.today()
        )
        await self._maybe_generate_recurring(bill)
        await self._async_save()

    async def async_delete_bill(self, bill_id: str) -> None:
        self.bills = [b for b in self.bills if b.id != bill_id]
        self.payments = [p for p in self.payments if p.bill_id != bill_id]
        self.savings_plans = [p for p in self.savings_plans if p.bill_id != bill_id]
        await self._async_save()

    # ------------------------------------------------------------- savings

    async def async_set_savings_plan(
        self, bill_id: str, entries: list[dict[str, Any]]
    ) -> SavingsPlan:
        bill = self._get_bill(bill_id)
        plan_entries = [
            SavingsPlanEntry(month=e["month"], amount=float(e["amount"])) for e in entries
        ]
        if not savings_plan_meets_amount(plan_entries, bill.total_amount):
            raise ValueError(
                f"Savings plan totals {sum(e.amount for e in plan_entries):.2f}, "
                f"which doesn't cover the bill amount of {bill.total_amount:.2f}"
            )
        self.savings_plans = [p for p in self.savings_plans if p.bill_id != bill_id]
        plan = SavingsPlan(bill_id=bill_id, entries=plan_entries)
        self.savings_plans.append(plan)
        await self._async_save()
        return plan

    def savings_plan_for_bill(self, bill_id: str) -> SavingsPlan | None:
        return next((p for p in self.savings_plans if p.bill_id == bill_id), None)

    def proposed_savings_plan_for_bill(self, bill_id: str) -> list[SavingsPlanEntry]:
        bill = self._get_bill(bill_id)
        return calculate_default_savings_plan(bill, date.today())

    def responsibility_for_bill(self, bill_id: str) -> dict[str, dict[str, float]]:
        bill = self._get_bill(bill_id)
        return bill_responsibility(bill, self.members, self.responsibility_method)

    async def async_add_savings_deposit(
        self, amount: float, deposit_date: str, notes: str = ""
    ) -> SavingsDeposit:
        deposit = SavingsDeposit(id=new_id(), date=deposit_date, amount=amount, notes=notes)
        self.savings_deposits.append(deposit)
        await self._async_save()
        return deposit

    # ------------------------------------------------------- cash infusions

    async def async_add_cash_infusion(
        self,
        amount: float,
        infusion_date: str,
        source: str = "",
        contributions: list[dict[str, Any]] | None = None,
        repayment_due_date: str | None = None,
        repayment_entries: list[dict[str, Any]] | None = None,
    ) -> CashInfusion:
        contribs = [
            Contribution(member_id=c["member_id"], amount=float(c["amount"]))
            for c in (contributions or [])
        ]
        if not cash_infusion_matches_amount(contribs, amount):
            raise ValueError(
                f"Contributions total {cash_infusion_contributions_total(contribs):.2f} doesn't "
                f"match the infusion amount of {amount:.2f}"
            )

        repayment_bill_id = None
        if repayment_due_date:
            repayment_bill_id = self._create_repayment_bill(
                amount, infusion_date, source, repayment_due_date, repayment_entries
            ).id

        infusion = CashInfusion(
            id=new_id(),
            date=infusion_date,
            amount=amount,
            source=source,
            contributions=contribs,
            repayment_bill_id=repayment_bill_id,
        )
        self.cash_infusions.append(infusion)
        await self._async_save()
        return infusion

    async def async_delete_cash_infusion(self, infusion_id: str) -> None:
        self.cash_infusions = [i for i in self.cash_infusions if i.id != infusion_id]
        await self._async_save()

    def _create_repayment_bill(
        self,
        amount: float,
        infusion_date: str,
        source: str,
        due_date: str,
        entries: list[dict[str, Any]] | None,
    ) -> Bill:
        """File a one-time "debt" bill for a cash infusion that needs repaying.

        Reuses the existing one-time-bill + savings-plan machinery, since
        "save up to pay this off by a date" is exactly the same shape of
        problem whether the bill is a real invoice or a promise to a member.
        """
        category = next(
            (c for c in self.categories if c.name.lower() == "debt"),
            self.categories[0] if self.categories else None,
        )
        if category is None:
            raise ValueError("No categories exist to file a repayment bill under")
        bill = Bill(
            id=new_id(),
            name=f"Repay: {source}" if source else "Cash infusion repayment",
            amount=amount,
            category_id=category.id,
            due_date=due_date,
            frequency=Frequency.ONE_TIME,
            bill_type=BillType.DEBT,
            notes=f"Repayment for a cash infusion recorded on {infusion_date}.",
            month=due_date[:7],
        )
        self.bills.append(bill)
        plan_entries = (
            [SavingsPlanEntry(month=e["month"], amount=float(e["amount"])) for e in entries]
            if entries
            else calculate_default_savings_plan(bill, date.today())
        )
        if not savings_plan_meets_amount(plan_entries, bill.total_amount):
            raise ValueError(
                f"Repayment plan totals {sum(e.amount for e in plan_entries):.2f}, which "
                f"doesn't cover the {bill.total_amount:.2f} owed"
            )
        self.savings_plans.append(SavingsPlan(bill_id=bill.id, entries=plan_entries))
        return bill

    # ------------------------------------------------------------ payments

    def _generate_recurring_bill(self, bill: Bill) -> Bill | None:
        """Create the next occurrence of a recurring bill if its lineage doesn't already have one.

        Returns the new Bill, or None if the bill doesn't recur or its next
        occurrence already exists.
        """
        next_date = next_due_date(date.fromisoformat(bill.due_date), bill.frequency)
        if next_date is None:
            return None
        lineage_id = bill.recurring_parent_id or bill.id
        # Match by the SAME lineage, not "no parent recorded yet" - two
        # unrelated bills (e.g. Rent and Internet, both due the 1st) each
        # start with recurring_parent_id=None, so comparing that field
        # directly (instead of via `or bill.id`) treated any of them as
        # already covering this bill's next occurrence and silently skipped
        # generating it.
        already_generated = any(
            (b.recurring_parent_id or b.id) == lineage_id
            for b in self.bills
            if b.due_date == next_date.isoformat()
        )
        if already_generated:
            return None
        new_bill = Bill(
            id=new_id(),
            name=bill.name,
            amount=bill.amount,
            category_id=bill.category_id,
            due_date=next_date.isoformat(),
            frequency=bill.frequency,
            bill_type=bill.bill_type,
            notes=bill.notes,
            pay_to=bill.pay_to,
            month=next_date.isoformat()[:7],
            manual_responsibility=bill.manual_responsibility,
            responsible_member_id=bill.responsible_member_id,
            recurring_parent_id=lineage_id,
        )
        self.bills.append(new_bill)
        return new_bill

    async def _maybe_generate_recurring(self, bill: Bill) -> None:
        if bill.status != BillStatus.PAID:
            return
        self._generate_recurring_bill(bill)

    async def async_ensure_recurring_bills(self, today: date | None = None) -> bool:
        """Generate the next occurrence for any recurring bill whose due date
        has passed, even if it's still unpaid.

        Without this, a recurring bill that never gets marked paid blocks its
        own recurrence forever (generation was only ever triggered by
        payment), so it silently disappears from every future period instead
        of showing up as still owed. Loops to catch up a bill that's been
        overdue for several cycles in one pass.
        """
        today = today or date.today()
        changed = False
        for _ in range(24):  # safety bound - enough to catch up years of a monthly bill
            generated_this_pass = False
            for bill in list(self.bills):
                if bill.frequency == Frequency.ONE_TIME:
                    continue
                try:
                    due = date.fromisoformat(bill.due_date)
                except ValueError:
                    continue
                if due >= today:
                    continue
                if self._generate_recurring_bill(bill) is not None:
                    generated_this_pass = True
                    changed = True
            if not generated_this_pass:
                break
        if changed:
            await self._async_save()
        return changed

    async def _mark_bill_paid(self, bill: Bill, payment_date: str, notes: str = "") -> Payment:
        payment = Payment(
            id=new_id(), bill_id=bill.id, date=payment_date, type=PaymentType.NORMAL, notes=notes
        )
        self.payments.append(payment)
        bill.status = BillStatus.PAID
        await self._maybe_generate_recurring(bill)
        return payment

    async def async_mark_paid_normal(
        self, bill_id: str, payment_date: str, notes: str = ""
    ) -> Payment:
        bill = self._get_bill(bill_id)
        payment = await self._mark_bill_paid(bill, payment_date, notes)
        await self._async_save()
        return payment

    async def async_clear_all_bills(
        self, payment_date: str, exclude_bill_ids: list[str] | None = None
    ) -> list[Payment]:
        """Mark every not-yet-paid bill due this month as paid, in one action.

        Marks bills paid rather than deleting them. household_summary and
        category_totals sum whatever's currently in self.bills for the
        month, so deleting a bill to "clear" it drops it out of that sum
        entirely - it looks like it vanished from the budget instead of
        showing settled. Marking it paid keeps it counted.
        """
        excluded = set(exclude_bill_ids or [])
        month = _current_month(date.today())
        payments = []
        for bill in self.bills:
            if bill.month == month and bill.id not in excluded and bill.status != BillStatus.PAID:
                payments.append(await self._mark_bill_paid(bill, payment_date))
        if payments:
            await self._async_save()
        return payments

    async def _async_record_contribution_payment(
        self,
        bill_id: str,
        contributions: list[dict[str, Any]],
        payment_date: str,
        notes: str,
        payment_type: PaymentType,
    ) -> Payment:
        bill = self._get_bill(bill_id)
        contribution_objs = [
            Contribution(member_id=c["member_id"], amount=c["amount"]) for c in contributions
        ]
        payment = Payment(
            id=new_id(),
            bill_id=bill_id,
            date=payment_date,
            type=payment_type,
            contributions=contribution_objs,
            notes=notes,
        )
        self.payments.append(payment)

        total_paid = payments_total_for_bill(bill_id, self.payments)
        bill.status = status_from_contribution_total(total_paid, bill.total_amount)
        await self._maybe_generate_recurring(bill)
        await self._async_save()
        return payment

    async def async_mark_paid_individual(
        self, bill_id: str, contributions: list[dict[str, Any]], payment_date: str, notes: str = ""
    ) -> Payment:
        return await self._async_record_contribution_payment(
            bill_id, contributions, payment_date, notes, PaymentType.INDIVIDUAL
        )

    async def async_mark_paid_partial(
        self, bill_id: str, contributions: list[dict[str, Any]], payment_date: str, notes: str = ""
    ) -> Payment:
        return await self._async_record_contribution_payment(
            bill_id, contributions, payment_date, notes, PaymentType.PARTIAL
        )

    async def async_defer_bill(
        self, bill_id: str, deferred_until: str, reason: str, notes: str = ""
    ) -> Bill:
        bill = self._get_bill(bill_id)
        bill.status = BillStatus.DEFERRED
        bill.deferred_until = deferred_until
        bill.deferred_reason = reason
        if notes:
            bill.notes = notes
        await self._async_save()
        return bill

    def _get_payment(self, payment_id: str) -> Payment:
        for payment in self.payments:
            if payment.id == payment_id:
                return payment
        raise ValueError(f"Unknown payment_id {payment_id}")

    def _resync_bill_status_for_payment(self, bill_id: str) -> None:
        bill = self._get_bill(bill_id)
        total_paid = payments_total_for_bill(bill_id, self.payments)
        bill.status = status_after_late_fee(bill, total_paid, date.today())

    async def async_edit_payment(
        self,
        payment_id: str,
        payment_date: str | None = None,
        notes: str | None = None,
        contributions: list[dict[str, Any]] | None = None,
    ) -> Payment:
        payment = self._get_payment(payment_id)
        if payment_date is not None:
            payment.date = payment_date
        if notes is not None:
            payment.notes = notes
        if contributions is not None:
            # A normal payment has no per-member breakdown by definition - it
            # covers the bill in full, so there's nothing here to reassign.
            if payment.type == PaymentType.NORMAL:
                raise ValueError("Paid Normally records have no contributions to edit")
            payment.contributions = [
                Contribution(member_id=c["member_id"], amount=float(c["amount"]))
                for c in contributions
            ]
        self._resync_bill_status_for_payment(payment.bill_id)
        await self._async_save()
        return payment

    async def async_delete_payment(self, payment_id: str) -> None:
        payment = self._get_payment(payment_id)
        bill_id = payment.bill_id
        self.payments = [p for p in self.payments if p.id != payment_id]
        self._resync_bill_status_for_payment(bill_id)
        await self._async_save()

    # ---------------------------------------------------------------- misc

    def get_settlement(self, month: str):
        return compute_settlement(
            month, self.bills, self.payments, self.members, self.responsibility_method
        )

    # ------------------------------------------------------------ rollover

    async def async_trigger_monthly_rollover(self) -> None:
        today = date.today()
        previous_month = _current_month(today - timedelta(days=today.day))
        month_bills = [b for b in self.bills if b.month == previous_month]
        month_payments = [p for p in self.payments if p.date.startswith(previous_month)]

        self.archive[previous_month] = {
            "bills": [b.to_dict() for b in month_bills],
            "payments": [p.to_dict() for p in month_payments],
            "settlement": self.get_settlement(previous_month).to_dict(),
        }

        await self._async_save()
