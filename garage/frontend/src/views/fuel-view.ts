import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { FuelEntry, GarageState } from "../types";
import { money, mileage, shortDate } from "../format";
import { glassCardStyle, pageStyles } from "../styles";
import "../components/fuel-dialog";

@customElement("garage-fuel-view")
export class GarageFuelView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) garageState!: GarageState;

  @state() private _fuelDialogOpen = false;
  @state() private _editingEntry: FuelEntry | null = null;
  @state() private _vehicleFilter = "";

  static styles = [glassCardStyle, pageStyles, css`
    .filter { display: flex; align-items: center; gap: 12px; }
    .filter label { font-size: .76rem; color: var(--garage-muted); }
    .history { padding: 22px; }
    .entry, .ledger-head { display: grid; grid-template-columns: minmax(0, 1.5fr) 95px 90px 100px 88px; gap: 18px; align-items: center; }
    .entry { padding: 18px 0; border-bottom: 1px solid var(--garage-border); }
    .entry:last-child { border: 0; }
    .entry strong { font-size: .83rem; font-weight: 550; }
    .entry .sub { font-size: .72rem; margin-top: 4px; }
    .entry .mono { font-size: .8rem; } .entry .amount { text-align: right; }
    .entry-actions { display: flex; justify-content: flex-end; }
    .ledger-head span:nth-last-child(2) { text-align: right; }
    .entry-details { display: flex; gap: 12px; align-items: center; min-width: 0; }
    .entry-details > div { min-width: 0; overflow-wrap: anywhere; }
    .mobile-label { display: none; }
    @media (max-width: 1100px) { .entry, .ledger-head { grid-template-columns: minmax(0, 1fr) 80px 85px 88px; gap: 12px; } .economy { display: none; } }
    @media (max-width: 600px) {
      .history { padding: 16px; } .filter { width: 100%; } .filter select { flex: 1; }
      .entry { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; }
      .entry-details { grid-column: 1 / -1; }
      .entry .volume { display: none; } .entry .amount { text-align: left; }
      .ledger-head { display: none; } .entry-actions { grid-column: 2; }
    }
  `];

  render() {
    const s = this.garageState;
    const entries = [...s.fuelEntries]
      .filter((e) => !this._vehicleFilter || e.vehicleId === this._vehicleFilter)
      .sort((a, b) => b.date.localeCompare(a.date) || b.odometer - a.odometer);

    const vehicle = (id: string) => s.vehicles.find((v) => v.vehicleId === id);
    const filteredVehicle = this._vehicleFilter ? vehicle(this._vehicleFilter) : null;
    const avgMpg = filteredVehicle?.averageMpg ?? null;
    const avgPrice = filteredVehicle?.averagePricePerGallon ?? null;
    const monthlySpend = filteredVehicle
      ? filteredVehicle.monthlyFuelCost
      : s.totalMonthlyFuelSpend;
    const lifetimeSpend = filteredVehicle
      ? filteredVehicle.lifetimeFuelCost
      : s.vehicles.reduce((sum, v) => sum + v.lifetimeFuelCost, 0);

    return html`
      <div class="header-row">
        <div class="filter"><label for="fuel-vehicle-filter">Vehicle</label><select id="fuel-vehicle-filter"
          aria-label="Filter by vehicle"
          .value=${this._vehicleFilter}
          @change=${(e: Event) => (this._vehicleFilter = (e.target as HTMLSelectElement).value)}
        >
          <option value="">All Vehicles</option>
          ${s.vehicles.map((v) => html`<option value=${v.vehicleId}>${v.nickname}</option>`)}
        </select></div>
        <button
          class="link"
          @click=${() => {
            this._editingEntry = null;
            this._fuelDialogOpen = true;
          }}
        >
          <ha-icon aria-hidden="true" icon="mdi:plus"></ha-icon>Add Fuel
        </button>
      </div>

      <div class="summary-grid">
        <ha-card>
          <div class="kpi-top"><div class="label">Average MPG</div><ha-icon aria-hidden="true" icon="mdi:speedometer"></ha-icon></div>
          <div class="value">${avgMpg !== null ? avgMpg.toFixed(1) : "—"}</div><div class="kpi-foot">${filteredVehicle ? "Recorded fuel economy" : "Select a vehicle for its average"}</div>
        </ha-card>
        <ha-card>
          <div class="kpi-top"><div class="label">Price / gallon</div><ha-icon aria-hidden="true" icon="mdi:gas-station-outline"></ha-icon></div>
          <div class="value">${avgPrice !== null ? money(avgPrice) : "—"}</div><div class="kpi-foot">${filteredVehicle ? "Average at the pump" : "Select a vehicle for its average"}</div>
        </ha-card>
        <ha-card>
          <div class="kpi-top"><div class="label">Monthly spending</div><ha-icon aria-hidden="true" icon="mdi:calendar-month-outline"></ha-icon></div>
          <div class="value">${money(monthlySpend)}</div><div class="kpi-foot">Fuel purchases this month</div>
        </ha-card>
        <ha-card>
          <div class="kpi-top"><div class="label">Lifetime spending</div><ha-icon aria-hidden="true" icon="mdi:chart-line"></ha-icon></div>
          <div class="value">${money(lifetimeSpend)}</div><div class="kpi-foot">All recorded fuel purchases</div>
        </ha-card>
      </div>

      <ha-card class="history">
        <div class="panel-head"><div><h2>Fill-up history</h2><p>Every stop at the pump, in one ledger.</p></div><span class="pill">${entries.length} entries</span></div>
        ${entries.length ? html`
          <div class="ledger-head" aria-hidden="true"><span>Vehicle / date</span><span class="volume">Volume</span><span class="economy">Economy</span><span>Total paid</span><span>Actions</span></div>
          <div role="list">${entries.map(e => html`
            <div class="entry" role="listitem">
              <div class="entry-details"><span class="icon-tile"><ha-icon aria-hidden="true" icon="mdi:gas-station-outline"></ha-icon></span><div><strong>${vehicle(e.vehicleId)?.nickname ?? "Unknown vehicle"}</strong><div class="sub">${shortDate(e.date)} · ${e.station || "Station not recorded"}<br>${mileage(e.odometer)}</div></div></div>
              <span class="mono volume">${e.gallonsAdded !== null ? e.gallonsAdded.toFixed(2) + " gal" : "—"}</span>
              <span class="mono economy">${e.mpg !== null ? e.mpg.toFixed(1) + " mpg" : "—"}</span>
              <strong class="mono amount">${money(e.amountDollars)}</strong>
              <div class="entry-actions">
                <button class="icon" aria-label="Edit fuel entry" @click=${() => { this._editingEntry = e; this._fuelDialogOpen = true; }}><ha-icon aria-hidden="true" icon="mdi:pencil-outline"></ha-icon></button>
                <button class="icon danger" aria-label="Delete fuel entry" @click=${() => garageApi.deleteFuelEntry(this.hass, e.id)}><ha-icon aria-hidden="true" icon="mdi:trash-can-outline"></ha-icon></button>
              </div>
            </div>`)}</div>
        ` : html`<div class="empty"><ha-icon aria-hidden="true" icon="mdi:gas-station-outline"></ha-icon><strong>No fill-ups recorded.</strong>Add your first fuel entry to start tracking efficiency.</div>`}
      </ha-card>

      <garage-fuel-dialog
        .hass=${this.hass}
        .open=${this._fuelDialogOpen}
        .vehicles=${s.vehicles}
        .vehicleId=${this._vehicleFilter}
        .entry=${this._editingEntry}
        @fuel-dialog-closed=${() => (this._fuelDialogOpen = false)}
      ></garage-fuel-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-fuel-view": GarageFuelView;
  }
}
