"""The slice of Home Assistant's `hass` object the coordinator uses.

The integration's coordinator ran inside Home Assistant and reached it in
three ways: `hass.bus.async_fire("hustle_<event>", ...)` for automations,
`hass.services.async_call("notify", ...)` for per-member push alerts, and
`hass.async_create_task(...)` for background chore-image generation. This
stands in for exactly those, so coordinator.py carries over nearly
unchanged (and its tests keep using their FakeHass):
- events go to Core's `POST api/events/<type>`,
- service calls to `POST api/services/<domain>/<service>`,
- tasks to the running loop.

All three are fire-and-forget, as they were - the caller never awaits them
and a failure is logged, never raised into a mutation. Without Home
Assistant (`ha` is None on a dev run) events and notifications are dropped.

`session` and `images_dir` are for image_gen.py, which used
`async_get_clientsession(hass)` and `hass.config.path("www", ...)`.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from pathlib import Path
from typing import Any

import aiohttp

from .ha_client import HomeAssistantClient, HomeAssistantError

_LOGGER = logging.getLogger(__name__)


class _Bus:
    def __init__(self, bridge: HassBridge) -> None:
        self._bridge = bridge

    def async_fire(self, event_type: str, event_data: dict[str, Any] | None = None) -> None:
        ha = self._bridge.ha
        if ha is None:
            return
        self._bridge.async_create_task(
            self._bridge.best_effort(
                ha.fire_event(event_type, event_data or {}), f"event {event_type}"
            )
        )


class _Services:
    def __init__(self, bridge: HassBridge) -> None:
        self._bridge = bridge

    def async_call(self, domain: str, service: str, data: dict[str, Any] | None = None) -> None:
        ha = self._bridge.ha
        if ha is None:
            return
        self._bridge.async_create_task(
            self._bridge.best_effort(
                ha.call_service(domain, service, data or {}), f"{domain}.{service}"
            )
        )


class HassBridge:
    def __init__(
        self,
        ha: HomeAssistantClient | None,
        session: aiohttp.ClientSession | None,
        images_dir: Path,
    ) -> None:
        self.ha = ha
        self.session = session
        self.images_dir = images_dir
        self.bus = _Bus(self)
        self.services = _Services(self)
        # The loop only keeps weak references to tasks - hold them until
        # they finish so none gets garbage-collected mid-flight.
        self._tasks: set[asyncio.Task] = set()

    def async_create_task(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    @staticmethod
    async def best_effort(coro: Coroutine[Any, Any, Any], what: str) -> None:
        try:
            await coro
        except HomeAssistantError:
            _LOGGER.warning("Home Assistant call failed: %s", what, exc_info=True)
