# Cache tactical theme

The current visual direction is black, gunmetal and silver with restrained olive and coyote accents. This supersedes the historical monochrome theme description in CLAUDE.md.

`src/cache-panel.ts` defines the shared `--cache-*` tokens, compatibility aliases for existing `--hud-*` and Home Assistant properties, background contours/grain, navigation and page header. Keep the configured collection name alongside CACHE branding.

`src/styles.ts` retains the existing `glassCardStyle` and `formStyles` reusable Lit CSS exports. Every existing view imports these within its shadow root. They cover card material, buttons, inputs, badges, selections, focus indicators, responsive grids and reduced motion. No wrapper components are needed to change existing event/slot behavior.

Dashboard bars use olive, wishlist accents use coyote, and warnings/errors retain semantic colors. Dialogs use a more opaque raised surface to preserve readability over content. Attachment cards reuse the surface token while retaining their existing stack behavior.

All nine views inherit this system: dashboard, firearms/details, parts inventory, ammunition, range sessions, training schedule, training plans, storage and settings. API calls, calculations, data models and persistence are unchanged.

Validation: npm run lint and npm run build (including TypeScript checking) passed. No automated test script exists. Browser visual review remains required: Chromium was unavailable and its installation download failed. Check populated and empty views, long collection/item names, add/edit dialogs, dropdowns, attachment stacks and dashboard bars at mobile/tablet/desktop sizes in Home Assistant before merging. Main-branch pushes trigger the existing Home Assistant deployment workflow.
