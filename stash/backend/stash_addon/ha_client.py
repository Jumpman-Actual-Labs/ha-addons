"""Calls into Home Assistant Core, through Supervisor's API proxy.

The panel ran inside Home Assistant's frontend, where `hass.user` said who
was looking (and whether they're an admin - the Household view gates edits
on it) and `hass.callWS({type: "config/auth/list"})` listed accounts to link
a member to. Ingress only passes the user's id and name, so the add-on asks
Core's websocket API for the rest (config.yaml's `homeassistant_api: true`),
authenticated with the SUPERVISOR_TOKEN Supervisor injects.
"""
from __future__ import annotations

import time
from typing import Any

import aiohttp

_TIMEOUT = aiohttp.ClientTimeout(total=15)
# Long enough that opening the panel doesn't hit Core every time, short
# enough that a new account or admin change shows up without a restart.
_USERS_TTL_SECONDS = 60

ADMIN_GROUP = "system-admin"


class HomeAssistantError(Exception):
    """Home Assistant Core couldn't be reached, or refused the call."""


class HomeAssistantClient:
    def __init__(self, session: aiohttp.ClientSession, base_url: str, token: str) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._users: list[dict[str, Any]] = []
        self._users_at = 0.0

    async def list_users(self) -> list[dict[str, Any]]:
        """`config/auth/list` only exists on the websocket API. Cached for
        _USERS_TTL_SECONDS."""
        if self._users_at and time.monotonic() - self._users_at < _USERS_TTL_SECONDS:
            return self._users
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
        self._users = result.get("result") or []
        self._users_at = time.monotonic()
        return self._users


def is_admin(user: dict[str, Any]) -> bool:
    return bool(user.get("is_owner")) or ADMIN_GROUP in (user.get("group_ids") or [])
