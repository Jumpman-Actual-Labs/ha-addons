# Family Hustle

Your family's calendar, chores, meals and shopping list in one sidebar
panel, laid out like a Skylight Calendar.

- **Calendar**: your Google Calendar as a day, week or month view, with
  the Meals tab's dinners on the all-day row. Tag each event with who it's
  for (that sets its color) and who's attending (their initials show on
  it). The strip across the top shows each person's chores done today. Tap
  someone to see only their events. Parents add events with the **+**
  button, including multi-day and repeating ones, and tap one to tag, edit
  or delete it. Workouts from Gains programs show too: tap one to set when
  it starts (just that day, or every week), and it ends when Gains expects
  the workout to be done.
  On a phone it looks like the iPhone Calendar app: each date has a colored
  bar showing who has events that day, and tapping a date lists its events.
- **Chores**: everything Hustle did: chores and recurring chores, extra jobs
  (bounties), grades, behavior, paychecks and payroll, and reports.
- **Meals**, in two sections:
  - **This week**: the next seven dinners. Add one from a recipe or just
    type it, move or remove it, open its recipe, or have the AI plan the
    week (**Plan with AI**) or a batch dish (**Meal prep**). A meal-prep
    batch gets its own card at the top, with its nights and recipe. The grocery list from a plan sits
    underneath. Check off what you already have and **Add to shopping
    list** sends the rest to the Shopping tab.
  - **Recipes**: the family recipe box. Search it, add and edit recipes
    (**Fill with AI** completes whatever you leave blank without touching
    what you wrote), **Cook** a recipe step by step with an ingredient
    checklist (the screen stays on, and tapping an amount rescales every
    ingredient), send its ingredients to the shopping list, or plan it for
    a night. A dinner with
    the same name as a recipe links to it.
- **Shopping**: Home Assistant's own shopping list, so it's the same list
  as in the Home Assistant app and Assist ("add milk to the shopping
  list"). Everyone in the family can add items, check them off, rename
  them or remove them.

Family Hustle has light and dark themes. **Auto** follows Home Assistant's
dark mode; the button at the bottom of the menu switches between Auto,
Light and Dark on each device.

## Requirements

- **Google Calendar integration** in Home Assistant (Settings > Devices &
  Services > Add Integration > Google Calendar). Family Hustle reads and
  writes your calendars through it, so anything it can see shows up here.
  A separate "Dinners" Google Calendar for meal plans keeps them off the
  family calendar.
- **MQTT broker** (the Mosquitto broker add-on) for Family Hustle's Home
  Assistant entities. Without one, the panel works fine but the entities
  below won't exist.
- The **Shopping List** integration (or any Home Assistant to-do list) for
  the Shopping tab. It uses `todo.shopping_list` unless a parent picks
  another list under Shopping › ⚙.
- The **Gains** add-on (1.0.3 or newer), for program workouts on the
  calendar. Optional.
- An **OpenAI or Anthropic API key** for meal planning, and OpenAI for chore
  pictures. Optional: everything else works without one.

## Options

| Option | Description |
| --- | --- |
| `openai_api_key` | Meal planning and chore pictures. If blank, falls back to `openai_api_key` in `secrets.yaml`. |
| `anthropic_api_key` | Meal planning. If blank, falls back to `anthropic_api_key` in `secrets.yaml`. |
| `ai_provider` | Which one plans meals when both keys are set. |
| `mqtt_enabled` | Publish the automation entities over MQTT. |
| `log_level` | `debug`, `info`, `warning` or `error`. |

## Getting started

1. Install and start the add-on, then open **Family Hustle** from the
   sidebar.
2. As a Home Assistant administrator, fill in the welcome screen. You
   become the first parent. (If you're moving from the Hustle integration,
   your family is already there; see below.)
3. **Chores › Settings**: add the rest of the family and link each person
   to their own Home Assistant account. Kids should have their own
   non-admin accounts. Family Hustle knows who's looking from the account
   they're signed in with, and kids only get the kid views.
4. **Calendar › ⚙**: pick your Google Calendar(s) and each person's color.
   The ⚙ settings on every tab are for parents with admin permission.
5. **Meals › ⚙**: pick the Dinners calendar.
6. **Shopping › ⚙**: change the to-do list, if you don't want Home
   Assistant's Shopping List.

## Entities

Published via MQTT discovery under a **Family Hustle** device, with the
same entity ids the Hustle integration used:

- `sensor.hustle_pending_payroll_count`, `sensor.hustle_days_until_payday`,
  `sensor.hustle_active_chores_count`, `sensor.hustle_active_bounties_count`,
  `sensor.hustle_pending_approvals_count`
- per person: `sensor.hustle_<name>_pending_earnings`,
  `sensor.hustle_<name>_lifetime_earnings`,
  `sensor.hustle_<name>_current_paycheck` (in cents)

The `hustle_*` events (chore submitted, bounty completed, and so on) still
fire on Home Assistant's event bus, and each person's notify target still
gets their alerts.

## Moving from the Hustle and Household integrations

1. Install and start this add-on. On its first start it copies the Hustle
   integration's data and chore pictures, and Household's grocery list and
   Dinners calendar choice, out of your config directory. It only reads
   them; nothing there is changed. The log says what it imported.
2. Open Family Hustle and check everything is there. Then pick your family
   calendar under Calendar › ⚙.
3. Remove the Hustle and Household integrations (Settings > Devices &
   Services), delete their `panel_custom` entries from
   `configuration.yaml`, and restart Home Assistant. Once the integration's
   entities are gone, the MQTT ones take over the same entity ids, so
   automations keep working.

The `hustle.*` and `household.*` services are gone; everything is managed
from the panel. Data lives in the add-on and is included in add-on
backups. Calendar events stay in Google Calendar. Family Hustle keeps only
who each event is for and who's attending.
