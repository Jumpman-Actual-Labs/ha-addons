# Workout Together

From a planned workout's overflow menu, an athlete can invite any other Gains profile on
this Home Assistant instance. A pending ShareRequest of kind `joint_workout` stores the
source workout id, revision and device choice. No workout is added or started until the
recipient accepts in their own account. Declining leaves both workouts unchanged.

Acceptance creates active athlete-owned records linked by the same persistent session id.
The recipient can use different weight units or gym equipment and can have another active
workout. Planned weights are converted to their units, and each participant's logs display
that athlete's units. No account linking or coach grant is required to receive an invite.
Only the intended recipient can accept; a coach cannot accept or join on their behalf.

The two participant records identify profile, workout, membership status and a snapshot of
their personal exercise/set logs. The authoritative logs remain in the participant's own
Workout: this preserves existing history, personal records, recovery and program attribution.
The second athlete receives a fresh prescription with no copied performance or program link.
Joining never grants permission to log for the other athlete. Existing explicitly granted
coach permissions still apply; recorded-by identifies the authenticated athlete or coach.

The default order is exercise 1 / set 1 / A, then B, then set 2 / A, then B, before exercise 2.
The backend rejects new logs outside the current turn; corrections do not advance the turn.
Both records carry identical session metadata, persisted in the existing Store and published
through sensors and training_state. Partner updates advance both workout revisions, so stale
session_action requests fail. Sending an invite and joint membership mutations require expected_revision.
Acceptance and membership mutations use the training service lock. Stale invitations cannot
start a source workout that has changed or already started. The panel's existing two-second refresh updates both accounts.

Finish saves only the current athlete's history and removes them from the turn rotation;
the partner can keep training. Leave removes the current athlete from rotation and lets them
continue solo. End detaches both athletes for solo continuation. No operation deletes the
partner's workout. Departed participant snapshots freeze, so later solo logs are not shared.
Structure edits, skip and delete require leaving first; weight/reps planning, bar choices,
notes, effort and corrections remain personal. Sharing still uses the existing accept-first
copy workflow, independently of Workout Together.

Session metadata is additive and optional for older stores. Invalid session data is ignored
without changing legacy workout histories. Two session replicas are stored atomically with
their owned workout records; no storage-version migration or external database is required.

## Device choice

The partner picker requires a choice between the same device and different devices.
Sessions persist `device_mode`; legacy sessions default to `different_devices`.
Different-device logging remains restricted to the authenticated athlete or their existing coach.

In `same_device` mode, `controller_profile_id` identifies the initiating account. The shared
workout screen reuses the normal set rows, reps/weight inputs, Log set button and timed-set
controls, interleaving labeled rows A1, B1, A2, B2. Drafts and timers are keyed by the performing
athlete's workout. The usual exercise-effort prompt uses the scoped `log_effort` action after
an athlete finishes their exercise, even if the turn has moved to their partner. It updates
effort without rewriting any set log. Recorded-by still identifies the authenticated controller;
PRs, recovery and history belong to the performing athlete. The controller may finish each
participant independently, including finishing the second athlete after saving their own workout.

This scope exists only through `joint_session_action` for active session participants. It cannot
be used by another account, outside the session, in coach mode, after leaving, or after the session
ends. Selecting a shared device never creates a coach grant or unlocks direct partner edits.
The normal turn, input and expected-revision checks also apply to shared-device logging.
