import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { FuelEntry, Vehicle } from "../types";
import { formStyles } from "../styles";
import "./garage-dialog";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@customElement("garage-fuel-dialog")
export class GarageFuelDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) vehicles: Vehicle[] = [];
  @property({ type: String }) vehicleId = "";
  @property({ attribute: false }) entry: FuelEntry | null = null;

  @state() private _vehicleId = "";
  @state() private _date = todayIso();
  @state() private _odometer = "";
  @state() private _amountDollars = "";
  @state() private _fuelGrade = "regular";
  @state() private _station = "";
  @state() private _paymentMethod = "credit_card";
  @state() private _fullTank = true;
  @state() private _pricePerGallon = "";
  @state() private _gallons = "";
  @state() private _notes = "";
  @state() private _saving = false;
  @state() private _scanning = false;
  @state() private _scanError = "";

  private _lastOpen = false;
  private _lastEntryId: string | null = null;

  static styles = [
    formStyles,
    css`
      .vehicle-picker {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 10px;
      }
      .vehicle-tile {
        position: relative;
        aspect-ratio: 4 / 3;
        padding: 0;
        overflow: hidden;
        border-radius: 10px;
        border: 2px solid transparent;
        background: var(--secondary-background-color, #333);
        color: var(--secondary-text-color);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .vehicle-tile img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .vehicle-tile ha-icon {
        --mdc-icon-size: 40px;
        margin-bottom: 20px;
      }
      .vehicle-tile .vehicle-name {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 16px 8px 6px;
        background: linear-gradient(transparent, rgba(0, 0, 0, 0.75));
        color: #fff;
        font-size: 0.85rem;
        font-weight: 600;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .vehicle-tile:not(.selected) {
        opacity: 0.55;
      }
      .vehicle-tile.selected {
        border-color: var(--primary-color);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-color) 35%, transparent);
      }
      .vehicle-tile:disabled {
        cursor: default;
      }
    `,
  ];

  updated(): void {
    const entryId = this.entry?.id ?? null;
    if ((this.open && !this._lastOpen) || entryId !== this._lastEntryId) {
      const e = this.entry;
      this._vehicleId = e?.vehicleId || this.vehicleId || this.vehicles[0]?.vehicleId || "";
      this._date = e?.date ?? todayIso();
      this._odometer = e ? String(e.odometer) : "";
      this._amountDollars = e ? String(e.amountDollars) : "";
      this._fuelGrade = e?.fuelGrade ?? "regular";
      this._station = e?.station ?? "";
      this._paymentMethod = e?.paymentMethod ?? "credit_card";
      this._fullTank = e?.fullTank ?? true;
      this._pricePerGallon = e?.pricePerGallon != null ? String(e.pricePerGallon) : "";
      this._gallons = e?.gallonsAdded != null ? String(e.gallonsAdded) : "";
      this._notes = e?.notes ?? "";
    }
    this._lastOpen = this.open;
    this._lastEntryId = entryId;
  }

  private get _isValid(): boolean {
    return (
      !!this._vehicleId &&
      !!this._date &&
      (Number(this._odometer) || 0) > 0 &&
      (Number(this._amountDollars) || 0) > 0
    );
  }

  private async _save(): Promise<void> {
    if (!this._isValid) return;
    this._saving = true;
    try {
      const fields: Record<string, unknown> = {
        date: this._date,
        odometer: Number(this._odometer),
        amount_dollars: Number(this._amountDollars),
        fuel_grade: this._fuelGrade,
        station: this._station.trim(),
        payment_method: this._paymentMethod,
        full_tank: this._fullTank,
        notes: this._notes.trim(),
      };
      if (this._pricePerGallon) fields.price_per_gallon = Number(this._pricePerGallon);
      if (this._gallons) fields.gallons_added = Number(this._gallons);
      if (this.entry) {
        await garageApi.editFuelEntry(this.hass, this.entry.id, fields);
      } else {
        await garageApi.logFuel(this.hass, { vehicle_id: this._vehicleId, ...fields });
      }
      this._close();
    } finally {
      this._saving = false;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("fuel-dialog-closed"));
  }

  private async _scanPhoto(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!file) return;
    this._scanning = true;
    this._scanError = "";
    try {
      const result = await garageApi.analyzeFuelPhoto(this.hass, file);
      if (result.amount_dollars != null) this._amountDollars = String(result.amount_dollars);
      if (result.gallons != null) this._gallons = String(result.gallons);
      if (result.price_per_gallon != null) {
        this._pricePerGallon = String(result.price_per_gallon);
      }
    } catch (err) {
      this._scanError = err instanceof Error ? err.message : "Scan failed";
    } finally {
      this._scanning = false;
    }
  }

  render() {
    return html`
      <garage-dialog
        description="Record a fill-up to keep fuel level, economy and spending up to date."
        icon="mdi:gas-station-outline"
        heading=${this.entry ? "Edit Fuel Entry" : "Add Fuel"}
        .open=${this.open}
        @garage-dialog-closed=${this._close}
      >
        <label>Vehicle</label>
        <div class="vehicle-picker" role="group" aria-label="Choose a vehicle">
          ${this.vehicles.map(
            (v) => html`
              <button
                type="button"
                class="vehicle-tile ${v.vehicleId === this._vehicleId ? "selected" : ""}"
                aria-pressed=${v.vehicleId === this._vehicleId}
                ?disabled=${!!this.entry && v.vehicleId !== this._vehicleId}
                @click=${() => (this._vehicleId = v.vehicleId)}
              >
                ${v.photoPath
                  ? html`<img src=${v.photoPath} alt="" />`
                  : html`<ha-icon icon="mdi:car"></ha-icon>`}
                <span class="vehicle-name">${v.nickname}</span>
              </button>
            `
          )}
        </div>

        <h3 class="form-section">Pump &amp; payment</h3><label for="scan-pump-photo-optional">Scan Pump Photo (optional)</label>
        <input id="scan-pump-photo-optional" type="file" accept="image/*" capture="environment" @change=${this._scanPhoto} />
        ${this._scanning ? html`<div>Reading photo...</div>` : ""}
        ${this._scanError
          ? html`<div style="color: var(--error-color, #c62828);">${this._scanError}</div>`
          : ""}

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
            <label for="current-odometer">Current Odometer</label>
            <input id="current-odometer"
              type="number"
              .value=${this._odometer}
              @input=${(e: InputEvent) => (this._odometer = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="row">
          <div>
            <label for="dollar-amount">Dollar Amount</label>
            <input id="dollar-amount"
              type="number"
              step="0.01"
              .value=${this._amountDollars}
              @input=${(e: InputEvent) => (this._amountDollars = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="price-gallon-optional">Price/Gallon (optional)</label>
            <input id="price-gallon-optional"
              type="number"
              step="0.001"
              .value=${this._pricePerGallon}
              @input=${(e: InputEvent) => (this._pricePerGallon = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <label for="gallons-optional">Gallons (optional)</label>
        <input id="gallons-optional"
          type="number"
          step="0.001"
          .value=${this._gallons}
          @input=${(e: InputEvent) => (this._gallons = (e.target as HTMLInputElement).value)}
        />
        <div style="color: var(--secondary-text-color); font-size: 0.75rem; margin-top: -4px;">
          Enter gallons or price/gallon (or both) - the other is calculated automatically.
        </div>

        <div class="row">
          <div>
            <label for="fuel-grade">Fuel Grade</label>
            <select id="fuel-grade"
              .value=${this._fuelGrade}
              @change=${(e: Event) => (this._fuelGrade = (e.target as HTMLSelectElement).value)}
            >
              <option value="regular">Regular</option>
              <option value="midgrade">Midgrade</option>
              <option value="premium">Premium</option>
              <option value="diesel">Diesel</option>
              <option value="electric">Electric</option>
            </select>
          </div>
          <div>
            <label for="payment-method">Payment Method</label>
            <select id="payment-method"
              .value=${this._paymentMethod}
              @change=${(e: Event) => (this._paymentMethod = (e.target as HTMLSelectElement).value)}
            >
              <option value="credit_card">Credit Card</option>
              <option value="debit_card">Debit Card</option>
              <option value="cash">Cash</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <label for="fuel-station">Fuel Station</label>
        <input id="fuel-station"
          type="text"
          .value=${this._station}
          @input=${(e: InputEvent) => (this._station = (e.target as HTMLInputElement).value)}
        />

        <label>
          <input
            type="checkbox"
            style="width:auto;"
            .checked=${this._fullTank}
            @change=${(e: Event) => (this._fullTank = (e.target as HTMLInputElement).checked)}
          />
          Full tank
        </label>

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
    "garage-fuel-dialog": GarageFuelDialog;
  }
}
