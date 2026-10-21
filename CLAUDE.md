# Cache add-on

Firearm, parts, ammunition, maintenance and range tracking as a Home
Assistant **add-on** (this repo is also the add-on repository users add to
the Add-on Store). Replaced the `ha-cache-integration` +
`ha-cache-frontend` pair (a native integration + custom panel, the Stash/
Hustle pattern) - moved to an add-on for the Add-on Store's install and
versioned update flow. Those two repos are retired; start Cache work here.

## Layout

- `repository.yaml` - add-on repository manifest.
- `cache/config.yaml` - the add-on: ingress panel (`panel_icon: mdi:safe`),
  `homeassistant_config:ro` map (only for the one-time import and the
  secrets.yaml key fallback), `services: mqtt:want`, options
  (`openai_api_key`, `mqtt_enabled`, `log_level`). `image:` points at
  GHCR, so Supervisor pulls prebuilt images instead of building on the
  device.
- `cache/Dockerfile` - two stages: Node builds `cache/frontend`, then the
  HA Python base image gets the backend + the built panel in
  `/app/static`. Started by s6 (`rootfs/etc/services.d/cache/run`, which
  `exec`s `python3 -m cache_addon`; `finish` halts the container on a crash
  so Supervisor's watchdog notices).
- `cache/backend/` - the Python service. See its CLAUDE.md.
- `cache/frontend/` - the Lit panel. See its CLAUDE.md.

## How it fits together

- **Ingress only.** The backend (aiohttp, port 8099) serves the panel and
  its API. `web.py`'s middleware refuses any client but Supervisor's
  ingress proxy (172.30.32.2) - ingress is what authenticates users, and
  it passes who they are in `X-Remote-User-*` headers.
- **The panel still thinks it's talking to Home Assistant.** It was
  written against `hass.states` + `hass.callService`; the backend's
  `states.py` builds the same entity payloads the integration's sensors
  had, pushed over a websocket, and the frontend's `addon-hass.ts`
  implements the `hass` interface on top. Views didn't change.
- **Storage** is `/data/cache.json` in Home Assistant's `Store` envelope,
  uploads in `/data/uploads/`. Both are covered by add-on backups.
- **First start imports from the integration** (`migrate.py`): newest
  `.storage/cache_data_*`, `www/cache_uploads/*`, and the config entry's
  OpenAI key. Runs only while `/data/cache.json` doesn't exist; never
  writes to the HA config dir.
- **Automation entities via MQTT discovery** (`mqtt.py`) with the
  integration's entity ids. Without a broker the add-on still runs; it
  just logs that the entities are unavailable. There are no `cache.*` HA
  services any more.

## Release / deploy

Nothing here auto-deploys to the live house like the integration repos did.
On push to `main`, `.github/workflows/build.yml` builds and pushes
`ghcr.io/jumpman-actual-labs/{aarch64,amd64}-addon-cache:<version>`; Home
Assistant offers the update only when `cache/config.yaml`'s `version`
changes. So: bump `version` + `cache/CHANGELOG.md` in the same change as
anything meant to ship. The GHCR packages must be public for Supervisor to
pull them.

`validate.yml` runs backend ruff + pytest, frontend lint + build, and the
add-on linter.

## Local dev

```
cd cache/backend
python -m venv .venv && .venv/Scripts/pip install -r requirements_test.txt
.venv/Scripts/python -m pytest -q
```

Run the whole thing locally (no Supervisor needed): build the frontend
(`cd cache/frontend && npm ci && npm run build`), then start the backend
with `CACHE_ALLOW_ANY_CLIENT=1 CACHE_DATA_DIR=<dir>
CACHE_HA_CONFIG_DIR=<dir> CACHE_STATIC_DIR=../frontend/dist
python -m cache_addon` from `cache/backend` and open `http://localhost:8099`.
Put a copy of a real `.storage/cache_data_*` under
`<CACHE_HA_CONFIG_DIR>/.storage/` to exercise the import. Node isn't on PATH
on this machine - WinGet's cached Node install under
`%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_*` works.
