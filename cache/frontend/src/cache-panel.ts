import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "./ha-api";
import { parseCacheState } from "./ha-api";
import type { CacheState } from "./types";
import "./views/dashboard-view";
import "./views/firearms-view";
import "./views/inventory-view";
import "./views/ammunition-view";
import "./views/range-sessions-view";
import "./views/training-schedule-view";
import "./views/training-plan-view";
import "./views/storage-locations-view";
import "./views/settings-view";

type Tab =
  | "dashboard"
  | "firearms"
  | "inventory"
  | "ammunition"
  | "range-sessions"
  | "training-schedule"
  | "training-plan"
  | "storage-locations"
  | "settings";

interface TabDef {
  id: Tab;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: "dashboard", label: "Dashboard", icon: "mdi:view-dashboard" },
  { id: "firearms", label: "Firearms", icon: "mdi:target" },
  { id: "inventory", label: "Parts Inventory", icon: "mdi:toolbox" },
  { id: "ammunition", label: "Ammunition", icon: "mdi:ammunition" },
  { id: "range-sessions", label: "Range Sessions", icon: "mdi:calendar-check" },
  { id: "training-schedule", label: "Training Schedule", icon: "mdi:calendar-sync" },
  { id: "training-plan", label: "Training Plans", icon: "mdi:calendar-multiselect" },
  { id: "storage-locations", label: "Storage Locations", icon: "mdi:warehouse" },
  { id: "settings", label: "Settings", icon: "mdi:cog" },
];

@customElement("cache-panel")
export class CachePanel extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) narrow = false;

  @state() private _tab: Tab = "dashboard";
  @state() private _pendingFirearmId: string | null = null;
  @state() private _pendingItemId: string | null = null;
  @state() private _pendingWishlistFilter = false;

  /* Premium futuristic-OS glass theme - a "smoked-glass holoscreen"
   * material system, not a themed website. Defined once here and
   * cascaded everywhere: every view/component in this app was already
   * written against Home Assistant's own theme variables (`var(
   * --primary-color, <light-theme fallback>)`, `var(--card-background-
   * color, ...)`, etc.) rather than literal colors, specifically so a
   * theme could be swapped in from one place. Redefining those SAME
   * variable names here, on `:host`, means every descendant `var(--x,
   * fallback)` call - in this component's own shadow tree AND in every
   * nested view/dialog's shadow tree, since CSS custom properties
   * inherit straight through shadow boundaries the same way `color`/
   * `font-family` do - resolves to the theme palette instead of its
   * light-theme fallback, with zero changes needed in most other files.
   * Only components that hardcode literal hex instead of reading these
   * variables (attachment-bar.ts - a deliberately-always-dark surface
   * from before this reskin) needed their own hex values swapped by
   * hand; everything else - forms, buttons, badges, every ha-card-based
   * panel - picks this up automatically.
   *
   * This is the SEVENTH pass at this theme, iterated live against
   * feedback each time: green-phosphor CRT terminal → cyan/violet glass
   * HUD → pure black/white/gray → a desaturated gunmetal accent → a
   * vivid GLOWING arc-reactor cyan ("Iron Man/Stark tech") → a flat,
   * matte, glow-free monochrome match to a specific reference image →
   * **here**: an explicit, detailed brief for a "sophisticated
   * near-future armory management operating system running on smoked
   * glass displays" - dark/minimal/elegant/precise/glass-like/
   * futuristic/professional, explicitly NOT gritty/cyberpunk/neon-heavy/
   * blue-everywhere/video-game-like/busy/military-cliché. The pass-6
   * "no glow, flat monochrome, muted green for status only" direction
   * carries forward essentially unchanged - what's new is depth and
   * material quality: three distinct near-black background tones
   * instead of two (a deeper `--hud-bg` for the content area, `--hud-
   * bg-2` for the app shell/topbar, `--hud-sidebar-bg` for the sidebar -
   * previously the sidebar and topbar shared one flat tone), the
   * sidebar and topbar gained real translucency + backdrop blur instead
   * of a solid fill, and several NEW tokens exist purely so every glass
   * surface in the app (see `styles.ts`'s `glassCardStyle`/`formStyles`)
   * reads as ONE consistent material system rather than each component
   * picking its own blur/radius/hover values: `--hud-border-hover` (a
   * card's border on hover - distinct from `--hud-border-strong`, which
   * is for small chip/avatar outlines, not card interaction),
   * `--hud-radius`/`--hud-radius-sm` (card vs. control corner
   * rounding), and `--hud-blur` (the base glass blur amount cards read
   * against). Still no glow anywhere - depth here comes from real
   * translucency/blur/shadow layering, not light emission.
   *
   * Layout: `render()` below replaced the original horizontal `<header>`
   * tab strip with a fixed-width `<aside class="sidebar">` (logo block,
   * a vertical icon+label nav list, a "SYSTEM STATUS" footer card) plus
   * a slim top utility bar showing the REAL signed-in HA user's name
   * (`hass.user.name`) - not a fabricated callsign, and not decorative
   * search/notification icons, since neither has any real functionality
   * behind it in this app yet. There's deliberately no decorative
   * right-side "system telemetry" panel (vault temperature, humidity,
   * GPS, etc.) - none of that data exists anywhere in this app's domain
   * model, and fabricating live-looking sensor readouts would read as
   * real telemetry when it's actually invented, which is worse than
   * just not having the panel. */
  static styles = css`
    :host {
      display: flex;
      height: 100%;
      position: relative;
      overflow: hidden;
      /* Three distinct near-black tones (deepest to lightest) instead of
         a flat two-tone split - content area, app shell, sidebar each
         read as a slightly different depth layer rather than one flat
         background. Still overwhelmingly neutral black/charcoal, no
         blue cast. */
      --hud-bg: #050607;
      --hud-bg-2: #08090b;
      --hud-sidebar-bg: #101114;
      /* The glass fill every card/dialog/control is built from - dark
         charcoal, genuinely translucent (not "nearly solid"), so
         backdrop-filter blur has real material to show through. */
      --hud-panel-bg: rgba(22, 24, 27, 0.4);
      --hud-white: #f2f4f6;
      --hud-white-dim: #a3adb6;
      --hud-mute: #6b7078;
      /* The one hue that isn't the neutral accent or semantic warning/
         error - reserved strictly for "everything's fine" status text
         (the sidebar's SYSTEM STATUS card, badges elsewhere reading
         "operational"/"secure"/etc.). */
      --hud-good: #7bc98f;
      /* The interactive accent is plain white/light-gray, not a hue.
         No glow anywhere in this theme - depth comes from translucency/
         blur/shadow layering instead. */
      --hud-accent: var(--hud-white);
      --hud-border: rgba(255, 255, 255, 0.1);
      /* Small chip/avatar/logo-mark outlines (NOT card hover - see
         --hud-border-hover below). */
      --hud-border-strong: rgba(255, 255, 255, 0.22);
      /* A glass card's border on hover - one step up from --hud-border,
         short of --hud-border-strong, so an interactive card visibly
         responds without reading as a hard outline. */
      --hud-border-hover: rgba(255, 255, 255, 0.16);
      /* Shared corner rounding - cards vs. smaller controls (inputs,
         buttons, filter pills). Dialogs stay their own literal 14px,
         distinct enough from both to read as a deliberately larger
         surface. */
      --hud-radius: 10px;
      --hud-radius-sm: 8px;
      /* The base glass blur every card/control reads against;
         larger surfaces (dialogs) use a proportionally larger literal
         blur rather than this token. */
      --hud-blur: 18px;
      --hud-amber: #e8b34c;
      --hud-red: #e5484d;
      /* Wishlist's own hue - distinct from --hud-amber (still used for
         low-ammo/"installed elsewhere" warnings) so a wishlist badge/card
         tint doesn't visually collide with an unrelated warning state on
         the same card. */
      --hud-purple: #a78bfa;
      --hud-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

      --primary-color: var(--hud-accent);
      --secondary-color: var(--hud-amber);
      --primary-background-color: var(--hud-bg);
      --secondary-background-color: var(--hud-bg-2);
      --card-background-color: var(--hud-panel-bg);
      --app-header-background-color: var(--hud-bg-2);
      --primary-text-color: var(--hud-white);
      --secondary-text-color: var(--hud-white-dim);
      --divider-color: var(--hud-border);
      --text-primary-color: #0a0a0b;
      --error-color: var(--hud-red);

      background: var(--hud-bg);
      color: var(--hud-white);
      font-family: var(--hud-font);
    }
    /* A soft, colorless ambient highlight - not decoration for its own
       sake, but what makes the glass cards elsewhere actually READ as
       glass: a frosted, semi-transparent panel over a perfectly flat
       background is visually identical to an opaque one, since blur has
       nothing to refract. This gives every backdrop-filter blur surface
       something to catch. */
    :host::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background: radial-gradient(ellipse 900px 560px at 22% -8%, rgba(255, 255, 255, 0.05), transparent 60%);
    }
    /* A faint film-grain texture, tiled across the ENTIRE host bounds
       (unlike the radial highlight above, which only lights up the
       top-left) - main scrolls its own content independently of this
       fixed backdrop, so a card near the bottom of a long list needs
       texture directly behind it too, not just a gradient that fades
       out past the first screenful. Kept deliberately subtle (5% via
       mix-blend-mode: overlay, not a flat opaque pattern) and grain-
       shaped rather than a repeating grid/scanline - the latter reads
       as a retro CRT terminal almost immediately regardless of color
       (see this file's Theme history), grain doesn't. */
    :host::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      opacity: 0.05;
      mix-blend-mode: overlay;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-repeat: repeat;
    }
    /* A translucent glass panel, not a flat fill - sits above the
       :host::before/::after ambient highlight + grain (z-index 2 vs 0)
       so the blur has the same material to read against as every other
       glass surface in the app. */
    .sidebar {
      width: 220px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      background: color-mix(in srgb, var(--hud-sidebar-bg) 88%, transparent);
      backdrop-filter: blur(24px) saturate(120%);
      -webkit-backdrop-filter: blur(24px) saturate(120%);
      border-right: 1px solid var(--hud-border);
      position: relative;
      z-index: 2;
      height: 100%;
      box-sizing: border-box;
      overflow-y: auto;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 20px 16px;
    }
    .logo-mark {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--hud-white) 8%, transparent);
      border: 1px solid var(--hud-border-strong);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .logo-mark ha-icon {
      --mdc-icon-size: 20px;
      color: var(--hud-white);
    }
    .logo-text {
      font-size: 0.95rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      line-height: 1.25;
      color: var(--hud-white);
    }
    nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px 12px;
      flex: 1;
    }
    button.nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      background: none;
      border: none;
      border-radius: 8px;
      color: var(--hud-mute);
      font-family: inherit;
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 10px 12px;
      cursor: pointer;
      text-align: left;
      white-space: nowrap;
      transition: color 0.15s ease, background 0.15s ease;
    }
    button.nav-item ha-icon {
      --mdc-icon-size: 18px;
      flex-shrink: 0;
    }
    button.nav-item:hover {
      color: var(--hud-white-dim);
      background: color-mix(in srgb, var(--hud-white) 5%, transparent);
    }
    /* "Slightly lighter glass panel" for the selected nav item, plus a
       thin edge highlight (not a hard outline) - restrained, no strong
       color. */
    button.nav-item.active {
      color: var(--hud-white);
      background: color-mix(in srgb, var(--hud-white) 9%, transparent);
      box-shadow: inset 0 0 0 1px var(--hud-border);
    }
    .status-card {
      margin: 12px;
      padding: 12px 14px;
      border-radius: var(--hud-radius-sm);
      border: 1px solid var(--hud-border);
      background: color-mix(in srgb, var(--hud-bg) 75%, transparent);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .status-card .label {
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--hud-mute);
      margin-bottom: 4px;
    }
    .status-card .value {
      font-size: 0.85rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--hud-good);
    }
    .content-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      position: relative;
      z-index: 2;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      padding: 10px 20px;
      border-bottom: 1px solid var(--hud-border);
      background: color-mix(in srgb, var(--hud-bg-2) 82%, transparent);
      backdrop-filter: blur(20px) saturate(120%);
      -webkit-backdrop-filter: blur(20px) saturate(120%);
    }
    .operator {
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--hud-white-dim);
      text-align: right;
      line-height: 1.3;
    }
    .operator .name {
      color: var(--hud-white);
    }
    .avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--hud-white) 10%, transparent);
      border: 1px solid var(--hud-border-strong);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--hud-accent);
      font-size: 0.8rem;
      font-weight: 700;
      flex-shrink: 0;
    }
    /* Generous enough that a large/ultrawide desktop display doesn't read
       as a narrow web page floating in the middle of the screen - still
       capped so line lengths/card widths stay reasonable on the very
       widest monitors, just a much higher cap than before. */
    /* min-height: 0 is the actual fix for internal scroll containment -
       .content-col (main's parent, a column flex container) stretches
       to a definite height fine via the outer :host row container's
       default align-items: stretch, but main's own flex: 1 (flex-basis:
       0%) still defaults to min-height: auto, which refuses to let it
       shrink below its OWN content's natural height. Without this, tab
       content taller than the viewport grows main (and therefore the
       whole page) instead of scrolling internally within it, so the
       sidebar/topbar scroll away too instead of staying fixed. */
    main {
      padding: 20px 24px;
      max-width: 1680px;
      margin: 0 auto;
      width: 100%;
      box-sizing: border-box;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    /* Icon-only sidebar below 700px - a fixed 220px rail plus a
       min-content main area doesn't fit a phone screen, and a full
       collapsible-drawer treatment is more than this pass needs; hiding
       labels keeps every tab still reachable by icon without the rail
       eating most of the viewport. */
    @media (max-width: 700px) {
      .sidebar {
        width: 64px;
      }
      .logo {
        padding: 16px 8px;
        justify-content: center;
      }
      .logo-text,
      button.nav-item span,
      .status-card,
      .operator {
        display: none;
      }
      button.nav-item {
        justify-content: center;
        padding: 10px 8px;
      }
    }
  `;

  private _selectTab(tab: Tab): void {
    this._tab = tab;
    this._pendingFirearmId = null;
    this._pendingItemId = null;
    this._pendingWishlistFilter = false;
  }

  /** Lets other views (e.g. a range session card, an inventory item's
   * "installed on" link) jump straight to a firearm's detail view on the
   * Firearms tab without the tab needing to expose its internal state. */
  private _handleOpenFirearm(e: Event): void {
    const firearmId = (e as CustomEvent<{ firearmId: string }>).detail.firearmId;
    this._pendingFirearmId = firearmId;
    this._tab = "firearms";
  }

  /** Same idea for jumping to an inventory item's detail from a build
   * slot's "View" button. */
  private _handleViewItem(e: Event): void {
    const itemId = (e as CustomEvent<{ itemId: string }>).detail.itemId;
    this._pendingItemId = itemId;
    this._tab = "inventory";
  }

  /** Plain tab-switch requests with no specific record to jump to - e.g.
   * dashboard-view.ts's "View All"/status links. An optional `wishlist`
   * flag (only meaningful when `tab` is "firearms") additionally presets
   * that view's Owned/Both/Wishlist filter to "wishlist" - dashboard-
   * view.ts's Wishlist panel uses this for its "View Wishlist" link. Sets
   * `_tab` directly rather than routing through `_selectTab` (which
   * would immediately clear the pending flag this handler just set) -
   * same reasoning as `_handleOpenFirearm`/`_handleViewItem` below. */
  private _handleSwitchTab(e: Event): void {
    const detail = (e as CustomEvent<{ tab: string; wishlist?: boolean }>).detail;
    if (!TABS.some((t) => t.id === detail.tab)) return;
    this._pendingFirearmId = null;
    this._pendingItemId = null;
    this._pendingWishlistFilter = detail.wishlist ?? false;
    this._tab = detail.tab as Tab;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("cache-open-firearm", this._handleOpenFirearm as EventListener);
    this.addEventListener("cache-view-item", this._handleViewItem as EventListener);
    this.addEventListener("cache-switch-tab", this._handleSwitchTab as EventListener);
  }

  disconnectedCallback(): void {
    this.removeEventListener("cache-open-firearm", this._handleOpenFirearm as EventListener);
    this.removeEventListener("cache-view-item", this._handleViewItem as EventListener);
    this.removeEventListener("cache-switch-tab", this._handleSwitchTab as EventListener);
    super.disconnectedCallback();
  }

  render() {
    const state: CacheState = parseCacheState(this.hass);
    const userName = this.hass?.user?.name ?? null;

    return html`
      <aside class="sidebar">
        <div class="logo">
          <div class="logo-mark"><ha-icon icon="mdi:safe"></ha-icon></div>
          <div class="logo-text">${state.settings?.collectionName ?? "Cache"}</div>
        </div>
        <nav>
          ${TABS.map(
            (tab) => html`
              <button
                class="nav-item ${this._tab === tab.id ? "active" : ""}"
                @click=${() => this._selectTab(tab.id)}
              >
                <ha-icon icon=${tab.icon}></ha-icon>
                <span>${tab.label}</span>
              </button>
            `
          )}
        </nav>
        <div class="status-card">
          <div class="label">System Status</div>
          <div class="value">Operational</div>
        </div>
      </aside>
      <div class="content-col">
        <div class="topbar">
          ${userName
            ? html`
                <div class="operator">
                  <div>Signed in as</div>
                  <div class="name">${userName}</div>
                </div>
                <div class="avatar">${userName.charAt(0).toUpperCase()}</div>
              `
            : ""}
        </div>
        <main>
        ${this._tab === "dashboard"
          ? html`<cache-dashboard-view .hass=${this.hass} .cacheState=${state}></cache-dashboard-view>`
          : ""}
        ${this._tab === "firearms"
          ? html`<cache-firearms-view
              .hass=${this.hass}
              .cacheState=${state}
              .initialFirearmId=${this._pendingFirearmId}
              .initialWishlistFilter=${this._pendingWishlistFilter}
            ></cache-firearms-view>`
          : ""}
        ${this._tab === "inventory"
          ? html`<cache-inventory-view
              .hass=${this.hass}
              .cacheState=${state}
              .initialItemId=${this._pendingItemId}
            ></cache-inventory-view>`
          : ""}
        ${this._tab === "ammunition"
          ? html`<cache-ammunition-view .hass=${this.hass} .cacheState=${state}></cache-ammunition-view>`
          : ""}
        ${this._tab === "range-sessions"
          ? html`<cache-range-sessions-view
              .hass=${this.hass}
              .cacheState=${state}
            ></cache-range-sessions-view>`
          : ""}
        ${this._tab === "training-schedule"
          ? html`<cache-training-schedule-view
              .hass=${this.hass}
              .cacheState=${state}
            ></cache-training-schedule-view>`
          : ""}
        ${this._tab === "training-plan"
          ? html`<cache-training-plan-view
              .hass=${this.hass}
              .cacheState=${state}
            ></cache-training-plan-view>`
          : ""}
        ${this._tab === "storage-locations"
          ? html`<cache-storage-locations-view
              .hass=${this.hass}
              .cacheState=${state}
            ></cache-storage-locations-view>`
          : ""}
        ${this._tab === "settings"
          ? html`<cache-settings-view .hass=${this.hass} .cacheState=${state}></cache-settings-view>`
          : ""}
        </main>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-panel": CachePanel;
  }
}
