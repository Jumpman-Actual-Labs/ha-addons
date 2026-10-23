"""The integration's daily 00:05 job (its `async_track_time_change` in
__init__.py), as a plain asyncio loop: generate any recurring bills that
have come due, then archive last month's bills/payments/settlement.

Like the integration, it runs every day, not just on the 1st -
`async_trigger_monthly_rollover` rewrites the same archive entry, so
re-running it is harmless. Each run saves, which also rebuilds the read
model for the new date (overdue status, this pay period, current month).

Local time comes from the container's TZ, which Supervisor sets to Home
Assistant's configured time zone.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, time, timedelta

from .coordinator import FinanceCoordinator

_LOGGER = logging.getLogger(__name__)

ROLLOVER_TIME = time(0, 5)


def seconds_until(now: datetime, at: time) -> float:
    target = datetime.combine(now.date(), at, tzinfo=now.tzinfo)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def async_daily_rollover(coordinator: FinanceCoordinator) -> None:
    await coordinator.async_ensure_recurring_bills()
    await coordinator.async_trigger_monthly_rollover()


async def run_daily_rollover(coordinator: FinanceCoordinator) -> None:
    while True:
        await asyncio.sleep(seconds_until(datetime.now().astimezone(), ROLLOVER_TIME))
        try:
            await async_daily_rollover(coordinator)
        except Exception:
            _LOGGER.exception("Daily rollover failed")
            # Still move the read model to the new day.
            coordinator.async_refresh()
