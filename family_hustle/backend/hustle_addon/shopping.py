"""The Shopping tab: a Home Assistant to-do list, shared with the rest of
Home Assistant.

The list itself lives in Home Assistant - by default `todo.shopping_list`
(HA's built-in Shopping List integration), or whichever `todo.*` list a
parent picks (`calendar_settings["shopping_list"]`). So an item added here
shows up in the HA app's to-do lists and Assist ("add milk to the shopping
list"), and the other way round. Family Hustle keeps no copy; it reads
through `todo.get_items` and writes through the other `todo.*` services.

Any linked member can add, check off and remove items - kids included -
since the whole family shops from it. Choosing the list is a parent's
(`update_calendar_settings`, with the other HA entities the app uses).
The Meals tab's grocery list feeds it through `shopping_add_items`.
"""
from __future__ import annotations

import logging
import re
from typing import Any

import voluptuous as vol

from . import validation as cv
from .coordinator import HustleCoordinator
from .ha_client import HomeAssistantClient, HomeAssistantError
from .services import Handler, ServiceCall, ServiceError, _require_member

_LOGGER = logging.getLogger(__name__)

_TODO_ENTITY = re.compile(r"^todo\.[a-z0-9_]+$")

STATUS_NEEDS_ACTION = "needs_action"
STATUS_COMPLETED = "completed"


class ShoppingUnavailable(ServiceError):
    """Home Assistant (and so every to-do list) isn't reachable - always the
    case on a dev run outside Supervisor."""


def todo_entity(value: Any) -> str:
    value = cv.string(value)
    if not _TODO_ENTITY.match(value):
        raise vol.Invalid(f"{value} is not a to-do list")
    return value


def normalize_item(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "uid": raw.get("uid"),
        "summary": raw.get("summary") or "",
        "status": raw.get("status") or STATUS_NEEDS_ACTION,
        "description": raw.get("description") or "",
    }


class ShoppingList:
    def __init__(self, ha: HomeAssistantClient | None, coordinator: HustleCoordinator) -> None:
        self._ha = ha
        self._coordinator = coordinator

    def _client(self) -> HomeAssistantClient:
        if self._ha is None:
            raise ShoppingUnavailable("To-do lists need Home Assistant - not available here.")
        return self._ha

    @property
    def entity_id(self) -> str:
        entity_id = self._coordinator.calendar_settings.get("shopping_list")
        if not entity_id:
            raise ServiceError("Pick a shopping list in the Shopping tab's settings first.")
        return entity_id

    async def _call(
        self, service: str, data: dict[str, Any], *, return_response: bool = False
    ) -> dict[str, Any] | None:
        try:
            return await self._client().call_service(
                "todo", service, {"entity_id": self.entity_id, **data},
                return_response=return_response,
            )
        except HomeAssistantError as err:
            raise ServiceError(f"The shopping list didn't take that: {err}") from err

    async def list_lists(self) -> list[dict[str, Any]]:
        """Every `todo.*` entity Home Assistant has: `[{entity_id, name}]`."""
        try:
            states = await self._client().get_states()
        except HomeAssistantError as err:
            raise ServiceError(f"Couldn't list to-do lists: {err}") from err
        lists = [
            {
                "entity_id": s["entity_id"],
                "name": (s.get("attributes") or {}).get("friendly_name") or s["entity_id"],
            }
            for s in states
            if _TODO_ENTITY.match(str(s.get("entity_id", "")))
        ]
        return sorted(lists, key=lambda item: str(item["name"]).lower())

    async def items(self) -> dict[str, Any]:
        entity_id = self.entity_id
        response = await self._call("get_items", {}, return_response=True) or {}
        raw = (response.get(entity_id) or {}).get("items") or []
        return {"entity_id": entity_id, "items": [normalize_item(i) for i in raw]}

    async def add_items(self, summaries: list[str]) -> int:
        """Skips blanks and anything already on the list unchecked, so
        sending a grocery list twice doesn't double everything up."""
        current = {
            i["summary"].strip().lower()
            for i in (await self.items())["items"]
            if i["status"] == STATUS_NEEDS_ACTION
        }
        added = 0
        for summary in summaries:
            summary = summary.strip()
            if not summary or summary.lower() in current:
                continue
            await self._call("add_item", {"item": summary})
            current.add(summary.lower())
            added += 1
        return added

    async def update_item(
        self, uid: str, rename: str | None = None, status: str | None = None
    ) -> None:
        data: dict[str, Any] = {"item": uid}
        if rename is not None:
            data["rename"] = rename
        if status is not None:
            data["status"] = status
        await self._call("update_item", data)

    async def remove_items(self, uids: list[str]) -> None:
        if uids:
            await self._call("remove_item", {"item": uids})

    async def clear_completed(self) -> None:
        await self._call("remove_completed_items", {})


SERVICE_SHOPPING_ADD_ITEMS = "shopping_add_items"
SERVICE_SHOPPING_UPDATE_ITEM = "shopping_update_item"
SERVICE_SHOPPING_REMOVE_ITEMS = "shopping_remove_items"
SERVICE_SHOPPING_CLEAR_COMPLETED = "shopping_clear_completed"

SCHEMAS = {
    SERVICE_SHOPPING_ADD_ITEMS: vol.Schema(
        {vol.Required("items"): vol.All(cv.ensure_list, [cv.string])}
    ),
    SERVICE_SHOPPING_UPDATE_ITEM: vol.Schema(
        {
            vol.Required("uid"): cv.string,
            vol.Optional("rename"): vol.All(cv.string, vol.Length(min=1)),
            vol.Optional("status"): vol.In([STATUS_NEEDS_ACTION, STATUS_COMPLETED]),
        }
    ),
    SERVICE_SHOPPING_REMOVE_ITEMS: vol.Schema(
        {vol.Required("uids"): vol.All(cv.ensure_list, [cv.string])}
    ),
    SERVICE_SHOPPING_CLEAR_COMPLETED: vol.Schema({}),
}


def build_handlers(coordinator: HustleCoordinator, shopping: ShoppingList) -> dict[str, Handler]:
    async def handle_add_items(call: ServiceCall) -> dict[str, Any]:
        _require_member(coordinator, call)
        return {"added": await shopping.add_items(call.data["items"])}

    async def handle_update_item(call: ServiceCall) -> None:
        _require_member(coordinator, call)
        await shopping.update_item(
            call.data["uid"], call.data.get("rename"), call.data.get("status")
        )

    async def handle_remove_items(call: ServiceCall) -> None:
        _require_member(coordinator, call)
        await shopping.remove_items(call.data["uids"])

    async def handle_clear_completed(call: ServiceCall) -> None:
        _require_member(coordinator, call)
        await shopping.clear_completed()

    return {
        SERVICE_SHOPPING_ADD_ITEMS: handle_add_items,
        SERVICE_SHOPPING_UPDATE_ITEM: handle_update_item,
        SERVICE_SHOPPING_REMOVE_ITEMS: handle_remove_items,
        SERVICE_SHOPPING_CLEAR_COMPLETED: handle_clear_completed,
    }
