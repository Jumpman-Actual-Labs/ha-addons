# Changelog

## 1.0.7

- Building a program no longer fails with "No feasible load: inventory
  minimum exceeds comparable performance" when an athlete's last logged
  weight is lighter than anything the gym can load. The exercise starts at
  the gym's lightest load at the low end of the rep range instead (kids'
  profiles still refuse, as with their starting loads).

## 1.0.6

- Replace exercise shows its list right away: Similar / All exercises /
  Show unavailable buttons up top, the other filters folded under "More
  filters", and the whole dialog scrolls instead of squeezing the results.
- An exercise page has Prev / Next buttons, and Skip exercise moves on to
  the next one.
- The "Details" button (the same as the info icon) is now History: your
  last 10 sessions of that exercise with sets, volume, estimated 1RM, PRs
  and effort.
- Add exercise button on planned and in-progress workouts.
- Workout Together: move between exercises in any order (turns alternate
  within each exercise), remove or add exercises for both athletes, and
  switch bars - including a partner's on a shared device. Removing an
  exercise is refused if your partner already logged sets on it.
- Removing an exercise now shows an error if it fails instead of doing
  nothing.

## 1.0.5

- Panel now visible to non-admin users. Added Allowed users option to restrict access to specific accounts.

## 1.0.4

- Program workouts no longer go to the Family Hustle calendar - the
  schedule sharing added in 1.0.3 is removed.

## 1.0.3

- Program workouts can show on the Family Hustle calendar: Gains shares
  each athlete's upcoming program sessions and how long it expects each to
  take, with the Family Hustle add-on only.

## 1.0.2

- Runs are switched off for now: no Runs tab, run builder, run plan card or
  run suggestions from Geoffrey, and new programs have no run days. Runs
  you already logged are kept and come back if runs are switched on again.
- The Coach tab shows athletes as tiles with their Home Assistant account
  picture (or their initial when they don't have one).

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
