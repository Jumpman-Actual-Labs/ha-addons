// Enums mirrored from custom_components/hustle/const.py (StrEnum values).

export type MemberRole = "parent" | "child";
export type PermissionLevel = "admin" | "standard";
export type RecurrenceType =
  | "none"
  | "daily"
  | "weekly"
  | "custom_cron"
  | "biweekly"
  | "monthly"
  | "quarterly";
export type OverdueAction = "remove" | "convert_to_bounty" | "deduct";
export type ChoreAssignmentStatus = "assigned" | "submitted" | "approved" | "rejected";
export type SplitRule = "first_come" | "equal_split" | "parent_decides";
export type BountyStatus = "open" | "expired" | "cancelled" | "closed";
export type AcceptanceStatus = "accepted" | "submitted" | "completed" | "abandoned";
export type BehaviorCategory = "bonus" | "deduction";
export type PayrollRecurrence = "weekly" | "biweekly" | "monthly";
export type PayPeriodStatus = "open" | "generated" | "approved" | "paid";
export type PaycheckStatus = "draft" | "pending_approval" | "approved" | "paid";

// ------------------------------------------------------------------ members

export interface Member {
  entityId: string;
  memberId: string;
  pendingEarningsCents: number;
  lifetimeEarningsCents: number;
  potentialEarningsCents: number;
}

/** Full roster entry from the member roster sensor - includes deactivated
 * members so parents can review/reactivate them. */
export interface MemberRosterEntry {
  id: string;
  haDisplayName: string;
  role: MemberRole;
  permissionLevel: PermissionLevel | null;
  haUserId: string;
  active: boolean;
  avatarColor: string | null;
  dateOfBirth: string | null;
  /** Only meaningful when role === "parent". Empty = unrestricted (manages
   * every child in the household). */
  managedChildIds: string[];
  notifyTarget: string | null;
}

// --------------------------------------------------------------- household

export interface HouseholdInfo {
  name: string;
  currency: string;
  timezone: string;
  setupCompleted: boolean;
  notifyService: string | null;
}

export interface PayrollConfigInfo {
  recurrence: PayrollRecurrence;
  paydayRule: {
    type: string;
    dayOfWeek: string | null;
    anchorDate: string | null;
    dayOfMonth: number | null;
  };
  requiresParentApproval: boolean;
  approvalThresholdCents: number | null;
  autoGenerate: boolean;
  payParentsToo: boolean;
  defaultInitiativeBonusPct: number;
}

// ------------------------------------------------------------ grade catalog

export interface SubjectCatalogEntry {
  id: string;
  name: string;
  active: boolean;
}

export interface GradeScaleCatalogEntry {
  letter: string;
  valueCents: number;
  sortOrder: number;
}

// --------------------------------------------------------- behavior catalog

export interface BehaviorTypeCatalogEntry {
  id: string;
  label: string;
  category: BehaviorCategory;
  defaultAmountCents: number;
  icon: string | null;
  active: boolean;
}

// -------------------------------------------------------------------- reports

export interface EarningsByChildEntry {
  memberId: string;
  memberName: string;
  totalCents: number;
}

export interface EarningsByPayPeriodEntry {
  payPeriodId: string;
  startDate: string;
  endDate: string;
  paydayDate: string;
  totalGrossCents: number;
  totalNetCents: number;
}

export interface ChoreReportEntry {
  choreDefinitionId: string;
  title: string;
  completionCount: number;
  totalPaidCents: number;
}

export interface ReliabilityEntry {
  memberId: string;
  memberName: string;
  approvedCount: number;
  rejectedCount: number;
  totalCount: number;
  reliabilityPct: number;
}

export interface ReportsData {
  earningsByChild: EarningsByChildEntry[];
  earningsByPayPeriod: EarningsByPayPeriodEntry[];
  highestPayingChores: ChoreReportEntry[];
  mostCompletedChores: ChoreReportEntry[];
  reliability: ReliabilityEntry[];
}

// ------------------------------------------------------ recent bounties history

export interface RecentBountyHistoryEntry {
  id: string;
  title: string;
  status: BountyStatus;
  payoutCents: number;
  splitRule: SplitRule;
  updatedAt: string;
  acceptances: BountyAcceptance[];
}

// ---------------------------------------------------------- chore catalog

export interface ChoreDefinition {
  entityId: string;
  definitionId: string;
  title: string;
  description: string | null;
  payoutCents: number;
  category: string | null;
  recurrenceType: RecurrenceType;
  recurrenceConfig: { days_of_week?: string[]; anchor_date?: string; day_of_month?: number };
  isBounty: boolean;
  isRepeatable: boolean;
  isRotating: boolean;
  /** Who an auto-generated recurring occurrence gets assigned to. Ignored
   * when isRotating (the rotation picks one assignee itself) or isBounty
   * (bounties are posted open, not assigned). Empty means auto-generation
   * silently assigns nobody - a recurring chore with no default assignees
   * never actually produces new occurrences. */
  defaultAssigneeIds: string[];
  ageMin: number | null;
  ageMax: number | null;
  requiresApproval: boolean;
  prerequisiteIds: string[];
  dueTime: string | null;
  availableFromTime: string | null;
  availableUntilTime: string | null;
  overdueAction: OverdueAction | null;
  overdueDeductionCents: number | null;
  overdueBountyHours: number | null;
  overduePenaltyPct: number | null;
  imagePath: string | null;
  updatedAt: string;
}

export interface ChoreAssignment {
  entityId: string;
  assignmentId: string;
  choreDefinitionId: string;
  memberId: string;
  status: ChoreAssignmentStatus;
  dueDate: string;
  dueTime: string | null;
  availableFromTime: string | null;
  availableUntilTime: string | null;
  payoutCents: number;
  submittedAt: string | null;
}

// -------------------------------------------------------------- bounties

export interface BountyAcceptance {
  memberId: string;
  status: AcceptanceStatus;
  acceptedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  approvedByMemberId: string | null;
  payoutCents: number | null;
}

export interface Bounty {
  entityId: string;
  bountyId: string;
  title: string;
  status: BountyStatus;
  payoutCents: number;
  availableAt: string;
  deadlineAt: string;
  splitRule: SplitRule;
  requiresApproval: boolean;
  originalAssigneeMemberId: string | null;
  overduePenaltyPct: number | null;
  sourceChoreDefinitionId: string | null;
  isRepeatable: boolean;
  acceptances: BountyAcceptance[];
}

// ---------------------------------------------------------------- payroll

export interface PaycheckLineItem {
  earningSourceType: string;
  sourceRefId: string;
  description: string;
  amountCents: number;
  lineMetadata: Record<string, unknown>;
}

export interface PaycheckHistoryEntry {
  id: string;
  payPeriodId: string;
  grossCents: number;
  netCents: number;
  status: PaycheckStatus;
}

export interface MemberPaycheck {
  entityId: string;
  memberId: string;
  netCents: number | null;
  status: PaycheckStatus | null;
  grossCents: number | null;
  lineItems: PaycheckLineItem[];
  paycheckHistory: PaycheckHistoryEntry[];
}

export interface CurrentPeriod {
  id: string;
  startDate: string;
  endDate: string;
  paydayDate: string;
  status: PayPeriodStatus;
}

// ----------------------------------------------------------------- grades

export interface GradeEntry {
  id: string;
  subjectId: string;
  subjectName: string;
  gradeLetter: string;
  gradeValueCents: number;
  periodLabel: string;
  enteredAt: string;
}

export interface MemberGrades {
  entityId: string;
  memberId: string;
  gradeCount: number;
  recentGrades: GradeEntry[];
}

// -------------------------------------------------------------- behavior

export interface BehaviorEntry {
  id: string;
  behaviorTypeId: string;
  behaviorTypeLabel: string;
  amountCents: number;
  note: string | null;
  recordedAt: string;
}

export interface MemberBehavior {
  entityId: string;
  memberId: string;
  totalAmountCents: number;
  recentEntries: BehaviorEntry[];
}

// ----------------------------------------------------------------- misc

export interface ActivityEntry {
  id: string;
  eventType: string;
  title: string;
  message: string;
  memberId: string | null;
  amountCents: number | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface HustleState {
  // fixed/count sensors
  pendingPayrollCount: number;
  daysUntilPayday: number | null;
  activeChoresCount: number;
  activeBountiesCount: number;
  pendingApprovalCount: number;
  setupStatus: string | null;
  householdName: string | null;
  memberCount: number;
  recentActivity: ActivityEntry[];
  currentPeriod: CurrentPeriod | null;

  // full catalogs/rosters
  memberRoster: MemberRosterEntry[];
  household: HouseholdInfo | null;
  payrollConfig: PayrollConfigInfo | null;
  subjects: SubjectCatalogEntry[];
  gradeScale: GradeScaleCatalogEntry[];
  behaviorTypes: BehaviorTypeCatalogEntry[];
  reports: ReportsData | null;
  recentBountiesHistory: RecentBountyHistoryEntry[];

  // grouped/per-item entities
  members: Member[];
  choreDefinitions: ChoreDefinition[];
  choreAssignments: ChoreAssignment[];
  bounties: Bounty[];
  paychecks: MemberPaycheck[];
  grades: MemberGrades[];
  behavior: MemberBehavior[];
}
