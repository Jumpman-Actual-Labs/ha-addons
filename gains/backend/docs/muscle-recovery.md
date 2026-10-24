# Muscle recovery estimates

Profile sensor attributes and `gains/training_state` expose `muscle_recovery`:
`model_version`, UTC `calculated_at`, `half_life_hours`, and `muscles` keyed by
canonical muscle ID. Each muscle has `recovery_percent` (0–100) and nullable
`last_trained_at`. No logged history means 100. Coaches need view_progress
permission to see estimates derived from private workout history.

Version 1 recomputes from completed sets in active/completed workouts belonging
to the athlete. Planned/skipped sessions and uncompleted sets never add fatigue.
Each set adds 6 points scaled by bounded square-root volume (10 reps or 30 seconds
for timed holds), relative intensity against prior exercise estimated 1RM, and
exercise effort (easy 0.6, moderate 0.85, hard 1.1, max 1.3; unrated 1).
Optional stored set RPE 1–10 overrides effort with 0.5 + 0.08 × RPE.
Secondary muscles get 40% of primary fatigue. Fatigue accumulates to at most 100,
then decays with a 24-hour half-life; less than 0.5 points snaps to fully recovered.
These are general training estimates, not measured physiology or injury advice.

Legacy sets use session completion/start/creation time if recorded_at is absent
or invalid. Dates without timezone are treated as UTC; future/undated events are
ignored. Missing reps/load/effort receive neutral defaults. Bodyweight and timed
sets remain supported. No migration or persisted fatigue cache is required;
editing or removing history changes the next estimate without double counting.

The compact frontend keeps existing thumbnails and displays percent recovered.
It validates model version, timestamps and percentages, continues decay between
backend updates, and refreshes displayed readiness each minute. Older backends
or restricted coach snapshots show Recovery unavailable, never exercise coverage.
