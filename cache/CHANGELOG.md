# Changelog

## 1.0.0

- Cache is now a Home Assistant add-on instead of a custom integration +
  custom panel. Same features, same data.
- On first start, imports everything from the old `cache` integration
  (collection data, uploaded photos/documents, OpenAI key) automatically.
- Automation entities (`binary_sensor.cache_cleaning_due`, `..._low_ammunition`,
  `..._training_due`, `..._training_ammo_alert`, and their count sensors) are
  now published over MQTT and keep their entity ids.
