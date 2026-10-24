"""The Meals tab's recipe box.

Recipes live in the Hustle store (`coordinator.recipes`): a title,
description, servings, prep/cook minutes, ingredient lines, step lines,
tags, a source link and notes. Everyone in the family can read and cook
from them; adding, editing and deleting is for parents.

Dinners link to recipes by title - a dinner is a calendar event, and its
summary is the only thing guaranteed to survive Google - so planning a
recipe for a night just schedules a dinner with the recipe's title
(meals.py's `schedule_meals`), and the panel finds the recipe again by
matching titles.

`generate_recipe` asks the AI provider (meals.py's OpenAI/Anthropic
plumbing) to write a recipe from just a name, for the editor to fill in -
it saves nothing itself.
"""
from __future__ import annotations

from typing import Any

import aiohttp
import voluptuous as vol

from . import validation as cv
from .config import AddonConfig
from .coordinator import HustleCoordinator
from .meals import _generate_json
from .services import Handler, ServiceCall, _require_parent

MAX_LINES = 100


def _lines(value: Any) -> list[str]:
    """Ingredient/step/tag lists: strings, blanks dropped."""
    lines = [cv.string(v).strip() for v in cv.ensure_list(value)]
    lines = [line for line in lines if line]
    if len(lines) > MAX_LINES:
        raise vol.Invalid(f"at most {MAX_LINES} lines")
    return lines


def _minutes(value: Any) -> int | None:
    if value in (None, ""):
        return None
    minutes = int(value)
    if minutes < 0 or minutes > 7 * 24 * 60:
        raise vol.Invalid("minutes out of range")
    return minutes


_SERVINGS = vol.All(vol.Coerce(int), vol.Range(min=1, max=100))

RECIPE_FIELDS = {
    vol.Optional("description"): cv.string,
    vol.Optional("servings"): vol.Any(None, _SERVINGS),
    vol.Optional("prep_minutes"): _minutes,
    vol.Optional("cook_minutes"): _minutes,
    vol.Optional("ingredients"): _lines,
    vol.Optional("steps"): _lines,
    vol.Optional("tags"): _lines,
    vol.Optional("source_url"): cv.string,
    vol.Optional("notes"): cv.string,
}

# What a new recipe has when the form leaves a field out.
RECIPE_DEFAULTS: dict[str, Any] = {
    "description": "",
    "servings": None,
    "prep_minutes": None,
    "cook_minutes": None,
    "ingredients": [],
    "steps": [],
    "tags": [],
    "source_url": "",
    "notes": "",
}

SERVICE_ADD_RECIPE = "add_recipe"
SERVICE_UPDATE_RECIPE = "update_recipe"
SERVICE_DELETE_RECIPE = "delete_recipe"
SERVICE_GENERATE_RECIPE = "generate_recipe"

SCHEMAS = {
    SERVICE_ADD_RECIPE: vol.Schema({vol.Required("title"): cv.string, **RECIPE_FIELDS}),
    SERVICE_UPDATE_RECIPE: vol.Schema(
        {vol.Required("recipe_id"): cv.string, vol.Optional("title"): cv.string, **RECIPE_FIELDS}
    ),
    SERVICE_DELETE_RECIPE: vol.Schema({vol.Required("recipe_id"): cv.string}),
    SERVICE_GENERATE_RECIPE: vol.Schema(
        {
            vol.Required("title"): cv.string,
            vol.Optional("description", default=""): cv.string,
            vol.Optional("servings", default=4): _SERVINGS,
        }
    ),
}

# ------------------------------------------------------------- AI writer

_RECIPE_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string"},
        "servings": {"type": "integer"},
        "prep_minutes": {"type": "integer"},
        "cook_minutes": {"type": "integer"},
        "ingredients": {"type": "array", "items": {"type": "string"}},
        "steps": {"type": "array", "items": {"type": "string"}},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "description",
        "servings",
        "prep_minutes",
        "cook_minutes",
        "ingredients",
        "steps",
        "tags",
    ],
    "additionalProperties": False,
}

_RECIPE_SYSTEM_PROMPT = (
    "You are a home cook writing clear, reliable family recipes. Respond only "
    "with the requested JSON - no commentary."
)


def _recipe_prompt(title: str, description: str, servings: int) -> str:
    lines = [f'Write a recipe for "{title}" that serves {servings}.']
    if description:
        lines.append(f"What the family has in mind: {description}")
    lines.append(
        "Give a one-sentence description; realistic prep and cook times in minutes; "
        "ingredients one per line with quantities (e.g. '2 cups rice'); short, "
        "numbered-free cooking steps one per line, in order; and 1-3 short tags "
        "(e.g. 'Chicken', 'Quick', 'Vegetarian')."
    )
    return "\n".join(lines)


async def generate_recipe(
    session: aiohttp.ClientSession,
    config: AddonConfig,
    title: str,
    description: str,
    servings: int,
) -> dict[str, Any]:
    result = await _generate_json(
        session,
        config,
        _RECIPE_SYSTEM_PROMPT,
        _recipe_prompt(title, description, servings),
        _RECIPE_SCHEMA,
        "recipe",
    )
    return {key: result.get(key, RECIPE_DEFAULTS.get(key)) for key in _RECIPE_SCHEMA["required"]}


# --------------------------------------------------------------- handlers


def build_handlers(
    coordinator: HustleCoordinator,
    session: aiohttp.ClientSession | None,
    config: AddonConfig,
) -> dict[str, Handler]:
    async def handle_add_recipe(call: ServiceCall) -> dict[str, Any]:
        author = _require_parent(coordinator, call)
        recipe = await coordinator.async_add_recipe(
            created_by=author.id, **{**RECIPE_DEFAULTS, **call.data}
        )
        return {"recipe_id": recipe["id"]}

    async def handle_update_recipe(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        fields = {k: v for k, v in call.data.items() if k != "recipe_id"}
        await coordinator.async_update_recipe(call.data["recipe_id"], **fields)

    async def handle_delete_recipe(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await coordinator.async_delete_recipe(call.data["recipe_id"])

    async def handle_generate_recipe(call: ServiceCall) -> dict[str, Any]:
        _require_parent(coordinator, call)
        return await generate_recipe(
            session, config, call.data["title"], call.data["description"], call.data["servings"]
        )

    return {
        SERVICE_ADD_RECIPE: handle_add_recipe,
        SERVICE_UPDATE_RECIPE: handle_update_recipe,
        SERVICE_DELETE_RECIPE: handle_delete_recipe,
        SERVICE_GENERATE_RECIPE: handle_generate_recipe,
    }

