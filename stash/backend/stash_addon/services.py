"""<verb>_<noun> services - one per coordinator mutation method, called by
the panel as `POST api/services/<name>` (see web.py) the same way it used to
call `finance.<name>` through Home Assistant. `SCHEMAS` is carried over from
the integration unchanged (`validation.py` stands in for HA's
config_validation, imported as `cv`), so a field the panel sends that isn't
listed here fails with voluptuous's "extra keys not allowed".
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import voluptuous as vol

from . import validation as cv
from .const import BillType, FinanceMode, Frequency, PayFrequency, ResponsibilityMethod, SavingsType
from .coordinator import FinanceCoordinator


class ServiceError(Exception):
    """Unknown service, invalid data, or a mutation the coordinator refused."""


CONTRIBUTION_SCHEMA = vol.Schema(
    {vol.Required("member_id"): cv.string, vol.Required("amount"): vol.Coerce(float)}
)
SAVINGS_PLAN_ENTRY_SCHEMA = vol.Schema(
    {vol.Required("month"): cv.string, vol.Required("amount"): vol.Coerce(float)}
)

SERVICE_ADD_MEMBER = "add_member"
SERVICE_EDIT_MEMBER = "edit_member"
SERVICE_DELETE_MEMBER = "delete_member"
SERVICE_UPDATE_INCOME = "update_income"
SERVICE_ADD_INCOME_SOURCE = "add_income_source"
SERVICE_EDIT_INCOME_SOURCE = "edit_income_source"
SERVICE_DELETE_INCOME_SOURCE = "delete_income_source"
SERVICE_ADD_CATEGORY = "add_category"
SERVICE_SET_SAVINGS_PLAN = "set_savings_plan"
SERVICE_DELETE_CATEGORY = "delete_category"
SERVICE_SET_CATEGORY_BUDGET = "set_category_budget"
SERVICE_ADD_BILL = "add_bill"
SERVICE_EDIT_BILL = "edit_bill"
SERVICE_SET_BILL_LATE_FEE = "set_bill_late_fee"
SERVICE_DELETE_BILL = "delete_bill"
SERVICE_MARK_PAID_NORMAL = "mark_paid_normal"
SERVICE_MARK_PAID_INDIVIDUAL = "mark_paid_individual"
SERVICE_MARK_PAID_PARTIAL = "mark_paid_partial"
SERVICE_CLEAR_ALL_BILLS = "clear_all_bills"
SERVICE_EDIT_PAYMENT = "edit_payment"
SERVICE_DELETE_PAYMENT = "delete_payment"
SERVICE_DEFER_BILL = "defer_bill"
SERVICE_TRIGGER_MONTHLY_ROLLOVER = "trigger_monthly_rollover"
SERVICE_SET_MODE = "set_mode"
SERVICE_SET_RESPONSIBILITY_METHOD = "set_responsibility_method"
SERVICE_SET_SAVINGS_GOAL = "set_savings_goal"
SERVICE_ADD_SAVINGS_DEPOSIT = "add_savings_deposit"
SERVICE_ADD_CASH_INFUSION = "add_cash_infusion"
SERVICE_DELETE_CASH_INFUSION = "delete_cash_infusion"
SERVICE_ADD_CATEGORY_EXPENSE = "add_category_expense"
SERVICE_EDIT_CATEGORY_EXPENSE = "edit_category_expense"
SERVICE_DELETE_CATEGORY_EXPENSE = "delete_category_expense"

SCHEMAS = {
    SERVICE_ADD_MEMBER: vol.Schema(
        {
            vol.Required("name"): cv.string,
            vol.Optional("income", default=0): vol.Coerce(float),
            vol.Optional("notes", default=""): cv.string,
            vol.Optional("pay_frequency", default=PayFrequency.MONTHLY.value): vol.In(
                [f.value for f in PayFrequency]
            ),
            vol.Optional("pay_days"): [vol.Coerce(int)],
            vol.Optional("pay_anchor_date"): cv.string,
            vol.Optional("ha_user_id"): cv.string,
        }
    ),
    SERVICE_EDIT_MEMBER: vol.Schema(
        {
            vol.Required("member_id"): cv.string,
            vol.Optional("name"): cv.string,
            vol.Optional("notes"): cv.string,
            vol.Optional("pay_frequency"): vol.In([f.value for f in PayFrequency]),
            vol.Optional("pay_days"): [vol.Coerce(int)],
            vol.Optional("pay_anchor_date"): cv.string,
            vol.Optional("ha_user_id"): cv.string,
        }
    ),
    SERVICE_DELETE_MEMBER: vol.Schema({vol.Required("member_id"): cv.string}),
    SERVICE_UPDATE_INCOME: vol.Schema(
        {
            vol.Required("member_id"): cv.string,
            vol.Required("month"): cv.string,
            vol.Required("amount"): vol.Coerce(float),
        }
    ),
    SERVICE_ADD_INCOME_SOURCE: vol.Schema(
        {
            vol.Required("member_id"): cv.string,
            vol.Required("name"): cv.string,
            vol.Required("amount"): vol.Coerce(float),
            vol.Optional("pay_frequency", default=PayFrequency.MONTHLY.value): vol.In(
                [f.value for f in PayFrequency]
            ),
            vol.Optional("pay_days"): [vol.Coerce(int)],
            vol.Optional("pay_anchor_date"): cv.string,
        }
    ),
    SERVICE_EDIT_INCOME_SOURCE: vol.Schema(
        {
            vol.Required("member_id"): cv.string,
            vol.Required("source_id"): cv.string,
            vol.Optional("name"): cv.string,
            vol.Optional("amount"): vol.Coerce(float),
            vol.Optional("pay_frequency"): vol.In([f.value for f in PayFrequency]),
            vol.Optional("pay_days"): [vol.Coerce(int)],
            vol.Optional("pay_anchor_date"): cv.string,
        }
    ),
    SERVICE_DELETE_INCOME_SOURCE: vol.Schema(
        {
            vol.Required("member_id"): cv.string,
            vol.Required("source_id"): cv.string,
        }
    ),
    SERVICE_ADD_CATEGORY: vol.Schema({vol.Required("name"): cv.string}),
    SERVICE_SET_SAVINGS_PLAN: vol.Schema(
        {
            vol.Required("bill_id"): cv.string,
            vol.Required("entries"): [SAVINGS_PLAN_ENTRY_SCHEMA],
        }
    ),
    SERVICE_DELETE_CATEGORY: vol.Schema({vol.Required("category_id"): cv.string}),
    SERVICE_SET_CATEGORY_BUDGET: vol.Schema(
        {
            vol.Required("category_id"): cv.string,
            vol.Required("planned_budget"): vol.Coerce(float),
        }
    ),
    SERVICE_ADD_BILL: vol.Schema(
        {
            vol.Required("name"): cv.string,
            vol.Required("amount"): vol.Coerce(float),
            vol.Required("category_id"): cv.string,
            vol.Required("due_date"): cv.string,
            vol.Required("frequency"): vol.In([f.value for f in Frequency]),
            vol.Required("bill_type"): vol.In([t.value for t in BillType]),
            vol.Optional("notes", default=""): cv.string,
            vol.Optional("pay_to", default=""): cv.string,
            vol.Optional("manual_responsibility"): dict,
            vol.Optional("responsible_member_id"): cv.string,
        }
    ),
    SERVICE_EDIT_BILL: vol.Schema(
        {
            vol.Required("bill_id"): cv.string,
            vol.Optional("name"): cv.string,
            vol.Optional("amount"): vol.Coerce(float),
            vol.Optional("category_id"): cv.string,
            vol.Optional("due_date"): cv.string,
            vol.Optional("frequency"): vol.In([f.value for f in Frequency]),
            vol.Optional("bill_type"): vol.In([t.value for t in BillType]),
            vol.Optional("notes"): cv.string,
            vol.Optional("pay_to"): cv.string,
            vol.Optional("responsible_member_id"): cv.string,
        }
    ),
    SERVICE_SET_BILL_LATE_FEE: vol.Schema(
        {
            vol.Required("bill_id"): cv.string,
            vol.Required("amount"): vol.Coerce(float),
        }
    ),
    SERVICE_DELETE_BILL: vol.Schema({vol.Required("bill_id"): cv.string}),
    SERVICE_MARK_PAID_NORMAL: vol.Schema(
        {
            vol.Required("bill_id"): cv.string,
            vol.Required("payment_date"): cv.string,
            vol.Optional("notes", default=""): cv.string,
        }
    ),
    SERVICE_MARK_PAID_INDIVIDUAL: vol.Schema(
        {
            vol.Required("bill_id"): cv.string,
            vol.Required("contributions"): [CONTRIBUTION_SCHEMA],
            vol.Required("payment_date"): cv.string,
            vol.Optional("notes", default=""): cv.string,
        }
    ),
    SERVICE_MARK_PAID_PARTIAL: vol.Schema(
        {
            vol.Required("bill_id"): cv.string,
            vol.Required("contributions"): [CONTRIBUTION_SCHEMA],
            vol.Required("payment_date"): cv.string,
            vol.Optional("notes", default=""): cv.string,
        }
    ),
    SERVICE_CLEAR_ALL_BILLS: vol.Schema(
        {
            vol.Required("payment_date"): cv.string,
            vol.Optional("exclude_bill_ids"): [cv.string],
        }
    ),
    SERVICE_EDIT_PAYMENT: vol.Schema(
        {
            vol.Required("payment_id"): cv.string,
            vol.Optional("payment_date"): cv.string,
            vol.Optional("notes"): cv.string,
            vol.Optional("contributions"): [CONTRIBUTION_SCHEMA],
        }
    ),
    SERVICE_DELETE_PAYMENT: vol.Schema({vol.Required("payment_id"): cv.string}),
    SERVICE_DEFER_BILL: vol.Schema(
        {
            vol.Required("bill_id"): cv.string,
            vol.Required("deferred_until"): cv.string,
            vol.Required("reason"): cv.string,
            vol.Optional("notes", default=""): cv.string,
        }
    ),
    SERVICE_TRIGGER_MONTHLY_ROLLOVER: vol.Schema({}),
    SERVICE_SET_MODE: vol.Schema({vol.Required("mode"): cv.string}),
    SERVICE_SET_RESPONSIBILITY_METHOD: vol.Schema(
        {vol.Required("responsibility_method"): cv.string}
    ),
    SERVICE_SET_SAVINGS_GOAL: vol.Schema(
        {
            vol.Required("savings_type"): vol.In([t.value for t in SavingsType]),
            vol.Required("value"): vol.Coerce(float),
        }
    ),
    SERVICE_ADD_SAVINGS_DEPOSIT: vol.Schema(
        {
            vol.Required("amount"): vol.Coerce(float),
            vol.Required("deposit_date"): cv.string,
            vol.Optional("notes", default=""): cv.string,
        }
    ),
    SERVICE_ADD_CASH_INFUSION: vol.Schema(
        {
            vol.Required("amount"): vol.Coerce(float),
            vol.Required("infusion_date"): cv.string,
            vol.Optional("source", default=""): cv.string,
            vol.Optional("contributions"): [CONTRIBUTION_SCHEMA],
            vol.Optional("repayment_due_date"): cv.string,
            vol.Optional("repayment_entries"): [SAVINGS_PLAN_ENTRY_SCHEMA],
        }
    ),
    SERVICE_DELETE_CASH_INFUSION: vol.Schema({vol.Required("infusion_id"): cv.string}),
    SERVICE_ADD_CATEGORY_EXPENSE: vol.Schema(
        {
            vol.Required("category_id"): cv.string,
            vol.Required("name"): cv.string,
            vol.Required("amount"): vol.Coerce(float),
            vol.Required("expense_date"): cv.string,
            vol.Optional("notes", default=""): cv.string,
        }
    ),
    SERVICE_EDIT_CATEGORY_EXPENSE: vol.Schema(
        {
            vol.Required("expense_id"): cv.string,
            vol.Optional("name"): cv.string,
            vol.Optional("amount"): vol.Coerce(float),
            vol.Optional("date"): cv.string,
            vol.Optional("notes"): cv.string,
        }
    ),
    SERVICE_DELETE_CATEGORY_EXPENSE: vol.Schema({vol.Required("expense_id"): cv.string}),
}


Handler = Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]]

# Services that returned data to callers asking for it (Home Assistant's
# SupportsResponse.OPTIONAL) - Garage's Stash sync reads add_category_expense's.
RESPONDS_WITH_DATA = (
    SERVICE_ADD_CATEGORY_EXPENSE,
    SERVICE_CLEAR_ALL_BILLS,
    SERVICE_ADD_INCOME_SOURCE,
)


def build_handlers(coordinator: FinanceCoordinator) -> dict[str, Handler]:
    async def handle_add_member(data: dict[str, Any]) -> None:
        await coordinator.async_add_member(
            data["name"],
            data["income"],
            data["notes"],
            pay_frequency=PayFrequency(data["pay_frequency"]),
            pay_days=data.get("pay_days"),
            pay_anchor_date=data.get("pay_anchor_date"),
            ha_user_id=data.get("ha_user_id"),
        )

    async def handle_edit_member(data: dict[str, Any]) -> None:
        fields = {k: v for k, v in data.items() if k != "member_id"}
        await coordinator.async_edit_member(data["member_id"], **fields)

    async def handle_delete_member(data: dict[str, Any]) -> None:
        await coordinator.async_delete_member(data["member_id"])

    async def handle_update_income(data: dict[str, Any]) -> None:
        await coordinator.async_update_income(
            data["member_id"], data["month"], data["amount"]
        )

    async def handle_add_income_source(data: dict[str, Any]) -> dict:
        source = await coordinator.async_add_income_source(
            data["member_id"],
            data["name"],
            data["amount"],
            PayFrequency(data["pay_frequency"]),
            data.get("pay_days"),
            data.get("pay_anchor_date"),
        )
        return {"source_id": source.id}

    async def handle_edit_income_source(data: dict[str, Any]) -> None:
        fields = {k: v for k, v in data.items() if k not in ("member_id", "source_id")}
        await coordinator.async_edit_income_source(
            data["member_id"], data["source_id"], **fields
        )

    async def handle_delete_income_source(data: dict[str, Any]) -> None:
        await coordinator.async_delete_income_source(
            data["member_id"], data["source_id"]
        )

    async def handle_add_category(data: dict[str, Any]) -> None:
        await coordinator.async_add_category(data["name"])

    async def handle_set_savings_plan(data: dict[str, Any]) -> None:
        await coordinator.async_set_savings_plan(data["bill_id"], data["entries"])

    async def handle_delete_category(data: dict[str, Any]) -> None:
        await coordinator.async_delete_category(data["category_id"])

    async def handle_set_category_budget(data: dict[str, Any]) -> None:
        await coordinator.async_set_category_budget(
            data["category_id"], data["planned_budget"]
        )

    async def handle_add_bill(data: dict[str, Any]) -> None:
        await coordinator.async_add_bill(
            name=data["name"],
            amount=data["amount"],
            category_id=data["category_id"],
            due_date=data["due_date"],
            frequency=Frequency(data["frequency"]),
            bill_type=BillType(data["bill_type"]),
            notes=data["notes"],
            pay_to=data["pay_to"],
            manual_responsibility=data.get("manual_responsibility"),
            responsible_member_id=data.get("responsible_member_id"),
        )

    async def handle_edit_bill(data: dict[str, Any]) -> None:
        fields = {k: v for k, v in data.items() if k != "bill_id"}
        await coordinator.async_edit_bill(data["bill_id"], **fields)

    async def handle_set_bill_late_fee(data: dict[str, Any]) -> None:
        await coordinator.async_set_bill_late_fee(data["bill_id"], data["amount"])

    async def handle_delete_bill(data: dict[str, Any]) -> None:
        await coordinator.async_delete_bill(data["bill_id"])

    async def handle_mark_paid_normal(data: dict[str, Any]) -> None:
        await coordinator.async_mark_paid_normal(
            data["bill_id"], data["payment_date"], data["notes"]
        )

    async def handle_mark_paid_individual(data: dict[str, Any]) -> None:
        await coordinator.async_mark_paid_individual(
            data["bill_id"],
            data["contributions"],
            data["payment_date"],
            data["notes"],
        )

    async def handle_mark_paid_partial(data: dict[str, Any]) -> None:
        await coordinator.async_mark_paid_partial(
            data["bill_id"],
            data["contributions"],
            data["payment_date"],
            data["notes"],
        )

    async def handle_clear_all_bills(data: dict[str, Any]) -> dict:
        payments = await coordinator.async_clear_all_bills(
            data["payment_date"], data.get("exclude_bill_ids")
        )
        return {"cleared_count": len(payments)}

    async def handle_edit_payment(data: dict[str, Any]) -> None:
        await coordinator.async_edit_payment(
            data["payment_id"],
            payment_date=data.get("payment_date"),
            notes=data.get("notes"),
            contributions=data.get("contributions"),
        )

    async def handle_delete_payment(data: dict[str, Any]) -> None:
        await coordinator.async_delete_payment(data["payment_id"])

    async def handle_defer_bill(data: dict[str, Any]) -> None:
        await coordinator.async_defer_bill(
            data["bill_id"],
            data["deferred_until"],
            data["reason"],
            data["notes"],
        )

    async def handle_trigger_monthly_rollover(data: dict[str, Any]) -> None:
        await coordinator.async_trigger_monthly_rollover()

    async def handle_set_mode(data: dict[str, Any]) -> None:
        # The integration passed the raw string through, which then broke
        # saving (`self.mode.value`) - coerce it like every other enum here.
        await coordinator.async_set_mode(FinanceMode(data["mode"]))

    async def handle_set_responsibility_method(data: dict[str, Any]) -> None:
        await coordinator.async_set_responsibility_method(
            ResponsibilityMethod(data["responsibility_method"])
        )

    async def handle_set_savings_goal(data: dict[str, Any]) -> None:
        await coordinator.async_set_savings_goal(
            SavingsType(data["savings_type"]), data["value"]
        )

    async def handle_add_savings_deposit(data: dict[str, Any]) -> None:
        await coordinator.async_add_savings_deposit(
            data["amount"], data["deposit_date"], data["notes"]
        )

    async def handle_add_cash_infusion(data: dict[str, Any]) -> None:
        await coordinator.async_add_cash_infusion(
            data["amount"],
            data["infusion_date"],
            data["source"],
            data.get("contributions"),
            repayment_due_date=data.get("repayment_due_date"),
            repayment_entries=data.get("repayment_entries"),
        )

    async def handle_delete_cash_infusion(data: dict[str, Any]) -> None:
        await coordinator.async_delete_cash_infusion(data["infusion_id"])

    async def handle_add_category_expense(data: dict[str, Any]) -> dict:
        expense = await coordinator.async_add_category_expense(
            data["category_id"],
            data["name"],
            data["amount"],
            data["expense_date"],
            data["notes"],
        )
        # Response is optional (existing automations calling this without
        # expecting a response keep working) - but callers that need to link
        # back to the created expense (e.g. Garage's Finance sync) can ask
        # for one instead of re-querying to find what they just created.
        return {"expense_id": expense.id}

    async def handle_edit_category_expense(data: dict[str, Any]) -> None:
        data = dict(data)
        expense_id = data.pop("expense_id")
        await coordinator.async_edit_category_expense(expense_id, **data)

    async def handle_delete_category_expense(data: dict[str, Any]) -> None:
        await coordinator.async_delete_category_expense(data["expense_id"])

    return {
        SERVICE_ADD_MEMBER: handle_add_member,
        SERVICE_EDIT_MEMBER: handle_edit_member,
        SERVICE_DELETE_MEMBER: handle_delete_member,
        SERVICE_UPDATE_INCOME: handle_update_income,
        SERVICE_ADD_INCOME_SOURCE: handle_add_income_source,
        SERVICE_EDIT_INCOME_SOURCE: handle_edit_income_source,
        SERVICE_DELETE_INCOME_SOURCE: handle_delete_income_source,
        SERVICE_ADD_CATEGORY: handle_add_category,
        SERVICE_SET_SAVINGS_PLAN: handle_set_savings_plan,
        SERVICE_DELETE_CATEGORY: handle_delete_category,
        SERVICE_SET_CATEGORY_BUDGET: handle_set_category_budget,
        SERVICE_ADD_BILL: handle_add_bill,
        SERVICE_EDIT_BILL: handle_edit_bill,
        SERVICE_SET_BILL_LATE_FEE: handle_set_bill_late_fee,
        SERVICE_DELETE_BILL: handle_delete_bill,
        SERVICE_MARK_PAID_NORMAL: handle_mark_paid_normal,
        SERVICE_MARK_PAID_INDIVIDUAL: handle_mark_paid_individual,
        SERVICE_MARK_PAID_PARTIAL: handle_mark_paid_partial,
        SERVICE_CLEAR_ALL_BILLS: handle_clear_all_bills,
        SERVICE_EDIT_PAYMENT: handle_edit_payment,
        SERVICE_DELETE_PAYMENT: handle_delete_payment,
        SERVICE_DEFER_BILL: handle_defer_bill,
        SERVICE_TRIGGER_MONTHLY_ROLLOVER: handle_trigger_monthly_rollover,
        SERVICE_SET_MODE: handle_set_mode,
        SERVICE_SET_RESPONSIBILITY_METHOD: handle_set_responsibility_method,
        SERVICE_SET_SAVINGS_GOAL: handle_set_savings_goal,
        SERVICE_ADD_SAVINGS_DEPOSIT: handle_add_savings_deposit,
        SERVICE_ADD_CASH_INFUSION: handle_add_cash_infusion,
        SERVICE_DELETE_CASH_INFUSION: handle_delete_cash_infusion,
        SERVICE_ADD_CATEGORY_EXPENSE: handle_add_category_expense,
        SERVICE_EDIT_CATEGORY_EXPENSE: handle_edit_category_expense,
        SERVICE_DELETE_CATEGORY_EXPENSE: handle_delete_category_expense,
    }


async def async_call_service(
    handlers: dict[str, Handler], name: str, data: dict[str, Any]
) -> dict[str, Any] | None:
    """Validates `data` against the service's schema (the same voluptuous
    schemas Home Assistant used to apply before calling the handler) and
    runs it, returning the handler's response for RESPONDS_WITH_DATA
    services. Unknown names, schema failures and the coordinator's own
    ValueErrors (unknown ids) all raise ServiceError, so web.py
    reports every user-facing failure the same way."""
    handler = handlers.get(name)
    if handler is None:
        raise ServiceError(f"Unknown service: {name}")
    try:
        validated = SCHEMAS[name](data)
    except vol.Invalid as err:
        raise ServiceError(f"Invalid data for {name}: {err}") from err
    try:
        response = await handler(dict(validated))
    except ValueError as err:
        raise ServiceError(str(err)) from err
    return response if name in RESPONDS_WITH_DATA else None
