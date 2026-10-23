import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { Bill, FinanceState } from "../types";
import { money } from "../format";
import { isOverdue, localDate, remainingForBill, responsibilityFor } from "../bill-selectors";
import { budgetFunding, cushionFlow, periodPayments, periodPlan } from "../pay-period";
import { glassCardStyle, bankingStyle } from "../styles";
import "../components/bill-workspace-dialog";
import "../components/savings-deposit-dialog";

interface MemberBreakdown {
  responsibleAmount: number;
  responsibilityPct: number;
  actuallyPaid: number;
  settlementBalance: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@customElement("finance-dashboard-view")
export class FinanceDashboardView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) financeState!: FinanceState;

  @state() private _queue: "all" | "due" | "paid" = "all";
  @state() private _overviewPeriod: "current" | "next" = "current";

  @state() private _selectedBill: Bill | null = null;
  @state() private _cushionDepositOpen = false;

  static styles = [glassCardStyle, css`


    .home-layout { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(285px, 1fr); gap: 24px; align-items: start; }
    .pay-workspace, .month-plan, .savings-panel { background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #e3e9ed); border-radius: 14px; padding: 22px; margin: 0; min-width: 0; }
    .workspace-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .workspace-title h2 { margin: 3px 0 0; font-size: 1.16rem; font-weight: 650; }
    .eyebrow { font-size: 0.65rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--secondary-text-color, #64748b); }
    .attention { display: flex; gap: 12px; align-items: center; border-radius: 9px; padding: 14px; margin-bottom: 20px; background: var(--stash-success-bg); color: var(--stash-success); }
    .attention.urgent { background: var(--stash-danger-bg); color: var(--stash-danger); }
    .attention span { display: block; margin-top: 3px; font-size: 0.75rem; }
    .queue-tabs { display: flex; gap: 14px; border-bottom: 1px solid var(--divider-color, #ddd); }
    .queue-tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 0; color: var(--secondary-text-color, #64748b); font: inherit; font-size: 0.8rem; cursor: pointer; }
    .queue-tabs button[aria-pressed="true"] { border-color: var(--primary-color); color: var(--primary-color); font-weight: 650; }
    .queue-tabs span { font-size: 0.7rem; margin-left: 4px; }
    .payment-item { width: 100%; display: flex; gap: 12px; align-items: center; text-align: left; border: 0; border-bottom: 1px solid var(--divider-color, #ddd); background: transparent; color: inherit; padding: 18px 0; cursor: pointer; font: inherit; }
    .date-tile { flex: 0 0 44px; display: flex; flex-direction: column; align-items: center; border-radius: 8px; background: var(--secondary-background-color, #eff2f7); padding: 5px; }
    .date-tile span { font-size: 0.6rem; text-transform: uppercase; } .date-tile strong { font-size: 1.1rem; }
    .date-tile.soon { background: color-mix(in srgb, #be800d 12%, var(--card-background-color, #fff)); color: var(--stash-warning); }
    .date-tile.late { background: var(--stash-danger-bg); color: var(--stash-danger); }
    .payment-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .payment-name strong { font-size: 0.87rem; font-weight: 600; }
    .payment-name small, .payment-balance small { display: block; color: var(--secondary-text-color, #64748b); font-size: 0.7rem; line-height: 1.5; margin-top: 4px; }
    .payment-balance { text-align: right; font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .queue-footer { display: flex; justify-content: space-between; gap: 12px; font-size: 0.75rem; padding: 18px 0; }
    .queue-footer span { color: var(--secondary-text-color, #64748b); }
    .next-income { border-top: 1px solid var(--divider-color, #ddd); display: flex; flex-wrap: wrap; gap: 8px 16px; padding-top: 18px; font-size: 0.77rem; }
    .next-income button.link { padding: 0; }
    .view-more { width: 100%; border: 0; background: none; color: var(--primary-color); padding: 12px; cursor: pointer; }
    .plan-rail { display: grid; gap: 18px; min-width: 0; }
    .plan-result { background: var(--secondary-background-color, #f1f4f8); border-radius: 10px; padding: 18px; }
    .plan-result > span, .plan-result small { display: block; font-size: 0.72rem; color: var(--secondary-text-color, #64748b); }
    .plan-result > strong { display: block; font-size: clamp(1.6rem, 3vw, 2.2rem); letter-spacing: -0.04em; margin: 6px 0 10px; font-variant-numeric: tabular-nums; }
    .plan-result.shortfall > strong { color: var(--stash-danger); }
    .plan-ledger { font-size: 0.79rem; margin: 18px 0; }
    .plan-ledger > div { display: flex; justify-content: space-between; gap: 10px; padding: 7px 0; }
    dt { color: var(--secondary-text-color, #64748b); } dd { margin: 0; font-variant-numeric: tabular-nums; }
    .month-plan > button { width: 100%; }
    .savings-panel .workspace-title { color: var(--stash-success); }
    .savings-amount strong { font-size: 1.4rem; font-variant-numeric: tabular-nums; }
    .savings-amount span { display: block; font-size: 0.74rem; color: var(--secondary-text-color, #64748b); }
    progress { appearance: none; -webkit-appearance: none; display: block; border: none; width: 100%; height: 7px; margin: 16px 0; accent-color: var(--stash-success); }
    progress::-webkit-progress-bar { background: var(--secondary-background-color, #edf2f5); border-radius: 5px; } progress::-webkit-progress-value { background: var(--stash-success); border-radius: 5px; }
    .savings-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .savings-actions button.link { padding: 0; font-size: 0.75rem; }
    @media (max-width: 1100px) { .home-layout { grid-template-columns: minmax(0, 1fr); } .plan-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 600px) { .plan-rail { grid-template-columns: minmax(0, 1fr); } .pay-workspace, .month-plan, .savings-panel { padding: 16px; } .home-layout { gap: 16px; } .payment-item { gap: 8px; } .payment-balance strong { font-size: 0.85rem; } .queue-tabs { gap: 12px; } .workspace-title h2 { font-size: 1.05rem; } }
    .view-switcher { justify-content: flex-end; }
    .bill-info { min-width: 0; flex-wrap: wrap; overflow-wrap: anywhere; }
    .transaction-amount { text-align: right; font-variant-numeric: tabular-nums; }
    .transaction-amount strong { display: block; font-size: 0.9rem; font-weight: 600; }
    .transaction-amount small { display: block; font-size: 0.72rem; color: var(--secondary-text-color, #6b7d86); margin-top: 3px; }
    .row { align-items: center; }
    .clickable {
      cursor: pointer;
    }
    .clickable:hover {
      background: var(--secondary-background-color, #f5f5f5);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    ha-card {
      padding: 20px;
    }
    .label {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
      margin-bottom: 6px;
    }
    .value {
      font-size: clamp(1.6rem, 3vw, 2.15rem);
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }
    section {
      margin-bottom: 24px;
    }
    section h2 {
      font-size: 1.05rem;
      font-weight: 500;
      margin: 0 0 10px;
    }
    .row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
    }
    .row:last-child {
      border-bottom: none;
    }
    .empty {
      color: var(--secondary-text-color, #727272);
      padding: 8px 0;
    }
    .progress-card {
      padding: 16px;
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
      text-transform: capitalize;
      white-space: nowrap;
    }
    .tag.paid { background: #e8f5e9; color: #2e7d32; }
    .tag.overdue { background: #ffebee; color: #c62828; }
    .tag.due { background: #fff8e1; color: #f57f17; }
    .tag.upcoming { background: #eeeeee; color: #616161; }
    .tag.pay-from-savings { background: #e3f2fd; color: #1565c0; }
    .sub-label {
      color: var(--secondary-text-color, #727272);
      font-size: 0.75rem;
      margin-top: 4px;
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
    .view-switcher {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
    }
    .view-switcher label {
      color: var(--secondary-text-color, #727272);
      font-size: 0.85rem;
    }
    .view-select {
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--divider-color, #e0e0e0);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color, #212121);
      font-size: 0.9rem;
    }
    button.link {
      background: none;
      border: none;
      color: var(--primary-color, #03a9f4);
      cursor: pointer;
      font-size: 0.9rem;
      padding: 0 0 10px;
    }
    .hoverable {
      position: relative;
    }
    .hover-popover {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      z-index: 10;
      min-width: 220px;
      max-width: 320px;
      max-height: 240px;
      overflow-y: auto;
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #e0e0e0);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      padding: 10px 12px;
      margin-top: 6px;
    }
    .hoverable:hover .hover-popover {
      display: block;
    }
    .hover-popover-title {
      font-weight: 500;
      margin-bottom: 6px;
      font-size: 0.85rem;
    }
    .hover-popover-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 0.85rem;
      padding: 3px 0;
    }
  `, bankingStyle, css`
    .period-heading { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:28px; }
    .period-heading h2 { font-size:clamp(1.5rem, 2.6vw, 2rem); letter-spacing:-.045em; margin:8px 0; line-height:1.2; }
    .period-heading p { margin:8px 0 0; color:var(--secondary-text-color); font-size:.85rem; }
    .period-toggle, .bill-filters { display:flex; gap:4px; }
    .period-toggle { padding:4px; background:var(--card-background-color); border:1px solid var(--divider-color); border-radius:12px; flex-shrink:0; }
    .period-toggle button, .bill-filters button { border:0; background:none; color:var(--secondary-text-color); font:inherit; font-size:.78rem; padding:8px 13px; border-radius:8px; cursor:pointer; }
    .period-toggle button[aria-pressed="true"], .bill-filters button[aria-pressed="true"] { background:var(--stash-selected); color:var(--primary-color); }
    .overview-grid { display:grid; grid-template-columns:1.1fr 1fr; gap:22px; align-items:stretch; }
    .focus-card { background:var(--card-background-color); border:1px solid var(--divider-color); border-radius:20px; padding:26px; min-width:0; }
    .card-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .card-heading h2 { margin:0; font-size:1rem; font-weight:650; }
    .quiet { color:var(--secondary-text-color); font-size:.75rem; }
    .chart-layout { display:flex; gap:28px; align-items:center; justify-content:center; padding:30px 0; }
    .bill-ring { width:190px; height:190px; flex:0 0 190px; border:0; border-radius:50%; background:conic-gradient(var(--stash-success) 0 var(--paid-progress), var(--primary-color) var(--paid-progress) var(--bills-progress), var(--stash-warning) var(--bills-progress) 0); padding:13px; cursor:pointer; color:inherit; }
    .ring-center { border-radius:50%; height:100%; width:100%; background:var(--card-background-color); display:flex; align-items:center; justify-content:center; flex-direction:column; gap:6px; }
    .ring-center strong { font-size:1.55rem; letter-spacing:-.045em; font-variant-numeric:tabular-nums; }
    .ring-center small, .ring-center > span { font-size:.72rem; color:var(--secondary-text-color); }
    .chart-key { display:grid; gap:14px; flex:1; max-width:220px; }
    .chart-stat { text-align:left; padding:12px; border:1px solid transparent; background:none; color:inherit; border-radius:12px; cursor:pointer; }
    .chart-stat[aria-pressed="true"], .chart-stat:hover { background:var(--secondary-background-color); border-color:var(--divider-color); }
    .chart-stat > span { font-size:.78rem; color:var(--secondary-text-color); display:flex; align-items:center; gap:8px; }
    .chart-stat i { width:8px; height:8px; border-radius:50%; background:var(--primary-color); }
    .paid-stat i { background:var(--stash-success); }
    .cushion-stat i { background:var(--stash-warning); }
    .cushion-stat { cursor:default; }
    .cushion-stat:hover { background:none; border-color:transparent; }
    .chart-stat strong { display:block; font-size:1.4rem; margin:4px 0; letter-spacing:-.035em; font-variant-numeric:tabular-nums; }
    .chart-stat small { font-size:.65rem; color:var(--secondary-text-color); }
    .chart-caption { display:flex; justify-content:space-between; gap:12px; border-top:1px solid var(--divider-color); padding-top:18px; font-size:.77rem; }
    .chart-caption span { color:var(--secondary-text-color); }
    .cushion-card { background:var(--stash-cushion-bg); }
    .cushion-card .card-heading ha-icon { color:var(--stash-success); }
    .member-card { background:var(--stash-cushion-bg); }
    .member-card .card-heading ha-icon { color:var(--stash-success); }
    .member-card .cushion-label { margin-top:8px; }
    .member-cushion-share { margin-top:20px; padding-top:18px; border-top:1px solid var(--divider-color); }
    .cushion-label { display:block; color:var(--secondary-text-color); font-size:.75rem; margin-top:24px; }
    .cushion-amount { font-size:2.4rem; letter-spacing:-.055em; font-weight:700; margin:4px 0; font-variant-numeric:tabular-nums; }
    .cushion-amount-secondary { font-size:1.4rem; letter-spacing:-.04em; font-weight:650; margin:4px 0; font-variant-numeric:tabular-nums; }
    .period-cushion { display:flex; justify-content:space-between; align-items:center; gap:12px; border-top:1px solid var(--divider-color); margin-top:18px; padding-top:16px; }
    .period-cushion span { font-size:.75rem; color:var(--secondary-text-color); }
    .period-cushion strong { font-size:1.15rem; font-variant-numeric:tabular-nums; }
    .period-cushion-note { font-size:.72rem; line-height:1.5; color:var(--secondary-text-color); margin:8px 0 0; }
    .cushion-deposit-btn { width:100%; margin-top:12px; }
    .cushion-explanation { font-size:.8rem; line-height:1.65; color:var(--secondary-text-color); margin:6px 0 20px; max-width:390px; }
    .period-bills { margin-top:24px; }
    .text-action { border:0; background:none; color:var(--primary-color); cursor:pointer; font-size:.75rem; }
    .bill-filters { margin:20px 0 8px; }
    .period-bill { width:100%; display:flex; align-items:center; gap:16px; padding:14px 0; border:0; border-bottom:1px solid var(--divider-color); background:none; color:inherit; text-align:left; cursor:pointer; }
    .period-bill:last-child { border-bottom:0; }
    .bill-date { display:flex; flex-direction:column; align-items:center; justify-content:center; background:var(--secondary-background-color); border-radius:10px; width:45px; height:48px; flex-shrink:0; }
    .bill-date strong { font-size:1rem; } .bill-date small { font-size:.6rem; text-transform:uppercase; color:var(--secondary-text-color); }
    .bill-description { flex:1; min-width:0; overflow-wrap:anywhere; }
    .bill-description strong, .bill-value strong { font-size:.84rem; font-weight:600; }
    .bill-description small, .bill-value small { display:block; font-size:.68rem; color:var(--secondary-text-color); margin-top:4px; }
    .bill-value { text-align:right; font-variant-numeric:tabular-nums; flex-shrink:0; }
    .bill-value .positive { color:var(--stash-success); }
    .late-text, .bill-value .late-text, .shortfall { color:var(--stash-danger); }
    .row-chevron { color:var(--secondary-text-color); }
    .setup { text-align:center; padding:40px; } .setup p { color:var(--secondary-text-color); }
    @media(max-width:1100px) { .chart-layout { gap:12px; } .bill-ring { width:160px; height:160px; flex-basis:160px; } .focus-card { padding:22px; } }
    @media(max-width:900px) { .overview-grid { grid-template-columns:1fr; } .chart-layout { gap:36px; } .bill-ring { width:190px; height:190px; flex-basis:190px; } }
    @media(max-width:600px) { .period-heading { align-items:flex-start; flex-direction:column; gap:16px; margin-bottom:20px; } .period-toggle { width:100%; } .period-toggle button { flex:1; } .focus-card { padding:20px 16px; border-radius:16px; } .chart-layout { gap:10px; padding:24px 0; } .bill-ring { width:145px; height:145px; flex-basis:145px; padding:10px; } .ring-center strong { font-size:1.2rem; } .chart-stat { padding:8px; } .chart-stat strong { font-size:1.15rem; } .chart-stat small { display:none; } .period-bill { gap:10px; } .row-chevron { display:none; } }
  `];

  private _go(tab: string): void {
    this.dispatchEvent(new CustomEvent("stash-navigate", {
      detail: { tab }, bubbles: true, composed: true,
    }));
  }

  // Recomputes each member's responsibility/paid/settlement figures for
  // whichever bill subset the view dropdown selects, using the same rules
  // the backend applies for the current month (bill_responsibility_totals,
  // compute_settlement) - each Bill already carries its own per-member
  // responsibility split and payment contributions, so this needs no
  // backend support to work for the period/next-period buckets too.
  private _memberBreakdown(bills: Bill[]): Map<string, MemberBreakdown> {
    const members = this.financeState.members;
    const responsible = new Map<string, number>(members.map((m) => [m.memberId, 0]));
    const settlementResponsible = new Map<string, number>(members.map((m) => [m.memberId, 0]));
    const paid = new Map<string, number>(members.map((m) => [m.memberId, 0]));
    const settlementPaid = new Map<string, number>(members.map((m) => [m.memberId, 0]));

    for (const bill of bills) {
      for (const m of members) {
        responsible.set(m.memberId, (responsible.get(m.memberId) ?? 0) + responsibilityFor(bill, m.memberId));
      }
      const hasContribution = bill.payments.some(p => p.contributions.length > 0);
      // Personal payments remain visible in progress, but never create
      // household reimbursement credits or debts.
      if (hasContribution) {
        for (const payment of bill.payments) for (const c of payment.contributions) {
          paid.set(c.memberId, (paid.get(c.memberId) ?? 0) + c.amount);
          if (!bill.responsibleMemberId) settlementPaid.set(c.memberId, (settlementPaid.get(c.memberId) ?? 0) + c.amount);
        }
      } else if (bill.status === "paid") {
        for (const m of members) paid.set(m.memberId, (paid.get(m.memberId) ?? 0) + responsibilityFor(bill, m.memberId));
      }
      if (hasContribution && !bill.responsibleMemberId) {
        for (const m of members) settlementResponsible.set(m.memberId,
          (settlementResponsible.get(m.memberId) ?? 0) + responsibilityFor(bill, m.memberId));
      }
    }

    const totalResponsible = [...responsible.values()].reduce((sum, v) => sum + v, 0);
    const breakdown = new Map<string, MemberBreakdown>();
    for (const m of members) {
      const resp = responsible.get(m.memberId) ?? 0;
      const paidAmount = paid.get(m.memberId) ?? 0;
      breakdown.set(m.memberId, {
        responsibleAmount: round2(resp),
        responsibilityPct: totalResponsible > 0 ? (resp / totalResponsible) * 100 : 0,
        actuallyPaid: round2(paidAmount),
        settlementBalance: round2((settlementPaid.get(m.memberId) ?? 0) - (settlementResponsible.get(m.memberId) ?? 0)),
      });
    }
    return breakdown;
  }


  render() {
    const data = this.financeState;
    const today = localDate();
    const plan = periodPlan(data, today);
    const isNext = this._overviewPeriod === "next";
    const bills = plan ? (isNext ? plan.next : plan.current) : [];
    const total = bills.reduce((s, b) => s + b.amount, 0);
    const remaining = bills.reduce((s, b) => s + remainingForBill(b), 0);
    const paid = round2(total - remaining);
    const pct = total > 0 ? paid / total * 100 : 0;
    // The ring's full circle is bills + the cushion still to set aside, so
    // the cushion shows as its own slice instead of being invisible once
    // bills are accounted for. Always based on the actual cushion target
    // (not toggle-dependent), same as the "Add to cushion" line below it.
    const cushionAmount = plan?.balance.transfer ?? 0;
    const chartTotal = total + cushionAmount;
    const paidProgress = chartTotal > 0 ? (paid / chartTotal) * 100 : 0;
    const billsProgress = chartTotal > 0 ? ((paid + remaining) / chartTotal) * 100 : 0;
    const queue = bills.filter(b => this._queue === "all" || (this._queue === "paid" ? b.amount - remainingForBill(b) > 0 : remainingForBill(b) > 0));
    const fmtDate = (s: string) => new Date(s + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const lastDay = (s: string) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() - 1); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
    const balance = plan?.balance;
    const choose = (filter: typeof this._queue) => { this._queue = filter; };
    const me = this.financeState.members.find(m => m.haUserId === this.hass.user?.id);
    const myBreakdown = me ? this._memberBreakdown(bills).get(me.memberId) : undefined;
    const myDeposit = myBreakdown ? Math.max(0, round2(myBreakdown.responsibleAmount - myBreakdown.actuallyPaid)) : 0;
    const funding = me && plan ? budgetFunding(me, isNext ? plan.end : plan.start,
      isNext ? plan.nextEnd : plan.end, periodPayments(me, data.bills,
        isNext ? plan.end : plan.start, isNext ? plan.nextEnd : plan.end)) : null;
    // Cushion saved in the previous period covers the viewed period; what to
    // save during the viewed period is based on the period after it. Viewing
    // "next period" shifts both one step forward.
    const flow = plan ? cushionFlow(data, plan) : null;
    const savePlan = isNext ? flow?.following : plan;
    const carriedIn = (isNext ? plan?.balance.transfer : flow?.previous?.balance.transfer) ?? 0;
    const toSave = savePlan?.balance.transfer ?? 0;
    const myToSave = savePlan?.cushionMembers.find(m => m.memberId === me?.memberId)?.transfer ?? 0;
    return html`
      <div class="period-heading">
        <div><span class="eyebrow">YOUR PAY-PERIOD PLAN</span><h2>A little more breathing room.</h2>
          <p>${plan ? `${fmtDate(isNext ? plan.end : plan.start)} – ${lastDay(isNext ? plan.nextEnd : plan.end)}` : "Add your household’s pay schedule to get started."}</p></div>
        <div class="period-toggle" role="group" aria-label="Overview pay period">
          <button aria-pressed=${!isNext} @click=${() => { this._overviewPeriod = "current"; choose("all"); }}>This period</button>
          <button aria-pressed=${isNext} @click=${() => { this._overviewPeriod = "next"; choose("all"); }}>Next period</button>
        </div>
      </div>
      ${!plan ? html`<section class="focus-card setup"><ha-icon icon="mdi:calendar-month-outline"></ha-icon><h2>Start with payday.</h2><p>Stash uses your household’s pay dates to group bills and plan a cushion.</p><button class="primary" @click=${() => this._go("household")}>Set up pay schedules</button></section>` : html`
      <div class="overview-grid">
        <section class="focus-card progress-card">
          <div class="card-heading"><h2>Bills ${isNext ? "next" : "this"} period</h2><span class="quiet">${bills.length} bills</span></div>
          <div class="chart-layout">
            <button
              class="bill-ring"
              style=${`--paid-progress:${paidProgress}%; --bills-progress:${billsProgress}%;`}
              @click=${() => choose("all")}
              aria-label=${`Show all bills: ${money(total)} total, ${money(paid)} paid, ${money(remaining)} left to pay${cushionAmount > 0 ? `, plus ${money(cushionAmount)} to set aside for the cushion` : ""}`}
            >
              <span class="ring-center"><small>Total bills</small><strong>${money(total)}</strong><span>${Math.round(pct)}% paid</span></span>
            </button>
            <div class="chart-key">
              <button class="chart-stat paid-stat" aria-pressed=${this._queue === "paid"} @click=${() => choose("paid")}><span><i></i>Paid</span><strong>${money(paid)}</strong><small>View payments made →</small></button>
              <button class="chart-stat due-stat" aria-pressed=${this._queue === "due"} @click=${() => choose("due")}><span><i></i>Left to pay</span><strong>${money(remaining)}</strong><small>View outstanding bills →</small></button>
              ${cushionAmount > 0
                ? html`<div class="chart-stat cushion-stat"><span><i></i>Cushion to set aside</span><strong>${money(cushionAmount)}</strong></div>`
                : ""}
            </div>
          </div>
          <div class="chart-caption"><span>Next period starts</span><strong>${fmtDate(isNext ? plan.nextEnd : plan.end)}</strong></div>
          <div class="period-cushion">
            <span>Cushion from ${isNext ? "this" : "last"} period</span>
            <strong>${money(carriedIn)}</strong>
          </div>
          <p class="period-cushion-note">Set aside ${isNext ? "this" : "last"} period to help cover ${isNext ? "next" : "this"} period’s bills. Savings and personal Stashes are excluded.</p>
          <details><summary>How the cushion is calculated</summary><p class="period-cushion-note">For each person, compare what is left after bills in this period and the next: the paychecks landing in that period minus the bills they are responsible for. If next period leaves less, set aside half the gap now so both periods end with about the same cushion. One person’s roomier period never offsets another person’s tighter one. This is a reserve target based on scheduled income and bills, not available cash.</p></details>
          ${balance!.transfer > 0
            ? html`<button class="secondary cushion-deposit-btn" @click=${() => (this._cushionDepositOpen = true)}>
                Deposit to cushion
              </button>`
            : ""}
        </section>
        <section class="focus-card member-card">
          ${me
            ? html`
                <div class="card-heading"><h2>${me.name}</h2><ha-icon icon="mdi:account-circle-outline"></ha-icon></div>
                <span class="cushion-label">Budget funding for ${isNext ? "next" : "this"} period</span>
                <div class="cushion-amount">${money(funding!.deposit)}</div>
                <p class="quiet">Based on ${money(funding!.income)} scheduled income and your monthly budget share. Capped at scheduled income after ${money(funding!.credited)} in recorded bill payments. This is a funding target, not your available bank balance. Savings and cushion are separate.</p>
                <p class="quiet">Period budget target: ${money(funding!.target)}.</p>
                ${funding!.shortfall > 0 ? html`<p class="shortfall">Period budget unfunded: ${money(funding!.shortfall)}</p>` : ""}
                ${funding!.income === 0 ? html`<p class="shortfall">No income scheduled this period. Review income and pay dates in Household.</p>` : ""}
                <div class="member-cushion-share">
                  <span class="cushion-label">Your bills still owed ${isNext ? "next" : "this"} period</span>
                  <div class="cushion-amount-secondary">${money(myDeposit)}</div>
                  <p class="quiet">Bill obligations remain due. Category spending is included in the budget target above.</p>
                  ${myDeposit > funding!.deposit ? html`<p class="shortfall">Bills above this funding target: ${money(myDeposit - funding!.deposit)}. Existing funds or a revised plan are needed.</p>` : ""}
                </div>
                <div class="member-cushion-share">
                  <span class="cushion-label">Your monthly budget responsibility</span>
                  <div class="cushion-amount-secondary">${money(me.budgetResponsibleAmount)}</div>
                  <span class="quiet">Includes bills and category budgets; savings are separate.</span>
                  ${funding!.monthlyShortfall > 0 ? html`<p class="shortfall">Monthly budget exceeds your ${money(me.income)} income by ${money(funding!.monthlyShortfall)}. Reduce the budget or add income to close the gap.</p>` : ""}
                </div>
                <div class="member-cushion-share">
                  <span class="cushion-label">Your cushion to save ${isNext ? "next" : "this"} period</span>
                  <div class="cushion-amount-secondary">${money(myToSave)}</div>
                  <span class="quiet">Household total ${money(toSave)}</span>
                </div>
              `
            : html`
                <div class="card-heading"><h2>Your deposit</h2><ha-icon icon="mdi:account-circle-outline"></ha-icon></div>
                <p class="cushion-explanation">
                  Link your account to a household member from the Household tab to see your
                  personal deposit and cushion share here.
                </p>
              `}
        </section>
      </div>
      <section class="focus-card period-bills">
        <div class="card-heading"><h2>Your bills</h2><button class="text-action" @click=${() => this._go("bills")}>Manage bills ↗</button></div>
        <div class="bill-filters" role="group" aria-label="Filter period bills">
          ${(["all", "due", "paid"] as const).map(filter => html`<button aria-pressed=${this._queue === filter} @click=${() => choose(filter)}>${{ all: "All bills", due: "To pay", paid: "Paid" }[filter]}</button>`)}
        </div>
        <div class="period-list">
          ${queue.map(b => {
            const left = remainingForBill(b);
            const due = b.status === "deferred" && b.deferredUntil ? b.deferredUntil : b.dueDate;
            return html`<button class="period-bill" @click=${() => (this._selectedBill = b)} aria-label=${`Open ${b.name}`}>
              <span class="bill-date"><strong>${due.slice(8)}</strong><small>${new Date(due + "T12:00:00").toLocaleDateString(undefined, { month: "short" })}</small></span>
              <span class="bill-description"><strong>${b.name}</strong><small>${left === 0 ? `Due ${fmtDate(due)} · Paid` : `${b.status === "deferred" ? "Deferred to" : "Due"} ${fmtDate(due)}`}${b.lateFee ? ` · ${money(b.lateFee)} fee included` : ""}</small></span>
              <span class="bill-value"><strong>${money(this._queue === "paid" ? b.amount - left : left === 0 ? b.amount : left)}</strong><small class=${this._queue === "paid" || left === 0 ? "positive" : isOverdue(b, today) ? "late-text" : ""}>${left === 0 ? "Paid ✓" : this._queue === "paid" ? "Part paid" : isOverdue(b, today) ? "Overdue" : b.payments.length ? "Left after payments" : "To pay"}</small></span><span class="row-chevron">›</span>
            </button>`;
          })}
          ${!queue.length ? html`<p class="empty">No ${this._queue === "all" ? "" : this._queue === "paid" ? "paid " : "outstanding "}bills in this period.</p>` : ""}
        </div>
      </section>
      `}
      <finance-bill-workspace
        .hass=${this.hass}
        .financeState=${data}
        .bill=${this._selectedBill}
        @bill-workspace-closed=${() => (this._selectedBill = null)}
      ></finance-bill-workspace>

      <finance-savings-deposit-dialog
        .hass=${this.hass}
        .open=${this._cushionDepositOpen}
        heading="Deposit to Cushion"
        .targetAmount=${balance?.transfer ?? 0}
        @savings-deposit-closed=${() => (this._cushionDepositOpen = false)}
      ></finance-savings-deposit-dialog>

    `;
  }

}

declare global {
  interface HTMLElementTagNameMap {
    "finance-dashboard-view": FinanceDashboardView;
  }
}
