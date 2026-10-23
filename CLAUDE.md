# Jumpman Actual Labs add-ons

The single Home Assistant add-on repository for all Jumpman Actual Labs
add-ons. Users add `https://github.com/Jumpman-Actual-Labs/ha-addons` to the
Add-on Store once; every top-level folder with a `config.yaml` shows up as
its own installable add-on. (Renamed from `ha-cache-addon` so new add-ons
don't each need their own repository.)

## Commit identity (check before every commit)

Every commit here must be authored and committed as:

```
jumpmanactual <75352153+jumpmanactual@users.noreply.github.com>
```

Run `git config user.name` / `git config user.email` first; if they're
unset or anything else, set them for this repo with `git config user.name
jumpmanactual` and `git config user.email
75352153+jumpmanactual@users.noreply.github.com`. Never invent an identity:
GitHub credits a commit to whichever account owns its email, and a guessed
`<name>@users.noreply.github.com` belongs to a real stranger (this happened
once - three commits were credited to an unrelated user "jordan" and had to
be rewritten). `commit-identity.yml` fails CI on any push or PR whose
commits use a different author or committer email.

## Adding a new add-on

1. Create a top-level folder named after the add-on's `slug`
   (e.g. `relay/`) with `config.yaml`, `Dockerfile`, `build.yaml`,
   `DOCS.md`, `CHANGELOG.md`, `icon.png`, `logo.png`. Use `cache/` as the
   reference. Set `url:` in `config.yaml` and the
   `org.opencontainers.image.source` label in `build.yaml` to this repo's
   URL.
2. Keep the slug unique in this repo - it's part of the add-on's ID.
3. Add a row to the table in `README.md`.
4. If it has tests/builds, add `.github/workflows/<slug>.yml` with
   `paths: ["<slug>/**", ...]` filters like `cache.yml`. `addon-lint.yml`
   finds and lints every add-on folder automatically.
5. Push, then in HA: Add-on Store > ⋮ > Check for updates.

Don't leave scratch/template folders containing a `config.yaml` at the
top level - Supervisor would list them as add-ons.

Each add-on keeps its own CLAUDE.md for its internals (Garage and Stash,
ported from integrations the same way as Cache: `garage/CLAUDE.md`,
`stash/CLAUDE.md`). Garage's Stash sync calls the Stash add-on directly
over Supervisor's add-on network - see `stash/CLAUDE.md`. The rest
of this file is about Cache.

# Cache add-on

Firearm, parts, ammunition, maintenance and range tracking as a Home
Assistant **add-on**. Replaced the `ha-cache-integration` +
`ha-cache-frontend` pair (a native integration + custom panel, the Stash/
Hustle pattern) - moved to an add-on for the Add-on Store's install and
versioned update flow. Those two repos are retired; start Cache work here.

## Layout

- `repository.yaml` - add-on repository manifest (shared by all add-ons).
- `cache/config.yaml` - the add-on: ingress panel (`panel_icon: mdi:ammunition`),
  `homeassistant_config:ro` map (only for the one-time import and the
  secrets.yaml key fallback), `services: mqtt:want`, options
  (`openai_api_key`, `mqtt_enabled`, `log_level`). No `image:` key, so
  Supervisor builds the Dockerfile on the HA box itself at install/update
  (a few minutes). Prebuilt GHCR images were tried first and dropped: the
  Jumpman-Actual-Labs org blocks public packages, and Supervisor can't pull
  private ones.
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
Home Assistant offers an update only when `cache/config.yaml`'s `version`
changes, then rebuilds the image on the HA box. So: bump `version` +
`cache/CHANGELOG.md` in the same change as anything meant to ship. The
repo must stay public - the Add-on Store can't add a private repository.

`cache.yml` runs backend ruff + pytest and frontend lint + build when
`cache/` changes; `addon-lint.yml` runs the add-on linter on every add-on.

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
