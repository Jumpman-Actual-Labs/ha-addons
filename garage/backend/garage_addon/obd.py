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

Fuel level comes from the tank's float, which reads the slope of wherever
the car is sitting (park nose-up on a driveway and it drops) and sloshes
under braking. So with an odometer linked, fuel readings only count while
the odometer is moving, and what's applied is the median of the current
trip's last FUEL_WINDOW of them (a trip ends at a stop of NEW_TRIP_SECONDS).
Without an odometer there's no way to tell parked from driving, so every
reading counts, still median-smoothed.

A linked gear sensor sharpens both: fuel only counts in a drive gear, and
shifting into Park ends the trip on the spot. Fuel only goes in while the
vehicle is stopped, so a tank's fill-up is only believed across a stop -
Park, or a NEW_TRIP_SECONDS gap (the dongle sleeps with the engine off) -
never mid-trip (see logic.track_sensor_tank).

Tire pressures and a trouble-code sensor, when linked, are read on the same
poll and handed over as they are (coordinator.py raises the alerts).

What each read did is kept in `coordinator.live_status` (shown in the panel
via states.py) and logged at warning when a sensor starts failing, so a
link that isn't working is visible instead of silently ignored.
"""
from __future__ import annotations

import asyncio
import logging
import statistics
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .coordinator import GarageCoordinator
from .ha_client import HomeAssistantClient, HomeAssistantError
from .logic import TIRE_POSITIONS, parse_trouble_codes

_LOGGER = logging.getLogger(__name__)

POLL_SECONDS = 60
FUEL_WINDOW = 5
# Readings in the trip's window before its median is trusted to follow a tank
# from fill-up to fill-up (logic.track_sensor_tank) - one fresh reading
# could be a slosh, and a slosh up would look like a fill-up.
TANK_SETTLED_READINGS = 3
# Raw odometer travel between polls that counts as driving - WiCAN reports
# hundredths of a mile, so this ignores rounding jitter, not real movement.
MOVING_MILES = 0.05
# A trip's fuel window starts over after a stop this long - long enough to
# cover any fill-up, so the old tank's readings never outvote the new one.
# (Not a "fuel jumped up" rule: a slosh spike looks exactly like that.)
NEW_TRIP_SECONDS = 3 * 60

_KM_UNITS = {"km", "kilometers", "kilometres"}
_PSI_PER = {"kpa": 0.145038, "bar": 14.5038}
# Numeric gear codes as the Ram's transmission reports them (the WiCAN's
# 22 55 03 PID): 13 Park, 11 Reverse, 0 Neutral, 1-10 the gear it's in.
_GEAR_CODES = {13: "park", 11: "reverse", 0: "neutral"}
_GEAR_WORDS = {"p": "park", "park": "park", "r": "reverse", "reverse": "reverse",
               "n": "neutral", "neutral": "neutral"}


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


def odometer_miles(state: dict[str, Any] | None) -> float | None:
    """Miles, unrounded (motion detection needs the fraction). Kilometre
    sensors are converted. 0 is treated as no reading - OBD dongles report
    it while the ECU is still waking up."""
    reading = _number(state)
    if reading is None:
        return None
    value, unit = reading
    if unit in _KM_UNITS:
        value /= 1.609344
    return value or None


def parse_odometer(state: dict[str, Any] | None) -> int | None:
    """Whole miles, as Vehicle.current_mileage stores them."""
    miles = odometer_miles(state)
    return round(miles) if miles else None


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


def parse_gear(state: dict[str, Any] | None) -> str | None:
    """park / reverse / neutral / drive, from a numeric gear code or a
    letter (P/R/N/D/S/L/M, or the word); None with no usable reading."""
    if not state:
        return None
    raw = str(state.get("state", "")).strip().lower()
    if raw in ("", "unavailable", "unknown", "none"):
        return None
    try:
        code = int(float(raw))
    except ValueError:
        return _GEAR_WORDS.get(raw, "drive" if raw[:1] in "dslm" else None)
    return _GEAR_CODES.get(code, "drive" if 1 <= code <= 10 else None)


def parse_psi(state: dict[str, Any] | None) -> float | None:
    """A tire pressure in psi; kPa and bar sensors are converted."""
    reading = _number(state)
    if reading is None or reading[0] == 0:
        return None
    value, unit = reading
    return round(value * _PSI_PER.get(unit, 1), 1)


@dataclass
class _VehicleTracker:
    last_odometer: float | None = None
    last_moved_at: datetime | None = None
    fuel_window: deque[float] = field(default_factory=lambda: deque(maxlen=FUEL_WINDOW))
    # A stop (Park, or a long gap) since the last reading handed to the
    # tank tracker - the only time a fill-up can happen.
    stopped: bool = False

    def moving(self, odometer: float | None, now: datetime) -> bool:
        moved = (
            odometer is not None
            and self.last_odometer is not None
            and odometer - self.last_odometer >= MOVING_MILES
        )
        if odometer is not None:
            self.last_odometer = odometer
        if moved:
            if self.last_moved_at and (now - self.last_moved_at).total_seconds() > NEW_TRIP_SECONDS:
                self.end_trip()
            self.last_moved_at = now
        return moved

    def end_trip(self) -> None:
        self.fuel_window.clear()
        self.stopped = True

    def smoothed_fuel(self, fuel: float) -> float:
        self.fuel_window.append(fuel)
        return round(statistics.median(self.fuel_window), 3)

    @property
    def fuel_settled(self) -> bool:
        return len(self.fuel_window) >= TANK_SETTLED_READINGS


class LiveReadings:
    def __init__(self, coordinator: GarageCoordinator, ha: HomeAssistantClient) -> None:
        self._coordinator = coordinator
        self._ha = ha
        self._trackers: dict[str, _VehicleTracker] = {}
        self._failing: set[str] = set()

    async def _read(self, entity_id: str) -> tuple[dict[str, Any] | None, str]:
        """The state, and a status: ok / unavailable / missing / error."""
        try:
            state = await self._ha.get_state(entity_id)
        except HomeAssistantError as err:
            self._log_failure(entity_id, f"couldn't be read: {err}")
            return None, f"error: {err}"
        if state is None:
            self._log_failure(entity_id, "doesn't exist in Home Assistant")
            return None, "missing"
        if entity_id in self._failing:
            self._failing.discard(entity_id)
            _LOGGER.info("%s is readable again", entity_id)
        return state, "ok"

    def _log_failure(self, entity_id: str, problem: str) -> None:
        if entity_id not in self._failing:
            self._failing.add(entity_id)
            _LOGGER.warning("Linked sensor %s %s", entity_id, problem)

    @staticmethod
    def _status(
        entity_id: str, state: dict[str, Any] | None, read: str, now: str, numeric: bool = True
    ) -> dict:
        """`numeric` False for text sensors (a gear letter, trouble codes),
        which are only unavailable when Home Assistant says so."""
        raw = state.get("state") if state else None
        unit = ((state or {}).get("attributes") or {}).get("unit_of_measurement") or ""
        if read == "ok" and (
            _number(state) is None
            if numeric
            else str(raw).lower() in ("unavailable", "unknown", "none", "")
        ):
            read = "unavailable"
        return {"entity_id": entity_id, "status": read, "state": raw, "unit": unit, "read_at": now}

    async def poll_once(self, now: datetime | None = None) -> None:
        now = now or datetime.now(UTC)
        stamp = now.isoformat()
        live_status: dict[str, dict[str, Any]] = {}
        for vehicle in list(self._coordinator.vehicles):
            if not (
                vehicle.odometer_entity_id
                or vehicle.fuel_level_entity_id
                or vehicle.gear_entity_id
                or vehicle.tire_entity_ids
                or vehicle.trouble_codes_entity_id
            ):
                continue
            tracker = self._trackers.setdefault(vehicle.id, _VehicleTracker())
            status: dict[str, Any] = {}

            odometer = None
            if vehicle.odometer_entity_id:
                state, read = await self._read(vehicle.odometer_entity_id)
                odometer = odometer_miles(state)
                status["odometer"] = self._status(vehicle.odometer_entity_id, state, read, stamp)
            moving = tracker.moving(odometer, now)

            gear = None
            if vehicle.gear_entity_id:
                state, read = await self._read(vehicle.gear_entity_id)
                gear = parse_gear(state)
                status["gear"] = self._status(
                    vehicle.gear_entity_id, state, read, stamp, numeric=False
                )
                if gear == "park":
                    tracker.end_trip()
            driving = moving and gear in (None, "drive")

            fuel_pct = None
            tank_reading = None
            if vehicle.fuel_level_entity_id:
                state, read = await self._read(vehicle.fuel_level_entity_id)
                fuel = parse_fuel_level(state)
                status["fuel"] = self._status(vehicle.fuel_level_entity_id, state, read, stamp)
                if fuel is not None:
                    if (vehicle.odometer_entity_id or vehicle.gear_entity_id) and not driving:
                        # Parked (or stopped) - the float reads the slope.
                        status["fuel"]["status"] = "parked"
                    else:
                        fuel_pct = tracker.smoothed_fuel(fuel)
                        if odometer is not None and tracker.fuel_settled:
                            tank_reading = (odometer, fuel_pct, tracker.stopped)
                            tracker.stopped = False

            tires = None
            if vehicle.tire_entity_ids:
                tires = {}
                for position in TIRE_POSITIONS:
                    entity_id = vehicle.tire_entity_ids.get(position)
                    if not entity_id:
                        continue
                    state, read = await self._read(entity_id)
                    status[f"tire_{position}"] = self._status(entity_id, state, read, stamp)
                    psi = parse_psi(state)
                    if psi is not None:
                        tires[position] = psi

            trouble = None
            if vehicle.trouble_codes_entity_id:
                state, read = await self._read(vehicle.trouble_codes_entity_id)
                status["trouble_codes"] = self._status(
                    vehicle.trouble_codes_entity_id, state, read, stamp, numeric=False
                )
                trouble = parse_trouble_codes(state)

            live_status[vehicle.id] = status
            await self._coordinator.async_apply_live_readings(
                vehicle.id,
                round(odometer) if odometer else None,
                fuel_pct,
                tank_reading,
                tires=tires,
                trouble=trouble,
            )
        self._coordinator.set_live_status(live_status)


async def run_live_readings(coordinator: GarageCoordinator, ha: HomeAssistantClient) -> None:
    readings = LiveReadings(coordinator, ha)
    while True:
        try:
            await readings.poll_once()
        except Exception:
            _LOGGER.exception("Reading linked vehicle sensors failed")
        await asyncio.sleep(POLL_SECONDS)
