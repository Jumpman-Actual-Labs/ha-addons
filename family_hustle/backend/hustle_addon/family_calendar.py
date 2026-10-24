"""The Calendar tab: the family's Google Calendar, with each event tagged
with who it's for and who's attending.

Events stay in Home Assistant's calendars - normally the family's Google
Calendar through HA's own Google Calendar integration, but any `calendar.*`
entity works. Family Hustle reads them through Core's REST API, adds and
deletes them through its `calendar/event/*` websocket commands, and never
keeps its own copy. The only thing it stores is the tags
(`coordinator.event_tags`), keyed by `event_tag_key` - calendar entity +
the event's `uid`. A recurring event's instances share one `uid`, so
tagging "Soccer practice" tags every week of it.

Kept out of Google on purpose: writing tags into event descriptions would
show up as clutter in everyone's Google Calendar and break when someone
edits the description there.

Reading is open to any linked member; adding, deleting and tagging
events is for parents (the same `_require_parent` guard the chore services
use), and the settings - which calendars, the dinners calendar, the
shopping list - for admin parents only.

New events can repeat: `rrule` is an iCalendar RRULE (`FREQ=WEEKLY;
BYDAY=TU,TH`), passed straight through to the calendar - Google expands
it, and the reads come back as individual occurrences sharing the uid.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from typing import Any

import voluptuous as vol

from . import validation as cv
from .coordinator import HustleCoordinator
from .ha_client import HomeAssistantClient, HomeAssistantError
from .services import (
    Handler,
    ServiceCall,
    ServiceError,
    _require_parent,
    _require_parent_admin,
)
from .shopping import todo_entity

_LOGGER = logging.getLogger(__name__)

_CALENDAR_ENTITY = re.compile(r"^calendar\.[a-z0-9_]+$")
# FREQ first, then any of the RRULE parts the panel builds (BYDAY, INTERVAL,
# COUNT, UNTIL, BYMONTHDAY...) - letters, digits, commas, signs only.
_RRULE = re.compile(
    r"^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+\-]+)*$"
)


class CalendarUnavailable(ServiceError):
    """Home Assistant (and so every calendar) isn't reachable - always the
    case on a dev run outside Supervisor."""


def calendar_entity(value: Any) -> str:
    value = cv.string(value)
    if not _CALENDAR_ENTITY.match(value):
        raise vol.Invalid(f"{value} is not a calendar entity")
    return value


def rrule(value: Any) -> str:
    value = cv.string(value).strip().upper().removeprefix("RRULE:")
    if not _RRULE.match(value):
        raise vol.Invalid(f"{value} is not a repeat rule this calendar understands")
    return value


def event_tag_key(entity_id: str, uid: str) -> str:
    return f"{entity_id}|{uid}"


def _parse_when(value: dict[str, Any] | str | None) -> tuple[str | None, bool]:
    """Core's `{"date": ...}` / `{"dateTime": ...}` (or a bare string) ->
    (ISO string, all_day)."""
    if isinstance(value, dict):
        if value.get("dateTime"):
            return str(value["dateTime"]), False
        if value.get("date"):
            return str(value["date"]), True
        return None, False
    if isinstance(value, str):
        return value, len(value) == 10
    return None, False


def normalize_event(
    raw: dict[str, Any],
    entity_id: str,
    calendar_name: str,
    event_tags: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """One event as the panel uses it, with its tags merged in. None for an
    event without a start (nothing to place on the grid)."""
    start, all_day = _parse_when(raw.get("start"))
    end, _ = _parse_when(raw.get("end"))
    if start is None:
        return None
    uid = raw.get("uid")
    tags = event_tags.get(event_tag_key(entity_id, uid), {}) if uid else {}
    return {
        "entity_id": entity_id,
        "calendar_name": calendar_name,
        "uid": uid,
        "recurrence_id": raw.get("recurrence_id"),
        "rrule": raw.get("rrule"),
        "summary": raw.get("summary") or "",
        "description": raw.get("description") or "",
        "location": raw.get("location") or "",
        "start": start,
        "end": end or start,
        "all_day": all_day,
        "for_member_id": tags.get("for_member_id"),
        "attendee_ids": tags.get("attendee_ids", []),
    }


def event_window(start: date, end: date) -> tuple[str, str]:
    """[start, end) dates -> the local-time ISO bounds Core's calendar API
    takes."""
    tz = datetime.now().astimezone().tzinfo
    return (
        datetime.combine(start, datetime.min.time(), tzinfo=tz).isoformat(),
        datetime.combine(end, datetime.min.time(), tzinfo=tz).isoformat(),
    )


def _same_start(event_start: str | None, wanted: str, all_day: bool) -> bool:
    if event_start is None:
        return False
    if all_day:
        return event_start[:10] == wanted[:10]
    try:
        return datetime.fromisoformat(event_start) == datetime.fromisoformat(wanted)
    except ValueError:
        return event_start == wanted


class FamilyCalendar:
    def __init__(self, ha: HomeAssistantClient | None, coordinator: HustleCoordinator) -> None:
        self._ha = ha
        self._coordinator = coordinator

    def _client(self) -> HomeAssistantClient:
        if self._ha is None:
            raise CalendarUnavailable("Calendars need Home Assistant - not available here.")
        return self._ha

    async def list_calendars(self) -> list[dict[str, Any]]:
        try:
            calendars = await self._client().get_calendars()
        except HomeAssistantError as err:
            raise ServiceError(f"Couldn't list calendars: {err}") from err
        return sorted(
            (
                {"entity_id": c.get("entity_id"), "name": c.get("name") or c.get("entity_id")}
                for c in calendars
                if c.get("entity_id")
            ),
            key=lambda c: str(c["name"]).lower(),
        )

    async def events(self, entity_ids: list[str], start: date, end: date) -> dict[str, Any]:
        """Every event on `entity_ids` overlapping [start, end), tagged.
        One calendar failing (removed, Google unreachable) doesn't hide the
        others - it's reported in `errors` instead."""
        client = self._client()
        try:
            names = {c["entity_id"]: c["name"] for c in await self.list_calendars()}
        except ServiceError:
            names = {}
        window_start, window_end = event_window(start, end)
        tags = self._coordinator.event_tags
        events: list[dict[str, Any]] = []
        errors: list[str] = []
        for entity_id in entity_ids:
            try:
                raw_events = await client.get_calendar_events(entity_id, window_start, window_end)
            except HomeAssistantError as err:
                _LOGGER.warning("Couldn't read %s: %s", entity_id, err)
                errors.append(f"{names.get(entity_id, entity_id)}: {err}")
                continue
            for raw in raw_events:
                event = normalize_event(raw, entity_id, names.get(entity_id, entity_id), tags)
                if event is not None:
                    events.append(event)
        events.sort(key=lambda e: (e["start"], e["summary"]))
        return {"events": events, "errors": errors}

    async def create_event(
        self,
        entity_id: str,
        summary: str,
        start: str,
        end: str,
        all_day: bool,
        description: str = "",
        location: str = "",
        repeat: str | None = None,
    ) -> str | None:
        """Adds the event and returns its uid - looked up afterwards, since
        `calendar/event/create` doesn't return one. None if it can't be
        found again (the event still exists; it just can't be tagged yet).
        `repeat` is an RRULE; a repeating event's first occurrence is the
        one found."""
        client = self._client()
        event: dict[str, Any] = {"summary": summary, "dtstart": start, "dtend": end}
        if description:
            event["description"] = description
        if location:
            event["location"] = location
        if repeat:
            event["rrule"] = repeat
        try:
            await client.ws_command(
                {"type": "calendar/event/create", "entity_id": entity_id, "event": event}
            )
        except HomeAssistantError as err:
            raise ServiceError(f"Couldn't add the event: {err}") from err

        first_day = date.fromisoformat(start[:10])
        window_start, window_end = event_window(first_day, first_day + timedelta(days=1))
        try:
            created = await client.get_calendar_events(entity_id, window_start, window_end)
        except HomeAssistantError:
            return None
        for raw in created:
            when, _ = _parse_when(raw.get("start"))
            if raw.get("summary") == summary and _same_start(when, start, all_day):
                return raw.get("uid")
        return None

    async def delete_event(
        self, entity_id: str, uid: str, recurrence_id: str | None = None
    ) -> None:
        message: dict[str, Any] = {
            "type": "calendar/event/delete",
            "entity_id": entity_id,
            "uid": uid,
        }
        if recurrence_id:
            message["recurrence_id"] = recurrence_id
        try:
            await self._client().ws_command(message)
        except HomeAssistantError as err:
            raise ServiceError(f"Couldn't delete the event: {err}") from err


def _event_bounds(data: dict[str, Any]) -> tuple[str, str]:
    """The service's `start`/`end` -> `dtstart`/`dtend`. All-day events
    take dates with an EXCLUSIVE end (iCalendar), so a one-day event ends
    the next day - Google otherwise shows nothing."""
    if data["all_day"]:
        start = date.fromisoformat(data["start"][:10])
        end = date.fromisoformat(data["end"][:10]) if data.get("end") else start
        if end <= start:
            end = start + timedelta(days=1)
        return start.isoformat(), end.isoformat()
    try:
        start_dt = datetime.fromisoformat(data["start"])
        end_dt = datetime.fromisoformat(data["end"]) if data.get("end") else None
    except ValueError as err:
        raise ServiceError(f"Invalid start/end: {err}") from err
    # No offset means the household's local time (the container's TZ).
    if start_dt.tzinfo is None:
        start_dt = start_dt.astimezone()
    if end_dt is not None and end_dt.tzinfo is None:
        end_dt = end_dt.astimezone()
    if end_dt is None or end_dt <= start_dt:
        end_dt = start_dt + timedelta(hours=1)
    return start_dt.isoformat(), end_dt.isoformat()


SERVICE_CREATE_EVENT = "create_event"
SERVICE_DELETE_EVENT = "delete_event"
SERVICE_TAG_EVENT = "tag_event"
SERVICE_UPDATE_CALENDAR_SETTINGS = "update_calendar_settings"

SCHEMAS = {
    SERVICE_CREATE_EVENT: vol.Schema(
        {
            vol.Optional("entity_id"): calendar_entity,
            vol.Required("summary"): cv.string,
            vol.Required("start"): cv.string,
            vol.Optional("end"): cv.string,
            vol.Optional("all_day", default=False): cv.boolean,
            vol.Optional("description", default=""): cv.string,
            vol.Optional("location", default=""): cv.string,
            vol.Optional("rrule"): vol.Any(rrule, None),
            vol.Optional("for_member_id"): vol.Any(cv.string, None),
            vol.Optional("attendee_ids", default=list): [cv.string],
        }
    ),
    SERVICE_DELETE_EVENT: vol.Schema(
        {
            vol.Required("entity_id"): calendar_entity,
            vol.Required("uid"): cv.string,
            vol.Optional("recurrence_id"): vol.Any(cv.string, None),
        }
    ),
    SERVICE_TAG_EVENT: vol.Schema(
        {
            vol.Required("entity_id"): calendar_entity,
            vol.Required("uid"): cv.string,
            vol.Optional("for_member_id"): vol.Any(cv.string, None),
            vol.Optional("attendee_ids", default=list): [cv.string],
        }
    ),
    SERVICE_UPDATE_CALENDAR_SETTINGS: vol.Schema(
        {
            vol.Optional("family_calendars"): [calendar_entity],
            vol.Optional("default_calendar"): vol.Any(calendar_entity, None),
            vol.Optional("dinners_calendar"): vol.Any(calendar_entity, None),
            vol.Optional("shopping_list"): vol.Any(todo_entity, None),
            vol.Optional("show_dinners"): cv.boolean,
        }
    ),
}


def build_handlers(
    coordinator: HustleCoordinator, calendar: FamilyCalendar
) -> dict[str, Handler]:
    async def handle_create_event(call: ServiceCall) -> dict[str, Any]:
        _require_parent(coordinator, call)
        entity_id = call.data.get("entity_id") or coordinator.calendar_settings.get(
            "default_calendar"
        )
        if not entity_id:
            raise ServiceError("Pick a calendar for new events in Calendar settings first.")
        start, end = _event_bounds(call.data)
        uid = await calendar.create_event(
            entity_id,
            call.data["summary"],
            start,
            end,
            call.data["all_day"],
            call.data["description"],
            call.data["location"],
            call.data.get("rrule"),
        )
        for_member_id = call.data.get("for_member_id")
        attendee_ids = call.data["attendee_ids"]
        if uid and (for_member_id or attendee_ids):
            await coordinator.async_set_event_tags(
                event_tag_key(entity_id, uid), for_member_id, attendee_ids
            )
        return {"uid": uid, "entity_id": entity_id}

    async def handle_delete_event(call: ServiceCall) -> None:
        _require_parent(coordinator, call)
        await calendar.delete_event(
            call.data["entity_id"], call.data["uid"], call.data.get("recurrence_id")
        )
        # A deleted single instance of a recurring event keeps the series'
        # tags - only drop them when the whole event is gone.
        if not call.data.get("recurrence_id"):
            await coordinator.async_remove_event_tags(
                event_tag_key(call.data["entity_id"], call.data["uid"])
            )

    async def handle_tag_event(call: ServiceCall) -> dict[str, Any]:
        _require_parent(coordinator, call)
        return await coordinator.async_set_event_tags(
            event_tag_key(call.data["entity_id"], call.data["uid"]),
            call.data.get("for_member_id"),
            call.data["attendee_ids"],
        )

    async def handle_update_calendar_settings(call: ServiceCall) -> dict[str, Any]:
        _require_parent_admin(coordinator, call)
        return await coordinator.async_update_calendar_settings(**call.data)

    return {
        SERVICE_CREATE_EVENT: handle_create_event,
        SERVICE_DELETE_EVENT: handle_delete_event,
        SERVICE_TAG_EVENT: handle_tag_event,
        SERVICE_UPDATE_CALENDAR_SETTINGS: handle_update_calendar_settings,
    }

