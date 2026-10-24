"""The Meals tab - the Household integration (`ha-household`), moved in.

Same jobs as before: a weekly dinner board read from a dedicated "Dinners"
calendar, an AI meal-plan wizard (Dinner Planning or Meal Prep), accepted
meals scheduled onto that calendar as all-day events, moving a dinner to
another day, and a grocery list that stays viewable after the wizard
closes.

What changed in the move:
- The dinners calendar is `calendar_settings["dinners_calendar"]` (set in
  the panel, or imported from Household's config entry - see migrate.py)
  instead of a config-flow field.
- The board is read on demand (web.py's `api/meals/week`) rather than a
  30-minute polling sensor, so a scheduled or moved dinner shows up
  immediately - the whole reason Household's `_refresh_dinner_menu` dance
  existed.
- Moving a dinner deletes and re-creates it through the
  `calendar/event/*` websocket commands (FamilyCalendar), since
  Household's `calendar.delete_event` service isn't one Home Assistant
  has.
- API keys: add-on options first, then secrets.yaml (`openai_api_key` /
  `anthropic_api_key`), instead of the integration's options flow.
- The grocery list lives in the Hustle store (`coordinator.grocery_list`).
- Only parents run these (AI calls cost money and the calendar is shared);
  picking the dinners calendar is for admin parents, like every setting.

The AI calls themselves - prompts, JSON schemas, OpenAI Structured Outputs
vs Anthropic's single-forced-tool idiom - are Household's `ai_client.py`
unchanged.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta
from typing import Any

import aiohttp
import voluptuous as vol
import yaml

from . import validation as cv
from .config import AddonConfig
from .coordinator import HustleCoordinator
from .family_calendar import FamilyCalendar
from .services import Handler, ServiceCall, ServiceError, _require_parent

_LOGGER = logging.getLogger(__name__)

PROVIDER_OPENAI = "openai"
PROVIDER_ANTHROPIC = "anthropic"

OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_CHAT_MODEL = "gpt-4o-mini"

ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_API_VERSION = "2023-06-01"
ANTHROPIC_CHAT_MODEL = "claude-sonnet-5"

MEAL_PLAN_MODES = ["dinner_planning", "meal_prep"]


class AIError(ServiceError):
    """Any failure calling, or parsing the response of, the AI provider -
    shown in the wizard's error banner as-is."""


# ------------------------------------------------------------------ keys


def _parse_secrets_yaml(text: str, key: str) -> str | None:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    value = data.get(key)
    return str(value) if value else None


def _read_secrets_key(config: AddonConfig, key: str) -> str | None:
    path = config.ha_config_dir / "secrets.yaml"
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return _parse_secrets_yaml(text, key)


async def resolve_key(config: AddonConfig, option: str) -> str | None:
    """The add-on option if set, else the same-named secrets.yaml entry
    (what the Household and Hustle integrations both fell back to)."""
    configured = getattr(config, option, "")
    if configured:
        return configured
    return await asyncio.to_thread(_read_secrets_key, config, option)


async def resolve_provider_and_key(config: AddonConfig) -> tuple[str, str]:
    """With one key available there's nothing to choose; with both, the
    `ai_provider` option picks, defaulting to OpenAI."""
    openai_key = await resolve_key(config, "openai_api_key")
    anthropic_key = await resolve_key(config, "anthropic_api_key")
    configured = [
        (provider, key)
        for provider, key in (
            (PROVIDER_OPENAI, openai_key),
            (PROVIDER_ANTHROPIC, anthropic_key),
        )
        if key
    ]
    if not configured:
        raise AIError(
            "No AI provider API key is configured - set an OpenAI and/or Anthropic API "
            "key under Settings > Add-ons > Family Hustle > Configuration, or add "
            "openai_api_key/anthropic_api_key to secrets.yaml."
        )
    for provider, key in configured:
        if provider == config.ai_provider:
            return provider, key
    return configured[0]


# --------------------------------------------------------------- providers


async def _call_openai(
    session: aiohttp.ClientSession,
    api_key: str,
    system_prompt: str,
    user_prompt: str,
    schema: dict,
    schema_name: str,
) -> dict:
    payload = {
        "model": OPENAI_CHAT_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema_name, "strict": True, "schema": schema},
        },
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    try:
        async with session.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=60),
        ) as resp:
            body = await resp.json()
            if resp.status != 200:
                message = (body.get("error") or {}).get("message", f"HTTP {resp.status}")
                raise AIError(f"OpenAI request failed: {message}")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise AIError(f"Could not reach OpenAI: {err}") from err

    try:
        return json.loads(body["choices"][0]["message"]["content"])
    except (KeyError, IndexError, json.JSONDecodeError) as err:
        _LOGGER.error("Unexpected OpenAI response shape: %s", body)
        raise AIError("OpenAI returned an unexpected response") from err


async def _call_anthropic(
    session: aiohttp.ClientSession,
    api_key: str,
    system_prompt: str,
    user_prompt: str,
    schema: dict,
    schema_name: str,
) -> dict:
    payload = {
        "model": ANTHROPIC_CHAT_MODEL,
        "max_tokens": 4096,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
        "tools": [
            {
                "name": schema_name,
                "description": f"Return the {schema_name} result.",
                "input_schema": schema,
            }
        ],
        "tool_choice": {"type": "tool", "name": schema_name},
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "Content-Type": "application/json",
    }

    try:
        async with session.post(
            ANTHROPIC_MESSAGES_URL,
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=60),
        ) as resp:
            body = await resp.json()
            if resp.status != 200:
                message = (body.get("error") or {}).get("message", f"HTTP {resp.status}")
                raise AIError(f"Anthropic request failed: {message}")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise AIError(f"Could not reach Anthropic: {err}") from err

    try:
        for block in body["content"]:
            if block.get("type") == "tool_use":
                return block["input"]
    except (KeyError, TypeError) as err:
        _LOGGER.error("Unexpected Anthropic response shape: %s", body)
        raise AIError("Anthropic returned an unexpected response") from err

    _LOGGER.error("Anthropic response had no tool_use block: %s", body)
    raise AIError("Anthropic returned an unexpected response")


async def _generate_json(
    session: aiohttp.ClientSession,
    config: AddonConfig,
    system_prompt: str,
    user_prompt: str,
    schema: dict,
    schema_name: str,
) -> dict:
    provider, api_key = await resolve_provider_and_key(config)
    if provider == PROVIDER_ANTHROPIC:
        return await _call_anthropic(
            session, api_key, system_prompt, user_prompt, schema, schema_name
        )
    return await _call_openai(session, api_key, system_prompt, user_prompt, schema, schema_name)


# ------------------------------------------------------------- meal planning

_MEAL_PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "meals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["name", "description"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["meals"],
    "additionalProperties": False,
}

_MEAL_PLAN_SYSTEM_PROMPT = (
    "You are a home meal-planning assistant helping a family decide what to "
    "cook. Respond only with the requested JSON - no commentary."
)


def _meal_plan_prompt(
    mode: str,
    servings: int,
    days: int,
    count: int,
    preferences: str | None,
    exclude_names: list[str],
) -> str:
    if mode == "meal_prep":
        goal = (
            f"Suggest {count} candidate meal-prep dish(es). Each dish must be a single "
            f"recipe substantial and freezer/fridge-friendly enough to be portioned out "
            f"and eaten across all {days} days of the period - not {days} different meals."
        )
    else:
        goal = (
            f"Suggest {count} different dinner recipes, intended as one distinct meal per "
            f"day across a {days}-day span."
        )

    lines = [goal, f"Each recipe should serve {servings} people."]
    if preferences:
        lines.append(f"Preferences/constraints from the family: {preferences}")
    if exclude_names:
        lines.append(
            "Do not suggest any of these meals again - they've already been shown this "
            "session: " + ", ".join(exclude_names)
        )
    lines.append(
        "For each meal, give a short, appealing name and a one-sentence description."
    )
    return "\n".join(lines)


async def generate_meal_plan(
    session: aiohttp.ClientSession,
    config: AddonConfig,
    mode: str,
    servings: int,
    days: int,
    count: int,
    preferences: str | None,
    exclude_names: list[str],
) -> list[dict]:
    prompt = _meal_plan_prompt(mode, servings, days, count, preferences, exclude_names)
    result = await _generate_json(
        session, config, _MEAL_PLAN_SYSTEM_PROMPT, prompt, _MEAL_PLAN_SCHEMA, "meal_plan"
    )
    return result.get("meals", [])


# ------------------------------------------------------------ grocery lists

_GROCERY_LIST_SCHEMA = {
    "type": "object",
    "properties": {
        "categories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string"},
                    "items": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["category", "items"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["categories"],
    "additionalProperties": False,
}

_GROCERY_LIST_SYSTEM_PROMPT = (
    "You are a home meal-planning assistant building a grocery list from a set of "
    "accepted meals. Respond only with the requested JSON - no commentary."
)


def _grocery_list_prompt(meals: list[dict], servings: int) -> str:
    meal_lines = "\n".join(f"- {m['name']}: {m.get('description', '')}" for m in meals)
    return (
        f"Build a categorized grocery list (e.g. Produce, Meat & Seafood, Dairy, Pantry, "
        f"Bakery, Frozen, etc.) covering every ingredient needed to cook all of the meals "
        f"below, each for {servings} people. Combine duplicate ingredients across meals "
        f"into a single line with a combined quantity where sensible, rather than listing "
        f"the same ingredient once per meal.\n\nMeals:\n{meal_lines}"
    )


async def generate_grocery_list(
    session: aiohttp.ClientSession, config: AddonConfig, meals: list[dict], servings: int
) -> list[dict]:
    prompt = _grocery_list_prompt(meals, servings)
    result = await _generate_json(
        session, config, _GROCERY_LIST_SYSTEM_PROMPT, prompt, _GROCERY_LIST_SCHEMA, "grocery_list"
    )
    return result.get("categories", [])


# ------------------------------------------------------------- dinner board


def dinner_week(events: list[dict[str, Any]], today: date) -> list[dict[str, Any]]:
    """Calendar events -> the board's `[{date, dish, notes, is_today, uid}]`
    (Household's `sensor.household_dinner_menu` `week` attribute). Only the
    start day matters for slotting a dinner into the week."""
    week = []
    for event in events:
        start = event["start"]
        try:
            day = (
                date.fromisoformat(start)
                if event["all_day"]
                else datetime.fromisoformat(start).astimezone().date()
            )
        except ValueError:
            continue
        week.append(
            {
                "date": day.isoformat(),
                "dish": event["summary"],
                "notes": event["description"] or None,
                "is_today": day == today,
                "uid": event["uid"],
            }
        )
    week.sort(key=lambda entry: entry["date"])
    return week


async def load_dinner_week(
    calendar: FamilyCalendar, coordinator: HustleCoordinator
) -> dict[str, Any]:
    entity_id = coordinator.calendar_settings.get("dinners_calendar")
    if not entity_id:
        return {"calendar_entity": None, "week": [], "errors": []}
    today = datetime.now().astimezone().date()
    result = await calendar.events([entity_id], today, today + timedelta(days=7))
    return {
        "calendar_entity": entity_id,
        "week": dinner_week(result["events"], today),
        "errors": result["errors"],
    }


# ---------------------------------------------------------------- services

_MEAL_SCHEMA = vol.Schema(
    {vol.Required("name"): cv.string, vol.Optional("description", default=""): cv.string}
)


def _date(value: Any) -> date:
    try:
        return date.fromisoformat(cv.string(value))
    except ValueError as err:
        raise vol.Invalid(f"invalid date {value}") from err


SERVICE_GENERATE_MEAL_PLAN = "generate_meal_plan"
SERVICE_GENERATE_GROCERY_LIST = "generate_grocery_list"
SERVICE_SCHEDULE_MEALS = "schedule_meals"
SERVICE_MOVE_MEAL = "move_meal"
SERVICE_REMOVE_MEAL = "remove_meal"

SCHEMAS = {
    SERVICE_GENERATE_MEAL_PLAN: vol.Schema(
        {
            vol.Required("mode"): vol.In(MEAL_PLAN_MODES),
            vol.Required("servings"): vol.Coerce(int),
            vol.Required("days"): vol.Coerce(int),
            vol.Required("count"): vol.Coerce(int),
            vol.Optional("preferences"): cv.string,
            vol.Optional("exclude_meal_names", default=list): vol.All(
                cv.ensure_list, [cv.string]
            ),
        }
    ),
    SERVICE_GENERATE_GROCERY_LIST: vol.Schema(
        {
            vol.Required("meals"): vol.All(cv.ensure_list, [_MEAL_SCHEMA]),
            vol.Required("servings"): vol.Coerce(int),
        }
    ),
    SERVICE_SCHEDULE_MEALS: vol.Schema(
        {
            vol.Required("meals"): vol.All(
                cv.ensure_list,
                [
                    vol.Schema(
                        {
                            vol.Required("name"): cv.string,
                            vol.Optional("description", default=""): cv.string,
                            vol.Required("date"): _date,
                        }
                    )
                ],
            )
        }
    ),
    SERVICE_MOVE_MEAL: vol.Schema(
        {
            vol.Required("uid"): cv.string,
            vol.Required("name"): cv.string,
            vol.Optional("description", default=""): cv.string,
            vol.Required("new_date"): _date,
        }
    ),
    SERVICE_REMOVE_MEAL: vol.Schema({vol.Required("uid"): cv.string}),
}


def build_handlers(
    coordinator: HustleCoordinator,
    calendar: FamilyCalendar,
    session: aiohttp.ClientSession,
    config: AddonConfig,
) -> dict[str, Handler]:
    def _dinners_calendar() -> str:
        entity_id = coordinator.calendar_settings.get("dinners_calendar")
        if not entity_id:
            raise ServiceError("Pick a Dinners calendar in the Meals tab's settings first.")
        return entity_id

    async def _add_dinner(entity_id: str, name: str, description: str, day: date) -> None:
        # All-day, with end = the next day: the end date is EXCLUSIVE, and
        # Google shows a zero-length all-day event as nothing at all.
        await calendar.create_event(
            entity_id,
            name,
            day.isoformat(),
            (day + timedelta(days=1)).isoformat(),
            True,
            description,
        )

    async def handle_generate_meal_plan(call: ServiceCall) -> dict[str, Any]:
        _require_parent(coordinator, call)
        meals = await generate_meal_plan(
            session,
            config,
            call.data["mode"],
            call.data["servings"],
            call.data["days"],
            call.data["count"],
            call.data.get("preferences"),
            call.data["exclude_meal_names"],
        )
        return {"meals": meals}

    async def handle_generate_grocery_list(call: ServiceCall) -> dict[str, Any]:
        _require_parent(coordinator, call)
        categories = await generate_grocery_list(
            session, config, call.data["meals"], call.data["servings"]
        )
        await coordinator.async_save_grocery_list(categories)
        return {"categories": categories}

    async def handle_schedule_meals(call: ServiceCall) -> dict[str, Any]:
        _require_parent(coordinator, call)
        entity_id = _dinners_calendar()
        for meal in call.data["meals"]:
            await _add_dinner(entity_id, meal["name"], meal["description"], meal["date"])
        return {"scheduled": len(call.data["meals"])}

    async def handle_move_meal(call: ServiceCall) -> dict[str, Any]:
        """Delete then re-create - not atomic, but a failure in between just
        needs the dinner re-added, same as Household."""
        _require_parent(coordinator, call)
        entity_id = _dinners_calendar()
        try:
            await calendar.delete_event(entity_id, call.data["uid"])
        except ServiceError as err:
            raise ServiceError(f"Could not remove the existing event: {err}") from err
        await _add_dinner(
            entity_id, call.data["name"], call.data["description"], call.data["new_date"]
        )
        return {"moved": True}

    async def handle_remove_meal(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await calendar.delete_event(_dinners_calendar(), call.data["uid"])

    return {
        SERVICE_GENERATE_MEAL_PLAN: handle_generate_meal_plan,
        SERVICE_GENERATE_GROCERY_LIST: handle_generate_grocery_list,
        SERVICE_SCHEDULE_MEALS: handle_schedule_meals,
        SERVICE_MOVE_MEAL: handle_move_meal,
        SERVICE_REMOVE_MEAL: handle_remove_meal,
    }
