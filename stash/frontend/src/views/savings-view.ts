import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { financeApi } from "../ha-api";
import type { FinanceState } from "../types";
import { money } from "../format";
import { glassCardStyle, bankingStyle } from "../styles";
import "../components/savings-deposit-dialog";

@customElement("finance-savings-view")
export class FinanceSavingsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) financeState!: FinanceState;

  @state() private _depositDialogOpen = false;

  @state() private _saving = false;
  @state() private _savingsType = "fixed_amount";
  @state() private _savingsValue = "";
  @state() private _savingsSaved = false;
  private _savingsInitialized = false;

  static styles = [glassCardStyle, css`
    ha-card {
      padding: 20px;
      margin-bottom: 24px;
    }
    .summary-row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
    }
    .summary-row + .summary-row {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--divider-color, #e0e0e0);
    }
    .summary-col:last-child {
      text-align: right;
    }
    .label {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
      margin-bottom: 6px;
    }
    .value {
      font-size: 1.6rem;
      font-weight: 500;
    }
    .sub-label {
      color: var(--secondary-text-color, #727272);
      font-size: 0.75rem;
      margin-top: 4px;
    }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 16px;
    }
    button.primary {
      background: var(--primary-color, #03a9f4);
      color: var(--text-primary-color, #fff);
      border: none;
      border-radius: 8px;
      padding: 10px 16px;
      font-size: 0.95rem;
      cursor: pointer;
    }
    h2 {
      font-size: 1.05rem;
      font-weight: 500;
      margin: 0 0 12px;
    }
    .member-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
    }
    .row:last-child {
      border-bottom: none;
    }
    section {
      margin-bottom: 24px;
    }
    p.hint {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
    }
    p.confirm {
      color: var(--success-color, #43a047);
      font-size: 0.9rem;
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
  `, bankingStyle];

  updated(changed: Map<string, unknown>): void {
    if (changed.has("financeState") && !this._savingsInitialized && this.financeState) {
      this._savingsInitialized = true;
      this._savingsType = this.financeState.savings.type;
      this._savingsValue = String(this.financeState.savings.value);
    }
  }

  private async _saveSavingsGoal(): Promise<void> {
    this._saving = true;
    try {
      await financeApi.setSavingsGoal(this.hass, this._savingsType, Number(this._savingsValue) || 0);
      this._savingsSaved = true;
      setTimeout(() => (this._savingsSaved = false), 4000);
    } finally {
      this._saving = false;
    }
  }

  render() {
    const savings = this.financeState.savings;

    return html`
      <div class="toolbar">
        <button class="primary" @click=${() => (this._depositDialogOpen = true)}>Record Deposit</button>
      </div>

      <ha-card>
        <div class="summary-row">
          <div class="summary-col">
            <div class="label">Monthly Savings Goal</div>
            <div class="value">${money(savings.amount)}</div>
            ${savings.planContributions > 0
              ? html`<div class="sub-label">
                  Includes ${money(savings.planContributions)} for one-time bill plans
                </div>`
              : ""}
          </div>
          <div class="summary-col">
            <div class="label">Deposited This Month</div>
            <div class="value">${money(savings.depositedMonth)}</div>
          </div>
        </div>
        <div class="summary-row">
          <div class="summary-col">
            <div class="label">Savings This Pay Period</div>
            <div class="value">${money(savings.perPeriod)}</div>
          </div>
          <div class="summary-col">
            <div class="label">Deposited This Pay Period</div>
            <div class="value">${money(savings.depositedPeriod)}</div>
          </div>
        </div>
      </ha-card>

      ${this.financeState.mode === "split" && savings.breakdown.length > 0
        ? html`
            <section>
              <h2>Savings Share by Member</h2>
              <div class="member-grid">
                ${this.financeState.members.map(
                  (m) => html`
                    <ha-card>
                      <div class="label">${m.name}</div>
                      <div class="row">
                        <span>Share</span>
                        <span>
                          ${(savings.breakdown.find((b) => b.memberId === m.memberId)?.pct ?? 0).toFixed(1)}%
                        </span>
                      </div>
                      <div class="row">
                        <span>Amount</span>
                        <span>${money(
                          savings.breakdown.find((b) => b.memberId === m.memberId)?.amount ?? 0
                        )}</span>
                      </div>
                    </ha-card>
                  `
                )}
              </div>
            </section>
          `
        : ""}

      <ha-card>
        <h2>Savings Goal</h2>
        <p class="hint">
          Set aside money each month as a percent of income, a percent of what's left after
          bills, or a flat amount. Split proportionally by income across members.
        </p>
        <label>Type</label>
        <select
          ?disabled=${this._saving}
          @change=${(e: Event) => (this._savingsType = (e.target as HTMLSelectElement).value)}
        >
          <option value="percent_of_income" ?selected=${this._savingsType === "percent_of_income"}>
            Percent of total income
          </option>
          <option
            value="percent_of_remaining"
            ?selected=${this._savingsType === "percent_of_remaining"}
          >
            Percent of remaining income
          </option>
          <option value="fixed_amount" ?selected=${this._savingsType === "fixed_amount"}>
            Fixed dollar amount
          </option>
        </select>
        <label>${this._savingsType === "fixed_amount" ? "Amount ($)" : "Percent (%)"}</label>
        <input
          type="number"
          step="0.01"
          .value=${this._savingsValue}
          @input=${(e: InputEvent) => (this._savingsValue = (e.target as HTMLInputElement).value)}
        />
        <div class="toolbar">
          <button class="primary" ?disabled=${this._saving} @click=${this._saveSavingsGoal}>
            Save
          </button>
        </div>
        ${this._savingsSaved ? html`<p class="confirm">Savings goal updated.</p>` : ""}
      </ha-card>

      <finance-savings-deposit-dialog
        .hass=${this.hass}
        .open=${this._depositDialogOpen}
        heading="Record Savings Deposit"
        .targetAmount=${savings.perPeriod}
        @savings-deposit-closed=${() => (this._depositDialogOpen = false)}
      ></finance-savings-deposit-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-savings-view": FinanceSavingsView;
  }
}
