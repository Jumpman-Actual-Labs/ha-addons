import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { financeApi } from "../ha-api";
import type { CategoryExpense } from "../types";
import "./finance-dialog";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@customElement("finance-category-expense-dialog")
export class FinanceCategoryExpenseDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  @property({ type: String }) categoryId = "";
  @property({ type: String }) categoryName = "";
  @property({ attribute: false }) expense: CategoryExpense | null = null;

  @state() private _name = "";
  @state() private _amount = "";
  @state() private _date = todayIso();
  @state() private _notes = "";
  @state() private _saving = false;

  private _lastOpen = false;
  private _lastExpenseId: string | null = null;

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
    const expenseId = this.expense?.id ?? null;
    if ((this.open && !this._lastOpen) || expenseId !== this._lastExpenseId) {
      const e = this.expense;
      this._name = e?.name ?? "";
      this._amount = e ? String(e.amount) : "";
      this._date = e?.date ?? todayIso();
      this._notes = e?.notes ?? "";
    }
    this._lastOpen = this.open;
    this._lastExpenseId = expenseId;
  }

  private get _isValid(): boolean {
    return !!this._name.trim() && (Number(this._amount) || 0) > 0 && !!this._date;
  }

  private async _save(): Promise<void> {
    if (!this._isValid) return;
    this._saving = true;
    try {
      if (this.expense) {
        await financeApi.editCategoryExpense(this.hass, this.expense.id, {
          name: this._name.trim(),
          amount: Number(this._amount) || 0,
          date: this._date,
          notes: this._notes,
        });
      } else {
        await financeApi.addCategoryExpense(
          this.hass,
          this.categoryId,
          this._name.trim(),
          Number(this._amount) || 0,
          this._date,
          this._notes
        );
      }
      this._close();
    } finally {
      this._saving = false;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("category-expense-closed"));
  }

  render() {
    return html`
      <finance-dialog
        heading="${this.expense ? "Edit Item" : "Add Item"} - ${this.categoryName}"
        .open=${this.open}
        @finance-dialog-closed=${this._close}
      >
        <label>Name</label>
        <input
          type="text"
          placeholder="e.g. Gas"
          .value=${this._name}
          @input=${(e: InputEvent) => (this._name = (e.target as HTMLInputElement).value)}
        />

        <label>Amount</label>
        <input
          type="number"
          step="0.01"
          .value=${this._amount}
          @input=${(e: InputEvent) => (this._amount = (e.target as HTMLInputElement).value)}
        />

        <label>Date</label>
        <input
          type="date"
          .value=${this._date}
          @input=${(e: InputEvent) => (this._date = (e.target as HTMLInputElement).value)}
        />

        <label>Notes (optional)</label>
        <input
          type="text"
          .value=${this._notes}
          @input=${(e: InputEvent) => (this._notes = (e.target as HTMLInputElement).value)}
        />

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
    "finance-category-expense-dialog": FinanceCategoryExpenseDialog;
  }
}
