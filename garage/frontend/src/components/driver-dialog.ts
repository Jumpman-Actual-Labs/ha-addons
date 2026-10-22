import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HaUserSummary, HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import { formStyles } from "../styles";
import "./garage-dialog";

@customElement("garage-driver-dialog")
export class GarageDriverDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;

  @state() private _name = "";
  @state() private _haUserId = "";
  @state() private _notifyTarget = "";
  @state() private _haUsers: HaUserSummary[] = [];
  @state() private _saving = false;

  private _lastOpen = false;

  static styles = [formStyles];

  updated(): void {
    if (this.open && !this._lastOpen) {
      this._name = "";
      this._haUserId = "";
      this._notifyTarget = "";
      garageApi.listHaUsers().then((users) => (this._haUsers = users));
    }
    this._lastOpen = this.open;
  }

  private get _isValid(): boolean {
    return !!this._name.trim();
  }

  private async _save(): Promise<void> {
    if (!this._isValid) return;
    this._saving = true;
    try {
      await garageApi.addDriver(
        this.hass,
        this._name.trim(),
        this._haUserId || undefined,
        this._notifyTarget.trim() || undefined
      );
      this._close();
    } finally {
      this._saving = false;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("driver-dialog-closed"));
  }

  render() {
    return html`
      <garage-dialog icon="mdi:account-outline" description="Add a driver and link their account or reminder destination." heading="Add Driver" .open=${this.open} @garage-dialog-closed=${this._close}>
        <label for="name">Name</label>
        <input id="name"
          type="text"
          .value=${this._name}
          @input=${(e: InputEvent) => (this._name = (e.target as HTMLInputElement).value)}
        />

        <label for="linked-ha-user-optional">Linked HA User (optional)</label>
        <select id="linked-ha-user-optional"
          .value=${this._haUserId}
          @change=${(e: Event) => (this._haUserId = (e.target as HTMLSelectElement).value)}
        >
          <option value="">None</option>
          ${this._haUsers.map((u) => html`<option value=${u.id}>${u.name}</option>`)}
        </select>

        <label for="notify-target-optional-e-g-notify-mobile-app-x">Notify Target (optional, e.g. notify.mobile_app_x)</label>
        <input id="notify-target-optional-e-g-notify-mobile-app-x"
          type="text"
          .value=${this._notifyTarget}
          @input=${(e: InputEvent) => (this._notifyTarget = (e.target as HTMLInputElement).value)}
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
    "garage-driver-dialog": GarageDriverDialog;
  }
}
