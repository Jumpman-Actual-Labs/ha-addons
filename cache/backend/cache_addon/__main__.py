"""Add-on entry point - `python3 -m cache_addon` (see rootfs/etc/services.d/cache/run)."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import signal

import aiohttp
from aiohttp import web

from .config import load_config
from .coordinator import CacheCoordinator
from .migrate import migrate_from_integration
from .mqtt import MqttPublisher, async_get_broker
from .services import build_service_context
from .storage import CacheStore
from .web import create_app

_LOGGER = logging.getLogger("cache_addon")


async def main() -> None:
    config = load_config()
    logging.basicConfig(
        level=config.log_level.upper(),
        format="%(asctime)s %(levelname)s (%(name)s) %(message)s",
    )

    await asyncio.to_thread(migrate_from_integration, config)

    coordinator = CacheCoordinator(CacheStore(config.store_path))
    await coordinator.async_load()

    async with aiohttp.ClientSession() as session:
        services = build_service_context(coordinator, config, session)
        runner = web.AppRunner(create_app(config, coordinator, services, session))
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", config.port).start()
        _LOGGER.info("Cache listening on port %s", config.port)

        mqtt_task: asyncio.Task | None = None
        if config.mqtt_enabled:
            broker = await async_get_broker(session, config.supervisor_token)
            if broker:
                mqtt_task = asyncio.create_task(MqttPublisher(coordinator, broker).run())
            else:
                _LOGGER.warning(
                    "No MQTT broker found - Cache's Home Assistant entities "
                    "(cleaning due, low ammo, training due) won't be available. "
                    "Install the Mosquitto broker add-on and restart Cache."
                )

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            # Not available on Windows dev runs - Ctrl+C still raises there.
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, stop.set)
        await stop.wait()

        if mqtt_task:
            mqtt_task.cancel()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
