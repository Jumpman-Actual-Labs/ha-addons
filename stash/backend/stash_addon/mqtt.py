"""Home Assistant entities for automations, via MQTT discovery.

The integration exposed sensors under a "Stash" device. An add-on can't
create entities itself, so it publishes them through the MQTT broker using
Home Assistant's discovery protocol, with an explicit default_entity_id
matching the integration's entity ids so existing automations keep working
once it's removed:
- the fixed ones: Total Income, Total Bills, Paid, Remaining, Cash
  Remaining, Bills Due This Pay Period, Overdue Bills, Deferred Bills,
  Finance Mode, Savings, Cash Infusions;
- one `<name> Finance Summary` sensor per member and one `<name> Spending`
  sensor per category.

The integration's per-bill sensors aren't published - every recurring bill
gets a new record each month, so they piled up one entity per bill per
month, and they existed mainly to carry data to the panel, which now reads
it from the add-on directly (see states.py). Category sensors leave out the
expense list for the same reason.

Member and category sensors come and go with their records. Their discovery
topics sit under a `stash` node id, so on connect the publisher can read
back what a previous run left retained and clear any that no longer exist.

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

from . import states
from .coordinator import FinanceCoordinator

_LOGGER = logging.getLogger(__name__)

DISCOVERY_PREFIX = "homeassistant"
NODE_ID = "stash"
BASE_TOPIC = "stash"
AVAILABILITY_TOPIC = f"{BASE_TOPIC}/availability"
RECONNECT_SECONDS = 30
# How long to collect retained discovery configs from a previous run.
RETAINED_SCAN_SECONDS = 2

MEMBER_KEY_PREFIX = "member_"
CATEGORY_KEY_PREFIX = "category_"
DYNAMIC_KEY_PREFIXES = (MEMBER_KEY_PREFIX, CATEGORY_KEY_PREFIX)

_DEVICE = {
    "identifiers": ["stash_addon"],
    "name": "Stash",
    "manufacturer": "Jumpman Actual Labs",
    "model": "Stash add-on",
}


def slugify(text: str) -> str:
    """Close enough to Home Assistant's slugify for entity ids built from a
    member or category name ("Kids' Stuff" -> "kids_stuff")."""
    return re.sub(r"[^a-z0-9]+", "_", text.lower().replace("'", "")).strip("_")


@dataclass(frozen=True)
class MqttEntity:
    key: str  # discovery object id and topic segment
    name: str
    entity_id: str
    state: Callable[[dict[str, Any]], Any]
    attributes: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    monetary: bool = False

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
            "unique_id": f"stash_addon_{self.key}",
            "default_entity_id": self.entity_id,
            "state_topic": self.state_topic,
            "availability_topic": AVAILABILITY_TOPIC,
            "device": _DEVICE,
        }
        if self.attributes:
            config["json_attributes_topic"] = self.attributes_topic
        if self.monetary:
            config["unit_of_measurement"] = "USD"
            config["device_class"] = "monetary"
            config["state_class"] = "total"
        return config


def discovery_topic(key: str) -> str:
    return f"{DISCOVERY_PREFIX}/sensor/{NODE_ID}/{key}/config"


def _fixed(
    key: str,
    name: str,
    build: Callable[[dict[str, Any]], states.Entity],
    monetary: bool = True,
) -> MqttEntity:
    """A fixed sensor whose state and attributes are exactly the panel's
    entity of the same kind (see states.py)."""
    return MqttEntity(
        key,
        name,
        f"sensor.stash_{slugify(name)}",
        lambda data: build(data)["state"],
        lambda data: build(data)["attributes"],
        monetary,
    )


def _summary(key: str, name: str) -> MqttEntity:
    return _fixed(key, name, lambda data: states.summary_value(data, key))


def _count(key: str, name: str) -> MqttEntity:
    return _fixed(key, name, lambda data: states.count(data, key), monetary=False)


FIXED_ENTITIES: list[MqttEntity] = [
    _summary("total_income", "Total Income"),
    _summary("total_bills", "Total Bills"),
    _summary("paid", "Paid"),
    _summary("remaining", "Remaining"),
    _summary("cash_remaining", "Cash Remaining"),
    _count("upcoming_this_pay_period", "Bills Due This Pay Period"),
    _count("overdue", "Overdue Bills"),
    _count("deferred", "Deferred Bills"),
    _fixed("mode", "Finance Mode", states.mode, monetary=False),
    _fixed("savings", "Savings", states.savings),
    _fixed("cash_infusions", "Cash Infusions", states.cash_infusions),
]


def _find(records: list[Any], record_id: str) -> Any:
    return next(r for r in records if r.id == record_id)


def _member_entity(member_id: str, name: str) -> MqttEntity:
    return MqttEntity(
        f"{MEMBER_KEY_PREFIX}{member_id}",
        f"{name} Finance Summary",
        f"sensor.stash_{slugify(name)}_finance_summary",
        lambda data: round(_find(data["members"], member_id).current_income(), 2),
        lambda data: states.member_attributes(data, _find(data["members"], member_id)),
        monetary=True,
    )


def _category_attributes(data: dict[str, Any], category_id: str) -> dict[str, Any]:
    attributes = states.category_attributes(data, _find(data["categories"], category_id))
    attributes.pop("expenses")
    return attributes


def _category_entity(category_id: str, name: str) -> MqttEntity:
    return MqttEntity(
        f"{CATEGORY_KEY_PREFIX}{category_id}",
        f"{name} Spending",
        f"sensor.stash_{slugify(name)}_spending",
        lambda data: round(data["category_totals"].get(category_id, 0.0), 2),
        lambda data: _category_attributes(data, category_id),
        monetary=True,
    )


def entities_for(data: dict[str, Any]) -> list[MqttEntity]:
    return (
        FIXED_ENTITIES
        + [_member_entity(m.id, m.name) for m in data.get("members", [])]
        + [_category_entity(c.id, c.name) for c in data.get("categories", [])]
    )


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


def dynamic_keys(data: dict[str, Any]) -> set[str]:
    return {e.key for e in entities_for(data) if e.key.startswith(DYNAMIC_KEY_PREFIXES)}


def stale_dynamic_keys(published_keys: set[str], data: dict[str, Any]) -> set[str]:
    published = {k for k in published_keys if k.startswith(DYNAMIC_KEY_PREFIXES)}
    return published - dynamic_keys(data)


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
    def __init__(self, coordinator: FinanceCoordinator, broker: dict) -> None:
        self._coordinator = coordinator
        self._broker = broker
        self._changed = asyncio.Event()
        self._last: dict[str, str] = {}
        # Member/category discovery keys currently retained on the broker.
        self._published_dynamic: set[str] = set()
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
            identifier="stash-addon",
            will=aiomqtt.Will(AVAILABILITY_TOPIC, "offline", retain=True),
        ) as client:
            _LOGGER.info("Connected to MQTT broker at %s", self._broker["host"])
            self._published_dynamic = await self._retained_dynamic_keys(client)
            await client.publish(AVAILABILITY_TOPIC, "online", retain=True)

            while True:
                self._changed.clear()
                await self._publish_changes(client)
                await self._changed.wait()

    async def _retained_dynamic_keys(self, client: aiomqtt.Client) -> set[str]:
        """Member/category sensors a previous run left on the broker, so ones
        whose record was deleted can be cleared even if that happened while
        the broker was unreachable."""
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
        return {k for k in keys if k.startswith(DYNAMIC_KEY_PREFIXES)}

    async def _publish_changes(self, client: aiomqtt.Client) -> None:
        data = self._coordinator.data or {}
        if not data:
            return
        for key in stale_dynamic_keys(self._published_dynamic, data):
            # An empty retained config is how discovery removes an entity.
            await client.publish(discovery_topic(key), "", retain=True)
            for kind in ("state", "attributes"):
                await client.publish(f"{BASE_TOPIC}/sensor/{key}/{kind}", "", retain=True)
            self._published_dynamic.discard(key)
            self._last = {t: p for t, p in self._last.items() if f"/{key}/" not in t}
        for topic, payload in build_messages(data).items():
            if self._last.get(topic) != payload:
                await client.publish(topic, payload, retain=True)
                self._last[topic] = payload
        self._published_dynamic |= dynamic_keys(data)
