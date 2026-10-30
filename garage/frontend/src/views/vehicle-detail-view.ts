import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { GarageState, Vehicle } from "../types";
import { shortDate } from "../format";
import { glassCardStyle, pageStyles } from "../styles";
import "./maintenance-view";
import "./documents-view";
import "../components/vehicle-readings";

@customElement("garage-vehicle-detail-view")
export class GarageVehicleDetailView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) garageState!: GarageState;
  @property({ attribute: false }) vehicle!: Vehicle;

  static styles = [glassCardStyle, pageStyles, css`
    .layout { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(0, 2fr); gap: 24px; align-items: start; }
    .info { padding: 24px; }
    img { width: 100%; max-height: 240px; object-fit: cover; border-radius: 12px; }
    dl { margin: 0; } dl div { padding: 12px 0; border-bottom: 1px solid var(--garage-border); }
    dt { color: var(--garage-muted); font-size: .75rem; } dd { margin: 5px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .readings-panel { padding: 22px; margin-bottom: 24px; }
    .readings-panel h2 { margin: 0 0 16px; font-size: 1rem; }
    .reading-note { margin: 14px 0 0; color: var(--garage-muted); font-size: .78rem; line-height: 1.6; }
    details { margin-top: 14px; color: var(--garage-muted); font-size: .78rem; }
    summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--garage-accent); }
    summary::before { content: "+"; width: 20px; font-family: var(--garage-mono); }
    details[open] summary::before { content: "−"; }
    summary:focus-visible { outline: 2px solid var(--garage-accent); outline-offset: 3px; }
    details dl div { padding: 8px 0; }
    details dd { font-family: var(--garage-mono); font-size: .75rem; }
    .documents { margin-top: 32px; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  `];

  render() {
    const v = this.vehicle;
    const s = this.garageState;
    const scoped: GarageState = { ...s, vehicles: [v],
      maintenanceRecords: s.maintenanceRecords.filter(r => r.vehicleId === v.vehicleId),
      documents: s.documents.filter(d => d.vehicleId === v.vehicleId),
      totalMonthlyMaintenanceSpend: v.monthlyMaintenanceCost };
    const fields = [
      ["Vehicle", `${v.year} ${v.make} ${v.model} ${v.trim}`],
      ["Status", v.status], ["VIN", v.vin], ["License plate", v.licensePlate],
      ["Title number", v.titleNumber], ["Color", v.color],
      ["Fuel type", v.fuelType], ["Drivetrain", v.drivetrain.toUpperCase()],
      ["Tank capacity", v.tankCapacityGal == null ? "" : `${v.tankCapacityGal} gal`],
      ["Oil capacity", v.oilCapacityQt == null ? "" : `${v.oilCapacityQt} qt`],
      ["Tire size", v.tireSize],
      ["Primary driver", s.drivers.find(d => d.id === v.primaryDriverId)?.name],
      ["Registration expires", shortDate(v.registrationExpires)],
      ["Insurance expires", shortDate(v.insuranceExpires)], ["Notes", v.notes],
    ];
    return html`
      <div class="header-row"><button class="secondary" @click=${() => this.dispatchEvent(new CustomEvent("vehicle-back"))}>← All vehicles</button>
        <button class="link" @click=${() => this.dispatchEvent(new CustomEvent("vehicle-edit", { detail: v }))}>Edit Vehicle</button></div>
      <div class="section-head"><div><h2>${v.nickname}</h2><p>${v.year} ${v.make} ${v.model}</p></div></div>
      <ha-card class="readings-panel"><h2>Vehicle readings</h2>
        <garage-vehicle-readings wide .vehicle=${v} .lowFuelThreshold=${s.settings.lowFuelThreshold}></garage-vehicle-readings>
        <p class="reading-note">${v.odometerEntityId || v.fuelLevelEntityId
          ? "Linked sensors are checked about once a minute. Last saved readings remain when a sensor is unavailable."
          : "Link fuel and odometer sensors in Edit vehicle to collect readings automatically."}</p>
        ${v.odometerEntityId || v.fuelLevelEntityId ? html`<details><summary>Reading sources</summary><dl>
          ${v.odometerEntityId ? html`<div><dt>Odometer sensor</dt><dd>${v.odometerEntityId}</dd></div>` : ""}
          ${v.fuelLevelEntityId ? html`<div><dt>Fuel level sensor</dt><dd>${v.fuelLevelEntityId}</dd></div>` : ""}
        </dl></details>` : ""}
      </ha-card>
      <div class="layout">
        <ha-card class="info"><h2>Vehicle information</h2>${v.photoPath ? html`<img src=${v.photoPath} alt=${v.nickname} />` : ""}
          <dl>${fields.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value || "—"}</dd></div>`)}</dl></ha-card>
        <section aria-label="Maintenance information and history"><garage-maintenance-view .hass=${this.hass} .garageState=${scoped}></garage-maintenance-view></section>
      </div>
      <section class="documents" aria-label="Vehicle documents"><garage-documents-view .hass=${this.hass} .garageState=${scoped} .vehicleId=${v.vehicleId}></garage-documents-view></section>
    `;
  }
}
