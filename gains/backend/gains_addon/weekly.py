"""The integration's Sunday 23:50 job (its `async_track_time_change` in
__init__.py), as a plain asyncio loop: prepare next week's plan for every
active single-week program, near the end of the current training week, so
the current week's logged workouts are still available to it.

Local time comes from the container's TZ, which Supervisor sets to Home
Assistant's configured time zone.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, time, timedelta

from .coordinator import GainsCoordinator

_LOGGER = logging.getLogger(__name__)

GENERATION_TIME = time(23, 50)
SUNDAY = 6


def seconds_until_next(now: datetime, at: time, weekday: int) -> float:
    """Seconds from `now` to the next `weekday` (Monday=0) at `at`, local."""
    target = datetime.combine(now.date(), at, tzinfo=now.tzinfo)
    target += timedelta(days=(weekday - now.weekday()) % 7)
    if target <= now:
        target += timedelta(days=7)
    return (target - now).total_seconds()


async def async_generate_upcoming_weeks(coordinator: GainsCoordinator, today: date) -> None:
    for program in list(coordinator.data.programs):
        if program.status != "active" or len(program.weeks) != 1:
            continue
        try:
            start = date.fromisoformat(program.start_date)
            monday = start - timedelta(days=start.weekday())
            current_week = max(1, (today - monday).days // 7 + 1)
            next_week = current_week + 1
            if next_week > 260 or str(next_week) in program.generated_weeks:
                continue
            owner = coordinator.get_profile(program.profile_id)
            if owner is None or not owner.ha_user_id:
                continue
            await coordinator.async_program_action(
                owner.ha_user_id,
                program.id,
                "generate_week",
                {"week_number": next_week},
            )
        except Exception:
            # A provider outage must never stop other programs from updating.
            _LOGGER.exception("Could not generate next Gains week for %s", program.id)


async def run_weekly_generation(coordinator: GainsCoordinator) -> None:
    while True:
        now = datetime.now().astimezone()
        wait = seconds_until_next(now, GENERATION_TIME, SUNDAY)
        await asyncio.sleep(wait)
        # The Sunday it was scheduled for, even if the loop wakes late enough
        # to be past midnight - otherwise "next week" would skip one.
        sunday = (now + timedelta(seconds=wait)).date()
        await async_generate_upcoming_weeks(coordinator, sunday)
        # Never fire twice for the same Sunday if the sleep ended a hair early.
        await asyncio.sleep(60)
