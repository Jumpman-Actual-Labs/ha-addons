# Garage

Vehicles, drivers, fuel, maintenance (with mileage/time-based due
tracking), documents and a per-vehicle Health Score, in its own sidebar
panel.

## Requirements

- **MQTT broker** (the Mosquitto broker add-on) for Garage's Home Assistant
  entities. Garage finds it automatically. Without one, the panel works fine
  but the entities below won't exist.

## Options

| Option | Description |
| --- | --- |
| `openai_api_key` | Optional. Used for Scan Pump Photo and for guessing tank/oil capacity when decoding a VIN. If blank, Garage falls back to an `openai_api_key` entry in `secrets.yaml`. |
| `mqtt_enabled` | Publish the automation entities over MQTT. |
| `log_level` | `debug`, `info`, `warning` or `error`. |

## Entities

Published via MQTT discovery under a **Garage** device:

- `sensor.garage_monthly_fuel_spending`, `sensor.garage_monthly_maintenance_spending`
- `sensor.garage_vehicles_needing_attention` (count, with the vehicles as
  attributes)
- one `sensor.garage_<nickname>` per vehicle - its Health Score, with
  mileage, fuel level, MPG, costs and next maintenance due as attributes.

## Live odometer and fuel level (OBD)

If your car has an OBD-II dongle in Home Assistant (a WiCAN, for example),
edit the vehicle and pick its sensors under **Live sensors** - the odometer
(e.g. `sensor.wican_<id>_local_a6_odometer`) and the fuel tank level (e.g.
`sensor.wican_<id>_local_2f_fueltanklevel`). Garage reads them about once a
minute and keeps Current Mileage and Fuel % current. Mileage never goes
backwards, and readings while the car is off (unavailable) are ignored.

A tank's fuel gauge reads the slope the car is parked on, so with an
odometer linked, fuel level only updates while you're driving (smoothed over
the last few minutes). Under each reading Garage shows what the sensor is
doing: live, parked, asleep, not found in Home Assistant, or failing (see
the add-on log for why).

With both sensors linked, Garage also spots fill-ups on the fuel sensor (a
jump of 15% or more) and measures each tank's MPG from the miles driven and
the fuel actually burned. Average MPG and estimated range use the last 5 of
those tanks, so a fill-up you forgot to log doesn't throw them off. Set the
vehicle's tank capacity for this to work. Until a tank has been measured,
the average comes from logged fill-ups, leaving out any over 80 MPG.

When the sensor sees a fill-up nobody logged, the vehicle's primary driver
gets a notification (set their notify target under Drivers) and the vehicle
shows **Fill-up detected**: **Log it** opens Add Fuel with the date,
odometer and estimated gallons filled in, **Dismiss** clears it. If you
forgot to log a fill-up, tick **I missed logging the fill-up before this
one** on the next one so its MPG is skipped.

### Gear, tires and trouble codes

- **Gear sensor**: a numeric gear code (the Ram's 13 = Park, 11 = Reverse,
  0 = Neutral, 1-10 = the gear) or a letter (P/R/N/D). Fuel only counts in a
  drive gear, and Park ends a trip, so even a quick fill-up is caught and
  fuel sloshing mid-trip never looks like one.
- **Tire sensors**: one per tire (psi, kPa or bar), plus the target
  pressure from the door jamb sticker. Garage alerts when a tire is 4 psi
  under the target (under 30 psi without one), when the four are 4+ psi
  apart, and when one tire has lost 2+ psi more than the others over a
  week - a slow leak. It keeps one reading a day for that.
- **Trouble codes sensor**: any sensor whose state lists the active codes
  (e.g. `P0420 P0171`, or `All clear`), with an optional
  `check_engine_light` attribute.

Tire and trouble-code problems show on the vehicle, are part of the 8am
reminders, and lower the health score. A new tire alert also notifies the
primary driver straight away.

## Stash and reminders

- **Stash sync** (Settings tab): when on and Stash is installed (the Stash
  add-on from this repository, or the old Stash integration), logging fuel
  or paid maintenance adds an expense to the Stash category you name, and
  edits/deletes follow it.
- **Driver reminders**: every day at 8am, each vehicle's primary driver gets
  overdue-maintenance and low-fuel reminders on their notify target (e.g.
  `notify.mobile_app_phone`).

## Moving from the Garage integration

1. Install and start this add-on. On its first start it copies the
   integration's data, vehicle photos and documents out of your config
   directory (read-only - nothing there is changed). The log says what it
   imported.
2. Open the Garage panel from the sidebar and check everything is there.
3. Remove the Garage integration (Settings > Devices & Services), delete the
   `panel_custom` entry for it from `configuration.yaml`, and restart Home
   Assistant. Once the integration's entities are gone, the MQTT ones take
   over the same entity ids, so automations keep working.

The `garage.*` services are gone - Garage is managed from its panel. Data
lives in the add-on and is included in add-on backups.
