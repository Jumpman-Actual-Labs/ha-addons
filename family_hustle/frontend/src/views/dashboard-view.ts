import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { HustleState } from "../types";
import { formatCents } from "../utils/money";
import { formatDate, formatRelative, today, isOverdue, isWithinAvailabilityWindow } from "../utils/time";
import { memberName } from "../utils/members";
import { formStyles } from "../styles";

@customElement("hustle-dashboard-view")
export class HustleDashboardView extends LitElement {
  @property({ attribute: false }) readOnly = false;
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;
  @property({ attribute: false }) effectiveMemberId!: string;
  @property({ attribute: false }) isParent = false;
  @property({ attribute: false }) visibleMemberIds: string[] = [];

  static styles = [formStyles, css`
    * { box-sizing: border-box; }
    .kid-welcome { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-bottom:28px; }
    .kid-welcome h1 { margin:6px 0; }
    .kid-wallet { display:flex; gap:12px; align-items:center; padding:16px 20px; border-radius:18px; border:1px solid var(--divider-color,#e2e7e9); background:var(--card-background-color,#fff); color:inherit; text-align:left; cursor:pointer; flex-shrink:0; }
    .kid-wallet strong { display:block; font-size:1.65rem; letter-spacing:-.04em; }
    .kid-wallet small { display:block; color:var(--secondary-text-color,#657080); }
    @media(max-width:600px) { .kid-welcome { align-items:stretch; flex-direction:column; gap:16px; } .kid-wallet { justify-content:space-between; } }
    .heading { margin-bottom: 26px; }
    .eyebrow { font-size: .72rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--secondary-text-color,#657080); }
    h1 { font-size: clamp(1.65rem,4vw,2.15rem); margin: 8px 0; font-weight: 750; }
    h2 { font-size: 1rem; margin: 0; font-weight: 650; }
    p { margin: 6px 0; }
    .top { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; margin-bottom: 28px; }
    .hero { background: #153d35; color: #fff; border-radius: 22px; padding: 28px; display: flex; flex-direction: column; align-items: flex-start; }
    .hero .eyebrow { color: #b9d2c9; }
    .amount { font-size: clamp(2.6rem,6vw,3.8rem); font-weight: 750; letter-spacing: -.05em; margin: 10px 0 4px; font-variant-numeric: tabular-nums; }
    .hero p { color: #c5dcd3; font-size: .9rem; }
    .hero-footer { border-top: 1px solid #ffffff26; padding-top: 20px; margin-top: 24px; width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .hero button { background: #e1f6a7; color: #173b2f; border: 0; border-radius: 10px; padding: 10px 16px; cursor: pointer; font-weight: 650; }
    .panel { border: 1px solid var(--divider-color,#e2e7e9); background: var(--card-background-color,#fff); border-radius: 20px; padding: 24px; min-width: 0; }
    .panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .attention-row { width: 100%; display: flex; align-items: center; gap: 14px; padding: 15px 0; background: none; border: 0; border-bottom: 1px solid var(--divider-color,#edf0f2); text-align: left; cursor: pointer; }
    .attention-row:last-child { border-bottom: 0; }
    .count { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: var(--secondary-background-color,#f1f5f3); font-size: 1.15rem; font-weight: 700; flex-shrink: 0; }
    .row-copy { flex: 1; min-width: 0; }
    .row-copy strong { display: block; font-size: .92rem; font-weight: 600; }
    .row-copy small { display: block; margin-top: 3px; color: var(--secondary-text-color,#657080); }
    .lower { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; align-items: start; }
    .member { padding: 20px 0; border-bottom: 1px solid var(--divider-color,#edf0f2); }
    .member:last-child { padding-bottom: 0; border: 0; }
    .member:first-of-type { padding-top: 0; }
    .member-top { display: flex; gap: 12px; align-items: center; }
    .avatar { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: var(--secondary-background-color,#edf3ee); color: var(--primary-text-color,#214939); font-weight: 700; }
    .member-amount { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    progress { appearance: none; display: block; width: 100%; height: 6px; border: 0; border-radius: 8px; overflow: hidden; margin: 14px 0 8px; background: var(--divider-color,#edf0f2); }
    progress::-webkit-progress-bar { background: var(--divider-color,#edf0f2); }
    progress::-webkit-progress-value { background: #368269; border-radius: 8px; }
    progress::-moz-progress-bar { background: #368269; }
    .member-meta { display: flex; justify-content: space-between; gap: 8px; font-size: .78rem; color: var(--secondary-text-color,#657080); }
    .activity { display: flex; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--divider-color,#edf0f2); }
    .activity:last-child { border-bottom: 0; padding-bottom: 0; }
    .dot { width: 7px; height: 7px; background: #70a38b; border-radius: 50%; margin-top: 7px; flex-shrink: 0; }
    .activity-title { font-size: .88rem; overflow-wrap: anywhere; }
    .activity-time { font-size: .76rem; color: var(--secondary-text-color,#657080); margin-top: 4px; }
    .activity-money { margin-left: auto; white-space: nowrap; font-size: .85rem; font-weight: 600; }
    .quiet { font-size: .8rem; color: var(--secondary-text-color,#657080); }
    .empty { line-height: 1.6; padding: 20px 0; }
    @media(max-width:760px) { .top,.lower { grid-template-columns: 1fr; gap: 16px; } .hero,.panel { padding: 22px; } .heading { margin-bottom: 20px; } }
  `];

  private _go(tab: string) {
    this.dispatchEvent(new CustomEvent("hustle-navigate", { detail: tab, bubbles: true, composed: true }));
  }

  private _attention(count: number, title: string, detail: string, tab: string) {
    return html`<button class="attention-row" @click=${() => this._go(tab)}><span class="count">${count}</span><span class="row-copy"><strong>${title}</strong><small>${detail}</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button>`;
  }

  render() {
    const s = this.hustleState;
    const scoped = (id: string) => this.isParent ? this.visibleMemberIds.includes(id) : id === this.effectiveMemberId;
    const members = s.members.filter(m => scoped(m.memberId));
    const earned = members.reduce((sum, m) => sum + m.pendingEarningsCents, 0);
    const assignments = s.choreAssignments.filter(a => scoped(a.memberId) && (this.isParent || a.dueDate <= today()));
    const todo = assignments.filter(a => (a.status === "assigned" || a.status === "rejected") && (this.isParent || (!isOverdue(a.dueDate,a.dueTime) && isWithinAvailabilityWindow(a.dueDate,a.availableFromTime,a.availableUntilTime)))).length;
    const approvals = assignments.filter(a => a.status === "submitted").length;
    const bountyApprovals = s.bounties.reduce((sum,b) => sum + b.acceptances.filter(a => scoped(a.memberId) && a.status === "submitted").length,0);
    const activity = s.recentActivity.filter(a => a.memberId === null || scoped(a.memberId)).slice(0,6);
    const payday = s.daysUntilPayday === null ? "Payday not scheduled" : s.daysUntilPayday === 0 ? "Payday is today" : s.daysUntilPayday < 0 ? "Payday has passed" : `Payday in ${s.daysUntilPayday} ${s.daysUntilPayday === 1 ? "day" : "days"}`;
    if (!this.isParent) return html`
      <div class="kid-welcome">
        <div><div class="eyebrow">Your day, one task at a time</div><h1>Hi, ${memberName(s, this.effectiveMemberId)}.</h1><p class="muted">Finish a task. Tap “I’m done!” A parent checks it next.</p></div>
        <button class="kid-wallet" @click=${() => this._go("my-paycheck")}><span><small>My earnings</small><strong>${formatCents(earned)}</strong><small>${payday}</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button>
      </div>
      <hustle-chores-view .hass=${this.hass} .hustleState=${s} .effectiveMemberId=${this.effectiveMemberId} .isParent=${false} .assignableMemberIds=${[]} .readOnly=${this.readOnly}></hustle-chores-view>
    `;
    return html`
      <div class="heading"><div class="eyebrow">${this.isParent ? "Family overview" : "Your overview"}</div><h1>${this.isParent ? "A little effort. A lot of progress." : `${memberName(s, this.effectiveMemberId)}, let’s get started!`}</h1><p class="muted">${this.isParent ? "A clear view of the work, the rewards, and what comes next." : "Your chores, your progress, your next paycheck."}</p></div>
      <div class="top">
        <section class="hero"><div class="eyebrow">${this.isParent ? "Family earnings this period" : "Your earnings this period"}</div><div class="amount">${formatCents(earned)}</div><p>${s.currentPeriod ? `${formatDate(s.currentPeriod.startDate)} – ${formatDate(s.currentPeriod.endDate)}` : "Earnings will appear as work is approved."}</p><div class="hero-footer"><span>${payday}</span><button @click=${() => this._go(this.isParent ? "payroll" : "my-paycheck")}>${this.isParent ? "View payroll" : "See my money"} →</button></div></section>
        <section class="panel"><div class="panel-heading"><h2>${this.isParent ? "Needs attention" : "What do you want to do?"}</h2></div>
          ${this._attention(todo,this.isParent ? "Assigned chores" : "Chores to do",this.isParent ? "See each child's assigned work" : "Pick up where you left off","chores")}
          ${this._attention(approvals,this.isParent ? "Chores to review" : "Waiting for approval",this.isParent ? "Approve completed work" : "Waiting for a parent","chores")}
          ${this.isParent ? this._attention(bountyApprovals,"Bounties to review","Check completed extra work","bounties") : this._attention(s.bounties.filter(b => b.status === "open").length,"Extra jobs","Do a little extra. Earn a little more.","bounties")}
        </section>
      </div>
      <div class="lower">
        <section class="panel"><div class="panel-heading"><h2>${this.isParent ? "Everyone's progress" : "Your progress"}</h2><span class="quiet">This pay period</span></div>
          ${members.length ? members.map(m => { const total = Math.max(0,m.pendingEarningsCents + m.potentialEarningsCents); const pct = total ? Math.max(0,Math.min(100,m.pendingEarningsCents/total*100)) : 0; const name = memberName(s,m.memberId); return html`<div class="member"><div class="member-top"><div class="avatar" aria-hidden="true">${name.slice(0,1)}</div><div class="row-copy"><strong>${name}</strong><small>${formatCents(m.lifetimeEarningsCents)} earned overall</small></div><div class="member-amount">${formatCents(m.pendingEarningsCents)}</div></div><progress max="100" value=${pct} aria-label=${`${name}'s earning progress`}></progress><div class="member-meta"><span>Earned this period</span><span>${formatCents(total)} possible</span></div></div>`; }) : html`<p class="empty">No earnings to show yet. Assign a chore to get started.</p>`}
        </section>
        <section class="panel"><div class="panel-heading"><h2>Latest activity</h2><span class="quiet">Most recent</span></div>${activity.length ? activity.map(a => html`<div class="activity"><span class="dot"></span><div><div class="activity-title">${a.title}</div><div class="activity-time">${formatRelative(a.occurredAt)}</div></div>${a.amountCents !== null ? html`<span class="activity-money">${formatCents(a.amountCents)}</span>` : ""}</div>`) : html`<p class="empty">A fresh start. Completed chores and rewards will appear here.</p>`}</section>
      </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { "hustle-dashboard-view": HustleDashboardView; } }
