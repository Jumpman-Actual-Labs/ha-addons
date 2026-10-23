# Stash

Household bills, income, budgets, savings, cash infusions and who-owes-whom
settlements, in its own sidebar panel. Fully manual - Stash never connects
to a bank.

## Requirements

- **MQTT broker** (the Mosquitto broker add-on) for Stash's Home Assistant
  entities. Stash finds it automatically. Without one, the panel works fine
  but the entities below won't exist.

## Options

| Option | Description |
| --- | --- |
| `mqtt_enabled` | Publish the automation entities over MQTT. |
| `log_level` | `debug`, `info`, `warning` or `error`. |

## Entities

Published via MQTT discovery under a **Stash** device:

- `sensor.stash_total_income`, `sensor.stash_total_bills`,
  `sensor.stash_paid`, `sensor.stash_remaining`,
  `sensor.stash_cash_remaining`
- `sensor.stash_bills_due_this_pay_period`, `sensor.stash_overdue_bills`,
  `sensor.stash_deferred_bills` (counts)
- `sensor.stash_finance_mode`, `sensor.stash_savings`,
  `sensor.stash_cash_infusions`
- one `sensor.stash_<name>_finance_summary` per household member and one
  `sensor.stash_<name>_spending` per category.

The integration's per-bill sensors (`sensor.stash_bill_<name>`) are gone -
bill details live in the panel.

## Garage

Garage's Stash sync (Garage > Settings) talks to this add-on directly - no
setup needed beyond installing both from this repository.

## Moving from the Stash integration

1. Install and start this add-on. On its first start it copies the
   integration's data out of your config directory (read-only - nothing
   there is changed). The log says what it imported.
2. Open the Stash panel from the sidebar and check everything is there.
3. Remove the Stash integration (Settings > Devices & Services), delete the
   `panel_custom` entry for `finance-panel` from `configuration.yaml`, and
   restart Home Assistant. Once the integration's entities are gone, the
   MQTT ones take over the same entity ids, so automations keep working.

The `finance.*` services are gone - Stash is managed from its panel. Data
lives in the add-on and is included in add-on backups.
