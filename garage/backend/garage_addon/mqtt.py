"""Home Assistant entities for automations, via MQTT discovery.

The integration exposed sensors under a "Garage" device: the two monthly
spending totals, vehicles needing attention, and one health-score sensor
per vehicle. An add-on can't create entities itself, so it publishes the
same ones through the MQTT broker using Home Assistant's discovery
protocol, with an explicit default_entity_id matching the integration's
entity ids so existing automations keep working once it's removed.

Only these automation-facing entities are published. The integration's
settings/drivers/maintenance-templates sensors and the per-vehicle history
lists existed to carry data to the panel, which now reads it from the
add-on directly (see states.py).

Vehicle sensors come and go with the vehicles. Their discovery topics sit
under a `garage` node id, so on connect the publisher can read back what a
previous run left retained and clear any vehicle that no longer exists.

The broker comes from Supervisor's MQTT service discovery (config.yaml's
`services: [mqtt:want]`), so there's nothing to configure when the Mosquitto
add-on is installed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import aiohttp
import aiomqtt

from .coordinator import GarageCoordinator
from .states import vehicle_summary_attributes

_LOGGER = logging.getLogger(__name__)

DISCOVERY_PREFIX = "homeassistant"
NODE_ID = "garage"
BASE_TOPIC = "garage"
AVAILABILITY_TOPIC = f"{BASE_TOPIC}/availability"
RECONNECT_SECONDS = 30
# How long to collect retained discovery configs from a previous run.
RETAINED_SCAN_SECONDS = 2

_DEVICE = {
    "identifiers": ["garage_addon"],
    "name": "Garage",
    "manufacturer": "Jumpman Actual Labs",
    "model": "Garage add-on",
}


def slugify(text: str) -> str:
    """Close enough to Home Assistant's slugify for entity ids built from a
    vehicle nickname ("Dad's F-150" -> "dad_s_f_150")."""
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return slug or "vehicle"


@dataclass(frozen=True)
class MqttEntity:
    key: str  # discovery object id and topic segment
    name: str
    entity_id: str
    state: Callable[[dict[str, Any]], Any]
    attributes: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    unit: str | None = None
    device_class: str | None = None
    state_class: str = "measurement"

    @property
    def state_topic(self) -> str:
        return f"{BASE_TOPIC}/sensor/{self.key}/state"

    @property
    def attributes_topic(self) -> str:
        return f"{BASE_TOPIC}/sensor/{self.key}/attributes"

    @property
    def discovery_topic(self) -> str:
        return discovery_topic(self.key)

    def discovery(self) -> dict[str, Any]:
        config: dict[str, Any] = {
            "name": self.name,
            "unique_id": f"garage_addon_{self.key}",
            "default_entity_id": self.entity_id,
            "state_topic": self.state_topic,
            "availability_topic": AVAILABILITY_TOPIC,
            "device": _DEVICE,
            "state_class": self.state_class,
        }
        if self.attributes:
            config["json_attributes_topic"] = self.attributes_topic
        if self.unit:
            config["unit_of_measurement"] = self.unit
        if self.device_class:
            config["device_class"] = self.device_class
        return config


def discovery_topic(key: str) -> str:
    return f"{DISCOVERY_PREFIX}/sensor/{NODE_ID}/{key}/config"


def _vehicle_names(data: dict[str, Any]) -> dict[str, Any]:
    names = {v.id: v.nickname for v in data.get("vehicles", [])}
    ids = data.get("vehicles_needing_attention", [])
    return {"vehicle_ids": ids, "vehicles": [names[i] for i in ids if i in names]}


FIXED_ENTITIES: list[MqttEntity] = [
    MqttEntity(
        "monthly_fuel_spending",
        "Monthly Fuel Spending",
        "sensor.garage_monthly_fuel_spending",
        lambda data: round(data.get("total_monthly_fuel_spend", 0), 2),
        unit="USD",
        device_class="monetary",
        state_class="total",
    ),
    MqttEntity(
        "monthly_maintenance_spending",
        "Monthly Maintenance Spending",
        "sensor.garage_monthly_maintenance_spending",
        lambda data: round(data.get("total_monthly_maintenance_spend", 0), 2),
        unit="USD",
        device_class="monetary",
        state_class="total",
    ),
    MqttEntity(
        "vehicles_needing_attention",
        "Vehicles Needing Attention",
        "sensor.garage_vehicles_needing_attention",
        lambda data: len(data.get("vehicles_needing_attention", [])),
        _vehicle_names,
        unit="vehicles",
    ),
]

VEHICLE_KEY_PREFIX = "vehicle_"


def _vehicle_entity(vehicle_id: str, nickname: str) -> MqttEntity:
    return MqttEntity(
        f"{VEHICLE_KEY_PREFIX}{vehicle_id}",
        nickname,
        f"sensor.garage_{slugify(nickname)}",
        lambda data: data["vehicle_summaries"][vehicle_id]["health_score"],
        lambda data: vehicle_summary_attributes(data["vehicle_summaries"][vehicle_id]),
    )


def entities_for(data: dict[str, Any]) -> list[MqttEntity]:
    return FIXED_ENTITIES + [_vehicle_entity(v.id, v.nickname) for v in data.get("vehicles", [])]


def build_messages(data: dict[str, Any]) -> dict[str, str]:
    """topic -> payload for every entity's discovery config, state and
    attributes. Pure, so the payload shapes are unit-testable without a
    broker."""
    messages: dict[str, str] = {}
    for entity in entities_for(data):
        messages[entity.discovery_topic] = json.dumps(entity.discovery())
        messages[entity.state_topic] = str(entity.state(data))
        if entity.attributes:
            messages[entity.attributes_topic] = json.dumps(entity.attributes(data))
    return messages


def stale_vehicle_keys(published_keys: set[str], data: dict[str, Any]) -> set[str]:
    current = {f"{VEHICLE_KEY_PREFIX}{v.id}" for v in data.get("vehicles", [])}
    return {k for k in published_keys if k.startswith(VEHICLE_KEY_PREFIX)} - current


async def async_get_broker(session: aiohttp.ClientSession, token: str) -> dict | None:
    """Asks Supervisor for the MQTT broker another add-on (normally
    Mosquitto) has registered. None when there isn't one, or when running
    outside Supervisor entirely."""
    if not token:
        return None
    try:
        async with session.get(
            "http://supervisor/services/mqtt",
            headers={"Authorization": f"Bearer {token}"},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                return None
            body = await resp.json()
    except (TimeoutError, aiohttp.ClientError, ValueError):
        return None
    return body.get("data") or None


class MqttPublisher:
    def __init__(self, coordinator: GarageCoordinator, broker: dict) -> None:
        self._coordinator = coordinator
        self._broker = broker
        self._changed = asyncio.Event()
        self._last: dict[str, str] = {}
        # Vehicle discovery keys currently retained on the broker.
        self._published_vehicles: set[str] = set()
        coordinator.async_add_listener(self._changed.set)

    async def run(self) -> None:
        while True:
            try:
                await self._run_connected()
            except aiomqtt.MqttError as err:
                _LOGGER.warning(
                    "MQTT connection lost (%s) - retrying in %ss", err, RECONNECT_SECONDS
                )
            # Everything is re-sent after a reconnect - the broker may have
            # restarted and lost the retained messages.
            self._last = {}
            await asyncio.sleep(RECONNECT_SECONDS)

    async def _run_connected(self) -> None:
        async with aiomqtt.Client(
            hostname=self._broker["host"],
            port=int(self._broker.get("port", 1883)),
            username=self._broker.get("username"),
            password=self._broker.get("password"),
            identifier="garage-addon",
            will=aiomqtt.Will(AVAILABILITY_TOPIC, "offline", retain=True),
        ) as client:
            _LOGGER.info("Connected to MQTT broker at %s", self._broker["host"])
            self._published_vehicles = await self._retained_vehicle_keys(client)
            await client.publish(AVAILABILITY_TOPIC, "online", retain=True)

            while True:
                self._changed.clear()
                await self._publish_changes(client)
                await self._changed.wait()

    async def _retained_vehicle_keys(self, client: aiomqtt.Client) -> set[str]:
        """Vehicle sensors a previous run left on the broker, so ones whose
        vehicle was deleted can be cleared even if that happened while the
        broker was unreachable."""
        wildcard = discovery_topic("+")
        keys: set[str] = set()
        await client.subscribe(wildcard)
        try:
            async with asyncio.timeout(RETAINED_SCAN_SECONDS):
                async for message in client.messages:
                    key = str(message.topic).split("/")[-2]
                    if message.payload:
                        keys.add(key)
        except TimeoutError:
            pass
        await client.unsubscribe(wildcard)
        return {k for k in keys if k.startswith(VEHICLE_KEY_PREFIX)}

    async def _publish_changes(self, client: aiomqtt.Client) -> None:
        data = self._coordinator.data or {}
        if not data:
            return
        for key in stale_vehicle_keys(self._published_vehicles, data):
            # An empty retained config is how discovery removes an entity.
            await client.publish(discovery_topic(key), "", retain=True)
            for kind in ("state", "attributes"):
                await client.publish(f"{BASE_TOPIC}/sensor/{key}/{kind}", "", retain=True)
            self._published_vehicles.discard(key)
            self._last = {t: p for t, p in self._last.items() if f"/{key}/" not in t}
        for topic, payload in build_messages(data).items():
            if self._last.get(topic) != payload:
                await client.publish(topic, payload, retain=True)
                self._last[topic] = payload
        self._published_vehicles |= {
            f"{VEHICLE_KEY_PREFIX}{v.id}" for v in data.get("vehicles", [])
        }
