import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { GarageState, Vehicle } from "../types";

import { glassCardStyle, formStyles, pageStyles } from "../styles";
import "../components/vehicle-dialog";
import "../components/driver-dialog";
import "../components/vehicle-card";
import "./vehicle-detail-view";

@customElement("garage-vehicles-view")
export class GarageVehiclesView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) garageState!: GarageState;

  @state() private _vehicleDialogOpen = false;
  @state() private _editingVehicle: Vehicle | null = null;
  @state() private _driverDialogOpen = false;
  @state() private _deleting: { kind: "vehicle" | "driver"; id: string } | null = null;
  @state() private _deleteBusy = false;
  @state() private _deleteError = "";
  @state() private _selectedVehicleId = "";
  @state() private _search = "";
  @state() private _status = "all";

  static styles = [glassCardStyle, formStyles, pageStyles, css`
    .toolbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 22px; }
    .toolbar input { width: min(100%, 280px); }
    .filters { display: flex; gap: 6px; flex-wrap: wrap; }
    .filters button { min-height: 38px; padding: 8px 12px; font-size: .73rem; border: 1px solid var(--garage-border); border-radius: 7px; color: var(--garage-muted); background: var(--garage-inset); }
    .filters button[aria-pressed="true"] { color: var(--garage-accent); border-color: #f6a45b4a; background: #f6a45b0b; }
    .driver-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 14px; }
    .driver { display: flex; align-items: center; gap: 14px; padding: 18px; }
    .avatar { display: grid; place-items: center; width: 42px; height: 42px; flex-shrink: 0; border-radius: 11px; background: #a4b1bc15; color: #bcc6ce; font-weight: 600; }
    .driver-info { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .driver-info strong { font-size: .85rem; font-weight: 550; }
    .driver-info .sub { font-size: .72rem; margin-top: 4px; }
    section + section { margin-top: 32px; }
  `];

  private _openAddVehicle(): void {
    this._editingVehicle = null;
    this._vehicleDialogOpen = true;
  }

  private _openEditVehicle(v: Vehicle): void {
    this._editingVehicle = v;
    this._vehicleDialogOpen = true;
  }

  private _deleteVehicle(vehicleId: string): void {
    this._deleteError = "";
    this._deleting = { kind: "vehicle", id: vehicleId };
  }

  private _deleteDriver(driverId: string): void {
    this._deleteError = "";
    this._deleting = { kind: "driver", id: driverId };
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleting || this._deleteBusy) return;
    const target = this._deleting;
    this._deleteBusy = true;
    try {
      if (target.kind === "vehicle") await garageApi.deleteVehicle(this.hass, target.id);
      else await garageApi.deleteDriver(this.hass, target.id);
      this._deleting = null;
    } catch (error) {
      this._deleteError = error instanceof Error ? error.message : "Unable to delete. Please try again.";
    } finally {
      this._deleteBusy = false;
    }
  }

  render() {
    const s = this.garageState;
    const selected = s.vehicles.find(v => v.vehicleId === this._selectedVehicleId);
    const query = this._search.trim().toLowerCase();
    const vehicles = s.vehicles.filter(v => (this._status === "all" || v.status === this._status) && (!query || `${v.nickname} ${v.make} ${v.model} ${v.year}`.toLowerCase().includes(query)));
    return html`
      ${selected ? html`<garage-vehicle-detail-view .hass=${this.hass} .garageState=${s} .vehicle=${selected}
        @vehicle-back=${() => (this._selectedVehicleId = "")}
        @vehicle-edit=${(e: CustomEvent<Vehicle>) => this._openEditVehicle(e.detail)}></garage-vehicle-detail-view>` : html`<section>
        <div class="section-head"><div><h2>Vehicle collection <span class="pill">${s.vehicles.length}</span></h2><p>Every vehicle. One complete record.</p></div><button class="link" @click=${this._openAddVehicle}><ha-icon aria-hidden="true" icon="mdi:plus"></ha-icon>Add Vehicle</button></div>
        <div class="toolbar">
          <div class="filters" aria-label="Filter by vehicle status">${["all", "active", "stored", "project", "sold"].map(status => html`<button aria-pressed=${this._status === status} @click=${() => (this._status = status)}>${status === "all" ? "All vehicles" : status[0].toUpperCase() + status.slice(1)}</button>`)}</div>
          <input type="search" aria-label="Search vehicles" placeholder="Search your garage…" .value=${this._search} @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)} />
        </div>
        ${vehicles.length ? html`<div class="vehicle-grid">${vehicles.map(v => html`<garage-vehicle-card .vehicle=${v} .lowFuelThreshold=${s.settings.lowFuelThreshold} .manage=${true} .selectable=${true} @vehicle-select=${(e: CustomEvent<Vehicle>) => (this._selectedVehicleId = e.detail.vehicleId)} @vehicle-edit=${(e: CustomEvent<Vehicle>) => this._openEditVehicle(e.detail)} @vehicle-delete=${(e: CustomEvent<Vehicle>) => this._deleteVehicle(e.detail.vehicleId)}></garage-vehicle-card>`)}</div>`
          : html`<ha-card><div class="empty"><ha-icon aria-hidden="true" icon="mdi:car-search"></ha-icon><strong>${s.vehicles.length ? "No vehicles match." : "Make room for your first vehicle."}</strong>${s.vehicles.length ? "Try another status or search." : "Add a vehicle to start building its history."}</div></ha-card>`}
      </section>
      <section>
        <div class="section-head"><div><h2>Drivers <span class="pill">${s.drivers.length}</span></h2><p>People behind the wheel and their reminder destinations.</p></div><button class="secondary" @click=${() => (this._driverDialogOpen = true)}><ha-icon aria-hidden="true" icon="mdi:account-plus-outline"></ha-icon>Add Driver</button></div>
        ${s.drivers.length ? html`<div class="driver-list">${s.drivers.map(d => html`<ha-card class="driver"><div class="avatar" aria-hidden="true">${d.name.trim().split(/\\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase()}</div><div class="driver-info"><strong>${d.name}</strong><div class="sub">${d.notifyTarget ? "Reminders: " + d.notifyTarget : "No reminder destination linked"}</div></div><button class="icon danger" aria-label=${`Delete ${d.name}`} @click=${() => this._deleteDriver(d.id)}><ha-icon aria-hidden="true" icon="mdi:trash-can-outline"></ha-icon></button></ha-card>`)}</div>`
          : html`<ha-card><div class="empty"><strong>No drivers yet.</strong>Link drivers to keep the right people informed.</div></ha-card>`}
      </section>
      `}
      <garage-dialog
        heading=${this._deleting?.kind === "vehicle" ? "Delete vehicle?" : "Delete driver?"}
        .open=${this._deleting !== null}
        @garage-dialog-closed=${() => (this._deleting = null)}>
        <p>${this._deleting?.kind === "vehicle"
          ? "This will permanently delete the vehicle and all its fuel and maintenance history."
          : "This will permanently delete the driver."}</p>
        ${this._deleteError ? html`<p role="alert">${this._deleteError}</p>` : ""}
        <div class="actions" slot="footer">
          <button class="secondary" ?disabled=${this._deleteBusy} @click=${() => (this._deleting = null)}>Cancel</button>
          <button class="primary" ?disabled=${this._deleteBusy} @click=${this._confirmDelete}>
            ${this._deleteBusy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </garage-dialog>

      <garage-vehicle-dialog
        .hass=${this.hass}
        .open=${this._vehicleDialogOpen}
        .vehicle=${this._editingVehicle}
        .drivers=${s.drivers}
        @vehicle-dialog-closed=${() => (this._vehicleDialogOpen = false)}
      ></garage-vehicle-dialog>

      <garage-driver-dialog
        .hass=${this.hass}
        .open=${this._driverDialogOpen}
        @driver-dialog-closed=${() => (this._driverDialogOpen = false)}
      ></garage-driver-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-vehicles-view": GarageVehiclesView;
  }
}
