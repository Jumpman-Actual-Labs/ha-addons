import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "./ha-api";
import { parseFinanceState } from "./ha-api";
import type { FinanceState } from "./types";
import "./views/dashboard-view";
import "./views/members-view";
import "./views/bills-view";
import "./views/savings-view";
import "./views/income-view";
import "./views/settings-view";

type Tab = "dashboard" | "bills" | "budgets" | "savings" | "household" | "settings";
type Navigation = { tab: Tab; householdTab?: "members" | "income" };

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "dashboard", label: "Overview", icon: "mdi:view-dashboard" },
  { id: "bills", label: "Bills", icon: "mdi:receipt-text" },
  { id: "budgets", label: "Budgets", icon: "mdi:chart-box-outline" },
  { id: "savings", label: "Savings", icon: "mdi:piggy-bank" },
  { id: "household", label: "Household", icon: "mdi:account-group" },
  { id: "settings", label: "Settings", icon: "mdi:cog" },
];

@customElement("finance-panel")
export class FinancePanel extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) narrow = false;

  @state() private _tab: Tab = "dashboard";
  @state() private _householdTab: "members" | "income" = "members";

  static styles = css`
    :host {
      display: block; height: 100%; overflow: auto;
      --primary-color: #8bb5ff;
      --text-primary-color: #101c30;
      --primary-background-color: #0f151f;
      --card-background-color: #1a2433;
      --secondary-background-color: #253247;
      --primary-text-color: #eef2f9;
      --secondary-text-color: #a5b3c8;
      --divider-color: #2b394d;
      --stash-success: #75d4b2;
      --stash-danger: #f19898;
      --stash-warning: #e8c37c;
      --stash-success-bg: #203b38;
      --stash-danger-bg: #3d2932;
      --stash-selected: #283e5d;
      --stash-cushion-bg: #1a2d35;
      --stash-navy: #172a40;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px; line-height: 1.5;
    }
    * { box-sizing: border-box; }
    .subnav { display: flex; gap: 8px; margin-bottom: 20px; }
    .subnav button { font: inherit; border: 1px solid var(--divider-color, #ddd); border-radius: 8px; padding: 10px 18px; cursor: pointer; background: var(--card-background-color, #fff); color: var(--primary-text-color, #172d32); }
    .subnav button[aria-pressed="true"] { border-color: var(--primary-color); color: var(--primary-color); font-weight: 650; }
    .shell { display: grid; grid-template-columns: 196px minmax(0, 1fr); min-height: 100%; }
    header { position: sticky; top: 0; height: 100vh; height: 100dvh; align-self: start; background: var(--card-background-color, #fff); border-right: 1px solid var(--divider-color, #e3e9ed); z-index: 10; }
    .header-inner { padding: 32px 16px; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 0 10px 34px; }
    .brand-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: #102c36; color: #fff; --mdc-icon-size: 21px; }
    h1 { margin: 0; font-size: 1.5rem; font-weight: 750; letter-spacing: -0.055em; }
    .brand small { display: block; color: var(--secondary-text-color, #6b7d86); font-size: 0.65rem; }
    nav { display: flex; flex-direction: column; gap: 6px; }
    button.tab { display: flex; align-items: center; gap: 12px; width: 100%; padding: 13px 14px; border: 0; border-radius: 9px; background: transparent; color: var(--secondary-text-color, #6b7d86); font: inherit; font-size: 0.85rem; cursor: pointer; text-align: left; }
    button.tab.active { color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 10%, transparent); font-weight: 650; }
    button.tab:hover { background: color-mix(in srgb, var(--primary-color) 7%, transparent); }
    button.tab:last-child { margin-top: 24px; }
    button.tab ha-icon { --mdc-icon-size: 20px; }
    button:focus-visible { outline: 3px solid var(--primary-color); outline-offset: 2px; }
    main { width: 100%; max-width: 1240px; padding: 36px 40px 56px; margin: 0 auto; min-width: 0; }
    .page-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
    h2 { font-size: 1.7rem; line-height: 1.2; letter-spacing: -0.045em; margin: 0; font-weight: 650; }
    .page-heading p { font-size: 0.82rem; color: var(--secondary-text-color, #6b7d86); margin: 8px 0 0; }
    .mode { font-size: 0.72rem; border: 1px solid var(--divider-color, #dde5e8); padding: 7px 12px; border-radius: 7px; white-space: nowrap; background: var(--card-background-color, #fff); }
    @media (max-width: 1000px) { main { padding: 28px 22px; } .shell { grid-template-columns: 176px minmax(0, 1fr); } .header-inner { padding: 28px 10px; } }
    @media (max-width: 760px) {
      .shell { display: block; }
      header { height: auto; border-right: 0; border-bottom: 1px solid var(--divider-color, #e3e9ed); }
      .header-inner { padding: 12px 10px 8px; }
      .brand { padding: 0 5px 10px; gap: 8px; }
      .brand-icon { width: 28px; height: 28px; border-radius: 8px; --mdc-icon-size: 18px; }
      h1 { font-size: 1.2rem; } .brand small { display: none; }
      nav { flex-direction: row; gap: 2px; }
      button.tab { justify-content: center; flex-direction: column; flex: 1; gap: 4px; padding: 8px 1px; font-size: 0.65rem; min-width: 0; }
      button.tab:last-child { margin-top: 0; }
      main { padding: 24px 14px 36px; }
      .page-heading { align-items: flex-start; margin-bottom: 20px; }
      h2 { font-size: 1.4rem; }
      .mode { padding: 5px 8px; font-size: 0.65rem; }
    }

    .titlebar { display:flex; justify-content:space-between; align-items:center; height:68px; padding:0 26px; background:var(--card-background-color); border-bottom:1px solid var(--divider-color); position:sticky; top:0; z-index:20; }
    .titlebar .brand { padding:0; gap:10px; }
    .titlebar h1 { font-size:1.55rem; letter-spacing:-.06em; } .titlebar h1 span { color:var(--primary-color); }
    .brand-icon { background:var(--stash-selected); color:var(--primary-color); border-radius:10px; width:32px; height:32px; }
    .titlebar .mode { border-radius:30px; padding:7px 14px; color:var(--secondary-text-color); font-size:.72rem; display:flex; align-items:center; gap:8px; }
    .titlebar .mode ha-icon { --mdc-icon-size:18px; }
    .shell { grid-template-columns:104px minmax(0, 1fr); min-height:calc(100% - 68px); }
    header { top:68px; height:calc(100dvh - 68px); }
    .header-inner { padding:18px 10px; }
    button.tab { flex-direction:column; text-align:center; gap:8px; padding:16px 4px; font-size:.7rem; border-radius:12px; }
    button.tab.active { background:var(--stash-selected); }
    button.tab:last-child { margin-top:20px; }
    main { max-width:1160px; padding:38px 36px 56px; }
    .page-heading.dashboard-heading { display:none; }
    @media(max-width:760px) {
      .titlebar { height:58px; padding:0 16px; }
      .titlebar .brand { padding:0; }
      .titlebar h1 { font-size:1.35rem; }
      .titlebar .mode { font-size:.65rem; padding:5px 9px; }
      .shell { display:block; }
      header { top:58px; height:auto; }
      .header-inner { padding:6px 8px; }
      button.tab { padding:9px 1px; gap:4px; font-size:.61rem; border-radius:8px; }
      button.tab:last-child { margin-top:0; }
      main { padding:24px 14px 40px; }
    }
  `;

  private _financeState(): FinanceState {
    return parseFinanceState(this.hass);
  }

  private _selectTab(tab: Tab): void {
    this._tab = tab;
  }

  render() {
    const state = this._financeState();
    return html`
      <div class="titlebar"><div class="brand"><ha-icon class="brand-icon" icon="mdi:wallet-outline"></ha-icon><h1>stash<span>.</span></h1></div><span class="mode"><ha-icon icon="mdi:account-group-outline"></ha-icon>${state.mode === "split" ? "Split" : "Shared"} household</span></div>
      <div class="shell">
      <header>
        <div class="header-inner">
        <nav aria-label="Stash sections">
        ${TABS.map(
          (tab) => html`
            <button
              class="tab ${this._tab === tab.id ? "active" : ""}"
              aria-current=${this._tab === tab.id ? "page" : "false"}
              @click=${() => this._selectTab(tab.id)}
            >
              <ha-icon icon=${tab.icon}></ha-icon>
              ${tab.label}
            </button>
          `
        )}
        </nav></div>
      </header>
      <main @stash-navigate=${(e: CustomEvent<Navigation | Tab>) => {
        const target = typeof e.detail === "string" ? { tab: e.detail } : e.detail;
        if (TABS.some(t => t.id === target.tab)) {
          this._selectTab(target.tab);
          if (target.householdTab) this._householdTab = target.householdTab;
        }
      }}>
        <div class="page-heading ${this._tab === "dashboard" ? "dashboard-heading" : ""}"><div>
          <h2>${this._tab === "dashboard" ? "Overview" : TABS.find(t => t.id === this._tab)?.label}</h2>
          <p>${{
            dashboard: "What needs your attention, and where your money stands.",
            bills: "Payments, deadlines, and history.",
            budgets: "Plan by category. See where spending stands.",
            savings: "Make room for your next goal.",
            household: "People, pay cycles, income, and shared responsibility.",
            settings: "Set up Stash to work for your household.",
          }[this._tab]}</p>
        </div></div>
        ${this._tab === "dashboard"
          ? html`<finance-dashboard-view .hass=${this.hass} .financeState=${state}></finance-dashboard-view>`
          : ""}
        ${this._tab === "household" ? html`
          <nav class="subnav" aria-label="Household sections">
            <button aria-pressed=${this._householdTab === "members"} @click=${() => (this._householdTab = "members")}>People & shares</button>
            <button aria-pressed=${this._householdTab === "income"} @click=${() => (this._householdTab = "income")}>Income</button>
          </nav>
          ${this._householdTab === "members"
            ? html`<finance-members-view .hass=${this.hass} .financeState=${state}></finance-members-view>`
            : html`<finance-income-view .hass=${this.hass} .financeState=${state}></finance-income-view>`}
        ` : ""}
        ${this._tab === "bills"
          ? html`<finance-bills-view .hass=${this.hass} .financeState=${state}></finance-bills-view>`
          : ""}
        ${this._tab === "savings"
          ? html`<finance-savings-view .hass=${this.hass} .financeState=${state}></finance-savings-view>`
          : ""}
        ${this._tab === "budgets"
          ? html`<finance-bills-view .hass=${this.hass} .financeState=${state} section="budgets"></finance-bills-view>`
          : ""}
        ${this._tab === "settings"
          ? html`<finance-settings-view .hass=${this.hass} .financeState=${state}></finance-settings-view>`
          : ""}
      </main>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-panel": FinancePanel;
  }
}
