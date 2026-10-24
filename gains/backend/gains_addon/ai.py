"""AI Coach provider abstraction (partial Phase 8: AI Coach).

Anthropic and OpenAI providers are implemented; AIProvider is kept narrow
(one method) so a later phase can add Gemini/Ollama without
coordinator.py caring which one is configured -- see the retired design
package's "AI provider abstraction" requirement.

The AI never mutates state directly: coordinator.async_ai_chat only ever
turns a provider's raw text into validated, athlete-approved proposals
(see logic.py's parse_ai_reply/validate_proposed_workouts/
validate_proposed_runs/sanitize_profile_updates). This module's only job
is "send a prompt, get text back."
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Any, Protocol

import aiohttp

from .const import DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL

if TYPE_CHECKING:
    from .config import AddonConfig

_LOGGER = logging.getLogger(__name__)

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_API_VERSION = "2023-06-01"
MAX_TOKENS = 16384

# A 429 is a transient "try again shortly" signal, not a real failure --
# both providers report the exact wait themselves (Retry-After header, or
# "...try again in 18.6s" in OpenAI's error message), so retrying a couple
# of times beats surfacing the raw rate-limit text to the athlete.
MAX_RATE_LIMIT_RETRIES = 3
DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5.0
_RETRY_AFTER_SECONDS_RE = re.compile(r"try again in ([\d.]+)s", re.IGNORECASE)


def _rate_limit_wait_seconds(response: Any, payload: dict) -> float:
    """Best-effort read of how long the provider asked us to wait."""
    header = response.headers.get("retry-after") if response.headers else None
    if header is not None:
        try:
            return max(0.0, float(header))
        except ValueError:
            pass
    message = payload.get("error", {}).get("message", "") if isinstance(payload, dict) else ""
    match = _RETRY_AFTER_SECONDS_RE.search(message)
    if match:
        return max(0.0, float(match.group(1)))
    return DEFAULT_RATE_LIMIT_WAIT_SECONDS


JSON_TOOL = {
    "name": "return_gains_response",
    "description": "Return the complete structured Gains response.",
    "input_schema": {
        "type": "object",
        "properties": {
            "proposal": {"type": "object"},
            "reply": {"type": "string"},
            "actions": {"type": "array", "items": {"type": "object"}},
            "proposed_workouts": {"type": "array", "items": {"type": "object"}},
            "proposed_runs": {"type": "array", "items": {"type": "object"}},
        },
        "additionalProperties": True,
    },
}

OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"


class AIProviderError(Exception):
    """Raised when the configured AI provider can't produce a reply."""


class AIProvider(Protocol):
    async def complete(self, system_prompt: str, messages: list[dict[str, str]]) -> str:
        """Return the assistant's raw text reply for this conversation so far."""


class AnthropicProvider:
    """Calls the Anthropic Messages API directly over aiohttp.

    No `anthropic` SDK dependency -- a plain HTTP call covers the one
    endpoint, and keeps the add-on's requirements.txt to what it already
    needs for its own web server.
    """

    def __init__(self, session: aiohttp.ClientSession, api_key: str, model: str) -> None:
        self._session = session
        self._api_key = api_key
        self._model = model

    async def complete(self, system_prompt: str, messages: list[dict[str, str]]) -> str:
        session = self._session
        for attempt in range(MAX_RATE_LIMIT_RETRIES + 1):
            try:
                response = await session.post(
                    ANTHROPIC_API_URL,
                    headers={
                        "x-api-key": self._api_key,
                        "anthropic-version": ANTHROPIC_API_VERSION,
                        "content-type": "application/json",
                    },
                    json={
                        "model": self._model,
                        "max_tokens": MAX_TOKENS,
                        "system": system_prompt,
                        "messages": messages,
                        "tools": [JSON_TOOL],
                        "tool_choice": {"type": "tool", "name": JSON_TOOL["name"]},
                    },
                )
                payload = await response.json()
            except Exception as err:
                _LOGGER.error("Anthropic API call failed: %s", err)
                raise AIProviderError(str(err)) from err

            if response.status == 429 and attempt < MAX_RATE_LIMIT_RETRIES:
                wait = _rate_limit_wait_seconds(response, payload)
                _LOGGER.warning("Anthropic rate limited, retrying in %.1fs", wait)
                await asyncio.sleep(wait)
                continue
            if response.status != 200:
                message = payload.get("error", {}).get("message", f"HTTP {response.status}")
                raise AIProviderError(message)
            break

        blocks = payload.get("content", [])
        tool_result = next(
            (
                block.get("input")
                for block in blocks
                if block.get("type") == "tool_use" and block.get("name") == JSON_TOOL["name"]
            ),
            None,
        )
        if isinstance(tool_result, dict):
            return json.dumps(tool_result)
        text = "".join(block.get("text", "") for block in blocks if block.get("type") == "text")
        if not text:
            raise AIProviderError("Anthropic returned an empty response")
        return text


class OpenAIProvider:
    """Calls the OpenAI Chat Completions API directly over aiohttp.

    Same no-SDK reasoning as AnthropicProvider -- a plain HTTP call avoids
    adding `openai` to requirements.txt.
    """

    def __init__(self, session: aiohttp.ClientSession, api_key: str, model: str) -> None:
        self._session = session
        self._api_key = api_key
        self._model = model

    async def complete(self, system_prompt: str, messages: list[dict[str, str]]) -> str:
        session = self._session
        for attempt in range(MAX_RATE_LIMIT_RETRIES + 1):
            try:
                response = await session.post(
                    OPENAI_API_URL,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "content-type": "application/json",
                    },
                    json={
                        "model": self._model,
                        "messages": [{"role": "system", "content": system_prompt}, *messages],
                        "response_format": {"type": "json_object"},
                    },
                )
                payload = await response.json()
            except Exception as err:
                _LOGGER.error("OpenAI API call failed: %s", err)
                raise AIProviderError(str(err)) from err

            if response.status == 429 and attempt < MAX_RATE_LIMIT_RETRIES:
                wait = _rate_limit_wait_seconds(response, payload)
                _LOGGER.warning("OpenAI rate limited, retrying in %.1fs", wait)
                await asyncio.sleep(wait)
                continue
            if response.status != 200:
                message = payload.get("error", {}).get("message", f"HTTP {response.status}")
                raise AIProviderError(message)
            break

        choices = payload.get("choices", [])
        if not choices:
            raise AIProviderError("OpenAI returned no choices")
        text = choices[0].get("message", {}).get("content", "")
        if not text:
            raise AIProviderError("OpenAI returned an empty response")
        return text


def build_ai_provider(config: AddonConfig, session: aiohttp.ClientSession) -> AIProvider | None:
    """The configured provider, or None when its API key isn't set (Ask
    Geoffrey then answers with coordinator.NO_AI_PROVIDER_REPLY). Was the
    integration's `_configure_ai_provider`; the add-on restarts when its
    options change, so this only runs at startup."""
    if config.ai_provider == "openai":
        if not config.openai_api_key:
            return None
        return OpenAIProvider(
            session, config.openai_api_key, config.openai_model or DEFAULT_OPENAI_MODEL
        )
    if not config.anthropic_api_key:
        return None
    return AnthropicProvider(
        session, config.anthropic_api_key, config.anthropic_model or DEFAULT_ANTHROPIC_MODEL
    )
