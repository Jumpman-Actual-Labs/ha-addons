"""Gains workouts on the Calendar tab.

The Gains add-on (same repository) owns training programs: each active
program's sessions fall on set weekdays, and Gains estimates how long each
takes. Family Hustle reads them from Gains' `internal/schedule`
(gains/backend/gains_addon/web.py - only this add-on may call it) over
Supervisor's add-on network, and shows each as an event for the athlete's
family member.

Gains has no idea of a time of day, so start times live here
(`coordinator.workout_times`): one for a single workout (`once`, keyed by
program + occurrence), or one for that program session every week
(`weekly`, keyed by program + session template - "every Monday's upper
body"). A workout with no start time is an all-day item; with one it runs
from then for Gains' estimated length.

The athlete sets their own times; parents can set anyone's. Without the
Gains add-on (not installed, stopped, or a dev run) the calendar just has
no workouts - that's not an error.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from typing import Any

import aiohttp
import voluptuous as vol

from . import validation as cv
from .coordinator import HustleCoordinator
from .services import (
    Handler,
    HomeAssistantError,
    ServiceCall,
    ServiceError,
    _require_member,
)

_LOGGER = logging.getLogger(__name__)

_TIMEOUT = aiohttp.ClientTimeout(total=15)
GAINS_PORT = 8099
# Supervisor names this container `<repository hash>-family-hustle` (the
# slug's underscore becomes a hyphen); Gains is `<repository hash>-gains`.
OWN_HOST_SLUG = "family-hustle"

WORKOUT_CALENDAR = "gains"
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class GainsUnavailable(Exception):
    """The Gains add-on isn't there to ask."""


def gains_base_url(own_hostname: str) -> str | None:
    """`a1b2c3d4-family-hustle` -> `http://a1b2c3d4-gains:8099`. None
    outside Supervisor."""
    suffix = f"-{OWN_HOST_SLUG}"
    if not own_hostname.endswith(suffix) or len(own_hostname) == len(suffix):
        return None
    return f"http://{own_hostname.removesuffix(suffix)}-gains:{GAINS_PORT}"


class GainsClient:
    def __init__(self, session: aiohttp.ClientSession, base_url: str) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")

    async def schedule(self, start: date, end: date) -> list[dict[str, Any]]:
        try:
            async with self._session.get(
                f"{self._base_url}/internal/schedule",
                params={"start": start.isoformat(), "end": end.isoformat()},
                timeout=_TIMEOUT,
            ) as resp:
                body = await resp.json(content_type=None)
                if resp.status >= 400:
                    raise GainsUnavailable(f"Gains refused the schedule ({resp.status})")
        except (TimeoutError, aiohttp.ClientError, ValueError) as err:
            raise GainsUnavailable(f"Gains add-on unreachable: {err}") from err
        return list((body or {}).get("workouts") or [])


def time_of_day(value: Any) -> str:
    value = cv.string(value).strip()
    if not _TIME.match(value):
        raise vol.Invalid("time must be HH:MM")
    return value


def once_key(program_id: str, occurrence_id: str) -> str:
    return f"{program_id}|{occurrence_id}"


def weekly_key(program_id: str, template_id: str) -> str:
    return f"{program_id}|{template_id}"


def workout_event(
    entry: dict[str, Any], times: dict[str, dict[str, str]], member_id: str | None
) -> dict[str, Any]:
    """One Gains workout as a calendar event (the shape normalize_event
    gives the panel), plus a `workout` block the panel uses instead of tags."""
    once = times.get("once", {}).get(once_key(entry["program_id"], entry["occurrence_id"]))
    weekly = times.get("weekly", {}).get(weekly_key(entry["program_id"], entry["template_id"]))
    start_time = once or weekly
    day = date.fromisoformat(entry["date"])
    minutes = int(entry.get("minutes") or 45)
    if start_time:
        hour, minute = (int(p) for p in start_time.split(":"))
        start_dt = datetime(day.year, day.month, day.day, hour, minute).astimezone()
        start, end, all_day = (
            start_dt.isoformat(),
            (start_dt + timedelta(minutes=minutes)).isoformat(),
            False,
        )
    else:
        start, end, all_day = day.isoformat(), (day + timedelta(days=1)).isoformat(), True
    return {
        "entity_id": WORKOUT_CALENDAR,
        "calendar_name": "Gains",
        "uid": once_key(entry["program_id"], entry["occurrence_id"]),
        "recurrence_id": None,
        "rrule": None,
        "summary": entry.get("name") or "Workout",
        "description": entry.get("program_name") or "",
        "location": "",
        "start": start,
        "end": end,
        "all_day": all_day,
        "for_member_id": member_id,
        "attendee_ids": [],
        "workout": {
            "program_id": entry["program_id"],
            "program_name": entry.get("program_name") or "",
            "occurrence_id": entry["occurrence_id"],
            "template_id": entry["template_id"],
            "weekday": entry.get("weekday"),
            "date": entry["date"],
            "athlete": entry.get("athlete") or "",
            "ha_user_id": entry.get("ha_user_id") or "",
            "minutes": minutes,
            "status": entry.get("status") or "planned",
            "start_time": start_time,
            "start_time_scope": "once" if once else "weekly" if weekly else None,
        },
    }


class Workouts:
    def __init__(self, client: GainsClient | None, coordinator: HustleCoordinator) -> None:
        self._client = client
        self._coordinator = coordinator

    async def _schedule(self, start: date, end: date) -> list[dict[str, Any]]:
        if self._client is None:
            return []
        try:
            return await self._client.schedule(start, end)
        except GainsUnavailable as err:
            _LOGGER.debug("No Gains workouts: %s", err)
            return []

    async def events(self, start: date, end: date) -> list[dict[str, Any]]:
        members = {m.ha_user_id: m.id for m in self._coordinator.members if m.active}
        times = self._coordinator.workout_times
        return [
            workout_event(entry, times, members.get(entry.get("ha_user_id") or ""))
            for entry in await self._schedule(start, end)
        ]

    async def find(self, program_id: str, occurrence_id: str, day: date) -> dict[str, Any]:
        for entry in await self._schedule(day, day + timedelta(days=1)):
            if entry["program_id"] == program_id and entry["occurrence_id"] == occurrence_id:
                return entry
        raise ServiceError("That workout isn't on the Gains schedule any more.")


SERVICE_SET_WORKOUT_TIME = "set_workout_time"

SCHEMAS = {
    SERVICE_SET_WORKOUT_TIME: vol.Schema(
        {
            vol.Required("program_id"): cv.string,
            vol.Required("occurrence_id"): cv.string,
            vol.Required("date"): cv.string,
            vol.Optional("time"): vol.Any(time_of_day, None),
            vol.Optional("scope", default="once"): vol.In(["once", "weekly"]),
        }
    ),
}


def build_handlers(coordinator: HustleCoordinator, workouts: Workouts) -> dict[str, Handler]:
    async def handle_set_workout_time(call: ServiceCall) -> dict[str, Any]:
        """The athlete, or any parent, sets (or clears, with no `time`) a
        workout's start - for this one, or for that session every week. The
        workout is looked up on Gains' schedule first, so the caller can't
        name someone else's."""
        caller = _require_member(coordinator, call)
        try:
            day = date.fromisoformat(call.data["date"])
        except ValueError as err:
            raise ServiceError("date must be YYYY-MM-DD") from err
        entry = await workouts.find(call.data["program_id"], call.data["occurrence_id"], day)
        if caller.role != "parent" and caller.ha_user_id != entry.get("ha_user_id"):
            raise HomeAssistantError("You can only set times for your own workouts.")
        if call.data["scope"] == "weekly":
            key = weekly_key(entry["program_id"], entry["template_id"])
            # A weekly time replaces this week's one-off, so it takes effect here too.
            await coordinator.async_set_workout_time(
                "once", once_key(entry["program_id"], entry["occurrence_id"]), None
            )
        else:
            key = once_key(entry["program_id"], entry["occurrence_id"])
        await coordinator.async_set_workout_time(call.data["scope"], key, call.data.get("time"))
        return {"time": call.data.get("time"), "scope": call.data["scope"]}

    return {SERVICE_SET_WORKOUT_TIME: handle_set_workout_time}
