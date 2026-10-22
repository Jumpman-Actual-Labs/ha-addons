# Changelog

## 1.0.10

- Firearms have an "NFA item" checkbox (Add/Edit Firearm). NFA counts on the
  dashboard are now checked firearms plus suppressors, so SBSs, machine
  guns, AOWs and destructive devices can be counted, not just SBRs.
  Firearms already saved as type SBR start out checked.
- NFA firearms show an "NFA" badge on their card and detail page.

## 1.0.9

- Recent Activity: a wishlist firearm marked as purchased now gets its own
  "Added to collection" line at the moment it was bought (from now on -
  ones bought before this update have no recorded purchase time). Parts
  bought off the wishlist are dated the same way.
- Recent Activity shows the 10 newest events; "Show more" adds 10 more, and
  anything older drops off.
- Armory Status rows now open exactly what they count: "Need Cleaning"
  opens Firearms filtered to the ones needing cleaning, and the NFA count
  is split into "NFA Firearms" (opens Firearms filtered to them) and
  "Suppressors" (opens Parts filtered to them). A chip shows the active
  filter and clears it.
- The Firearms and Wishlist cards' "NFA" counts no longer include
  suppressor parts.

## 1.0.8

- Recent Activity no longer lists wishlist parts - neither adding one nor
  putting one on a firearm's planned build. Wishlist firearms still show as
  "Added to wishlist".

## 1.0.7

- Dashboard Recent Activity is more complete and specific:
  - Wishlist firearms and parts say "Added to wishlist" instead of
    "Added to collection".
  - Now also shows parts added, parts installed on a firearm, and storage
    locations added.
  - Range sessions are one line each (total rounds and firearms) instead of
    one line per firearm, so they no longer crowd out everything else.
  - Every row opens what it refers to, and "Show more" expands the list in
    place instead of jumping to the Firearms tab.

## 1.0.6

- Add/Edit Firearm: the caliber suggestions now match the selected firearm
  type (e.g. Handgun shows only handgun calibers, Shotgun only gauges).
  Any caliber can still be typed in.

## 1.0.5

- Sidebar icon is now an ammunition icon instead of a safe.

## 1.0.4

- Ammunition cards: Edit and Delete moved into a ⋮ menu, and Add/Remove
  rounds are now small - / + buttons next to the round count.

## 1.0.3

- New Cache logo and icon.

## 1.0.2

- Brings in the latest Cache work that 1.0.0 missed: the tactical redesign
  (olive accents, contour background, Bear Armory branding), expandable
  Estimated Value / Purchase Price breakdowns, and the "Get AI Used-Value
  Estimate" button for firearms and parts.

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
