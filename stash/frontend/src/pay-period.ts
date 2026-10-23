import type { Bill, FinanceState, Member, PayFrequency } from "./types";
import { dueOrder, remainingForBill, responsibilityFor } from "./bill-selectors";

const round = (n: number) => Math.round(n * 100) / 100;
const date = (s: string) => new Date(s + "T12:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const days = (s: string, n: number) => { const d = date(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

type PaySchedule = Pick<Member, "payFrequency" | "payDays" | "payAnchorDate">;

// Paychecks per month, used to turn a monthly figure into one paycheck.
// Weekly/biweekly use the annualized average (52 or 26 per year / 12).
export const MONTHLY_PAY_MULTIPLIER: Record<PayFrequency, number> = {
  monthly: 1,
  semi_monthly: 2,
  biweekly: 26 / 12,
  weekly: 52 / 12,
};

export function payDates(member: PaySchedule, start: string, end: string): string[] {
  const result: string[] = [];
  for (let cursor = start; cursor < end; cursor = days(cursor, 1)) {
    const d = date(cursor);
    if (member.payFrequency === "weekly" || member.payFrequency === "biweekly") {
      if (!member.payAnchorDate) continue;
      const diff = Math.round((d.getTime() - date(member.payAnchorDate).getTime()) / 86400000);
      if (diff >= 0 && diff % (member.payFrequency === "weekly" ? 7 : 14) === 0) result.push(cursor);
    } else {
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      const configuredDays = member.payDays.length ? member.payDays : member.payFrequency === "monthly" ? [1] : [1, 15];
      const payDays = member.payFrequency === "monthly" ? configuredDays.slice(0, 1) : configuredDays;
      if (payDays.some(day => Math.min(day, last) === d.getUTCDate())) result.push(cursor);
    }
  }
  return result;
}

// A member's income streams, each paid on its own schedule. Without named
// sources, their single income figure follows their own pay schedule.
function incomeStreams(member: Member): { monthly: number; schedule: PaySchedule }[] {
  const sources = member.incomeSources ?? [];
  if (sources.length) return sources.map(s => ({ monthly: s.amount, schedule: s }));
  return [{ monthly: member.income, schedule: member }];
}

// Income that actually lands in [from, to), by each stream's own paydays.
export function incomeBetween(member: Member, from: string, to: string): number {
  return round(incomeStreams(member).reduce(
    (sum, { monthly, schedule }) =>
      sum + payDates(schedule, from, to).length * (monthly / MONTHLY_PAY_MULTIPLIER[schedule.payFrequency]),
    0));
}

// Scheduled funding guidance, not an available bank balance.
export function budgetFunding(member: Member, from: string, to: string, paid = 0) {
  const income = Math.max(0, incomeBetween(member, from, to));
  const monthlyIncome = Math.max(0, member.income);
  const monthlyBudget = Math.max(0, member.budgetResponsibleAmount);
  const share = monthlyIncome > 0 ? income / monthlyIncome
    : payDates(member, from, to).length / MONTHLY_PAY_MULTIPLIER[member.payFrequency];
  const target = round(monthlyBudget * share);
  const credited = Math.max(0, paid);
  const remainingTarget = round(Math.max(0, target - credited));
  const deposit = round(Math.min(remainingTarget, Math.max(0, income - credited)));
  return { income, target, deposit, credited: round(credited),
    shortfall: round(Math.max(0, remainingTarget - deposit)),
    monthlyShortfall: round(Math.max(0, monthlyBudget - monthlyIncome)) };
}

export function periodPayments(member: Member, bills: Bill[], from: string, to: string): number {
  return round(bills.reduce((sum, bill) => sum + bill.payments
    .filter(payment => payment.date >= from && payment.date < to)
    .reduce((total, payment) => total + payment.contributions
      .filter(contribution => contribution.memberId === member.memberId)
      .reduce((amount, contribution) => amount + contribution.amount, 0), 0), 0));
}

export function balanceResponsibilities(current: number, next: number) {
  const transfer = round(Math.max(0, (next - current) / 2));
  return { current: round(current), next: round(next), transfer, currentAfter: round(current + transfer), nextAfter: round(next - transfer) };
}

// The cushion target this period's plan would have shown a day before it
// began (what was set aside to cover this period) and what the next period's
// plan will ask for. Re-running periodPlan as of those dates keeps all three
// numbers on identical math rather than a second, divergent calculation.
export function cushionFlow(data: FinanceState, plan: { start: string; end: string }) {
  return {
    previous: periodPlan(data, days(plan.start, -1)),
    following: periodPlan(data, plan.end),
  };
}

export function periodPlan(data: FinanceState, today: string) {
  const startOfMonth = today.slice(0, 7) + "-01";
  const horizon = days(today, 100);
  const schedules = data.members.map(m => {
    const sourceDates = [...new Set(incomeStreams(m)
      .flatMap(stream => payDates(stream.schedule, startOfMonth, horizon)))].sort();
    return { member: m, dates: sourceDates.length ? sourceDates : payDates(m, startOfMonth, horizon) };
  });
  const configured = schedules.filter(s => s.dates.length);
  const allDates = [...new Set(configured.flatMap(s => s.dates))].sort();
  if (!allDates.length) return null;
  // A household round includes at least one payday for each configured member.
  let start = startOfMonth;
  const endAfter = (from: string) => {
    const first = configured.map(s => s.dates.find(d => d >= from)).filter((d): d is string => !!d);
    if (first.length !== configured.length) return null;
    const complete = first.sort()[first.length - 1];
    return allDates.find(d => d > complete) ?? null;
  };
  let end = endAfter(start);
  while (end && today >= end) { start = end; end = endAfter(start); }
  if (!end) return null;
  const nextEnd = endAfter(end);
  if (!nextEnd) return null;
  const effectiveDate = (b: Bill) => b.status === "deferred" ? b.deferredUntil : b.dueDate;
  const between = (from: string, to: string) => data.bills.filter(b => {
    const due = effectiveDate(b); return due && due >= from && due < to;
  }).sort(dueOrder);
  const currentOnly = between(start, end);
  const next = between(end, nextEnd);
  const carryover = data.bills.filter(b => {
    const due = effectiveDate(b);
    if (!due || due >= start) return false;
    if (remainingForBill(b) > 0) return true; // still owed
    // Paid off during this period - keep it counted (as paid) instead of
    // just vanishing the moment it's settled. Only a bill fully resolved
    // before this period began drops out for good.
    return b.payments.some(p => p.date >= start);
  }).sort(dueOrder);
  // Still-unpaid bills from before this period are folded into "current"
  // rather than kept in a separate bucket - they're money you still owe
  // right now, and hiding them out of the period total/list made them look
  // like they'd vanished instead of just being overdue.
  const current = [...carryover, ...currentOnly].sort(dueOrder);
  const total = round(current.reduce((s, b) => s + b.amount, 0));
  const remaining = round(current.reduce((s, b) => s + remainingForBill(b), 0));
  const carryoverTotal = round(carryover.reduce((s, b) => s + remainingForBill(b), 0));
  const nextTotal = round(next.reduce((s, b) => s + b.amount, 0));
  const cushionMembers = data.members.map(member => {
    const currentShare = current.reduce((sum, b) => sum + responsibilityFor(b, member.memberId), 0);
    const nextShare = next.reduce((sum, b) => sum + responsibilityFor(b, member.memberId), 0);
    // The cushion evens out what each person has left after bills: income
    // landing in the period minus the bills they're responsible for. Passing
    // that net burden through the same half-the-gap rule saves from the
    // roomier period into the tighter one.
    const currentIncome = incomeBetween(member, start, end);
    const nextIncome = incomeBetween(member, end, nextEnd);
    const net = balanceResponsibilities(currentShare - currentIncome, nextShare - nextIncome);
    return {
      memberId: member.memberId, name: member.name,
      current: round(currentShare), next: round(nextShare), currentIncome, nextIncome,
      transfer: net.transfer, currentAfter: net.currentAfter, nextAfter: net.nextAfter,
    };
  });
  const sum = (key: "current" | "next" | "transfer" | "currentAfter" | "nextAfter") => round(cushionMembers.reduce((total, m) => total + m[key], 0));
  // Personal Stashes, cash infusions and savings are not part of the cushion.
  // Each person's target stays separate rather than offsetting another person's.
  const balance = { current: sum("current"), next: sum("next"), transfer: sum("transfer"), currentAfter: sum("currentAfter"), nextAfter: sum("nextAfter") };
  return { start, end, nextEnd, current, next, carryover, total, remaining, paid: round(total - remaining), carryoverTotal, nextTotal, cushionMembers, balance };
}
