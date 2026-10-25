# Changelog

## 1.2.2

- Meals: lunches. **Meal prep** now makes lunches by default (packable
  dishes that keep in the fridge), with Dinners still a choice. Adding a
  meal by hand and a recipe's "Plan for" ask Lunch or Dinner. This week
  shows each day's lunch and dinner.
- Lunches go on the same meals calendar, titled "Lunch: <dish>", and get
  their own icon on the Calendar tab. Existing dinners are unchanged.

## 1.2.1

- Gains workouts are off the calendar again (too much on it). Their start
  times and the "Show workouts" setting are cleared. Event editing and meal
  prep from 1.2.0 stay.

## 1.2.0

- Calendar: edit events - title, time, dates, place, notes, repeat and
  who it's for. For a repeating event, change just that day or that day and
  every one after.
- Calendar: workouts from Gains programs (needs Gains 1.0.3) show for each
  athlete. Tap one to set when it starts - for just that workout or that
  day every week - and it ends when Gains expects the workout to be done.
  Turn them off under ⚙ › Show workouts.
- Meals: Meal prep has its own button again, meal-prep dinners are marked
  as a batch, and a card at the top of This week shows the batch, its
  nights and its recipe.

## 1.1.1

- Cook mode: tap any ingredient's amount and type a new one - every other
  ingredient (and the servings) scales to match, in kitchen-friendly
  fractions. ½×, 2× and Original buttons too.
- Recipe editor: "Write with AI" is now "Fill with AI", at the bottom. It
  only fills fields that are still blank, uses what you've already written
  to keep the rest consistent, and never changes anything you wrote.

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
- Meals tab rebuilt in two sections. **This week** lists the next seven
  dinners: add one (from a recipe or just a name), move or remove it, open
  its recipe, or plan the week with AI. The grocery list sits underneath
  with "Add to shopping list". **Recipes** is the family recipe box: search,
  add or edit recipes (or have the AI write one from its name), Cook mode
  (step by step in big type, ingredient checklist, keeps the screen on),
  add a recipe's ingredients to the shopping list, and plan it for a night.
  Dinners link to recipes by name.
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
