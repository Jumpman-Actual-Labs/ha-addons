"""Add-on entry point - `python3 -m garage_addon` (see rootfs/etc/services.d/garage/run)."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import signal

import aiohttp
from aiohttp import web

from .config import load_config
from .coordinator import GarageCoordinator
from .ha_client import HomeAssistantClient
from .migrate import migrate_from_integration
from .mqtt import MqttPublisher, async_get_broker
from .obd import run_live_readings
from .reminders import run_daily_tasks
from .services import build_handlers
from .stash_client import StashClient, stash_base_url
from .storage import GarageStore
from .web import create_app

_LOGGER = logging.getLogger("garage_addon")


async def main() -> None:
    config = load_config()
    logging.basicConfig(
        level=config.log_level.upper(),
        format="%(asctime)s %(levelname)s (%(name)s) %(message)s",
    )

    await asyncio.to_thread(migrate_from_integration, config)

    async with aiohttp.ClientSession() as session:
        ha = (
            HomeAssistantClient(session, config.core_api_url, config.supervisor_token)
            if config.supervisor_token
            else None
        )
        stash_url = stash_base_url(config.hostname)
        stash = StashClient(session, stash_url) if stash_url else None
        coordinator = GarageCoordinator(GarageStore(config.store_path), ha, stash)
        await coordinator.async_load()

        handlers = build_handlers(coordinator, config)
        runner = web.AppRunner(create_app(config, coordinator, handlers, session, ha))
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", config.port).start()
        _LOGGER.info("Garage listening on port %s", config.port)

        tasks = [asyncio.create_task(run_daily_tasks(coordinator, ha))]
        if ha is not None:
            tasks.append(asyncio.create_task(run_live_readings(coordinator, ha)))
        if config.mqtt_enabled:
            broker = await async_get_broker(session, config.supervisor_token)
            if broker:
                tasks.append(asyncio.create_task(MqttPublisher(coordinator, broker).run()))
            else:
                _LOGGER.warning(
                    "No MQTT broker found - Garage's Home Assistant entities "
                    "(monthly spending, vehicles needing attention, vehicle "
                    "health) won't be available. Install the Mosquitto broker "
                    "add-on and restart Garage."
                )

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            # Not available on Windows dev runs - Ctrl+C still raises there.
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, stop.set)
        await stop.wait()

        for task in tasks:
            task.cancel()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
