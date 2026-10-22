import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "./ha-api";
import { parseGarageState } from "./ha-api";
import type { GarageState } from "./types";
import { themeStyles } from "./styles";
import "./views/dashboard-view";
import "./views/vehicles-view";
import "./views/fuel-view";
import "./views/maintenance-view";
import "./views/documents-view";
import "./views/analytics-view";
import "./views/settings-view";

type Tab =
  | "dashboard"
  | "vehicles"
  | "fuel"
  | "maintenance"
  | "documents"
  | "analytics"
  | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "mdi:view-dashboard" },
  { id: "vehicles", label: "Vehicles", icon: "mdi:car" },
  { id: "fuel", label: "Fuel", icon: "mdi:gas-station" },
  { id: "maintenance", label: "Maintenance", icon: "mdi:wrench" },
  { id: "documents", label: "Documents", icon: "mdi:file-document" },
  { id: "analytics", label: "Analytics", icon: "mdi:chart-line" },
  { id: "settings", label: "Settings", icon: "mdi:cog" },
];

const PAGE_DESCRIPTIONS: Record<Tab, string> = {
  dashboard: "Your vehicles, running costs, and what needs attention.",
  vehicles: "Manage your vehicles and the people who drive them.",
  fuel: "Track fill-ups, fuel economy, and spending.",
  maintenance: "Keep service history organized and stay ahead of the next job.",
  documents: "Registration, insurance, and service records in one place.",
  analytics: "Compare running costs and fuel economy across your garage.",
  settings: "Manage reminders and connected integrations.",
};

@customElement("garage-panel")
export class GaragePanel extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) narrow = false;

  @state() private _tab: Tab = "dashboard";

  static styles = [themeStyles, css`
    :host { display: block; height: 100%; overflow: auto; background: var(--garage-bg); }
    * { box-sizing: border-box; }
    .titlebar {
      height: 72px; position: sticky; top: 0; z-index: 20;
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 0 28px; background: #181b1e; border-bottom: 1px solid var(--garage-border);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid #f6a45b33; border-radius: 11px; background: #f6a45b0b; color: var(--garage-accent); }
    h1 { margin: 0; font-size: 1.55rem; letter-spacing: -.06em; font-weight: 700; }
    h1 span { color: var(--garage-accent); }
    .brand small { display: block; font-size: .6rem; letter-spacing: .14em; text-transform: uppercase; color: var(--garage-muted); margin-top: -2px; }
    .integration { display: flex; align-items: center; gap: 8px; font-size: .72rem; color: var(--garage-muted); }
    .integration ha-icon { --mdc-icon-size: 17px; color: var(--garage-accent); }
    .shell { display: grid; grid-template-columns: 200px minmax(0, 1fr); min-height: calc(100% - 72px); }
    aside { position: sticky; top: 72px; height: calc(100dvh - 72px); align-self: start; display: flex; flex-direction: column; border-right: 1px solid var(--garage-border); padding: 24px 12px 16px; background: #16191c; }
    .nav-label { color: var(--garage-muted); font-size: .6rem; letter-spacing: .14em; text-transform: uppercase; padding: 0 14px 16px; }
    nav { display: flex; flex-direction: column; gap: 5px; }
    button { font: inherit; cursor: pointer; }
    button.tab { display: flex; align-items: center; gap: 12px; min-height: 46px; padding: 12px 14px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--garage-muted); font-size: .8rem; text-align: left; transition: background 160ms ease, color 160ms ease; }
    button.tab ha-icon { --mdc-icon-size: 20px; flex-shrink: 0; }
    button.tab:hover { color: var(--garage-text); background: #272b2f; }
    button.tab.active { color: var(--garage-accent); background: linear-gradient(110deg, #f6a45b18, #f6a45b05); border-color: #f6a45b28; box-shadow: inset 2px 0 var(--garage-accent); font-weight: 600; }
    button.tab:last-child { margin-top: 18px; }
    button:focus-visible { outline: 2px solid var(--garage-accent); outline-offset: 2px; }
     .short-label { display: none; }
    .fleet-summary { margin-top: auto; padding: 18px 14px 4px; border-top: 1px solid var(--garage-border); color: var(--garage-muted); font-size: .72rem; }
    .fleet-summary strong { display: block; color: var(--garage-text); font-size: .83rem; font-weight: 550; margin-bottom: 4px; }
    main { min-width: 0; width: 100%; max-width: 1500px; margin: 0 auto; padding: 32px 32px 56px; }
    .page-heading { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
    .eyebrow { color: var(--garage-accent); font-size: .6rem; font-weight: 600; text-transform: uppercase; letter-spacing: .14em; margin-bottom: 8px; }
    .page-heading h2 { font-size: clamp(1.5rem, 2.4vw, 2rem); letter-spacing: -.045em; line-height: 1.2; margin: 0; font-weight: 650; }
    .page-heading p { margin: 8px 0 0; color: var(--garage-muted); font-size: .82rem; }
    .fleet-pill { padding: 9px 12px; border: 1px solid var(--garage-border); border-radius: 8px; background: var(--garage-surface); font-size: .72rem; color: var(--garage-muted); white-space: nowrap; }
    .fleet-pill strong { color: var(--garage-text); font-weight: 600; margin-right: 6px; font-family: var(--garage-mono); }
    @media (max-width: 1100px) { .shell { grid-template-columns: 168px minmax(0, 1fr); } main { padding: 28px 22px 48px; } aside { padding-left: 8px; padding-right: 8px; } }
    @media (max-width: 800px) {
      .titlebar { height: 62px; padding: 0 16px; }
      h1 { font-size: 1.35rem; } .brand small { display: none; }
      .integration { font-size: .65rem; } .brand-mark { width: 32px; height: 32px; }
      .shell { display: block; }
      aside { top: 62px; height: auto; padding: 8px; z-index: 15; border-right: 0; border-bottom: 1px solid var(--garage-border); }
      .nav-label, .fleet-summary, .full-label { display: none; }
      .short-label { display: inline; }
      nav { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; }
      button.tab { flex-direction: column; gap: 5px; padding: 9px 0; min-height: 54px; font-size: .59rem; border-radius: 7px; justify-content: center; }
      button.tab:last-child { margin-top: 0; }
      button.tab.active { box-shadow: inset 0 -2px var(--garage-accent); }
      button.tab ha-icon { --mdc-icon-size: 19px; }
      main { padding: 24px 14px 36px; }
      .page-heading { align-items: flex-start; gap: 12px; margin-bottom: 22px; }
      .page-heading p { font-size: .78rem; }
      .fleet-pill { padding: 7px 9px; font-size: .65rem; }
    }
    @media (max-width: 400px) { .fleet-pill { display: none; } }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `];

  private _garageState(): GarageState {
    return parseGarageState(this.hass);
  }

  private _selectTab(tab: Tab): void {
    this._tab = tab;
    this.scrollTo({ top: 0 });
  }

  render() {
    if (!this.hass) return html``;
    const state = this._garageState();
    return html`
      <div class="titlebar">
        <div class="brand"><div class="brand-mark"><ha-icon aria-hidden="true" icon="mdi:garage-variant"></ha-icon></div><div><h1>garage<span>.</span></h1><small>Vehicle intelligence</small></div></div>
        <span class="integration"><ha-icon aria-hidden="true" icon="mdi:home-assistant"></ha-icon>Home Assistant</span>
      </div>
      <div class="shell">
        <aside>
          <div class="nav-label">Workspace</div>
          <nav aria-label="Garage pages">
            ${TABS.map((tab) => html`
              <button aria-label=${tab.label} class="tab ${this._tab === tab.id ? "active" : ""}"
                aria-current=${this._tab === tab.id ? "page" : "false"}
                @click=${() => this._selectTab(tab.id)}>
                <ha-icon aria-hidden="true" icon=${tab.icon}></ha-icon><span class="full-label">${tab.label}</span><span class="short-label">${tab.id === "dashboard" ? "Overview" : tab.id === "maintenance" ? "Service" : tab.id === "documents" ? "Docs" : tab.id === "analytics" ? "Insights" : tab.label}</span>
              </button>`)}
          </nav>
          <div class="fleet-summary"><strong>${state.vehicles.length} ${state.vehicles.length === 1 ? "vehicle" : "vehicles"} in your garage</strong>${state.drivers.length} ${state.drivers.length === 1 ? "driver" : "drivers"} · ${state.documents.length} documents</div>
        </aside>
        <main @garage-navigate=${(event: CustomEvent<Tab>) => {
          if (TABS.some(tab => tab.id === event.detail)) this._selectTab(event.detail);
        }}>
          <div class="page-heading">
            <div><div class="eyebrow">Garage / ${this._tab === "dashboard" ? "Overview" : this._tab}</div>
              <h2>${this._tab === "dashboard" ? "Your garage, at a glance." : TABS.find(tab => tab.id === this._tab)?.label}</h2>
              <p>${PAGE_DESCRIPTIONS[this._tab]}</p>
            </div>
            <div class="fleet-pill"><strong>${state.vehicles.filter(v => v.status === "active").length}</strong>Active vehicles</div>
          </div>
        ${this._tab === "dashboard"
          ? html`<garage-dashboard-view .hass=${this.hass} .garageState=${state}></garage-dashboard-view>`
          : ""}
        ${this._tab === "vehicles"
          ? html`<garage-vehicles-view .hass=${this.hass} .garageState=${state}></garage-vehicles-view>`
          : ""}
        ${this._tab === "fuel"
          ? html`<garage-fuel-view .hass=${this.hass} .garageState=${state}></garage-fuel-view>`
          : ""}
        ${this._tab === "maintenance"
          ? html`<garage-maintenance-view .hass=${this.hass} .garageState=${state}></garage-maintenance-view>`
          : ""}
        ${this._tab === "documents"
          ? html`<garage-documents-view .hass=${this.hass} .garageState=${state}></garage-documents-view>`
          : ""}
        ${this._tab === "analytics"
          ? html`<garage-analytics-view .hass=${this.hass} .garageState=${state}></garage-analytics-view>`
          : ""}
        ${this._tab === "settings"
          ? html`<garage-settings-view .hass=${this.hass} .garageState=${state}></garage-settings-view>`
          : ""}
        </main>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-panel": GaragePanel;
  }
}

