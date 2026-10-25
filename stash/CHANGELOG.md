# Changelog

## 1.0.2

- Budgets shows each bill once. An overdue bill and its next occurrence
  no longer appear as two rows - the row shows the overdue one, with the
  next amount and due date underneath.
- Clicking a bill on Budgets shows its next payment due (plus anything due
  after it) and its last 3 payments across every month.
- A recurring bill's next occurrence now keeps its "Pay to" company.

## 1.0.1

- New "Midnight Cobalt" look with a dark and a light theme, including
  glowing light-ribbon backgrounds. Stash follows Home Assistant's
  light/dark setting automatically.
- Status tags (paid, overdue, due soon, deferred) now match the theme
  instead of always using light-mode colors.
- New category colors and add-on icon to match.

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
