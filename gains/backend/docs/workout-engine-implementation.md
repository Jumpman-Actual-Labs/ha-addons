# Workout engine implementation and rollout gate

Independent Gains implementation, 14 October 2026. No Gravl source, catalog, constants,
or implementation was used. Existing Gains exercise IDs and manual catalog remain intact.

## Baseline and reconciliation

Remote main still matches the audit: backend `b39bab4d4bc9e8708218eb03057bd3554df6f1b9`,
frontend `8dc6d72b4ca153f459b7198fe7cde4fbf9455b38`. Remote branch inventories were fetched.
The retained custom-split feature branch has the same backend tree as main; older recovery,
effort and weekly-generation branches omit newer main features. Work starts from main's
combined feature set, rather than replacing it with an older feature branch.

## Phase evidence

| Phase | Delivered behavior | Verification |
| --- | --- | --- |
| 0 | Scheduler import stubs repaired; semantic failures captured before behavioral changes | 323 original backend tests passed; 11 new failing cases reproduced intent, selection, exposure, split parsing, duration and malformed-response defects |
| 1 | Typed intent/session/context contracts; numeric Other normalization; authoritative counts/days; specific muscle targeting; all generated workouts use the session boundary | Five authored days with 0/1/5/6 adversarial AI sessions, wizard muscle fields, valid squat on chest request through builder and chat, acceptance and storage round-trip |
| 2 | Reviewed movement pool, family caps, stable mains, local seeded accessory choice, actual completed exposure and separate week reservations | Multi-seed target/uniqueness/staple invariants; planned history excluded; whole-week reservations |
| 3 | Shared recovery replay, warmup classification, actual active sets, explicit rest, duration estimates/trimming, role conflicts without split substitution | Short/long workload tests, actual secondary fatigue consistency, warmup exclusion; frontend uses prescribed rests |
| 4 | Selection precedes prescription; working-set success and existing exercise effort drive fixed rep ranges; physical plate quantities, pairs, stack limits and assistance direction; immutable unit/gym snapshots | Normal coordinator logging yields 100 -> 102 kg with available paired plates; hard/partial work, timed/bodyweight/assistance modes, shared-unit conversion and owned history tests |
| 5 | Origin contracts, calendar/completion rotation, explicit lighter-week cadence, immutable generated/opened weeks, per-scope generation locks, context/revision checks, bounded provider fallback, retryable acceptance/save failures | Rotation/opening, edited authoring, concurrent generation, cancellation, outages, idempotent acceptance and save-failure tests |

Manual edits are explicit overrides and remain reviewable. Edited programs use their edited
structure as the source of future weeks. Legacy multiweek templates stay readable and retain
their original cycle. Generated weekly contracts freeze on opening; actual logs remain separate.
All existing permission, child-weighted, joint-device and sharing tests are retained.

## Defined policies and limitations

- Generation uses a deliberately small reviewed metadata pool. Unreviewed entries remain
  available to manual editing but cannot fill generated roles. Additional catalog tagging is
  future reviewed work, not inferred metadata silently applied to all 209 exercises.
- A selected inventory enforces known physical equipment and load ladders. Machines/cables
  without a supported load configuration are excluded from automatic selection. Generic
  plate-loaded machines without explicit sleeve/base-load conventions are not assigned an
  invented ladder. Bench/rack requirements are reviewed for the initial candidate pool.
- No selected gym retains the existing unconfigured-inventory policy. Loads are conservative
  estimates with a visible warning, not a claim of equipment feasibility. Legacy inventory units
  and performance contexts are unknown; no historical numbers are rewritten.
- Stack targets use nominal stack labels, with pulley configuration retained as context.
  Higher assistance means easier work, so assistance progression reduces the nominal load.
- Recovery and duration are estimates, not measurements. Duration includes five minutes of
  warmup, per-exercise transitions, repetition pace and prescribed rests. No new physiology
  model or automatic unrelated split substitution is introduced.
- Text extraction covers bounded explicit muscle/duration/floor-press phrases; the existing
  Geoffrey builder prefill is the route for richer structured requests. Private chat text is not
  retained in planning diagnostics.
- Local real HA checks use HA 2025.1.4 on Python 3.12. Windows lacks HA's POSIX `fchmod`
  atomic writer: local service tests use FakeStore there. Linux CI enforces actual HA imports
  and performs the real disk Store round-trip, on Python 3.12, 3.13 and 3.14 compatible HA releases.
  No deployed HA instance or paid/live AI provider was exercised.

## Production approval required

These PRs do not authorize rollout. Before merging either main: require green backend/frontend
validation and hassfest, verify the deployed HA version, back up `.storage/gains_data`,
and test the copied store on a staging host. Install both compatible
components together, check coach/child/shared-gym paths and normal logging, then obtain the
user's explicit approval to merge/deploy and restart HA. Roll back both components together;
additive fields allow the older reader to ignore them. Do not restore an old backup over new
logs without separately preserving those logs.
