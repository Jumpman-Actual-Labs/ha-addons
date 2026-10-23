import { LitElement, css, html, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { CashInfusion, FinanceState } from "../types";
import { money } from "../format";
import { glassCardStyle, bankingStyle } from "../styles";
import "../components/cash-infusion-dialog";

interface Slice {
  label: string;
  amount: number;
  color: string;
}

const CIRCUMFERENCE = 2 * Math.PI * 50;

@customElement("finance-income-view")
export class FinanceIncomeView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) financeState!: FinanceState;

  @state() private _infusionDialogOpen = false;

  static styles = [glassCardStyle, css`
    ha-card {
      padding: 20px;
      margin-bottom: 24px;
    }
    .label {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
      margin-bottom: 6px;
    }
    .value {
      font-size: 1.8rem;
      font-weight: 500;
    }
    .breakdown-card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 32px;
    }
    .chart {
      flex-shrink: 0;
    }
    .legend {
      flex: 1;
      min-width: 200px;
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
    }
    .legend-row:last-child {
      border-bottom: none;
    }
    .swatch {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .legend-label {
      flex: 1;
    }
    .legend-name {
      font-weight: 500;
    }
    .legend-pct {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
    }
    .legend-amount {
      font-weight: 500;
    }
    .stash-card .value {
      color: var(--success-color, #43a047);
    }
    .stash-hint {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
      margin-top: 6px;
    }
    section {
      margin-bottom: 24px;
    }
    section h2 {
      font-size: 1.05rem;
      font-weight: 500;
      margin: 0 0 10px;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .section-header h2 {
      margin: 0 0 10px;
    }
    button.link {
      background: none;
      border: none;
      color: var(--primary-color, #03a9f4);
      cursor: pointer;
      font-size: 0.9rem;
      padding: 0 0 10px;
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
    .row .bill-info {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .tag {
      font-size: 0.75rem;
      padding: 3px 8px;
      border-radius: 12px;
      background: #e3f2fd;
      color: #1565c0;
      white-space: nowrap;
    }
    .empty {
      color: var(--secondary-text-color, #727272);
      padding: 8px 0;
    }
  `, bankingStyle];

  private get _myMember() {
    const userId = this.hass.user?.id;
    if (!userId) return null;
    return this.financeState.members.find((m) => m.haUserId === userId) ?? null;
  }

  private _memberName(memberId: string): string {
    return this.financeState.members.find((m) => m.memberId === memberId)?.name ?? "Unknown";
  }

  private _renderDonut(slices: Slice[], total: number) {
    let cumulative = 0;
    const arcs = slices
      .filter((s) => s.amount > 0)
      .map((s) => {
        const fraction = total > 0 ? s.amount / total : 0;
        const length = fraction * CIRCUMFERENCE;
        const offset = -cumulative;
        cumulative += length;
        return svg`<circle
          cx="60"
          cy="60"
          r="50"
          fill="none"
          stroke="${s.color}"
          stroke-width="16"
          stroke-dasharray="${length} ${CIRCUMFERENCE}"
          stroke-dashoffset="${offset}"
          transform="rotate(-90 60 60)"
        />`;
      });
    return html`
      <svg class="chart" viewBox="0 0 120 120" width="160" height="160">
        <circle cx="60" cy="60" r="50" fill="none" stroke="var(--divider-color, #e0e0e0)" stroke-width="16" />
        ${arcs}
      </svg>
    `;
  }

  render() {
    const member = this._myMember;

    if (!member) {
      return html`
        <ha-card>
          <div class="empty">
            You're not linked to a household member yet. Ask an admin to link your HA account
            from the Members tab so you can see your own income breakdown here.
          </div>
        </ha-card>
      `;
    }

    const savingsShare =
      this.financeState.savings.breakdown.find((b) => b.memberId === member.memberId)?.amount ?? 0;
    // Excludes cash-infusion repayment bills - a loan you're paying back to
    // someone shouldn't inflate your personal Budget/Savings/Stash breakdown,
    // even though it's still tracked as a real bill everywhere else.
    const budgetAmt = member.budgetResponsibleAmountExcludingRepayments;
    const shortfall = Math.max(budgetAmt + savingsShare - member.income, 0);
    const stashAmt = Math.max(member.income - budgetAmt - savingsShare, 0);
    const total = member.income > 0 ? member.income : budgetAmt + savingsShare + stashAmt;

    const slices: Slice[] = [
      { label: "Budget", amount: budgetAmt, color: "var(--error-color, #db4437)" },
      { label: "Savings", amount: savingsShare, color: "var(--primary-color, #03a9f4)" },
      { label: "Stash", amount: stashAmt, color: "var(--success-color, #43a047)" },
    ];

    const cashInfusions: CashInfusion[] = this.financeState.cashInfusions;

    return html`
      <ha-card>
        <div class="label">Your Monthly Income</div>
        <div class="value">${money(member.income)}</div>
      </ha-card>

      <ha-card class="breakdown-card">
        ${this._renderDonut(slices, total)}
        <div class="legend">
          ${slices.map(
            (s) => html`
              <div class="legend-row">
                <div class="swatch" style="background:${s.color}"></div>
                <div class="legend-label">
                  <div class="legend-name">${s.label}</div>
                  <div class="legend-pct">${total > 0 ? ((s.amount / total) * 100).toFixed(1) : "0.0"}%</div>
                </div>
                <div class="legend-amount">${money(s.amount)}</div>
              </div>
            `
          )}
        </div>
      </ha-card>

      <ha-card class="stash-card">
        <div class="label">Your Stash</div>
        <div class="value">${money(stashAmt)}</div>
        ${shortfall > 0 ? html`<p style="color:var(--error-color)">Monthly shortfall: ${money(shortfall)}. Your budget and savings exceed recorded income; reduce the plan or add income.</p>` : ""}
        <div class="stash-hint">What's left of your income after your budget share and savings. Your budget includes bills and category spending, with planned category amounts counted once; loan repayments are excluded here.</div>
      </ha-card>

      <section>
        <div class="section-header">
          <h2>Cash Infusions (${cashInfusions.length})</h2>
          <button class="link" @click=${() => (this._infusionDialogOpen = true)}>
            + Add Infusion
          </button>
        </div>
        <ha-card>
          ${cashInfusions.length === 0
            ? html`<div class="empty">No cash infusions recorded yet.</div>`
            : cashInfusions.map(
                (i) => html`
                  <div class="row">
                    <span class="bill-info">
                      ${i.source || "Cash infusion"}
                      ${i.contributions.length > 0
                        ? html`<span class="tag"
                            >${i.contributions
                              .map((c) => this._memberName(c.memberId))
                              .join(", ")}</span
                          >`
                        : ""}
                      ${i.repaymentBillId
                        ? html`<span class="tag">Repayment scheduled</span>`
                        : ""}
                    </span>
                    <span>${money(i.amount)} - ${i.date}</span>
                  </div>
                `
              )}
        </ha-card>
      </section>

      <finance-cash-infusion-dialog
        .hass=${this.hass}
        .open=${this._infusionDialogOpen}
        .members=${this.financeState.members}
        .defaultMemberId=${member.memberId}
        @cash-infusion-closed=${() => (this._infusionDialogOpen = false)}
      ></finance-cash-infusion-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-income-view": FinanceIncomeView;
  }
}
