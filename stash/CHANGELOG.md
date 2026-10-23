# Changelog

## 1.0.0

- Stash is now a Home Assistant add-on instead of a custom integration +
  custom panel. Same features, same data.
- On first start, imports everything from the old `finance` integration
  automatically.
- Automation entities (totals, bill counts, savings, cash infusions, and
  one sensor per member and per category) are now published over MQTT and
  keep their entity ids. Per-bill sensors are no longer created.
- Garage's Stash sync talks to the add-on directly.
- Changing the household mode in Settings works again (the integration
  failed to save it).
