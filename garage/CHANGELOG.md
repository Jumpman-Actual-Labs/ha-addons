# Changelog

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
