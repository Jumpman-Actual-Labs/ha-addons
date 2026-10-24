import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "./ha-api";
import { parseHustleState } from "./ha-api";
import { parseFamilyExtras } from "./family-api";
import type { MemberRosterEntry } from "./types";
import "./hustle-panel";
import "./views/calendar-view";
import "./views/meals-view";
import "./views/setup-view";
import "./views/shopping-view";

/* Family Hustle's root: a Skylight-style rail with four tabs - Calendar
 * (the landing page), Chores (the whole Hustle panel, unchanged inside),
 * Meals and Shopping. Works out who's looking first: a linked member gets
 * the app; an HA admin on a household nobody can manage yet gets first-run
 * setup; anyone else is asked to get a parent to link their account.
 *
 * Also owns the theme: light or dark, per device. "Auto" (the default)
 * follows Home Assistant's own dark mode - ingress serves this page in an
 * iframe on HA's origin, so the parent page's <home-assistant> element is
 * readable - falling back to the OS setting when opened on its own. */

type Tab = "calendar" | "chores" | "meals" | "shopping";
type ThemeMode = "auto" | "light" | "dark";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "calendar", label: "Calendar", icon: "mdi:calendar-month" },
  { id: "chores", label: "Chores", icon: "mdi:broom" },
  { id: "meals", label: "Meals", icon: "mdi:silverware-fork-knife" },
  { id: "shopping", label: "Shopping", icon: "mdi:cart-outline" },
];

const THEMES: Record<ThemeMode, { next: ThemeMode; label: string; icon: string }> = {
  auto: { next: "light", label: "Auto", icon: "mdi:theme-light-dark" },
  light: { next: "dark", label: "Light", icon: "mdi:weather-sunny" },
  dark: { next: "auto", label: "Dark", icon: "mdi:weather-night" },
};

const TAB_KEY = "family-hustle-tab";
const THEME_KEY = "family-hustle-theme";

function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage blocked - fall back to the default
  }
}

function save(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered this time - harmless.
  }
}

function haDarkMode(): boolean | undefined {
  try {
    const ha = window.parent?.document.querySelector("home-assistant") as
      | { hass?: { themes?: { darkMode?: unknown } } }
      | null;
    const darkMode = ha?.hass?.themes?.darkMode;
    return typeof darkMode === "boolean" ? darkMode : undefined;
  } catch {
    return undefined; // not embedded in HA, or a different origin
  }
}

@customElement("family-app")
export class FamilyApp extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) narrow = false;
  @property({ type: Boolean, reflect: true }) dark = false;

  @state() private _tab: Tab = FamilyApp._savedTab();
  @state() private _theme: ThemeMode = FamilyApp._savedTheme();

  private _darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  private _themeTimer?: number;
  private _applyTheme = (): void => {
    const dark =
      this._theme === "auto" ? (haDarkMode() ?? this._darkQuery.matches) : this._theme === "dark";
    this.dark = dark;
    // The page behind the app (and native form controls) match too.
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };

  static styles = css`
    /* Every color in the app comes from these. The Home Assistant variables
     * (--primary-background-color etc.) are what the Hustle views were
     * written against, so setting them here themes the Chores tab too -
     * custom properties inherit into every shadow root below. The --fh-*
     * ones are Family Hustle's own. */
    :host {
      --primary-background-color: #f6f7f9;
      --card-background-color: #ffffff;
      --primary-text-color: #2f3a4a;
      --secondary-text-color: #7b8796;
      --divider-color: #e6e9ee;
      --primary-color: #23765c;
      --fh-surface-2: #eef1f6;
      --fh-surface-3: #fafbfc;
      --fh-today-col: #fbfcfe;
      --fh-nav-on: #eef6f5;
      --fh-tint-base: #ffffff;
      --fh-event-ink: #2f3a4a;
      --fh-warn-bg: #fff7e8;
      --fh-warn-ink: #7a5212;
      --fh-error-bg: #fdecea;
      --fh-error-ink: #8a2a20;
      --fh-danger: #b3261e;
      --fh-danger-line: #f0c4bf;
      --fh-check: #7fc8c0;
      --fh-shadow: rgba(0, 0, 0, 0.08);
      display: flex;
      min-height: 100vh;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
      color-scheme: light;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    :host([dark]) {
      --primary-background-color: #12151a;
      --card-background-color: #1c2027;
      --primary-text-color: #e6e9ef;
      --secondary-text-color: #9aa4b2;
      --divider-color: #2d333d;
      --primary-color: #7fc8c0;
      --fh-surface-2: #262c35;
      --fh-surface-3: #171b21;
      --fh-today-col: #1f252d;
      --fh-nav-on: #24302f;
      --fh-tint-base: #1c2027;
      --fh-tint-boost: 1.35;
      --fh-event-ink: #eef1f5;
      --fh-warn-bg: #3a2f18;
      --fh-warn-ink: #f3d398;
      --fh-error-bg: #3d1f1d;
      --fh-error-ink: #f5b5ae;
      --fh-danger: #f28b82;
      --fh-danger-line: #5c2b27;
      --fh-check: #5fa8a0;
      --fh-shadow: rgba(0, 0, 0, 0.4);
      color-scheme: dark;
    }
    nav {
      width: 84px;
      flex: none;
      background: var(--card-background-color);
      border-right: 1px solid var(--divider-color);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 16px 0;
      position: sticky;
      top: 0;
      height: 100vh;
      box-sizing: border-box;
    }
    .logo {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: #7fc8c0;
      color: #fff;
      display: grid;
      place-items: center;
      font-family: Georgia, serif;
      font-weight: 700;
      font-size: 1.2rem;
      margin-bottom: 14px;
    }
    nav button {
      width: 68px;
      border: 0;
      background: transparent;
      border-radius: 14px;
      padding: 10px 0 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      font: inherit;
      font-size: 0.72rem;
      color: var(--secondary-text-color);
      cursor: pointer;
    }
    nav button.on {
      background: var(--fh-nav-on);
      color: var(--primary-text-color);
      font-weight: 650;
    }
    nav button:focus-visible {
      outline: 3px solid #7fc8c0;
    }
    nav .theme {
      margin-top: auto;
    }
    main {
      flex: 1;
      min-width: 0;
      padding: 22px 26px 40px;
      box-sizing: border-box;
    }
    .notice {
      max-width: 520px;
      margin: 10vh auto;
      background: var(--card-background-color);
      border: 1px solid var(--divider-color);
      border-radius: 20px;
      padding: 28px;
      line-height: 1.6;
    }
    .notice h1 {
      font-family: Georgia, serif;
      font-weight: 600;
      margin: 0 0 8px;
    }
    @media (max-width: 760px) {
      :host {
        flex-direction: column-reverse;
      }
      nav {
        width: 100%;
        height: auto;
        flex-direction: row;
        justify-content: space-around;
        border-right: 0;
        border-top: 1px solid var(--divider-color);
        padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        top: auto;
        z-index: 30;
      }
      nav button {
        width: 64px;
      }
      nav .theme {
        margin-top: 0;
      }
      .logo {
        display: none;
      }
      main {
        padding: 14px 12px calc(84px + env(safe-area-inset-bottom));
      }
    }
  `;

  private static _savedTab(): Tab {
    const saved = load(TAB_KEY);
    return TABS.some((t) => t.id === saved) ? (saved as Tab) : "calendar";
  }

  private static _savedTheme(): ThemeMode {
    const saved = load(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "auto";
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._applyTheme();
    this._darkQuery.addEventListener("change", this._applyTheme);
    // HA doesn't tell an iframe when its theme changes - a cheap re-check
    // keeps Auto in step when someone flips HA between light and dark.
    this._themeTimer = window.setInterval(this._applyTheme, 2000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._darkQuery.removeEventListener("change", this._applyTheme);
    window.clearInterval(this._themeTimer);
  }

  private _select(tab: Tab): void {
    this._tab = tab;
    save(TAB_KEY, tab);
  }

  private _cycleTheme(): void {
    this._theme = THEMES[this._theme].next;
    save(THEME_KEY, this._theme);
    this._applyTheme();
  }

  private _me(roster: MemberRosterEntry[]): MemberRosterEntry | null {
    const userId = this.hass.user?.id;
    if (!userId) return null;
    return roster.find((m) => m.haUserId === userId && m.active) ?? null;
  }

  render() {
    if (!this.hass?.states) return nothing;
    const state = parseHustleState(this.hass);
    const extras = parseFamilyExtras(this.hass);
    const me = this._me(state.memberRoster);

    if (!me) {
      const nobodyManages = !state.memberRoster.some(
        (m) => m.active && m.role === "parent" && m.permissionLevel === "admin"
      );
      if (nobodyManages && this.hass.user?.is_admin) {
        return html`<main><family-setup-view .hass=${this.hass} .householdName=${state.householdName ?? ""}></family-setup-view></main>`;
      }
      return html`<main><div class="notice">
        <h1>Link your account</h1>
        <p>A parent needs to add you to Family Hustle (Chores › Settings) and link your Home Assistant account before you can use it.</p>
      </div></main>`;
    }

    const theme = THEMES[this._theme];
    return html`
      <nav aria-label="Family Hustle">
        <div class="logo" aria-hidden="true">${(state.householdName || "F").trim()[0]?.toUpperCase()}</div>
        ${TABS.map(
          (t) => html`<button class=${this._tab === t.id ? "on" : ""} aria-current=${this._tab === t.id ? "page" : "false"} @click=${() => this._select(t.id)}>
            <ha-icon icon=${t.icon}></ha-icon>${t.label}
          </button>`
        )}
        <button class="theme" title="Theme: ${theme.label} (tap to change)" aria-label="Theme: ${theme.label}" @click=${this._cycleTheme}>
          <ha-icon icon=${theme.icon}></ha-icon>${theme.label}
        </button>
      </nav>
      <main>
        ${this._tab === "calendar"
          ? html`<family-calendar-view .hass=${this.hass} .hustleState=${state} .extras=${extras} .me=${me}></family-calendar-view>`
          : nothing}
        ${this._tab === "chores" ? html`<hustle-panel .hass=${this.hass} .narrow=${this.narrow}></hustle-panel>` : nothing}
        ${this._tab === "meals"
          ? html`<family-meals-view .hass=${this.hass} .extras=${extras} .me=${me}></family-meals-view>`
          : nothing}
        ${this._tab === "shopping"
          ? html`<family-shopping-view .hass=${this.hass} .extras=${extras} .me=${me}></family-shopping-view>`
          : nothing}
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "family-app": FamilyApp;
  }
}
