"""The panel's read model - a `hass.states`-shaped snapshot for one viewer.

Under the integration, the panel read its athlete data from
`GainsAthleteProfileSensor`'s attributes, finding its own sensor by the
`ha_user_id` attribute and counting every athlete sensor for the profile
count (see the frontend's ha-api.ts `parseGainsState`). These functions
build those same entity payloads straight from the coordinator, so the
frontend's parsing layer carries over unchanged: web.py serves the result at
`api/states` and pushes a fresh one over `api/websocket` on every change.

One difference: the snapshot is built per viewer. Their own athlete sensor
carries the full attribute set the integration's sensor had; everyone
else's carries only the identity markers the panel needs to count athletes.
Home Assistant's state machine exposed every athlete's workouts and Ask
Geoffrey conversation to every logged-in user; the panel never read them,
and the add-on knows who's asking, so it doesn't send them.

Entity ids don't matter to the panel (it never looks them up by id), so
they're keyed by profile id rather than the slugified display names Home
Assistant generated. Keep attribute shapes in sync with what ha-api.ts
parses.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from . import logic
from .const import ATTR_DISPLAY_NAME, ATTR_HA_USER_ID, ATTR_ONBOARDING_COMPLETE, ATTR_PROFILE_ID
from .load_policy import inventory_policy
from .models import AthleteProfile

if TYPE_CHECKING:
    from .coordinator import GainsCoordinator

Entity = dict[str, Any]

PROFILE_COUNT_ENTITY_ID = "sensor.gains_profile_count"


def _entity(entity_id: str, state: Any, attributes: dict[str, Any]) -> Entity:
    # Home Assistant always stringifies state (None becomes "unknown") -
    # ha-api.ts parses state with that in mind, so mirror it.
    return {
        "entity_id": entity_id,
        "state": "unknown" if state is None else str(state),
        "attributes": attributes,
    }


def profile_entity_id(profile: AthleteProfile) -> str:
    return f"sensor.gains_profile_{profile.id}"


def profile_state(profile: AthleteProfile) -> str:
    """The integration sensor's native_value."""
    return profile.experience_level or "unset"


def profile_attributes(coordinator: GainsCoordinator, profile: AthleteProfile) -> dict[str, Any]:
    """Exactly `GainsAthleteProfileSensor.extra_state_attributes`."""
    attrs = logic.profile_extra_attributes(
        profile,
        coordinator.workouts_for_profile(profile.id),
        coordinator.runs_for_profile(profile.id),
        coordinator.profiles,
        coordinator.gym_profiles,
        coordinator.data.share_requests,
    )
    attrs["inventory_policy"] = inventory_policy(profile, coordinator.data)
    attrs["joint_targets"] = coordinator.joint_targets(profile)
    return attrs


def profile_markers(profile: AthleteProfile) -> dict[str, Any]:
    """What another athlete's sensor carries in a viewer's snapshot - enough
    for ha-api.ts to recognize and count it, nothing more."""
    return {
        ATTR_PROFILE_ID: profile.id,
        ATTR_HA_USER_ID: profile.ha_user_id,
        ATTR_DISPLAY_NAME: profile.display_name,
        ATTR_ONBOARDING_COMPLETE: profile.onboarding_complete,
    }


def build_states(coordinator: GainsCoordinator, viewer_id: str | None) -> dict[str, Entity]:
    states: dict[str, Entity] = {
        PROFILE_COUNT_ENTITY_ID: _entity(
            PROFILE_COUNT_ENTITY_ID, len(coordinator.profiles), {}
        ),
    }
    for profile in coordinator.profiles:
        own = bool(viewer_id) and profile.ha_user_id == viewer_id
        attributes = (
            profile_attributes(coordinator, profile) if own else profile_markers(profile)
        )
        entity_id = profile_entity_id(profile)
        states[entity_id] = _entity(entity_id, profile_state(profile), attributes)
    return states
