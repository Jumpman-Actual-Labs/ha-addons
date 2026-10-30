# Garage add-on

Vehicle management as a Home Assistant **add-on**: vehicles, drivers, fuel
logs, template-driven maintenance with mileage/time-based due tracking,
documents, a per-vehicle Health Score, Stash sync and driver reminders.
Replaced the `ha-garage-integration` + `ha-garage-frontend` pair (native
integration + custom panel) the same way Cache did - read the repo's
top-level CLAUDE.md first; everything it says about Cache's shape (ingress
only, the `hass` stand-in, Store envelope, one-time import, MQTT entities,
version bumps, building on the HA box) applies here too. Start Garage work
here, not in those two repos.

## Layout

- `config.yaml` - ingress panel (`mdi:garage`), `homeassistant_api: true`
  (Stash, notify, user list), `homeassistant_config:ro` (import +
  secrets.yaml key fallback), `services: mqtt:want`, options
  (`openai_api_key`, `mqtt_enabled`, `log_level`).
- `backend/garage_addon/` - the Python service (`python3 -m garage_addon`).
- `frontend/` - the Lit panel, built by the Dockerfile's Node stage.

## Backend

Ported as-is from the integration: `const.py`, `models.py`, `logic.py`
(pure functions - keep business logic here, not in the coordinator), and
`coordinator.py`'s mutation/summary methods. `services.py`'s `SCHEMAS` are
byte-for-byte the integration's (`validation.py` stands in for HA's `cv`);
a new service field needs updating there AND in the coordinator.

Add-on layers around them:
- `stash_client.py` - the Stash add-on's `internal/` API, called directly
  on Supervisor's add-on network (see `stash/CLAUDE.md`). Stash sync in
  `coordinator.py` tries it first and falls back to the old integration
  through `ha_client.py` only when the add-on is unreachable; still
  best-effort - never blocks a mutation.
- `ha_client.py` - Core's REST/websocket API via Supervisor
  (`SUPERVISOR_TOKEN`). Replaces every `hass` call the integration made:
  `finance.*` services + reading Stash category sensors (the old Stash
  integration fallback),
  `notify.*` (driver reminders), `config/auth/list` (driver ↔ HA user).
  `None` outside Supervisor; Finance sync and reminders are then skipped.
- `reminders.py` - the integration's daily 8am `async_track_time_change`
  job as an asyncio loop, plus a just-after-midnight
  `coordinator.async_refresh()` so due status/health/monthly spend don't
  stay stuck on yesterday (the integration only recomputed on mutation).
- `states.py` - the panel's read model, the exact sensor payloads the
  integration's `sensor.py` exposed (`garage_key`/`vehicle_id` markers).
  Keep in sync with `frontend/src/ha-api.ts`'s `parseGarageState`.
- `mqtt.py` - automation entities with the integration's entity ids: the
  two monthly spend sensors, vehicles needing attention, and one health
  sensor per vehicle (`sensor.garage_<slugified nickname>`). Vehicle
  sensors are dynamic; their discovery topics sit under a `garage` node id
  so the publisher reads back what's retained on connect and clears
  vehicles that no longer exist.
- `obd.py` - live odometer / fuel level: polls each vehicle's linked
  `odometer_entity_id` / `fuel_level_entity_id` (HA sensors, e.g. a WiCAN
  OBD dongle's) every minute via `ha_client.get_state` and feeds
  `coordinator.async_apply_live_readings` (mileage only moves forward,
  `%` becomes a 0-1 fraction, km becomes miles, unavailable is skipped).
  `web.py`'s `api/ha_sensors` lists numeric sensors for the dialog's pickers.
- `lookups.py` - fuel pump photo scan (OpenAI vision) and VIN decode
  (NHTSA vPIC + optional OpenAI tank/oil capacity guess). Key: add-on
  option, then secrets.yaml (where the integration read it).
- `web.py` - `api/states`, `api/websocket`, `api/services/<name>`,
  `api/upload` (document), `api/vehicle_photo`, `api/analyze_fuel_photo`,
  `api/decode_vin`, `api/ha_users`, and `uploads/...`. Uploads land in
  `/data/uploads/documents/<vehicle_id>/` and
  `/data/uploads/vehicles/<vehicle_id>/photo.<ext>`; stored paths are the
  relative URLs (`uploads/...`). Unlike the integration, deleting a
  document or vehicle deletes its files (they'd otherwise bloat backups).
- `migrate.py` - first start only (no `/data/garage.json`): newest
  `.storage/garage_data_*`, `www/garage_documents/` and
  `www/garage_vehicles/`, rewriting `/local/garage_*` paths to `uploads/...`.

Tests: `cd garage/backend && python -m venv .venv && .venv/Scripts/pip
install -r requirements_test.txt`, then `.venv/Scripts/python -m pytest -q`
and `.venv/Scripts/python -m ruff check garage_addon tests`.
`test_logic.py`/`test_models.py`/`test_coordinator.py` came from the
integration; `test_addon.py` covers the add-on layers.

## Frontend

Unchanged views/components from `ha-garage-frontend`; see its old CLAUDE.md
notes kept here:
- `ha-api.ts` is the only file that talks to the backend - `parseGarageState`
  plus `garageApi.*` wrappers. Uploads/lookups are relative `fetch`es (no
  auth header - ingress authenticates).
- `addon-hass.ts` implements the `hass` the panel expects; `main.ts`
  mounts `<garage-panel>`; `shims/ha-elements.ts` provides `<ha-card>` and
  `<ha-icon>` (icons generated into `shims/icons.ts` by
  `scripts/gen-icons.mjs` from every `mdi:` literal - `npm run build` does
  it).
- `types.ts` mirrors the backend's shapes by hand.
- `<garage-dialog>` doesn't style slotted content: each dialog needs
  `formStyles` in its own `static styles` (shadow DOM scoping).
- `styles.ts` holds Garage's graphite/steel/workshop-orange palette,
  applied at the panel root.

Local run (no Supervisor): build the frontend (`npm ci && npm run build`),
then from `garage/backend`: `GARAGE_ALLOW_ANY_CLIENT=1
GARAGE_DATA_DIR=<dir> GARAGE_HA_CONFIG_DIR=<dir>
GARAGE_STATIC_DIR=../frontend/dist python -m garage_addon`, open
`http://localhost:8099`.
