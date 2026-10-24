# Geoffrey training and Coach Mode — review implementation

## Architecture

The existing provider abstraction, coordinator, Store, workouts, runs and logging
services remain authoritative. `training.py` contains the shared request/context
and deterministic proposal validators. `training_coordinator.py` adds explicitly
scoped service operations without changing the self-only `_own_workout` and
`_own_run` helpers.

`build_training` receives `{type, source, answers}` as structured JSON. Chat uses
the same context and validators. No builder constructs a fake conversational
prompt. Both paths require editable review and `accept_training` before creating
records. Acceptance is idempotent per proposal and revalidates edited payloads.

Programs retain week/session prescriptions and materialize an actual workout/run
only when a session is opened. Actual records contain `program_id` and
`program_session_id`; the program session contains `actual_id`. Progress is
derived from actual records. Starting a session and proposal acceptance are
serialized with a coordinator lock. Program edits use revision checks and retain
already-materialized sessions.

## Services

All new services return response data through normal HA service responses:

- `training_state`: authenticated active-athlete snapshot and permitted choices.
- `build_training`: generate and persist a validated, unaccepted proposal.
- `review_training`: validate/register an editable chat proposal.
- `accept_training`: revalidate and create accepted training.
- `program_action`: activate/pause/remove, edit, or open a program session.
- `session_action`: explicit allowlist for existing logging and planned-set edits.
- `set_coach_permissions`: grant/revoke access to the caller's own athlete data.
- `ask_geoffrey`: chat with an explicit optional target athlete.

The service context's `user_id` is always the viewer identity. A client-supplied
`target_profile_id` is only a requested resource scope, never authentication.

## Directional permissions

The athlete owns `coach_grants[coach_profile_id]`. A linked relationship AND an
explicit permission are required. Existing links retain sharing and receive no
new privileges. Administrator status does not bypass coaching authorization.
Unlinking removes grants in both directions, so relinking cannot resurrect them.

Permissions: `view_workouts`, `coach_workouts`, `view_progress`, `manage_programs`.
Live logging implies workout viewing. Geoffrey requires training history access
as well as the applicable editing permission. Coaching conversations are separate
from the athlete's private chat. Role metadata supports coach, guardian and
training partner without inferring parental authority from names or account links.

Log attribution uses the authenticated viewer's Gains profile. Workout ownership
and performance remain with the athlete. Revisions and audit entries record edits.

These checks protect Gains service paths. They do not replace Home Assistant's
own authorization model for entities exposed elsewhere in the host application.

## Storage and rollout

All changes are additive to Store version 1; no existing key changes shape.
Missing programs/proposals/grants/segments/audit fields load as empty defaults.
Existing simple runs, workouts, links and sharing remain readable. No automatic
coaching grants are migrated. Back up the existing Gains Store before deployment.

Deploy backend and matching frontend together. Deploying backend main restarts
Home Assistant; these changes should remain on review branches until approved.
The new panel depends on the new response services.

## Review limits / remaining acceptance work

- Programs are ongoing and store a four-week schedule cycle. Each calendar-week
  occurrence materializes a distinct workout/run and remains in history after the
  program is removed. Invalid or truncated cycles fail before proposal creation.
- Progression and conflict avoidance are provider instructions, not a complete
  deterministic scheduling/progression engine. Completed training is included in
  future context; automatic adaptation is not implemented.
- Program/session editors support replacement, day moves and scoped regeneration.
  Geoffrey does not yet emit approved in-place edits to existing saved runs or
  workouts, or an Apply to Next Set action. Human Coach Mode supports direct edits.
- Current exercise/set lives on the existing workout. Rest countdowns remain
  device-local; coach presence and multi-athlete session tracking are not included.
- Exercise skipping records a note and advances focus; there is no separate skip
  state yet. Per-exercise rest prescriptions are not introduced.
- End-to-end tests against a real HA instance, two physical devices and configured
  AI providers are still required before release. Unit tests use the repository's
  existing HA stubs and fake provider; they are not proof of live integration.

## Verification

Run `PYTHONPATH=. python3 -m pytest tests -q` and
`python3 -m ruff check custom_components/gains tests/test_training.py`.
Security tests preserve original ownership tests and cover directional grants,
wrong-target rejection, revision conflicts, attribution, revocation during AI
requests, additive storage, sharing, and idempotent materialization/acceptance.
