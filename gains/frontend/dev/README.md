# Interface preview

Run `npm run dev -- --host 127.0.0.1 --port 5178` and open
http://127.0.0.1:5178/dev/ . This is a development-only host with synthetic
athlete, program, gym, history and recovery data. It does not connect to Home Assistant.
The production library build does not include this HTML entry or host.

Use the toolbar to switch light/dark themes, inherited HA accent colors, or empty/populated states. The first
Start now button opens a simulated workout. Exercise selection, set logging and
rest timer actions can be checked without modifying live data. This minimal host
is not an implementation of the full HA backend or its component library.

Browser checks performed at 390×844 and 1280×720: home and next-session controls,
light/dark switching, unavailable recovery, empty onboarding, session opening,
exercise navigation, one-set logging and rest timer progression. Full Home Assistant
component rendering and production smoke testing remain rollout checks.

The four-section program builder also supports synthetic proposal generation and acceptance. The mock returns a visual fixture, not real exercise selection, equipment feasibility or progression. Production planner compatibility was checked separately with four serialized frontend-to-backend contract cases.
