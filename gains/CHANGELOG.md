# Changelog

## 1.0.1

- The panel uses your own Home Assistant theme again - its accent colors
  and your light/dark setting - and follows along when you change them,
  as it did when Gains was an integration.

## 1.0.0

- Gains is now a Home Assistant add-on instead of a custom integration +
  custom panel. Same features, same data.
- On first start, imports everything from the old `gains` integration
  automatically, including its AI provider and API key settings.
- AI provider, API keys and models are add-on options.
- Automation entities (profile count and one sensor per athlete) are now
  published over MQTT and keep their entity ids. Athlete sensors no longer
  carry workout/run history, gyms or the Ask Geoffrey conversation.
- Each person's panel only receives their own athlete data; other
  athletes' workouts and conversations are no longer sent to every
  logged-in user.
