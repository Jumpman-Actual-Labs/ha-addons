import { LitElement, css, html, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { financeApi } from "../ha-api";
import type { Bill, BillPayment, Contribution, FinanceState } from "../types";
import { money } from "../format";
import { isOverdue, outstandingInSeries, recentSeriesPayments, remainingForBill, seriesPayTo, type BillSeries } from "../bill-selectors";
import { glassCardStyle, bankingStyle } from "../styles";
import { paletteColor } from "../colors";
import "./finance-dialog";

const CIRCUMFERENCE = 2 * Math.PI * 50;

type PaymentStep = "choose" | "normal" | "partial" | "deferred";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Bill details (with payment history) plus the payment/edit/late-fee flows
 * reachable from it. Shared by the Bills tab and the Overview dashboard so
 * a bill can be opened and paid without navigating away from either page.
 *
 * Driven by the `bill` property: set it to open the details dialog, and
 * listen for `bill-workspace-closed` to know when the caller should clear
 * it (the sub-dialogs it opens - edit/pay/late fee - are otherwise fully
 * self-contained local state).
 *
 * With `series` set (the Budgets tab), the details show the bill as a whole -
 * the next payment due and the last 3 payments across every occurrence -
 * and `bill` should be the series' focus occurrence, which Pay/Edit act on.
 */
@customElement("finance-bill-workspace")
export class FinanceBillWorkspace extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) financeState!: FinanceState;
  @property({ attribute: false }) bill: Bill | null = null;
  @property({ attribute: false }) series: BillSeries | null = null;

  @state() private _saving = false;

  // Edit bill dialog
  @state() private _editOpen = false;
  @state() private _editBillId = "";
  @state() private _editName = "";
  @state() private _editPayTo = "";
  @state() private _editAmount = "";
  @state() private _editCategoryId = "";
  @state() private _editDueDate = today();
  @state() private _editFrequency = "monthly";
  @state() private _editBillType = "fixed";
  @state() private _editNotes = "";
  @state() private _editOwner = "";
  @state() private _editError = "";

  // Mark payment dialog
  @state() private _paymentBill: Bill | null = null;
  @state() private _paymentStep: PaymentStep = "choose";
  @state() private _paymentDate = today();
  @state() private _paymentNotes = "";
  @state() private _contributions: Contribution[] = [];
  // Drives the partial-payment auto-split: entering a total here
  // redistributes it across the household by each member's share of this
  // bill, unless _paidIndividually is set, in which case it's all
  // attributed to one person instead.
  @state() private _partialTotalAmount = "";
  @state() private _paidIndividually = false;
  @state() private _deferUntil = today();
  @state() private _deferReason = "";

  // Late fee dialog
  @state() private _feeBill: Bill | null = null;
  @state() private _feeAmount = "";
  @state() private _feeError = "";

  // Edit payment dialog - lets a historical payment record be corrected
  // (date, notes, and per-member contributions) or removed entirely.
  @state() private _editingPayment: BillPayment | null = null;
  @state() private _editingPaymentBill: Bill | null = null;
  @state() private _editPaymentDate = today();
  @state() private _editPaymentNotes = "";
  @state() private _editPaymentContributions: Contribution[] = [];
  @state() private _editPaymentError = "";

  static styles = [glassCardStyle, bankingStyle, css`
    label { display:block; margin:16px 0 6px; }
    input, select, textarea { display:block; box-sizing:border-box; width:100%; min-width:0; padding:11px 12px; border:1px solid var(--divider-color, #ccd3dd); border-radius:9px; background:var(--secondary-background-color, #f5f6fa); color:var(--primary-text-color, #172d32); font:inherit; font-size:.9rem; }
    textarea { resize:vertical; min-height:84px; }
    .contribution-row select, .contribution-row input { width:0; }
    .edit-bill-dialog { --finance-dialog-max-width:640px; }
    .form-intro { margin:0 0 24px; color:var(--secondary-text-color); font-size:.82rem; line-height:1.6; }
    .bill-form { border:0; padding:0; margin:0; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px 20px; min-width:0; }
    .field { min-width:0; } .field.full, .full { grid-column:1 / -1; }
    .field label { margin:0 0 7px; font-weight:600; font-size:.8rem; }
    .field label span { font-weight:400; color:var(--secondary-text-color); }
    .field small, .field-help { color:var(--secondary-text-color); font-size:.72rem; line-height:1.5; }
    .field small { display:block; margin-top:6px; } .field-help { margin:-6px 0 0; }
    .form-actions { background:var(--card-background-color); border-top:1px solid var(--divider-color); padding:16px 24px; margin:0; }
    .edit-bill-dialog input, .edit-bill-dialog select { color-scheme:dark; }
    @media(max-width:540px) { .bill-form { grid-template-columns:minmax(0,1fr); gap:16px; } .field input, .field select, .field textarea { font-size:16px; } .form-actions button { flex:1; } }
    .bill-breakdown { padding: 16px; border-radius: 12px; background: var(--secondary-background-color, #f5f5f5); margin-bottom: 20px; }
    .bill-breakdown > div { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; }
    .bill-breakdown .total { border-top: 1px solid var(--divider-color, #ddd); margin-top: 8px; padding-top: 12px; }
    .budget-card { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 24px; padding: 20px; }
    .donut-legend { display: flex; flex-direction: column; gap: 6px; margin-left: 12px; }
    .donut-legend .legend-row { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; }
    .donut-legend .swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
    .donut-legend .legend-name { flex: 1; }
    .donut-legend .legend-amount { color: var(--secondary-text-color, #727272); }
    .bill-details-notes { margin: 4px 0 16px; padding: 12px; border-radius: 8px; background: var(--secondary-background-color, #f5f5f5); font-size: 0.9rem; }
    .bill-details-history-title { font-weight: 500; margin-bottom: 4px; }
    .next-due { padding: 16px; border-radius: 12px; background: var(--secondary-background-color, #f5f5f5); margin-bottom: 20px; }
    .next-due-label { font-size: 0.8rem; color: var(--secondary-text-color, #727272); }
    .next-due-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 4px; }
    .next-due-row strong { font-size: 1.2rem; font-variant-numeric: tabular-nums; }
    .next-due-then { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--divider-color, #ddd); font-size: 0.85rem; color: var(--secondary-text-color, #727272); }
    .next-due .status { font-size: 0.8rem; padding: 3px 8px; border-radius: 12px; text-transform: capitalize; white-space: nowrap; }
    .next-due .status.unpaid { background: var(--stash-muted-bg); color: var(--secondary-text-color); }
    .next-due .status.partially_paid { background: var(--stash-warning-bg); color: var(--stash-warning); }
    .next-due .status.deferred { background: var(--stash-deferred-bg); color: var(--stash-deferred); }
    .next-due .status.overdue { background: var(--stash-danger-bg); color: var(--stash-danger); }
    .history-entry-for { color: var(--secondary-text-color, #727272); font-size: 0.8rem; margin-top: 2px; }
    .bill-details-actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center; margin-top: 20px; }
    .history-entry { padding: 12px 0; border-bottom: 1px solid var(--divider-color, #e0e0e0); }
    .history-entry:last-child { border-bottom: none; }
    .history-entry-header { display: flex; justify-content: space-between; font-weight: 500; }
    .history-entry-meta { display: flex; align-items: center; gap: 8px; color: var(--secondary-text-color, #727272); font-size: 0.85rem; margin-top: 2px; }
    .history-entry-meta .history-edit { margin-left: auto; font-size: 0.8rem; padding: 0; }
    .history-entry-meta .tag { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; text-transform: capitalize; }
    .history-entry-meta .tag.late { background: var(--stash-danger-bg); color: var(--stash-danger); }
    .history-entry-meta .tag.on-time { background: var(--stash-success-bg); color: var(--stash-success); }
    .history-contributions { margin-top: 8px; padding-left: 12px; }
    .history-contribution-row { display: flex; justify-content: space-between; font-size: 0.85rem; color: var(--secondary-text-color, #727272); padding: 2px 0; }
    .history-entry-notes { margin-top: 6px; font-size: 0.85rem; color: var(--secondary-text-color, #727272); font-style: italic; }
    button.link { background: none; border: none; color: var(--primary-color, #03a9f4); cursor: pointer; padding: 4px 0; }
    button.option { display: block; width: 100%; text-align: left; background: var(--secondary-background-color, #f5f5f5); border: 1px solid var(--divider-color, #e0e0e0); border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; font-size: 1rem; cursor: pointer; }
    .contribution-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .contribution-row select { flex: 2; }
    .contribution-row input { flex: 1; }
    .share-hint { display: flex; align-items: center; gap: 8px; color: var(--secondary-text-color, #727272); font-size: 0.8rem; margin: -4px 0 8px; }
    .checkbox-field { display: flex; align-items: center; gap: 8px; margin: 16px 0 6px; }
    .checkbox-field input { width: auto; }
    .totals { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--divider-color, #e0e0e0); }
    .totals .row { display: flex; justify-content: space-between; padding: 4px 0; }
    .error { color: var(--error-color, #c62828); font-size: 0.85rem; margin: 8px 0 0; }
    .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  `];

  private _close(): void {
    this.dispatchEvent(new CustomEvent("bill-workspace-closed", { bubbles: true, composed: true }));
  }

  // ------------------------------------------------------------ late fee

  private _openLateFee(bill: Bill): void {
    this._close();
    this._feeBill = bill;
    this._feeAmount = String(bill.lateFee);
    this._feeError = "";
  }

  private async _saveLateFee(): Promise<void> {
    if (!this._feeBill || this._saving) return;
    const amount = Number(this._feeAmount);
    if (!this._feeAmount.trim() || !Number.isFinite(amount) || amount < 0) {
      this._feeError = "Enter a valid amount of zero or more.";
      return;
    }
    this._saving = true;
    this._feeError = "";
    try {
      await financeApi.setBillLateFee(this.hass, this._feeBill.billId, amount);
      this._feeBill = null;
    } catch (err) {
      this._feeError = err instanceof Error ? err.message : String(err);
    } finally {
      this._saving = false;
    }
  }

  // -------------------------------------------------------------- details

  private _payBillFromDetails(bill: Bill): void {
    this._close();
    this._openPayment(bill);
  }

  private _editBillFromDetails(bill: Bill): void {
    this._close();
    this._openEditBill(bill);
  }

  private async _deleteBillFromDetails(bill: Bill): Promise<void> {
    this._close();
    await financeApi.deleteBill(this.hass, bill.billId);
  }

  private _memberName(memberId: string): string {
    return this.financeState.members.find((m) => m.memberId === memberId)?.name ?? memberId;
  }

  private _paymentTypeLabel(type: BillPayment["type"]): string {
    if (type === "individual") return "Paid Individually";
    if (type === "partial") return "Partial Payment";
    return "Paid Normally";
  }

  private _renderBillHistory(bill: Bill) {
    if (bill.payments.length === 0) {
      return html`<div class="empty">No payments recorded yet.</div>`;
    }
    return html`${[...bill.payments].reverse().map((p) => this._renderHistoryEntry(bill, p))}`;
  }

  private _renderSeriesDetails(series: BillSeries) {
    const [next, ...later] = outstandingInSeries(series);
    const recent = recentSeriesPayments(series, 3);
    return html`
      <div class="next-due">
        <div class="next-due-label">Next payment due</div>
        ${next
          ? html`
              <div class="next-due-row">
                <span>${next.dueDate}</span>
                <strong>${money(remainingForBill(next))}</strong>
                <span class="status ${isOverdue(next) ? "overdue" : next.status}">${isOverdue(next) ? "overdue" : next.status.replace("_", " ")}</span>
              </div>
              ${later.length > 0
                ? html`<div class="next-due-then">Then ${later.map((b) => `${money(remainingForBill(b))} due ${b.dueDate}`).join(", ")}</div>`
                : ""}
            `
          : html`<div class="empty">All caught up - nothing due.</div>`}
      </div>
      <div class="bill-details-history-title">Past payments</div>
      ${recent.length === 0
        ? html`<div class="empty">No payments recorded yet.</div>`
        : recent.map(({ bill, payment }) => this._renderHistoryEntry(bill, payment, true))}
    `;
  }

  private _renderHistoryEntry(bill: Bill, p: BillPayment, showDue = false) {
    return html`
          <div class="history-entry">
            <div class="history-entry-header">
              <span>${this._paymentTypeLabel(p.type)}</span>
              <span>${money(p.total)}</span>
            </div>
            <div class="history-entry-meta">
              Paid ${p.date}
              ${p.isLate
                ? html`<span class="tag late">late</span>`
                : html`<span class="tag on-time">on time</span>`}
              <button class="link history-edit" @click=${() => this._openEditPayment(bill, p)}>Edit</button>
            </div>
            ${p.contributions.length > 0
              ? html`
                  <div class="history-contributions">
                    ${p.contributions.map(
                      (c) => html`
                        <div class="history-contribution-row">
                          <span>${this._memberName(c.memberId)}</span>
                          <span>${money(c.amount)}</span>
                        </div>
                      `
                    )}
                  </div>
                `
              : ""}
            ${showDue ? html`<div class="history-entry-for">For the bill due ${bill.dueDate}</div>` : ""}
            ${p.notes ? html`<div class="history-entry-notes">${p.notes}</div>` : ""}
          </div>
    `;
  }

  // ---------------------------------------------------------- edit payment

  private _openEditPayment(bill: Bill, payment: BillPayment): void {
    this._editingPayment = payment;
    this._editingPaymentBill = bill;
    this._editPaymentDate = payment.date;
    this._editPaymentNotes = payment.notes;
    this._editPaymentContributions = payment.contributions.map((c) => ({
      member_id: c.memberId,
      amount: c.amount,
    }));
    this._editPaymentError = "";
  }

  private _closeEditPayment(): void {
    this._editingPayment = null;
    this._editingPaymentBill = null;
  }

  private async _saveEditPayment(): Promise<void> {
    if (!this._editingPayment || this._saving) return;
    this._saving = true;
    this._editPaymentError = "";
    try {
      const fields: { payment_date?: string; notes?: string; contributions?: Contribution[] } = {
        payment_date: this._editPaymentDate,
        notes: this._editPaymentNotes,
      };
      // A normal payment covers the bill in full by definition - there's no
      // per-member breakdown to send back for it.
      if (this._editingPayment.type !== "normal") {
        fields.contributions = this._editPaymentContributions.filter(
          (c) => c.member_id && c.amount > 0
        );
      }
      await financeApi.editPayment(this.hass, this._editingPayment.id, fields);
      this._closeEditPayment();
    } catch (err) {
      this._editPaymentError = err instanceof Error ? err.message : String(err);
    } finally {
      this._saving = false;
    }
  }

  private async _deleteEditingPayment(): Promise<void> {
    if (!this._editingPayment || this._saving) return;
    this._saving = true;
    try {
      await financeApi.deletePayment(this.hass, this._editingPayment.id);
      this._closeEditPayment();
    } finally {
      this._saving = false;
    }
  }

  private _renderBillResponsibilityDonut(bill: Bill) {
    const members = this.financeState.members;
    const myId = members.find((m) => m.haUserId === this.hass.user?.id)?.memberId;
    let cumulative = 0;
    const arcs = members.map((m, i) => {
      const amount = bill.responsibility[m.memberId] ?? 0;
      const fraction = bill.amount > 0 ? amount / bill.amount : 0;
      const length = fraction * CIRCUMFERENCE;
      const offset = -cumulative;
      cumulative += length;
      return svg`<circle
        cx="60"
        cy="60"
        r="50"
        fill="none"
        stroke="${paletteColor(i)}"
        stroke-width="16"
        stroke-dasharray="${length} ${CIRCUMFERENCE}"
        stroke-dashoffset="${offset}"
        transform="rotate(-90 60 60)"
      />`;
    });
    return html`
      <div class="budget-card">
        <svg viewBox="0 0 120 120" width="140" height="140">
          <circle cx="60" cy="60" r="50" fill="none" stroke="var(--divider-color, #e0e0e0)" stroke-width="16" />
          ${arcs}
        </svg>
        <div class="donut-legend">
          ${members.map(
            (m, i) => html`
              <div class="legend-row">
                <span class="swatch" style="background:${paletteColor(i)}"></span>
                <span class="legend-name">${m.name}${m.memberId === myId ? " (You)" : ""}</span>
                <span class="legend-amount">${money(bill.responsibility[m.memberId] ?? 0)}</span>
              </div>
            `
          )}
        </div>
      </div>
    `;
  }

  private _renderBillDetailsContent() {
    const bill = this.bill;
    if (!bill) return html``;
    if (this.series) {
      return html`
        ${this._renderSeriesDetails(this.series)}
        <p class="bill-meta">${seriesPayTo(this.series) ? `Paid to ${seriesPayTo(this.series)} · ` : ""}${bill.frequency.replace("_", " ")} · ${bill.responsibleMemberId ? `Individual bill · ${this._memberName(bill.responsibleMemberId)}` : "Shared household bill"}</p>
        ${bill.notes ? html`<div class="bill-details-notes"><strong>Notes:</strong> ${bill.notes}</div>` : ""}
        ${this._renderDetailsActions(bill)}
      `;
    }
    return html`
      <div class="bill-breakdown">
        <div><span>Original amount</span><strong>${money(bill.baseAmount)}</strong></div>
        <div><span>Late fees</span><strong>${money(bill.lateFee)}</strong></div>
        <div class="total"><span>Total due</span><strong>${money(bill.amount)}</strong></div>
      </div>
      <p class="bill-meta">${bill.responsibleMemberId ? `Individual bill · ${this._memberName(bill.responsibleMemberId)} is responsible for 100%. Payments do not create household reimbursement debts.` : "Shared household bill"}</p>
      ${this._renderBillResponsibilityDonut(bill)}
      ${bill.notes ? html`<div class="bill-details-notes"><strong>Notes:</strong> ${bill.notes}</div>` : ""}
      <div class="bill-details-history-title">Payment History</div>
      ${this._renderBillHistory(bill)}
      ${this._renderDetailsActions(bill)}
    `;
  }

  private _renderDetailsActions(bill: Bill) {
    return html`
      <div class="bill-details-actions">
        <button class="link" @click=${() => this._deleteBillFromDetails(bill)}>Delete</button>
        <div class="actions">
          ${bill.status !== "paid" ? html`<button class="secondary" @click=${() => this._openLateFee(bill)}>${bill.lateFee > 0 ? "Edit Late Fees" : "Add Late Fee"}</button>` : ""}
          <button class="secondary" @click=${() => this._editBillFromDetails(bill)}>Edit Bill</button>
          <button class="primary" @click=${() => this._payBillFromDetails(bill)}>Pay Bill</button>
        </div>
      </div>
    `;
  }

  // ------------------------------------------------------------- edit bill

  private _openEditBill(bill: Bill): void {
    this._editOwner = bill.responsibleMemberId ?? "";
    this._editError = "";
    this._editBillId = bill.billId;
    this._editName = bill.name;
    this._editPayTo = bill.payTo;
    this._editAmount = String(bill.baseAmount);
    this._editCategoryId = bill.categoryId;
    this._editDueDate = bill.dueDate;
    this._editFrequency = bill.frequency;
    this._editBillType = bill.billType;
    this._editNotes = bill.notes;
    this._editOpen = true;
  }

  private async _saveEditBill(): Promise<void> {
    if (!this._editBillId || this._saving) return;
    const amount = Number(this._editAmount);
    if (!this._editName.trim() || !this._editAmount.trim() || !Number.isFinite(amount) || amount < 0 || !this._editDueDate) {
      this._editError = "Enter a name, a valid amount, and a due date.";
      return;
    }
    this._editError = "";
    this._saving = true;
    try {
      await financeApi.editBill(this.hass, this._editBillId, {
        name: this._editName.trim(),
        pay_to: this._editPayTo.trim(),
        amount,
        responsible_member_id: this._editOwner,
        category_id: this._editCategoryId,
        due_date: this._editDueDate,
        frequency: this._editFrequency,
        bill_type: this._editBillType,
        notes: this._editNotes,
      });
      this._editOpen = false;
    } catch (err) {
      this._editError = err instanceof Error ? err.message : String(err);
    } finally {
      this._saving = false;
    }
  }

  // -------------------------------------------------------- mark payment

  private _openPayment(bill: Bill): void {
    this._paymentBill = bill;
    this._paymentStep = "choose";
    this._paymentDate = today();
    this._paymentNotes = "";
    const myMember = this.financeState.members.find((m) => m.haUserId === this.hass.user?.id);
    const defaultMemberId = bill.responsibleMemberId ?? myMember?.memberId ?? this.financeState.members[0]?.memberId ?? "";
    // Default to what's actually still owed (bill amount less any prior
    // partial payments), not the member's proportional share - one person
    // paying the whole bill is the common case, and "Use share" is right
    // there for the split case.
    const alreadyPaid = bill.payments.reduce((sum, p) => sum + p.total, 0);
    const totalDue = Math.max(bill.amount - alreadyPaid, 0);
    this._contributions = [{ member_id: defaultMemberId, amount: totalDue }];
    this._partialTotalAmount = String(totalDue);
    this._paidIndividually = false;
    this._deferUntil = today();
    this._deferReason = "";
  }

  private _enterPartialStep(paidIndividually: boolean): void {
    this._paidIndividually = paidIndividually;
    this._paymentStep = "partial";
    this._recomputeSplit();
  }

  // Redistributes bill.responsibility's per-member shares proportionally
  // across the entered total (not each member's full share of the whole
  // bill - a partial payment is usually less than that). Remainder cents
  // from rounding go to the largest share so the split always sums exactly
  // to the entered total.
  private _splitByResponsibility(total: number, bill: Bill): Contribution[] {
    const entries = Object.entries(bill.responsibility)
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      const fallback = bill.responsibleMemberId || this.financeState.members[0]?.memberId || "";
      return [{ member_id: fallback, amount: total }];
    }
    const shareSum = entries.reduce((sum, [, amount]) => sum + amount, 0);
    const totalCents = Math.round(total * 100);
    const shares = entries.map(([, amount]) => Math.round((amount / shareSum) * totalCents));
    shares[0] += totalCents - shares.reduce((sum, c) => sum + c, 0);
    return entries.map(([memberId], i) => ({ member_id: memberId, amount: shares[i] / 100 }));
  }

  private _recomputeSplit(): void {
    const bill = this._paymentBill;
    if (!bill) return;
    const total = Number(this._partialTotalAmount) || 0;
    if (this._paidIndividually) {
      const myMember = this.financeState.members.find((m) => m.haUserId === this.hass.user?.id);
      const memberId =
        this._contributions[0]?.member_id ||
        bill.responsibleMemberId ||
        myMember?.memberId ||
        this.financeState.members[0]?.memberId ||
        "";
      this._contributions = [{ member_id: memberId, amount: total }];
    } else {
      this._contributions = this._splitByResponsibility(total, bill);
    }
  }

  private _closePayment(): void {
    this._paymentBill = null;
  }

  private async _submitNormal(): Promise<void> {
    if (!this._paymentBill) return;
    this._saving = true;
    try {
      await financeApi.markPaidNormal(
        this.hass,
        this._paymentBill.billId,
        this._paymentDate,
        this._paymentNotes
      );
      this._closePayment();
    } finally {
      this._saving = false;
    }
  }

  private async _submitContributions(kind: "individual" | "partial"): Promise<void> {
    if (!this._paymentBill) return;
    this._saving = true;
    try {
      const contributions = this._contributions.filter((c) => c.member_id && c.amount > 0);
      if (kind === "individual") {
        await financeApi.markPaidIndividual(
          this.hass,
          this._paymentBill.billId,
          contributions,
          this._paymentDate,
          this._paymentNotes
        );
      } else {
        await financeApi.markPaidPartial(
          this.hass,
          this._paymentBill.billId,
          contributions,
          this._paymentDate,
          this._paymentNotes
        );
      }
      this._closePayment();
    } finally {
      this._saving = false;
    }
  }

  private async _submitDefer(): Promise<void> {
    if (!this._paymentBill) return;
    this._saving = true;
    try {
      await financeApi.deferBill(
        this.hass,
        this._paymentBill.billId,
        this._deferUntil,
        this._deferReason,
        this._paymentNotes
      );
      this._closePayment();
    } finally {
      this._saving = false;
    }
  }

  // Shared by the Mark Payment flow (against this._contributions) and the
  // Edit Payment flow (against this._editPaymentContributions) - takes the
  // array and a setter so both can reuse the same rows/totals UI without
  // duplicating it.
  private _renderContributionEditor(
    contributions: Contribution[],
    bill: Bill | null,
    onChange: (next: Contribution[]) => void
  ) {
    const update = (index: number, field: "member_id" | "amount", value: string) => {
      const next = [...contributions];
      next[index] = { ...next[index], [field]: field === "amount" ? Number(value) || 0 : value };
      onChange(next);
    };
    const remove = (index: number) => onChange(contributions.filter((_, i) => i !== index));
    const add = () =>
      onChange([...contributions, { member_id: this.financeState.members[0]?.memberId ?? "", amount: 0 }]);
    const total = contributions.reduce((sum, c) => sum + c.amount, 0);
    return html`
      ${bill?.responsibleMemberId ? html`<p class="bill-meta">Individual bill for ${this._memberName(bill.responsibleMemberId)}. Payments do not create household reimbursement debts.</p>` : ""}
      ${contributions.map((c, i) => {
        const share = bill?.responsibility[c.member_id] ?? 0;
        return html`
          <div class="contribution-row">
            <select @change=${(e: Event) => update(i, "member_id", (e.target as HTMLSelectElement).value)}>
              ${this.financeState.members.map(
                (m) => html`<option value=${m.memberId} ?selected=${m.memberId === c.member_id}>${m.name}</option>`
              )}
            </select>
            <input
              type="number"
              step="0.01"
              .value=${String(c.amount)}
              @input=${(e: InputEvent) => update(i, "amount", (e.target as HTMLInputElement).value)}
            />
            <button class="link" @click=${() => remove(i)}>Remove</button>
          </div>
          <div class="share-hint">
            Their share: ${money(share)}
            <button class="link" @click=${() => update(i, "amount", String(share))}>Use share</button>
          </div>
        `;
      })}
      <button class="link" @click=${add}>+ Add contributor</button>
      <div class="totals">
        <div class="row"><span>Total paid</span><span>${money(total)}</span></div>
        <div class="row">
          <span>Remaining</span>
          <span>${money(Math.max((bill?.amount ?? 0) - total, 0))}</span>
        </div>
      </div>
    `;
  }

  private _renderPaymentDialogContent() {
    const bill = this._paymentBill;
    if (!bill) return html``;

    if (this._paymentStep === "choose") {
      return html`
        <button class="option" @click=${() => (this._paymentStep = "normal")}>Paid Normally</button>
        <button class="option" @click=${() => this._enterPartialStep(true)}>Paid Individually</button>
        <button class="option" @click=${() => this._enterPartialStep(false)}>Partial Payment</button>
        <button class="option" @click=${() => (this._paymentStep = "deferred")}>Deferred</button>
        <div class="actions">
          <button class="secondary" @click=${this._closePayment}>Cancel</button>
        </div>
      `;
    }

    if (this._paymentStep === "normal") {
      return html`
        <label>Payment date</label>
        <input type="date" .value=${this._paymentDate} @input=${(e: InputEvent) => (this._paymentDate = (e.target as HTMLInputElement).value)} />
        <label>Notes</label>
        <input .value=${this._paymentNotes} @input=${(e: InputEvent) => (this._paymentNotes = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._paymentStep = "choose")}>Back</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._submitNormal}>Mark Paid</button>
        </div>
      `;
    }

    if (this._paymentStep === "partial") {
      return html`
        <label class="checkbox-field">
          <input
            type="checkbox"
            .checked=${this._paidIndividually}
            @change=${(e: Event) => {
              this._paidIndividually = (e.target as HTMLInputElement).checked;
              this._recomputeSplit();
            }}
          />
          Paid individually (one person covering this, not split across the household)
        </label>
        <label>Amount paid</label>
        <input
          type="number"
          step="0.01"
          .value=${this._partialTotalAmount}
          @input=${(e: InputEvent) => {
            this._partialTotalAmount = (e.target as HTMLInputElement).value;
            this._recomputeSplit();
          }}
        />
        ${!this._paidIndividually
          ? html`<p class="field-help">Split automatically across the household by each person's share of this bill.</p>`
          : ""}
        ${this._renderContributionEditor(
          this._contributions,
          this._paymentBill,
          (next) => (this._contributions = next)
        )}
        <label>Payment date</label>
        <input type="date" .value=${this._paymentDate} @input=${(e: InputEvent) => (this._paymentDate = (e.target as HTMLInputElement).value)} />
        <label>Notes</label>
        <input .value=${this._paymentNotes} @input=${(e: InputEvent) => (this._paymentNotes = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._paymentStep = "choose")}>Back</button>
          <button class="primary" ?disabled=${this._saving} @click=${() => this._submitContributions(this._paidIndividually ? "individual" : "partial")}>
            Save
          </button>
        </div>
      `;
    }

    // deferred
    return html`
      <label>Deferred until</label>
      <input type="date" .value=${this._deferUntil} @input=${(e: InputEvent) => (this._deferUntil = (e.target as HTMLInputElement).value)} />
      <label>Reason</label>
      <input .value=${this._deferReason} @input=${(e: InputEvent) => (this._deferReason = (e.target as HTMLInputElement).value)} />
      <label>Notes</label>
      <input .value=${this._paymentNotes} @input=${(e: InputEvent) => (this._paymentNotes = (e.target as HTMLInputElement).value)} />
      <div class="actions">
        <button class="secondary" @click=${() => (this._paymentStep = "choose")}>Back</button>
        <button class="primary" ?disabled=${this._saving} @click=${this._submitDefer}>Defer</button>
      </div>
    `;
  }

  render() {
    return html`
      <finance-dialog
        heading=${this.bill?.name ?? "Bill Details"}
        .open=${this.bill !== null}
        @finance-dialog-closed=${() => this._close()}
      >
        ${this._renderBillDetailsContent()}
      </finance-dialog>

      <finance-dialog
        heading=${this._paymentBill ? `Mark Payment - ${this._paymentBill.name}` : ""}
        .open=${this._paymentBill !== null}
        @finance-dialog-closed=${this._closePayment}
      >
        ${this._renderPaymentDialogContent()}
      </finance-dialog>

      <finance-dialog
        heading=${this._editingPaymentBill ? `Edit Payment - ${this._editingPaymentBill.name}` : "Edit Payment"}
        .open=${this._editingPayment !== null}
        @finance-dialog-closed=${() => this._closeEditPayment()}
      >
        <label>Payment date</label>
        <input
          type="date"
          .value=${this._editPaymentDate}
          @input=${(e: InputEvent) => (this._editPaymentDate = (e.target as HTMLInputElement).value)}
        />
        ${this._editingPayment && this._editingPayment.type !== "normal"
          ? this._renderContributionEditor(
              this._editPaymentContributions,
              this._editingPaymentBill,
              (next) => (this._editPaymentContributions = next)
            )
          : ""}
        <label>Notes</label>
        <input
          .value=${this._editPaymentNotes}
          @input=${(e: InputEvent) => (this._editPaymentNotes = (e.target as HTMLInputElement).value)}
        />
        ${this._editPaymentError ? html`<p class="error" role="alert">${this._editPaymentError}</p>` : ""}
        <div class="bill-details-actions">
          <button class="link" ?disabled=${this._saving} @click=${() => this._deleteEditingPayment()}>
            Delete payment
          </button>
          <div class="actions">
            <button class="secondary" ?disabled=${this._saving} @click=${() => this._closeEditPayment()}>
              Cancel
            </button>
            <button class="primary" ?disabled=${this._saving} @click=${() => this._saveEditPayment()}>
              ${this._saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </finance-dialog>

      <finance-dialog class="edit-bill-dialog" heading="Edit Bill" .open=${this._editOpen} .dismissible=${!this._saving} @finance-dialog-closed=${() => (this._editOpen = false)}>
        <p class="form-intro">Update the bill details, schedule, and responsible person.</p>
        <form id="edit-bill-form" @submit=${(e: SubmitEvent) => { e.preventDefault(); void this._saveEditBill(); }}>
          <fieldset ?disabled=${this._saving} class="bill-form">
            <div class="field full"><label for="edit-name">Bill name</label>
              <input id="edit-name" required .value=${this._editName} @input=${(e: InputEvent) => (this._editName = (e.target as HTMLInputElement).value)} /></div>
            <div class="field full"><label for="edit-payee">Pay to <span>(optional)</span></label>
              <input id="edit-payee" .value=${this._editPayTo} @input=${(e: InputEvent) => (this._editPayTo = (e.target as HTMLInputElement).value)} /></div>
            <div class="field"><label for="edit-amount">Bill amount</label>
              <input id="edit-amount" type="number" min="0" step="0.01" inputmode="decimal" required aria-describedby="amount-hint" .value=${this._editAmount} @input=${(e: InputEvent) => (this._editAmount = (e.target as HTMLInputElement).value)} />
              <small id="amount-hint">Before any late fees.</small></div>
            <div class="field"><label for="edit-due">Due date</label>
              <input id="edit-due" type="date" required .value=${this._editDueDate} @input=${(e: InputEvent) => (this._editDueDate = (e.target as HTMLInputElement).value)} /></div>
            <div class="field"><label for="edit-category">Category</label>
              <select id="edit-category" @change=${(e: Event) => (this._editCategoryId = (e.target as HTMLSelectElement).value)}>
                ${!this.financeState.categories.some(c => c.categoryId === this._editCategoryId) ? html`<option value=${this._editCategoryId} selected>Uncategorized</option>` : ""}
                ${this.financeState.categories.map(c => html`<option value=${c.categoryId} ?selected=${c.categoryId === this._editCategoryId}>${c.name}</option>`)}
              </select></div>
            <div class="field"><label for="edit-frequency">Frequency</label>
              <select id="edit-frequency" @change=${(e: Event) => (this._editFrequency = (e.target as HTMLSelectElement).value)}>
                ${["weekly", "biweekly", "monthly", "quarterly", "yearly", "one_time"].map(f => html`<option value=${f} ?selected=${f === this._editFrequency}>${f.replace("_", " ")}</option>`)}
              </select></div>
            <div class="field"><label for="edit-type">Bill type</label>
              <select id="edit-type" @change=${(e: Event) => (this._editBillType = (e.target as HTMLSelectElement).value)}>
                ${["fixed", "variable", "debt", "subscription", "installment"].map(t => html`<option value=${t} ?selected=${t === this._editBillType}>${t}</option>`)}
              </select></div>
            <div class="field"><label for="edit-owner">Responsible person</label>
              <select id="edit-owner" @change=${(e: Event) => (this._editOwner = (e.target as HTMLSelectElement).value)}>
                <option value="" ?selected=${!this._editOwner}>Shared household</option>
                ${this.financeState.members.map(m => html`<option value=${m.memberId} ?selected=${m.memberId === this._editOwner}>Individual · ${m.name}</option>`)}
                ${this._editOwner && !this.financeState.members.some(m => m.memberId === this._editOwner) ? html`<option value=${this._editOwner} selected>Former member</option>` : ""}
              </select></div>
            <p class="field-help full">Individual bills count only toward that person’s responsibility and do not create a household reimbursement debt.</p>
            <div class="field full"><label for="edit-notes">Notes <span>(optional)</span></label>
              <textarea id="edit-notes" rows="3" .value=${this._editNotes} @input=${(e: InputEvent) => (this._editNotes = (e.target as HTMLTextAreaElement).value)}></textarea></div>
          </fieldset>
          ${this._editError ? html`<p class="error" role="alert">${this._editError}</p>` : ""}
        </form>
          <div slot="footer" class="actions form-actions">
            <button type="button" class="secondary" ?disabled=${this._saving} @click=${() => (this._editOpen = false)}>Cancel</button>
            <button form="edit-bill-form" type="submit" class="primary" ?disabled=${this._saving}>${this._saving ? "Saving…" : "Save changes"}</button>
          </div>
      </finance-dialog>

      <finance-dialog heading="Late Fees" .open=${this._feeBill !== null}
        @finance-dialog-closed=${() => { if (!this._saving) this._feeBill = null; }}>
        <p>${this._feeBill?.name}</p>
        <p class="bill-meta">Set the total late fees for this bill only. Future recurring bills keep the original amount. Enter 0 to remove fees.</p>
        <label for="late-fee">Total late fees</label>
        <input id="late-fee" type="number" min="0" step="0.01" inputmode="decimal"
          .value=${this._feeAmount} ?disabled=${this._saving}
          @input=${(e: InputEvent) => (this._feeAmount = (e.target as HTMLInputElement).value)} />
        <p>Original amount: ${money(this._feeBill?.baseAmount ?? 0)}</p>
        <p><strong>Total with fees: ${money((this._feeBill?.baseAmount ?? 0) + (Number(this._feeAmount) || 0))}</strong></p>
        ${this._feeError ? html`<p class="error" role="alert">${this._feeError}</p>` : ""}
        <div class="actions">
          <button class="secondary" ?disabled=${this._saving} @click=${() => (this._feeBill = null)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveLateFee}>${this._saving ? "Saving…" : "Save Fees"}</button>
        </div>
      </finance-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-bill-workspace": FinanceBillWorkspace;
  }
}
