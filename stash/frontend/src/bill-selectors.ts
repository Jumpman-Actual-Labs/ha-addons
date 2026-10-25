import type { Bill } from "./types";

export function responsibilityFor(bill: Bill, memberId: string): number {
  if (bill.responsibleMemberId) return bill.responsibleMemberId === memberId ? bill.amount : 0;
  return bill.responsibility[memberId] ?? 0;
}

export function remainingForBill(bill: Bill): number {
  if (bill.status === "paid") return 0;
  return Math.max(0, Math.round((bill.amount - bill.payments.reduce((sum, p) => sum + p.total, 0)) * 100) / 100);
}

export function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function isOverdue(bill: Bill, today = localDate()): boolean {
  return bill.status !== "paid" && bill.status !== "deferred" && remainingForBill(bill) > 0 && bill.dueDate < today;
}

export function dueOrder(a: Bill, b: Bill): number {
  return a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name);
}

export type BillSortKey = "dueDate" | "paidDate" | "name" | "payTo" | "amountDue";
export type SortDirection = "asc" | "desc";

export function lastPaymentDate(bill: Bill): string {
  return bill.payments.reduce((latest, payment) => payment.date > latest ? payment.date : latest, "");
}

export function compareBills(a: Bill, b: Bill, key: BillSortKey, direction: SortDirection): number {
  const value = (bill: Bill): string | number => {
    switch (key) {
      case "paidDate": return lastPaymentDate(bill);
      case "amountDue": return remainingForBill(bill);
      case "payTo": return bill.payTo.trim();
      case "name": return bill.name.trim();
      default: return bill.dueDate;
    }
  };
  const av = value(a), bv = value(b);
  // Missing payment dates/payees stay at the end in either direction.
  if (av === "" && bv !== "") return 1;
  if (bv === "" && av !== "") return -1;
  const order = typeof av === "number" && typeof bv === "number"
    ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
  return order * (direction === "asc" ? 1 : -1)
    || dueOrder(a, b) || a.billId.localeCompare(b.billId);
}

/**
 * Every occurrence of one bill. Recurring bills get a new Bill per due
 * date (the next one is generated once the current one is paid or its due
 * date passes), so an overdue occurrence and the next one coexist. Grouped
 * by recurring lineage, and also by name within a category so a bill
 * re-entered by hand (a new lineage) still collapses into the same row.
 */
export interface BillSeries {
  key: string;
  /** The occurrence a list row represents - see seriesFocus. */
  focus: Bill;
  /** Oldest due date first. */
  bills: Bill[];
}

export interface SeriesPayment {
  bill: Bill;
  payment: Bill["payments"][number];
}

function nameKey(bill: Bill): string {
  return `${bill.categoryId}\u0000${bill.name.trim().toLowerCase()}`;
}

/**
 * The earliest unpaid occurrence due by the end of `month` (overdue first),
 * else the latest occurrence in `month`, else the latest overall.
 */
export function seriesFocus(bills: Bill[], month: string): Bill {
  const sorted = [...bills].sort(dueOrder);
  return sorted.find((b) => b.status !== "paid" && b.month <= month)
    ?? [...sorted].reverse().find((b) => b.month === month)
    ?? sorted[sorted.length - 1];
}

export function groupBillSeries(bills: Bill[], month: string): BillSeries[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(k, root);
    return root;
  };
  const union = (a: string, b: string) => {
    for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k);
    parent.set(find(a), find(b));
  };
  for (const bill of bills) {
    union(`l:${bill.recurringParentId ?? bill.billId}`, `n:${nameKey(bill)}`);
  }
  const groups = new Map<string, Bill[]>();
  for (const bill of bills) {
    const root = find(`n:${nameKey(bill)}`);
    groups.set(root, [...(groups.get(root) ?? []), bill]);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    focus: seriesFocus(group, month),
    bills: [...group].sort(dueOrder),
  }));
}

/** Older occurrences may lack a payee (recurrences didn't copy it). */
export function seriesPayTo(series: BillSeries): string {
  return series.focus.payTo || series.bills.map((b) => b.payTo).reverse().find(Boolean) || "";
}

/** Unpaid occurrences, oldest due first. */
export function outstandingInSeries(series: BillSeries): Bill[] {
  return series.bills.filter((b) => b.status !== "paid" && remainingForBill(b) > 0);
}

/** The most recent payments across every occurrence, newest first. */
export function recentSeriesPayments(series: BillSeries, limit = 3): SeriesPayment[] {
  return series.bills
    .flatMap((bill) => bill.payments.map((payment) => ({ bill, payment })))
    .sort((a, b) => b.payment.date.localeCompare(a.payment.date) || b.bill.dueDate.localeCompare(a.bill.dueDate))
    .slice(0, limit);
}
