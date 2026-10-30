# Changelog

## 1.2.0

- Live sensors: link a vehicle to Home Assistant sensors (for example a
  WiCAN OBD-II dongle's odometer and fuel tank level) under Edit Vehicle →
  Live sensors. Garage reads them about once a minute and keeps Current
  Mileage and Fuel % up to date, so mileage-based maintenance, the health
  score, estimated range and low-fuel reminders follow the car. Mileage only
  ever goes up; readings while the dongle is asleep are ignored. Kilometre
  odometers are converted to miles.

## 1.1.1

- Panel now visible to non-admin users. Added Allowed users option to restrict access to specific accounts.

## 1.1.0

- Stash sync works with the new Stash add-on (talking to it directly), and
  still with the old Stash integration if that's what's installed.

## 1.0.0

- Garage is now a Home Assistant add-on instead of a custom integration +
  custom panel. Same features, same data.
- On first start, imports everything from the old `garage` integration
  (vehicles, drivers, fuel, maintenance, documents, vehicle photos)
  automatically.
- Automation entities (`sensor.garage_monthly_fuel_spending`,
  `sensor.garage_monthly_maintenance_spending`,
  `sensor.garage_vehicles_needing_attention` and one health-score sensor per
  vehicle) are now published over MQTT and keep their entity ids.
- Stash sync and the daily 8am driver reminders work as before, through
  Home Assistant's API.
- The OpenAI key can now be set in the add-on's options (secrets.yaml's
  `openai_api_key` still works as a fallback).
