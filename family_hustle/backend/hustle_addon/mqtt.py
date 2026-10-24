"""Home Assistant entities for automations, via MQTT discovery.

The integration exposed sensors under a "Hustle" device. An add-on can't
create entities itself, so it publishes the automation-facing ones through
the MQTT broker using Home Assistant's discovery protocol, with an explicit
default_entity_id matching the integration's entity ids so existing
automations keep working once it's removed:
- the payroll/chore/bounty/approval counts and days until payday,
- per member: pending earnings, lifetime earnings and current paycheck
  (cents, as before).

Only these are published. The integration's roster/catalog/report/history
sensors and the per-chore/assignment/bounty ones existed to carry data to
the panel, which now reads it from the add-on directly (see states.py).
The integration's `hustle_*` events still reach Home Assistant's event bus
(see bridge.py), so event-triggered automations keep working too.

Member sensors come and go with the members. Their discovery topics sit
under a `hustle` node id, so on connect the publisher can read back what a
previous run left retained and clear any member that no longer exists.

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

from .coordinator import HustleCoordinator
from .states import member_current_paycheck, member_lifetime_cents, member_pending_cents

_LOGGER = logging.getLogger(__name__)

DISCOVERY_PREFIX = "homeassistant"
NODE_ID = "hustle"
BASE_TOPIC = "hustle"
AVAILABILITY_TOPIC = f"{BASE_TOPIC}/availability"
RECONNECT_SECONDS = 30
# How long to collect retained discovery configs from a previous run.
RETAINED_SCAN_SECONDS = 2

_DEVICE = {
    "identifiers": ["family_hustle_addon"],
    "name": "Family Hustle",
    "manufacturer": "Jumpman Actual Labs",
    "model": "Family Hustle add-on",
}


def slugify(text: str) -> str:
    """Close enough to Home Assistant's slugify for entity ids built from a
    member's name ("Mary-Kate" -> "mary_kate")."""
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return slug or "member"


@dataclass(frozen=True)
class MqttEntity:
    key: str  # discovery object id and topic segment
    name: str
    entity_id: str
    state: Callable[[dict[str, Any]], Any]
    attributes: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    unit: str | None = None
    state_class: str | None = "measurement"

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
            "unique_id": f"hustle_addon_{self.key}",
            "default_entity_id": self.entity_id,
            "state_topic": self.state_topic,
            "availability_topic": AVAILABILITY_TOPIC,
            "device": _DEVICE,
        }
        if self.state_class:
            config["state_class"] = self.state_class
        if self.attributes:
            config["json_attributes_topic"] = self.attributes_topic
        if self.unit:
            config["unit_of_measurement"] = self.unit
        return config


def discovery_topic(key: str) -> str:
    return f"{DISCOVERY_PREFIX}/sensor/{NODE_ID}/{key}/config"


def _count(key: str) -> Callable[[dict[str, Any]], Any]:
    def state(data: dict[str, Any]) -> Any:
        value = data.get(key)
        return len(value) if isinstance(value, list) else value

    return state


def _days_until_payday_attributes(data: dict[str, Any]) -> dict[str, Any]:
    period = data.get("current_period")
    if period is None:
        return {}
    return {
        "start_date": period.start_date,
        "end_date": period.end_date,
        "payday_date": period.payday_date,
        "status": period.status.value,
    }


FIXED_ENTITIES: list[MqttEntity] = [
    MqttEntity(
        "pending_payroll_count",
        "Pending Payroll Count",
        "sensor.hustle_pending_payroll_count",
        _count("pending_payroll_count"),
    ),
    MqttEntity(
        "days_until_payday",
        "Days Until Payday",
        "sensor.hustle_days_until_payday",
        lambda data: data.get("days_until_payday"),
        _days_until_payday_attributes,
        unit="d",
    ),
    MqttEntity(
        "active_chores_count",
        "Active Chores Count",
        "sensor.hustle_active_chores_count",
        _count("active_chores_count"),
    ),
    MqttEntity(
        "active_bounties_count",
        "Active Bounties Count",
        "sensor.hustle_active_bounties_count",
        _count("active_bounties_count"),
    ),
    MqttEntity(
        "pending_approval_count",
        "Pending Approvals Count",
        "sensor.hustle_pending_approvals_count",
        _count("pending_approval_count"),
    ),
]

MEMBER_KEY_PREFIX = "member_"


def _member_entities(member_id: str, name: str) -> list[MqttEntity]:
    slug = slugify(name)

    def paycheck_state(data: dict[str, Any]) -> Any:
        paycheck = member_current_paycheck(data, member_id)
        return paycheck.net_cents if paycheck else None

    def paycheck_attributes(data: dict[str, Any]) -> dict[str, Any]:
        paycheck = member_current_paycheck(data, member_id)
        return {
            "member_id": member_id,
            "status": paycheck.status.value if paycheck else None,
            "gross_cents": paycheck.gross_cents if paycheck else None,
        }

    return [
        MqttEntity(
            f"{MEMBER_KEY_PREFIX}{member_id}_pending_earnings",
            f"{name} Pending Earnings",
            f"sensor.hustle_{slug}_pending_earnings",
            lambda data: member_pending_cents(data, member_id),
            lambda data: {
                "member_id": member_id,
                "potential_cents": data.get("potential_earnings_by_member", {}).get(
                    member_id, 0
                ),
            },
            unit="cents",
        ),
        MqttEntity(
            f"{MEMBER_KEY_PREFIX}{member_id}_lifetime_earnings",
            f"{name} Lifetime Earnings",
            f"sensor.hustle_{slug}_lifetime_earnings",
            lambda data: member_lifetime_cents(data, member_id),
            lambda data: {"member_id": member_id},
            unit="cents",
            state_class="total",
        ),
        MqttEntity(
            f"{MEMBER_KEY_PREFIX}{member_id}_current_paycheck",
            f"{name} Current Paycheck",
            f"sensor.hustle_{slug}_current_paycheck",
            paycheck_state,
            paycheck_attributes,
            unit="cents",
        ),
    ]


def entities_for(data: dict[str, Any]) -> list[MqttEntity]:
    return FIXED_ENTITIES + [
        entity
        for member in data.get("members", [])
        for entity in _member_entities(member.id, member.ha_display_name)
    ]


def _member_keys(data: dict[str, Any]) -> set[str]:
    return {e.key for e in entities_for(data) if e.key.startswith(MEMBER_KEY_PREFIX)}


def build_messages(data: dict[str, Any]) -> dict[str, str]:
    """topic -> payload for every entity's discovery config, state and
    attributes. Pure, so the payload shapes are unit-testable without a
    broker."""
    messages: dict[str, str] = {}
    for entity in entities_for(data):
        messages[entity.discovery_topic] = json.dumps(entity.discovery())
        state = entity.state(data)
        # An empty payload is how an MQTT sensor reports "unknown".
        messages[entity.state_topic] = "" if state is None else str(state)
        if entity.attributes:
            messages[entity.attributes_topic] = json.dumps(entity.attributes(data))
    return messages


def stale_member_keys(published_keys: set[str], data: dict[str, Any]) -> set[str]:
    return {k for k in published_keys if k.startswith(MEMBER_KEY_PREFIX)} - _member_keys(data)


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
    def __init__(self, coordinator: HustleCoordinator, broker: dict) -> None:
        self._coordinator = coordinator
        self._broker = broker
        self._changed = asyncio.Event()
        self._last: dict[str, str] = {}
        # Member discovery keys currently retained on the broker.
        self._published_members: set[str] = set()
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
            identifier="family-hustle-addon",
            will=aiomqtt.Will(AVAILABILITY_TOPIC, "offline", retain=True),
        ) as client:
            _LOGGER.info("Connected to MQTT broker at %s", self._broker["host"])
            self._published_members = await self._retained_member_keys(client)
            await client.publish(AVAILABILITY_TOPIC, "online", retain=True)

            while True:
                self._changed.clear()
                await self._publish_changes(client)
                await self._changed.wait()

    async def _retained_member_keys(self, client: aiomqtt.Client) -> set[str]:
        """Member sensors a previous run left on the broker, so ones whose
        member was removed can be cleared even if that happened while the
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
        return {k for k in keys if k.startswith(MEMBER_KEY_PREFIX)}

    async def _publish_changes(self, client: aiomqtt.Client) -> None:
        data = self._coordinator.data or {}
        if not data:
            return
        for key in stale_member_keys(self._published_members, data):
            # An empty retained config is how discovery removes an entity.
            await client.publish(discovery_topic(key), "", retain=True)
            for kind in ("state", "attributes"):
                await client.publish(f"{BASE_TOPIC}/sensor/{key}/{kind}", "", retain=True)
            self._published_members.discard(key)
            self._last = {t: p for t, p in self._last.items() if f"/{key}/" not in t}
        for topic, payload in build_messages(data).items():
            if self._last.get(topic) != payload:
                await client.publish(topic, payload, retain=True)
                self._last[topic] = payload
        self._published_members |= _member_keys(data)
