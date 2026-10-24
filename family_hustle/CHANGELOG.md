# Changelog

## 1.0.0

- Family Hustle replaces the Hustle integration + custom panel, and the
  Household integration, as one Home Assistant add-on.
- New Calendar tab, laid out like a Skylight Calendar: your Google Calendar
  (through Home Assistant) as a week or month grid, with each event tagged
  with who it's for and who's attending, each person's chores done today,
  and adding/deleting events from the panel.
- Chores tab: all of Hustle (chores, extra jobs, grades, behavior,
  paychecks, payroll, reports), unchanged.
- Meals tab: Household's dinner board, AI meal-plan wizard, grocery list and
  moving a dinner, unchanged apart from the board updating immediately.
- First start imports the Hustle integration's data and chore pictures, and
  Household's grocery list and Dinners calendar.
- Hustle's automation entities are published over MQTT with their old
  entity ids, and `hustle_*` events still fire.
- First-run setup screen replaces the integration's config flow.
