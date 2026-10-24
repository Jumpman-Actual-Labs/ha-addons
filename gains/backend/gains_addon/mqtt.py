"""Home Assistant entities for automations, via MQTT discovery.

The integration exposed `sensor.gains_profile_count` plus one
`sensor.gains_<name>` per athlete. An add-on can't create entities itself,
so it publishes them through the MQTT broker using Home Assistant's
discovery protocol, with an explicit default_entity_id matching the
integration's entity ids so existing automations keep working once it's
removed.

Athlete sensors keep the integration's state (experience level, or
"unset") and its scalar attributes, plus workout/run counts. The list and
dict attributes (every workout, run, gym, the Ask Geoffrey conversation,
the per-exercise inventory policy) aren't published: they existed to carry
data to the panel, which now reads it from the add-on directly (see
states.py), and on an MQTT sensor they'd be visible to every Home Assistant
user and grow without bound in the recorder.

Athlete sensors come and go with their profiles. Their discovery topics
sit under a `gains` node id, so on connect the publisher can read back what
a previous run left retained and clear any that no longer exist.

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
from .const import ATTR_RUNS, ATTR_WORKOUTS
from .coordinator import GainsCoordinator
from .models import AthleteProfile

_LOGGER = logging.getLogger(__name__)

DISCOVERY_PREFIX = "homeassistant"
NODE_ID = "gains"
BASE_TOPIC = "gains"
AVAILABILITY_TOPIC = f"{BASE_TOPIC}/availability"
RECONNECT_SECONDS = 30
# How long to collect retained discovery configs from a previous run.
RETAINED_SCAN_SECONDS = 2

PROFILE_KEY_PREFIX = "profile_"

_DEVICE = {
    "identifiers": ["gains_addon"],
    "name": "Gains",
    "manufacturer": "Jumpman Actual Labs",
    "model": "Gains add-on",
}


def slugify(text: str) -> str:
    """Close enough to Home Assistant's slugify for entity ids built from an
    athlete's display name ("Jordan's" -> "jordans")."""
    return re.sub(r"[^a-z0-9]+", "_", text.lower().replace("'", "")).strip("_")


@dataclass(frozen=True)
class MqttEntity:
    key: str  # discovery object id and topic segment
    name: str
    entity_id: str
    icon: str
    state: Callable[[GainsCoordinator], Any]
    attributes: Callable[[GainsCoordinator], dict[str, Any]] | None = None

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
            "unique_id": f"gains_addon_{self.key}",
            "default_entity_id": self.entity_id,
            "icon": self.icon,
            "state_topic": self.state_topic,
            "availability_topic": AVAILABILITY_TOPIC,
            "device": _DEVICE,
        }
        if self.attributes:
            config["json_attributes_topic"] = self.attributes_topic
        return config


def discovery_topic(key: str) -> str:
    return f"{DISCOVERY_PREFIX}/sensor/{NODE_ID}/{key}/config"


PROFILE_COUNT = MqttEntity(
    "profile_count",
    "Profile Count",
    "sensor.gains_profile_count",
    "mdi:account-group",
    lambda coordinator: len(coordinator.profiles),
)


def _find(coordinator: GainsCoordinator, profile_id: str) -> AthleteProfile:
    return next(p for p in coordinator.profiles if p.id == profile_id)


def athlete_attributes(coordinator: GainsCoordinator, profile: AthleteProfile) -> dict[str, Any]:
    full = states.profile_attributes(coordinator, profile)
    attributes = {k: v for k, v in full.items() if not isinstance(v, (list, dict))}
    attributes["workouts_completed"] = sum(
        1 for w in full[ATTR_WORKOUTS] if w.get("status") == "completed"
    )
    attributes["runs_completed"] = sum(
        1 for r in full[ATTR_RUNS] if r.get("status") == "completed"
    )
    return attributes


def _athlete_entity(profile: AthleteProfile) -> MqttEntity:
    profile_id = profile.id
    return MqttEntity(
        f"{PROFILE_KEY_PREFIX}{profile_id}",
        profile.display_name,
        f"sensor.gains_{slugify(profile.display_name) or profile_id}",
        "mdi:dumbbell",
        lambda coordinator: states.profile_state(_find(coordinator, profile_id)),
        lambda coordinator: athlete_attributes(coordinator, _find(coordinator, profile_id)),
    )


def entities_for(coordinator: GainsCoordinator) -> list[MqttEntity]:
    return [PROFILE_COUNT] + [_athlete_entity(p) for p in coordinator.profiles]


def build_messages(coordinator: GainsCoordinator) -> dict[str, str]:
    """topic -> payload for every entity's discovery config, state and
    attributes. Pure, so the payload shapes are unit-testable without a
    broker."""
    messages: dict[str, str] = {}
    for entity in entities_for(coordinator):
        messages[entity.discovery_topic] = json.dumps(entity.discovery())
        messages[entity.state_topic] = str(entity.state(coordinator))
        if entity.attributes:
            messages[entity.attributes_topic] = json.dumps(entity.attributes(coordinator))
    return messages


def dynamic_keys(coordinator: GainsCoordinator) -> set[str]:
    return {
        e.key for e in entities_for(coordinator) if e.key.startswith(PROFILE_KEY_PREFIX)
    }


def stale_dynamic_keys(published_keys: set[str], coordinator: GainsCoordinator) -> set[str]:
    published = {k for k in published_keys if k.startswith(PROFILE_KEY_PREFIX)}
    return published - dynamic_keys(coordinator)


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
    def __init__(self, coordinator: GainsCoordinator, broker: dict) -> None:
        self._coordinator = coordinator
        self._broker = broker
        self._changed = asyncio.Event()
        self._last: dict[str, str] = {}
        # Athlete discovery keys currently retained on the broker.
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
            identifier="gains-addon",
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
        """Athlete sensors a previous run left on the broker, so ones whose
        profile is gone can be cleared even if that happened while the broker
        was unreachable."""
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
        return {k for k in keys if k.startswith(PROFILE_KEY_PREFIX)}

    async def _publish_changes(self, client: aiomqtt.Client) -> None:
        coordinator = self._coordinator
        for key in stale_dynamic_keys(self._published_dynamic, coordinator):
            # An empty retained config is how discovery removes an entity.
            await client.publish(discovery_topic(key), "", retain=True)
            for kind in ("state", "attributes"):
                await client.publish(f"{BASE_TOPIC}/sensor/{key}/{kind}", "", retain=True)
            self._published_dynamic.discard(key)
            self._last = {t: p for t, p in self._last.items() if f"/{key}/" not in t}
        for topic, payload in build_messages(coordinator).items():
            if self._last.get(topic) != payload:
                await client.publish(topic, payload, retain=True)
                self._last[topic] = payload
        self._published_dynamic |= dynamic_keys(coordinator)
