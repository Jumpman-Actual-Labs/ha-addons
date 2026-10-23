import { LitElement, css, html, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { financeApi } from "../ha-api";
import type {
  Bill,
  Category,
  CategoryExpense,
  FinanceState,
  Frequency,
} from "../types";
import { money } from "../format";
import { compareBills, lastPaymentDate, isOverdue, remainingForBill, type BillSortKey, type SortDirection } from "../bill-selectors";
import { glassCardStyle, bankingStyle } from "../styles";
import { paletteColor } from "../colors";
import "../components/finance-dialog";
import "../components/category-expense-dialog";
import "../components/bill-workspace-dialog";

const CIRCUMFERENCE = 2 * Math.PI * 50;

const FREQUENCIES = ["weekly", "biweekly", "monthly", "quarterly", "yearly", "one_time"];
const BILL_TYPES = ["fixed", "variable", "debt", "subscription", "installment"];

// A bill's amount is per-occurrence, not per-month - scale it to a monthly
// equivalent for budget auto-fill. Weekly/biweekly use the annualized
// average (52 or 26 occurrences/year, divided by 12) since they don't divide
// evenly into a month.
const MONTHLY_BILL_MULTIPLIER: Record<Frequency, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
  one_time: 1,
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

@customElement("finance-bills-view")
export class FinanceBillsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) financeState!: FinanceState;
  @property({ type: String }) section: "bills" | "budgets" = "bills";
  @state() private _filter = "outstanding";
  @state() private _search = "";
  @state() private _sort: BillSortKey = "dueDate";
  @state() private _sortDirection: SortDirection = "asc";
  @state() private _saving = false;

  // Bill details/payment/edit/late-fee - handled by finance-bill-workspace
  @state() private _selectedBill: Bill | null = null;

  // Add bill dialog
  @state() private _addOpen = false;
  @state() private _newName = "";
  @state() private _newPayTo = "";
  @state() private _newAmount = "";
  @state() private _newCategoryId = "";
  @state() private _newDueDate = today();
  @state() private _newFrequency = "monthly";
  @state() private _newBillType = "fixed";
  @state() private _newNotes = "";
  @state() private _newOwner = "";
  @state() private _newError = "";

  // Manage categories (list + add + delete)
  @state() private _manageCategoriesOpen = false;
  @state() private _newCategoryName = "";
  @state() private _categoryError = "";

  // Add/edit category expense (non-bill item) dialog
  @state() private _expenseDialogOpen = false;
  @state() private _expenseCategoryId = "";
  @state() private _expenseCategoryName = "";
  @state() private _editingExpense: CategoryExpense | null = null;

  // Set category planned-budget dialog
  @state() private _budgetDialogOpen = false;
  @state() private _budgetCategoryId = "";
  @state() private _budgetCategoryName = "";
  @state() private _budgetAmount = "";
  @state() private _budgetEditingCategory: Category | null = null;

  // Budget donut hover detail
  @state() private _hoveredCategoryId: string | null = null;

  static styles = [glassCardStyle, css`



    .budget-totals .budget-summary { flex-direction: row; flex-wrap: wrap; gap: 24px; justify-content: space-between; }
    .budget-totals .budget-summary .label { margin-top: 0; }
    .allocation { margin: 0 0 24px; border: 1px solid var(--divider-color, #ddd); border-radius: 10px; }
    .allocation summary { cursor: pointer; padding: 14px 16px; font-size: 0.8rem; }
    .allocation .budget-card { margin: 0; --ha-card-border-width: 0; }
    .bill-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 20px 0 12px; }
    .sort-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:0 0 12px; }
    .sort-controls label { margin:0; }
    .sort-controls select { width:auto; min-width:0; flex:0 1 190px; }
    @media(max-width:480px) { .sort-controls label { flex-basis:100%; } .sort-controls select { flex:1 1 110px; } }
    .bill-controls input { flex: 1 1 200px; }
    .bill-controls select { flex: 0 1 200px; }
    .bill-list { border: 1px solid var(--divider-color, #e3e9ed); border-radius: 12px; overflow: hidden; background: var(--card-background-color, #fff); }
    .list-caption { display: flex; justify-content: space-between; gap: 12px; padding: 16px 18px; font-size: 0.8rem; color: var(--secondary-text-color, #667); }
    .bill-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 20px; }
    .bill-metrics > div { padding: 16px; border: 1px solid var(--divider-color, #ddd); border-radius: 10px; background: var(--card-background-color, #fff); }
    .bill-metrics span { display: block; font-size: 0.74rem; color: var(--secondary-text-color, #667); }
    .bill-metrics strong { font-size: clamp(1rem, 2vw, 1.5rem); font-variant-numeric: tabular-nums; }
    .bill-metrics .late strong { color: var(--stash-danger, #b64545); }
    .bill-metrics .done strong { color: var(--stash-success, #238265); }
    @media (max-width: 480px) { .bill-metrics > div { padding: 12px 9px; } .bill-controls select { flex: 1; } }
    ha-card.bill-card { border-radius: 0; --ha-card-border-radius: 0; --ha-card-border-width: 0; border-bottom: 1px solid var(--divider-color, #e3e9ed); padding: 18px; margin: 0; }
    .bill-row { gap: 14px; }
    .bill-avatar { display: grid; place-items: center; flex: 0 0 40px; height: 40px; border-radius: 10px; background: color-mix(in srgb, var(--primary-color) 8%, transparent); color: var(--primary-color); --mdc-icon-size: 20px; }
    .bill-money { text-align: right; flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
    .bill-money strong { font-size: 0.95rem; font-weight: 650; font-variant-numeric: tabular-nums; }
    .bill-name { line-height: 1.5; }
    .bill-meta { margin-top: 3px; }
    ha-card.category-section { padding: 0; margin-bottom: 18px; background: var(--card-background-color, #fff); border-radius: 12px; overflow: hidden; }
    .category-section .item-row { padding: 16px 18px; }
    .category-section .empty { padding: 18px; }
    .category-section .category-header { padding: 16px 18px; background: color-mix(in srgb, var(--secondary-background-color, #f1f4f6) 55%, var(--card-background-color, #fff)); flex-wrap: wrap; }
    @media (max-width: 480px) { .bill-avatar { display: none; } ha-card.bill-card { padding: 16px 12px; } .bill-row { align-items: flex-start; gap: 8px; } .bill-money strong { font-size: 0.88rem; } }
    .fee-badge { display: inline-block; margin: 6px 0 0 6px; padding: 3px 8px; border-radius: 6px; color: var(--warning-color, #9a6700); background: color-mix(in srgb, var(--warning-color, #e6a700) 12%, transparent); }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 8px;
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
    button.secondary {
      background: none;
      border: 1px solid var(--divider-color, #e0e0e0);
      border-radius: 8px;
      padding: 10px 16px;
      cursor: pointer;
    }
    button.link {
      background: none;
      border: none;
      color: var(--primary-color, #03a9f4);
      cursor: pointer;
      padding: 4px 0;
    }
    ha-card {
      padding: 16px;
      margin-bottom: 10px;
    }
    .bill-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .bill-main {
      min-width: 0;
      overflow-wrap: anywhere;
      flex: 1;
    }
    .bill-name {
      font-weight: 500;
    }
    .pay-to {
      font-weight: 400;
      color: var(--secondary-text-color, #727272);
    }
    .bill-meta {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
    }
    .status {
      font-size: 0.8rem;
      padding: 3px 8px;
      border-radius: 12px;
      text-transform: capitalize;
      white-space: nowrap;
    }
    .status.unpaid { background: #eeeeee; color: #616161; }
    .status.partially_paid { background: #fff8e1; color: #f57f17; }
    .status.paid { background: #e8f5e9; color: #2e7d32; }
    .status.deferred { background: #ede7f6; color: #5e35b1; }
    .status.overdue { background: #ffebee; color: #c62828; }
    .bill-card {
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .bill-card:hover {
      background: var(--secondary-background-color, #f5f5f5);
    }
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
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
    }
    .contribution-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }
    .contribution-row input {
      flex: 1;
    }
    .category-list {
      max-height: 240px;
      overflow-y: auto;
      margin-bottom: 12px;
    }
    .category-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
    }
    .budget-history {
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
    }
    .budget-history-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.9rem;
      color: var(--secondary-text-color, #727272);
      padding: 2px 0;
    }
    .budget-card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 20px;
    }
    .budget-summary {
      display: flex;
      flex-direction: column;
      min-width: 140px;
    }
    .budget-summary .label {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
      margin-top: 14px;
    }
    .budget-summary .label:first-child {
      margin-top: 0;
    }
    .budget-summary .value {
      font-size: 1.3rem;
      font-weight: 500;
    }
    .budget-summary .value.over-budget {
      color: var(--error-color, #c62828);
    }
    .donut-wrap {
      position: relative;
      width: 160px;
      height: 160px;
      flex-shrink: 0;
    }
    .donut-slice {
      position: absolute;
      top: 0;
      left: 0;
      width: 160px;
      height: 160px;
      pointer-events: none;
    }
    .donut-slice svg {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
    }
    .donut-slice .slice-hit {
      pointer-events: stroke;
      cursor: pointer;
    }
    .donut-slice .slice-visible-svg {
      transition: transform 0.15s ease;
    }
    .donut-slice:hover .slice-visible-svg {
      transform: translate(var(--pop-x, 0px), var(--pop-y, 0px));
    }
    .donut-detail {
      min-width: 200px;
      max-width: 220px;
    }
    .donut-detail-title {
      font-weight: 500;
      margin-bottom: 6px;
      font-size: 0.9rem;
    }
    .donut-detail-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 0.85rem;
      padding: 2px 0;
    }
    .donut-detail-row .over-budget {
      color: var(--error-color, #c62828);
    }
    .donut-detail-recommendation {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--divider-color, #e0e0e0);
      font-size: 0.8rem;
      color: var(--secondary-text-color, #727272);
    }
    .donut-legend {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-left: 12px;
    }
    .donut-legend .legend-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85rem;
    }
    .donut-legend .swatch {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .donut-legend .legend-name {
      flex: 1;
    }
    .donut-legend .legend-amount {
      color: var(--secondary-text-color, #727272);
    }
    .empty {
      color: var(--secondary-text-color, #727272);
      padding: 8px 0;
    }
    .error {
      color: var(--error-color, #c62828);
      font-size: 0.85rem;
      margin: 8px 0 0;
    }
    .category-section {
      margin-bottom: 16px;
    }
    .category-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 0 10px;
    }
    .category-header .swatch {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .category-header .category-name {
      font-weight: 500;
      flex: 1;
    }
    .category-header .category-pct {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
      margin-right: 8px;
    }
    .category-header .category-total {
      font-weight: 500;
      margin-right: 12px;
    }
    .category-header .category-budget {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
      margin-right: 12px;
      white-space: nowrap;
    }
    .category-header .category-budget.over-budget {
      color: var(--error-color, #c62828);
    }
    .item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
    }
    .item-row .item-name {
      font-weight: 500;
    }
    .item-meta {
      color: var(--secondary-text-color, #727272);
      font-size: 0.8rem;
    }
    .item-tag {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--secondary-background-color, #eeeeee);
      color: var(--secondary-text-color, #727272);
      margin-left: 8px;
    }
  `, bankingStyle];

  private _openExpenseDialog(category: Category): void {
    this._editingExpense = null;
    this._expenseCategoryId = category.categoryId;
    this._expenseCategoryName = category.name;
    this._expenseDialogOpen = true;
  }

  private _openEditExpenseDialog(category: Category, expense: CategoryExpense): void {
    this._editingExpense = expense;
    this._expenseCategoryId = category.categoryId;
    this._expenseCategoryName = category.name;
    this._expenseDialogOpen = true;
  }

  private async _deleteExpense(expenseId: string): Promise<void> {
    await financeApi.deleteCategoryExpense(this.hass, expenseId);
  }

  private _openBudgetDialog(category: Category): void {
    this._budgetCategoryId = category.categoryId;
    this._budgetCategoryName = category.name;
    this._budgetAmount = category.plannedBudget ? String(category.plannedBudget) : "";
    this._budgetEditingCategory = category;
    this._budgetDialogOpen = true;
  }

  private async _saveBudget(): Promise<void> {
    if (!this._budgetCategoryId) return;
    this._saving = true;
    try {
      await financeApi.setCategoryBudget(this.hass, this._budgetCategoryId, Number(this._budgetAmount) || 0);
      this._budgetDialogOpen = false;
    } finally {
      this._saving = false;
    }
  }

  private _autoFillBudgetFromBills(): void {
    if (!this._budgetCategoryId) return;
    const currentMonth = today().slice(0, 7);
    const seenLineages = new Set<string>();
    let total = 0;
    for (const bill of this.financeState.bills) {
      if (bill.categoryId !== this._budgetCategoryId || bill.month !== currentMonth) continue;
      // A recurring bill only gets its next instance materialized once the
      // current one is paid, so a weekly/biweekly bill can have anywhere
      // from one to several instances already existing this month depending
      // on the day - summing bill.amount as-is would give an amount that
      // depends on how far through the month you happen to be. Count each
      // recurring series once and scale it to a monthly figure by
      // frequency instead.
      const lineageId = bill.recurringParentId ?? bill.billId;
      if (seenLineages.has(lineageId)) continue;
      seenLineages.add(lineageId);
      total += bill.baseAmount * MONTHLY_BILL_MULTIPLIER[bill.frequency];
    }
    this._budgetAmount = String(Math.round(total * 100) / 100);
  }

  private _recommendationText(category: Category): string {
    if (category.budgetRecommendation === "raise") {
      return `Averaging ${money(category.historicalAverageSpend)}/mo - consistently over budget, consider raising it`;
    }
    if (category.budgetRecommendation === "lower") {
      return `Averaging ${money(category.historicalAverageSpend)}/mo - consistently under budget, consider lowering it`;
    }
    return `Averaging ${money(category.historicalAverageSpend)}/mo - in line with this budget`;
  }

  private _renderBudgetSummary(categories: Category[], totalBills: number) {
    const totalPlanned = categories.reduce((sum, c) => sum + c.plannedBudget, 0);
    const overBudget = totalPlanned > totalBills;
    return html`
      <div class="budget-summary">
        <div class="label">Monthly Bills</div>
        <div class="value">${money(totalBills)}</div>
        <div class="label">Total Budget</div>
        <div class="value ${overBudget ? "over-budget" : ""}">${money(totalPlanned)}</div>
      </div>
    `;
  }

  private _renderBudgetDonut(categories: Category[]) {
    const colorIndex = new Map(categories.map((c, i) => [c.categoryId, i]));
    const budgeted = categories
      .filter((c) => c.plannedBudget > 0)
      .sort((a, b) => b.plannedBudget - a.plannedBudget);
    const totalPlanned = budgeted.reduce((sum, c) => sum + c.plannedBudget, 0);

    let cumulative = 0;
    const popDistance = 8;
    const slices = budgeted.map((c) => {
      const fraction = totalPlanned > 0 ? c.plannedBudget / totalPlanned : 0;
      const length = fraction * CIRCUMFERENCE;
      const offset = -cumulative;
      const midFraction = totalPlanned > 0 ? (cumulative + length / 2) / CIRCUMFERENCE : 0;
      cumulative += length;
      const angle = midFraction * 2 * Math.PI - Math.PI / 2;
      return {
        category: c,
        length,
        offset,
        popX: popDistance * Math.cos(angle),
        popY: popDistance * Math.sin(angle),
      };
    });

    const hovered = budgeted.find((c) => c.categoryId === this._hoveredCategoryId) ?? null;

    return html`
      <div class="donut-wrap">
        <svg class="chart" viewBox="0 0 120 120" width="160" height="160">
          <circle cx="60" cy="60" r="50" fill="none" stroke="var(--divider-color, #e0e0e0)" stroke-width="16" />
        </svg>
        ${slices.map(({ category: c, length, offset, popX, popY }) => {
          return html`
            <div
              class="donut-slice"
              style="--pop-x:${popX.toFixed(2)}px; --pop-y:${popY.toFixed(2)}px;"
              @mouseenter=${() => (this._hoveredCategoryId = c.categoryId)}
              @mouseleave=${() => (this._hoveredCategoryId = null)}
            >
              <svg class="slice-hit-svg" viewBox="0 0 120 120" width="160" height="160">
                ${svg`<circle
                  class="slice-hit"
                  cx="60"
                  cy="60"
                  r="50"
                  fill="none"
                  stroke="transparent"
                  stroke-width="24"
                  stroke-dasharray="${length} ${CIRCUMFERENCE}"
                  stroke-dashoffset="${offset}"
                  transform="rotate(-90 60 60)"
                />`}
              </svg>
              <svg class="slice-visible-svg" viewBox="0 0 120 120" width="160" height="160">
                ${svg`<circle
                  cx="60"
                  cy="60"
                  r="50"
                  fill="none"
                  stroke="${paletteColor(colorIndex.get(c.categoryId)!)}"
                  stroke-width="16"
                  stroke-dasharray="${length} ${CIRCUMFERENCE}"
                  stroke-dashoffset="${offset}"
                  transform="rotate(-90 60 60)"
                />`}
              </svg>
            </div>
          `;
        })}
      </div>
      <div class="donut-detail">
        ${hovered
          ? html`
              <div class="donut-detail-title">${hovered.name}</div>
              <div class="donut-detail-row"><span>Budget</span><span>${money(hovered.plannedBudget)}</span></div>
              <div class="donut-detail-row">
                <span>Spend</span>
                <span class="${hovered.total > hovered.plannedBudget ? "over-budget" : ""}">${money(hovered.total)}</span>
              </div>
              <div class="donut-detail-recommendation">${this._recommendationText(hovered)}</div>
            `
          : html`<div class="empty">Hover a slice to see its details.</div>`}
      </div>
      <div class="donut-legend">
        ${budgeted.length === 0
          ? html`<div class="empty">Set a budget on a category below to see it here.</div>`
          : budgeted.map(
              (c) => html`
                <div class="legend-row">
                  <span class="swatch" style="background:${paletteColor(colorIndex.get(c.categoryId)!)}"></span>
                  <span class="legend-name">${c.name}</span>
                  <span class="legend-amount">${money(c.plannedBudget)}</span>
                </div>
              `
            )}
      </div>
    `;
  }

  private _renderBillRow(bill: Bill) {
    return html`
      <ha-card class="bill-card" role="button" tabindex="0" aria-label=${`View ${bill.name}`}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._selectedBill = bill; }
        }}
        @click=${() => (this._selectedBill = bill)}>
        <div class="bill-row">
          <span class="bill-avatar"><ha-icon icon="mdi:receipt-text-outline"></ha-icon></span>
          <div class="bill-main">
            <div class="bill-name">${bill.name}${bill.payTo ? html` <span class="pay-to">- ${bill.payTo}</span>` : ""}</div>
            <div class="bill-meta">
              Due ${bill.dueDate} · ${bill.frequency.replace("_", " ")}
              ${bill.responsibleMemberId ? html` · Individual: ${this.financeState.members.find(m => m.memberId === bill.responsibleMemberId)?.name ?? "Former member"}` : ""}
              ${bill.status !== "paid" && bill.payments.length > 0 ? html`<span> · ${money(remainingForBill(bill))} left to pay</span>` : ""}
              ${this._sort === "paidDate" && this.section === "bills" ? html`<span> · ${lastPaymentDate(bill) ? `Last payment ${lastPaymentDate(bill)}` : "No recorded payment date"}</span>` : ""}
              ${this._sort === "amountDue" && this.section === "bills" ? html`<span> · Bill total ${money(bill.amount)}</span>` : ""}
              ${bill.lateFee > 0 ? html`<span class="fee-badge">Includes ${money(bill.lateFee)} late fees</span>` : ""}
            </div>
          </div>
          <div class="bill-money"><strong>${money(this.section === "bills" && this._sort === "amountDue" ? remainingForBill(bill) : bill.amount)}</strong><span class="status ${bill.status}">${bill.status.replace("_", " ")}</span></div>
        </div>
      </ha-card>
    `;
  }

  // ------------------------------------------------------------- add bill

  private _openAddBill(): void {
    this._newOwner = "";
    this._newError = "";
    this._newName = "";
    this._newPayTo = "";
    this._newAmount = "";
    this._newCategoryId = this.financeState.categories[0]?.categoryId ?? "";
    this._newDueDate = today();
    this._newFrequency = "monthly";
    this._newBillType = "fixed";
    this._newNotes = "";
    this._addOpen = true;
  }

  private async _saveNewBill(): Promise<void> {
    if (!this._newName.trim() || !this._newCategoryId) return;
    this._saving = true;
    try {
      await financeApi.addBill(this.hass, {
        name: this._newName.trim(),
        pay_to: this._newPayTo.trim(),
        amount: Number(this._newAmount) || 0,
        category_id: this._newCategoryId,
        due_date: this._newDueDate,
        frequency: this._newFrequency,
        bill_type: this._newBillType,
        notes: this._newNotes,
        responsible_member_id: this._newOwner,
      });
      this._addOpen = false;
    } catch (err) {
      this._newError = err instanceof Error ? err.message : String(err);
    } finally {
      this._saving = false;
    }
  }

  private async _saveNewCategory(): Promise<void> {
    if (!this._newCategoryName.trim()) return;
    this._saving = true;
    this._categoryError = "";
    try {
      await financeApi.addCategory(this.hass, this._newCategoryName.trim());
      this._newCategoryName = "";
    } catch (e) {
      this._categoryError = (e as { message?: string })?.message || "Failed to add category.";
    } finally {
      this._saving = false;
    }
  }

  private async _deleteCategory(categoryId: string): Promise<void> {
    await financeApi.deleteCategory(this.hass, categoryId);
  }

  render() {
    const categories = this.financeState.categories;
    const totalBudget = categories.reduce((sum, c) => sum + c.total, 0);
    const knownCategoryIds = new Set(categories.map((c) => c.categoryId));
    const currentMonth = today().slice(0, 7);
    const visibleBills = this.financeState.bills.filter(b => {
      const match = `${b.name} ${b.payTo}`.toLowerCase().includes(this._search.toLowerCase());
      return match && (this._filter === "all" ||
        (this._filter === "outstanding" && b.status !== "paid") ||
        (this._filter === "overdue" && isOverdue(b)) ||
        (this._filter === "deferred" && b.status === "deferred") ||
        (this._filter === "paid" && b.status === "paid"));
    }).sort((a, b) => compareBills(a, b, this._sort, this._sortDirection));
    const unpaid = this.financeState.bills.filter(b => b.status !== "paid");
    const late = unpaid.filter(b => isOverdue(b));
    const uncategorizedBills = this.financeState.bills
      .filter((b) => !knownCategoryIds.has(b.categoryId) && b.month === currentMonth)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    return html`
      <div class="toolbar">
        ${this.section === "budgets" ? html`
        <button
          class="secondary"
          @click=${() => {
            this._categoryError = "";
            this._manageCategoriesOpen = true;
          }}
        >
          Manage Categories
        </button>
        ` : ""}
        <button class="primary" @click=${this._openAddBill}>Add Bill</button>
      </div>

      ${this.section === "bills" ? html`
        <div class="bill-metrics">
          <div><span>Outstanding · all dates</span><strong>${money(unpaid.reduce((sum, b) => sum + remainingForBill(b), 0))}</strong></div>
          <div class="late"><span>Overdue · ${late.length} bills</span><strong>${money(late.reduce((sum, b) => sum + remainingForBill(b), 0))}</strong></div>
          <div class="done"><span>Paid this month</span><strong>${money(this.financeState.summary.paid)}</strong></div>
        </div>
        <div class="bill-controls">
          <input type="search" aria-label="Search bills" placeholder="Search bills or payees" .value=${this._search} @input=${(e: InputEvent) => (this._search = (e.target as HTMLInputElement).value)} />
          <select aria-label="Bill status" .value=${this._filter} @change=${(e: Event) => (this._filter = (e.target as HTMLSelectElement).value)}>
            <option value="outstanding">Outstanding</option><option value="overdue">Overdue</option><option value="deferred">Deferred</option><option value="paid">Paid</option><option value="all">All bills</option>
          </select>
        </div>
        <div class="sort-controls">
          <label for="bill-sort">Sort by</label>
          <select id="bill-sort" .value=${this._sort} @change=${(e: Event) => {
            this._sort = (e.target as HTMLSelectElement).value as BillSortKey;
            this._sortDirection = this._sort === "paidDate" || this._sort === "amountDue" ? "desc" : "asc";
          }}>
            <option value="dueDate">Due date</option><option value="paidDate">When paid</option>
            <option value="name">Name</option><option value="payTo">Pay to</option><option value="amountDue">Amount due</option>
          </select>
          <select aria-label="Sort direction" .value=${this._sortDirection} @change=${(e: Event) => (this._sortDirection = (e.target as HTMLSelectElement).value as SortDirection)}>
            <option value="asc">${this._sort === "name" || this._sort === "payTo" ? "A–Z" : this._sort === "amountDue" ? "Lowest first" : "Oldest first"}</option>
            <option value="desc">${this._sort === "name" || this._sort === "payTo" ? "Z–A" : this._sort === "amountDue" ? "Highest first" : "Newest first"}</option>
          </select>
        </div>
        <div class="bill-list">
          <div class="list-caption"><span>${visibleBills.length} bills${this._sort === "paidDate" ? " · latest recorded payment date" : ""}</span><span>${this._sort === "amountDue" ? "Amount due" : "Bill total"}</span></div>
          ${visibleBills.map(b => this._renderBillRow(b))}
          ${!visibleBills.length ? html`<p class="empty">No bills match this view.</p>` : ""}
        </div>
      ` : html`
      <section>
        <h2>Monthly budget</h2>
        <ha-card class="budget-totals">
          ${this._renderBudgetSummary(categories, this.financeState.summary.totalBills)}
        </ha-card>
        <details class="allocation"><summary>Budget allocation chart</summary>
          <ha-card class="budget-card">${this._renderBudgetDonut(categories)}</ha-card>
        </details>
      </section>

      ${categories.map((category, i) => {
        const categoryBills = this.financeState.bills
          .filter((b) => b.categoryId === category.categoryId && b.month === currentMonth)
          .sort((a, b) => b.amount - a.amount);
        const pct = totalBudget > 0 ? (category.total / totalBudget) * 100 : 0;
        const overBudget = category.plannedBudget > 0 && category.total > category.plannedBudget;
        return html`
          <ha-card class="category-section">
            <div class="category-header">
              <div class="swatch" style="background:${paletteColor(i)}"></div>
              <span class="category-name">${category.name}</span>
              <span class="category-pct">${pct.toFixed(1)}%</span>
              <span class="category-total">${money(category.total)}</span>
              <span class="category-budget ${overBudget ? "over-budget" : ""}">
                ${category.plannedBudget > 0
                  ? html`of ${money(category.plannedBudget)} budget`
                  : "no budget set"}
              </span>
              <button class="link" @click=${() => this._openBudgetDialog(category)}>
                ${category.plannedBudget > 0 ? "Edit Budget" : "Set Budget"}
              </button>
              <button class="link" @click=${() => this._openExpenseDialog(category)}>+ Add Item</button>
            </div>
            ${categoryBills.length === 0 && category.expenses.length === 0
              ? html`<div class="empty">Nothing in this category yet.</div>`
              : ""}
            ${categoryBills.map((bill) => this._renderBillRow(bill))}
            ${category.expenses.map(
              (expense) => html`
                <div class="item-row">
                  <div>
                    <span class="item-name">${expense.name}</span>
                    <span class="item-tag">item</span>
                    <div class="item-meta">
                      ${expense.date}${expense.notes ? html` - ${expense.notes}` : ""}
                    </div>
                  </div>
                  <div>
                    <span>${money(expense.amount)}</span>
                    <button
                      class="link"
                      @click=${() => this._openEditExpenseDialog(category, expense)}
                    >
                      Edit
                    </button>
                    <button class="link" @click=${() => this._deleteExpense(expense.id)}>Delete</button>
                  </div>
                </div>
              `
            )}
          </ha-card>
        `;
      })}

      ${uncategorizedBills.length > 0
        ? html`
            <ha-card class="category-section">
              <div class="category-header">
                <span class="category-name">Uncategorized</span>
              </div>
              ${uncategorizedBills.map((bill) => this._renderBillRow(bill))}
            </ha-card>
          `
        : ""}

      `}

      <finance-dialog heading="Add Bill" .open=${this._addOpen} @finance-dialog-closed=${() => (this._addOpen = false)}>
        <label>Name</label>
        <input .value=${this._newName} @input=${(e: InputEvent) => (this._newName = (e.target as HTMLInputElement).value)} />
        <label>Pay to (company)</label>
        <input .value=${this._newPayTo} @input=${(e: InputEvent) => (this._newPayTo = (e.target as HTMLInputElement).value)} />
        <label>Amount</label>
        <input type="number" step="0.01" .value=${this._newAmount} @input=${(e: InputEvent) => (this._newAmount = (e.target as HTMLInputElement).value)} />
        <label>Category</label>
        <select @change=${(e: Event) => (this._newCategoryId = (e.target as HTMLSelectElement).value)}>
          ${this.financeState.categories.map(
            (c) => html`<option value=${c.categoryId} ?selected=${c.categoryId === this._newCategoryId}>${c.name}</option>`
          )}
        </select>
        <label>Due date</label>
        <input type="date" .value=${this._newDueDate} @input=${(e: InputEvent) => (this._newDueDate = (e.target as HTMLInputElement).value)} />
        <label>Frequency</label>
        <select @change=${(e: Event) => (this._newFrequency = (e.target as HTMLSelectElement).value)}>
          ${FREQUENCIES.map((f) => html`<option value=${f} ?selected=${f === this._newFrequency}>${f.replace("_", " ")}</option>`)}
        </select>
        <label>Bill type</label>
        <select @change=${(e: Event) => (this._newBillType = (e.target as HTMLSelectElement).value)}>
          ${BILL_TYPES.map((t) => html`<option value=${t} ?selected=${t === this._newBillType}>${t}</option>`)}
        </select>
        <label for="new-owner">Responsible person</label>
        <select id="new-owner" @change=${(e: Event) => (this._newOwner = (e.target as HTMLSelectElement).value)}>
          <option value="" ?selected=${!this._newOwner}>Shared household</option>
          ${this.financeState.members.map(m => html`<option value=${m.memberId} ?selected=${m.memberId === this._newOwner}>Individual · ${m.name}</option>`)}
        </select>
        ${this._newError ? html`<p role="alert">${this._newError}</p>` : ""}
        <label>Notes</label>
        <input .value=${this._newNotes} @input=${(e: InputEvent) => (this._newNotes = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._addOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveNewBill}>Save</button>
        </div>
      </finance-dialog>

      <finance-dialog
        heading="Manage Categories"
        .open=${this._manageCategoriesOpen}
        @finance-dialog-closed=${() => (this._manageCategoriesOpen = false)}
      >
        <div class="category-list">
          ${this.financeState.categories.map(
            (c) => html`
              <div class="category-row">
                <span>${c.name}</span>
                <button class="link" @click=${() => this._deleteCategory(c.categoryId)}>Remove</button>
              </div>
            `
          )}
        </div>
        <label>New category name</label>
        <div class="contribution-row">
          <input
            .value=${this._newCategoryName}
            @input=${(e: InputEvent) => (this._newCategoryName = (e.target as HTMLInputElement).value)}
          />
          <button class="secondary" ?disabled=${this._saving} @click=${this._saveNewCategory}>Add</button>
        </div>
        ${this._categoryError ? html`<p class="error">${this._categoryError}</p>` : ""}
        <div class="actions">
          <button class="primary" @click=${() => (this._manageCategoriesOpen = false)}>Done</button>
        </div>
      </finance-dialog>

      <finance-bill-workspace
        .hass=${this.hass}
        .financeState=${this.financeState}
        .bill=${this._selectedBill}
        @bill-workspace-closed=${() => (this._selectedBill = null)}
      ></finance-bill-workspace>

      <finance-category-expense-dialog
        .hass=${this.hass}
        .open=${this._expenseDialogOpen}
        .categoryId=${this._expenseCategoryId}
        .categoryName=${this._expenseCategoryName}
        .expense=${this._editingExpense}
        @category-expense-closed=${() => {
          this._expenseDialogOpen = false;
          this._editingExpense = null;
        }}
      ></finance-category-expense-dialog>

      <finance-dialog
        heading=${this._budgetEditingCategory && this._budgetEditingCategory.plannedBudget > 0
          ? `Edit Budget - ${this._budgetCategoryName}`
          : `Set Budget - ${this._budgetCategoryName}`}
        .open=${this._budgetDialogOpen}
        @finance-dialog-closed=${() => (this._budgetDialogOpen = false)}
      >
        ${this._budgetEditingCategory && this._budgetEditingCategory.plannedBudget > 0
          ? html`
              <div class="budget-history">
                <div class="budget-history-row">
                  <span>Current budget</span><span>${money(this._budgetEditingCategory.plannedBudget)}</span>
                </div>
                <div class="budget-history-row">
                  <span>Average spend (last 3 mo)</span>
                  <span>${money(this._budgetEditingCategory.historicalAverageSpend)}</span>
                </div>
                <div class="budget-history-row">
                  <span>Last month's spend</span><span>${money(this._budgetEditingCategory.lastMonthSpend)}</span>
                </div>
              </div>
            `
          : ""}
        <label>Planned monthly budget</label>
        <input
          type="number"
          step="0.01"
          .value=${this._budgetAmount}
          @input=${(e: InputEvent) => (this._budgetAmount = (e.target as HTMLInputElement).value)}
        />
        <button class="link" @click=${this._autoFillBudgetFromBills}>
          Auto-set from this month's bills
        </button>
        <div class="actions">
          <button class="secondary" @click=${() => (this._budgetDialogOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveBudget}>Save</button>
        </div>
      </finance-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-bills-view": FinanceBillsView;
  }
}
