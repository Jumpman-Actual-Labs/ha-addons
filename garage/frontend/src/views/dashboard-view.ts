import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { GarageState, Vehicle } from "../types";
import { money, shortDate } from "../format";
import { glassCardStyle, pageStyles } from "../styles";
import "../components/vehicle-card";
import "../components/fuel-dialog";

@customElement("garage-dashboard-view")
export class GarageDashboardView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) garageState!: GarageState;
  @state() private _fuelDialogOpen = false;
  @state() private _fuelVehicleId = "";

  static styles = [glassCardStyle, pageStyles, css`
    .workspace { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(270px, 1fr); gap: 22px; align-items: start; }
    .fleet, .rail { min-width: 0; }
    .rail { display: grid; gap: 20px; }
    .vehicle-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 290px), 1fr)); }
    .rail .panel { padding: 20px; }
    .panel-head h2 { font-size: .85rem; }
    .panel-head ha-icon { color: var(--garage-accent); --mdc-icon-size: 18px; }
    .panel-head h2 { display: flex; align-items: center; gap: 8px; }
    .attention-row { padding: 14px 0; border-bottom: 1px solid var(--garage-border); }
    .attention-row:last-of-type { border: 0; }
    .attention-row strong { display: block; font-size: .8rem; font-weight: 550; margin-bottom: 4px; }
    .attention-row span { display: block; font-size: .73rem; color: var(--garage-warning); line-height: 1.7; }
    .clear { padding: 18px 0 8px; color: var(--garage-success); }
    .clear strong { display: block; color: var(--garage-text); font-size: .85rem; margin: 10px 0 4px; font-weight: 550; }
    .clear p { margin: 0; color: var(--garage-muted); font-size: .75rem; }
    .activity { display: flex; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--garage-border); }
    .activity:last-of-type { border: 0; }
    .activity .icon-tile { width: 32px; height: 32px; border-radius: 8px; }
    .activity strong { display: block; font-size: .76rem; font-weight: 550; }
    .activity small { display: block; color: var(--garage-muted); font-size: .69rem; margin-top: 3px; }
    .activity .amount { margin-left: auto; text-align: right; flex-shrink: 0; font-size: .75rem; font-family: var(--garage-mono); }
    .activity .amount small { font-family: var(--garage-font); }
    .cost-split { display: flex; height: 7px; gap: 4px; margin: 18px 0; overflow: hidden; border-radius: 4px; background: var(--garage-raised); }
    .cost-split span:first-child { background: var(--garage-accent); border-radius: 4px; }
    .cost-split span:last-child { background: #a4b1bc; border-radius: 4px; }
    .cost-row { display: flex; justify-content: space-between; align-items: center; font-size: .75rem; padding: 7px 0; }
    .cost-row span { color: var(--garage-muted); display: flex; align-items: center; gap: 8px; }
    .cost-row i { width: 6px; height: 6px; border-radius: 2px; background: var(--garage-accent); }
    .cost-row.service i { background: #a4b1bc; }
    .cost-total { font-size: 1.65rem; letter-spacing: -.05em; font-weight: 650; margin-top: 10px; }
    @media (max-width: 1180px) { .workspace { grid-template-columns: 1fr; } .rail { grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); align-items: start; } }
  `];

  private _navigate(tab: string): void {
    this.dispatchEvent(new CustomEvent("garage-navigate", { detail: tab, bubbles: true, composed: true }));
  }

  private _openFuelDialog(vehicleId: string): void {
    this._fuelVehicleId = vehicleId; this._fuelDialogOpen = true;
  }

  render() {
    const s = this.garageState;
    const active = s.vehicles.filter(v => v.status === "active");
    const needsAttention = s.vehicles.filter(v => v.maintenanceDueCount > 0 || v.maintenanceDueSoonCount > 0 ||
      (v.currentFuelPct !== null && v.currentFuelPct <= s.settings.lowFuelThreshold) ||
      (v.registrationExpires && new Date(v.registrationExpires) < new Date()) ||
      (v.insuranceExpires && new Date(v.insuranceExpires) < new Date()));
    const total = s.totalMonthlyFuelSpend + s.totalMonthlyMaintenanceSpend;
    const name = (id: string) => s.vehicles.find(v => v.vehicleId === id)?.nickname ?? "Unknown vehicle";
    const activity = [
      ...s.fuelEntries.map(e => ({ id: "fuel-" + e.id, date: e.date, title: "Fuel added", vehicle: name(e.vehicleId), amount: e.amountDollars, icon: "mdi:gas-station-outline" })),
      ...s.maintenanceRecords.map(r => ({ id: "service-" + r.id, date: r.date, title: r.name, vehicle: name(r.vehicleId), amount: r.cost, icon: "mdi:wrench-outline" })),
    ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    return html`
      <div class="summary-grid">
        <ha-card><div class="kpi-top"><span class="label">Fuel spending</span><ha-icon aria-hidden="true" icon="mdi:gas-station-outline"></ha-icon></div><div class="value">${money(s.totalMonthlyFuelSpend)}</div><div class="kpi-foot">This month · all vehicles</div></ha-card>
        <ha-card><div class="kpi-top"><span class="label">Maintenance</span><ha-icon aria-hidden="true" icon="mdi:wrench-outline"></ha-icon></div><div class="value">${money(s.totalMonthlyMaintenanceSpend)}</div><div class="kpi-foot">This month · all vehicles</div></ha-card>
        <ha-card><div class="kpi-top"><span class="label">Active vehicles</span><ha-icon aria-hidden="true" icon="mdi:car-multiple"></ha-icon></div><div class="value">${active.length.toString().padStart(2, "0")}</div><div class="kpi-foot">${s.vehicles.length} total in your garage</div></ha-card>
        <ha-card><div class="kpi-top"><span class="label">Needs attention</span><ha-icon aria-hidden="true" icon="mdi:alert-circle-outline"></ha-icon></div><div class="value" style=${needsAttention.length ? "color:var(--garage-warning)" : "color:var(--garage-success)"}>${needsAttention.length.toString().padStart(2, "0")}</div><div class="kpi-foot">Service, fuel &amp; renewals</div></ha-card>
      </div>
      <div class="workspace">
        <section class="fleet">
          <div class="section-head"><div><h2>Active fleet</h2><p>Vehicle health and the essentials.</p></div><button class="secondary" @click=${() => this._navigate("vehicles")}>Manage vehicles<ha-icon aria-hidden="true" icon="mdi:arrow-top-right"></ha-icon></button></div>
          ${active.length ? html`<div class="vehicle-grid">${active.slice(0, 4).map(v => html`<garage-vehicle-card .vehicle=${v} .lowFuelThreshold=${s.settings.lowFuelThreshold} @vehicle-fuel=${(e: CustomEvent<Vehicle>) => this._openFuelDialog(e.detail.vehicleId)}></garage-vehicle-card>`)}</div>
            ${active.length > 4 ? html`<button class="ghost" @click=${() => this._navigate("vehicles")}>View all ${active.length} active vehicles →</button>` : ""}
          ` : html`<ha-card><div class="empty"><ha-icon aria-hidden="true" icon="mdi:car-outline"></ha-icon><strong>Your garage starts here.</strong>Add your first vehicle to track health, fuel and service.<br><button class="ghost" @click=${() => this._navigate("vehicles")}>Go to Vehicles →</button></div></ha-card>`}
        </section>
        <div class="rail">
          <ha-card class="panel">
            <div class="panel-head"><h2><ha-icon aria-hidden="true" icon="mdi:clipboard-check-outline"></ha-icon>Attention queue</h2><span class="pill ${needsAttention.length ? "warn" : "good"}">${needsAttention.length ? needsAttention.length + " vehicles" : "All clear"}</span></div>
            ${needsAttention.length ? needsAttention.slice(0, 4).map(v => html`<div class="attention-row"><strong>${v.nickname}</strong>
              ${v.maintenanceDueCount ? html`<span>${v.nextMaintenanceDue?.name ?? "Maintenance"} · ${v.maintenanceDueCount} due</span>` : ""}
              ${v.maintenanceDueSoonCount ? html`<span>${v.maintenanceDueSoonCount} service items due soon</span>` : ""}
              ${v.currentFuelPct !== null && v.currentFuelPct <= s.settings.lowFuelThreshold ? html`<span>Fuel below your reminder threshold</span>` : ""}
              ${v.registrationExpires && new Date(v.registrationExpires) < new Date() ? html`<span>Registration expired</span>` : ""}
              ${v.insuranceExpires && new Date(v.insuranceExpires) < new Date() ? html`<span>Insurance expired</span>` : ""}
            </div>`) : html`<div class="clear"><ha-icon aria-hidden="true" icon="mdi:check-circle-outline"></ha-icon><strong>${s.vehicles.length ? "No alerts from your recorded data." : "Ready when you are."}</strong><p>${s.vehicles.length ? "Keep readings and service records up to date." : "Add a vehicle to start tracking reminders."}</p></div>`}
            <button class="ghost" @click=${() => this._navigate("maintenance")}>Open maintenance →</button>
          </ha-card>
          <ha-card class="panel">
            <div class="panel-head"><h2><ha-icon aria-hidden="true" icon="mdi:chart-donut"></ha-icon>Monthly operating cost</h2></div>
            <div class="eyebrow">Fuel + maintenance</div><div class="cost-total">${money(total)}</div>
            <div class="cost-split" aria-hidden="true"><span style=${`width:${total > 0 ? s.totalMonthlyFuelSpend / total * 100 : 0}%`}></span><span style=${`width:${total > 0 ? s.totalMonthlyMaintenanceSpend / total * 100 : 0}%`}></span></div>
            <div class="cost-row"><span><i></i>Fuel</span><strong class="mono">${money(s.totalMonthlyFuelSpend)}</strong></div>
            <div class="cost-row service"><span><i></i>Maintenance</span><strong class="mono">${money(s.totalMonthlyMaintenanceSpend)}</strong></div>
            <button class="ghost" @click=${() => this._navigate("analytics")}>Explore analytics →</button>
          </ha-card>
          <ha-card class="panel">
            <div class="panel-head"><h2><ha-icon aria-hidden="true" icon="mdi:history"></ha-icon>Recent activity</h2></div>
            ${activity.length ? activity.map(a => html`<div class="activity"><span class="icon-tile"><ha-icon aria-hidden="true" icon=${a.icon}></ha-icon></span><div><strong>${a.title}</strong><small>${a.vehicle}</small></div><div class="amount">${money(a.amount)}<small>${shortDate(a.date)}</small></div></div>`) : html`<div class="sub">Your fuel and service history will appear here.</div>`}
            <button class="ghost" @click=${() => this._navigate("fuel")}>View fuel history →</button>
          </ha-card>
        </div>
      </div>
      <garage-fuel-dialog .hass=${this.hass} .open=${this._fuelDialogOpen} .vehicles=${s.vehicles} .vehicleId=${this._fuelVehicleId} @fuel-dialog-closed=${() => (this._fuelDialogOpen = false)}></garage-fuel-dialog>
    `;
  }
}
declare global { interface HTMLElementTagNameMap { "garage-dashboard-view": GarageDashboardView; } }

