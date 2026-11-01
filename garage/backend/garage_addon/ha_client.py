"""Calls into Home Assistant Core, through Supervisor's API proxy.

The integration ran inside Home Assistant and used `hass` directly for the
things Garage needs from it: the Stash (`finance`) integration's
services and category sensors, `notify.*` for driver reminders, and the HA
user list for linking a driver to an account. The add-on also reads the
sensors a vehicle is linked to (odometer / fuel level - see obd.py). The add-on reaches the same
things over Core's REST/websocket API (config.yaml's
`homeassistant_api: true`), authenticated with the SUPERVISOR_TOKEN
Supervisor injects.

Everything here raises HomeAssistantError on failure - callers decide
whether that's fatal (it never is for a Garage mutation; see coordinator.py).
"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)

_TIMEOUT = aiohttp.ClientTimeout(total=15)


class HomeAssistantError(Exception):
    """Home Assistant Core couldn't be reached, or refused the call."""


class HomeAssistantClient:
    def __init__(self, session: aiohttp.ClientSession, base_url: str, token: str) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}
        self._token = token

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with self._session.request(
                method,
                f"{self._base_url}/api/{path}",
                headers=self._headers,
                timeout=_TIMEOUT,
                **kwargs,
            ) as resp:
                if resp.status >= 400:
                    raise HomeAssistantError(
                        f"{method} {path} failed ({resp.status}): {await resp.text()}"
                    )
                return await resp.json(content_type=None)
        except (TimeoutError, aiohttp.ClientError, ValueError) as err:
            raise HomeAssistantError(f"{method} {path} failed: {err}") from err

    async def get_components(self) -> set[str]:
        config = await self._request("GET", "config")
        return set(config.get("components", []))

    async def get_states(self) -> list[dict[str, Any]]:
        return await self._request("GET", "states")

    async def get_state(self, entity_id: str) -> dict[str, Any] | None:
        """None when the entity doesn't exist (404), rather than an error."""
        try:
            return await self._request("GET", f"states/{entity_id}")
        except HomeAssistantError as err:
            if "(404)" in str(err):
                return None
            raise

    async def call_service(
        self,
        domain: str,
        service: str,
        data: dict[str, Any],
        *,
        return_response: bool = False,
    ) -> dict[str, Any] | None:
        path = f"services/{domain}/{service}"
        if return_response:
            path += "?return_response"
        body = await self._request("POST", path, json=data)
        if return_response and isinstance(body, dict):
            return body.get("service_response")
        return None

    async def _ws_commands(self, *command_types: str) -> list[Any]:
        """Runs websocket-only commands (no REST equivalent) over one
        connection, returning each one's result in order."""
        url = f"{self._base_url}/websocket".replace("http", "ws", 1)
        results = []
        try:
            # No message size cap: the entity registry of a big install runs
            # past aiohttp's 4 MB default.
            async with self._session.ws_connect(
                url, timeout=_TIMEOUT.total, max_msg_size=0
            ) as ws:
                await ws.receive_json()  # auth_required
                await ws.send_json({"type": "auth", "access_token": self._token})
                auth = await ws.receive_json()
                if auth.get("type") != "auth_ok":
                    raise HomeAssistantError("Home Assistant rejected the add-on's token")
                for message_id, command_type in enumerate(command_types, start=1):
                    await ws.send_json({"id": message_id, "type": command_type})
                    result = await ws.receive_json()
                    if not result.get("success"):
                        raise HomeAssistantError(f"{command_type} failed: {result.get('error')}")
                    results.append(result.get("result") or [])
        except (TimeoutError, aiohttp.ClientError, ValueError, TypeError) as err:
            raise HomeAssistantError(f"{', '.join(command_types)} failed: {err}") from err
        return results

    async def list_users(self) -> list[dict[str, Any]]:
        """`config/auth/list` only exists on the websocket API."""
        (users,) = await self._ws_commands("config/auth/list")
        return users

    async def list_devices_and_entities(self) -> tuple[list[dict], list[dict]]:
        """The device and entity registries - which device each sensor
        belongs to, for linking a whole OBD dongle at once."""
        devices, entities = await self._ws_commands(
            "config/device_registry/list", "config/entity_registry/list"
        )
        return devices, entities
