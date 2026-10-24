"""Calls into Home Assistant Core, through Supervisor's API proxy
(config.yaml's `homeassistant_api: true`, authenticated with the
SUPERVISOR_TOKEN Supervisor injects).

Only used for account pictures: the Coach tab shows each athlete with the
picture from their Home Assistant person, which ingress doesn't pass along.
A person's `entity_picture` is a path on Home Assistant's own origin
(`/api/image/serve/...`), and so is the ingress panel, so the panel can use
it as-is.
"""
from __future__ import annotations

import logging
import time

import aiohttp

_LOGGER = logging.getLogger(__name__)

_TIMEOUT = aiohttp.ClientTimeout(total=10)
# Long enough that refreshing the Coach tab doesn't hit Core every time,
# short enough that a new picture shows up without a restart.
_PICTURES_TTL_SECONDS = 60


class HomeAssistantClient:
    def __init__(self, session: aiohttp.ClientSession, base_url: str, token: str) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._pictures: dict[str, str] = {}
        self._pictures_at = 0.0

    async def user_pictures(self) -> dict[str, str]:
        """Home Assistant user id -> their person's picture URL. Best-effort:
        on any failure, whatever was fetched last (possibly nothing)."""
        if self._pictures_at and time.monotonic() - self._pictures_at < _PICTURES_TTL_SECONDS:
            return self._pictures
        try:
            async with self._session.get(
                f"{self._base_url}/api/states",
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=_TIMEOUT,
            ) as resp:
                resp.raise_for_status()
                states = await resp.json()
        except (TimeoutError, aiohttp.ClientError, ValueError) as err:
            _LOGGER.warning("Couldn't read account pictures from Home Assistant: %s", err)
            return self._pictures
        self._pictures = person_pictures(states)
        self._pictures_at = time.monotonic()
        return self._pictures


def person_pictures(states: list[dict]) -> dict[str, str]:
    pictures: dict[str, str] = {}
    for state in states if isinstance(states, list) else []:
        if not isinstance(state, dict) or not str(state.get("entity_id", "")).startswith("person."):
            continue
        attributes = state.get("attributes") or {}
        user_id, picture = attributes.get("user_id"), attributes.get("entity_picture")
        if user_id and picture:
            pictures[str(user_id)] = str(picture)
    return pictures
