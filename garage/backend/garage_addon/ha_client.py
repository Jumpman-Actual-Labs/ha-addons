"""Calls into Home Assistant Core, through Supervisor's API proxy.

The integration ran inside Home Assistant and used `hass` directly for the
three things Garage needs from it: the Stash (`finance`) integration's
services and category sensors, `notify.*` for driver reminders, and the HA
user list for linking a driver to an account. The add-on reaches the same
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

    async def list_users(self) -> list[dict[str, Any]]:
        """`config/auth/list` only exists on the websocket API."""
        url = f"{self._base_url}/websocket".replace("http", "ws", 1)
        try:
            async with self._session.ws_connect(url, timeout=_TIMEOUT.total) as ws:
                await ws.receive_json()  # auth_required
                await ws.send_json({"type": "auth", "access_token": self._token})
                auth = await ws.receive_json()
                if auth.get("type") != "auth_ok":
                    raise HomeAssistantError("Home Assistant rejected the add-on's token")
                await ws.send_json({"id": 1, "type": "config/auth/list"})
                result = await ws.receive_json()
        except (TimeoutError, aiohttp.ClientError, ValueError, TypeError) as err:
            raise HomeAssistantError(f"Listing users failed: {err}") from err
        if not result.get("success"):
            raise HomeAssistantError(f"Listing users failed: {result.get('error')}")
        return result.get("result") or []
