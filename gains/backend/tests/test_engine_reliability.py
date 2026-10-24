"""Failure, concurrency and authored state policies through coordinator routes."""
import asyncio
import copy
import json

import pytest

from gains_addon import training
from gains_addon.models import GainsData
from tests.inventory_fixtures import equip
from tests.test_coordinator import coordinator as base_coordinator
from tests.test_engine_coordinator import REQUEST


@pytest.fixture(name='coordinator')
async def engine_coordinator():
    return await base_coordinator.__wrapped__()


async def test_failed_acceptance_is_retryable_and_manual_program_edits_survive(coordinator):
    await coordinator.async_ensure_profile('u', 'Synthetic')
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    proposal = await coordinator.async_build_training('u', copy.deepcopy(REQUEST))
    original_save = coordinator._store.async_save
    async def failed_save(data):
        raise OSError('synthetic disk failure')
    coordinator._store.async_save = failed_save
    with pytest.raises(OSError):
        await coordinator.async_accept_training('u', proposal['id'], proposal['payload'])
    assert not coordinator.data.programs
    assert not coordinator.data.training_proposals[0].get('accepted_id')
    coordinator._store.async_save = original_save
    edited = copy.deepcopy(proposal['payload'])
    edited['weeks'][0]['sessions'][0]['name'] = 'Core Training'
    await coordinator.async_accept_training('u', proposal['id'], edited)
    program = coordinator.data.programs[0]
    assert not program.origin_request
    assert program.manual_overrides
    explicit_ids = [
        e["exercise_id"] for e in edited["weeks"][0]["sessions"][0]["prescription"]["exercises"]
    ]
    await coordinator.async_program_action('u', program.id, 'generate_week', {'week_number': 2})
    assert program.generated_weeks["2"]["sessions"][0]["name"] == "Core Training"
    assert [
        e["exercise_id"]
        for e in program.generated_weeks["2"]["sessions"][0]["prescription"]["exercises"]
    ] == explicit_ids


async def test_duplicate_week_generation_is_single_flight(coordinator):
    await coordinator.async_ensure_profile('u', 'Synthetic')
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    proposal = await coordinator.async_build_training('u', copy.deepcopy(REQUEST))
    await coordinator.async_accept_training('u', proposal['id'], proposal['payload'])
    program = coordinator.data.programs[0]
    entered, released = asyncio.Event(), asyncio.Event()
    class WaitingProvider:
        calls = 0
        async def complete(self, prompt, messages):
            self.calls += 1
            entered.set()
            await released.wait()
            return json.dumps({'proposal': proposal['payload']})
    provider = WaitingProvider()
    coordinator.ai_provider = provider
    first = asyncio.create_task(
        coordinator.async_program_action("u", program.id, "generate_week", {"week_number": 2})
    )
    await entered.wait()
    second = asyncio.create_task(
        coordinator.async_program_action("u", program.id, "generate_week", {"week_number": 2})
    )
    released.set()
    results = await asyncio.gather(first, second)
    assert provider.calls == 1
    assert sorted(result['generated'] for result in results) == [False, True]


async def test_completion_rotation_advances_only_linked_finished_events(coordinator):
    await coordinator.async_ensure_profile("u", "Synthetic")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    request = {
        "type": "program",
        "source": "wizard",
        "answers": {"lifting_days": 3, "split": "PHUL", "sequencing_policy": "completion"},
    }
    proposal = await coordinator.async_build_training('u', request)
    await coordinator.async_accept_training('u', proposal['id'], proposal['payload'])
    program = coordinator.data.programs[0]
    assert (
        training.program_template(program, 2, coordinator.data)["sessions"][0]["name"]
        == "Power Upper Training"
    )
    opened = await coordinator.async_program_action(
        "u", program.id, "open_session", {"session_id": "w1s1"}
    )
    await coordinator.async_skip_workout("u", opened["id"])
    assert (
        training.program_template(program, 2, coordinator.data)["sessions"][0]["name"]
        == "Power Lower Training"
    )
    await coordinator.async_delete_workout('u', opened['id'])
    restored = GainsData.from_dict(coordinator.data.to_dict())
    assert (
        training.program_template(restored.programs[0], 2, restored)["sessions"][0]["name"]
        == "Power Lower Training"
    )


async def test_cancellation_releases_generation_scope(coordinator):
    await coordinator.async_ensure_profile('u', 'Synthetic')
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    entered = asyncio.Event()
    class WaitingProvider:
        async def complete(self, prompt, messages):
            entered.set()
            await asyncio.Event().wait()
    coordinator.ai_provider = WaitingProvider()
    task = asyncio.create_task(coordinator.async_build_training('u', copy.deepcopy(REQUEST)))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    coordinator.ai_provider = None
    proposal = await coordinator.async_build_training('u', copy.deepcopy(REQUEST))
    assert proposal and len(coordinator.data.training_proposals) == 1


async def test_session_specific_staples_follow_split_identity_across_rotation(coordinator):
    await coordinator.async_ensure_profile("u", "Synthetic")
    equip(coordinator.get_profile_by_user_id('u'), coordinator.data)
    await coordinator.async_update_profile("u", preferred_sequencing_policy="calendar")
    request = {
        "type": "program",
        "source": "wizard",
        "answers": {
            "lifting_days": 3,
            "split": "PHUL",
            "session_preferences": {"1": {"required_exercises": ["barbell_bench_press"]}},
        },
    }
    proposal = await coordinator.async_build_training("u", request)
    await coordinator.async_accept_training(
        "u", proposal["id"], json.loads(json.dumps(proposal["payload"]))
    )
    program = coordinator.data.programs[0]
    await coordinator.async_program_action('u', program.id, 'generate_week', {'week_number': 2})
    week = program.generated_weeks['2']
    assert week['sessions'][0]['name'] == 'Hypertrophy Lower Training'
    assert week['sessions'][1]['name'] == 'Power Upper Training'
    assert week["sessions"][0]["prescription"]["planning"]["intent"]["required"] == []
    assert (
        "barbell_bench_press"
        in week["sessions"][1]["prescription"]["planning"]["intent"]["required"]
    )
