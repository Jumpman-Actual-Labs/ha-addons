import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { GarageState } from "../types";
import { glassCardStyle, formStyles, pageStyles } from "../styles";

@customElement("garage-settings-view")
export class GarageSettingsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) garageState!: GarageState;

  @state() private _lowFuelThreshold = "";
  @state() private _financeSyncEnabled = false;
  @state() private _financeCategoryName = "";
  private _initialized = false;

  static styles = [glassCardStyle, formStyles, pageStyles, css`
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; align-items: start; }
    .settings-card { padding: 24px; }
    .card-heading { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
    .card-heading h2 { margin: 0; font-size: 1rem; }
    .card-heading p { margin: 3px 0 0; color: var(--garage-muted); font-size: .75rem; }
    .description { color: var(--garage-muted); font-size: .8rem; line-height: 1.8; }
    .threshold { display: flex; gap: 18px; align-items: center; margin: 16px 0; }
    input[type="range"] { border: 0; padding: 0; min-height: 24px; accent-color: var(--garage-accent); background: none; flex: 1; }
    .percent { display: flex; align-items: center; gap: 8px; font-family: var(--garage-mono); color: var(--garage-accent); }
    .percent input { width: 74px; text-align: center; padding: 10px 6px; font-family: var(--garage-mono); }
    .setting-note { border-top: 1px solid var(--garage-border); padding-top: 16px; color: var(--garage-muted); font-size: .75rem; line-height: 1.8; }
    .toggle-row { display: flex; align-items: center; gap: 14px; justify-content: space-between; padding: 18px 0; border-top: 1px solid var(--garage-border); border-bottom: 1px solid var(--garage-border); margin-bottom: 20px; }
    .toggle-row label { margin: 0; color: var(--garage-text); font-size: .82rem; }
    .toggle-row small { display: block; margin-top: 5px; color: var(--garage-muted); font-size: .73rem; }
    input.switch { appearance: none; width: 42px; height: 24px; border: 1px solid #626970; border-radius: 12px; background: var(--garage-raised); position: relative; cursor: pointer; }
    input.switch::before { content: ""; position: absolute; width: 16px; height: 16px; border-radius: 50%; background: var(--garage-muted); top: 3px; left: 3px; transition: transform 160ms ease; }
    input.switch:checked { background: #f6a45b25; border-color: var(--garage-accent); }
    input.switch:checked::before { background: var(--garage-accent); transform: translateX(18px); }
    .scan-card { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(220px, 1fr) minmax(0, 2fr); gap: 24px; }
    .scan-card .card-heading { align-items: flex-start; margin: 0; }
    code { color: var(--garage-accent); font-family: var(--garage-mono); font-size: .77rem; padding: 2px 5px; border-radius: 4px; background: var(--garage-inset); overflow-wrap: anywhere; }
    @media (max-width: 1050px) { .settings-grid, .scan-card { grid-template-columns: 1fr; } }
  `];

  willUpdate(): void {
    if (!this._initialized) {
      this._lowFuelThreshold = String(Math.round(this.garageState.settings.lowFuelThreshold * 100));
      this._financeSyncEnabled = this.garageState.settings.financeSyncEnabled;
      this._financeCategoryName = this.garageState.settings.financeCategoryName;
      this._initialized = true;
    }
  }

  private async _saveThreshold(): Promise<void> {
    const value = Number(this._lowFuelThreshold) / 100;
    if (!Number.isFinite(value) || value < 0 || value > 1) return;
    await garageApi.updateSettings(this.hass, { low_fuel_threshold: value });
  }

  private async _toggleFinanceSync(): Promise<void> {
    this._financeSyncEnabled = !this._financeSyncEnabled;
    await garageApi.updateSettings(this.hass, {
      finance_sync_enabled: this._financeSyncEnabled,
    });
  }

  private async _saveFinanceCategoryName(): Promise<void> {
    const name = this._financeCategoryName.trim();
    if (!name) return;
    await garageApi.updateSettings(this.hass, { finance_category_name: name });
  }

  render() {
    return html`
      <div class="settings-grid">
        <ha-card class="settings-card">
          <div class="card-heading"><span class="icon-tile"><ha-icon aria-hidden="true" icon="mdi:bell-outline"></ha-icon></span><div><h2>Smart reminders</h2><p>Stay ahead of fuel and service.</p></div></div>
          <p class="description">Choose the fuel level that should trigger a reminder for your drivers.</p>
          <label for="fuel-threshold">Low-fuel threshold</label>
          <div class="threshold">
            <input type="range" aria-label="Low-fuel threshold percentage" min="0" max="100" step="1" .value=${this._lowFuelThreshold} @input=${(e: Event) => (this._lowFuelThreshold = (e.target as HTMLInputElement).value)} @change=${this._saveThreshold} />
            <div class="percent"><input id="fuel-threshold" type="number" min="0" max="100" step="1" .value=${this._lowFuelThreshold} @input=${(e: Event) => (this._lowFuelThreshold = (e.target as HTMLInputElement).value)} @change=${this._saveThreshold} /><span>%</span></div>
          </div>
          <div class="setting-note">Drivers with a linked notification destination receive daily reminders at 8am for overdue maintenance and low fuel. Changes save automatically.</div>
        </ha-card>
        <ha-card class="settings-card">
          <div class="card-heading"><span class="icon-tile"><ha-icon aria-hidden="true" icon="mdi:wallet-outline"></ha-icon></span><div><h2>Stash integration</h2><p>Keep vehicle expenses in your household budget.</p></div></div>
          <div class="toggle-row"><label for="finance-sync">Sync vehicle expenses<small>Fuel and maintenance costs · requires Stash</small></label><input id="finance-sync" class="switch" type="checkbox" .checked=${this._financeSyncEnabled} @change=${this._toggleFinanceSync} /></div>
          <label for="stash-category">Expense category</label>
          <input id="stash-category" type="text" placeholder="e.g. Transportation" .value=${this._financeCategoryName} @input=${(e: Event) => (this._financeCategoryName = (e.target as HTMLInputElement).value)} @change=${this._saveFinanceCategoryName} />
          <p class="hint">Use an existing category name in Stash. Matching is case-insensitive; changes save automatically.</p>
        </ha-card>
        <ha-card class="settings-card scan-card">
          <div class="card-heading"><span class="icon-tile"><ha-icon aria-hidden="true" icon="mdi:camera-outline"></ha-icon></span><div><h2>Pump photo scanning</h2><p>Less typing at your next fill-up.</p></div></div>
          <div class="description">Use <strong>Scan Pump Photo</strong> in the Add Fuel dialog to read the amount, gallons and price from a pump photo.<br><br>To enable scanning, add an <code>openai_api_key</code> entry to Home Assistant's <code>secrets.yaml</code> and restart Home Assistant. Review the scanned values before saving.</div>
        </ha-card>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-settings-view": GarageSettingsView;
  }
}

