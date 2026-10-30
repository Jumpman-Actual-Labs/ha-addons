"""Live odometer and fuel level from Home Assistant sensors.

A vehicle can be linked to two HA entities - typically an OBD-II dongle's,
like a WiCAN's `sensor.wican_<id>_local_a6_odometer` and
`..._2f_fueltanklevel` - and this loop keeps `current_mileage` and
`current_fuel_pct` in step with them, so due-by-mileage maintenance, the
health score, estimated range and low-fuel reminders run off the car
itself instead of whatever was last typed in.

Polled rather than subscribed: one REST read per linked entity every
POLL_SECONDS is plenty for numbers that move this slowly, and it survives
Core restarts without reconnect logic. A dongle that's asleep with the car
off reports unavailable/unknown, which is skipped - the last good reading
stays.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from .coordinator import GarageCoordinator
from .ha_client import HomeAssistantClient, HomeAssistantError

_LOGGER = logging.getLogger(__name__)

POLL_SECONDS = 60

_KM_UNITS = {"km", "kilometers", "kilometres"}


def _number(state: dict[str, Any] | None) -> tuple[float, str] | None:
    if not state:
        return None
    try:
        value = float(state.get("state"))
    except (TypeError, ValueError):  # unavailable / unknown / garbage
        return None
    if value != value or value < 0:  # NaN, or a dongle's error sentinel
        return None
    unit = str((state.get("attributes") or {}).get("unit_of_measurement") or "")
    return value, unit.strip().lower()


def parse_odometer(state: dict[str, Any] | None) -> int | None:
    """Whole miles. Kilometre sensors are converted. 0 is treated as no
    reading - OBD dongles report it while the ECU is still waking up."""
    reading = _number(state)
    if reading is None:
        return None
    value, unit = reading
    if unit in _KM_UNITS:
        value /= 1.609344
    miles = round(value)
    return miles or None


def parse_fuel_level(state: dict[str, Any] | None) -> float | None:
    """A 0-1 fraction, like Vehicle.current_fuel_pct. Percent sensors
    (unit `%`, or any value above 1) are divided by 100."""
    reading = _number(state)
    if reading is None:
        return None
    value, unit = reading
    if unit == "%" or value > 1:
        value /= 100
    if value > 1:
        return None
    return round(value, 3)


async def _async_read(ha: HomeAssistantClient, entity_id: str) -> dict[str, Any] | None:
    if not entity_id:
        return None
    try:
        return await ha.get_state(entity_id)
    except HomeAssistantError:
        _LOGGER.debug("Couldn't read %s", entity_id, exc_info=True)
        return None


async def async_poll_once(coordinator: GarageCoordinator, ha: HomeAssistantClient) -> None:
    for vehicle in list(coordinator.vehicles):
        if not (vehicle.odometer_entity_id or vehicle.fuel_level_entity_id):
            continue
        odometer = parse_odometer(await _async_read(ha, vehicle.odometer_entity_id))
        fuel_pct = parse_fuel_level(await _async_read(ha, vehicle.fuel_level_entity_id))
        await coordinator.async_apply_live_readings(vehicle.id, odometer, fuel_pct)


async def run_live_readings(coordinator: GarageCoordinator, ha: HomeAssistantClient) -> None:
    while True:
        try:
            await async_poll_once(coordinator, ha)
        except Exception:
            _LOGGER.exception("Reading linked vehicle sensors failed")
        await asyncio.sleep(POLL_SECONDS)
