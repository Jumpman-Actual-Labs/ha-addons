# Changelog

## 1.4.0

- Average MPG no longer goes wild when fill-ups aren't logged. With a fuel
  level and odometer sensor linked, Garage follows each tank from fill-up
  to fill-up on the sensor and averages the last 5 tanks' miles over the
  gallons actually burned, whether or not anyone logged them.
- A logged full tank gets no MPG when the sensor saw an unlogged fill-up
  since the last one (its miles would span two tanks).
- Without sensor tanks yet, logged fill-ups over 80 MPG are left out of
  the average.
- New "I missed logging the fill-up before this one" checkbox on Add Fuel.
  That entry gets no MPG. A full tank whose miles since the last one run
  past about 1.3 tanks (at the vehicle's own average) gets none either.
- Fill-ups nobody logged: when the fuel sensor sees one, the vehicle's
  primary driver gets a notification and the vehicle shows a "Fill-up
  detected" prompt. **Log it** opens Add Fuel filled in (date, odometer,
  estimated gallons); **Dismiss** clears it. A fill-up logged at the pump
  isn't prompted.
- Gear sensor link. Fuel only counts in a drive gear, shifting into Park
  ends a trip, and a fuel jump only counts as a fill-up across a stop
  (Park, or a few minutes stopped) - never mid-trip, where it's slosh.
- Tire pressure: link a sensor per tire and set the target pressure.
  Garage shows all four, and alerts on a low tire, uneven pressures, or one
  tire losing pressure faster than the others over a week (slow leak).
  Each alert notifies the primary driver once, is in the 8am reminders,
  and lowers the health score.
- Trouble codes: link a sensor whose state lists the active codes (or "All
  clear"). Codes show on the vehicle, are in the 8am reminders, and lower
  the health score (more with the check engine light on).
- The sensor pickers in Edit Vehicle now show the linked sensor instead of
  "Not linked" when the sensor list loads after the form opens.

## 1.3.1

- Fuel level from a linked sensor now only counts while the vehicle is
  driving (when an odometer sensor is linked too), smoothed over the trip's
  last few readings. Parking on a slope, or fuel sloshing under braking, no
  longer skews it. After a stop of 3+ minutes (like a fill-up) it starts
  fresh.
- Each reading now says what the linked sensor is doing: live, parked,
  asleep, not found, or failing. A sensor that can't be read is logged as a
  warning instead of only at debug level.

## 1.3.0

- Redesigned the dashboard around vehicle readings, with prominent fuel,
  odometer and estimated range displays. Spending and recent activity remain
  available below the vehicle overview.
- Vehicle cards and detail pages share a clearer readings display, including
  low-fuel warnings, readable units and layouts for smaller screens.
- Reading source labels distinguish linked sensors from saved readings. Garage
  retains the last saved values when a sensor is unavailable; a configured
  sensor link does not indicate a fresh reading.

## 1.2.0

- Live sensors: link a vehicle to Home Assistant sensors (for example a
  WiCAN OBD-II dongle's odometer and fuel tank level) under Edit Vehicle →
  Live sensors. Garage reads them about once a minute and keeps Current
  Mileage and Fuel % up to date, so mileage-based maintenance, the health
  score, estimated range and low-fuel reminders follow the car. Mileage only
  ever goes up; readings while the dongle is asleep are ignored. Kilometre
  odometers are converted to miles.

## 1.1.1

- Panel now visible to non-admin users. Added Allowed users option to restrict access to specific accounts.

## 1.1.0

- Stash sync works with the new Stash add-on (talking to it directly), and
  still with the old Stash integration if that's what's installed.

## 1.0.0

- Garage is now a Home Assistant add-on instead of a custom integration +
  custom panel. Same features, same data.
- On first start, imports everything from the old `garage` integration
  (vehicles, drivers, fuel, maintenance, documents, vehicle photos)
  automatically.
- Automation entities (`sensor.garage_monthly_fuel_spending`,
  `sensor.garage_monthly_maintenance_spending`,
  `sensor.garage_vehicles_needing_attention` and one health-score sensor per
  vehicle) are now published over MQTT and keep their entity ids.
- Stash sync and the daily 8am driver reminders work as before, through
  Home Assistant's API.
- The OpenAI key can now be set in the add-on's options (secrets.yaml's
  `openai_api_key` still works as a fallback).
