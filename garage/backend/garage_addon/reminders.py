"""The integration's daily 8am driver reminders (its `async_track_time_change`
job in __init__.py), as a plain asyncio loop.

Each morning it sends each reminder from `coordinator.compute_reminders` to the vehicle's
primary driver's `notify.*` target, through Home Assistant Core's API.
Best-effort, same as before: a missing or failing notify target is logged
and never stops the reminders for every other driver.

Local time comes from the container's TZ, which Supervisor sets to Home
Assistant's configured time zone.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, time, timedelta

from .coordinator import GarageCoordinator
from .ha_client import HomeAssistantClient, HomeAssistantError
from .models import Driver

_LOGGER = logging.getLogger(__name__)

REMINDER_TIME = time(8, 0)
NEW_DAY_TIME = time(0, 0, 5)


def seconds_until(now: datetime, at: time) -> float:
    target = datetime.combine(now.date(), at, tzinfo=now.tzinfo)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def _async_notify_driver(
    ha: HomeAssistantClient, driver: Driver | None, message: str
) -> None:
    if not driver or not driver.notify_target:
        return
    service = driver.notify_target.removeprefix("notify.")
    try:
        await ha.call_service("notify", service, {"message": message})
    except HomeAssistantError:
        _LOGGER.warning("Failed to notify driver %s via %s", driver.id, driver.notify_target)


async def async_send_reminders(
    coordinator: GarageCoordinator, ha: HomeAssistantClient, today: date
) -> None:
    for reminder in coordinator.compute_reminders(today):
        vehicle = next((v for v in coordinator.vehicles if v.id == reminder["vehicle_id"]), None)
        if vehicle is None:
            continue
        driver = next((d for d in coordinator.drivers if d.id == vehicle.primary_driver_id), None)
        await _async_notify_driver(ha, driver, reminder["message"])


async def run_daily_tasks(
    coordinator: GarageCoordinator, ha: HomeAssistantClient | None
) -> None:
    """Wakes just after midnight (a new day/month moves due dates, health
    scores and monthly spend) and at REMINDER_TIME (which also sends the
    reminders)."""
    while True:
        now = datetime.now().astimezone()
        until_reminders = seconds_until(now, REMINDER_TIME)
        until_new_day = seconds_until(now, NEW_DAY_TIME)
        await asyncio.sleep(min(until_reminders, until_new_day))
        coordinator.async_refresh()
        if ha is None or until_reminders > until_new_day:
            continue
        try:
            await async_send_reminders(coordinator, ha, date.today())
        except Exception:
            _LOGGER.exception("Daily reminders failed")
