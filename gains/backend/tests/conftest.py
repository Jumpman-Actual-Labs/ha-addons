"""Runs are switched off (const.RUNS_ENABLED) but their code is kept for
when they come back. Tests of that dormant run behavior carry
`@pytest.mark.runs_enabled`, which switches it on for just that test;
everything else runs with the real default."""
from __future__ import annotations

import pytest

from gains_addon import const


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "runs_enabled: run with const.RUNS_ENABLED switched on")


@pytest.fixture(autouse=True)
def _runs_flag(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    if request.node.get_closest_marker("runs_enabled"):
        monkeypatch.setattr(const, "RUNS_ENABLED", True)
