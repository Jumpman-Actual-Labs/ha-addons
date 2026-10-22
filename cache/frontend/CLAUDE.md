# Cache - Frontend

The Cache add-on's panel (its own sidebar entry via ingress). Built with Lit
+ TypeScript, bundled by Vite into `dist/` (an `index.html` + one hashed JS
file) that the backend serves at the ingress root. It was originally a
custom Home Assistant panel (`ha-cache-frontend`) and still is one in
structure: `<cache-panel>` takes a `hass` object and every view reads from
it. In the add-on, `src/main.ts` mounts it and `src/addon-hass.ts`
provides that `hass` (see Architecture).

## Theme

The whole panel is a "smoked-glass holoscreen" material system - a
premium, futuristic OPERATING SYSTEM aesthetic (sophisticated near-
future armory management OS), not a themed website, not a video-game
HUD, not neon cyberpunk. Overwhelmingly near-black/dark-charcoal, one
neutral white/gray accent, NO glow anywhere - depth and "futuristic"
read comes entirely from real material properties (translucency,
backdrop blur, soft layered shadows, thin borders, restrained gradient
highlights) rather than light emission. This is set almost entirely in
ONE place: `cache-panel.ts`'s `:host` styles redefine Home Assistant's
own theme variables (`--primary-color`, `--card-background-color`,
`--primary-text-color`, `--secondary-text-color`, `--divider-color`,
`--secondary-color`, `--error-color`, etc.) to the theme palette. Every
other view/component in this app was already written against those SAME
variable names (`var(--primary-color, <light-theme fallback>)`) rather
than literal colors, specifically so a theme could be swapped in from
one place - CSS custom properties inherit straight through shadow DOM
boundaries the same way `color`/`font-family` do, so this cascades into
every nested view/dialog's own shadow tree automatically. The fallback
hex values baked into each `var(--x, ...)` call throughout the codebase
are effectively dead now (they'd only matter if `cache-panel` stopped
setting the variable) - they're kept in sync with the real value anyway
purely so reading the source in isolation doesn't mislead, not because
they do anything. `--text-primary-color` (text drawn ON a
`--primary-color` fill, e.g. a primary button's label) is near-black,
for contrast against that white fill. `--hud-good` (a muted green,
`#7bc98f`) is a SEPARATE variable reserved strictly for status-good text
(the sidebar's "System Status" card, success badges) - it is not the
interactive accent and shouldn't be used for buttons/links/focus rings.

**Design tokens** (`cache-panel.ts`'s `:host`) - the single source every
glass surface app-wide reads from, so the material system stays ONE
consistent thing rather than each component inventing its own blur/
radius/hover values:
- `--hud-bg` / `--hud-bg-2` / `--hud-sidebar-bg` - three distinct
  near-black tones (deepest to lightest: content area, app shell,
  sidebar), not a flat single background. No blue cast, ever.
- `--hud-panel-bg` - the translucent glass fill every card/dialog/
  control is built from (`rgba(22, 24, 27, 0.46)` - genuinely see-
  through, not "nearly solid").
- `--hud-white` / `--hud-white-dim` / `--hud-mute` - text primary/
  secondary/tertiary.
- `--hud-border` - a glass surface's resting border. `--hud-border-
  strong` - small chip/avatar/logo-mark outlines specifically (NOT card
  hover). `--hud-border-hover` - a glass CARD's border once hovered, one
  step up from `--hud-border`, short of `--hud-border-strong`.
- `--hud-radius` / `--hud-radius-sm` - card vs. control corner rounding.
  Dialogs stay their own literal 14px (a deliberately larger surface).
- `--hud-blur` - the base glass blur amount cards/controls read against;
  larger surfaces (dialogs, sidebar) use a proportionally bigger literal
  blur instead of this token.
- `--hud-good` / `--hud-amber` / `--hud-red` - the three semantic hues
  (status-good, warning, error) - the ONLY color outside the neutral
  white/gray accent anywhere in the theme.

**This is the SEVENTH pass at this theme**, iterated live against
feedback each time - keep this history in mind before re-designing from
scratch, and don't be surprised if it moves again:
1. Monochrome green-phosphor CRT-terminal look (scanlines, a repeating
   grid texture, a monospace font, a scrolling scan-sweep animation). Read
   as 1980s DOS, not futuristic. Scrapped entirely.
2. Electric-cyan/violet glass HUD (gradient header text, colored ambient
   glow blobs, cyan corner brackets, 12px/16px rounded corners). Closer,
   but still "more color and more rounding than asked for" at the time.
3. Pure black/white/gray, `--primary-color` a plain soft white, no hue
   anywhere outside warning/error, no glow anywhere. Hit "less color,
   less rounded, elegant" but lost the "military" read entirely.
4. `--primary-color` became a desaturated gunmetal/steel blue-gray
   (`#7c8a94`) instead of plain white - still no glow, still tight radii
   - to bring back a "military hardware" read without reintroducing much
   color. Bolder (but still glow-free) corner brackets.
5. A specific, concrete brief - "Iron Man/Tony Stark clean" - which was
   read as unambiguously a saturated, GLOWING blue aesthetic, not a
   desaturated/glow-free one. `--hud-accent` moved to a vivid arc-reactor
   cyan (`#00d9ff`), and box-shadow GLOW came back on buttons, focus
   rings, and corner brackets (`filter: drop-shadow(...)`).
6. A reference SCREENSHOT was given a second time, explicitly to "match
   the color scheme and design" - and that screenshot's actual rendered
   look is flat and matte, with NO glow anywhere, closer to pass 3 than
   pass 5. `--hud-accent` moved back to plain white, every box-shadow
   bloom/`filter: drop-shadow(...)`/`text-shadow` was removed outright.
   Several follow-up refinements landed within this same pass, each its
   own small round of feedback: the corner-accent brackets were removed
   entirely (plain edges, nothing drawn on top of a card); card fills
   became genuinely more transparent with a soft ambient highlight +
   tiled film-grain texture reintroduced behind them specifically so
   `backdrop-filter: blur()` had real material to refract (a frosted
   card over a perfectly flat, ungrained background is indistinguishable
   from an opaque one); and cards gained a real 4-layer 3D shadow (inset
   top highlight, inset bottom vignette, contact shadow, ambient shadow)
   so glass panels read as physically sitting above the page.
7. **Current**: a long, explicit, structured brief for a "sophisticated
   near-future armory management operating system running on smoked
   glass displays" - Apple-level restraint plus futuristic military
   inventory system, explicitly NOT gritty/cyberpunk/neon/blue-
   everywhere/video-game-like/busy. The pass-6 direction (flat,
   monochrome, no glow, muted green status-only) carries forward
   unchanged - this pass is almost entirely about MATERIAL QUALITY and
   DEPTH HIERARCHY rather than color: the shadow recipe from pass 6's
   follow-ups was dialed back to roughly half its previous alpha
   (pass 6's shadows, built to prove the glass effect existed at all,
   read as too bold once judged against "barely visible" restraint);
   `backdrop-filter` saturate dropped from 150%/140% to 120% everywhere;
   the background hierarchy went from two flat tones to three distinct
   near-black tones (`--hud-bg`/`--hud-bg-2`/`--hud-sidebar-bg`); the
   sidebar and topbar gained real translucency + backdrop blur instead
   of a solid fill; `ha-card` gained a barely-visible 145deg diagonal
   sheen gradient (`ha-card::before`, reusing the pseudo-element freed up
   when corner marks were removed) simulating a glass edge reflection;
   and the whole system got named, shared design tokens (above) for the
   first time instead of each component hand-tuning its own values.
   `firearms-view.ts`'s firearm cards - explicitly called out as the
   most important surface in the brief - got the most dedicated work:
   a restrained hover interaction (2px lift, `--ha-card-border-color`/
   `--ha-card-background`/`--ha-card-box-shadow` redefined at `:hover`
   on the ha-card element from outside, since those custom properties
   are what glassCardStyle's base rule reads for its shadow-DOM
   internals - see the ha-card.firearm:hover comment for why this works
   but a plain CSS transition on background/border-color driven through
   a custom property isn't guaranteed to animate smoothly across a
   shadow boundary, so only `transform` is relied on for guaranteed
   smooth motion), a taller image area with its own subtle top-lit
   gradient + hairline divider from the info area below it (distinct
   glass "opacity" between image and info, per the brief, rather than
   boxing the photo in an obvious frame), an image hover scale
   (1.015x), and a dedicated `.firearms-grid` with real breakpoints
   (4/3/2/1 columns) instead of the shared auto-fit `.grid` (which
   suits panel/list content elsewhere, not a photo-forward card grid
   that wants a firm, intentional column count at each size).

A follow-up density/layout pass (dashboard-view.ts specifically, plus
two shared token nudges) landed within this same pass-7 direction, not
a new one: `--hud-panel-bg` alpha `0.46` -> `0.4` and the `ha-card::
before` sheen gradient's peak alpha `0.035` -> `0.045` (both still
restrained, just a touch more visible material separation - "cards
still read slightly too much like solid dark rectangles" was the
specific feedback), plus fixing dashboard-view.ts's forced-equal-height
panel grid (see its own Architecture bullet below for the full
`grid-template-areas`/`.right-stack`/`align-items: start` mechanics)
and a `cache-panel.ts` `main { min-height: 0 }` bugfix the height
auditing surfaced (without it, any tab's content exceeding the
viewport grows the whole page instead of scrolling internally, so the
sidebar/topbar scroll away too).

The throughline worth remembering for next time: monospace fonts and
repeating line/scanline textures read as "retro terminal" almost
immediately regardless of color or glow; a SPECIFIC named reference (an
era, a franchise, a real product, or literally an image) is worth
implementing literally rather than through this project's own prior
"less is more" instincts OR the previous pass's direction. And - new
from this pass - when a brief explicitly asks for "restraint" or
"barely visible" material cues, that's a signal to DIAL BACK a
previous pass's boldness even if that previous pass was itself a
direct, approved response to earlier feedback; restraint isn't the
default state to return to, it's an active choice each pass has to make
again based on what THIS brief is actually asking for.

One component predates the reskin and was built as a deliberately-
always-dark surface with literal hardcoded hex instead of reading HA's
theme variables (`attachment-bar.ts`) - it doesn't pick up the cascade
and had its hex values hand-swapped on every one of the seven passes
above. (`my-build-view.ts` used to be the other one; it was deleted when
My Build's standalone view was removed - see "My Build" below.) If you add a new component that should ALWAYS
look like this theme regardless of the variable cascade (unlikely - the
cascade is what everything else uses), that's the pattern to follow;
otherwise just use `var(--primary-color, ...)` etc. like every other
view and it'll fall in line automatically.

`glassCardStyle` (`styles.ts`) gives every `ha-card` the shared glass
treatment: a translucent fill (`--hud-panel-bg`) with real `backdrop-
filter: blur(var(--hud-blur)) saturate(120%)`, a thin neutral border, a
restrained 4-layer `--ha-card-box-shadow` (inset top highlight for a
glass edge catching light, inset bottom vignette for a sense of actual
thickness, a tight contact shadow, a soft ambient shadow - all
deliberately low-alpha, see pass 7 above), and `ha-card::before` for a
barely-visible 145deg diagonal sheen gradient (a *material* highlight,
distinct from and layered under the box-shadow's inset top highlight,
which is a *lighting* cue). No corner-accent marks - an earlier pass
drew bracket/reticle-style corners here (and on `cache-dialog`'s
`.surface`/`attachment-bar`'s cards); removed for a plainer glass-panel
look with nothing drawn on top of the card edges. `cache-dialog`'s
`.surface` and `attachment-bar`'s cards use the same shadow recipe
(scaled per element size) rather than each having its own one-off
values, so every glass surface in the app reads consistently. `form
Styles` (`styles.ts`) carries the rest: glass inputs/selects (`--hud-
radius-sm` rounding, translucent fill, hover border via `--hud-border-
hover`), a translucent-not-solid `button.primary` (stands out through
CONTRAST - still the brightest surface - not an opaque fill or a
glow), tiny inset-glass `.badge` chips (`rgba(255,255,255,0.05)` fill/
`rgba(255,255,255,0.08)` border for the neutral variant, low-alpha
semantic tints for info/success/warning/error), and the `.segmented`
toggle (active state is a translucent light fill, deliberately short of
pure white/opaque, per the brief's "avoid making it pure white").

## Architecture

- `src/addon-hass.ts` - `AddonConnection`, the add-on's implementation of
  the `HomeAssistant` interface `ha-api.ts` declares. `states` comes from
  the backend's `api/websocket`, which pushes a full `hass.states`-shaped
  snapshot on connect and after every change (reconnecting with backoff);
  `callService("cache", name, data)` is `POST api/services/<name>`, throwing
  an `Error` with the backend's message on failure (views show
  `err.message`, and slot-modal.ts matches "already installed on another
  firearm" in it). Every URL is relative - ingress serves the page under
  `/api/hassio_ingress/<token>/`.
- `src/shims/ha-elements.ts` - stand-ins for `<ha-card>` and `<ha-icon>`,
  which HA's frontend registered for the panel but don't exist in an
  ingress iframe. `ha-card` honors the same `--ha-card-*` custom properties
  `styles.ts`'s glass treatment sets; `ha-icon` looks `mdi:<name>` up in
  `src/shims/icons.ts`, which `scripts/gen-icons.mjs` generates from every
  `mdi:` literal in `src/` (run automatically by `npm run build`). An icon
  name built at runtime from pieces won't be found by that scan - keep
  icon names as whole string literals.
- `src/ha-api.ts` - the only file that talks to the backend.
  `parseCacheState()` reads `hass.states`, finds Cache's entities by their
  stable discovery attributes (`cache_key`, `firearm_id`, `inventory_item_id`,
  `ammunition_id`), and returns a typed `CacheState`. `cacheApi.*` wraps
  every service call, plus `uploadPhoto()`/`uploadDocument()`/
  `scanAmmoBox()`/`lookupAmmoBarcode()` for the things a JSON service call
  can't do - multipart file upload (`uploadFile()`, `POST api/upload/photo`,
  `api/upload/document`, `api/scan_ammo_box`) and a plain JSON POST
  (`postJson()`, `api/lookup_ammo_barcode`). If you add a new backend
  service, add its wrapper here, not ad hoc `hass.callService` calls
  scattered through views. `scanAmmoBox()`/`lookupAmmoBarcode()` don't
  persist anything server-side - both return a best-effort
  `ScannedAmmoFields` (any unreadable field is `null`, via the shared
  `parseScannedAmmoFields()`) for the caller to merge into a form draft; the
  OpenAI API key is configured server-side only, as the add-on's
  `openai_api_key` option - the frontend never sees or handles that key.
- `src/types.ts` - TS mirror of the backend's `const.py` lists and
  `states.py`'s attribute shapes - kept in sync by hand (no shared schema,
  so a backend state/service field rename needs a matching edit here).
- `src/cache-panel.ts` - root element `main.ts` mounts and
  sets `.hass`/`.narrow` on directly (not HTML attributes). Owns tab state,
  calls `parseCacheState` once per render and passes the result down.
  Navigation is a fixed 220px LEFT sidebar (`<aside class="sidebar">` -
  logo block, a vertical icon+label `<nav>` list, a "System Status"
  footer card), not the original horizontal top tab strip - replaced
  after being shown a reference screenshot of a sidebar-nav app. Below
  700px the sidebar collapses to a 64px icon-only rail (labels/footer/
  operator text `display: none` via a `@media` query) rather than a full
  collapsible-drawer treatment - every tab stays reachable by icon, just
  without a full redesign for mobile. A slim `.topbar` above `<main>`
  shows the REAL signed-in HA user's name (`hass.user.name`) and an
  initial-letter avatar - deliberately NOT the reference image's
  fabricated "OPERATOR BEAR-7" callsign, since this app has no callsign
  concept, and nothing invented should be presented next to genuinely
  real data. The reference also showed a decorative right-side "system
  telemetry" panel (vault temperature, humidity, GPS coordinates, a
  skull/wings emblem) - deliberately NOT built, since none of that data
  exists anywhere in this app's domain model; a firearms inventory
  tracker has no vault sensors, and fabricating live-looking readouts
  would read as real telemetry when it's invented, which is worse than
  simply not having the panel. If asked to build a similar panel later,
  it should show something this app actually knows (e.g. cleaning-due/
  low-ammo counts already computed elsewhere), not invented sensor data.
  A `cache-switch-tab` event (`{ tab: string; wishlist?: boolean }`,
  `tab` validated against `TABS` before switching) lets a view ask to
  switch tabs with no specific record to jump to - `dashboard-view.ts`'s
  panel footer/status links use it, same bubbling-event pattern as the
  existing `cache-open-firearm`/`cache-view-item` (which target a
  SPECIFIC record, not just a tab). The optional `wishlist` flag only
  does anything when `tab` is `"firearms"`: it's consumed into
  `_pendingWishlistFilter` and passed to `cache-firearms-view` as
  `initialWishlistFilter`, which that view's `willUpdate` (mirroring the
  existing `initialFirearmId` -> `_selectedId` pattern exactly) uses to
  preset the Owned/Both/Wishlist segmented filter to "Wishlist" -
  dashboard-view.ts's Wishlist panel's "View Wishlist" link is the one
  caller that sets it. `main`'s `max-width` is `1680px` (was `1200px`) -
  generous enough that a large/ultrawide desktop display doesn't read as
  a narrow page floating in the center of the screen, while still capped
  so card/line widths stay reasonable on the very widest monitors.
- `src/views/*.ts` - one per tab (dashboard, firearms, my-build, inventory,
  ammunition, range-sessions, training-schedule, training-plan,
  storage-locations, settings). Each is self-contained: given `hass` +
  `cacheState`, it renders
  and calls `cacheApi` directly on user actions. There is no setup-wizard
  view - collection name/default thresholds are handled entirely by Home
  Assistant's own "Add Integration" config flow in the backend.
- `src/components/cache-dialog.ts` - a plain modal, not a wrapper around
  HA's `<ha-dialog>`, so it doesn't depend on HA's internal Material dialog
  API/slotting staying stable across versions.
- `src/components/image-source-button.ts` (`<cache-image-source-button>`) -
  every place the app accepts an image (firearm/inventory item photos in
  `photo-manager-section.ts`, staged Add-form photos in
  `firearms-view.ts`/`inventory-view.ts`, ammo box scan and
  barcode scan in `ammunition-view.ts`) goes through this one trigger-button-plus-menu
  component instead of a bare `<input type=file>`, so "Choose File",
  "Paste from Clipboard" (`navigator.clipboard.read()`, converts the first
  image `ClipboardItem` to a `File`), and "Image URL..." (plain `fetch()` +
  `.blob()`, rejects non-`image/*` responses) all work everywhere
  uniformly. Emits `cache-image-selected` (`detail: { files: File[] }`) and
  `cache-image-error` (`detail: { message: string }`) - callers wire the
  first straight into whatever they previously did with a file input's
  `FileList` (now a plain `File[]`) and the second into their existing
  `_error` state, so adding this to a new upload site is a template swap,
  not new logic. `multiple` only affects the file picker and clipboard
  paste (a URL can only ever resolve to one file); `capture` passes
  straight through to the underlying file input for the mobile-camera
  hint the scan buttons rely on. The Image URL fetch is a plain
  same-browser request with no server-side proxy, so it fails (with a
  pointed error message) against sites that block cross-origin image
  fetches - that's a real limitation, not a bug to route around.
  `.url-row button` ("Go") sets `width: auto; flex-shrink: 0` explicitly -
  without it the button silently inherited `width: 100%` from the
  earlier, equal-specificity `.menu button` rule (CSS cascades per
  property, so a later rule with equal specificity that never sets
  `width` doesn't clear an earlier one that did), which made the button
  claim the whole `.url-row` and squeeze the URL `<input>` down to
  nothing next to it - a real bug that shipped once, not a hypothetical.
  The dropdown menu itself is portalled into `document.body` (a manual
  `document.createElement("div")` appended there, rendered into via lit's
  own `render` import as `renderToDom`, NOT rendered inline inside this
  component's shadow root) instead of the more typical `position: absolute`
  popup - every real call site nests this button inside SOME ancestor with
  `overflow` set (`cache-dialog`'s scrollable `.surface`, a card body,
  etc.), and an in-shadow-DOM popup gets clipped by whichever overflow box
  it lands inside. `cache-dialog`'s `.surface` makes this worse than a
  plain `overflow:auto` box would: its `backdrop-filter` makes it a
  `position: fixed` containing block too (per the CSS spec, `filter`/
  `backdrop-filter` do this exactly like `transform` does), so switching
  the menu to `position: fixed` without portalling *still* gets clipped by
  that same box - only escaping to `document.body` entirely sidesteps it.
  A real bug this fixed: the Manage Photos dialog's "Add Photos" menu
  rendered into a couple of pixels of clipped, barely-scrollable space
  whenever the dialog was otherwise short (e.g. the empty "No photos yet"
  state), because the menu's own height didn't count toward `.surface`'s
  auto-height (out-of-flow positioned elements never do) but still
  overflowed past its bottom edge, triggering `overflow-y: auto`. The
  portal's `renderToDom` call passes `{ host: this }` explicitly - Lit's
  own render cycle does this automatically so `@click=${this._method}`
  (an unbound prototype method, not an arrow function) resolves `this` to
  the component inside the handler; calling the bare `render` import
  yourself skips that unless told to, which silently rebinds `this` to
  the clicked DOM element instead (a second real bug this hit while
  building the fix - "Image URL..." looked like a dead button). The
  portal position is computed fresh from `this.getBoundingClientRect()`
  every time the menu opens. It deliberately does NOT also close itself on
  `scroll` - an earlier version did, to stop a stale menu drifting away
  from a scrolled-past trigger, but a capture-phase `window` scroll
  listener sees scroll events from nested scrollable ancestors too, and
  mobile browsers scroll/resize the page when a text input gains focus to
  clear space for the on-screen keyboard - a real bug that version caused:
  opening "Image URL..." and tapping its input closed the whole menu
  before you could type anything, since focusing the input triggered
  exactly the scroll the listener was watching for. `_handleOutsideClick`'s
  "was this click
  outside the component" check now also excludes clicks landing inside
  the portal element (`path.includes(this._portal)`), since the portal is
  a `document.body` sibling, not a DOM descendant of this component
  anymore - without that, every click inside the menu itself would look
  like an outside click and close it before its own handler even ran.
  If editing this file's CSS, do not wrap anything in backtick-emphasis
  inside a `/* */` comment - a backtick anywhere inside the `css\`...\``
  template literal (comments included) closes it early, silently turning
  the rest of the block into corrupted "JS" that fails with confusing
  parse errors far from the actual typo. `navigator.clipboard.read()`
  requires a secure context (HTTPS, or localhost) to exist at all - if
  Home Assistant is served over plain HTTP (common for local-network-only
  installs), `navigator.clipboard` is `undefined` and "Paste from
  Clipboard" always fails; `_pasteFromClipboard()` checks
  `window.isSecureContext` to give an accurate reason in that case rather
  than a generic "try Choose File instead" that implies retrying might
  work. Nothing in this component can fix that - it's a browser platform
  restriction, not an app bug. `busyLabel` is a plain property (not a fixed
  string), so a caller can swap in a more specific message while
  `disabled` is set - `photo-manager-section.ts` always passes "Removing
  background…" (unconditionally now, for both `entityType`s - it used to
  only apply for `"inventory_item"`, before `CacheUploadPhotoView` started
  running EVERY photo upload through OpenAI background removal, not just
  parts; see the backend's CLAUDE.md). `photo-manager-section.ts`
  also shows a `.processing-note` line above the grid, unconditionally
  too, while `_uploading` is true, since the background-removal round trip
  is visibly slower than a plain upload and a silent spinner reads like
  it's stuck. `firearms-view.ts`'s dedicated hero/build-image button
  (`_renderEditPhotosSection`/`_renderAddPhotosSection`) passes the same
  "Removing background…" `busyLabel` for the same reason - every upload
  path in this app, hero or gallery, now runs through background removal.
- `src/components/log-range-session-dialog.ts` - each row's ammo field is a
  button that opens a second `<cache-dialog>` stacked on top of the main
  one (a later sibling in the render output, so it paints above the
  already-open form dialog) rather than a single flat `<select>` - picking
  ammo is two steps, caliber first then the specific entry within that
  caliber, because a flat list of every `Ammunition` row labeled just
  `${caliber} (${quantity} left)` shows the same caliber more than once
  with nothing but the quantity to tell entries apart the moment a
  collection has two products in the same caliber (e.g. two different 300
  BLK loads). Reopening the picker on a row that already has an ammo
  selected jumps straight to that entry's caliber (skips the calibers
  list) rather than always starting over at step one. The calibers step is
  also narrowed by `_calibersForRow()` to just the row's selected
  firearm's own caliber (auto-skipping straight to the product list when
  there's exactly one match, same as the "reopen an existing selection"
  case) - a firearm with no caliber recorded falls back to every caliber
  in the collection, since there's nothing to narrow against. Changing a
  row's firearm (`_updateRowFirearm`) clears that row's ammo selection if
  it's no longer compatible with the new firearm's caliber, so a stale
  incompatible pick can't silently ride along. The same component now
  doubles as the edit dialog - an `editingSession: RangeSession | null`
  property (set by `range-sessions-view.ts`'s Edit button) switches the
  heading/save-button copy and prefills date/location/notes/rows from the
  existing session in `willUpdate`, and `_save()` calls
  `cacheApi.updateRangeSession()` instead of `logRangeSession()` when set -
  see the backend's CLAUDE.md for how the backend reconciles
  round counts/ammo when a session's entries change.
- `src/styles.ts` - shared glassmorphism card treatment + form/button/badge
  primitives, imported into each view's own `static styles` (shadow DOM
  scoping means a global stylesheet can't reach into descendant components).
- `src/utils/options.ts` - `knownManufacturers()`/`knownCalibers()` back the
  manufacturer/caliber `<input list=...>` + `<datalist>` combos across every
  form (firearm, inventory item, ammunition, `slot-modal.ts`'s "+ Create
  New Part" form).
  These are suggestion dropdowns, not enforced enums - free typing still
  works, since there's no closed list of every manufacturer/caliber that
  could exist. Caliber seeds from `COMMON_CALIBERS` in `types.ts` plus
  whatever's already in the collection. The Add/Edit Firearm form passes
  its selected Firearm Type to `knownCalibers()`, which then narrows to
  that type's `CALIBERS_BY_FIREARM_TYPE` list (handgun/rifle/shotgun
  groups; AR Pistol/SBR and Lever Action add common pistol calibers) plus
  calibers already used on firearms of that type - ammo calibers are left
  out there, since ammo has no firearm type. "Other" isn't mapped, so it
  gets everything. Ammo and training forms still call it without a type
  and get the full list. Manufacturer is purely from
  whatever's already in the collection (no baseline list - too broad a
  category to seed usefully).
- Custom Name is optional on the firearm/inventory-item forms - leave it
  blank and the backend fills in a fallback (manufacturer + model, or
  type/category). Forms send `custom_name: ""` when blank rather than
  omitting the key, matching every other optional-field convention here.
- `inventory-view.ts`'s Add/Edit Item form has no Category `<select>` -
  Category is purely a display/sorting concept for the Parts Inventory
  grid and its filter dropdown, never something chosen directly when
  creating or editing an item. The form's `ItemDraft` carries `partType`
  only; `_save()` derives `category` from it via `CATEGORY_FOR_PART`
  right before building the payload, so the two fields can never drift
  out of sync client-side even though the form only surfaces one of
  them. The Part `<select>` itself is flat over every `PART_TYPES` entry
  (not narrowed by a Category first) since there's no Category step to
  narrow from anymore - this is the one form-level exception to
  `slot-modal.ts`'s Category-scoped Part picker described in "My Build"
  below, which still narrows by Category since it's opened from a
  specific Category's card.
- Both `Firearm` and `InventoryItem` carry an optional `productUrl` (a
  link to buy/reference the thing), rendered as a plain clickable
  external link in each entity's detail page fields grid when present,
  and edited via a "Product Link (optional)" `<input type="url">` on the
  Add/Edit form (`inventory-view.ts` and `firearms-view.ts` both, sent
  as `product_url`) - not restricted to wishlist entries, same as every
  other field, just most useful while something still is one.
- `inventory-view.ts`'s item detail page has an "Add Another" button
  (`_openDuplicate()`) alongside Edit Item - opens the same Add form,
  prefilled from the current item's fields, but with `_editing` left
  `null` so `_save()` creates a brand-new item rather than overwriting
  this one. Serial number is the one field deliberately NOT copied (left
  blank) - it identifies one specific physical unit, so carrying it over
  would give two different inventory items the same serial number.
- The Parts Inventory grid visually stacks same-manufacturer+model items
  into one card (`_groups`, a `Map` keyed by `manufacturer|model`
  lowercased, built once per render from `_filtered` - items missing
  either field never group, keyed instead by their own id so they always
  render as a singleton) - this is a display-only grouping, NOT a data
  merge. Each unit stays its own independent `InventoryItem` record with
  its own serial number/location/install status/photos. This was an
  explicit design choice after discussing a literal "merge duplicates
  with a quantity field" request - that would have broken My Build's
  per-slot tracking (an installed item's identity - which physical unit
  is on which firearm - can't survive being collapsed into a shared
  quantity count), so grouping is purely visual and the underlying data
  model didn't change at all. A stacked card shows the total count as a
  small square `.qty-corner-badge` in the card's own top-right corner
  (not inline next to the title, and not a pill - deliberately squared
  off to read as a count chip rather than this app's usual rounded
  `.badge` convention), and its rows are grouped again by
  `_locationGroups()` - "On &lt;firearm&gt;" or "📍 &lt;location&gt;" -
  rather than one row per unit, since the part's name is already the
  card's title and repeating it per row (the original first pass) added
  nothing. Two units sitting in the exact same spot collapse into a
  single row with its own small `.location-qty-badge`; a row's click
  target is just whichever one of its (possibly several, functionally
  interchangeable at that point) underlying units happened to be listed
  first, landing on that specific unit's own detail page.
- Ammunition's Cost Per Round isn't directly editable - the form takes Cost
  Per Box + Rounds Per Box instead, sends `cost_per_box`/`rounds_per_box`,
  and the backend computes `cost_per_round` server-side (see
  the backend's CLAUDE.md). `ammunition-view.ts`'s
  `computedCostPerRound()` does the same division purely for the live "≈
  $X.XX/round" hint under the form fields - it's not what gets saved.
  `Ammunition.speedClass` ("Subsonic"/"Supersonic"/`null`) is likewise
  backend-derived from `muzzle_velocity`, not computed here. The Add/Edit
  Ammunition dialog has two auto-fill options, both merged into the draft
  via the shared `_mergeScannedFields()` (existing draft values are kept
  for anything the scan couldn't fill, and the user reviews/edits before
  saving either way - nothing auto-saves from a scan):
  - "Scan Box Photo" (a `<cache-image-source-button>` with
    `capture="environment"`, so the file-picker path opens mobile's camera
    directly - Choose File/Paste/URL all work too) uploads the photo via
    `cacheApi.scanAmmoBox()`, which the backend feeds to OpenAI vision.
  - "Scan Barcode" decodes a UPC/EAN client-side via the browser's native
    `BarcodeDetector` (Shape Detection API - Chrome/Edge on Android +
    desktop, not Firefox/Safari; not part of TypeScript's bundled DOM
    types, so `ammunition-view.ts` declares it locally as a `Window`
    augmentation) from whichever image `cache-image-source-button` hands
    back, then sends the decoded value to `cacheApi.lookupAmmoBarcode()`.
    If `BarcodeDetector` isn't available, `_handleBarcodeFile` shows a
    clear "not supported in this browser - use Scan Box Photo instead"
    error rather than silently failing.
  Both `cacheApi` methods return the same `ScannedAmmoFields` shape (see
  `ha-api.ts`'s shared `parseScannedAmmoFields()`), so the view handles
  either scan method identically once the response comes back.
- Ammunition cards keep their actions compact: a ⋮ button (`.card-menu`,
  `button.icon.bare`) in the top-right opens an Edit/Delete menu, and
  Remove/Add rounds are `−`/`+` `button.icon`s beside the round count.
  `button.icon` and `.card-menu` live in `styles.ts` so other card grids
  can reuse them. Only one menu is open at a time (`_menuFor`, the ammo
  id); it closes on picking an item, any click outside a `.card-menu`, or
  Escape. The card with the open menu gets `.menu-open` (`z-index: 5`) -
  each glass card is its own stacking context (backdrop-filter), so
  without it the menu paints under the next card in the grid.
- The Add/Remove Rounds dialog (adjusting an existing ammo entry's
  quantity) shows an "Add by" Rounds/Boxes selector only when that entry
  has a `roundsPerBox` on file - entries without a known box size just get
  the plain rounds input, same as before this existed. In box mode the
  entered number is boxes, not rounds; `_confirmAdjust` multiplies by
  `roundsPerBox` before calling `cacheApi.addAmmoQuantity`/
  `removeAmmoQuantity`, which always take a round count - the box unit is
  purely a frontend input convenience, the backend has no concept of it.
- Training Schedule's "Train with" section is a repeatable list
  (`ScheduleDraft.targets: TargetDraft[]`), not a single target - each row
  independently a firearm, firearm type, or ammo type, with a per-row
  Remove button (shown once there's more than one row) and a "+ Add
  another" button. This is what lets one schedule cover a multi-caliber AR
  upper (a 300 BLK row + a 5.56 row) or "train with either my AR or my
  shotgun." Matches the backend's `RangeSchedule.targets` list (see
  the backend's CLAUDE.md) - `training-schedule-view.ts` mirrors
  the backend's per-target `target_type`/`firearm_id`/`firearm_type`/
  `caliber`/`speed_class`/`bullet_type`/`rounds_min` shape exactly, one
  `TargetDraft` per `RangeScheduleTarget`. Each row's third selector ("Any
  ammo"/"Subsonic only"/"Supersonic only") and the free-text "Bullet type"
  input next to it (backed by a `<datalist>` of `knownBulletTypes()` -
  ammo already in the collection, no baseline seed list, matching
  `knownManufacturers()`'s convention since bullet types are too varied to
  enumerate) are that target's optional ammo filters - e.g. "train with my
  suppressed pistol, but only subsonic JHP." The row's "Min rounds" input
  is that target's own ammo-alert threshold - each target is checked
  independently, so a multi-target schedule can require e.g. "50+ rounds
  of 300 BLK AND 100+ rounds of 5.56" rather than either covering the
  other.
- Training Plans (`training-plan-view.ts`) are a separate tab and a
  separate backend entity from Training Schedules - an ORDERED, ROTATING
  list of steps where only one is "current" at a time (e.g. a 6-month
  rifle/shotgun rotation), not one standalone recurring goal. Matches the
  backend's `TrainingPlan`/`TrainingPlanStep` shape (see
  the backend's CLAUDE.md). `PlanDraft.steps: StepDraft[]` is a
  reorderable list (move up/down buttons per `.step-card`, not drag-and-
  drop) - each step is its own mini-form with the same repeatable
  `targets: TargetDraft[]` row UI as a Training Schedule, including each
  target's own speed-class/bullet-type filters and "Min rounds" ammo-alert
  threshold (duplicated locally in this file rather than shared, matching
  every other view's self-contained convention), plus a step-level
  `notes`. The mode picker ("Sequential, self-paced" vs. "Locked to
  calendar months") is chosen once at plan creation and drives which
  fields the form shows: calendar mode reveals a start month/year picker,
  sequential mode doesn't need one since progress is tracked by the
  backend's `current_step_index`, not a date. Calendar-mode plans label
  their steps "Month N" instead of "Step N" throughout the form and the
  card's "Show steps"/current-step display (`this._draft.mode ===
  "calendar"` / `p.mode === "calendar"` picks the unit word) - purely a
  display convention, the underlying `TrainingPlanStep` data and ordering
  are identical either way. "Mark Current Step Done" on each plan card
  calls `cacheApi.advanceTrainingPlan()` with today's date (`todayIso()`)
  - a self-paced shortcut for completing a step without logging a full
  Range Session; the card's due status, ammo alert, and "Step/Month X of
  Y" progress line always reflect the backend-computed current step
  (`plan.steps.find(s => s.isCurrent)`), never a locally-tracked index,
  since calendar-mode plans can advance purely from the passage of time
  with no user action.
- Settings' "Ammunition Alerts" card has a rules list below the global
  default threshold input (`AmmoAlertRule` - see the backend's
  CLAUDE.md for the three-tier priority: an ammo entry's own threshold,
  then the first matching rule, then the global default). Unlike the rest
  of the Settings view (which batches edits into a local `_draft` and
  requires a "Save Settings" click), rules mutate immediately on
  add/delete/threshold-edit via `cacheApi.addAmmoAlertRule()`/
  `deleteAmmoAlertRule()`/`updateAmmoAlertRule()` - matching how every
  other list-entity view (storage locations, training schedules, training
  plans) behaves, rather than the flat-settings-field save pattern. A
  rule's `matchType`/`matchValue` aren't editable in place (changing the
  match criteria is a delete-and-re-add, since the value input's shape
  depends on the type - text+datalist for caliber/bullet type, a fixed
  Subsonic/Supersonic select for velocity); only the threshold number has
  an inline edit (`@change` on that row's input).
- `Firearm.effectiveEstimatedValue` (both firearm-card and firearm-detail
  "Estimated Value" displays, and the value sort in `firearms-view.ts`)
  is a backend-computed field - the firearm's own value plus every
  installed part's value (see the backend's CLAUDE.md) - never
  read `currentEstimatedValue` for display. `currentEstimatedValue`
  itself still only ever appears in the Add/Edit Firearm form's own
  "Current Estimated Value" input - that one's the raw manual override,
  editing it doesn't touch what installed parts are worth.

- The firearm detail page's Estimated Value/Purchase Price stat buttons
  (see the `Firearm.effectiveEstimatedValue` bullet above) render Purchase
  Price first, Estimated Value second - Purchase Price is what was
  actually spent, Estimated Value is the more speculative of the two, so
  the more concrete number reads left-to-right first. Below both, a
  "Get AI Used-Value Estimate" button (`firearms-view.ts`'s
  `_estimateValue()`, `inventory-view.ts` has the identical thing for
  parts) calls the new `cacheApi.estimateUsedValue()` (`POST api/
  estimate_value`, see the backend's CLAUDE.md for the
  backend). This is a knowledge-based GUESS from OpenAI's training data,
  NOT live market data - this app has no web-browsing capability anywhere
  - so the result is always shown with that caveat and a low/high range
  plus a confidence word rather than a single confident number, and
  NEVER auto-applied: `UsedValueEstimate` (`types.ts`) is just displayed,
  and only a second, explicit "Apply to Estimated Value" click writes the
  range's midpoint into `current_estimated_value`/`estimated_value` via
  the existing `updateFirearm`/`updateInventoryItem` - same "review, then
  explicitly apply" convention as the ammo-scan fields
  (`_mergeScannedFields`) elsewhere in this app. Both estimated prices
  come back `null` (rendered as an explicit "couldn't estimate
  confidently" message, not a button-less dead end) when the model
  doesn't recognize the item, rather than a guessed number - the frontend
  never invents a number the backend didn't actually return.

## The shadow-DOM gotcha

`<cache-dialog>` only provides a `<slot>` - it does not style whatever gets
slotted into it. Each view that uses the dialog must define its own
form/button styles in its own `static styles`, since Lit/shadow DOM scopes
CSS to the component that defines it.

## My Build

`src/types.ts`'s `PART_TAXONOMY` (`Record<Category, Part[]>`, mirroring
the backend's `const.py` constant of the same name exactly) is
the taxonomy every part-related feature in this app reads from - 10
Categories (`INVENTORY_CATEGORIES`, derived via `Object.keys`), 18 Parts
(`PART_TYPES`, derived via flattening `Object.values`), plus a reverse
`CATEGORY_FOR_PART` lookup. Every `InventoryItem` stores both as real,
independent fields - `category` (coarse, e.g. "Optic") and `partType`
(specific, e.g. "Optic Mount") - the backend cross-validates that a given
pair actually belongs together (see the backend's CLAUDE.md),
this frontend just narrows the add/edit form's Part `<select>` to
`PART_TAXONOMY[category]` when Category changes
(`inventory-view.ts`) and resets `partType` to that list's first entry so
the two fields can never drift out of sync client-side. Every firearm's
My Build now shows the identical universal set of installable slots -
`PART_TYPES` itself - there's no more per-firearm-type slot list like the
old `DIAGRAM_SLOTS` had, and `<cache-attachment-bar>` no longer takes a
`diagramType` prop at all (it was only ever used to look up that
per-type list). `slot-modal.ts` (the dialog a card click opens) is scoped
to a whole Category (e.g. "Optic"), not a single Part - since
`<cache-attachment-bar>` only ever shows one clickable card per Category
(see below), clicking that card, regardless of which of the category's
Parts it happens to represent, opens the SAME modal, heading
`"${category} Slot"`, with a "Currently Installed" row for EVERY Part in
the category (both Optic and Optic Mount, each independently View/Remove-
able) rather than just the one that was clicked - an empty row shows just
the Part name and nothing else (no "Empty" label; an earlier pass had
one, it read as noisy repeated across every still-empty Part in a
multi-Part category). The `slotType` prop (set
from whichever card was clicked) only seeds `_focusedPart`, an internal
`@state` - search/install/remove/create-new all key off `_focusedPart`,
not `slotType` directly, and it can move freely between the category's
Parts without closing the modal: clicking a specific "Currently Installed"
row's View/Remove first focuses that row's Part, and the generic "Attach
Part" button (label is literally that, not the specific Part's name -
labeling it with a name read oddly once the modal itself was already
showing both Parts' rows) toggles focus to the OTHER Part in a two-Part
category. Because this is all internal state, no event needs to reach
`firearms-view.ts` to pivot within an already-open
modal - `installedBySlot` (the same map `installedBySlot()` builds
elsewhere) is now the prop passed in, not a single `installedItem`, so
the modal itself can look up every Part's status. The "+ Create New Part"
flow (renamed from "+ Add New Item" so it reads as creating a fresh
inventory record, not picking one from a list) gains its own Part
`<select>` when the category has more than one Part, defaulting to
`_focusedPart`, and sends both `category` and `part_type` to
`addInventoryItem` either way, since both are required fields now.

A Part is NOT exclusive - any number of items can share the same Part on
the same firearm at once (e.g. two Optics), matching the backend's
`async_install_item` (see the backend's CLAUDE.md). Because of
this, `installedBySlot()` (`utils/installed-items.ts`) maps each Part to
an ARRAY of `InstalledItemSummary`, not a single item, and both
`<cache-attachment-bar>` and `slot-modal` were built around that shape
from the start rather than retrofitted:
- `<cache-attachment-bar>` gives every individual item its own card - see
  its own doc comment and the CLAUDE.md paragraph below for the full
  stack layout. Nothing gets collapsed behind a count badge; an early
  version tried that (one card per Part, with a badge for extra items
  sharing it) and it was replaced once a slot could hold enough items
  that hiding them behind a number stopped being acceptable.
- `slot-modal`'s "Currently Installed" section lists every item in a
  Part's array as its own row (only the first row of a multi-item Part
  repeats the Part name label, so it isn't printed once per item), each
  with its own independent View/Remove. Removing targets one specific
  item by its own id (`_removeTarget: InstalledItemSummary | null`, set
  by that row's own Remove button) rather than "whatever's in this
  Part's slot" - that phrase stopped meaning anything once a Part could
  hold more than one item. `cacheApi.removeItem()`'s signature changed
  to match: `(hass, itemId, newStorageLocationId)`, not
  `(hass, firearmId, slotType, newStorageLocationId)`.
- Installing never evicts whatever else already occupies a Part, so the
  install-list button always reads "Install" now - the old
  "Replace"-when-something's-already-there wording is gone. The search
  list (`_items`) excludes every item currently in the focused Part's
  array (not just one), so an already-installed item never shows up
  twice as a candidate to install alongside itself.

A handful of pre-taxonomy categories were dropped outright rather than
folded into one of the 10 (Sling, Holster, Case, Cleaning Kit, Ammo Can,
Range Bag, Safe, Tool, and the old catch-all "Miscellaneous", now "Other
/ Miscellaneous" under Accessory) - existing items with one of those
values get migrated server-side on the backend's next storage load (see
the backend's CLAUDE.md's `storage.py` bullet), this frontend
never sees the old shape.

`src/components/attachment-bar.ts` (`<cache-attachment-bar>`) is a flat bar
of attachment-category cards (styled after Call of Duty's Gunsmith
screen) - one `.category-group` per `PART_TAXONOMY` entry (10 groups, see
`types.ts`), each with a single left-justified `.cat` header row (a small
`mdi:chevron-right` glyph precedes the label, matching the reference
screenshot's ">OPTIC" styling). `.attachment-bar` is a CSS grid with an
explicit `grid-template-columns: repeat(5, 150px)` - 10 categories lay out
5x2 by default regardless of how wide the surrounding container is
(`repeat(auto-fill, 150px)` was considered and rejected: the old
my-build-view.ts capped its container at `max-width: 1000px`, wide
enough to fit 6 columns via auto-fill, when 5 was the deliberate
default - that view is gone now, but the fixed 5-column grid is still
the current behavior wherever `<cache-attachment-bar>` is embedded).
`@media (max-width:
860px/560px/360px)` step the column count down to 3/2/1 as the viewport
narrows - these are plain viewport-width media queries, not container
queries (no `container-type` is set up on an ancestor), so a narrow
embedding context on a wide viewport (unlikely here, but notably possible
in firearms-view.ts's detail-card layout) wouldn't trigger them; matches
what was actually asked for ("smaller screen"), not "smaller container."
Every individual installed item gets its OWN card - nothing is ever
collapsed behind a count badge. A category (up to 2 Parts, each able to
hold any number of items - see the multi-install paragraph above) flattens
every `installedBySlot[part]` entry across its Parts into one ordered
list, and the card count follows directly from how many items that list
has:
- **0 entries** - a single empty placeholder card (`+`), keyed to the
  category's first Part for its click target. There's no on-card
  indication of which Part is empty when a category has two and both
  are - the card is plain either way, and which Part gets attached is
  chosen inside the `slot-modal` the click opens, not from anything
  bolted onto the card itself.
- **1 entry** - a single filled card, no stacking.
- **2+ entries** - a `.stack` of up to `MAX_STACK_CARDS` (4) card slots,
  laid out via `stackTransforms(n)` rather than hardcoded for a specific
  count (this used to be capped at 2 - one card per Part - back when a
  Part could only ever hold a single item; once a Part could hold
  several, that cap started hiding real attached items behind a count
  badge instead of showing them, which is why this was generalized). At
  rest, cards are piled with each successive one offset by `REST_STEP`
  (6px) further down-right and a lower `z-index`, so only the frontmost
  is fully visible - `REST_STEP` is deliberately small enough that even a
  full 4-card pile's total offset (`(MAX_STACK_CARDS-1) * REST_STEP` =
  18px) stays under `.attachment-bar`'s 20px grid gap, so the resting
  pile never bleeds into whichever category sits next to it. Hovering
  the group fans every card out into a fixed `FAN_COLS`-wide (2) grid -
  1 row for n=2, 2 rows for n=3/4 - instead of one ever-widening row;
  because the column count is pinned at 2 regardless of n, the fan-out's
  horizontal scale is CONSTANT (`scale(0.46)`, the original hand-tuned
  n=2 value: `69 + 12(gap) + 69 = 150`) for every stacked count this app
  actually produces (2-4), rather than shrinking further and reading
  worse as more items share a slot. This is also what keeps the
  fanned-out group's WIDTH pinned to the resting card's own 150px
  footprint no matter how many cards are in it - a single wide row
  (an earlier version of this) grew wider with every additional card and
  spilled into the neighboring category's column once a slot held 3+
  items. Vertically, 2 rows of scale-0.46 cards (87.4px each) plus one
  12px gap between them (186.8px total) fits inside the resting 190px
  height with room to spare, so hovering never grows the group taller
  than its own resting box either. `.stack:hover` also gets `z-index: 5`
  so the (still same-footprint, but now positioned) fan paints above
  later categories' cards rather than under them - without it, a
  category earlier in DOM order hovering its stack would visually sit
  BEHIND a later category's plain card, since non-positioned siblings
  paint in DOM order by default. `stackTransforms()` computes each
  card's shrink + grid position; a `MIN_CARD_W` floor still guards
  against the fan shrinking a card into unreadability, though with
  `FAN_COLS` fixed at 2 it can't actually be reached at this app's n
  range (2-4) - kept as a defensive fallback, not something currently
  exercised. Resting and hover values are computed per-card in JS and
  passed down as CSS custom properties (`--rx`/`--ry`/`--z`/`--hx`/
  `--hy`/`--hscale` on each `.attachment-card-wrap`'s inline `style`)
  rather than hardcoded `.front`/`.back` classes, since the geometry
  depends on how many cards are in the stack; `.stack .attachment-card-
  wrap` reads the resting ones by default and `.stack:hover
  .attachment-card-wrap` switches to the hover ones - these replace
  (don't compose with) the resting transform, and `transform-origin: top
  left` keeps the shrink anchored at each card's own top-left corner
  rather than jumping from its center.
- **More than `MAX_STACK_CARDS` entries** - only the first
  `MAX_STACK_CARDS - 1` (3) get their own item card; the 4th slot becomes
  an overflow card (`_renderOverflowCard`) reading "+N more" instead of a
  5th+ item card, using the SAME `stackTransforms(MAX_STACK_CARDS)` slot
  it would've occupied. This exists so an unusually full slot (e.g. five
  Optics) doesn't shrink every card in the stack toward unreadability
  trying to fit them all - 4 fixed-size slots is the ceiling regardless
  of how many items are actually attached. The overflow card still emits
  `cache-slot-click` on click (seeded from its first hidden entry's Part)
  and opens the same `slot-modal`, which lists every item regardless of
  which card opened it - nothing is truly hidden, just not given its own
  card in the bar itself.

`_renderItemCard(entry, transform)` (falling back to `_renderEmptyCard`
for the 0-entries case, or `_renderOverflowCard` for the trailing "+N
more" slot) is the shared card-body renderer behind most shapes -
`transform` is only passed for a stacked card, empty string style
otherwise. Each card body is square-cornered
(`border-radius: 2px`, not the rounded style used elsewhere in this app)
and shows, in priority order: the installed item's own photo
(`InstalledItemSummary.photoUrl`) if it has one; a `SLOT_ICONS`-mapped
glyph (falls back to `DEFAULT_SLOT_ICON`) for a filled card; or a plain
`mdi:plus` for the empty placeholder. The item's name (or "Empty") sits
below the art, separated by a thin top border. Every card - stacked or
solo - still emits `cache-slot-click` with a specific Part as `slotType`
(never the Category) when clicked, since two Parts sharing a Category
are still two independently installable slots.
`photoUrl` comes from `utils/installed-items.ts`'s
`installedBySlot(cacheState, firearmId)` - a shared helper both call
sites use to build the slot map fresh from the live
`cacheState.inventoryItems` list (each item's own `photos` array) rather
than `Firearm.installedItems` (a lightweight backend summary with no
photo data - see the backend's `states.py` (`_firearm_entity`),
still used for the section heading's `(N)` count, just not for what's
rendered underneath it). `.art img` sets `width: 100%; height: 100%;
object-fit: contain` rather than `max-width`/`max-height: 100%` - the
max-only version left the image's rendering box sized off its own
intrinsic dimensions in some cases, so a tall/narrow photo (e.g. two
choke tubes shot in portrait) could render larger than the card and get
visually clipped at the card edges despite `object-fit: contain`. Pinning
both dimensions to 100% first guarantees the img's box always exactly
matches `.art`'s box, so `contain` has a fixed frame to fit the photo
inside with no cropping, only letterboxing.

The bar itself doesn't open anything - clicking a card emits
`cache-slot-click` with `{ slotType }` and leaves opening `slot-modal` to
whichever view embeds it. `firearms-view.ts`'s firearm detail
page is the only call site now - it's what renders under the "Installed Parts"
heading (that heading text is unchanged - the list underneath it just
isn't a plain list anymore, it's the same card bar this app has always
used to show a firearm's attachments). `src/views/my-build-view.ts` used
to be a second call site (a full-screen hero-photo overlay with its own
route/nav entry) but was deleted outright - see "Removing My Build /
folding photos into Edit" below - so `<cache-attachment-bar>` no longer
needs to work in two different container contexts, just the one. This
whole layout replaced an earlier
hand-drawn wireframe-SVG diagram with draggable per-slot anchor points
(`build-diagrams.ts` + `cache-build-diagram.ts`, both deleted) - that
whole system existed to position labels *at a specific spot* on a
diagram, which stopped mattering once the design moved to a flat
unpositioned card bar, and repeated attempts to get an embedded/uploaded
reference photo's anchor points lined up right were a running source of
friction the flat-bar layout sidesteps entirely.

A firearm has no separate "hero" or "build" image field - there used to
be one (`Firearm.buildImageUrl`, its own dedicated upload endpoint and a
"Hero / Build Image" section in Edit Firearm), removed once that concept
stopped earning its keep: every gallery photo already runs through
background removal on upload (see the backend's CLAUDE.md), so
a second dedicated upload wasn't producing a different RESULT, just a
second thing that could disagree with the gallery. A firearm's hero photo
is now simply whichever gallery photo is marked primary
(`photo-manager-section.ts`'s star button sets `primaryPhotoId`) -
`utils/hero-image.ts`'s `firearmHeroImage(cacheState, firearm)` is the
shared 2-tier fallback every display site reads: `primary gallery photo
?? cacheState.settings.diagramReferenceImages[firearm.diagramType] ??
null`. Both call sites go through this one function rather than each
reimplementing the chain - `dashboard-view.ts`'s Wishlist panel
(`_wishlistImage()`, a one-line wrapper) and `firearms-view.ts`'s own
detail-page header photo (`.detail-photo`, `_renderDetail`'s local
`heroPhoto`). The firearm detail GRID card (`.firearm-image`, the
collection-browsing list, not the detail page) is deliberately NOT wired
through this helper - it stays gallery-photo-only, since a wall of
default per-type placeholder images across every still-unphotographed
firearm in the grid would read as more misleading than an empty state.
`diagramReferenceImages[diagramType]` (the per-type placeholder managed
from Settings' "Default Firearm Photos" card,
`cacheApi.uploadDiagramImage()`/`clearDiagramReferenceImage()`) is
otherwise unaffected by the hero-field removal - it's a separate feature
(a fallback for firearms with NO photo of their own at all), just now one
tier shorter since there's no `buildImageUrl` tier ahead of it anymore.
For a brand-new firearm, the Add form's staged photo upload
(`_addPhotoFiles`, see "Removing My Build / folding photos into Edit"
below) doesn't need a separate hero-staging step either - the first
photo uploaded to an empty gallery is automatically marked primary
server-side (`coordinator.async_add_photo`), so it becomes the hero with
zero extra frontend logic.

## Removing My Build / folding photos into Edit

A later pass removed the standalone My Build view/route entirely
(`src/views/my-build-view.ts` deleted, its nav entry and the firearm
detail page's "MY BUILD" button both gone) and folded photo management
into the Add/Edit Firearm and Add/Edit Item forms directly (the
"MANAGE PHOTOS" button and its dialog are gone too). `<cache-attachment-
bar>`/`slot-modal.ts` themselves are UNCHANGED by this - see "My Build"
above for how they work - only the extra full-screen view that used to
wrap them for a dedicated build page was removed; the same bar still
renders under the firearm detail page's "Installed Parts" heading, which
is now its only home.

- `photo-manager-dialog.ts` (its own `<cache-dialog>` wrapper, `open`
  prop, "Done" button) was replaced by `photo-manager-section.ts` - no
  dialog chrome of its own, just the photo grid + upload button, meant to
  be embedded inside a PARENT dialog. `firearms-view.ts`'s
  `_renderEditPhotosSection`/`inventory-view.ts`'s equivalent drop it
  straight into the existing Edit Firearm/Edit Item `cache-dialog` -
  photo management now has exactly one home instead of two. (Firearms'
  Edit form used to also have a separate "Hero / Build Image" section
  alongside this; that field was removed entirely in a later pass - see
  the hero-photo bullet above.)
- A brand-new record has no id until `_save()` creates it, so the Add
  form can't upload photos the normal way (every upload endpoint takes an
  existing `entityId`). Instead it STAGES `File[]` in component state -
  `_addPhotoFiles` in `firearms-view.ts`, the equivalent in
  `inventory-view.ts` - with zero network activity until the record is
  actually created. `_save()` then:
  1. calls `cacheApi.addFirearm`/`addInventoryItem`, which now return the
     new record's id (see the `supports_response` bullet below) instead
     of the previous `Promise<unknown>`;
  2. if anything was staged, uploads each staged photo sequentially
     against that id (not `Promise.all`, so a partial failure has a
     well-defined "how far did it get" point rather than a pile of
     interleaved in-flight requests) - the first one uploaded becomes
     primary/hero automatically, server-side, so there's no separate
     "which one's the hero" step here;
  3. on a staged-upload failure, sets a DIFFERENT error message ("record
     added, but a photo failed to upload... add it from Edit Firearm
     instead") and leaves the dialog open on the fields tab, rather than
     either silently discarding the failure or misreporting it as the
     record itself failing to save - the record already exists at that
     point, only the photo attempt failed. A `_savingPhotos` flag disables
     the Save button while the sequential upload loop is running so a
     second click can't fire a duplicate create.
- The backend's `add_firearm`/`add_inventory_item` services are the FIRST
  use of Home Assistant's `supports_response=SupportsResponse.OPTIONAL`
  pattern in this codebase (`hass.services.async_register(...,
  supports_response=...)` - see the backend's CLAUDE.md).
  `OPTIONAL`, not `ONLY`, so every existing fire-and-forget
  `hass.callService(...)` caller elsewhere in the app is unaffected -
  only a caller that explicitly asks for a response
  (`returnResponse: true`) gets one back. `ha-api.ts`'s `HomeAssistant.
  callService` signature was widened to accept `target`/`notifyOnError`/
  `returnResponse` (matching HA's real frontend signature, even though
  `target` is never used here - no service targets an entity_id/device_id
  this app controls) and to return `{ context?, response? } | undefined`
  instead of the previous `Promise<unknown>`. A new
  `callCacheServiceForResponse()` helper wraps the four extra
  positional args other call sites don't need; `cacheApi.addFirearm`/
  `addInventoryItem` are now `async`, awaiting it and returning
  `String(response?.firearm_id ?? "")`/the item-id equivalent - this is
  what lets the staged-upload flow above learn the new record's id
  within the same Add-form submission, without waiting on any
  entity/state round-trip to reveal it another way.
- Wishlist firearms also changed in this pass - High/Medium/Low priority
  replaced by a full drag-and-drop rank order - but that's different
  enough (its own component, its own backend field) to warrant its own
  writeup; see "Wishlist" below.

## Wishlist

A wishlist firearm/part is a normal `Firearm`/`InventoryItem` with
`isWishlist: true` - not a separate list, entity, or view. Both
`firearms-view.ts` and `inventory-view.ts` share the filter/detail-page
skeleton below, but firearms and parts use two DIFFERENT schemes for
expressing "how much do I want this" - see "Removing My Build / folding
photos into Edit" below for why they diverged in this pass:
- A 3-way `_wishlistFilter` (`"owned" | "wishlist" | "all"`, default
  `"owned"`) filters the grid/list, so existing collections look unchanged
  until the user actually adds a wishlist entry. Rendered as a `.segmented`
  three-button toggle (`styles.ts`'s shared primitive, order Owned/Both/
  Wishlist left-to-right - "Both" is the `"all"` state's label) rather
  than a `<select>`, since all three options are worth seeing at once for
  a filter this central. `.segmented` is a generic shared style, not
  specific to this filter - reach for it anywhere else a small,
  mutually-exclusive option set would otherwise be a dropdown.
- The add/edit form gets a "This is a wishlist item" checkbox on both.
  `inventory-view.ts` still pairs it with the original `WISHLIST_PRIORITIES`
  (High/Medium/Low) `<select>` that only renders while checked - unchecking
  it doesn't just hide the priority field, `draftToPayload`/`_save()`
  explicitly sends `wishlist_priority: ""` in that case too, so toggling
  wishlist off always clears a stale priority rather than leaving one
  orphaned on a now-owned record. `firearms-view.ts` no longer has a
  priority `<select>` at all - checking the box shows a small note
  pointing at the Wishlist toolbar's "Reorder Wishlist" button instead,
  since a firearm's rank is set entirely from
  `wishlist-reorder-dialog.ts`'s drag-and-drop list, never from this form
  (`FirearmDraft` sends `is_wishlist` only; the coordinator auto-assigns
  a `wishlist_rank` server-side on the `false`→`true` transition and
  auto-clears it on `true`→`false` - see the backend's
  CLAUDE.md).
- The detail page shows a `.badge.warning` chip and a "Mark as Purchased"
  button that only appears while `isWishlist` is true. For
  `inventory-view.ts` the chip reads "Wishlist · `<Priority>` Priority";
  for `firearms-view.ts` it reads "Wishlist · #`<rank+1>`" (1-based,
  omitted entirely if `wishlistRank` is still `null`) - both the detail
  page's chip and the grid card's chip use the same rank text. There's no
  dedicated conversion flow or backend service for "purchasing" either -
  it just opens a small Purchase Date/Purchase Price dialog and calls the
  existing `updateFirearm`/`updateInventoryItem` with `is_wishlist: false`
  plus whatever was entered (inventory items also explicitly send
  `wishlist_priority: ""`; firearms don't need to - `is_wishlist: false`
  alone is enough, the coordinator clears `wishlist_rank` automatically on
  that transition, it isn't a field this call sets directly) - flipping
  the flag on an existing record IS what "purchasing" a wishlist entry
  means here, no new item gets created, nothing gets deleted.
- `dashboard-view.ts`'s pooled "top wishlist item" (used by the Wishlist
  panel) picks from BOTH firearms and parts, but the two schemes aren't
  directly comparable (a rank position and a priority tier are different
  units) - `logic.dashboard_stats` on the backend resolves this with a
  two-tier fallback: a ranked wishlist firearm always wins if any wishlist
  firearms exist at all, falling back to the top-priority wishlist part
  only when there are none (see the backend's CLAUDE.md). The
  frontend's own `_topWishlistFirearm` getter in `dashboard-view.ts`
  mirrors the firearm half of this: primary sort key `wishlistRank ??
  Infinity` (nulls last), tiebroken by estimated value descending, with a
  `createdAt`-descending pre-sort as the final (stable-sort) fallback for
  anything still tied - since the Wishlist panel only ever features a
  firearm, never a part - see its own doc comment for why.
- `slot-modal.ts`'s remove-item dialog only requires picking a Storage
  Location when the item being removed is owned - a wishlist item was
  only ever installed to preview a build (see the backend's
  CLAUDE.md), so it has no physical location to return to and the field
  is optional for it (defaults to "None", clearing
  `InventoryItem.storageLocationId` on removal). `InstalledItemSummary`
  carries its own `isWishlist` for this - both `installedBySlot()`'s
  builder and `parseInstalledItem` (the lightweight per-firearm summary
  used for the "(N)" count) populate it from the underlying item/backend
  field. A wishlist item CAN still be given a real location on removal
  (e.g. it's about to be purchased) - the field is optional, not hidden.
- `wishlist-reorder-dialog.ts` (`<wishlist-reorder-dialog>`, opened from
  the Firearms toolbar's "Reorder Wishlist" button - only shown while
  `_wishlistFilter !== "owned"`, since reordering a filtered-out list
  would be confusing) is the entire UI for setting a firearm's rank -
  there's no per-firearm "set rank" control anywhere else. `willUpdate`
  re-sorts the passed-in wishlist firearms by existing `wishlistRank ??
  Infinity` into local `_order` state whenever `open` flips true, so a
  firearm wishlisted before this feature existed (rank still `null`)
  still lands somewhere sane instead of crashing the sort. Reordering
  uses the native HTML5 drag-and-drop API (`draggable="true"` +
  dragstart/dragover/drop on each row) rather than a library - one list,
  one axis, nothing that justified a dependency - but native DnD doesn't
  work on touch devices, so every row ALSO gets plain up/down chevron
  buttons (`_move(index, delta)`) as the only way to reorder at all on a
  phone/tablet, not just an accessibility nicety. Nothing is sent to the
  backend until "Save Order" - `_save()` calls
  `cacheApi.reorderWishlistFirearms(hass, this._order.map(f => f.id))`,
  which saves the COMPLETE new order in one call (rank = list position)
  rather than per-drag deltas, matching the coordinator's own atomic
  `async_reorder_wishlist_firearms` design (see the backend's
  CLAUDE.md) - simpler than insert-between/fractional-rank math, and it
  means a cancelled dialog (or one closed via the X) leaves the saved
  order completely untouched since `_order` was always just local state.

`dashboard-view.ts` is the "home screen" - SEVEN consolidated glass
surfaces instead of one-card-per-stat-field. Every value is still read
straight from `DashboardStats`/`CacheState` (already wishlist-excluded
server-side where relevant - see the backend's CLAUDE.md);
this redesign is entirely about grouping/presentation, not new data.
Nothing is fabricated - a metric this app doesn't actually track (a
separate "maintenance" concept distinct from cleaning, "storage
issues") is simply not shown, rather than invented.

1. **Armory Overview** (`.overview-grid`, 4 `_kpiCard()`s) - Firearms
   (`totalFirearms`, secondary `"N Standard · M NFA"` computed as
   `totalFirearms - nfaItems`, or just `"Standard"` when `nfaItems` is
   0), Ammunition (`totalAmmunition`, secondary caliber COUNT -
   `Object.keys(ammunitionByCaliber).length`, not a stat field of its
   own), Collection Value (`totalCollectionValue`, no fabricated parts/
   ammo $ breakdown since `DashboardStats` doesn't expose one), Wishlist
   (`wishlistTotalValue`, secondary `wishlistFirearmsCount`, optional
   tertiary `wishlistNfaItems` when nonzero).
2. **Collection Breakdown** - one panel, a `.segmented`-styled Type/
   Caliber/Manufacturer tab row (`_breakdownTab` state) swapping which
   `DashboardStats` record (`byType`/`byCaliber`/`byManufacturer`) feeds
   the shared `_bars()` helper, replacing three separate always-visible
   panels. Reuses the same `.segmented` component the Owned/Both/
   Wishlist filter already uses elsewhere, not a new tab-control.
3. **Armory Status** - every row opens exactly the records it counts:
   "Need Cleaning" opens Firearms filtered to `needsCleaning`, "NFA
   Firearms" opens Firearms filtered to `NFA_FIREARM_TYPES`, "Suppressors"
   opens Parts filtered to `partType === "Suppressor"` (owned only, all
   computed client-side). The backend's `nfaItems` total mixes SBR
   firearms with suppressor parts, which live on different pages, so the
   row is split in two - and the Firearms/Wishlist KPI cards' "NFA" counts
   use firearms only for the same reason. The filter rides on
   `cache-switch-tab`'s `filter` -> cache-panel's `_pendingFilter` -> the
   view's `initialFilter` prop -> a `_preset` state rendered as a
   removable `.filter-chip` (styles.ts); applying a preset resets that
   view's other filters to owned/no search so nothing hides what was
   counted. Picking a tab from the sidebar clears it. Original intent:
   answers "does anything need attention?", not
   another stats dump. `_statusMetric()` rows for `cleaningDueCount`
   ("Need Cleaning", clickable -> Firearms tab) and `trainingDueCount`
   ("Training Due", clickable -> Training Schedule tab) - collapsed into
   a single "All Systems Nominal" positive state when BOTH are zero,
   since neither NFA count nor "last range session" represent a
   problem and shouldn't gate that positive state. `nfaItems` renders
   as its own informational row regardless (not an "issue", just
   metadata worth surfacing) - clickable to Firearms too. A footer shows
   the most recent `rangeSessions[].date` (plain client-side max, no new
   backend field), or "No sessions logged" if there aren't any yet.
   Deliberately does NOT include a "maintenance due" or "storage issues"
   row - neither concept exists anywhere in this app's data model (only
   cleaning is tracked; storage locations have no "issue" flag), and
   inventing one would violate the same "don't fabricate telemetry" rule
   `cache-panel.ts`'s sidebar bullet already documents.
4. **Recent Activity** - a single chronological feed (`_activityFeed`
   getter) built from the raw collection: firearm adds (a wishlist firearm
   says "Added to wishlist" instead of "Added to collection"; when it's
   later marked purchased, the backend's `acquiredAt` adds a second
   "Added to collection" row at that moment - records converted before
   `acquired_at` existed have no such row), part adds (an owned part
   bought off the wishlist is dated by `acquiredAt`, not `createdAt`) and part installs (`InventoryItem.installedAt`,
   "Installed on <firearm>") for OWNED parts only - wishlist parts are
   skipped entirely, neither their add nor a planned-build install counts
   as collection activity (Jordan asked for that explicitly), storage
   locations added, cleanings (`CleaningLogEntry.cleanedDate`), ONE row
   per range session (total rounds + firearm count, location in the
   title - it used to be one row per firearm, which buried everything
   else), and ammo transactions NOT tagged with a `rangeSessionId`
   (`changeType === "range_session"` ones are the range session itself).
   Sorted newest day first; within a day, by `loggedAt` when the event's
   own date is date-only (a session's/cleaning's `createdAt`), else its
   timestamp - otherwise date-only events always sank below that day's
   timestamped ones. Each row carries an `open` callback: firearms/
   cleanings open the firearm, parts open the part (`cache-view-item`),
   locations/sessions/ammo switch to their tab. Shows the 10 newest rows
   (`ACTIVITY_COLLAPSED`); "Show more / Show less" expands in place to 20
   (`ACTIVITY_EXPANDED`), and anything older than that isn't shown at all
   (Jordan's spec) - there's no separate activity page.
5. **Most Used** - a top-3-to-5 RANKING (`_mostUsed` getter reads
   `DashboardStats.mostUsedIds`, already sorted desc server-side, then
   filters out zero-round entries UNLESS fewer than 3 firearms would be
   left, so a barely-used collection still shows something rather than
   an empty panel), not the full inventory list the old panel showed.
   Bars are proportional to the top entry's round count. No "View
   Usage" link - no dedicated usage/analytics page exists to send it to.
6. **Ammunition Status** - total rounds + caliber count header, then the
   same shared bar-row style as Collection Breakdown, one row per
   `ammunitionByCaliber` entry. A caliber's row gets a `.badge.warning`
   "Low" tag when ANY underlying `Ammunition` entry for that caliber has
   `isLow === true` (already computed server-side per-entry via
   `logic.is_ammo_low` - see the backend's CLAUDE.md) -
   `ammunitionByCaliber` is an AGGREGATE across possibly-multiple
   entries sharing a caliber name, so this checks the raw
   `cacheState.ammunition` list rather than inventing a caliber-level
   threshold that doesn't exist. Caliber name normalization (e.g. "12
   GA" vs. "12 Gauge" as the same real-world caliber) is intentionally
   NOT done here - the backend doesn't normalize caliber strings
   anywhere, so silently merging them client-side would show numbers
   that don't match what Ammunition/Firearms show elsewhere.
7. **Wishlist** - features the single top-ranked WISHLIST FIREARM
   (`_topWishlistFirearm` getter), not the backend's pooled `
   topWishlistItemName`/`topWishlistItemPriority` (which ranks firearms
   AND parts together - see the backend's CLAUDE.md's
   `dashboard_stats` bullet - and doesn't expose a photo or the actual
   record, only a name string). This panel needed the real `Firearm`
   object (for its image and to link somewhere meaningful), so it
   reimplements the firearm half of that ranking rule client-side, scoped
   to `cacheState.firearms.filter(f => f.isWishlist)`: primary sort key
   `wishlistRank ?? Infinity` (nulls last), tiebroken by
   `effectiveEstimatedValue` descending, with a `createdAt`-descending
   pre-sort as the final stable-sort fallback for anything still tied -
   see the "Wishlist" section above for the full writeup (this bullet
   used to describe an older priority-tier-based version of this sort,
   from before firearms got a drag-and-drop rank). Image is
   `utils/hero-image.ts`'s `firearmHeroImage()` - the firearm's primary
   gallery photo, falling back to a per-type Settings default, or a
   placeholder icon if neither applies. Below the featured firearm,
   `wishlistFirearmsCount`/`wishlistTotalValue` (still the backend's
   pooled totals, since those ARE meant to cover parts too) and a "View
   Wishlist" link that dispatches `cache-switch-tab` with `{ tab:
   "firearms", wishlist: true }` - see `cache-panel.ts`'s bullet above for
   how that reaches `cache-firearms-view`'s segmented filter.

Layout: `.overview-grid` is a plain `repeat(auto-fit, minmax(220px,
1fr))` (4 across on desktop, wraps naturally on narrower screens, no
extra breakpoints needed). The six panels below sit in ONE
`.dashboard-grid` (`grid-template-columns: minmax(0, 2fr) minmax(320px,
1fr)`, roughly 67/33), laid out via named `grid-template-areas`
(`"breakdown status" "activity rightstack" "ammo ammo"`) rather than
DOM-order auto-placement, with `align-items: start` - CSS Grid's
default (`stretch`) is exactly what a follow-up density pass had to
remove: Recent Activity and Most Used originally shared a plain
2-column grid ROW and got stretched to match each other's height even
though neither's own content needed it (Most Used, 3 items, was
ballooning to match Recent Activity's up-to-6-events height). `align-
items: start` means every panel now sizes to its own content, full
stop. Most Used and Wishlist share the right column as their OWN
nested `.right-stack` (a plain flex column, not a second grid row) so
THEY don't force each other's height either - a short Wishlist (no
image, empty state) doesn't stretch to match a taller Most Used or vice
versa. Ammunition Status spans the full width at the bottom (`"ammo
ammo"`) rather than pairing with Wishlist, since its per-caliber bars
benefit from the horizontal room. Stacks to one column below 900px
(area order becomes breakdown/status/activity/rightstack/ammo). Recent
Activity shows 6 events with tightened internal spacing and a "Show
more" footer toggle when more exist (see item 4 above); every row is
clickable, with a subtle hover background rather than a full card
treatment. Armory Status's header carries a small
`.status-pill` (a dot + "Nominal"/"Attention", `--hud-good` green or
`--secondary-color` amber, no glow) reflecting the same `cleaningDue
=== 0 && trainingDue === 0` check the body rows use - the body no
longer ALSO renders a separate "All Systems Nominal" banner when
nominal (redundant with the header pill and wastes vertical space);
when nominal it just shows the informational NFA/last-session rows
directly. `ha-card.panel` padding tightened from `18px 20px` to `16px
18px`, `.dashboard-grid`'s gap from `20px` to `14px`, matching a
general pass to tighten internal list-item spacing (activity/ranking/
bar rows) throughout - see this file's Theme section's SEVENTH pass
entry for the shared token-level changes (panel background alpha,
sheen gradient) from the same density pass. `cache-panel.ts`'s `main`
also gained `min-height: 0` - a real bugfix independent of this
dashboard's own layout, but one this pass's height auditing surfaced:
without it, `main`'s `flex: 1` (inside `.content-col`, itself a column
flex container) defaults to `min-height: auto`, which refuses to let
`main` shrink below its own content's natural height - so ANY tab
whose content exceeds the viewport grows the whole page instead of
`main`'s own `overflow-y: auto` scrolling internally, meaning the
sidebar/topbar would scroll away too instead of staying fixed. The
dashboard's empty-collection welcome message keys off `totalFirearms
=== 0 && wishlistFirearmsCount === 0 && wishlistItemsCount === 0`
rather than `totalFirearms === 0` alone, so a wishlist-only, no-owned-
anything collection doesn't incorrectly show "Add your first firearm."

## Build & dev

- `npm run build` = regenerate `src/shims/icons.ts`, `tsc --noEmit`, then
  `vite build` (with `base: "./"` so asset URLs stay relative under the
  ingress prefix). The add-on's Dockerfile runs this in its first stage;
  nothing is deployed from here directly.
- `index.html` styles only `html`/`body` and `cache-panel`'s height - never
  give `cache-panel` a `display` there: page-level rules beat a
  component's own `:host` rules, and `:host` is `display: flex` (a
  `display: block` there once stacked the content under the sidebar).
- `npm run dev` proxies `api/` and `uploads/` to a backend on
  `localhost:8099` started with `CACHE_ALLOW_ANY_CLIENT=1` (see the repo's
  top-level CLAUDE.md).
