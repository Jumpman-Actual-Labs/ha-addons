import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { MaintenanceTemplate, Vehicle, WheelPosition } from "../types";
import { formStyles } from "../styles";
import "./garage-dialog";
import "./wheel-selector";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@customElement("garage-maintenance-dialog")
export class GarageMaintenanceDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) vehicles: Vehicle[] = [];
  @property({ attribute: false }) templates: MaintenanceTemplate[] = [];
  @property({ type: String }) vehicleId = "";
  @property({ type: String }) templateId = "";

  @state() private _vehicleId = "";
  @state() private _templateId = "";
  @state() private _name = "";
  @state() private _date = todayIso();
  @state() private _odometer = "";
  @state() private _cost = "";
  @state() private _partsCost = "";
  @state() private _laborCost = "";
  @state() private _performedBy = "shop";
  @state() private _shopName = "";
  @state() private _wheelPositions: WheelPosition[] = [];
  @state() private _notes = "";
  @state() private _saving = false;

  private _lastOpen = false;

  static styles = [formStyles];

  updated(): void {
    if (this.open && !this._lastOpen) {
      this._vehicleId = this.vehicleId || this.vehicles[0]?.vehicleId || "";
      this._templateId = this.templateId;
      const template = this.templates.find((t) => t.id === this._templateId);
      this._name = template?.name ?? "";
      this._date = todayIso();
      this._odometer = "";
      this._cost = "";
      this._partsCost = "";
      this._laborCost = "";
      this._performedBy = "shop";
      this._shopName = "";
      this._wheelPositions = [];
      this._notes = "";
    }
    this._lastOpen = this.open;
  }

  private get _selectedVehicle(): Vehicle | undefined {
    return this.vehicles.find((v) => v.vehicleId === this._vehicleId);
  }

  private get _isNewTires(): boolean {
    // Deliberately narrower than "any tire-related name" - Tire Rotation
    // doesn't involve replacing wheels, so it shouldn't show this picker.
    return this._name.toLowerCase().includes("new tire");
  }

  private _onTemplateChange(id: string): void {
    this._templateId = id;
    const template = this.templates.find((t) => t.id === id);
    if (template) this._name = template.name;
    if (!this._isNewTires) this._wheelPositions = [];
  }

  private _onNameInput(value: string): void {
    this._name = value;
    if (!this._isNewTires) this._wheelPositions = [];
  }

  private get _isValid(): boolean {
    return (
      !!this._vehicleId && !!this._name.trim() && !!this._date && (Number(this._odometer) || 0) >= 0
    );
  }

  private async _save(): Promise<void> {
    if (!this._isValid) return;
    this._saving = true;
    try {
      await garageApi.completeMaintenance(this.hass, {
        vehicle_id: this._vehicleId,
        template_id: this._templateId || null,
        name: this._name.trim(),
        date: this._date,
        odometer: Number(this._odometer) || 0,
        cost: Number(this._cost) || 0,
        parts_cost: Number(this._partsCost) || 0,
        labor_cost: Number(this._laborCost) || 0,
        performed_by: this._performedBy,
        shop_name: this._shopName.trim(),
        wheel_positions: this._wheelPositions,
        notes: this._notes.trim(),
      });
      this._close();
    } finally {
      this._saving = false;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("maintenance-dialog-closed"));
  }

  render() {
    return html`
      <garage-dialog
        description="Build a complete service record for your vehicle."
        icon="mdi:wrench-outline"
        heading="Log Completed Maintenance"
        .open=${this.open}
        @garage-dialog-closed=${this._close}
      >
        <label for="vehicle">Vehicle</label>
        <select id="vehicle"
          .value=${this._vehicleId}
          @change=${(e: Event) => (this._vehicleId = (e.target as HTMLSelectElement).value)}
        >
          ${this.vehicles.map((v) => html`<option value=${v.vehicleId}>${v.nickname}</option>`)}
        </select>

        <label for="type-template-optional">Type (template, optional)</label>
        <select id="type-template-optional"
          .value=${this._templateId}
          @change=${(e: Event) => this._onTemplateChange((e.target as HTMLSelectElement).value)}
        >
          <option value="">Custom / other</option>
          ${this.templates.map((t) => html`<option value=${t.id}>${t.name}</option>`)}
        </select>

        <label for="name">Name</label>
        <input id="name"
          type="text"
          .value=${this._name}
          @input=${(e: InputEvent) => this._onNameInput((e.target as HTMLInputElement).value)}
        />

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

        <div class="row">
          <div>
            <label for="total-cost">Total Cost</label>
            <input id="total-cost"
              type="number"
              step="0.01"
              .value=${this._cost}
              @input=${(e: InputEvent) => (this._cost = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="parts-cost">Parts Cost</label>
            <input id="parts-cost"
              type="number"
              step="0.01"
              .value=${this._partsCost}
              @input=${(e: InputEvent) => (this._partsCost = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="labor-cost">Labor Cost</label>
            <input id="labor-cost"
              type="number"
              step="0.01"
              .value=${this._laborCost}
              @input=${(e: InputEvent) => (this._laborCost = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="row">
          <div>
            <label for="diy-or-shop">DIY or Shop</label>
            <select id="diy-or-shop"
              .value=${this._performedBy}
              @change=${(e: Event) => (this._performedBy = (e.target as HTMLSelectElement).value)}
            >
              <option value="shop">Shop</option>
              <option value="diy">DIY</option>
            </select>
          </div>
          <div>
            <label for="shop-name">Shop Name</label>
            <input id="shop-name"
              type="text"
              .value=${this._shopName}
              @input=${(e: InputEvent) => (this._shopName = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        ${this._isNewTires
          ? html`
              <label>Wheels Serviced</label>
              <garage-wheel-selector
                .selected=${this._wheelPositions}
                .drivetrain=${this._selectedVehicle?.drivetrain ?? "fwd"}
                @wheels-changed=${(e: CustomEvent<WheelPosition[]>) =>
                  (this._wheelPositions = e.detail)}
              ></garage-wheel-selector>
            `
          : ""}

        <label for="notes">Notes</label>
        <input id="notes"
          type="text"
          .value=${this._notes}
          @input=${(e: InputEvent) => (this._notes = (e.target as HTMLInputElement).value)}
        />

        <div class="actions" slot="footer">
          <button class="secondary" @click=${this._close}>Cancel</button>
          <button class="primary" ?disabled=${this._saving || !this._isValid} @click=${this._save}>
            Save
          </button>
        </div>
      </garage-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-maintenance-dialog": GarageMaintenanceDialog;
  }
}
