from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from .const import BillStatus, BillType, Frequency, PayFrequency, PaymentType


def new_id() -> str:
    return uuid.uuid4().hex


@dataclass
class IncomeEntry:
    month: str  # "YYYY-MM"
    amount: float

    def to_dict(self) -> dict:
        return {"month": self.month, "amount": self.amount}

    @staticmethod
    def from_dict(data: dict) -> IncomeEntry:
        return IncomeEntry(month=data["month"], amount=data["amount"])


@dataclass
class IncomeSource:
    """One named, concurrent stream of monthly income (e.g. a job, a side

    gig, rental income) for a member who earns from more than one place at
    once. Distinct from IncomeEntry, which tracks how a single income
    figure has changed over time.
    """

    id: str
    name: str
    amount: float  # monthly
    # How often this source is actually paid out. The dollar math never
    # depends on this - amount is always already converted to its monthly
    # equivalent - but it drives this source's own next-payday (see
    # logic.next_pay_dates_for_source) and lets the per-paycheck figure be
    # reconstructed for editing instead of asking for the monthly total again.
    pay_frequency: PayFrequency = PayFrequency.MONTHLY
    # MONTHLY: one day-of-month, e.g. [15]. SEMI_MONTHLY: two, e.g. [1, 15].
    # Unused for WEEKLY/BIWEEKLY, which use pay_anchor_date instead.
    pay_days: list[int] = field(default_factory=list)
    # A known past or upcoming pay date ("YYYY-MM-DD") that WEEKLY/BIWEEKLY
    # schedules are calculated relative to (every 7 or 14 days from here).
    pay_anchor_date: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "amount": self.amount,
            "pay_frequency": self.pay_frequency.value,
            "pay_days": self.pay_days,
            "pay_anchor_date": self.pay_anchor_date,
        }

    @staticmethod
    def from_dict(data: dict) -> IncomeSource:
        return IncomeSource(
            id=data["id"],
            name=data["name"],
            amount=data["amount"],
            pay_frequency=PayFrequency(data.get("pay_frequency", PayFrequency.MONTHLY.value)),
            pay_days=data.get("pay_days", []),
            pay_anchor_date=data.get("pay_anchor_date"),
        )


@dataclass
class Member:
    id: str
    name: str
    notes: str = ""
    income_history: list[IncomeEntry] = field(default_factory=list)
    # When non-empty, this is the source of truth for current_income() -
    # income_history becomes a dormant legacy trail for members who never
    # moved off the single-figure flow. Lets a member with several
    # concurrent income streams (job + side gig, etc.) track and name each
    # one instead of being forced to fold them into one number.
    income_sources: list[IncomeSource] = field(default_factory=list)
    pay_frequency: PayFrequency = PayFrequency.MONTHLY
    # MONTHLY: one day-of-month, e.g. [15]. SEMI_MONTHLY: two, e.g. [1, 15].
    # Unused for WEEKLY/BIWEEKLY, which use pay_anchor_date instead.
    pay_days: list[int] = field(default_factory=list)
    # A known past or upcoming pay date ("YYYY-MM-DD") that WEEKLY/BIWEEKLY
    # schedules are calculated relative to (every 7 or 14 days from here).
    pay_anchor_date: str | None = None
    # The HA user account (config/auth user id) this member corresponds to,
    # if any - used to gate income visibility to that user plus admins.
    ha_user_id: str | None = None

    def current_income(self) -> float:
        if self.income_sources:
            return round(sum(s.amount for s in self.income_sources), 2)
        if not self.income_history:
            return 0.0
        return sorted(self.income_history, key=lambda e: e.month)[-1].amount

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "notes": self.notes,
            "income_history": [e.to_dict() for e in self.income_history],
            "income_sources": [s.to_dict() for s in self.income_sources],
            "pay_frequency": self.pay_frequency.value,
            "pay_days": self.pay_days,
            "pay_anchor_date": self.pay_anchor_date,
            "ha_user_id": self.ha_user_id,
        }

    @staticmethod
    def from_dict(data: dict) -> Member:
        return Member(
            id=data["id"],
            name=data["name"],
            notes=data.get("notes", ""),
            income_history=[
                IncomeEntry.from_dict(e) for e in data.get("income_history", [])
            ],
            income_sources=[
                IncomeSource.from_dict(s) for s in data.get("income_sources", [])
            ],
            pay_frequency=PayFrequency(data.get("pay_frequency", PayFrequency.MONTHLY.value)),
            pay_days=data.get("pay_days", []),
            pay_anchor_date=data.get("pay_anchor_date"),
            ha_user_id=data.get("ha_user_id"),
        )


@dataclass
class Category:
    id: str
    name: str
    is_custom: bool = True
    planned_budget: float = 0.0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "is_custom": self.is_custom,
            "planned_budget": self.planned_budget,
        }

    @staticmethod
    def from_dict(data: dict) -> Category:
        return Category(
            id=data["id"],
            name=data["name"],
            is_custom=data.get("is_custom", True),
            planned_budget=data.get("planned_budget", 0.0),
        )


@dataclass
class Contribution:
    member_id: str
    amount: float

    def to_dict(self) -> dict:
        return {"member_id": self.member_id, "amount": self.amount}

    @staticmethod
    def from_dict(data: dict) -> Contribution:
        return Contribution(member_id=data["member_id"], amount=data["amount"])


@dataclass
class Payment:
    id: str
    bill_id: str
    date: str  # ISO date
    type: PaymentType
    contributions: list[Contribution] = field(default_factory=list)
    notes: str = ""

    @property
    def total(self) -> float:
        return sum(c.amount for c in self.contributions)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "bill_id": self.bill_id,
            "date": self.date,
            "type": self.type.value,
            "contributions": [c.to_dict() for c in self.contributions],
            "notes": self.notes,
        }

    @staticmethod
    def from_dict(data: dict) -> Payment:
        return Payment(
            id=data["id"],
            bill_id=data["bill_id"],
            date=data["date"],
            type=PaymentType(data["type"]),
            contributions=[
                Contribution.from_dict(c) for c in data.get("contributions", [])
            ],
            notes=data.get("notes", ""),
        )


@dataclass
class Bill:
    id: str
    name: str
    amount: float
    category_id: str
    due_date: str  # ISO date
    frequency: Frequency
    bill_type: BillType
    status: BillStatus = BillStatus.UNPAID
    notes: str = ""
    pay_to: str = ""  # company/payee name
    deferred_until: str | None = None
    deferred_reason: str | None = None
    recurring_parent_id: str | None = None
    month: str = ""  # "YYYY-MM" this instance belongs to
    manual_responsibility: dict[str, float] | None = None  # member_id -> pct override
    late_fee: float = 0.0  # total fees for this occurrence only
    responsible_member_id: str | None = None  # None = shared household bill

    @property
    def total_amount(self) -> float:
        return self.amount + self.late_fee

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "amount": self.amount,
            "category_id": self.category_id,
            "due_date": self.due_date,
            "frequency": self.frequency.value,
            "bill_type": self.bill_type.value,
            "status": self.status.value,
            "notes": self.notes,
            "pay_to": self.pay_to,
            "deferred_until": self.deferred_until,
            "deferred_reason": self.deferred_reason,
            "recurring_parent_id": self.recurring_parent_id,
            "month": self.month,
            "manual_responsibility": self.manual_responsibility,
            "late_fee": self.late_fee,
            "responsible_member_id": self.responsible_member_id,
        }

    @staticmethod
    def from_dict(data: dict) -> Bill:
        return Bill(
            id=data["id"],
            name=data["name"],
            amount=data["amount"],
            category_id=data["category_id"],
            due_date=data["due_date"],
            frequency=Frequency(data["frequency"]),
            bill_type=BillType(data["bill_type"]),
            status=BillStatus(data.get("status", BillStatus.UNPAID.value)),
            notes=data.get("notes", ""),
            pay_to=data.get("pay_to", ""),
            deferred_until=data.get("deferred_until"),
            deferred_reason=data.get("deferred_reason"),
            recurring_parent_id=data.get("recurring_parent_id"),
            month=data.get("month", ""),
            manual_responsibility=data.get("manual_responsibility"),
            late_fee=data.get("late_fee", 0.0),
            responsible_member_id=data.get("responsible_member_id") or None,
        )


@dataclass
class MemberSettlement:
    member_id: str
    responsible: float
    paid: float
    difference: float

    def to_dict(self) -> dict:
        return {
            "member_id": self.member_id,
            "responsible": self.responsible,
            "paid": self.paid,
            "difference": self.difference,
        }

    @staticmethod
    def from_dict(data: dict) -> MemberSettlement:
        return MemberSettlement(
            member_id=data["member_id"],
            responsible=data["responsible"],
            paid=data["paid"],
            difference=data["difference"],
        )


@dataclass
class Settlement:
    month: str
    member_balances: list[MemberSettlement] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "month": self.month,
            "member_balances": [b.to_dict() for b in self.member_balances],
        }

    @staticmethod
    def from_dict(data: dict) -> Settlement:
        return Settlement(
            month=data["month"],
            member_balances=[
                MemberSettlement.from_dict(b) for b in data.get("member_balances", [])
            ],
        )


@dataclass
class SavingsPlanEntry:
    month: str  # "YYYY-MM"
    amount: float

    def to_dict(self) -> dict:
        return {"month": self.month, "amount": self.amount}

    @staticmethod
    def from_dict(data: dict) -> SavingsPlanEntry:
        return SavingsPlanEntry(month=data["month"], amount=data["amount"])


@dataclass
class SavingsPlan:
    bill_id: str
    entries: list[SavingsPlanEntry] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "bill_id": self.bill_id,
            "entries": [e.to_dict() for e in self.entries],
        }

    @staticmethod
    def from_dict(data: dict) -> SavingsPlan:
        return SavingsPlan(
            bill_id=data["bill_id"],
            entries=[SavingsPlanEntry.from_dict(e) for e in data.get("entries", [])],
        )


@dataclass
class SavingsDeposit:
    id: str
    date: str  # "YYYY-MM-DD"
    amount: float
    notes: str = ""

    def to_dict(self) -> dict:
        return {"id": self.id, "date": self.date, "amount": self.amount, "notes": self.notes}

    @staticmethod
    def from_dict(data: dict) -> SavingsDeposit:
        return SavingsDeposit(
            id=data["id"],
            date=data["date"],
            amount=data["amount"],
            notes=data.get("notes", ""),
        )


@dataclass
class CashInfusion:
    id: str
    date: str  # "YYYY-MM-DD"
    amount: float
    source: str = ""
    contributions: list[Contribution] = field(default_factory=list)
    # If this infusion is a loan that needs paying back, the id of the
    # one-time Bill created to track that promise (None if no repayment).
    repayment_bill_id: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "date": self.date,
            "amount": self.amount,
            "source": self.source,
            "contributions": [c.to_dict() for c in self.contributions],
            "repayment_bill_id": self.repayment_bill_id,
        }

    @staticmethod
    def from_dict(data: dict) -> CashInfusion:
        return CashInfusion(
            id=data["id"],
            date=data["date"],
            amount=data["amount"],
            source=data.get("source", ""),
            contributions=[Contribution.from_dict(c) for c in data.get("contributions", [])],
            repayment_bill_id=data.get("repayment_bill_id"),
        )


@dataclass
class CategoryExpense:
    """A one-off, non-bill spend logged against a category's budget (e.g. gas under Auto)."""

    id: str
    category_id: str
    name: str
    amount: float
    date: str  # "YYYY-MM-DD"
    notes: str = ""
    month: str = ""  # "YYYY-MM" this instance belongs to, mirrors Bill.month

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "category_id": self.category_id,
            "name": self.name,
            "amount": self.amount,
            "date": self.date,
            "notes": self.notes,
            "month": self.month,
        }

    @staticmethod
    def from_dict(data: dict) -> CategoryExpense:
        return CategoryExpense(
            id=data["id"],
            category_id=data["category_id"],
            name=data["name"],
            amount=data["amount"],
            date=data["date"],
            notes=data.get("notes", ""),
            month=data.get("month", ""),
        )
