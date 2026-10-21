# Cache

Firearm, parts, ammunition, maintenance and range tracking, in its own
sidebar panel.

## Requirements

- **MQTT broker** (the Mosquitto broker add-on) for Cache's Home Assistant
  entities. Cache finds it automatically. Without one, the panel works fine
  but the automation entities below won't exist.

## Options

| Option | Description |
| --- | --- |
| `openai_api_key` | Used for photo background removal and ammo box scanning. If blank, Cache falls back to an `openai_api_key` entry in `secrets.yaml`, then to the key the old integration had. |
| `mqtt_enabled` | Publish the automation entities over MQTT. |
| `log_level` | `debug`, `info`, `warning` or `error`. |

## Entities

Published via MQTT discovery under a **Cache** device:

- `binary_sensor.cache_cleaning_due`, `binary_sensor.cache_low_ammunition`,
  `binary_sensor.cache_training_due`, `binary_sensor.cache_training_ammo_alert`
- `sensor.cache_cleaning_due`, `sensor.cache_low_ammunition`,
  `sensor.cache_training_due`, `sensor.cache_training_ammo_alert` (counts, with
  an `items` attribute listing what's due/low)
- `sensor.cache_dashboard_stats` (total firearms, plus all dashboard stats as
  attributes) and `sensor.cache_range_sessions`

## Moving from the Cache integration

1. Install and start this add-on. On its first start it copies the
   integration's data, uploads and OpenAI key out of your config directory
   (read-only - nothing there is changed). The log says what it imported.
2. Open the Cache panel from the sidebar and check everything is there.
3. Remove the Cache integration (Settings > Devices & Services), delete the
   `panel_custom` entry for it from `configuration.yaml`, and restart Home
   Assistant. Once the integration's entities are gone, the MQTT ones take
   over the same entity ids, so automations keep working.

The `cache.*` services are gone - Cache is managed from its panel. Data lives
in the add-on and is included in add-on backups.
