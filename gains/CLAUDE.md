# Gains add-on

AI-assisted workout planning and tracking as a Home Assistant **add-on**:
athlete profiles (one per Home Assistant user, created on first visit),
strength workouts logged set by set, runs, gym equipment profiles, programs
built and adjusted by "Ask Geoffrey" (Anthropic or OpenAI), coach mode,
Workout Together, sharing between athletes, progress and muscle recovery.
Replaced the `ha-gains-integration` + `ha-gains-frontend` pair (native
integration + custom panel) the same way Cache, Garage and Stash did - read
the repo's top-level CLAUDE.md first; everything it says about Cache's shape
(ingress only, the `hass` stand-in, Store envelope, one-time import, MQTT
entities, version bumps, building on the HA box) applies here too. Start
Gains work here, not in those two repos.

## Layout

- `config.yaml` - ingress panel (`mdi:dumbbell`), `homeassistant_config:ro`
  (import), `services: mqtt:want`, options (`ai_provider`, the two API
  keys and models, `mqtt_enabled`, `log_level`). No `homeassistant_api` -
  the panel only needs the viewer's id and name, which ingress sends.
- `backend/gains_addon/` - the Python service (`python3 -m gains_addon`).
- `frontend/` - the Lit panel, built by the Dockerfile's Node stage.
- `backend/docs/`, `frontend/docs/` - design notes carried over from the
  two repos. They predate the move, so "integration"/"service" there means
  what's now the add-on backend and `api/services/<name>`.

## Identity

Unchanged in spirit from the integration: Home Assistant is the identity
provider, and the only "whose data is this" signal is the Home Assistant
user id. It used to be `call.context.user_id`; now it's the
`X-Remote-User-Id` header Supervisor's ingress proxy sets for the logged-in
session (`web.py` refuses any client but the proxy, so the header can't be
forged), passed to every handler in `services.py` as `user_id`. No handler
takes a client-supplied user/profile id to decide whose record gets written
- coach/target ids are checked against permissions in the coordinator, as
before.

## Backend

Ported as-is from the integration: every pure module (`logic.py`,
`models.py`, `training*.py`, `exercises.py`, `equipment.py`,
`load_policy.py`, `recovery.py`, `progress.py`, `joint_sessions.py`, ...),
and `coordinator.py`'s mutation methods - keep business logic in the pure
modules, not the coordinator. `services.py`'s schemas are byte-for-byte the
integration's (`validation.py` stands in for HA's `cv.string`/`cv.boolean`);
a new service field needs updating there AND in the coordinator. The
integration's `muscles.json` ships inside the package.

Changed for the add-on:
- `coordinator.py` - no `DataUpdateCoordinator`; it keeps the same
  `async_add_listener`/`async_set_updated_data` names (Stash's stand-in) and
  takes a `GainsStore`. `training_coordinator.py`'s `dt_util.now()` is the
  container's local time (Supervisor sets `TZ`).
- `ai.py` - providers take the add-on's aiohttp session instead of `hass`;
  `build_ai_provider` (was `_configure_ai_provider`) runs at startup - the
  add-on restarts when its options change.
- `storage.py` - `/data/gains.json` in HA's Store envelope.

Add-on layers around them:
- `states.py` - the panel's read model: `sensor.gains_profile_count` plus
  one sensor per athlete with exactly the integration sensor's attributes.
  Built **per viewer**: only the viewer's own athlete sensor carries data;
  everyone else's carries just the markers ha-api.ts needs to count them
  (the integration exposed every athlete's history and Ask Geoffrey chat in
  every user's `hass.states`). Keep in sync with
  `frontend/src/ha-api.ts`'s `parseGainsState`.
- `mqtt.py` - automation entities with the integration's entity ids:
  `sensor.gains_profile_count` and `sensor.gains_<display name>` per
  athlete (state = experience level), scalar attributes only plus
  completed workout/run counts. Athlete sensors are dynamic; their
  discovery topics sit under a `gains` node id so stale ones are cleared.
- `weekly.py` - the integration's Sunday 23:50 next-week generation as an
  asyncio loop.
- `web.py` - `api/states`, `api/websocket` (per-viewer pushes),
  `api/services/<name>`.
- `migrate.py` - first start only (no `/data/gains.json`):
  `.storage/gains_data` copied unchanged (ids and `ha_user_id`s survive),
  plus the config entry's AI options into `/data/imported_settings.json`,
  which `config.py` uses for any add-on option left blank. That's why
  `config.yaml` gives the provider and models no defaults.

Tests: from `gains/backend`, `python -m venv .venv && .venv/Scripts/pip
install -r requirements_test.txt`, then `.venv/Scripts/python -m pytest -q`
and `.venv/Scripts/python -m ruff check gains_addon tests`. The other
`test_*.py` files came from the integration (its HA-stubbing conftest is
gone - nothing imports Home Assistant now); `test_addon.py` covers the
add-on layers, including the integration's old real-HA service/Store
round trip.

## Frontend

Unchanged views/components from `ha-gains-frontend` (see its notes kept
here):
- `ha-api.ts` is the only file that talks to the backend - `parseGainsState`
  plus `gainsApi.*` (fire-and-forget services) and `trainingApi.*`
  (response services via `callWS({type: "call_service", return_response})`).
  `types.ts`/`training-types.ts` mirror the backend's shapes by hand.
- `addon-hass.ts` implements the `hass` the panel expects (`states`,
  `entities`, `user`, `callService`, and `callWS` for `call_service` only);
  `main.ts` mounts `<gains-panel>`; `shims/ha-elements.ts` provides
  `<ha-card>`, `<ha-icon>` (icons generated into `shims/icons.ts` by
  `scripts/gen-icons.mjs` from every `mdi:` literal - `npm run build` does
  it) and `<ha-dialog>` (a native `<dialog>` keeping mwc-dialog's
  `.open`/`@closed`/`--mdc-dialog-*` contract the views rely on).
- `theme.ts` sets the panel's own light/dark palette; only the accent
  (`--primary-color`) came from the HA theme, so `index.html` sets HA's
  default blue. Dark mode follows the device (`prefers-color-scheme`).
- `dev/` is the synthetic preview host (`npm run dev`, open `/dev/`) - no
  backend needed. `npm test` runs `tests/*.test.mjs`.

Local run (no Supervisor): build the frontend (`npm ci && npm run build`),
then from `gains/backend`: `GAINS_ALLOW_ANY_CLIENT=1 GAINS_DATA_DIR=<dir>
GAINS_HA_CONFIG_DIR=<dir> GAINS_STATIC_DIR=../frontend/dist python -m
gains_addon`, open `http://localhost:8099`. The viewer is a stand-in
"developer" user. Put a copy of a real `.storage/gains_data` under
`<GAINS_HA_CONFIG_DIR>/.storage/` to exercise the import.
