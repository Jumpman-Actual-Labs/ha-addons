import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { financeApi } from "../ha-api";
import type { Bill, SavingsPlanEntry } from "../types";
import { money } from "../format";
import "./finance-dialog";

function monthsUntilDue(dueDateStr: string): string[] {
  const due = new Date(`${dueDateStr}T00:00:00`);
  const now = new Date();
  const months: string[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  const endCursor = new Date(due.getFullYear(), due.getMonth(), 1);
  while (cursor <= endCursor) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  if (months.length === 0) {
    months.push(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

@customElement("finance-savings-plan-dialog")
export class FinanceSavingsPlanDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) bill: Bill | null = null;

  @state() private _months: string[] = [];
  @state() private _monthlyAmount = "";
  @state() private _useBreakdown = false;
  @state() private _breakdownEntries: SavingsPlanEntry[] = [];
  @state() private _saving = false;

  private _lastBillId = "";

  static styles = css`
    label {
      display: block;
      font-size: 0.85rem;
      color: var(--secondary-text-color, #727272);
      margin: 12px 0 4px;
    }
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
    input:disabled {
      opacity: 0.7;
    }
    .header {
      margin-bottom: 8px;
    }
    .header .amount {
      font-size: 1.3rem;
      font-weight: 500;
    }
    .header .due {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
    }
    .month-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .month-row span {
      flex: 1;
      font-size: 0.9rem;
    }
    .month-row input {
      flex: 1;
    }
    .totals {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px solid var(--divider-color, #e0e0e0);
    }
    .totals .row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
    }
    .totals .row.short {
      color: var(--error-color, #db4437);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
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
    button.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.secondary {
      background: none;
      border: 1px solid var(--divider-color, #e0e0e0);
      border-radius: 8px;
      padding: 10px 16px;
      cursor: pointer;
    }
  `;

  updated(changed: Map<string, unknown>): void {
    if (changed.has("bill") && this.bill && this.bill.billId !== this._lastBillId) {
      this._lastBillId = this.bill.billId;
      this._initializeFromBill(this.bill);
    }
  }

  private _initializeFromBill(bill: Bill): void {
    this._months = monthsUntilDue(bill.dueDate);
    const existing = bill.savingsPlan.length > 0 ? bill.savingsPlan : bill.proposedSavingsPlan;

    if (existing.length <= 1) {
      this._monthlyAmount = existing.length === 1 ? String(existing[0].amount) : "";
      this._useBreakdown = false;
      return;
    }

    const nonLast = existing.slice(0, -1);
    const allEqual = nonLast.every((e) => Math.abs(e.amount - nonLast[0].amount) < 0.01);
    if (allEqual) {
      this._monthlyAmount = String(nonLast[0].amount);
      this._useBreakdown = false;
    } else {
      this._useBreakdown = true;
      this._breakdownEntries = existing;
    }
  }

  private _onMonthlyAmountChange(value: string): void {
    this._monthlyAmount = value;
    const amount = Number(value) || 0;
    const total = amount * this._months.length;
    if (this.bill && total < this.bill.amount - 0.01) {
      this._useBreakdown = true;
      this._breakdownEntries = this._months.map((m) => ({ month: m, amount }));
      this._recalculateLastMonth();
    } else {
      this._useBreakdown = false;
    }
  }

  private _updateBreakdownEntry(index: number, value: string): void {
    const updated = [...this._breakdownEntries];
    updated[index] = { ...updated[index], amount: Number(value) || 0 };
    this._breakdownEntries = updated;
    this._recalculateLastMonth();
  }

  private _recalculateLastMonth(): void {
    if (!this.bill || this._breakdownEntries.length === 0) return;
    const lastIndex = this._breakdownEntries.length - 1;
    const nonLastTotal = this._breakdownEntries
      .slice(0, -1)
      .reduce((sum, e) => sum + e.amount, 0);
    const remainder = Math.max(round2(this.bill.amount - nonLastTotal), 0);
    this._breakdownEntries = this._breakdownEntries.map((e, i) =>
      i === lastIndex ? { ...e, amount: remainder } : e
    );
  }

  private get _total(): number {
    return this._useBreakdown
      ? this._breakdownEntries.reduce((sum, e) => sum + e.amount, 0)
      : (Number(this._monthlyAmount) || 0) * this._months.length;
  }

  private get _isValid(): boolean {
    return !!this.bill && this._total >= this.bill.amount - 0.01;
  }

  private async _save(): Promise<void> {
    if (!this.bill || !this._isValid) return;
    this._saving = true;
    try {
      const entries: SavingsPlanEntry[] = this._useBreakdown
        ? this._breakdownEntries
        : this._months.map((m) => ({ month: m, amount: Number(this._monthlyAmount) || 0 }));
      await financeApi.setSavingsPlan(this.hass, this.bill.billId, entries);
      this._close();
    } finally {
      this._saving = false;
    }
  }

  private _close(): void {
    this._lastBillId = "";
    this.dispatchEvent(new CustomEvent("savings-plan-closed"));
  }

  render() {
    const bill = this.bill;
    if (!bill) return html``;

    return html`
      <finance-dialog
        heading="Savings Plan - ${bill.name}"
        .open=${bill !== null}
        @finance-dialog-closed=${this._close}
      >
        <div class="header">
          <div class="amount">${money(bill.amount)}</div>
          <div class="due">Due ${bill.dueDate}</div>
        </div>

        <label>Save per month</label>
        <input
          type="number"
          step="0.01"
          .value=${this._monthlyAmount}
          @input=${(e: InputEvent) => this._onMonthlyAmountChange((e.target as HTMLInputElement).value)}
        />

        ${this._useBreakdown
          ? html`
              <label>This doesn't cover it by the due date - set an amount per month</label>
              ${this._breakdownEntries.map(
                (entry, i) => html`
                  <div class="month-row">
                    <span>${entry.month}</span>
                    <input
                      type="number"
                      step="0.01"
                      .value=${String(entry.amount)}
                      ?disabled=${i === this._breakdownEntries.length - 1}
                      @input=${(e: InputEvent) =>
                        this._updateBreakdownEntry(i, (e.target as HTMLInputElement).value)}
                    />
                  </div>
                `
              )}
            `
          : ""}

        <div class="totals">
          <div class="row"><span>Plan total</span><span>${money(this._total)}</span></div>
          <div class="row ${this._isValid ? "" : "short"}">
            <span>${this._isValid ? "Fully covered" : "Short by"}</span>
            <span>${this._isValid ? "" : money(bill.amount - this._total)}</span>
          </div>
        </div>

        <div class="actions">
          <button class="secondary" @click=${this._close}>Cancel</button>
          <button class="primary" ?disabled=${this._saving || !this._isValid} @click=${this._save}>
            Save
          </button>
        </div>
      </finance-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-savings-plan-dialog": FinanceSavingsPlanDialog;
  }
}
