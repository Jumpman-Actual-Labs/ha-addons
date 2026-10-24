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

/* Family Hustle's root: a Skylight-style rail with three tabs - Calendar
 * (the landing page), Chores (the whole Hustle panel, unchanged inside) and
 * Meals. Works out who's looking first: a linked member gets the app; an HA
 * admin on a household nobody can manage yet gets first-run setup; anyone
 * else is asked to get a parent to link their account. */

type Tab = "calendar" | "chores" | "meals";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "calendar", label: "Calendar", icon: "mdi:calendar-month" },
  { id: "chores", label: "Chores", icon: "mdi:broom" },
  { id: "meals", label: "Meals", icon: "mdi:silverware-fork-knife" },
];

const TAB_KEY = "family-hustle-tab";

@customElement("family-app")
export class FamilyApp extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) narrow = false;

  @state() private _tab: Tab = FamilyApp._savedTab();

  static styles = css`
    :host {
      display: flex;
      min-height: 100%;
      background: #f6f7f9;
      color: #2f3a4a;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    nav {
      width: 84px;
      flex: none;
      background: #fff;
      border-right: 1px solid #e6e9ee;
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
      color: #7b8796;
      cursor: pointer;
    }
    nav button.on {
      background: #eef6f5;
      color: #2f3a4a;
      font-weight: 650;
    }
    nav button:focus-visible {
      outline: 3px solid #7fc8c0;
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
      background: #fff;
      border: 1px solid #e6e9ee;
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
        border-top: 1px solid #e6e9ee;
        padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
        position: sticky;
        bottom: 0;
        top: auto;
        z-index: 30;
      }
      .logo {
        display: none;
      }
      main {
        padding: 14px 12px 24px;
      }
    }
  `;

  private static _savedTab(): Tab {
    try {
      const saved = window.localStorage.getItem(TAB_KEY);
      if (saved === "calendar" || saved === "chores" || saved === "meals") return saved;
    } catch {
      // Storage blocked - start on the calendar.
    }
    return "calendar";
  }

  private _select(tab: Tab): void {
    this._tab = tab;
    try {
      window.localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Not remembered this time - harmless.
    }
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

    return html`
      <nav aria-label="Family Hustle">
        <div class="logo" aria-hidden="true">${(state.householdName || "F").trim()[0]?.toUpperCase()}</div>
        ${TABS.map(
          (t) => html`<button class=${this._tab === t.id ? "on" : ""} aria-current=${this._tab === t.id ? "page" : "false"} @click=${() => this._select(t.id)}>
            <ha-icon icon=${t.icon}></ha-icon>${t.label}
          </button>`
        )}
      </nav>
      <main>
        ${this._tab === "calendar"
          ? html`<family-calendar-view .hass=${this.hass} .hustleState=${state} .extras=${extras} .me=${me}></family-calendar-view>`
          : nothing}
        ${this._tab === "chores" ? html`<hustle-panel .hass=${this.hass} .narrow=${this.narrow}></hustle-panel>` : nothing}
        ${this._tab === "meals"
          ? html`<family-meals-view .hass=${this.hass} .extras=${extras} .me=${me}></family-meals-view>`
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
