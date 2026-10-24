# Ask Geoffrey, builders and Coach Mode

This is a review implementation, paired with the integration's training services.
Do not deploy this panel ahead of the backend.

## User flows

Ask Geoffrey retains conversation and provides Build Workout, Build Run and Build
Program entry points. Structured actions from chat prefill the same question
engine. Questions branch by sport/event/frequency, retain answers on Back, and
skip known profile duration. Drafts are scoped to viewer and athlete in session
storage. Proposals are editable and require explicit acceptance.

Programs & builders is also accessible from the profile menu. Programs have no
fixed end date. They show the current week and completed sessions, repeat a
four-week schedule cycle until removed, and keep every completed occurrence in
history. Opened sessions use the existing Workouts and Runs views.

To enable coaching, link profiles using the existing account flow. In the
athlete's Account & preferences, use Who can coach me to explicitly grant the
linked coach access. Enter Coach Mode from Geoffrey or the profile menu, then
select an authorized athlete. The gold accent and persistent named banner identify
the active athlete. Use the banner to switch athletes or exit.

## Context and synchronization

`hass.user` always remains the authenticated viewer. `GainsViewContext` identifies
viewer, active profile and mode. `scopedTrainingHass` adapts existing API calls to
authorized response services; all views continue using the normal HA API module.
Keyed mounting resets athlete-specific UI on switches. Session drafts are scoped
to athlete; server target changes invalidate stale local values.

The scoped snapshot refreshes after local changes and pushed HA state changes,
with a two-second polling fallback. Both devices use the same stored workout ID.
Expected revisions reject stale writes. Rest timers remain local to each device.

## Verification

- `npm test`: branching, Geoffrey prefill, sensible splits and stale-answer filtering.
- `npm run build`: TypeScript and production bundle.
- `npm run lint`: existing ESLint rules.

A 390×844 browser smoke check with a fake HA response service covers wizard
prefill/back, skipped known duration, editable proposal, Coach Mode switching,
same workout logging component, target payload, unchanged authentication and exit.
Real HA service responses, AI providers and two-device behavior still need release
acceptance testing. Backend documentation tracks remaining feature limits.

Read-only coaching is enforced by the backend; hiding/disabling each unavailable
mutation control remains UX follow-up. Long program generation, Apply to Next Set,
saved-run/workout AI amendments and persistent shared rest state are not complete.
