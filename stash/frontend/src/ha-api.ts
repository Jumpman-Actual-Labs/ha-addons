import type {
  Bill,
  BillPayment,
  CashInfusion,
  CashInfusionContribution,
  Category,
  CategoryExpense,
  Contribution,
  FinanceState,
  IncomeSource,
  Member,
  Savings,
  SavingsBreakdownEntry,
  SavingsPlanEntry,
  Summary,
} from "./types";

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export interface HassUser {
  id: string;
  name: string;
  is_admin: boolean;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  user?: HassUser;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>
  ): Promise<unknown>;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
}

export interface HaUserSummary {
  id: string;
  name: string;
}

const DOMAIN = "finance";

function entitiesWith(hass: HomeAssistant, attr: string, distinguishingAttr?: string): HassEntity[] {
  // Other integrations can (and do - Hustle's per-member sensors are one
  // real example) reuse the same generic attribute name like "member_id" or
  // "category_id" for their own unrelated purposes. Matching on that alone
  // picks up every sensor in the whole Home Assistant instance that happens
  // to have it, not just this integration's own entities. A second,
  // Stash-specific attribute (always present on our own sensors, vanishingly
  // unlikely to appear on anyone else's) disambiguates.
  return Object.values(hass.states).filter(
    (e) =>
      e.entity_id.startsWith("sensor.") &&
      attr in e.attributes &&
      (!distinguishingAttr || distinguishingAttr in e.attributes)
  );
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseFinanceState(hass: HomeAssistant): FinanceState {
  const summaryByKey = new Map<string, HassEntity>();
  for (const entity of entitiesWith(hass, "finance_key")) {
    summaryByKey.set(String(entity.attributes.finance_key), entity);
  }

  const modeEntity = summaryByKey.get("mode");
  const upcomingEntity = summaryByKey.get("upcoming_this_pay_period");

  const summary: Summary = {
    totalIncome: num(summaryByKey.get("total_income")?.state),
    totalBills: num(summaryByKey.get("total_bills")?.state),
    paid: num(summaryByKey.get("paid")?.state),
    remaining: num(summaryByKey.get("remaining")?.state),
    cashRemaining: num(summaryByKey.get("cash_remaining")?.state),
    upcomingThisPayPeriod: num(upcomingEntity?.state),
    overdue: num(summaryByKey.get("overdue")?.state),
    deferred: num(summaryByKey.get("deferred")?.state),
  };

  const members: Member[] = entitiesWith(hass, "member_id", "responsibility_pct").map((e) => ({
    entityId: e.entity_id,
    memberId: String(e.attributes.member_id),
    name: String(e.attributes.name ?? ""),
    notes: String(e.attributes.notes ?? ""),
    income: num(e.attributes.income),
    incomeSources: (Array.isArray(e.attributes.income_sources) ? e.attributes.income_sources : []).map(
      (raw: unknown): IncomeSource => {
        const s = raw as Record<string, unknown>;
        return {
          id: String(s.id),
          name: String(s.name ?? ""),
          amount: num(s.amount),
          payFrequency: (s.pay_frequency as IncomeSource["payFrequency"]) ?? "monthly",
          payDays: Array.isArray(s.pay_days) ? (s.pay_days as number[]) : [],
          payAnchorDate: (s.pay_anchor_date as string | null) ?? null,
          nextPayDate: (s.next_pay_date as string | null) ?? null,
        };
      }
    ),
    responsibilityPct: num(e.attributes.responsibility_pct),
    budgetResponsibleAmount: num(e.attributes.budget_responsible_amount ?? e.attributes.responsible_amount),
    budgetResponsibleAmountExcludingRepayments: num(
      e.attributes.budget_responsible_amount_excluding_repayments ??
      e.attributes.responsible_amount_excluding_repayments
    ),
    responsibleAmount: num(e.attributes.responsible_amount),
    responsibleAmountExcludingRepayments: num(
      e.attributes.responsible_amount_excluding_repayments
    ),
    actuallyPaid: num(e.attributes.actually_paid),
    settlementBalance: num(e.attributes.settlement_balance),
    payFrequency: (e.attributes.pay_frequency as Member["payFrequency"]) ?? "monthly",
    payDays: Array.isArray(e.attributes.pay_days) ? (e.attributes.pay_days as number[]) : [],
    payAnchorDate: (e.attributes.pay_anchor_date as string | null) ?? null,
    nextPayDate: (e.attributes.next_pay_date as string | null) ?? null,
    haUserId: (e.attributes.ha_user_id as string | null) ?? null,
  }));

  const categories: Category[] = entitiesWith(hass, "category_id", "planned_budget").map((e) => ({
    entityId: e.entity_id,
    categoryId: String(e.attributes.category_id),
    name: String(e.attributes.name ?? ""),
    total: num(e.state),
    plannedBudget: num(e.attributes.planned_budget),
    budgetRecommendation:
      (e.attributes.budget_recommendation as Category["budgetRecommendation"]) ?? "maintain",
    historicalAverageSpend: num(e.attributes.historical_average_spend),
    lastMonthSpend: num(e.attributes.last_month_spend),
    expenses: (Array.isArray(e.attributes.expenses) ? e.attributes.expenses : []).map(
      (raw: unknown): CategoryExpense => {
        const x = raw as Record<string, unknown>;
        return {
          id: String(x.id),
          name: String(x.name ?? ""),
          amount: num(x.amount),
          date: String(x.date ?? ""),
          notes: String(x.notes ?? ""),
        };
      }
    ),
  }));

  const asPlanEntries = (value: unknown): SavingsPlanEntry[] =>
    Array.isArray(value)
      ? value.map((e) => ({ month: String(e.month), amount: num(e.amount) }))
      : [];

  const bills: Bill[] = entitiesWith(hass, "bill_id", "bill_category_id").map((e) => ({
    entityId: e.entity_id,
    billId: String(e.attributes.bill_id),
    name: String(e.attributes.name ?? ""),
    payTo: String(e.attributes.pay_to ?? ""),
    status: e.state as Bill["status"],
    amount: num(e.attributes.amount),
    baseAmount: num(e.attributes.base_amount ?? e.attributes.amount),
    lateFee: num(e.attributes.late_fee),
    dueDate: String(e.attributes.due_date ?? ""),
    categoryId: String(e.attributes.bill_category_id ?? ""),
    frequency: e.attributes.frequency as Bill["frequency"],
    billType: e.attributes.bill_type as Bill["billType"],
    month: String(e.attributes.month ?? ""),
    notes: String(e.attributes.notes ?? ""),
    deferredUntil: (e.attributes.deferred_until as string | null) ?? null,
    recurringParentId: (e.attributes.recurring_parent_id as string | null) ?? null,
    savingsPlan: asPlanEntries(e.attributes.savings_plan),
    proposedSavingsPlan: asPlanEntries(e.attributes.proposed_savings_plan),
    responsibility: ((e.attributes.responsibility as Record<string, number>) ?? {}),
    responsibleMemberId: (e.attributes.responsible_member_id as string) || null,
    payments: (Array.isArray(e.attributes.payments) ? e.attributes.payments : []).map(
      (raw: unknown): BillPayment => {
        const p = raw as Record<string, unknown>;
        return {
          id: String(p.id),
          date: String(p.date ?? ""),
          type: (p.type as BillPayment["type"]) ?? "normal",
          notes: String(p.notes ?? ""),
          total: num(p.total),
          contributions: (Array.isArray(p.contributions) ? p.contributions : []).map(
            (c: Record<string, unknown>) => ({
              memberId: String(c.member_id),
              amount: num(c.amount),
            })
          ),
          isLate: Boolean(p.is_late),
        };
      }
    ),
  }));

  const savingsEntity = summaryByKey.get("savings");
  const savingsBreakdownRaw = (savingsEntity?.attributes.breakdown as Record<
    string,
    { pct: number; amount: number }
  >) ?? {};
  const savings: Savings = {
    type: (savingsEntity?.attributes.savings_type as Savings["type"]) ?? "fixed_amount",
    value: num(savingsEntity?.attributes.savings_value),
    amount: num(savingsEntity?.state),
    goalAmount: num(savingsEntity?.attributes.savings_goal_amount),
    planContributions: num(savingsEntity?.attributes.savings_plan_contributions),
    perPeriod: num(savingsEntity?.attributes.savings_per_period),
    depositedMonth: num(savingsEntity?.attributes.savings_deposited_month),
    depositedPeriod: num(savingsEntity?.attributes.savings_deposited_period),
    breakdown: Object.entries(savingsBreakdownRaw).map(
      ([memberId, v]): SavingsBreakdownEntry => ({
        memberId,
        pct: num(v.pct),
        amount: num(v.amount),
      })
    ),
  };

  const cashInfusionsEntity = summaryByKey.get("cash_infusions");
  const cashInfusionsRaw = (cashInfusionsEntity?.attributes.infusions as unknown[]) ?? [];
  const cashInfusions: CashInfusion[] = cashInfusionsRaw.map((raw) => {
    const i = raw as Record<string, unknown>;
    const contributions = (Array.isArray(i.contributions) ? i.contributions : []).map(
      (c): CashInfusionContribution => ({
        memberId: String((c as Record<string, unknown>).member_id),
        amount: num((c as Record<string, unknown>).amount),
      })
    );
    return {
      id: String(i.id),
      date: String(i.date ?? ""),
      amount: num(i.amount),
      source: String(i.source ?? ""),
      contributions,
      repaymentBillId: (i.repayment_bill_id as string | null) ?? null,
    };
  });

  return {
    mode: (modeEntity?.state as FinanceState["mode"]) ?? "split",
    responsibilityMethod:
      (modeEntity?.attributes.responsibility_method as FinanceState["responsibilityMethod"]) ??
      "automatic",
    summary,
    members,
    categories,
    bills,
    savings,
    nextPayday: (upcomingEntity?.attributes.next_payday as string | null) ?? null,
    paydayAfterNext: (upcomingEntity?.attributes.payday_after_next as string | null) ?? null,
    nextPeriodBillsTotal: num(upcomingEntity?.attributes.next_period_bills_total),
    cashInfusions,
  };
}

function callFinanceService(
  hass: HomeAssistant,
  service: string,
  data: Record<string, unknown>
): Promise<unknown> {
  return hass.callService(DOMAIN, service, data);
}

export interface PayCycleFields {
  pay_frequency: string;
  pay_days?: number[];
  pay_anchor_date?: string;
}

export const financeApi = {
  addMember(
    hass: HomeAssistant,
    name: string,
    income: number,
    notes = "",
    payCycle?: PayCycleFields,
    haUserId?: string
  ) {
    return callFinanceService(hass, "add_member", {
      name,
      income,
      notes,
      ...payCycle,
      ...(haUserId ? { ha_user_id: haUserId } : {}),
    });
  },
  async listHaUsers(hass: HomeAssistant): Promise<HaUserSummary[]> {
    const users = await hass.callWS<Array<{ id: string; name: string; system_generated?: boolean }>>(
      { type: "config/auth/list" }
    );
    return users.filter((u) => !u.system_generated).map((u) => ({ id: u.id, name: u.name }));
  },
  editMember(hass: HomeAssistant, memberId: string, fields: Record<string, unknown>) {
    return callFinanceService(hass, "edit_member", { member_id: memberId, ...fields });
  },
  deleteMember(hass: HomeAssistant, memberId: string) {
    return callFinanceService(hass, "delete_member", { member_id: memberId });
  },
  updateIncome(hass: HomeAssistant, memberId: string, month: string, amount: number) {
    return callFinanceService(hass, "update_income", {
      member_id: memberId,
      month,
      amount,
    });
  },
  addIncomeSource(
    hass: HomeAssistant,
    memberId: string,
    name: string,
    amount: number,
    payCycle: PayCycleFields
  ) {
    return callFinanceService(hass, "add_income_source", {
      member_id: memberId,
      name,
      amount,
      ...payCycle,
    });
  },
  editIncomeSource(
    hass: HomeAssistant,
    memberId: string,
    sourceId: string,
    fields: { name?: string; amount?: number } & Partial<PayCycleFields>
  ) {
    return callFinanceService(hass, "edit_income_source", {
      member_id: memberId,
      source_id: sourceId,
      ...fields,
    });
  },
  deleteIncomeSource(hass: HomeAssistant, memberId: string, sourceId: string) {
    return callFinanceService(hass, "delete_income_source", {
      member_id: memberId,
      source_id: sourceId,
    });
  },
  addCategory(hass: HomeAssistant, name: string) {
    return callFinanceService(hass, "add_category", { name });
  },
  deleteCategory(hass: HomeAssistant, categoryId: string) {
    return callFinanceService(hass, "delete_category", { category_id: categoryId });
  },
  setCategoryBudget(hass: HomeAssistant, categoryId: string, plannedBudget: number) {
    return callFinanceService(hass, "set_category_budget", {
      category_id: categoryId,
      planned_budget: plannedBudget,
    });
  },
  addCategoryExpense(
    hass: HomeAssistant,
    categoryId: string,
    name: string,
    amount: number,
    expenseDate: string,
    notes = ""
  ) {
    return callFinanceService(hass, "add_category_expense", {
      category_id: categoryId,
      name,
      amount,
      expense_date: expenseDate,
      notes,
    });
  },
  editCategoryExpense(
    hass: HomeAssistant,
    expenseId: string,
    fields: { name?: string; amount?: number; date?: string; notes?: string }
  ) {
    return callFinanceService(hass, "edit_category_expense", {
      expense_id: expenseId,
      ...fields,
    });
  },
  deleteCategoryExpense(hass: HomeAssistant, expenseId: string) {
    return callFinanceService(hass, "delete_category_expense", { expense_id: expenseId });
  },
  addBill(
    hass: HomeAssistant,
    fields: {
      name: string;
      amount: number;
      category_id: string;
      due_date: string;
      frequency: string;
      bill_type: string;
      notes?: string;
      pay_to?: string;
      responsible_member_id?: string;
    }
  ) {
    return callFinanceService(hass, "add_bill", { notes: "", pay_to: "", ...fields });
  },
  editBill(hass: HomeAssistant, billId: string, fields: Record<string, unknown>) {
    return callFinanceService(hass, "edit_bill", { bill_id: billId, ...fields });
  },
  setBillLateFee(hass: HomeAssistant, billId: string, amount: number) {
    return callFinanceService(hass, "set_bill_late_fee", { bill_id: billId, amount });
  },
  deleteBill(hass: HomeAssistant, billId: string) {
    return callFinanceService(hass, "delete_bill", { bill_id: billId });
  },
  setSavingsPlan(hass: HomeAssistant, billId: string, entries: SavingsPlanEntry[]) {
    return callFinanceService(hass, "set_savings_plan", { bill_id: billId, entries });
  },
  markPaidNormal(hass: HomeAssistant, billId: string, paymentDate: string, notes = "") {
    return callFinanceService(hass, "mark_paid_normal", {
      bill_id: billId,
      payment_date: paymentDate,
      notes,
    });
  },
  markPaidIndividual(
    hass: HomeAssistant,
    billId: string,
    contributions: Contribution[],
    paymentDate: string,
    notes = ""
  ) {
    return callFinanceService(hass, "mark_paid_individual", {
      bill_id: billId,
      contributions,
      payment_date: paymentDate,
      notes,
    });
  },
  markPaidPartial(
    hass: HomeAssistant,
    billId: string,
    contributions: Contribution[],
    paymentDate: string,
    notes = ""
  ) {
    return callFinanceService(hass, "mark_paid_partial", {
      bill_id: billId,
      contributions,
      payment_date: paymentDate,
      notes,
    });
  },
  editPayment(
    hass: HomeAssistant,
    paymentId: string,
    fields: { payment_date?: string; notes?: string; contributions?: Contribution[] }
  ) {
    return callFinanceService(hass, "edit_payment", { payment_id: paymentId, ...fields });
  },
  deletePayment(hass: HomeAssistant, paymentId: string) {
    return callFinanceService(hass, "delete_payment", { payment_id: paymentId });
  },
  deferBill(
    hass: HomeAssistant,
    billId: string,
    deferredUntil: string,
    reason: string,
    notes = ""
  ) {
    return callFinanceService(hass, "defer_bill", {
      bill_id: billId,
      deferred_until: deferredUntil,
      reason,
      notes,
    });
  },
  triggerMonthlyRollover(hass: HomeAssistant) {
    return callFinanceService(hass, "trigger_monthly_rollover", {});
  },
  setMode(hass: HomeAssistant, mode: string) {
    return callFinanceService(hass, "set_mode", { mode });
  },
  setResponsibilityMethod(hass: HomeAssistant, method: string) {
    return callFinanceService(hass, "set_responsibility_method", {
      responsibility_method: method,
    });
  },
  setSavingsGoal(hass: HomeAssistant, savingsType: string, value: number) {
    return callFinanceService(hass, "set_savings_goal", { savings_type: savingsType, value });
  },
  addSavingsDeposit(hass: HomeAssistant, amount: number, depositDate: string, notes = "") {
    return callFinanceService(hass, "add_savings_deposit", {
      amount,
      deposit_date: depositDate,
      notes,
    });
  },
  addCashInfusion(
    hass: HomeAssistant,
    amount: number,
    infusionDate: string,
    source = "",
    contributions: Contribution[] = [],
    repaymentDueDate?: string,
    repaymentEntries?: SavingsPlanEntry[]
  ) {
    return callFinanceService(hass, "add_cash_infusion", {
      amount,
      infusion_date: infusionDate,
      source,
      contributions,
      ...(repaymentDueDate ? { repayment_due_date: repaymentDueDate } : {}),
      ...(repaymentEntries ? { repayment_entries: repaymentEntries } : {}),
    });
  },
  deleteCashInfusion(hass: HomeAssistant, infusionId: string) {
    return callFinanceService(hass, "delete_cash_infusion", { infusion_id: infusionId });
  },
};
