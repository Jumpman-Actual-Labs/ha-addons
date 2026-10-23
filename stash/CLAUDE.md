# Stash add-on

Household finance as a Home Assistant **add-on**: members and income
sources with pay schedules, bills (fixed/variable/recurring/installment,
late fees, deferrals), payments and per-member settlements, category
budgets and expenses, savings goals/plans/deposits, and cash infusions with
repayment bills. Fully manual - never connects to a bank. Replaced the
`ha-finance-integration` + `ha-finance-frontend` pair (native integration +
custom panel) the same way Cache and Garage did - read the repo's top-level
CLAUDE.md first; everything it says about Cache's shape (ingress only, the
`hass` stand-in, Store envelope, one-time import, MQTT entities, version
bumps, building on the HA box) applies here too. Start Stash work here, not
in those two repos.

Pay periods are a money-allocation reference only (how to split a paycheck
to cover what's coming due) - monthly totals, budgets and "This Month's
Bills" stay scoped by calendar month (`bill.month`). Don't let period
boundaries redefine which month a bill belongs to.

## Layout

- `config.yaml` - ingress panel (`mdi:cash-multiple`), `homeassistant_api:
  true` (HA user list only), `homeassistant_config:ro` (import),
  `services: mqtt:want`, options (`mqtt_enabled`, `log_level`).
- `backend/stash_addon/` - the Python service (`python3 -m stash_addon`).
- `frontend/` - the Lit panel, built by the Dockerfile's Node stage.

## Backend

Ported as-is from the integration: `const.py`, `models.py`, `logic.py`
(pure functions - keep business logic here, not in the coordinator), and
`coordinator.py`'s mutation/summary methods. `services.py`'s `SCHEMAS` are
byte-for-byte the integration's (`validation.py` stands in for HA's `cv`);
a new service field needs updating there AND in the coordinator. Money is
rounded at the states/service boundary, never inside `logic.py`; payment
and income history is append-only.

Add-on layers around them:
- `states.py` - the panel's read model, the exact sensor payloads the
  integration's `sensor.py` exposed (`finance_key`/`member_id`/`bill_id`/
  `category_id` markers). Pure function of the coordinator's public data
  (which now also carries the per-bill savings plan/proposal/responsibility
  the bill sensors used to ask the coordinator for). Keep in sync with
  `frontend/src/ha-api.ts`'s `parseFinanceState`.
- `mqtt.py` - automation entities with the integration's entity ids: the
  fixed summary/count/mode/savings/infusion sensors plus one per member and
  per category. Not per bill (see its docstring).
- `rollover.py` - the integration's daily 00:05 job (recurring bills +
  monthly archive) as an asyncio loop.
- `ha_client.py` - `config/auth/list` over Core's websocket (cached 60s),
  for `api/ha_users` and `hass.user.is_admin`.
- `web.py` - `api/states` (+ the viewer as `user`), `api/websocket`,
  `api/services/<name>`, `api/ha_users`, and `internal/...` for Garage.
- `migrate.py` - first start only (no `/data/stash.json`): newest
  `.storage/finance_data_*`, copied unchanged so ids (and Garage's links to
  synced expenses) survive.

### Garage's Stash sync

Garage used to call `finance.add/edit/delete_category_expense` through HA
and find the category id from Stash's category sensors. Now it calls
`internal/categories` and `internal/services/<those three>` on this add-on
over Supervisor's add-on network (`http://<prefix>-stash:8099`). Add-ons
from one repository share the hostname prefix, so each derives the other's
hostname from its own `HOSTNAME`; `web.py` only answers `internal/` from
the address Garage's hostname resolves to, and only those three services.
Garage's side is `garage/backend/garage_addon/stash_client.py`.

Tests: from `stash/backend`, `python -m venv .venv && .venv/Scripts/pip
install -r requirements_test.txt`, then `.venv/Scripts/python -m pytest -q`
and `.venv/Scripts/python -m ruff check stash_addon tests`. The
`test_<feature>.py` files came from the integration; `test_addon.py` covers
the add-on layers.

## Frontend

Unchanged views/components from `ha-finance-frontend`:
- `ha-api.ts` is the only file that talks to the backend - `parseFinanceState`
  plus `financeApi.*` wrappers. `types.ts` mirrors the backend's shapes by
  hand.
- `addon-hass.ts` implements the `hass` the panel expects (`states`,
  `user`, `callService`, and `callWS` for `config/auth/list` only);
  `main.ts` mounts `<finance-panel>`; `shims/ha-elements.ts` provides
  `<ha-card>` and `<ha-icon>` (icons generated into `shims/icons.ts` by
  `scripts/gen-icons.mjs` from every `mdi:` literal - `npm run build` does
  it).
- `<finance-dialog>` doesn't style slotted content: each view/dialog needs
  its form styles in its own `static styles` (shadow DOM scoping).
- `npm test` runs the pure-TS regression scripts in `scripts/`.

Local run (no Supervisor): build the frontend (`npm ci && npm run build`),
then from `stash/backend`: `STASH_ALLOW_ANY_CLIENT=1 STASH_DATA_DIR=<dir>
STASH_HA_CONFIG_DIR=<dir> STASH_STATIC_DIR=../frontend/dist python -m
stash_addon`, open `http://localhost:8099`. The viewer is a stand-in admin.
