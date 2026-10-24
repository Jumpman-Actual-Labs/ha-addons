# Gains

AI-assisted workout planning and tracking for everyone in your household, in
its own sidebar panel: strength workouts logged set by set, runs, gym
equipment, programs from Ask Geoffrey, coach mode, Workout Together and
progress. Every Home Assistant user who opens Gains gets their own athlete
profile; nobody can see or change anyone else's unless they share it or
grant coach access.

## Requirements

- **An Anthropic or OpenAI API key** for Ask Geoffrey and program building.
  Everything else works without one.
- **MQTT broker** (the Mosquitto broker add-on) for Gains' Home Assistant
  entities. Gains finds it automatically. Without one, the panel works fine
  but the entities below won't exist.

## Options

| Option | Description |
| --- | --- |
| `ai_provider` | `anthropic` or `openai`. Empty means Anthropic (or whatever the Gains integration used). |
| `anthropic_api_key` | Needed when the provider is Anthropic. |
| `anthropic_model` | Empty means `claude-sonnet-4-5`. |
| `openai_api_key` | Needed when the provider is OpenAI. |
| `openai_model` | Empty means `gpt-4o`. |
| `mqtt_enabled` | Publish the automation entities over MQTT. |
| `log_level` | `debug`, `info`, `warning` or `error`. |

## Entities

Published via MQTT discovery under a **Gains** device:

- `sensor.gains_profile_count` - how many athletes have a profile.
- one `sensor.gains_<name>` per athlete - their experience level, with
  their profile settings and completed workout/run counts as attributes.

Workout and run history, gyms and the Ask Geoffrey conversation live in
the panel only - the integration's sensors carried them as attributes.

## Moving from the Gains integration

1. Install and start this add-on. On its first start it copies the
   integration's data, and its AI provider settings, out of your config
   directory (read-only - nothing there is changed). The log says what it
   imported.
2. Open the Gains panel from the sidebar and check everything is there.
   Each person keeps their own profile - it's tied to their Home Assistant
   account, as before.
3. Remove the Gains integration (Settings > Devices & Services), delete the
   `panel_custom` entry for `gains-panel` from `configuration.yaml`, and
   restart Home Assistant. Once the integration's entities are gone, the
   MQTT ones take over the same entity ids, so automations keep working.

The `gains.*` services are gone - Gains is managed from its panel. Data
lives in the add-on and is included in add-on backups. The panel uses Home
Assistant's default blue accent rather than your theme's, and follows your
device's light/dark setting.
