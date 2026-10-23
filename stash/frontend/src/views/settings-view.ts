import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { financeApi } from "../ha-api";
import type { FinanceState } from "../types";
import { glassCardStyle, bankingStyle } from "../styles";

@customElement("finance-settings-view")
export class FinanceSettingsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) financeState!: FinanceState;

  @state() private _saving = false;
  @state() private _rolledOver = false;

  static styles = [glassCardStyle, css`
    ha-card {
      padding: 16px;
      margin-bottom: 16px;
      max-width: 480px;
    }
    h2 {
      font-size: 1.05rem;
      font-weight: 500;
      margin: 0 0 12px;
    }
    label {
      display: block;
      font-size: 0.85rem;
      color: var(--secondary-text-color, #727272);
      margin: 12px 0 4px;
    }
    select,
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--divider-color, #e0e0e0);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color, #212121);
      font-size: 1rem;
    }
    button.primary {
      background: var(--primary-color, #03a9f4);
      color: var(--text-primary-color, #fff);
      border: none;
      border-radius: 8px;
      padding: 10px 16px;
      font-size: 0.95rem;
      cursor: pointer;
      margin-top: 12px;
    }
    p.hint {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
    }
    p.confirm {
      color: var(--success-color, #43a047);
      font-size: 0.9rem;
    }
  `, bankingStyle];

  private async _setMode(e: Event): Promise<void> {
    this._saving = true;
    try {
      await financeApi.setMode(this.hass, (e.target as HTMLSelectElement).value);
    } finally {
      this._saving = false;
    }
  }

  private async _setResponsibilityMethod(e: Event): Promise<void> {
    this._saving = true;
    try {
      await financeApi.setResponsibilityMethod(this.hass, (e.target as HTMLSelectElement).value);
    } finally {
      this._saving = false;
    }
  }

  private async _triggerRollover(): Promise<void> {
    this._saving = true;
    try {
      await financeApi.triggerMonthlyRollover(this.hass);
      this._rolledOver = true;
      setTimeout(() => (this._rolledOver = false), 4000);
    } finally {
      this._saving = false;
    }
  }

  render() {
    return html`
      <ha-card>
        <h2>Finance Mode</h2>
        <p class="hint">
          Split mode calculates each member's budget responsibility, including bills and category
          budgets. Shared category amounts follow the income split; manual shares apply to bills.
          Shared mode treats income and the budget as one household total.
        </p>
        <label>Mode</label>
        <select ?disabled=${this._saving} @change=${this._setMode}>
          <option value="split" ?selected=${this.financeState.mode === "split"}>Split</option>
          <option value="shared" ?selected=${this.financeState.mode === "shared"}>Shared</option>
        </select>

        ${this.financeState.mode === "split"
          ? html`
              <label>Responsibility method</label>
              <select ?disabled=${this._saving} @change=${this._setResponsibilityMethod}>
                <option value="automatic" ?selected=${this.financeState.responsibilityMethod === "automatic"}>
                  Automatic (based on income)
                </option>
                <option value="manual" ?selected=${this.financeState.responsibilityMethod === "manual"}>
                  Manual (set per bill)
                </option>
              </select>
            `
          : ""}
      </ha-card>

      <ha-card>
        <h2>Monthly Rollover</h2>
        <p class="hint">
          Normally runs automatically at midnight on the 1st of each month: archives the
          previous month and refreshes overdue/deferred status. You can also trigger it
          manually here.
        </p>
        <button class="primary" ?disabled=${this._saving} @click=${this._triggerRollover}>
          Trigger Monthly Rollover
        </button>
        ${this._rolledOver ? html`<p class="confirm">Rollover complete.</p>` : ""}
      </ha-card>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-settings-view": FinanceSettingsView;
  }
}
