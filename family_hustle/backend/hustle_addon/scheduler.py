"""The integration's 5-minute scheduler tick (its `async_track_time_interval`
job in __init__.py), as a plain asyncio loop: generate due chore
occurrences, expire stale bounties, process overdue chores, and
auto-generate the current pay period's paychecks once payday arrives.

Also refreshes the coordinator's public data on every tick, so date-driven
numbers (days until payday, today's chore progress on the Calendar tab,
bounties dropping off the board at their deadline) move on without waiting
for a mutation.

Local time comes from the container's TZ, which Supervisor sets to Home
Assistant's configured time zone.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime

from .const import SCHEDULER_INTERVAL_MINUTES
from .coordinator import HustleCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_scheduler_tick(coordinator: HustleCoordinator) -> None:
    await coordinator.async_generate_due_chore_occurrences()
    await coordinator.async_expire_stale_bounties()
    await coordinator.async_process_overdue_chores()
    if coordinator.payroll_config and coordinator.payroll_config.auto_generate:
        period = await coordinator.async_get_or_create_current_period()
        if (
            period.status.value == "open"
            and date.fromisoformat(period.payday_date) <= datetime.now().astimezone().date()
        ):
            await coordinator.async_generate_pay_period(period.id)
    coordinator.async_set_updated_data(coordinator._build_public_data())


async def run_scheduler(coordinator: HustleCoordinator) -> None:
    while True:
        await asyncio.sleep(SCHEDULER_INTERVAL_MINUTES * 60)
        try:
            await async_scheduler_tick(coordinator)
        except Exception:
            _LOGGER.exception("Scheduler tick failed")
