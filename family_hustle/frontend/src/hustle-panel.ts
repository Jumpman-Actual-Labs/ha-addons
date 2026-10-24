import { LitElement, css, html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "./ha-api";
import { parseHustleState } from "./ha-api";
import type { HustleState, MemberRosterEntry } from "./types";
import "./views/dashboard-view";
import "./views/chores-view";
import "./views/bounties-view";
import "./views/grades-view";
import "./views/behavior-view";
import "./views/settings-view";
import "./views/payroll-view";
import "./views/my-paycheck-view";
import "./views/reports-view";

type Tab =
  | "dashboard"
  | "chores"
  | "bounties"
  | "my-paycheck"
  | "grades"
  | "behavior"
  | "settings"
  | "payroll"
  | "reports";

interface TabDef {
  id: Tab;
  label: string;
  icon: string;
  parentOnly: boolean;
}

// Role-based visibility: children see Dashboard/Chores/Bounties/My Paycheck
// only; parents see every tab. This is a UX nicety, not a security boundary
// - services resolve the acting member from context.user_id server-side
// regardless of what the panel shows. Resolved via the member roster
// sensor's ha_user_id, matched against hass.user.id.
const TABS: TabDef[] = [
  { id: "dashboard", label: "Overview", icon: "mdi:view-dashboard", parentOnly: false },
  { id: "chores", label: "Chores", icon: "mdi:broom", parentOnly: false },
  { id: "bounties", label: "Bounties", icon: "mdi:target", parentOnly: false },
  { id: "my-paycheck", label: "My Paycheck", icon: "mdi:cash", parentOnly: false },
  { id: "grades", label: "Grades", icon: "mdi:school", parentOnly: true },
  { id: "behavior", label: "Behavior", icon: "mdi:star-outline", parentOnly: true },
  { id: "settings", label: "Settings", icon: "mdi:cog", parentOnly: true },
  { id: "payroll", label: "Payroll", icon: "mdi:cash-multiple", parentOnly: true },
  { id: "reports", label: "Reports", icon: "mdi:chart-bar", parentOnly: true },
];

@customElement("hustle-panel")
export class HustlePanel extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) narrow = false;

  @state() private _tab: Tab = "dashboard";
  @state() private _viewingAsMemberId = "";

  static styles = css`
    :host { --hustle-accent: #23765c; display:block; min-height:100%; color:var(--primary-text-color,#172334); }
    * { box-sizing:border-box; }
    header { padding:0 0 16px; max-width:1120px; margin:auto; display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
    .brand { display:flex; align-items:center; gap:12px; }
    .brand > ha-icon { box-sizing:content-box; padding:12px; border-radius:16px; background:#153d35; color:#e1f6a7; }
    h1 { margin:0; font-size:1.65rem; font-weight:800; letter-spacing:-.04em; }
    .subtitle { margin:3px 0 0; font-size:.85rem; color:var(--secondary-text-color,#637185); }
    nav { max-width:1120px; margin:4px auto 0; padding:0; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    button,select { font:inherit; }
    button.tab { display:flex; align-items:center; gap:7px; border:0; border-radius:12px; background:transparent; color:var(--secondary-text-color,#637185); padding:12px 16px; cursor:pointer; min-height:44px; }
    button.tab.active { background:var(--card-background-color,#fff); color:var(--primary-text-color,#173b2f); box-shadow:0 2px 8px #0000000d; font-weight:700; }
    button:focus-visible,select:focus-visible { outline:3px solid var(--primary-color,#137657); outline-offset:3px; }
    .parent-tools { margin-left:auto; display:flex; align-items:center; gap:8px; }
    select { padding:10px; border:1px solid var(--divider-color,#dce2e9); border-radius:10px; color:inherit; background:var(--card-background-color,#fff); min-height:44px; max-width:100%; }
    .viewing-as { margin-left:auto; display:flex; align-items:center; gap:10px; font-size:.9rem; }
    main { padding:24px 0 48px; max-width:1120px; margin:auto; }
    .preview-banner { max-width:1080px; margin:16px auto 0; padding:12px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; border-radius:12px; background:#e1f0e9; color:#153d35; }
    .preview-banner button { min-height:44px; padding:8px 14px; border:1px solid #90b2a4; border-radius:10px; background:white; color:#153d35; cursor:pointer; }
    nav.kid-nav { display:grid; grid-template-columns:repeat(3,1fr); max-width:760px; gap:8px; }
    .kid-nav button.tab { justify-content:center; min-height:56px; font-weight:650; }
    .kid-nav button.tab.active { background:#153d35; color:#fff; }
    @media(max-width:600px) { nav.kid-nav { position:sticky; top:0; z-index:5; background:var(--primary-background-color,#f4f6f5); padding:10px 12px; margin-top:0; } .kid-nav button.tab { flex-direction:column; gap:4px; font-size:.8rem; } .kid-nav button.tab ha-icon { display:block; --mdc-icon-size:20px; } }
    .notice { padding:24px; border-radius:16px; background:var(--card-background-color,#fff); line-height:1.6; }
    @media(max-width:600px) { header { padding:0 0 12px; } nav { gap:4px; margin-top:12px; } button.tab { padding:10px; font-size:.85rem; } button.tab ha-icon { display:none; } .parent-tools { width:100%; margin:4px 0 0; justify-content:space-between; } .viewing-as { width:100%; margin:0; justify-content:space-between; } main { padding:18px 0; } }
  `;

  private _hustleState(): HustleState {
    return parseHustleState(this.hass);
  }

  private _selectTab(tab: Tab): void {
    this._tab = tab;
  }

  /** Only active, linked members can use the panel. Services enforce authorization. */
  private _currentMember(state: HustleState): MemberRosterEntry | null {
    const userId = this.hass?.user?.id;
    if (!userId || state.memberRoster.length === 0) return null;
    return state.memberRoster.find((m) => m.haUserId === userId && m.active) ?? null;
  }

  /** The children a parent may pick from: their managedChildIds if set
   * (hard restriction - the whole point of that field), else every active
   * child in the household. */
  private _viewingAsOptions(state: HustleState, me: MemberRosterEntry | null): MemberRosterEntry[] {
    const activeChildren = state.memberRoster.filter((m) => m.role === "child" && m.active);
    if (me && me.managedChildIds.length > 0) {
      return activeChildren.filter((c) => me.managedChildIds.includes(c.id));
    }
    return activeChildren;
  }

  /** Child previews scope every child-facing view; empty selection is the parent. */
  private _effectiveMemberId(state: HustleState, me: MemberRosterEntry | null): string {
    if (me?.role === "child") return me.id;
    const options = this._viewingAsOptions(state, me);
    if (options.some((o) => o.id === this._viewingAsMemberId)) return this._viewingAsMemberId;
    return me?.id ?? "";
  }

  render() {
    if (!this.hass?.states) return html`<main><p role="status">Connecting to Home Assistant…</p></main>`;
    const state = this._hustleState();
    const me = this._currentMember(state);
    // family-app.ts only shows this tab to linked members.
    if (!me) return html``;
    const isParentAccount = me.role === "parent";
    const viewingAsOptions = isParentAccount ? this._viewingAsOptions(state, me) : [];
    const previewChild = viewingAsOptions.find(m => m.id === this._viewingAsMemberId);
    const isChild = !isParentAccount || Boolean(previewChild);
    const visibleTabs = TABS.filter((tab) => isChild ? ["dashboard", "bounties", "my-paycheck"].includes(tab.id) : true);
    if (isChild && !visibleTabs.some((tab) => tab.id === this._tab)) {
      this._tab = "dashboard";
    }
    const effectiveMemberId = this._effectiveMemberId(state, me);


    return html`
      <header>
        <div class="brand"><ha-icon icon="mdi:broom"></ha-icon><div><h1>Chores</h1><p class="subtitle">${state.householdName || "Your family"} · Chores & rewards</p></div></div>
        ${isParentAccount
          ? html`
              <div class="viewing-as">
                <label for="member-picker">Viewing</label>
                <select id="member-picker"
                  @change=${(e: Event) => { this._viewingAsMemberId = (e.target as HTMLSelectElement).value; this._tab = "dashboard"; }}
                >
                  <option value="" ?selected=${!previewChild}>Parent view</option>
                  ${viewingAsOptions.map(
                    (o) => html`<option value=${o.id} ?selected=${o.id === effectiveMemberId}>${o.haDisplayName}</option>`
                  )}
                </select>
              </div>
            `
          : ""}
      </header>
      ${previewChild ? html`<div class="preview-banner" role="status"><span>Viewing as <strong>${previewChild.haDisplayName}</strong> · Preview only</span><button @click=${() => { this._viewingAsMemberId = ""; this._tab = "dashboard"; }}>Back to Parent view</button></div>` : ""}
      <nav class=${isChild ? "kid-nav" : ""} aria-label="Hustle sections">
        ${visibleTabs.filter(t => !t.parentOnly).map(tab => html`<button class="tab ${this._tab === tab.id ? "active" : ""}" aria-current=${this._tab === tab.id ? "page" : "false"} @click=${() => this._selectTab(tab.id)}><ha-icon icon=${tab.icon}></ha-icon>${isChild && tab.id === "dashboard" ? "Today" : isChild && tab.id === "bounties" ? "Extra jobs" : isChild && tab.id === "my-paycheck" ? "My money" : tab.label}</button>`)}
        ${!isChild ? html`<div class="parent-tools"><label for="parent-tools">Parent tools</label><select id="parent-tools" .value=${TABS.find(t => t.id === this._tab)?.parentOnly ? this._tab : ""} @change=${(e: Event) => { const value = (e.target as HTMLSelectElement).value; if (value) this._selectTab(value as Tab); }}><option value="">Choose a section</option>${visibleTabs.filter(t => t.parentOnly).map(tab => html`<option value=${tab.id}>${tab.label}</option>`)}</select></div>` : ""}
      </nav>
      <main @hustle-navigate=${(e: CustomEvent<Tab>) => { if (visibleTabs.some(t => t.id === e.detail)) this._selectTab(e.detail); }}>
        ${keyed(`${me.id}:${effectiveMemberId}:${isChild}`, html`
        ${this._tab === "dashboard"
          ? html`<hustle-dashboard-view
              .readOnly=${Boolean(previewChild)}
              .hass=${this.hass}
              .hustleState=${state}
              .effectiveMemberId=${effectiveMemberId}
              .isParent=${!isChild}
              .visibleMemberIds=${viewingAsOptions.map((o) => o.id)}
            ></hustle-dashboard-view>`
          : ""}
        ${this._tab === "chores"
          ? html`<hustle-chores-view
              .hass=${this.hass}
              .hustleState=${state}
              .effectiveMemberId=${effectiveMemberId}
              .isParent=${!isChild}
              .assignableMemberIds=${viewingAsOptions.map((o) => o.id)}
              .readOnly=${Boolean(previewChild)}
            ></hustle-chores-view>`
          : ""}
        ${this._tab === "bounties"
          ? html`<hustle-bounties-view
              .readOnly=${Boolean(previewChild)}
              .hass=${this.hass}
              .hustleState=${state}
              .effectiveMemberId=${effectiveMemberId}
              .isParent=${!isChild}
              .visibleMemberIds=${viewingAsOptions.map((o) => o.id)}
            ></hustle-bounties-view>`
          : ""}
        ${this._tab === "my-paycheck"
          ? html`<hustle-my-paycheck-view .hass=${this.hass} .hustleState=${state} .effectiveMemberId=${effectiveMemberId}></hustle-my-paycheck-view>`
          : ""}
        ${this._tab === "grades"
          ? html`<hustle-grades-view .hass=${this.hass} .hustleState=${state}></hustle-grades-view>`
          : ""}
        ${this._tab === "behavior"
          ? html`<hustle-behavior-view .hass=${this.hass} .hustleState=${state}></hustle-behavior-view>`
          : ""}
        ${this._tab === "settings"
          ? html`<hustle-settings-view .hass=${this.hass} .hustleState=${state}></hustle-settings-view>`
          : ""}
        ${this._tab === "payroll"
          ? html`<hustle-payroll-view .hass=${this.hass} .hustleState=${state}></hustle-payroll-view>`
          : ""}
        ${this._tab === "reports"
          ? html`<hustle-reports-view .hass=${this.hass} .hustleState=${state}></hustle-reports-view>`
          : ""}
        `)}
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-panel": HustlePanel;
  }
}

