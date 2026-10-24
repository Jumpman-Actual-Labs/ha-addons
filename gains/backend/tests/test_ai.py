"""Provider-level structured output contracts."""

from __future__ import annotations

import json

import pytest

from gains_addon import ai


class Response:
    def __init__(self, payload, status=200, headers=None):
        self.payload = payload
        self.status = status
        self.headers = headers or {}

    async def json(self):
        return self.payload


class Session:
    def __init__(self, response):
        self.responses = [response] if not isinstance(response, list) else response
        self.requests = []

    async def post(self, url, **kwargs):
        self.requests.append((url, kwargs))
        if len(self.responses) > 1:
            return self.responses[len(self.requests) - 1]
        return self.responses[0]


def _fake_sleep(recorder):
    async def sleep(seconds):
        recorder.append(seconds)

    return sleep


async def test_anthropic_forces_and_reads_structured_tool_output(monkeypatch):
    session = Session(
        Response(
            {
                "content": [
                    {
                        "type": "tool_use",
                        "name": ai.JSON_TOOL["name"],
                        "input": {"proposal": {"name": "Workout"}},
                    }
                ]
            }
        )
    )
    provider = ai.AnthropicProvider(session, "key", "model")
    result = json.loads(await provider.complete("system", [{"role": "user", "content": "go"}]))
    body = session.requests[0][1]["json"]
    assert result["proposal"]["name"] == "Workout"
    assert body["tool_choice"] == {"type": "tool", "name": ai.JSON_TOOL["name"]}
    assert body["tools"][0]["input_schema"]["type"] == "object"


async def test_openai_requests_json_object_response(monkeypatch):
    session = Session(Response({"choices": [{"message": {"content": '{"reply":"Hello"}'}}]}))
    provider = ai.OpenAIProvider(session, "key", "model")
    assert json.loads(await provider.complete("system", []))["reply"] == "Hello"
    assert session.requests[0][1]["json"]["response_format"] == {"type": "json_object"}


async def test_openai_retries_once_after_rate_limit_then_succeeds(monkeypatch):
    slept = []
    monkeypatch.setattr(ai.asyncio, "sleep", _fake_sleep(slept))
    session = Session(
        [
            Response(
                {"error": {"message": "Rate limit reached. Please try again in 18.6s."}},
                status=429,
            ),
            Response({"choices": [{"message": {"content": '{"reply":"Hello"}'}}]}),
        ]
    )
    provider = ai.OpenAIProvider(session, "key", "model")
    result = json.loads(await provider.complete("system", []))
    assert result["reply"] == "Hello"
    assert len(session.requests) == 2
    assert slept == [18.6]


async def test_openai_prefers_retry_after_header_over_message_text(monkeypatch):
    slept = []
    monkeypatch.setattr(ai.asyncio, "sleep", _fake_sleep(slept))
    session = Session(
        [
            Response(
                {"error": {"message": "try again in 18.6s"}},
                status=429,
                headers={"retry-after": "2"},
            ),
            Response({"choices": [{"message": {"content": '{"reply":"Hello"}'}}]}),
        ]
    )
    provider = ai.OpenAIProvider(session, "key", "model")
    await provider.complete("system", [])
    assert slept == [2.0]


async def test_openai_raises_after_exhausting_rate_limit_retries(monkeypatch):
    monkeypatch.setattr(ai.asyncio, "sleep", _fake_sleep([]))
    response = Response({"error": {"message": "Rate limit reached."}}, status=429)
    session = Session(response)
    provider = ai.OpenAIProvider(session, "key", "model")
    with pytest.raises(ai.AIProviderError, match="Rate limit reached"):
        await provider.complete("system", [])
    assert len(session.requests) == ai.MAX_RATE_LIMIT_RETRIES + 1


async def test_anthropic_retries_after_rate_limit_then_succeeds(monkeypatch):
    slept = []
    monkeypatch.setattr(ai.asyncio, "sleep", _fake_sleep(slept))
    session = Session(
        [
            Response({"error": {"message": "rate limited"}}, status=429),
            Response(
                {
                    "content": [
                        {
                            "type": "tool_use",
                            "name": ai.JSON_TOOL["name"],
                            "input": {"proposal": {"name": "Workout"}},
                        }
                    ]
                }
            ),
        ]
    )
    provider = ai.AnthropicProvider(session, "key", "model")
    result = json.loads(await provider.complete("system", [{"role": "user", "content": "go"}]))
    assert result["proposal"]["name"] == "Workout"
    assert len(session.requests) == 2
    assert slept == [ai.DEFAULT_RATE_LIMIT_WAIT_SECONDS]


# build_ai_provider - was the integration's _configure_ai_provider (test_init.py).


def _config(tmp_path, **options):
    from gains_addon.config import AddonConfig

    return AddonConfig(data_dir=tmp_path, ha_config_dir=tmp_path, static_dir=tmp_path, **options)


def test_build_ai_provider_is_none_without_any_key(tmp_path):
    assert ai.build_ai_provider(_config(tmp_path), object()) is None


def test_build_ai_provider_picks_anthropic_by_default(tmp_path):
    provider = ai.build_ai_provider(_config(tmp_path, anthropic_api_key="sk-test"), object())
    assert isinstance(provider, ai.AnthropicProvider)


def test_build_ai_provider_picks_openai_when_selected(tmp_path):
    config = _config(tmp_path, ai_provider="openai", openai_api_key="sk-test")
    assert isinstance(ai.build_ai_provider(config, object()), ai.OpenAIProvider)


def test_build_ai_provider_selected_provider_without_key_is_none(tmp_path):
    # A key for the *other* provider doesn't count.
    config = _config(tmp_path, ai_provider="openai", anthropic_api_key="sk-test")
    assert ai.build_ai_provider(config, object()) is None
