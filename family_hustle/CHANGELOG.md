# Changelog

## 1.1.0

- Light and dark themes. Auto (the default) follows Home Assistant's dark
  mode; the button at the bottom of the menu switches between Auto, Light
  and Dark on each device.
- Calendar: a Day view next to Week and Month (tap a day's name or date to
  open it).
- Calendar: dinners from the Meals tab show on the all-day row (turn off
  under ⚙ › Show dinners).
- Calendar: repeating events (every day, weekday, week on chosen days, 2
  weeks, month or year; until a date or a number of times), and timed
  events that span several days. Deleting a repeating event asks whether to
  delete just that day or all of them.
- Calendar on phones looks like the iPhone Calendar app: the month's
  dates, each with a colored bar of who has events that day, and the
  tapped day's events listed underneath. Swipe sideways for another month.
- Calendar ⚙ › Family colors: pick each person's color.
- Settings (calendars, dinners calendar, shopping list, colors) are now for
  admin parents only, in the panel and on the server.

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
- Shopping tab: Home Assistant's shopping list (or any to-do list), shared
  with the HA app and Assist. Everyone can add, check off, rename and
  remove items. The Meals grocery list can send what you don't already
  have straight to it.
- First-run setup screen replaces the integration's config flow.
