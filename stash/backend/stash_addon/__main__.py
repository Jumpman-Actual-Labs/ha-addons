"""Add-on entry point - `python3 -m stash_addon` (see rootfs/etc/services.d/stash/run)."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import signal

import aiohttp
from aiohttp import web

from .config import load_config
from .coordinator import FinanceCoordinator
from .ha_client import HomeAssistantClient
from .migrate import migrate_from_integration
from .mqtt import MqttPublisher, async_get_broker
from .rollover import run_daily_rollover
from .services import build_handlers
from .storage import FinanceStore
from .web import create_app

_LOGGER = logging.getLogger("stash_addon")


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
        coordinator = FinanceCoordinator(FinanceStore(config.store_path))
        await coordinator.async_load()

        handlers = build_handlers(coordinator)
        runner = web.AppRunner(create_app(config, coordinator, handlers, ha))
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", config.port).start()
        _LOGGER.info("Stash listening on port %s", config.port)

        tasks = [asyncio.create_task(run_daily_rollover(coordinator))]
        if config.mqtt_enabled:
            broker = await async_get_broker(session, config.supervisor_token)
            if broker:
                tasks.append(asyncio.create_task(MqttPublisher(coordinator, broker).run()))
            else:
                _LOGGER.warning(
                    "No MQTT broker found - Stash's Home Assistant entities "
                    "(totals, overdue bills, savings, member and category "
                    "sensors) won't be available. Install the Mosquitto broker "
                    "add-on and restart Stash."
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
