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
