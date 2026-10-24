"""<verb>_<noun> services - one per coordinator mutation method, called by
the panel as `POST api/services/<name>` (see web.py) the same way it used to
call `hustle.<name>` through Home Assistant. `SCHEMAS` is carried over from
the integration unchanged (`validation.py` stands in for HA's
config_validation, imported as `cv`); the handlers too, apart from taking
the coordinator from a closure instead of `hass.data`.

Who's calling comes from ingress (web.py reads `X-Remote-User-Id`, which
only Supervisor's proxy can set) and reaches the handlers as
`call.context.user_id` - the same field HA's ServiceCall had, so
`_member_for_context` and the guards below work as they did.

Permission gating (`require_parent`/`require_parent_admin`/
`require_self_or_parent` in the original backend's auth/permissions.py)
lives here as guard checks at the top of each handler, before the
coordinator method is called - this keeps the coordinator methods
themselves callable from the config flow/background jobs without a
"who's asking" context, per the plan's auth-translation section.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import voluptuous as vol

from . import validation as cv
from .const import (
    CHORE_CATEGORIES,
    BehaviorCategory,
    MemberRole,
    OverdueAction,
    PermissionLevel,
    RecurrenceType,
    SplitRule,
)
from .coordinator import HustleCoordinator
from .models import Member

PAYDAY_RULE_SCHEMA = vol.Schema(
    {
        vol.Required("type"): vol.In(["weekly", "biweekly", "monthly"]),
        vol.Optional("day_of_week"): cv.string,
        vol.Optional("anchor_date"): cv.string,
        vol.Optional("day_of_month"): vol.Coerce(int),
    }
)
GRADE_SCALE_ENTRY_SCHEMA = vol.Schema(
    {
        vol.Required("letter"): cv.string,
        vol.Required("value_cents"): vol.Coerce(int),
        vol.Optional("sort_order", default=0): vol.Coerce(int),
    }
)

SERVICE_SETUP_HOUSEHOLD = "setup_household"
SERVICE_UPDATE_HOUSEHOLD = "update_household"
SERVICE_COMPLETE_SETUP = "complete_setup"
SERVICE_UPDATE_PAYROLL_CONFIG = "update_payroll_config"
SERVICE_ADD_MEMBER = "add_member"
SERVICE_UPDATE_MEMBER = "update_member"
SERVICE_DEACTIVATE_MEMBER = "deactivate_member"
SERVICE_ADD_CHORE_DEFINITION = "add_chore_definition"
SERVICE_UPDATE_CHORE_DEFINITION = "update_chore_definition"
SERVICE_REGENERATE_CHORE_IMAGE = "regenerate_chore_image"
SERVICE_ASSIGN_CHORE = "assign_chore"
SERVICE_SUBMIT_CHORE = "submit_chore"
SERVICE_APPROVE_CHORE = "approve_chore"
SERVICE_REJECT_CHORE = "reject_chore"
SERVICE_GENERATE_DUE_CHORE_OCCURRENCES = "generate_due_chore_occurrences"
SERVICE_ADD_BOUNTY = "add_bounty"
SERVICE_ADD_BOUNTY_FROM_CHORE = "add_bounty_from_chore"
SERVICE_CONVERT_ASSIGNMENT_TO_BOUNTY = "convert_assignment_to_bounty"
SERVICE_UPDATE_BOUNTY = "update_bounty"
SERVICE_CANCEL_BOUNTY = "cancel_bounty"
SERVICE_CLOSE_BOUNTY = "close_bounty"
SERVICE_ACCEPT_BOUNTY = "accept_bounty"
SERVICE_SUBMIT_BOUNTY_ACCEPTANCE = "submit_bounty_acceptance"
SERVICE_COMPLETE_BOUNTY_ACCEPTANCE = "complete_bounty_acceptance"
SERVICE_FINALIZE_BOUNTY_SPLIT = "finalize_bounty_split"
SERVICE_EXPIRE_STALE_BOUNTIES = "expire_stale_bounties"
SERVICE_UNASSIGN_ALL_CHORES = "unassign_all_chores"
SERVICE_REMOVE_ALL_BOUNTIES = "remove_all_bounties"
SERVICE_RESET_ACCOUNT_EARNINGS = "reset_account_earnings"
SERVICE_RESET_CURRENT_PERIOD_PAYCHECKS = "reset_current_period_paychecks"
SERVICE_ADD_SUBJECT = "add_subject"
SERVICE_UPDATE_SUBJECT = "update_subject"
SERVICE_UPDATE_GRADE_SCALE = "update_grade_scale"
SERVICE_RECORD_GRADE = "record_grade"
SERVICE_UPDATE_GRADE_ENTRY = "update_grade_entry"
SERVICE_DELETE_GRADE_ENTRY = "delete_grade_entry"
SERVICE_ADD_BEHAVIOR_TYPE = "add_behavior_type"
SERVICE_UPDATE_BEHAVIOR_TYPE = "update_behavior_type"
SERVICE_RECORD_BEHAVIOR_ENTRY = "record_behavior_entry"
SERVICE_DELETE_BEHAVIOR_ENTRY = "delete_behavior_entry"
SERVICE_GET_OR_CREATE_CURRENT_PERIOD = "get_or_create_current_period"
SERVICE_GENERATE_PAY_PERIOD = "generate_pay_period"
SERVICE_APPROVE_PAYCHECK = "approve_paycheck"
SERVICE_MARK_PAYCHECK_PAID = "mark_paycheck_paid"
# Add-on only - replaces the integration's config flow (see
# handle_setup_family).
SERVICE_SETUP_FAMILY = "setup_family"

SCHEMAS = {
    SERVICE_SETUP_HOUSEHOLD: vol.Schema(
        {
            vol.Required("name"): cv.string,
            vol.Required("payday_rule"): PAYDAY_RULE_SCHEMA,
            vol.Optional("recurrence", default="weekly"): vol.In(["weekly", "biweekly", "monthly"]),
            vol.Optional("currency", default="USD"): cv.string,
            vol.Optional("timezone", default="UTC"): cv.string,
            vol.Optional("requires_parent_approval", default=True): cv.boolean,
            vol.Optional("default_initiative_bonus_pct", default=30): vol.Coerce(int),
            vol.Optional("grade_values_cents"): dict,
        }
    ),
    SERVICE_UPDATE_HOUSEHOLD: vol.Schema(
        {
            vol.Optional("name"): cv.string,
            vol.Optional("currency"): cv.string,
            vol.Optional("timezone"): cv.string,
            vol.Optional("notify_service"): cv.string,
        }
    ),
    SERVICE_COMPLETE_SETUP: vol.Schema({}),
    SERVICE_UPDATE_PAYROLL_CONFIG: vol.Schema(
        {
            vol.Optional("payday_rule"): PAYDAY_RULE_SCHEMA,
            vol.Optional("recurrence"): vol.In(["weekly", "biweekly", "monthly"]),
            vol.Optional("requires_parent_approval"): cv.boolean,
            vol.Optional("approval_threshold_cents"): vol.Coerce(int),
            vol.Optional("auto_generate"): cv.boolean,
            vol.Optional("pay_parents_too"): cv.boolean,
            vol.Optional("default_initiative_bonus_pct"): vol.Coerce(int),
        }
    ),
    SERVICE_ADD_MEMBER: vol.Schema(
        {
            vol.Required("ha_user_id"): cv.string,
            vol.Required("ha_display_name"): cv.string,
            vol.Required("role"): vol.In([r.value for r in MemberRole]),
            vol.Optional("permission_level"): vol.In([p.value for p in PermissionLevel]),
            vol.Optional("date_of_birth"): cv.string,
            vol.Optional("avatar_color"): cv.string,
            vol.Optional("managed_child_ids"): [cv.string],
            vol.Optional("notify_target"): cv.string,
        }
    ),
    SERVICE_UPDATE_MEMBER: vol.Schema(
        {
            vol.Required("member_id"): cv.string,
            vol.Optional("ha_display_name"): cv.string,
            vol.Optional("role"): vol.In([r.value for r in MemberRole]),
            vol.Optional("permission_level"): vol.In([p.value for p in PermissionLevel]),
            vol.Optional("active"): cv.boolean,
            vol.Optional("date_of_birth"): cv.string,
            vol.Optional("avatar_color"): cv.string,
            vol.Optional("managed_child_ids"): [cv.string],
            vol.Optional("notify_target"): cv.string,
        }
    ),
    SERVICE_DEACTIVATE_MEMBER: vol.Schema({vol.Required("member_id"): cv.string}),
    SERVICE_ADD_CHORE_DEFINITION: vol.Schema(
        {
            vol.Required("title"): cv.string,
            vol.Optional("payout_cents", default=0): vol.Coerce(int),
            vol.Optional("description"): cv.string,
            vol.Optional("category"): vol.In(CHORE_CATEGORIES),
            vol.Optional("recurrence_type", default="none"): vol.In(
                [r.value for r in RecurrenceType]
            ),
            vol.Optional("recurrence_config"): dict,
            vol.Optional("is_bounty", default=False): cv.boolean,
            vol.Optional("is_repeatable", default=False): cv.boolean,
            vol.Optional("is_rotating", default=False): cv.boolean,
            vol.Optional("rotation_order"): [cv.string],
            vol.Optional("default_assignee_ids"): [cv.string],
            vol.Optional("age_min"): vol.Coerce(int),
            vol.Optional("age_max"): vol.Coerce(int),
            vol.Optional("requires_approval", default=True): cv.boolean,
            vol.Optional("prerequisite_ids"): [cv.string],
            vol.Optional("due_time"): cv.string,
            vol.Optional("available_from_time"): cv.string,
            vol.Optional("available_until_time"): cv.string,
            vol.Optional("overdue_action"): vol.In([a.value for a in OverdueAction]),
            vol.Optional("overdue_deduction_cents"): vol.Coerce(int),
            vol.Optional("overdue_bounty_hours"): vol.Coerce(int),
            vol.Optional("overdue_penalty_pct"): vol.Coerce(int),
        }
    ),
    SERVICE_UPDATE_CHORE_DEFINITION: vol.Schema(
        {
            vol.Required("definition_id"): cv.string,
            vol.Optional("title"): cv.string,
            vol.Optional("payout_cents"): vol.Coerce(int),
            vol.Optional("description"): cv.string,
            vol.Optional("category"): vol.In(CHORE_CATEGORIES),
            vol.Optional("recurrence_type"): vol.In([r.value for r in RecurrenceType]),
            vol.Optional("recurrence_config"): dict,
            vol.Optional("is_bounty"): cv.boolean,
            vol.Optional("is_repeatable"): cv.boolean,
            vol.Optional("is_rotating"): cv.boolean,
            vol.Optional("rotation_order"): [cv.string],
            vol.Optional("default_assignee_ids"): [cv.string],
            vol.Optional("age_min"): vol.Coerce(int),
            vol.Optional("age_max"): vol.Coerce(int),
            vol.Optional("requires_approval"): cv.boolean,
            vol.Optional("active"): cv.boolean,
            vol.Optional("prerequisite_ids"): [cv.string],
            vol.Optional("due_time"): cv.string,
            vol.Optional("available_from_time"): cv.string,
            vol.Optional("available_until_time"): cv.string,
            vol.Optional("overdue_action"): vol.In([a.value for a in OverdueAction]),
            vol.Optional("overdue_deduction_cents"): vol.Coerce(int),
            vol.Optional("overdue_bounty_hours"): vol.Coerce(int),
            vol.Optional("overdue_penalty_pct"): vol.Coerce(int),
        }
    ),
    SERVICE_REGENERATE_CHORE_IMAGE: vol.Schema({vol.Required("definition_id"): cv.string}),
    SERVICE_ASSIGN_CHORE: vol.Schema(
        {
            vol.Required("definition_id"): cv.string,
            vol.Optional("member_ids"): [cv.string],
            vol.Required("due_date"): cv.string,
        }
    ),
    SERVICE_SUBMIT_CHORE: vol.Schema(
        {
            vol.Required("assignment_id"): cv.string,
        }
    ),
    SERVICE_APPROVE_CHORE: vol.Schema({vol.Required("assignment_id"): cv.string}),
    SERVICE_REJECT_CHORE: vol.Schema(
        {vol.Required("assignment_id"): cv.string, vol.Required("reason"): cv.string}
    ),
    SERVICE_GENERATE_DUE_CHORE_OCCURRENCES: vol.Schema({}),
    SERVICE_ADD_BOUNTY: vol.Schema(
        {
            vol.Required("title"): cv.string,
            vol.Required("payout_cents"): vol.Coerce(int),
            vol.Required("available_at"): cv.string,
            vol.Required("deadline_at"): cv.string,
            vol.Optional("description"): cv.string,
            vol.Optional("initiative_bonus_pct"): vol.Coerce(int),
            vol.Optional("estimated_minutes"): vol.Coerce(int),
            vol.Optional("requires_approval", default=True): cv.boolean,
            vol.Optional("split_rule", default="first_come"): vol.In([s.value for s in SplitRule]),
            vol.Optional("is_repeatable", default=False): cv.boolean,
        }
    ),
    SERVICE_ADD_BOUNTY_FROM_CHORE: vol.Schema(
        {
            vol.Required("chore_definition_id"): cv.string,
            vol.Required("available_at"): cv.string,
            vol.Required("deadline_at"): cv.string,
            vol.Optional("payout_cents"): vol.Coerce(int),
            vol.Optional("initiative_bonus_pct"): vol.Coerce(int),
            vol.Optional("estimated_minutes"): vol.Coerce(int),
            vol.Optional("split_rule", default="first_come"): vol.In([s.value for s in SplitRule]),
            vol.Optional("is_repeatable", default=False): cv.boolean,
        }
    ),
    SERVICE_CONVERT_ASSIGNMENT_TO_BOUNTY: vol.Schema(
        {
            vol.Required("assignment_id"): cv.string,
            vol.Required("available_at"): cv.string,
            vol.Required("deadline_at"): cv.string,
            vol.Optional("initiative_bonus_pct"): vol.Coerce(int),
            vol.Optional("split_rule", default="first_come"): vol.In([s.value for s in SplitRule]),
            vol.Optional("is_repeatable", default=False): cv.boolean,
        }
    ),
    SERVICE_UPDATE_BOUNTY: vol.Schema(
        {
            vol.Required("bounty_id"): cv.string,
            vol.Optional("title"): cv.string,
            vol.Optional("description"): cv.string,
            vol.Optional("payout_cents"): vol.Coerce(int),
            vol.Optional("initiative_bonus_pct"): vol.Coerce(int),
            vol.Optional("available_at"): cv.string,
            vol.Optional("deadline_at"): cv.string,
            vol.Optional("estimated_minutes"): vol.Coerce(int),
            vol.Optional("requires_approval"): cv.boolean,
            vol.Optional("split_rule"): vol.In([s.value for s in SplitRule]),
            vol.Optional("is_repeatable"): cv.boolean,
        }
    ),
    SERVICE_CANCEL_BOUNTY: vol.Schema({vol.Required("bounty_id"): cv.string}),
    SERVICE_CLOSE_BOUNTY: vol.Schema({vol.Required("bounty_id"): cv.string}),
    SERVICE_ACCEPT_BOUNTY: vol.Schema({vol.Required("bounty_id"): cv.string}),
    SERVICE_SUBMIT_BOUNTY_ACCEPTANCE: vol.Schema(
        {
            vol.Required("bounty_id"): cv.string,
            vol.Required("member_id"): cv.string,
        }
    ),
    SERVICE_COMPLETE_BOUNTY_ACCEPTANCE: vol.Schema(
        {vol.Required("bounty_id"): cv.string, vol.Required("member_id"): cv.string}
    ),
    SERVICE_FINALIZE_BOUNTY_SPLIT: vol.Schema(
        {vol.Required("bounty_id"): cv.string, vol.Required("allocations"): dict}
    ),
    SERVICE_EXPIRE_STALE_BOUNTIES: vol.Schema({}),
    SERVICE_UNASSIGN_ALL_CHORES: vol.Schema({}),
    SERVICE_REMOVE_ALL_BOUNTIES: vol.Schema({}),
    SERVICE_RESET_CURRENT_PERIOD_PAYCHECKS: vol.Schema({}),
    SERVICE_RESET_ACCOUNT_EARNINGS: vol.Schema({vol.Required("confirm"): vol.In([True])}),
    SERVICE_ADD_SUBJECT: vol.Schema({vol.Required("name"): cv.string}),
    SERVICE_UPDATE_SUBJECT: vol.Schema(
        {
            vol.Required("subject_id"): cv.string,
            vol.Optional("name"): cv.string,
            vol.Optional("active"): cv.boolean,
        }
    ),
    SERVICE_UPDATE_GRADE_SCALE: vol.Schema(
        {vol.Required("entries"): [GRADE_SCALE_ENTRY_SCHEMA]}
    ),
    SERVICE_RECORD_GRADE: vol.Schema(
        {
            vol.Required("subject_id"): cv.string,
            vol.Required("member_id"): cv.string,
            vol.Required("grade_letter"): cv.string,
            vol.Required("period_label"): cv.string,
            vol.Optional("note"): cv.string,
        }
    ),
    SERVICE_UPDATE_GRADE_ENTRY: vol.Schema(
        {
            vol.Required("entry_id"): cv.string,
            vol.Optional("grade_letter"): cv.string,
            vol.Optional("period_label"): cv.string,
            vol.Optional("note"): cv.string,
        }
    ),
    SERVICE_DELETE_GRADE_ENTRY: vol.Schema({vol.Required("entry_id"): cv.string}),
    SERVICE_ADD_BEHAVIOR_TYPE: vol.Schema(
        {
            vol.Required("label"): cv.string,
            vol.Required("category"): vol.In([c.value for c in BehaviorCategory]),
            vol.Required("default_amount_cents"): vol.Coerce(int),
            vol.Optional("icon"): cv.string,
        }
    ),
    SERVICE_UPDATE_BEHAVIOR_TYPE: vol.Schema(
        {
            vol.Required("type_id"): cv.string,
            vol.Optional("label"): cv.string,
            vol.Optional("default_amount_cents"): vol.Coerce(int),
            vol.Optional("icon"): cv.string,
            vol.Optional("active"): cv.boolean,
        }
    ),
    SERVICE_RECORD_BEHAVIOR_ENTRY: vol.Schema(
        {
            vol.Required("behavior_type_id"): cv.string,
            vol.Required("member_id"): cv.string,
            vol.Optional("amount_cents"): vol.Coerce(int),
            vol.Optional("note"): cv.string,
        }
    ),
    SERVICE_DELETE_BEHAVIOR_ENTRY: vol.Schema({vol.Required("entry_id"): cv.string}),
    SERVICE_GET_OR_CREATE_CURRENT_PERIOD: vol.Schema({}),
    SERVICE_GENERATE_PAY_PERIOD: vol.Schema(
        {
            vol.Required("period_id"): cv.string,
            vol.Optional("regenerate", default=False): cv.boolean,
        }
    ),
    SERVICE_APPROVE_PAYCHECK: vol.Schema({vol.Required("paycheck_id"): cv.string}),
    SERVICE_MARK_PAYCHECK_PAID: vol.Schema({vol.Required("paycheck_id"): cv.string}),
    SERVICE_SETUP_FAMILY: vol.Schema(
        {
            vol.Required("name"): cv.string,
            vol.Required("display_name"): cv.string,
            vol.Required("payday_rule"): PAYDAY_RULE_SCHEMA,
            vol.Optional("recurrence", default="weekly"): vol.In(["weekly", "biweekly", "monthly"]),
            vol.Optional("requires_parent_approval", default=True): cv.boolean,
        }
    ),
}


class ServiceError(Exception):
    """Unknown service, invalid data, a refused permission, or a mutation
    the coordinator refused - web.py reports them all as a 400."""


class HomeAssistantError(ServiceError):
    """Name kept from the integration, so the guards read unchanged."""


class ServiceValidationError(HomeAssistantError):
    pass


@dataclass
class Context:
    user_id: str | None = None


@dataclass
class ServiceCall:
    """Stands in for HA's ServiceCall: validated `data`, plus who's calling.
    `user` is the viewer as web.py describes them (`id`, `name`,
    `is_admin`) - only setup_family needs more than `context.user_id`."""

    data: dict[str, Any]
    context: Context = field(default_factory=Context)
    user: dict[str, Any] | None = None


Handler = Callable[[ServiceCall], Awaitable[dict[str, Any] | None]]


def _require_member(coordinator: HustleCoordinator, call: ServiceCall) -> Member:
    member = coordinator._member_for_context(call.context)
    if member is None:
        raise ServiceValidationError(
            "No Hustle member is linked to your Home Assistant user account."
        )
    return member


def _require_parent(coordinator: HustleCoordinator, call: ServiceCall) -> Member:
    member = _require_member(coordinator, call)
    if member.role != MemberRole.PARENT:
        raise HomeAssistantError("This action can only be performed by a parent.")
    return member


def _require_parent_admin(coordinator: HustleCoordinator, call: ServiceCall) -> Member:
    member = _require_member(coordinator, call)
    if member.role != MemberRole.PARENT or member.permission_level != PermissionLevel.ADMIN:
        raise HomeAssistantError("This action requires a parent with admin permissions.")
    return member


def build_handlers(coordinator: HustleCoordinator) -> dict[str, Handler]:
    async def handle_setup_household(call: ServiceCall) -> None:
        await coordinator.async_setup_household(
            name=call.data["name"],
            payday_rule=call.data["payday_rule"],
            recurrence=call.data["recurrence"],
            currency=call.data["currency"],
            timezone=call.data["timezone"],
            requires_parent_approval=call.data["requires_parent_approval"],
            default_initiative_bonus_pct=call.data["default_initiative_bonus_pct"],
            grade_values_cents=call.data.get("grade_values_cents"),
        )

    async def handle_update_household(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        fields = dict(call.data)
        await coordinator.async_update_household(**fields)

    async def handle_complete_setup(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        await coordinator.async_complete_setup()

    async def handle_update_payroll_config(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        await coordinator.async_update_payroll_config(**dict(call.data))

    async def handle_add_member(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        await coordinator.async_add_member(
            ha_user_id=call.data["ha_user_id"],
            ha_display_name=call.data["ha_display_name"],
            role=call.data["role"],
            permission_level=call.data.get("permission_level"),
            date_of_birth=call.data.get("date_of_birth"),
            avatar_color=call.data.get("avatar_color"),
            managed_child_ids=call.data.get("managed_child_ids"),
            notify_target=call.data.get("notify_target"),
        )

    async def handle_update_member(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        fields = {k: v for k, v in call.data.items() if k != "member_id"}
        await coordinator.async_update_member(call.data["member_id"], **fields)

    async def handle_deactivate_member(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        await coordinator.async_deactivate_member(call.data["member_id"])

    async def handle_add_chore_definition(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        fields = dict(call.data)
        await coordinator.async_add_chore_definition(**fields)

    async def handle_update_chore_definition(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items() if k != "definition_id"}
        await coordinator.async_update_chore_definition(call.data["definition_id"], **fields)

    async def handle_regenerate_chore_image(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_regenerate_chore_image(call.data["definition_id"])

    async def handle_assign_chore(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_assign_chore(
            call.data["definition_id"], call.data.get("member_ids"), call.data["due_date"]
        )

    async def handle_submit_chore(call: ServiceCall) -> None:
        actor = _require_member(coordinator, call)
        await coordinator.async_submit_chore(call.data["assignment_id"], actor)

    async def handle_approve_chore(call: ServiceCall) -> None:
        approver = _require_parent(coordinator, call)
        await coordinator.async_approve_chore(call.data["assignment_id"], approver)

    async def handle_reject_chore(call: ServiceCall) -> None:
        approver = _require_parent(coordinator, call)
        await coordinator.async_reject_chore(
            call.data["assignment_id"], call.data["reason"], approver
        )

    async def handle_generate_due_chore_occurrences(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_generate_due_chore_occurrences()

    async def handle_add_bounty(call: ServiceCall) -> None:
        creator = _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items()}
        await coordinator.async_add_bounty(creator=creator, **fields)

    async def handle_add_bounty_from_chore(call: ServiceCall) -> None:
        creator = _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items()}
        await coordinator.async_add_bounty_from_chore(creator=creator, **fields)

    async def handle_update_bounty(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items() if k != "bounty_id"}
        await coordinator.async_update_bounty(call.data["bounty_id"], **fields)

    async def handle_cancel_bounty(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_cancel_bounty(call.data["bounty_id"])

    async def handle_close_bounty(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_close_bounty(call.data["bounty_id"])

    async def handle_accept_bounty(call: ServiceCall) -> None:
        member = _require_member(coordinator, call)
        await coordinator.async_accept_bounty(call.data["bounty_id"], member)

    async def handle_submit_bounty_acceptance(call: ServiceCall) -> None:
        actor = _require_member(coordinator, call)
        await coordinator.async_submit_bounty_acceptance(
            call.data["bounty_id"], call.data["member_id"], actor
        )

    async def handle_convert_assignment_to_bounty(call: ServiceCall) -> None:
        creator = _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items() if k != "assignment_id"}
        await coordinator.async_convert_assignment_to_bounty(
            call.data["assignment_id"], creator=creator, **fields
        )

    async def handle_complete_bounty_acceptance(call: ServiceCall) -> None:
        approver = _require_parent(coordinator, call)
        await coordinator.async_complete_bounty_acceptance(
            call.data["bounty_id"], call.data["member_id"], approver
        )

    async def handle_finalize_bounty_split(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_finalize_bounty_split(
            call.data["bounty_id"], call.data["allocations"]
        )

    async def handle_expire_stale_bounties(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_expire_stale_bounties()

    async def handle_unassign_all_chores(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        await coordinator.async_unassign_all_chores()

    async def handle_remove_all_bounties(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        await coordinator.async_remove_all_bounties()

    async def handle_reset_account_earnings(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        if call.data.get("confirm") is not True:
            raise ServiceValidationError("Explicit confirmation is required to reset earnings.")
        await coordinator.async_reset_account_earnings()

    async def handle_reset_current_period_paychecks(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        await coordinator.async_reset_current_period_paychecks()

    async def handle_add_subject(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_add_subject(call.data["name"])

    async def handle_update_subject(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items() if k != "subject_id"}
        await coordinator.async_update_subject(call.data["subject_id"], **fields)

    async def handle_update_grade_scale(call: ServiceCall) -> None:
        _require_parent_admin(coordinator, call)
        await coordinator.async_update_grade_scale(call.data["entries"])

    async def handle_record_grade(call: ServiceCall) -> None:
        recorder = _require_parent(coordinator, call)
        await coordinator.async_record_grade(
            call.data["subject_id"],
            call.data["member_id"],
            call.data["grade_letter"],
            call.data["period_label"],
            recorder,
            note=call.data.get("note"),
        )

    async def handle_update_grade_entry(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items() if k != "entry_id"}
        await coordinator.async_update_grade_entry(call.data["entry_id"], **fields)

    async def handle_delete_grade_entry(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_delete_grade_entry(call.data["entry_id"])

    async def handle_add_behavior_type(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_add_behavior_type(
            call.data["label"],
            call.data["category"],
            call.data["default_amount_cents"],
            call.data.get("icon"),
        )

    async def handle_update_behavior_type(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items() if k != "type_id"}
        await coordinator.async_update_behavior_type(call.data["type_id"], **fields)

    async def handle_record_behavior_entry(call: ServiceCall) -> None:
        recorder = _require_parent(coordinator, call)
        await coordinator.async_record_behavior_entry(
            call.data["behavior_type_id"],
            call.data["member_id"],
            recorder,
            amount_cents=call.data.get("amount_cents"),
            note=call.data.get("note"),
        )

    async def handle_delete_behavior_entry(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_delete_behavior_entry(call.data["entry_id"])

    async def handle_get_or_create_current_period(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_get_or_create_current_period()

    async def handle_generate_pay_period(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_generate_pay_period(call.data["period_id"], call.data["regenerate"])

    async def handle_approve_paycheck(call: ServiceCall) -> None:
        approver = _require_parent(coordinator, call)
        await coordinator.async_approve_paycheck(call.data["paycheck_id"], approver)

    async def handle_mark_paycheck_paid(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_mark_paycheck_paid(call.data["paycheck_id"])

    handlers = {
        SERVICE_SETUP_HOUSEHOLD: handle_setup_household,
        SERVICE_UPDATE_HOUSEHOLD: handle_update_household,
        SERVICE_COMPLETE_SETUP: handle_complete_setup,
        SERVICE_UPDATE_PAYROLL_CONFIG: handle_update_payroll_config,
        SERVICE_ADD_MEMBER: handle_add_member,
        SERVICE_UPDATE_MEMBER: handle_update_member,
        SERVICE_DEACTIVATE_MEMBER: handle_deactivate_member,
        SERVICE_ADD_CHORE_DEFINITION: handle_add_chore_definition,
        SERVICE_UPDATE_CHORE_DEFINITION: handle_update_chore_definition,
        SERVICE_REGENERATE_CHORE_IMAGE: handle_regenerate_chore_image,
        SERVICE_ASSIGN_CHORE: handle_assign_chore,
        SERVICE_SUBMIT_CHORE: handle_submit_chore,
        SERVICE_APPROVE_CHORE: handle_approve_chore,
        SERVICE_REJECT_CHORE: handle_reject_chore,
        SERVICE_GENERATE_DUE_CHORE_OCCURRENCES: handle_generate_due_chore_occurrences,
        SERVICE_ADD_BOUNTY: handle_add_bounty,
        SERVICE_ADD_BOUNTY_FROM_CHORE: handle_add_bounty_from_chore,
        SERVICE_CONVERT_ASSIGNMENT_TO_BOUNTY: handle_convert_assignment_to_bounty,
        SERVICE_UPDATE_BOUNTY: handle_update_bounty,
        SERVICE_CANCEL_BOUNTY: handle_cancel_bounty,
        SERVICE_CLOSE_BOUNTY: handle_close_bounty,
        SERVICE_ACCEPT_BOUNTY: handle_accept_bounty,
        SERVICE_SUBMIT_BOUNTY_ACCEPTANCE: handle_submit_bounty_acceptance,
        SERVICE_COMPLETE_BOUNTY_ACCEPTANCE: handle_complete_bounty_acceptance,
        SERVICE_FINALIZE_BOUNTY_SPLIT: handle_finalize_bounty_split,
        SERVICE_EXPIRE_STALE_BOUNTIES: handle_expire_stale_bounties,
        SERVICE_UNASSIGN_ALL_CHORES: handle_unassign_all_chores,
        SERVICE_REMOVE_ALL_BOUNTIES: handle_remove_all_bounties,
        SERVICE_RESET_CURRENT_PERIOD_PAYCHECKS: handle_reset_current_period_paychecks,
        SERVICE_RESET_ACCOUNT_EARNINGS: handle_reset_account_earnings,
        SERVICE_ADD_SUBJECT: handle_add_subject,
        SERVICE_UPDATE_SUBJECT: handle_update_subject,
        SERVICE_UPDATE_GRADE_SCALE: handle_update_grade_scale,
        SERVICE_RECORD_GRADE: handle_record_grade,
        SERVICE_UPDATE_GRADE_ENTRY: handle_update_grade_entry,
        SERVICE_DELETE_GRADE_ENTRY: handle_delete_grade_entry,
        SERVICE_ADD_BEHAVIOR_TYPE: handle_add_behavior_type,
        SERVICE_UPDATE_BEHAVIOR_TYPE: handle_update_behavior_type,
        SERVICE_RECORD_BEHAVIOR_ENTRY: handle_record_behavior_entry,
        SERVICE_DELETE_BEHAVIOR_ENTRY: handle_delete_behavior_entry,
        SERVICE_GET_OR_CREATE_CURRENT_PERIOD: handle_get_or_create_current_period,
        SERVICE_GENERATE_PAY_PERIOD: handle_generate_pay_period,
        SERVICE_APPROVE_PAYCHECK: handle_approve_paycheck,
        SERVICE_MARK_PAYCHECK_PAID: handle_mark_paycheck_paid,
    }

    async def handle_setup_family(call: ServiceCall) -> None:
        """First run, in place of the integration's "Add Integration" wizard:
        creates the household (unless the import brought one) and makes the
        caller its first parent admin. Only a Home Assistant admin, and only
        while nobody can manage the household yet - after that, members are
        added from Settings like before."""
        user = call.user or {}
        if not call.context.user_id or not user.get("is_admin"):
            raise HomeAssistantError(
                "Only a Home Assistant administrator can set up Family Hustle."
            )
        if any(
            m.active and m.role == MemberRole.PARENT and m.permission_level == PermissionLevel.ADMIN
            for m in coordinator.members
        ):
            raise HomeAssistantError("Family Hustle is already set up.")
        if coordinator.household is None or not coordinator.household.setup_completed:
            await coordinator.async_setup_household(
                name=call.data["name"],
                payday_rule=call.data["payday_rule"],
                recurrence=call.data["recurrence"],
                requires_parent_approval=call.data["requires_parent_approval"],
            )
        existing = next(
            (m for m in coordinator.members if m.ha_user_id == call.context.user_id), None
        )
        if existing is None:
            await coordinator.async_add_member(
                ha_user_id=call.context.user_id,
                ha_display_name=call.data["display_name"],
                role="parent",
                permission_level="admin",
            )
        else:
            await coordinator.async_update_member(
                existing.id, role="parent", permission_level="admin", active=True
            )
        if not coordinator.household.setup_completed:
            await coordinator.async_complete_setup()

    handlers[SERVICE_SETUP_FAMILY] = handle_setup_family
    return handlers


async def async_call_service(
    schemas: dict[str, vol.Schema],
    handlers: dict[str, Handler],
    name: str,
    data: dict[str, Any],
    user: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Validates `data` against the service's schema (the same voluptuous
    schemas Home Assistant used to apply before calling the handler) and
    runs it as `user`. Unknown names, schema failures, the guards' errors
    and the coordinator's own ValueErrors (unknown ids, wrong state) all
    raise ServiceError, so web.py reports every user-facing failure the
    same way."""
    handler = handlers.get(name)
    if handler is None:
        raise ServiceError(f"Unknown service: {name}")
    try:
        validated = schemas[name](data)
    except vol.Invalid as err:
        raise ServiceError(f"Invalid data for {name}: {err}") from err
    call = ServiceCall(
        data=dict(validated),
        context=Context(user_id=(user or {}).get("id") or None),
        user=user,
    )
    try:
        return await handler(call)
    except ValueError as err:
        raise ServiceError(str(err)) from err
