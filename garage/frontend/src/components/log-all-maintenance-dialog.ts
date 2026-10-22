import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { MaintenanceTemplate, Vehicle } from "../types";
import { formStyles } from "../styles";
import "./garage-dialog";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Bulk-logs a "done" entry for a set of maintenance templates at once, all
 * on the same date/odometer - meant for backfilling history when a vehicle
 * is acquired with recent service records that don't map to individual
 * fuel-up-style entries (e.g. "the dealer just did all this before I bought
 * it"). Each checked template still becomes its own MaintenanceRecord via
 * the normal complete_maintenance service, just called once per template.
 */
@customElement("garage-log-all-maintenance-dialog")
export class GarageLogAllMaintenanceDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) vehicles: Vehicle[] = [];
  @property({ attribute: false }) templates: MaintenanceTemplate[] = [];

  @state() private _vehicleId = "";
  @state() private _date = todayIso();
  @state() private _odometer = "";
  @state() private _selectedTemplateIds = new Set<string>();
  @state() private _saving = false;

  private _lastOpen = false;

  static styles = [
    formStyles,
    css`
      .template-list {
        max-height: 260px;
        overflow-y: auto;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 8px;
        margin-top: 6px;
      }
      .template-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .template-row:last-child {
        border-bottom: none;
      }
      .template-row input {
        width: auto;
      }
    `,
  ];

  updated(): void {
    if (this.open && !this._lastOpen) {
      this._vehicleId = this.vehicles[0]?.vehicleId ?? "";
      this._date = todayIso();
      this._odometer = this._selectedVehicle ? String(this._selectedVehicle.currentMileage) : "";
      this._selectedTemplateIds = new Set(this.templates.map((t) => t.id));
    }
    this._lastOpen = this.open;
  }

  private get _selectedVehicle(): Vehicle | undefined {
    return this.vehicles.find((v) => v.vehicleId === this._vehicleId);
  }

  private _onVehicleChange(vehicleId: string): void {
    this._vehicleId = vehicleId;
    const vehicle = this.vehicles.find((v) => v.vehicleId === vehicleId);
    if (vehicle) this._odometer = String(vehicle.currentMileage);
  }

  private _toggleTemplate(id: string, checked: boolean): void {
    const next = new Set(this._selectedTemplateIds);
    if (checked) next.add(id);
    else next.delete(id);
    this._selectedTemplateIds = next;
  }

  private get _isValid(): boolean {
    return (
      !!this._vehicleId &&
      !!this._date &&
      (Number(this._odometer) || 0) >= 0 &&
      this._selectedTemplateIds.size > 0
    );
  }

  private async _save(): Promise<void> {
    if (!this._isValid) return;
    this._saving = true;
    try {
      const odometer = Number(this._odometer) || 0;
      const selected = this.templates.filter((t) => this._selectedTemplateIds.has(t.id));
      for (const template of selected) {
        await garageApi.completeMaintenance(this.hass, {
          vehicle_id: this._vehicleId,
          template_id: template.id,
          name: template.name,
          date: this._date,
          odometer,
          notes: "Logged via Log All Maintenance",
        });
      }
      this._close();
    } finally {
      this._saving = false;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("log-all-maintenance-dialog-closed"));
  }

  render() {
    return html`
      <garage-dialog
        description="Record several completed service items with one date and odometer reading."
        icon="mdi:clipboard-check-outline"
        heading="Log All Maintenance"
        .open=${this.open}
        @garage-dialog-closed=${this._close}
      >
        <label for="vehicle">Vehicle</label>
        <select id="vehicle"
          .value=${this._vehicleId}
          @change=${(e: Event) => this._onVehicleChange((e.target as HTMLSelectElement).value)}
        >
          ${this.vehicles.map((v) => html`<option value=${v.vehicleId}>${v.nickname}</option>`)}
        </select>

        <div class="row">
          <div>
            <label for="date">Date</label>
            <input id="date"
              type="date"
              .value=${this._date}
              @input=${(e: InputEvent) => (this._date = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="odometer">Odometer</label>
            <input id="odometer"
              type="number"
              .value=${this._odometer}
              @input=${(e: InputEvent) => (this._odometer = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <label>Items to mark done</label>
        <div class="template-list">
          ${this.templates.map(
            (t) => html`
              <label class="template-row">
                <input
                  type="checkbox"
                  .checked=${this._selectedTemplateIds.has(t.id)}
                  @change=${(e: Event) =>
                    this._toggleTemplate(t.id, (e.target as HTMLInputElement).checked)}
                />
                ${t.name}
              </label>
            `
          )}
        </div>

        <div class="actions" slot="footer">
          <button class="secondary" @click=${this._close}>Cancel</button>
          <button class="primary" ?disabled=${this._saving || !this._isValid} @click=${this._save}>
            ${this._saving ? "Logging..." : "Log Selected"}
          </button>
        </div>
      </garage-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-log-all-maintenance-dialog": GarageLogAllMaintenanceDialog;
  }
}
