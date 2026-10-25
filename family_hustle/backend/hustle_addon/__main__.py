"""Add-on entry point - `python3 -m hustle_addon` (see
rootfs/etc/services.d/family_hustle/run)."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import signal

import aiohttp
from aiohttp import web

from . import family_calendar, meals, recipes, services, shopping
from .bridge import HassBridge
from .config import load_config
from .coordinator import HustleCoordinator
from .family_calendar import FamilyCalendar
from .ha_client import HomeAssistantClient
from .migrate import migrate_from_integrations
from .mqtt import MqttPublisher, async_get_broker
from .scheduler import run_scheduler
from .shopping import ShoppingList
from .storage import HustleStore
from .web import create_app

_LOGGER = logging.getLogger("hustle_addon")


async def main() -> None:
    config = load_config()
    logging.basicConfig(
        level=config.log_level.upper(),
        format="%(asctime)s %(levelname)s (%(name)s) %(message)s",
    )

    await asyncio.to_thread(migrate_from_integrations, config)

    async with aiohttp.ClientSession() as session:
        ha = (
            HomeAssistantClient(session, config.core_api_url, config.supervisor_token)
            if config.supervisor_token
            else None
        )
        coordinator = HustleCoordinator(
            HassBridge(ha, session, config.images_dir), HustleStore(config.store_path)
        )
        coordinator.openai_api_key = await meals.resolve_key(config, "openai_api_key")
        await coordinator.async_load()

        calendar = FamilyCalendar(ha, coordinator)
        shopping_list = ShoppingList(ha, coordinator)
        schemas = {
            **services.SCHEMAS,
            **family_calendar.SCHEMAS,
            **meals.SCHEMAS,
            **recipes.SCHEMAS,
            **shopping.SCHEMAS,
        }
        handlers = {
            **services.build_handlers(coordinator),
            **family_calendar.build_handlers(coordinator, calendar),
            **meals.build_handlers(coordinator, calendar, session, config),
            **recipes.build_handlers(coordinator, session, config),
            **shopping.build_handlers(coordinator, shopping_list),
        }
        runner = web.AppRunner(
            create_app(config, coordinator, schemas, handlers, ha, calendar, shopping_list)
        )
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", config.port).start()
        _LOGGER.info("Family Hustle listening on port %s", config.port)

        tasks = [asyncio.create_task(run_scheduler(coordinator))]
        if config.mqtt_enabled:
            broker = await async_get_broker(session, config.supervisor_token)
            if broker:
                tasks.append(asyncio.create_task(MqttPublisher(coordinator, broker).run()))
            else:
                _LOGGER.warning(
                    "No MQTT broker found - Family Hustle's Home Assistant entities "
                    "(payroll/chore counts, member earnings) won't be available. "
                    "Install the Mosquitto broker add-on and restart Family Hustle."
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
