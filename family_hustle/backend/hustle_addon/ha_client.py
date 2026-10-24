"""Calls into Home Assistant Core, through Supervisor's API proxy.

The integration ran inside Home Assistant and used `hass` directly for the
things Hustle needs from it: firing `hustle_*` events, `notify.*` for
per-member push alerts, and the HA user list (linking a member to an
account, and whether the viewer is an HA admin for first-run setup). The
add-on also reads and writes Home Assistant's calendars (the family's
Google Calendar, through HA's Google Calendar integration) for the Calendar
and Meals tabs - see family_calendar.py. The
add-on reaches the same things over Core's REST/websocket API (config.yaml's
`homeassistant_api: true`), authenticated with the SUPERVISOR_TOKEN
Supervisor injects.

Everything here raises HomeAssistantError on failure - callers decide
whether that's fatal (it never is for a Hustle mutation; see bridge.py).
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
        self._headers = {"Authorization": f"Bearer {token}"}
        self._token = token
        self._users: list[dict[str, Any]] = []
        self._users_at = 0.0

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

    async def call_service(self, domain: str, service: str, data: dict[str, Any]) -> None:
        await self._request("POST", f"services/{domain}/{service}", json=data)

    async def fire_event(self, event_type: str, data: dict[str, Any]) -> None:
        await self._request("POST", f"events/{event_type}", json=data)

    async def ws_command(self, message: dict[str, Any]) -> Any:
        """One websocket command on its own short-lived connection - for the
        few things only the websocket API has (`config/auth/list`,
        `calendar/event/*`). Returns the command's `result`."""
        url = f"{self._base_url}/websocket".replace("http", "ws", 1)
        try:
            async with self._session.ws_connect(url, timeout=_TIMEOUT.total) as ws:
                await ws.receive_json()  # auth_required
                await ws.send_json({"type": "auth", "access_token": self._token})
                auth = await ws.receive_json()
                if auth.get("type") != "auth_ok":
                    raise HomeAssistantError("Home Assistant rejected the add-on's token")
                await ws.send_json({"id": 1, **message})
                result = await ws.receive_json()
        except (TimeoutError, aiohttp.ClientError, ValueError, TypeError) as err:
            raise HomeAssistantError(f"{message.get('type')} failed: {err}") from err
        if not result.get("success"):
            error = result.get("error") or {}
            raise HomeAssistantError(error.get("message") or f"{message.get('type')} failed")
        return result.get("result")

    async def list_users(self) -> list[dict[str, Any]]:
        """`config/auth/list` only exists on the websocket API. Cached for
        _USERS_TTL_SECONDS."""
        if self._users_at and time.monotonic() - self._users_at < _USERS_TTL_SECONDS:
            return self._users
        self._users = await self.ws_command({"type": "config/auth/list"}) or []
        self._users_at = time.monotonic()
        return self._users

    async def get_calendars(self) -> list[dict[str, Any]]:
        """Every `calendar.*` entity: `[{entity_id, name}]`."""
        return await self._request("GET", "calendars") or []

    async def get_calendar_events(
        self, entity_id: str, start: str, end: str
    ) -> list[dict[str, Any]]:
        """Events overlapping [start, end) - each `{summary, start, end,
        description, location, uid, recurrence_id, rrule}`, `start`/`end`
        being `{"date": ...}` (all-day) or `{"dateTime": ...}`."""
        return (
            await self._request(
                "GET", f"calendars/{entity_id}", params={"start": start, "end": end}
            )
            or []
        )


def is_admin(user: dict[str, Any]) -> bool:
    return bool(user.get("is_owner")) or ADMIN_GROUP in (user.get("group_ids") or [])
