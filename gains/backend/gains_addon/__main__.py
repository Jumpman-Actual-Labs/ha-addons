"""Add-on entry point - `python3 -m gains_addon` (see rootfs/etc/services.d/gains/run)."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import signal

import aiohttp
from aiohttp import web

from .ai import build_ai_provider
from .config import load_config
from .coordinator import GainsCoordinator
from .migrate import migrate_from_integration
from .mqtt import MqttPublisher, async_get_broker
from .services import build_handlers
from .storage import GainsStore
from .web import create_app
from .weekly import run_weekly_generation

_LOGGER = logging.getLogger("gains_addon")


async def main() -> None:
    config = load_config()
    logging.basicConfig(
        level=config.log_level.upper(),
        format="%(asctime)s %(levelname)s (%(name)s) %(message)s",
    )

    if await asyncio.to_thread(migrate_from_integration, config):
        # Picks up the AI settings the import may have brought over.
        config = load_config()

    async with aiohttp.ClientSession() as session:
        coordinator = GainsCoordinator(GainsStore(config.store_path))
        await coordinator.async_load()
        coordinator.ai_provider = build_ai_provider(config, session)
        if coordinator.ai_provider is None:
            _LOGGER.info(
                "No %s API key set - Ask Geoffrey stays off until one is added in "
                "the add-on's Configuration tab.",
                config.ai_provider,
            )

        runner = web.AppRunner(create_app(config, coordinator, build_handlers(coordinator)))
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", config.port).start()
        _LOGGER.info("Gains listening on port %s", config.port)

        tasks = [asyncio.create_task(run_weekly_generation(coordinator))]
        if config.mqtt_enabled:
            broker = await async_get_broker(session, config.supervisor_token)
            if broker:
                tasks.append(asyncio.create_task(MqttPublisher(coordinator, broker).run()))
            else:
                _LOGGER.warning(
                    "No MQTT broker found - Gains' Home Assistant entities (profile "
                    "count and one sensor per athlete) won't be available. Install "
                    "the Mosquitto broker add-on and restart Gains."
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
