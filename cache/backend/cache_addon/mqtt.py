"""Home Assistant entities for automations, via MQTT discovery.

The integration exposed binary_sensor.cache_* flags (cleaning due, low ammo,
training due, training ammo alert) plus their count sensors for automations.
An add-on can't create entities itself, so it publishes the same ones
through the MQTT broker using Home Assistant's discovery protocol. Entity ids
come out identical to the integration's (device "Cache" + the same entity
names, plus an explicit default_entity_id), so existing automations keep
working once the old integration is removed.

Only these automation-facing summary entities are published - the
per-firearm/part/ammo sensors and the big settings/schedule attribute blobs
existed to carry data to the panel, which now reads it from the add-on
directly (see states.py).

The broker comes from Supervisor's MQTT service discovery (config.yaml's
`services: [mqtt:want]`), so there's nothing to configure when the Mosquitto
add-on is installed.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import aiohttp
import aiomqtt

from . import states
from .coordinator import CacheCoordinator

_LOGGER = logging.getLogger(__name__)

DISCOVERY_PREFIX = "homeassistant"
BASE_TOPIC = "cache"
AVAILABILITY_TOPIC = f"{BASE_TOPIC}/availability"
RECONNECT_SECONDS = 30

_DEVICE = {
    "identifiers": ["cache_addon"],
    "name": "Cache",
    "manufacturer": "Jumpman Actual Labs",
    "model": "Cache add-on",
}


@dataclass(frozen=True)
class MqttEntity:
    component: str  # "sensor" or "binary_sensor"
    key: str  # becomes cache_<key> for the entity id/unique id/topics
    name: str
    state: Callable[[dict[str, Any]], Any]
    attributes: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    unit: str | None = None

    @property
    def object_id(self) -> str:
        return f"cache_{self.key}"

    @property
    def state_topic(self) -> str:
        return f"{BASE_TOPIC}/{self.component}/{self.key}/state"

    @property
    def attributes_topic(self) -> str:
        return f"{BASE_TOPIC}/{self.component}/{self.key}/attributes"

    def discovery(self) -> tuple[str, dict[str, Any]]:
        config: dict[str, Any] = {
            "name": self.name,
            "unique_id": f"cache_addon_{self.component}_{self.key}",
            "default_entity_id": f"{self.component}.{self.object_id}",
            "state_topic": self.state_topic,
            "availability_topic": AVAILABILITY_TOPIC,
            "device": _DEVICE,
        }
        if self.attributes:
            config["json_attributes_topic"] = self.attributes_topic
        if self.component == "binary_sensor":
            config["device_class"] = "problem"
            config["payload_on"] = "ON"
            config["payload_off"] = "OFF"
        else:
            config["state_class"] = "measurement"
            if self.unit:
                config["unit_of_measurement"] = self.unit
        topic = f"{DISCOVERY_PREFIX}/{self.component}/{self.object_id}/config"
        return topic, config


def _flag(key: str) -> Callable[[dict[str, Any]], str]:
    return lambda data: "ON" if data.get(key) else "OFF"


def _count(*keys: str) -> Callable[[dict[str, Any]], int]:
    return lambda data: sum(len(data.get(k, [])) for k in keys)


def _items(fn: Callable[[dict[str, Any]], list[str]]) -> Callable[[dict[str, Any]], dict]:
    return lambda data: {"items": fn(data)}


# The binary sensors' on/off conditions match the integration's
# binary_sensor.py exactly - including training_due/training_ammo_alert only
# looking at range schedules, not training plans (the count sensors cover
# both).
ENTITIES: list[MqttEntity] = [
    MqttEntity(
        "binary_sensor",
        "cleaning_due",
        "Cleaning Due",
        _flag("cleaning_due_firearm_ids"),
        _items(states.cleaning_due_items),
    ),
    MqttEntity(
        "binary_sensor",
        "low_ammunition",
        "Low Ammunition",
        _flag("low_ammo_ids"),
        _items(states.low_ammo_items),
    ),
    MqttEntity(
        "binary_sensor", "training_due", "Training Due", _flag("range_schedules_due_ids")
    ),
    MqttEntity(
        "binary_sensor",
        "training_ammo_alert",
        "Training Ammo Alert",
        _flag("range_schedules_ammo_alert_ids"),
    ),
    MqttEntity(
        "sensor",
        "dashboard_stats",
        "Dashboard Stats",
        lambda data: data.get("dashboard_stats", {}).get("total_firearms", 0),
        lambda data: dict(data.get("dashboard_stats", {})),
    ),
    MqttEntity(
        "sensor",
        "cleaning_due",
        "Cleaning Due",
        _count("cleaning_due_firearm_ids"),
        _items(states.cleaning_due_items),
        unit="firearms",
    ),
    MqttEntity(
        "sensor",
        "low_ammunition",
        "Low Ammunition",
        _count("low_ammo_ids"),
        _items(states.low_ammo_items),
        unit="calibers",
    ),
    MqttEntity(
        "sensor",
        "training_due",
        "Training Due",
        _count("range_schedules_due_ids", "training_plans_due_ids"),
        _items(states.training_due_items),
        unit="schedules",
    ),
    MqttEntity(
        "sensor",
        "training_ammo_alert",
        "Training Ammo Alert",
        _count("range_schedules_ammo_alert_ids", "training_plans_ammo_alert_ids"),
        _items(states.training_ammo_alert_items),
        unit="schedules",
    ),
    MqttEntity(
        "sensor",
        "range_sessions",
        "Range Sessions",
        _count("range_sessions"),
        unit="sessions",
    ),
]


def build_messages(data: dict[str, Any]) -> dict[str, str]:
    """topic -> payload for every entity's current state and attributes.
    Pure, so the payload shapes are unit-testable without a broker."""
    messages: dict[str, str] = {}
    for entity in ENTITIES:
        messages[entity.state_topic] = str(entity.state(data))
        if entity.attributes:
            messages[entity.attributes_topic] = json.dumps(entity.attributes(data))
    return messages


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
    def __init__(self, coordinator: CacheCoordinator, broker: dict) -> None:
        self._coordinator = coordinator
        self._broker = broker
        self._changed = asyncio.Event()
        self._last: dict[str, str] = {}
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
            identifier="cache-addon",
            will=aiomqtt.Will(AVAILABILITY_TOPIC, "offline", retain=True),
        ) as client:
            _LOGGER.info("Connected to MQTT broker at %s", self._broker["host"])
            for entity in ENTITIES:
                topic, config = entity.discovery()
                await client.publish(topic, json.dumps(config), retain=True)
            await client.publish(AVAILABILITY_TOPIC, "online", retain=True)

            while True:
                self._changed.clear()
                await self._publish_changes(client)
                await self._changed.wait()

    async def _publish_changes(self, client: aiomqtt.Client) -> None:
        for topic, payload in build_messages(self._coordinator.data or {}).items():
            if self._last.get(topic) != payload:
                await client.publish(topic, payload, retain=True)
                self._last[topic] = payload
