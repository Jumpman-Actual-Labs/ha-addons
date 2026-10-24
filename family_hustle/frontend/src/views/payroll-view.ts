import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { hustleApi } from "../ha-api";
import type { HustleState, PaycheckHistoryEntry } from "../types";
import { formatCents, signedFormatCents } from "../utils/money";
import { formatDate } from "../utils/time";
import { memberName } from "../utils/members";
import { glassCardStyle, formStyles } from "../styles";
import "../components/hustle-dialog";

const STATUS_BADGE: Record<string, string> = {
  draft: "",
  pending_approval: "warning",
  approved: "info",
  paid: "success",
};

/** Payroll history is only visible per-member (via each member's
 * MemberPaycheckSensor.paycheck_history, bounded to 10 entries), and the
 * historical entries don't carry line_items - only the *current* period's
 * paycheck per member exposes line_items. There's also no sensor listing
 * all pay periods, only the current one (via DaysUntilPaydaySensor's
 * current_period_id/start_date/end_date/payday_date/status attributes).
 * This view therefore: shows the current period from that sensor, and
 * builds a payroll table from every member's *current* paycheck (from
 * MemberPaycheckSensor's own state+status+line_items), plus a combined,
 * bounded history table from every member's paycheck_history list. */
@customElement("hustle-payroll-view")
export class HustlePayrollView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;

  @state() private _detailMemberId: string | null = null;
  @state() private _saving = false;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 16px;
        flex-wrap: wrap;
        justify-content: flex-start;
      }
      ha-card {
        padding: 16px;
        margin-bottom: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: left;
        padding: 10px 8px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .line-item {
        display: flex;
        justify-content: space-between;
        padding: 6px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        font-size: 0.9rem;
      }
      .totals {
        display: flex;
        justify-content: space-between;
        padding-top: 10px;
        font-weight: 700;
      }
    `,
  ];

  private async _getOrCreatePeriod(): Promise<void> {
    await hustleApi.getOrCreateCurrentPeriod(this.hass);
  }

  private async _generate(regenerate: boolean): Promise<void> {
    const period = this.hustleState.currentPeriod;
    if (!period) return;
    if (regenerate && !window.confirm("Regenerate payroll for this period? This replaces existing paychecks.")) {
      return;
    }
    this._saving = true;
    try {
      await hustleApi.generatePayPeriod(this.hass, period.id, regenerate);
    } finally {
      this._saving = false;
    }
  }

  /** MemberPaycheckSensor's current-paycheck attributes (status/gross_cents/
   * line_items) never include the paycheck's own `id` - only entries inside
   * `paycheck_history` do. Since history is sorted by created_at descending
   * and the current period's paycheck is always the newest one once it
   * exists, the current paycheck's id is recovered by matching the current
   * period's id against history entries rather than assuming index 0
   * (guards against a member with no history for the *current* period but
   * older entries from a past period still present in the bounded list). */
  private _currentPaycheckId(p: HustleState["paychecks"][number]): string | null {
    const periodId = this.hustleState.currentPeriod?.id;
    if (!periodId) return null;
    return p.paycheckHistory.find((h) => h.payPeriodId === periodId)?.id ?? null;
  }

  private async _approve(paycheckId: string): Promise<void> {
    await hustleApi.approvePaycheck(this.hass, paycheckId);
  }

  private async _markPaid(paycheckId: string): Promise<void> {
    await hustleApi.markPaycheckPaid(this.hass, paycheckId);
  }

  private _renderHistoryRow(memberId: string, p: PaycheckHistoryEntry) {
    return html`
      <tr>
        <td>${memberName(this.hustleState, memberId)}</td>
        <td>${formatCents(p.grossCents)}</td>
        <td style="font-weight:700">${formatCents(p.netCents)}</td>
        <td><span class="badge ${STATUS_BADGE[p.status] ?? ""}">${p.status.replace("_", " ")}</span></td>
      </tr>
    `;
  }

  render() {
    const s = this.hustleState;
    const period = s.currentPeriod;
    const currentPaychecks = s.paychecks.filter((p) => p.netCents !== null);
    const combinedHistory = s.paychecks.flatMap((p) =>
      p.paycheckHistory.map((h) => ({ memberId: p.memberId, entry: h }))
    );
    const detail = this._detailMemberId
      ? s.paychecks.find((p) => p.memberId === this._detailMemberId)
      : null;

    return html`
      <h1>Payroll</h1>

      <div class="toolbar">
        ${period
          ? html`<span class="badge info">Period ${period.startDate} → ${period.endDate} · Payday ${formatDate(period.paydayDate)}</span>`
          : html`<span class="muted">No current pay period yet.</span>`}
        ${!period ? html`<button class="secondary" @click=${this._getOrCreatePeriod}>Get or create current period</button>` : ""}
        ${period && currentPaychecks.length === 0
          ? html`<button class="primary" ?disabled=${this._saving} @click=${() => this._generate(false)}>Generate payroll for this period</button>`
          : ""}
        ${period && currentPaychecks.length > 0
          ? html`<button class="link" ?disabled=${this._saving} @click=${() => this._generate(true)}>Regenerate</button>`
          : ""}
      </div>

      <ha-card>
        <h3>Current period paychecks</h3>
        ${currentPaychecks.length === 0
          ? html`<div class="empty">No payroll generated for this period yet.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Gross</th>
                    <th>Net</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${currentPaychecks.map(
                    (p) => html`
                      <tr>
                        <td>${memberName(s, p.memberId)}</td>
                        <td>${formatCents(p.grossCents)}</td>
                        <td style="font-weight:700">${formatCents(p.netCents)}</td>
                        <td><span class="badge ${STATUS_BADGE[p.status ?? "draft"] ?? ""}">${(p.status ?? "draft").replace("_", " ")}</span></td>
                        <td>
                          <button class="link" @click=${() => (this._detailMemberId = p.memberId)}>Detail</button>
                          ${p.status === "pending_approval" && this._currentPaycheckId(p)
                            ? html`<button class="link" @click=${() => this._approve(this._currentPaycheckId(p)!)}>Approve</button>`
                            : ""}
                          ${p.status === "approved" && this._currentPaycheckId(p)
                            ? html`<button class="link" @click=${() => this._markPaid(this._currentPaycheckId(p)!)}>Mark paid</button>`
                            : ""}
                        </td>
                      </tr>
                    `
                  )}
                </tbody>
              </table>
            `}
      </ha-card>

      <ha-card>
        <h3>Recent payroll history (bounded, per member)</h3>
        ${combinedHistory.length === 0
          ? html`<div class="empty">No payroll history yet.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Gross</th>
                    <th>Net</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${combinedHistory.map((h) => this._renderHistoryRow(h.memberId, h.entry))}
                </tbody>
              </table>
            `}
      </ha-card>

      <hustle-dialog
        heading=${detail ? `Paycheck detail - ${memberName(s, detail.memberId)}` : ""}
        .open=${detail !== null}
        @hustle-dialog-closed=${() => (this._detailMemberId = null)}
      >
        ${detail
          ? html`
              <div class="muted small">${period ? `${period.startDate} → ${period.endDate}` : ""}</div>
              ${detail.lineItems.length === 0
                ? html`<p class="muted">No line items.</p>`
                : detail.lineItems.map(
                    (li) => html`
                      <div class="line-item">
                        <span>${li.description} <span class="badge">${li.earningSourceType}</span></span>
                        <span style="color:${li.amountCents < 0 ? "var(--error-color, #c62828)" : "var(--success-color, #43a047)"}">
                          ${signedFormatCents(li.amountCents)}
                        </span>
                      </div>
                    `
                  )}
              <div class="totals"><span>Net pay</span><span>${formatCents(detail.netCents)}</span></div>
            `
          : ""}
      </hustle-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-payroll-view": HustlePayrollView;
  }
}
