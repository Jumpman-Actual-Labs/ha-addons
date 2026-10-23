from __future__ import annotations

from enum import StrEnum

DOMAIN = "finance"
STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}_data"

SIGNAL_FINANCE_UPDATED = f"{DOMAIN}_updated"


class FinanceMode(StrEnum):
    SPLIT = "split"
    SHARED = "shared"


class ResponsibilityMethod(StrEnum):
    AUTOMATIC = "automatic"
    MANUAL = "manual"


class Frequency(StrEnum):
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    YEARLY = "yearly"
    ONE_TIME = "one_time"


class BillType(StrEnum):
    FIXED = "fixed"
    VARIABLE = "variable"
    DEBT = "debt"
    SUBSCRIPTION = "subscription"
    INSTALLMENT = "installment"


class BillStatus(StrEnum):
    UNPAID = "unpaid"
    PARTIALLY_PAID = "partially_paid"
    PAID = "paid"
    DEFERRED = "deferred"
    OVERDUE = "overdue"


class PaymentType(StrEnum):
    NORMAL = "normal"
    INDIVIDUAL = "individual"
    PARTIAL = "partial"


class PayFrequency(StrEnum):
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    SEMI_MONTHLY = "semi_monthly"
    MONTHLY = "monthly"


class SavingsType(StrEnum):
    PERCENT_OF_INCOME = "percent_of_income"
    PERCENT_OF_REMAINING = "percent_of_remaining"
    FIXED_AMOUNT = "fixed_amount"


DEFAULT_CATEGORIES: list[str] = [
    "Housing",
    "Utilities",
    "Insurance",
    "Debt",
    "Subscriptions",
    "Transportation",
    "Medical",
    "Childcare",
    "Entertainment",
    "Food",
    "Other",
]
