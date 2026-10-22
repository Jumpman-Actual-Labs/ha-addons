import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { Vehicle } from "../types";
import { formStyles } from "../styles";
import "./garage-dialog";

@customElement("garage-document-upload-dialog")
export class GarageDocumentUploadDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) vehicles: Vehicle[] = [];
  @property({ type: String }) vehicleId = "";

  @state() private _vehicleId = "";
  @state() private _category = "registration";
  @state() private _file: File | null = null;
  @state() private _saving = false;
  @state() private _error = "";

  private _lastOpen = false;

  static styles = [formStyles];

  updated(): void {
    if (this.open && !this._lastOpen) {
      this._vehicleId = this.vehicleId || this.vehicles[0]?.vehicleId || "";
      this._category = "registration";
      this._file = null;
      this._error = "";
    }
    this._lastOpen = this.open;
  }

  private get _isValid(): boolean {
    return !!this._vehicleId && !!this._file;
  }

  private async _save(): Promise<void> {
    if (!this._isValid || !this._file) return;
    this._saving = true;
    this._error = "";
    try {
      await garageApi.uploadDocument(this.hass, this._vehicleId, this._category, this._file);
      this._close();
    } catch (e) {
      this._error = "Upload failed. Please try again.";
    } finally {
      this._saving = false;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("document-upload-dialog-closed"));
  }

  render() {
    return html`
      <garage-dialog
        description="Keep registration, insurance and supporting records with the right vehicle."
        icon="mdi:file-document-outline"
        heading="Upload Document"
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

        <label for="category">Category</label>
        <select id="category"
          .value=${this._category}
          @change=${(e: Event) => (this._category = (e.target as HTMLSelectElement).value)}
        >
          <option value="registration">Registration</option>
          <option value="insurance">Insurance Card</option>
          <option value="receipt">Receipt</option>
          <option value="photo">Photo</option>
          <option value="other">Other</option>
        </select>

        <label for="file">File</label>
        <input id="file"
          type="file"
          @change=${(e: Event) =>
            (this._file = (e.target as HTMLInputElement).files?.[0] ?? null)}
        />

        ${this._error ? html`<div style="color: var(--error-color, #c62828);">${this._error}</div>` : ""}

        <div class="actions" slot="footer">
          <button class="secondary" @click=${this._close}>Cancel</button>
          <button class="primary" ?disabled=${this._saving || !this._isValid} @click=${this._save}>
            Upload
          </button>
        </div>
      </garage-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-document-upload-dialog": GarageDocumentUploadDialog;
  }
}
