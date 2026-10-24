# Family Hustle add-on

The family's calendar, chores and meals as one Home Assistant **add-on**
(slug `family_hustle`). It merges two retired integrations:
- **Hustle** (`ha-hustle-integration` + `ha-hustle-frontend`): chores,
  bounties, grades, behavior, payroll. This is now the Chores tab.
- **Household** (`ha-household`): dinner board, AI meal plans, grocery list.
  This is now the Meals tab.

It also adds a Calendar tab modeled on a Skylight Calendar and a Shopping
tab backed by a Home Assistant to-do list. It is ported the
same way as Cache, Garage and Stash, so read the repo's top-level CLAUDE.md
first: everything it says about Cache's shape (ingress only, the `hass`
stand-in, Store envelope, one-time import, MQTT entities, version bumps,
building on the HA box) applies here too. Start Hustle or Household work
here, not in those repos.

## Layout

- `config.yaml`: ingress panel (`mdi:calendar-heart`), `homeassistant_api:
  true` (calendars, notify, events, user list), `homeassistant_config:ro`
  (import + secrets.yaml key fallback), `services: mqtt:want`, options
  (`openai_api_key`, `anthropic_api_key`, `ai_provider`, `mqtt_enabled`,
  `log_level`).
- `backend/hustle_addon/`: the Python service (`python3 -m hustle_addon`).
- `frontend/`: the Lit app, built by the Dockerfile's Node stage.

## Backend

Ported from the Hustle integration with as little change as possible:
`const.py`, `models.py`, `logic.py` (pure functions; keep business logic
here) and `coordinator.py`. The coordinator still talks to a `hass`, which
is now `bridge.py`'s `HassBridge`. It turns `hass.bus.async_fire` into
Core's `POST api/events`, `hass.services.async_call` into
`POST api/services` (member `notify.*` alerts, which the integration
actually never awaited), and `hass.async_create_task` into a held loop
task. That's why the integration's coordinator tests run with their
FakeHass unchanged. `services.py`'s `SCHEMAS` and handlers are the
integration's. `ServiceCall`/`Context` are small stand-ins, and
`call.context.user_id` comes from ingress's `X-Remote-User-Id`, so the
parent/admin guards work as before. A new service field needs updating in
`SCHEMAS` AND the coordinator.

Add-on layers:
- `services.py` `setup_family`: first-run setup in place of the config
  flow. HA admin only, and only while no active parent admin exists.
- `family_calendar.py`: the Calendar tab. Events stay in HA calendars
  (Google). It reads them via `GET api/calendars/<id>` and adds/deletes
  them via the `calendar/event/create|delete` websocket commands.
  `calendar/event/create` returns no uid, so `create_event` finds it again
  by summary + start. Tags (`for_member_id`, `attendee_ids`) live in
  `coordinator.event_tags`, keyed `<entity_id>|<uid>`, so every instance of
  a recurring event shares them. Which calendars to show, where new events
  go and the dinners calendar are in `coordinator.calendar_settings`.
  Parents add, tag and delete; settings (`update_calendar_settings`) are
  admin parents only; any linked member reads. `create_event` takes an
  optional `rrule` (validated, passed through as the event's RRULE).
- `meals.py`: Household's `ai_client.py` (prompts and schemas unchanged;
  OpenAI Structured Outputs, or Anthropic forced tool use) plus its
  services. The board is read on demand (`api/meals/week`) instead of a
  30-minute polling sensor. `move_meal` is delete + create through
  `FamilyCalendar`, because Household's `calendar.delete_event` service
  doesn't exist in HA. The grocery list is `coordinator.grocery_list`.
  Parents only.
- `shopping.py`: the Shopping tab. The list is an HA to-do entity
  (`calendar_settings["shopping_list"]`, default `todo.shopping_list`), so
  it's shared with the HA app and Assist. It reads through `todo.get_items`
  (`?return_response`) and writes through `todo.add_item/update_item/
  remove_item/remove_completed_items`, keeping no copy. `add_items` skips
  anything already on the list unchecked. Any linked member may edit;
  choosing the list goes through `update_calendar_settings` (parents).
- `states.py`: the panel's read model. These are the exact payloads of the
  integration's `sensor.py` (`hustle_key`/`member_id`/`chore_definition_id`/
  `chore_assignment_id`/`bounty_id` markers), plus `calendar_settings`,
  `grocery_list` and `today_chore_progress`. Keep it in sync with
  `frontend/src/ha-api.ts` and `family-api.ts`.
- `mqtt.py`: the integration's automation entity ids (counts, days until
  payday, per-member pending/lifetime earnings and current paycheck,
  `sensor.hustle_<slug name>_...`). Member sensors are dynamic and get
  cleared like Garage's vehicles.
- `scheduler.py`: the integration's 5-minute tick (due chore occurrences,
  stale bounties, overdue chores, auto payroll), which also refreshes
  date-driven public data.
- `web.py`: `api/states` (+ viewer), `api/websocket`,
  `api/services/<name>` (answers `{"response": ...}`), `api/ha_users`,
  `api/calendar/calendars`, `api/calendar/events`, `api/meals/week`,
  `api/shopping/lists`, `api/shopping/items`, and
  `images/...` (AI chore pictures in `/data/images/`).
- `migrate.py`: first start only (no `/data/hustle.json`). It imports the
  newest `.storage/hustle_data_*` (rewriting `/local/hustle_images/` to
  `images/`), `www/hustle_images/`, Household's
  `.storage/household_grocery_list`, and the Household config entry's
  `calendar_entity` as `dinners_calendar`.

Tests: from `family_hustle/backend`, run `python -m venv .venv &&
.venv/Scripts/pip install -r requirements_test.txt`, then
`.venv/Scripts/python -m pytest -q` and `.venv/Scripts/python -m ruff check
hustle_addon tests`. `test_logic.py`/`test_coordinator.py` came from the
integration. `test_addon.py` covers the add-on layers against a fake HA.

## Frontend

- `family-app.ts`: the root, a Skylight-style rail (bottom bar on phones)
  with Calendar / Chores / Meals / Shopping, plus the theme button. It also
  owns the theme. Every color is a token on its `:host` (light) and
  `:host([dark])`. Those include the HA variables the Hustle views use, so
  they theme the Chores tab through shadow DOM too, plus `--fh-*` tokens for
  the new views. Add a color as a token in both blocks, never hard-coded.
  The theme is Auto (HA's `themes.darkMode` from the parent page, then
  `prefers-color-scheme`, re-checked every 2s), Light or Dark, kept per
  device in localStorage. It also decides who's looking: a linked
  member gets the app, an HA admin on an unmanaged household gets
  `views/setup-view.ts`, and anyone else gets "link your account".
- `views/calendar-view.ts`: the Skylight calendar. It has a member strip
  (today's chore progress; tap to filter), a day/week time-grid
  (`_gridView`, one or seven columns) with lanes for overlapping events and
  a now line, and a month grid. The dinners calendar is read alongside the
  family calendars and drawn as chalkboard chips on the all-day row
  (`show_dinners`). The + dialog builds an RRULE for repeats; weekly
  repeats move the start to the first chosen weekday, because Google
  otherwise counts DTSTART as an extra occurrence. Timed UNTIL is UTC. A
  tap tags or deletes (one occurrence, or the series without
  `recurrence_id`). The ⚙ (calendars, show dinners, family colors via
  `update_member` `avatar_color`) only shows to admin parents.
  At phone width (`_mobile`, max-width 760px) it renders `_phoneView`
  instead: iOS-Calendar-style month-only dates (`_range` returns just the
  month), a bar under each date in the colors of whoever has events that
  day (`_dayColors`; untagged = grey, dinners skipped), the picked day's
  agenda below, and a sideways swipe to change month. Event color = the "for" member
  (`utils/member-colors.ts`: avatar color or a pastel by roster order).
- `views/meals-view.ts`: Household's `household-panel.js`, rewritten in Lit
  with the same chalkboard styles and wizard steps. Its grocery checklists
  add their unchecked items to the shopping list.
- `views/shopping-view.ts`: the shopping list. It re-reads every 30s while
  open, because items also change from the HA app and voice.
- `hustle-panel.ts` and `views/*` (the rest): the Hustle frontend,
  unchanged apart from the panel header ("Chores") and losing its own
  link-your-account screen. `ha-api.ts` is still the only chores API
  layer, and `family-api.ts` is the calendar/meals one.
- `addon-hass.ts`, `shims/`, `scripts/gen-icons.mjs`: as in Stash. Run
  `npm run build` to regenerate icons from every `mdi:` literal.
- Always light (Skylight look). The Hustle views' HA-variable fallbacks are
  light colors, and there are no HA theme variables inside the iframe.
- `<hustle-dialog>` doesn't style slotted content. Each view needs its form
  styles in its own `static styles`.

Local run (no Supervisor): build the frontend (`npm ci && npm run build`),
then from `family_hustle/backend` run `HUSTLE_ALLOW_ANY_CLIENT=1
HUSTLE_DEV_USER_ID=<id> HUSTLE_DATA_DIR=<dir> HUSTLE_HA_CONFIG_DIR=<dir>
HUSTLE_STATIC_DIR=../frontend/dist python -m hustle_addon` and open
`http://localhost:8099`. The viewer is `HUSTLE_DEV_USER_ID`, as an HA admin.
Calendars need an HA API: point `HUSTLE_CORE_API_URL` at one and set any
`SUPERVISOR_TOKEN`. A small fake that serves `api/calendars`,
`api/calendars/<id>`, `websocket` (auth + `config/auth/list` +
`calendar/event/*`), `api/states` (for `todo.*` names), `api/events` and
`api/services` (with `todo.*` behind `?return_response`) is enough.
