import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { financeApi } from "../ha-api";
import type { Contribution, Member, SavingsPlanEntry } from "../types";
import { money } from "../format";
import "./finance-dialog";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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

@customElement("finance-cash-infusion-dialog")
export class FinanceCashInfusionDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) members: Member[] = [];
  @property({ type: String }) defaultMemberId = "";

  @state() private _amount = "";
  @state() private _date = todayIso();
  @state() private _source = "";
  @state() private _contributions: Contribution[] = [];
  @state() private _saving = false;

  // Repayment (this infusion is a loan owed back)
  @state() private _needsRepayment = false;
  @state() private _repaymentDueDate = todayIso();
  @state() private _repaymentMonths: string[] = [];
  @state() private _repaymentMonthlyAmount = "";
  @state() private _repaymentUseBreakdown = false;
  @state() private _repaymentEntries: SavingsPlanEntry[] = [];

  private _lastOpen = false;

  static styles = css`
    label {
      display: block;
      font-size: 0.85rem;
      color: var(--secondary-text-color, #727272);
      margin: 12px 0 4px;
    }
    input,
    select {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--divider-color, #e0e0e0);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color, #212121);
      font-size: 1rem;
    }
    .contribution-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }
    .contribution-row select {
      flex: 2;
    }
    .contribution-row input {
      flex: 1;
    }
    button.link {
      background: none;
      border: none;
      color: var(--primary-color, #03a9f4);
      cursor: pointer;
      padding: 4px 0;
      font-size: 0.9rem;
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
    .repayment-section {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--divider-color, #e0e0e0);
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
    }
    .checkbox-row label {
      margin: 0;
    }
    .checkbox-row input {
      width: auto;
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

  updated(): void {
    if (this.open && !this._lastOpen) {
      this._amount = "";
      this._date = todayIso();
      this._source = "";
      this._contributions = [
        { member_id: this.defaultMemberId || this.members[0]?.memberId || "", amount: 0 },
      ];
      this._needsRepayment = false;
      this._repaymentDueDate = todayIso();
      this._repaymentMonths = [];
      this._repaymentMonthlyAmount = "";
      this._repaymentUseBreakdown = false;
      this._repaymentEntries = [];
    }
    this._lastOpen = this.open;
  }

  private get _amountNum(): number {
    return Number(this._amount) || 0;
  }

  private get _contributionTotal(): number {
    return this._contributions.reduce((sum, c) => sum + c.amount, 0);
  }

  private get _isBalanced(): boolean {
    return Math.abs(this._contributionTotal - this._amountNum) < 0.01;
  }

  private get _repaymentTotal(): number {
    return this._repaymentUseBreakdown
      ? this._repaymentEntries.reduce((sum, e) => sum + e.amount, 0)
      : (Number(this._repaymentMonthlyAmount) || 0) * this._repaymentMonths.length;
  }

  private get _repaymentValid(): boolean {
    return !this._needsRepayment || this._repaymentTotal >= this._amountNum - 0.01;
  }

  private get _isValid(): boolean {
    return this._amountNum > 0 && !!this._date && this._isBalanced && this._repaymentValid;
  }

  private _onAmountChange(value: string): void {
    this._amount = value;
    if (this._contributions.length === 1) {
      this._contributions = [{ ...this._contributions[0], amount: Number(value) || 0 }];
    }
    if (this._needsRepayment) this._recalculateRepaymentMonths();
  }

  private _addContributionRow(): void {
    this._contributions = [
      ...this._contributions,
      { member_id: this.members[0]?.memberId ?? "", amount: 0 },
    ];
  }

  private _updateContribution(index: number, field: "member_id" | "amount", value: string): void {
    const updated = [...this._contributions];
    updated[index] = {
      ...updated[index],
      [field]: field === "amount" ? Number(value) || 0 : value,
    };
    this._contributions = updated;
  }

  private _removeContribution(index: number): void {
    this._contributions = this._contributions.filter((_, i) => i !== index);
  }

  private _toggleRepayment(checked: boolean): void {
    this._needsRepayment = checked;
    if (checked) this._recalculateRepaymentMonths();
  }

  private _recalculateRepaymentMonths(): void {
    this._repaymentMonths = monthsUntilDue(this._repaymentDueDate);
    if (this._repaymentUseBreakdown) {
      this._repaymentEntries = this._repaymentMonths.map(
        (m) =>
          this._repaymentEntries.find((e) => e.month === m) ?? { month: m, amount: 0 }
      );
      this._recalculateLastRepaymentMonth();
    }
  }

  private _onRepaymentDueDateChange(value: string): void {
    this._repaymentDueDate = value;
    this._recalculateRepaymentMonths();
  }

  private _onRepaymentMonthlyAmountChange(value: string): void {
    this._repaymentMonthlyAmount = value;
    const amount = Number(value) || 0;
    const total = amount * this._repaymentMonths.length;
    if (total < this._amountNum - 0.01) {
      this._repaymentUseBreakdown = true;
      this._repaymentEntries = this._repaymentMonths.map((m) => ({ month: m, amount }));
      this._recalculateLastRepaymentMonth();
    } else {
      this._repaymentUseBreakdown = false;
    }
  }

  private _updateRepaymentEntry(index: number, value: string): void {
    const updated = [...this._repaymentEntries];
    updated[index] = { ...updated[index], amount: Number(value) || 0 };
    this._repaymentEntries = updated;
    this._recalculateLastRepaymentMonth();
  }

  private _recalculateLastRepaymentMonth(): void {
    if (this._repaymentEntries.length === 0) return;
    const lastIndex = this._repaymentEntries.length - 1;
    const nonLastTotal = this._repaymentEntries
      .slice(0, -1)
      .reduce((sum, e) => sum + e.amount, 0);
    const remainder = Math.max(round2(this._amountNum - nonLastTotal), 0);
    this._repaymentEntries = this._repaymentEntries.map((e, i) =>
      i === lastIndex ? { ...e, amount: remainder } : e
    );
  }

  private async _save(): Promise<void> {
    if (!this._isValid) return;
    this._saving = true;
    try {
      const contributions = this._contributions.filter((c) => c.member_id && c.amount > 0);
      const repaymentEntries = this._needsRepayment
        ? this._repaymentUseBreakdown
          ? this._repaymentEntries
          : this._repaymentMonths.map((m) => ({
              month: m,
              amount: Number(this._repaymentMonthlyAmount) || 0,
            }))
        : undefined;
      await financeApi.addCashInfusion(
        this.hass,
        this._amountNum,
        this._date,
        this._source,
        contributions,
        this._needsRepayment ? this._repaymentDueDate : undefined,
        repaymentEntries
      );
      this._close();
    } finally {
      this._saving = false;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("cash-infusion-closed"));
  }

  render() {
    return html`
      <finance-dialog
        heading="Add Cash Infusion"
        .open=${this.open}
        @finance-dialog-closed=${this._close}
      >
        <label>Amount</label>
        <input
          type="number"
          step="0.01"
          .value=${this._amount}
          @input=${(e: InputEvent) => this._onAmountChange((e.target as HTMLInputElement).value)}
        />

        <label>Date</label>
        <input
          type="date"
          .value=${this._date}
          @input=${(e: InputEvent) => (this._date = (e.target as HTMLInputElement).value)}
        />

        <label>Source (optional)</label>
        <input
          type="text"
          placeholder="e.g. Tax refund, birthday gift"
          .value=${this._source}
          @input=${(e: InputEvent) => (this._source = (e.target as HTMLInputElement).value)}
        />

        <label>From</label>
        ${this._contributions.map(
          (c, i) => html`
            <div class="contribution-row">
              <select
                @change=${(e: Event) =>
                  this._updateContribution(i, "member_id", (e.target as HTMLSelectElement).value)}
              >
                ${this.members.map(
                  (m) =>
                    html`<option value=${m.memberId} ?selected=${m.memberId === c.member_id}>
                      ${m.name}
                    </option>`
                )}
              </select>
              <input
                type="number"
                step="0.01"
                .value=${String(c.amount)}
                @input=${(e: InputEvent) =>
                  this._updateContribution(i, "amount", (e.target as HTMLInputElement).value)}
              />
              ${this._contributions.length > 1
                ? html`<button class="link" @click=${() => this._removeContribution(i)}>
                    Remove
                  </button>`
                : ""}
            </div>
          `
        )}
        <button class="link" @click=${this._addContributionRow}>+ Add contributor</button>

        <div class="totals">
          <div class="row">
            <span>Attributed</span>
            <span>${money(this._contributionTotal)}</span>
          </div>
          <div class="row ${this._isBalanced ? "" : "short"}">
            <span>${this._isBalanced ? "Matches amount" : "Doesn't match amount"}</span>
          </div>
        </div>

        <div class="repayment-section">
          <div class="checkbox-row">
            <input
              type="checkbox"
              id="needs-repayment"
              .checked=${this._needsRepayment}
              @change=${(e: Event) => this._toggleRepayment((e.target as HTMLInputElement).checked)}
            />
            <label for="needs-repayment">This needs to be repaid</label>
          </div>

          ${this._needsRepayment
            ? html`
                <label>Repay by</label>
                <input
                  type="date"
                  .value=${this._repaymentDueDate}
                  @input=${(e: InputEvent) =>
                    this._onRepaymentDueDateChange((e.target as HTMLInputElement).value)}
                />

                <label>Save per month toward repayment</label>
                <input
                  type="number"
                  step="0.01"
                  .value=${this._repaymentMonthlyAmount}
                  @input=${(e: InputEvent) =>
                    this._onRepaymentMonthlyAmountChange((e.target as HTMLInputElement).value)}
                />

                ${this._repaymentUseBreakdown
                  ? html`
                      <label>This doesn't cover it by the due date - set an amount per month</label>
                      ${this._repaymentEntries.map(
                        (entry, i) => html`
                          <div class="month-row">
                            <span>${entry.month}</span>
                            <input
                              type="number"
                              step="0.01"
                              .value=${String(entry.amount)}
                              ?disabled=${i === this._repaymentEntries.length - 1}
                              @input=${(e: InputEvent) =>
                                this._updateRepaymentEntry(i, (e.target as HTMLInputElement).value)}
                            />
                          </div>
                        `
                      )}
                    `
                  : ""}

                <div class="totals">
                  <div class="row">
                    <span>Repayment plan total</span>
                    <span>${money(this._repaymentTotal)}</span>
                  </div>
                  <div class="row ${this._repaymentValid ? "" : "short"}">
                    <span>${this._repaymentValid ? "Fully covered" : "Short by"}</span>
                    <span
                      >${this._repaymentValid
                        ? ""
                        : money(this._amountNum - this._repaymentTotal)}</span
                    >
                  </div>
                </div>
              `
            : ""}
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
    "finance-cash-infusion-dialog": FinanceCashInfusionDialog;
  }
}
