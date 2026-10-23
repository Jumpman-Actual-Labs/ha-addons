export type FinanceMode = "split" | "shared";
export type ResponsibilityMethod = "automatic" | "manual";
export type Frequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "yearly"
  | "one_time";
export type BillType = "fixed" | "variable" | "debt" | "subscription" | "installment";
export type BillStatus = "unpaid" | "partially_paid" | "paid" | "deferred" | "overdue";
export type PayFrequency = "weekly" | "biweekly" | "semi_monthly" | "monthly";
export type SavingsType = "percent_of_income" | "percent_of_remaining" | "fixed_amount";

export interface IncomeSource {
  id: string;
  name: string;
  amount: number;
  payFrequency: PayFrequency;
  payDays: number[];
  payAnchorDate: string | null;
  nextPayDate: string | null;
}

export interface Member {
  entityId: string;
  memberId: string;
  name: string;
  notes: string;
  income: number;
  incomeSources: IncomeSource[];
  responsibilityPct: number;
  budgetResponsibleAmount: number;
  budgetResponsibleAmountExcludingRepayments: number;
  responsibleAmount: number;
  responsibleAmountExcludingRepayments: number;
  actuallyPaid: number;
  settlementBalance: number;
  payFrequency: PayFrequency;
  payDays: number[];
  payAnchorDate: string | null;
  nextPayDate: string | null;
  haUserId: string | null;
}

export interface CategoryExpense {
  id: string;
  name: string;
  amount: number;
  date: string;
  notes: string;
}

export type BudgetRecommendation = "raise" | "lower" | "maintain";

export interface Category {
  entityId: string;
  categoryId: string;
  name: string;
  total: number;
  plannedBudget: number;
  budgetRecommendation: BudgetRecommendation;
  historicalAverageSpend: number;
  lastMonthSpend: number;
  expenses: CategoryExpense[];
}

export interface SavingsPlanEntry {
  month: string;
  amount: number;
}

export type PaymentType = "normal" | "individual" | "partial";

export interface BillPaymentContribution {
  memberId: string;
  amount: number;
}

export interface BillPayment {
  id: string;
  date: string;
  type: PaymentType;
  notes: string;
  total: number;
  contributions: BillPaymentContribution[];
  isLate: boolean;
}

export interface Bill {
  responsibleMemberId: string | null;
  entityId: string;
  billId: string;
  baseAmount: number;
  lateFee: number;
  name: string;
  payTo: string;
  status: BillStatus;
  amount: number;
  dueDate: string;
  categoryId: string;
  frequency: Frequency;
  billType: BillType;
  month: string;
  notes: string;
  deferredUntil: string | null;
  recurringParentId: string | null;
  savingsPlan: SavingsPlanEntry[];
  proposedSavingsPlan: SavingsPlanEntry[];
  responsibility: Record<string, number>;
  payments: BillPayment[];
}

export interface Summary {
  totalIncome: number;
  totalBills: number;
  paid: number;
  remaining: number;
  cashRemaining: number;
  upcomingThisPayPeriod: number;
  overdue: number;
  deferred: number;
}

export interface SavingsBreakdownEntry {
  memberId: string;
  pct: number;
  amount: number;
}

export interface Savings {
  type: SavingsType;
  value: number;
  amount: number;
  goalAmount: number;
  planContributions: number;
  perPeriod: number;
  depositedMonth: number;
  depositedPeriod: number;
  breakdown: SavingsBreakdownEntry[];
}

export interface CashInfusionContribution {
  memberId: string;
  amount: number;
}

export interface CashInfusion {
  id: string;
  date: string;
  amount: number;
  source: string;
  contributions: CashInfusionContribution[];
  repaymentBillId: string | null;
}

export interface FinanceState {
  mode: FinanceMode;
  responsibilityMethod: ResponsibilityMethod;
  summary: Summary;
  members: Member[];
  categories: Category[];
  bills: Bill[];
  savings: Savings;
  nextPayday: string | null;
  paydayAfterNext: string | null;
  nextPeriodBillsTotal: number;
  cashInfusions: CashInfusion[];
}

export interface Contribution {
  member_id: string;
  amount: number;
}
