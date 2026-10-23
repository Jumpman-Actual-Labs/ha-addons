"""Calls into the Stash add-on, for Garage's Stash sync.

Stash used to be a Home Assistant integration, and Garage synced into it
through Core's API (`finance.*_category_expense` services, plus Stash's
category sensors to find a category id by name - see ha_client.py). Stash
is now an add-on in this same repository, so Garage calls it directly on
Supervisor's add-on network instead: `internal/categories` and
`internal/services/<name>` (stash/backend/stash_addon/web.py), which Stash
only answers for Garage's own address.

Add-ons from one repository share a hostname prefix (`<repository
hash>-<slug>`), so Stash's hostname is Garage's own with the slug swapped.

StashUnavailable means the Stash add-on isn't there (not installed, or
stopped) - the coordinator then falls back to the old integration, if
that's still installed. Any other StashError is Stash refusing the call.
"""
from __future__ import annotations

from typing import Any

import aiohttp

_TIMEOUT = aiohttp.ClientTimeout(total=15)
STASH_PORT = 8099


class StashError(Exception):
    """The Stash add-on refused the call."""


class StashUnavailable(StashError):
    """The Stash add-on couldn't be reached at all."""


def stash_base_url(own_hostname: str) -> str | None:
    """`a1b2c3d4-garage` -> `http://a1b2c3d4-stash:8099`. None outside
    Supervisor, where the hostname isn't `<prefix>-garage`."""
    prefix, sep, own_slug = own_hostname.rpartition("-")
    if not sep or not prefix or own_slug != "garage":
        return None
    return f"http://{prefix}-stash:{STASH_PORT}"


class StashClient:
    def __init__(self, session: aiohttp.ClientSession, base_url: str) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with self._session.request(
                method, f"{self._base_url}/internal/{path}", timeout=_TIMEOUT, **kwargs
            ) as resp:
                body = await resp.json(content_type=None)
                if resp.status >= 400:
                    error = body.get("error") if isinstance(body, dict) else None
                    raise StashError(f"{method} {path} failed ({resp.status}): {error}")
                return body
        except (TimeoutError, aiohttp.ClientConnectionError) as err:
            raise StashUnavailable(f"Stash add-on unreachable: {err}") from err
        except (aiohttp.ClientError, ValueError) as err:
            raise StashError(f"{method} {path} failed: {err}") from err

    async def find_category_id(self, category_name: str) -> str | None:
        target = category_name.strip().lower()
        for category in await self._request("GET", "categories"):
            if str(category.get("name", "")).strip().lower() == target:
                return str(category["id"])
        return None

    async def call_service(self, service: str, data: dict[str, Any]) -> dict[str, Any] | None:
        body = await self._request("POST", f"services/{service}", json=data)
        return body.get("response") if isinstance(body, dict) else None
