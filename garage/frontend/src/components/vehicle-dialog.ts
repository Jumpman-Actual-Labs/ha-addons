import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HaDeviceLinks, HaSensorSummary, HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { Driver, TirePosition, Vehicle } from "../types";
import { formStyles } from "../styles";
import "./garage-dialog";

const TIRES: Array<[TirePosition, string]> = [
  ["fl", "Front left"],
  ["fr", "Front right"],
  ["rl", "Rear left"],
  ["rr", "Rear right"],
];

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
  @state() private _gearEntityId = "";
  @state() private _tireEntityIds: Partial<Record<TirePosition, string>> = {};
  @state() private _tireTargetPsi = "";
  @state() private _troubleCodesEntityId = "";
  @state() private _haSensors: HaSensorSummary[] = [];
  @state() private _haDevices: HaDeviceLinks[] = [];
  @state() private _linkedDeviceNote = "";
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
      this._gearEntityId = v?.gearEntityId ?? "";
      this._tireEntityIds = { ...(v?.tireEntityIds ?? {}) };
      this._tireTargetPsi = v?.tireTargetPsi != null ? String(v.tireTargetPsi) : "";
      this._troubleCodesEntityId = v?.troubleCodesEntityId ?? "";
      garageApi.listHaSensors().then((sensors) => (this._haSensors = sensors));
      garageApi.listHaDevices().then((devices) => (this._haDevices = devices));
      this._linkedDeviceNote = "";
      this._photoPath = v?.photoPath ?? null;
      this._photoError = "";
    }
    this._lastOpen = this.open;
    this._lastVehicleId = vehicleId;
    // Lit sets a select's .value before rendering its options, so a link
    // whose option is new (a device just picked, the sensor list arriving)
    // shows blank - set it again now the options exist.
    const links: Record<string, string> = {
      "odometer-entity": this._odometerEntityId,
      "fuel-level-entity": this._fuelLevelEntityId,
      "gear-entity": this._gearEntityId,
      "trouble-codes-entity": this._troubleCodesEntityId,
      ...Object.fromEntries(TIRES.map(([p]) => [`tire-${p}`, this._tireEntityIds[p] ?? ""])),
    };
    for (const [id, value] of Object.entries(links)) {
      const select = this.renderRoot.querySelector<HTMLSelectElement>(`#${id}`);
      if (select && select.value !== value) select.value = value;
    }
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
        gear_entity_id: this._gearEntityId,
        tire_entity_ids: Object.fromEntries(
          Object.entries(this._tireEntityIds).filter(([, entityId]) => entityId)
        ),
        tire_target_psi: this._tireTargetPsi ? Number(this._tireTargetPsi) : null,
        trouble_codes_entity_id: this._troubleCodesEntityId,
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

  /** Sensors that look like the right kind (by unit, or a word in the name
   * for unitless ones like gear), the linked one even if it doesn't, and
   * every candidate if nothing matches. Number-only links (odometer, fuel,
   * tires) only offer numeric sensors. */
  private _sensorOptions(units: string[], linked: string, keywords: string[] = [], numeric = true) {
    const pool = this._haSensors.filter((s) => !numeric || s.numeric);
    const matching = pool.filter(
      (s) =>
        units.includes(s.unit.toLowerCase()) ||
        keywords.some((k) => `${s.entityId} ${s.name}`.toLowerCase().includes(k)) ||
        s.entityId === linked
    );
    const options = matching.some((s) => s.entityId !== linked) ? matching : pool;
    const known = options.some((s) => s.entityId === linked);
    return html`
      <option value="" ?selected=${!linked}>Not linked</option>
      ${linked && !known ? html`<option value=${linked} selected>${linked}</option>` : ""}
      ${options.map(
        // `selected` on the option, not just the select's .value: the
        // sensor list arrives after the select first renders, and .value
        // set before its option exists falls back to "Not linked".
        (s) => html`<option value=${s.entityId} ?selected=${s.entityId === linked}>
          ${s.name} (${s.state === "unavailable" || s.state === "unknown" ? s.state : `${s.state} ${s.unit}`.trim()})
        </option>`
      )}
    `;
  }

  /** Fills every sensor link the device has a match for; links it has
   * nothing for are left as they were. */
  private _linkDevice(deviceId: string): void {
    const device = this._haDevices.find((d) => d.deviceId === deviceId);
    if (!device) return;
    const { links } = device;
    if (links.odometer_entity_id) this._odometerEntityId = links.odometer_entity_id;
    if (links.fuel_level_entity_id) this._fuelLevelEntityId = links.fuel_level_entity_id;
    if (links.gear_entity_id) this._gearEntityId = links.gear_entity_id;
    if (links.trouble_codes_entity_id) this._troubleCodesEntityId = links.trouble_codes_entity_id;
    this._tireEntityIds = { ...this._tireEntityIds, ...links.tire_entity_ids };
    const missing = [
      !links.odometer_entity_id && "odometer",
      !links.fuel_level_entity_id && "fuel level",
      !links.gear_entity_id && "gear",
      Object.keys(links.tire_entity_ids).length < 4 && "tires",
      !links.trouble_codes_entity_id && "trouble codes",
    ].filter(Boolean);
    this._linkedDeviceNote =
      `Linked ${device.linkCount} sensor${device.linkCount === 1 ? "" : "s"} from ${device.name}.` +
      (missing.length ? ` Not found on it: ${missing.join(", ")} - pick those below if they're elsewhere.` : "");
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
        ${this._haDevices.length
          ? html`<label for="link-device">Link a device</label>
              <select id="link-device"
                @change=${(e: Event) => {
                  this._linkDevice((e.target as HTMLSelectElement).value);
                  (e.target as HTMLSelectElement).value = "";
                }}
              >
                <option value="" selected>Choose a device to fill in its sensors…</option>
                ${this._haDevices.map(
                  (d) => html`<option value=${d.deviceId}>
                    ${d.name}${d.model ? ` (${d.model})` : ""} · ${d.linkCount} sensor${d.linkCount === 1 ? "" : "s"}
                  </option>`
                )}
              </select>
              ${this._linkedDeviceNote
                ? html`<div style="color: var(--secondary-text-color); font-size: 0.75rem;">${this._linkedDeviceNote}</div>`
                : ""}`
          : ""}
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
        <div class="row">
          <div>
            <label for="gear-entity">Gear sensor</label>
            <select id="gear-entity"
              .value=${this._gearEntityId}
              @change=${(e: Event) => (this._gearEntityId = (e.target as HTMLSelectElement).value)}
            >
              ${this._sensorOptions([], this._gearEntityId, ["gear"], false)}
            </select>
          </div>
          <div>
            <label for="trouble-codes-entity">Trouble codes sensor</label>
            <select id="trouble-codes-entity"
              .value=${this._troubleCodesEntityId}
              @change=${(e: Event) => (this._troubleCodesEntityId = (e.target as HTMLSelectElement).value)}
            >
              ${this._sensorOptions([], this._troubleCodesEntityId, ["trouble", "dtc", "code"], false)}
            </select>
          </div>
        </div>
        <div style="color: var(--secondary-text-color); font-size: 0.75rem;">
          With a gear sensor, fuel only counts in a drive gear and shifting into
          Park ends a trip, so fill-ups are caught even on a quick stop. A
          trouble codes sensor's state lists the active codes (or "All clear").
        </div>
        <div class="row">
          ${TIRES.map(
            ([position, label]) => html`<div>
              <label for=${`tire-${position}`}>${label} tire</label>
              <select id=${`tire-${position}`}
                .value=${this._tireEntityIds[position] ?? ""}
                @change=${(e: Event) =>
                  (this._tireEntityIds = {
                    ...this._tireEntityIds,
                    [position]: (e.target as HTMLSelectElement).value,
                  })}
              >
                ${this._sensorOptions(["psi", "kpa", "bar"], this._tireEntityIds[position] ?? "")}
              </select>
            </div>`
          )}
        </div>
        <label for="tire-target">Target tire pressure (psi)</label>
        <input id="tire-target" type="number" min="0" step="1" placeholder="From the door jamb sticker"
          .value=${this._tireTargetPsi}
          @input=${(e: InputEvent) => (this._tireTargetPsi = (e.target as HTMLInputElement).value)} />

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
