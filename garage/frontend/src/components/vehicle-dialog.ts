import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HaSensorSummary, HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { Driver, Vehicle } from "../types";
import { formStyles } from "../styles";
import "./garage-dialog";

@customElement("garage-vehicle-dialog")
export class GarageVehicleDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) vehicle: Vehicle | null = null;
  @property({ attribute: false }) drivers: Driver[] = [];

  @state() private _nickname = "";
  @state() private _year = "";
  @state() private _make = "";
  @state() private _model = "";
  @state() private _trim = "";
  @state() private _drivetrain = "fwd";
  @state() private _titleNumber = "";
  @state() private _vin = "";
  @state() private _licensePlate = "";
  @state() private _color = "";
  @state() private _currentMileage = "";
  @state() private _fuelType = "gasoline";
  @state() private _tankCapacityGal = "";
  @state() private _oilCapacityQt = "";
  @state() private _tireSize = "";
  @state() private _status = "active";
  @state() private _currentFuelPct = "";
  @state() private _registrationExpires = "";
  @state() private _insuranceExpires = "";
  @state() private _primaryDriverId = "";
  @state() private _notes = "";
  @state() private _odometerEntityId = "";
  @state() private _fuelLevelEntityId = "";
  @state() private _haSensors: HaSensorSummary[] = [];
  @state() private _saving = false;
  @state() private _photoPath: string | null = null;
  @state() private _photoUploading = false;
  @state() private _photoError = "";
  @state() private _decodingVin = false;
  @state() private _vinDecodeError = "";

  private _lastOpen = false;
  private _lastVehicleId: string | null = null;

  static styles = [formStyles];

  updated(): void {
    const vehicleId = this.vehicle?.vehicleId ?? null;
    if ((this.open && !this._lastOpen) || vehicleId !== this._lastVehicleId) {
      const v = this.vehicle;
      this._nickname = v?.nickname ?? "";
      this._year = v ? String(v.year) : "";
      this._make = v?.make ?? "";
      this._model = v?.model ?? "";
      this._trim = v?.trim ?? "";
      this._drivetrain = v?.drivetrain ?? "fwd";
      this._titleNumber = v?.titleNumber ?? "";
      this._vin = v?.vin ?? "";
      this._licensePlate = v?.licensePlate ?? "";
      this._color = v?.color ?? "";
      this._currentMileage = v ? String(v.currentMileage) : "";
      this._fuelType = v?.fuelType ?? "gasoline";
      this._tankCapacityGal = v?.tankCapacityGal != null ? String(v.tankCapacityGal) : "";
      this._oilCapacityQt = v?.oilCapacityQt != null ? String(v.oilCapacityQt) : "";
      this._tireSize = v?.tireSize ?? "";
      this._status = v?.status ?? "active";
      this._currentFuelPct = v?.currentFuelPct != null ? String(v.currentFuelPct) : "";
      this._registrationExpires = v?.registrationExpires ?? "";
      this._insuranceExpires = v?.insuranceExpires ?? "";
      this._primaryDriverId = v?.primaryDriverId ?? "";
      this._notes = v?.notes ?? "";
      this._odometerEntityId = v?.odometerEntityId ?? "";
      this._fuelLevelEntityId = v?.fuelLevelEntityId ?? "";
      garageApi.listHaSensors().then((sensors) => (this._haSensors = sensors));
      this._photoPath = v?.photoPath ?? null;
      this._photoError = "";
    }
    this._lastOpen = this.open;
    this._lastVehicleId = vehicleId;
  }

  private async _decodeVin(): Promise<void> {
    const vin = this._vin.trim();
    if (!vin) return;
    this._decodingVin = true;
    this._vinDecodeError = "";
    try {
      const result = await garageApi.decodeVin(this.hass, vin);
      if (result.year != null) this._year = String(result.year);
      if (result.make) this._make = result.make;
      if (result.model) this._model = result.model;
      if (result.trim) this._trim = result.trim;
      if (result.drivetrain) this._drivetrain = result.drivetrain;
      if (result.fuel_type) this._fuelType = result.fuel_type;
      if (result.tank_capacity_gal != null) {
        this._tankCapacityGal = String(result.tank_capacity_gal);
      }
      if (result.oil_capacity_qt != null) {
        this._oilCapacityQt = String(result.oil_capacity_qt);
      }
    } catch (err) {
      this._vinDecodeError = err instanceof Error ? err.message : "VIN decode failed";
    } finally {
      this._decodingVin = false;
    }
  }

  private async _uploadPhoto(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file || !this.vehicle) return;
    this._photoUploading = true;
    this._photoError = "";
    try {
      this._photoPath = await garageApi.uploadVehiclePhoto(this.hass, this.vehicle.vehicleId, file);
    } catch (err) {
      this._photoError = "Photo upload failed. Please try again.";
    } finally {
      this._photoUploading = false;
    }
  }

  private get _isValid(): boolean {
    return !!this._nickname.trim() && !!this._year && !!this._make.trim() && !!this._model.trim();
  }

  private async _save(): Promise<void> {
    if (!this._isValid) return;
    this._saving = true;
    try {
      const fields: Record<string, unknown> = {
        nickname: this._nickname.trim(),
        year: Number(this._year),
        make: this._make.trim(),
        model: this._model.trim(),
        trim: this._trim.trim(),
        drivetrain: this._drivetrain,
        current_mileage: Number(this._currentMileage) || 0,
        fuel_type: this._fuelType,
        status: this._status,
        registration_expires: this._registrationExpires || null,
        insurance_expires: this._insuranceExpires || null,
        primary_driver_id: this._primaryDriverId || null,
        // Sent unconditionally (even when blank) so clearing a previously
        // set value actually takes effect, rather than silently keeping the
        // old one because an empty field was omitted from the payload.
        vin: this._vin.trim(),
        title_number: this._titleNumber.trim(),
        license_plate: this._licensePlate.trim(),
        color: this._color.trim(),
        tire_size: this._tireSize.trim(),
        notes: this._notes.trim(),
        odometer_entity_id: this._odometerEntityId,
        fuel_level_entity_id: this._fuelLevelEntityId,
      };
      if (this._tankCapacityGal) fields.tank_capacity_gal = Number(this._tankCapacityGal);
      if (this._oilCapacityQt) fields.oil_capacity_qt = Number(this._oilCapacityQt);
      if (this._currentFuelPct) fields.current_fuel_pct = Number(this._currentFuelPct);

      if (this.vehicle) {
        await garageApi.editVehicle(this.hass, this.vehicle.vehicleId, fields);
      } else {
        await garageApi.addVehicle(this.hass, fields);
      }
      this._close();
    } finally {
      this._saving = false;
    }
  }

  /** Sensors that look like the right kind (by unit), the linked one even if
   * it doesn't, and every numeric sensor if nothing matches the unit. */
  private _sensorOptions(units: string[], linked: string) {
    const matching = this._haSensors.filter(
      (s) => units.includes(s.unit.toLowerCase()) || s.entityId === linked
    );
    const options = matching.some((s) => s.entityId !== linked) ? matching : this._haSensors;
    const known = options.some((s) => s.entityId === linked);
    return html`
      <option value="">Not linked</option>
      ${linked && !known ? html`<option value=${linked}>${linked}</option>` : ""}
      ${options.map(
        (s) => html`<option value=${s.entityId}>
          ${s.name} (${s.state === "unavailable" || s.state === "unknown" ? s.state : `${s.state} ${s.unit}`.trim()})
        </option>`
      )}
    `;
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("vehicle-dialog-closed"));
  }

  render() {
    return html`
      <garage-dialog
        description="Vehicle specifications, ownership and reminders in one record."
        icon="mdi:car-outline"
        .wide=${true}
        heading=${this.vehicle ? "Edit Vehicle" : "Add Vehicle"}
        .open=${this.open}
        @garage-dialog-closed=${this._close}
      >
        ${this.vehicle
          ? html`
              <label for="vehicle-photo">Photo</label>
              ${this._photoPath
                ? html`<img
                    alt="Vehicle photo"
                    src=${this._photoPath}
                    style="width:100%; max-height:160px; object-fit:cover; border-radius:8px; margin-bottom:8px;"
                  />`
                : ""}
              <input id="vehicle-photo" type="file" accept="image/*" @change=${this._uploadPhoto} />
              ${this._photoUploading ? html`<div>Uploading...</div>` : ""}
              ${this._photoError
                ? html`<div style="color: var(--error-color, #c62828);">${this._photoError}</div>`
                : ""}
            `
          : html`<div style="color: var(--secondary-text-color); font-size: 0.8rem;">
              Save the vehicle first, then edit it to add a photo.
            </div>`}

        <h3 class="form-section">Vehicle details</h3>
        <label for="nickname">Nickname</label>
        <input id="nickname"
          type="text"
          placeholder="e.g. The Ram"
          .value=${this._nickname}
          @input=${(e: InputEvent) => (this._nickname = (e.target as HTMLInputElement).value)}
        />

        <div class="row">
          <div>
            <label for="year">Year</label>
            <input id="year"
              type="number"
              .value=${this._year}
              @input=${(e: InputEvent) => (this._year = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="make">Make</label>
            <input id="make"
              type="text"
              .value=${this._make}
              @input=${(e: InputEvent) => (this._make = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="model">Model</label>
            <input id="model"
              type="text"
              .value=${this._model}
              @input=${(e: InputEvent) => (this._model = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="row">
          <div>
            <label for="trim">Trim</label>
            <input id="trim"
              type="text"
              .value=${this._trim}
              @input=${(e: InputEvent) => (this._trim = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="color">Color</label>
            <input id="color"
              type="text"
              .value=${this._color}
              @input=${(e: InputEvent) => (this._color = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="drivetrain">Drivetrain</label>
            <select id="drivetrain"
              .value=${this._drivetrain}
              @change=${(e: Event) => (this._drivetrain = (e.target as HTMLSelectElement).value)}
            >
              <option value="fwd">FWD</option>
              <option value="rwd">RWD</option>
              <option value="awd">AWD</option>
              <option value="4wd">4WD</option>
            </select>
          </div>
        </div>

        <div class="row">
          <div>
            <label for="vin">VIN</label>
            <div style="display:flex; gap:8px; align-items:flex-start;">
              <input
                type="text"
                id="vin"
                style="flex:1;"
                .value=${this._vin}
                @input=${(e: InputEvent) => (this._vin = (e.target as HTMLInputElement).value)}
              />
              <button
                class="secondary"
                type="button"
                style="white-space:nowrap;"
                ?disabled=${this._decodingVin || !this._vin.trim()}
                @click=${this._decodeVin}
              >
                ${this._decodingVin ? "Decoding..." : "Decode VIN"}
              </button>
            </div>
          </div>
          <div>
            <label for="license-plate">License Plate</label>
            <input id="license-plate"
              type="text"
              .value=${this._licensePlate}
              @input=${(e: InputEvent) => (this._licensePlate = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>
        ${this._vinDecodeError
          ? html`<div style="color: var(--error-color, #c62828); font-size: 0.8rem;">
              ${this._vinDecodeError}
            </div>`
          : ""}

        <h3 class="form-section">Fuel & specifications</h3>
        <div class="row">
          <div>
            <label for="current-mileage">Current Mileage</label>
            <input id="current-mileage"
              type="number"
              .value=${this._currentMileage}
              @input=${(e: InputEvent) => (this._currentMileage = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="fuel-type">Fuel Type</label>
            <select id="fuel-type"
              .value=${this._fuelType}
              @change=${(e: Event) => (this._fuelType = (e.target as HTMLSelectElement).value)}
            >
              <option value="gasoline">Gasoline</option>
              <option value="diesel">Diesel</option>
              <option value="electric">Electric</option>
              <option value="hybrid">Hybrid</option>
              <option value="flex">Flex</option>
            </select>
          </div>
        </div>

        <div class="row">
          <div>
            <label for="tank-capacity-gal">Tank Capacity (gal)</label>
            <input id="tank-capacity-gal"
              type="number"
              step="0.1"
              .value=${this._tankCapacityGal}
              @input=${(e: InputEvent) => (this._tankCapacityGal = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="current-fuel">Current Fuel %</label>
            <input id="current-fuel"
              type="number"
              min="0"
              max="1"
              step="0.01"
              .value=${this._currentFuelPct}
              @input=${(e: InputEvent) => (this._currentFuelPct = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="row">
          <div>
            <label for="oil-capacity-qt">Oil Capacity (qt)</label>
            <input id="oil-capacity-qt"
              type="number"
              step="0.1"
              .value=${this._oilCapacityQt}
              @input=${(e: InputEvent) => (this._oilCapacityQt = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="tire-size">Tire Size</label>
            <input id="tire-size"
              type="text"
              placeholder="e.g. 275/60R20"
              .value=${this._tireSize}
              @input=${(e: InputEvent) => (this._tireSize = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>
        <div style="color: var(--secondary-text-color); font-size: 0.75rem; margin-top: -4px;">
          Tank/oil capacity from Decode VIN are AI estimates, not from an
          official spec database - double-check against your owner's manual.
        </div>

        <h3 class="form-section">Live sensors</h3>
        <div style="color: var(--secondary-text-color); font-size: 0.75rem;">
          Link Home Assistant sensors (e.g. a WiCAN OBD dongle's odometer and
          fuel tank level) and Garage keeps Current Mileage and Fuel % up to
          date on its own, about once a minute. Mileage only ever goes up.
        </div>
        <div class="row">
          <div>
            <label for="odometer-entity">Odometer sensor</label>
            <select id="odometer-entity"
              .value=${this._odometerEntityId}
              @change=${(e: Event) => (this._odometerEntityId = (e.target as HTMLSelectElement).value)}
            >
              ${this._sensorOptions(["mi", "km"], this._odometerEntityId)}
            </select>
          </div>
          <div>
            <label for="fuel-level-entity">Fuel level sensor</label>
            <select id="fuel-level-entity"
              .value=${this._fuelLevelEntityId}
              @change=${(e: Event) => (this._fuelLevelEntityId = (e.target as HTMLSelectElement).value)}
            >
              ${this._sensorOptions(["%"], this._fuelLevelEntityId)}
            </select>
          </div>
        </div>

        <h3 class="form-section">Ownership & reminders</h3>
        <label for="title-number">Title Number</label>
        <input id="title-number" type="text" .value=${this._titleNumber}
          @input=${(e: InputEvent) => (this._titleNumber = (e.target as HTMLInputElement).value)} />
        <div class="row">
          <div>
            <label for="status">Status</label>
            <select id="status"
              .value=${this._status}
              @change=${(e: Event) => (this._status = (e.target as HTMLSelectElement).value)}
            >
              <option value="active">Active</option>
              <option value="stored">Stored</option>
              <option value="sold">Sold</option>
              <option value="project">Project</option>
            </select>
          </div>
          <div>
            <label for="primary-driver">Primary Driver</label>
            <select id="primary-driver"
              .value=${this._primaryDriverId}
              @change=${(e: Event) => (this._primaryDriverId = (e.target as HTMLSelectElement).value)}
            >
              <option value="">None</option>
              ${this.drivers.map((d) => html`<option value=${d.id}>${d.name}</option>`)}
            </select>
          </div>
        </div>

        <div class="row">
          <div>
            <label for="registration-expires">Registration Expires</label>
            <input id="registration-expires"
              type="date"
              .value=${this._registrationExpires}
              @input=${(e: InputEvent) => (this._registrationExpires = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="insurance-expires">Insurance Expires</label>
            <input id="insurance-expires"
              type="date"
              .value=${this._insuranceExpires}
              @input=${(e: InputEvent) => (this._insuranceExpires = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

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
    "garage-vehicle-dialog": GarageVehicleDialog;
  }
}
