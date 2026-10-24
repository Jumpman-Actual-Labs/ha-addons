import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { HustleState } from "../types";
import { formatCents } from "../utils/money";
import { memberName } from "../utils/members";
import { glassCardStyle, formStyles } from "../styles";

const STATUS_BADGE: Record<string, string> = {
  draft: "",
  pending_approval: "warning",
  approved: "info",
  paid: "success",
};

/** Styled like an actual paper paycheck stub: household name as the
 * letterhead/"business name", a real Earnings/Deductions split (not a flat
 * line-item list), Net Pay as the bottom-line total. Scoped to whichever
 * member is currently effective (a child always sees their own; a parent
 * sees whoever they've picked in the panel-level "Viewing as" selector). */
@customElement("hustle-my-paycheck-view")
export class HustleMyPaycheckView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;
  @property({ attribute: false }) effectiveMemberId!: string;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      .letterhead {
        text-align: center;
        padding: 20px 16px 16px;
        border-bottom: 2px solid var(--primary-text-color, #212121);
        margin-bottom: 16px;
      }
      .letterhead .business-name {
        font-size: 1.4rem;
        font-weight: 800;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }
      .letterhead .payee {
        font-size: 1.05rem;
        font-weight: 600;
        margin-top: 6px;
      }
      .hero {
        text-align: center;
        padding: 20px 16px 28px;
      }
      .hero .net-label {
        color: var(--secondary-text-color, #727272);
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .hero .net {
        font-size: 2.6rem;
        font-weight: 800;
        color: var(--success-color, #43a047);
      }
      ha-card {
        padding: 16px;
        margin-bottom: 16px;
      }
      .columns {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }
      .column h3 {
        margin: 0 0 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .column.deductions h3 {
        color: var(--error-color, #c62828);
      }
      .column.earnings h3 {
        color: var(--success-color, #43a047);
      }
      .line-item {
        display: flex;
        justify-content: space-between;
        padding: 6px 0;
        font-size: 0.92rem;
      }
      .subtotal {
        display: flex;
        justify-content: space-between;
        padding: 8px 0 0;
        margin-top: 4px;
        border-top: 1px solid var(--divider-color, #e0e0e0);
        font-weight: 700;
      }
      .history-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .history-row:last-child {
        border-bottom: none;
      }
    `,
  ];

  render() {
    const s = this.hustleState;
    const paycheck = s.paychecks.find((p) => p.memberId === this.effectiveMemberId);
    const businessName = s.household?.name ?? "Household";
    const payeeName = this.effectiveMemberId ? memberName(s, this.effectiveMemberId) : "";

    const earnings = paycheck?.lineItems.filter((li) => li.amountCents > 0) ?? [];
    const deductions = paycheck?.lineItems.filter((li) => li.amountCents < 0) ?? [];
    const earningsTotal = earnings.reduce((sum, li) => sum + li.amountCents, 0);
    const deductionsTotal = deductions.reduce((sum, li) => sum + li.amountCents, 0);

    return html`
      <div class="letterhead">
        <div class="business-name">${businessName}</div>
        <div class="payee">${payeeName}</div>
      </div>

      ${!paycheck || paycheck.netCents === null
        ? html`<div class="empty">No paychecks yet - keep hustling!</div>`
        : html`
            <ha-card class="hero">
              <div class="muted">
                ${s.currentPeriod ? `${s.currentPeriod.startDate} → ${s.currentPeriod.endDate}` : ""}
              </div>
              <div class="net-label">Net Pay</div>
              <div class="net">${formatCents(paycheck.netCents)}</div>
              <span class="badge ${STATUS_BADGE[paycheck.status ?? "draft"] ?? ""}"
                >${(paycheck.status ?? "draft").replace("_", " ")}</span
              >
            </ha-card>

            <ha-card>
              <div class="columns">
                <div class="column earnings">
                  <h3>Earnings</h3>
                  ${earnings.length === 0
                    ? html`<p class="muted small">Nothing yet.</p>`
                    : earnings.map(
                        (li) => html`
                          <div class="line-item">
                            <span>${li.description}</span>
                            <span>${formatCents(li.amountCents)}</span>
                          </div>
                        `
                      )}
                  <div class="subtotal">
                    <span>Total earnings</span>
                    <span>${formatCents(earningsTotal)}</span>
                  </div>
                </div>
                <div class="column deductions">
                  <h3>Deductions</h3>
                  ${deductions.length === 0
                    ? html`<p class="muted small">Nothing yet.</p>`
                    : deductions.map(
                        (li) => html`
                          <div class="line-item">
                            <span>${li.description}</span>
                            <span>-${formatCents(-li.amountCents)}</span>
                          </div>
                        `
                      )}
                  <div class="subtotal">
                    <span>Total deductions</span>
                    <span>-${formatCents(-deductionsTotal)}</span>
                  </div>
                </div>
              </div>
              <div class="line-item" style="font-weight:800;font-size:1.05rem;margin-top:16px;padding-top:12px;border-top:2px solid var(--primary-text-color, #212121)">
                <span>Net Pay</span><span>${formatCents(paycheck.netCents ?? 0)}</span>
              </div>
            </ha-card>

            <ha-card>
              <h3>History</h3>
              ${paycheck.paycheckHistory.length === 0
                ? html`<div class="empty">No history yet.</div>`
                : paycheck.paycheckHistory.map(
                    (p) => html`
                      <div class="history-row">
                        <span class="badge ${STATUS_BADGE[p.status] ?? ""}">${p.status.replace("_", " ")}</span>
                        <span style="font-weight:700">${formatCents(p.netCents)}</span>
                      </div>
                    `
                  )}
            </ha-card>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-my-paycheck-view": HustleMyPaycheckView;
  }
}
