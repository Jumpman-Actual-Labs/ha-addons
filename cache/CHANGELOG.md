# Changelog

## 1.0.1

- Photos can be added without an OpenAI API key - they're saved as-is.
  With a key set, background removal works as before.

## 1.0.0

- Cache is now a Home Assistant add-on instead of a custom integration +
  custom panel. Same features, same data.
- On first start, imports everything from the old `cache` integration
  (collection data, uploaded photos/documents, OpenAI key) automatically.
- Automation entities (`binary_sensor.cache_cleaning_due`, `..._low_ammunition`,
  `..._training_due`, `..._training_ammo_alert`, and their count sensors) are
  now published over MQTT and keep their entity ids.
