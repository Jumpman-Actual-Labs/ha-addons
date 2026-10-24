import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { HustleState } from "../types";
import { formatCents } from "../utils/money";
import { formatDate } from "../utils/time";
import { memberName } from "../utils/members";
import { glassCardStyle, formStyles } from "../styles";

@customElement("hustle-reports-view")
export class HustleReportsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      section {
        margin-bottom: 28px;
      }
      ha-card {
        padding: 16px;
      }
      .bar-row {
        display: grid;
        grid-template-columns: 140px 1fr 90px;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
        font-size: 0.9rem;
      }
      .bar-track {
        background: var(--secondary-background-color, #eeeeee);
        border-radius: 6px;
        height: 14px;
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        background: var(--primary-color, #03a9f4);
        border-radius: 6px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: left;
        padding: 8px 6px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        font-size: 0.9rem;
      }
    `,
  ];

  private _renderBarChart(rows: Array<{ label: string; valueCents: number }>) {
    if (rows.length === 0) return html`<p class="muted small">Nothing to show yet.</p>`;
    const max = Math.max(...rows.map((r) => r.valueCents), 1);
    return rows.map(
      (r) => html`
        <div class="bar-row">
          <span>${r.label}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, (r.valueCents / max) * 100)}%"></div></div>
          <span style="text-align:right">${formatCents(r.valueCents)}</span>
        </div>
      `
    );
  }

  render() {
    const s = this.hustleState;
    const reports = s.reports;

    const earningsByChild = (reports?.earningsByChild ?? [])
      .map((e) => ({ label: e.memberName, valueCents: e.totalCents }))
      .sort((a, b) => b.valueCents - a.valueCents);

    const earningsByPayPeriod = reports?.earningsByPayPeriod ?? [];
    const highestPayingChores = reports?.highestPayingChores ?? [];
    const mostCompletedChores = reports?.mostCompletedChores ?? [];
    const reliability = reports?.reliability ?? [];

    return html`
      <h1>Reports</h1>

      <section>
        <h3>Earnings by child</h3>
        <ha-card>${this._renderBarChart(earningsByChild)}</ha-card>
      </section>

      <section>
        <h3>Earnings by pay period (last ${earningsByPayPeriod.length})</h3>
        <ha-card>
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Payday</th>
                <th>Gross</th>
                <th>Net</th>
              </tr>
            </thead>
            <tbody>
              ${earningsByPayPeriod.length === 0
                ? html`<tr><td class="muted" colspan="4">No pay periods yet.</td></tr>`
                : earningsByPayPeriod.map(
                    (p) => html`
                      <tr>
                        <td>${p.startDate} → ${p.endDate}</td>
                        <td>${formatDate(p.paydayDate)}</td>
                        <td>${formatCents(p.totalGrossCents)}</td>
                        <td style="font-weight:600">${formatCents(p.totalNetCents)}</td>
                      </tr>
                    `
                  )}
            </tbody>
          </table>
        </ha-card>
      </section>

      <section>
        <h3>Highest paying chores</h3>
        <ha-card>
          <table>
            <thead>
              <tr>
                <th>Chore</th>
                <th>Completions</th>
                <th>Total paid</th>
              </tr>
            </thead>
            <tbody>
              ${highestPayingChores.length === 0
                ? html`<tr><td class="muted" colspan="3">No completed chores yet.</td></tr>`
                : highestPayingChores.map(
                    (c) => html`
                      <tr>
                        <td>${c.title}</td>
                        <td>${c.completionCount}</td>
                        <td style="font-weight:600">${formatCents(c.totalPaidCents)}</td>
                      </tr>
                    `
                  )}
            </tbody>
          </table>
        </ha-card>
      </section>

      <section>
        <h3>Most completed chores</h3>
        <ha-card>
          <table>
            <thead>
              <tr>
                <th>Chore</th>
                <th>Completions</th>
                <th>Total paid</th>
              </tr>
            </thead>
            <tbody>
              ${mostCompletedChores.length === 0
                ? html`<tr><td class="muted" colspan="3">No completed chores yet.</td></tr>`
                : mostCompletedChores.map(
                    (c) => html`
                      <tr>
                        <td>${c.title}</td>
                        <td>${c.completionCount}</td>
                        <td style="font-weight:600">${formatCents(c.totalPaidCents)}</td>
                      </tr>
                    `
                  )}
            </tbody>
          </table>
        </ha-card>
      </section>

      <section>
        <h3>Chore reliability</h3>
        <ha-card>
          <table>
            <thead>
              <tr>
                <th>Child</th>
                <th>Approved</th>
                <th>Rejected</th>
                <th>Total</th>
                <th>Reliability</th>
              </tr>
            </thead>
            <tbody>
              ${reliability.length === 0
                ? html`<tr><td class="muted" colspan="5">No chore history yet.</td></tr>`
                : reliability.map(
                    (r) => html`
                      <tr>
                        <td>${r.memberName}</td>
                        <td>${r.approvedCount}</td>
                        <td>${r.rejectedCount}</td>
                        <td>${r.totalCount}</td>
                        <td style="font-weight:600">${r.reliabilityPct}%</td>
                      </tr>
                    `
                  )}
            </tbody>
          </table>
        </ha-card>
      </section>

      <section>
        <h3>Recent activity</h3>
        <ha-card>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Member</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              ${s.recentActivity.length === 0
                ? html`<tr><td class="muted" colspan="3">No activity yet.</td></tr>`
                : s.recentActivity.map(
                    (a) => html`
                      <tr>
                        <td>${a.title}</td>
                        <td>${a.memberId ? memberName(s, a.memberId) : ""}</td>
                        <td>${a.amountCents !== null ? formatCents(a.amountCents) : ""}</td>
                      </tr>
                    `
                  )}
            </tbody>
          </table>
        </ha-card>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-reports-view": HustleReportsView;
  }
}
