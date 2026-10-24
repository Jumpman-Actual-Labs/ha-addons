# Family Hustle

Your family's calendar, chores and meals in one sidebar panel, laid out like
a Skylight Calendar.

- **Calendar**: your Google Calendar as a week or month grid. Tag each event
  with who it's for (that sets its color) and who's attending (their
  initials show on it). The strip across the top shows each person's chores
  done today. Tap someone to see only their events. Parents add events with
  the **+** button and tag one by tapping it.
- **Chores**: everything Hustle did: chores and recurring chores, extra jobs
  (bounties), grades, behavior, paychecks and payroll, and reports.
- **Meals**: this week's dinners board, the AI meal-plan wizard (Dinner
  Planning or Meal Prep), a grocery list built from the plan, and moving a
  dinner to another day.

## Requirements

- **Google Calendar integration** in Home Assistant (Settings > Devices &
  Services > Add Integration > Google Calendar). Family Hustle reads and
  writes your calendars through it, so anything it can see shows up here.
  A separate "Dinners" Google Calendar for meal plans keeps them off the
  family calendar.
- **MQTT broker** (the Mosquitto broker add-on) for Family Hustle's Home
  Assistant entities. Without one, the panel works fine but the entities
  below won't exist.
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
4. **Calendar › ⚙**: pick your Google Calendar(s).
5. **Meals › ⚙**: pick the Dinners calendar.

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
