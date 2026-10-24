import type {
  ActivityEntry,
  BehaviorTypeCatalogEntry,
  Bounty,
  BountyAcceptance,
  ChoreAssignment,
  ChoreDefinition,
  CurrentPeriod,
  GradeScaleCatalogEntry,
  HouseholdInfo,
  HustleState,
  Member,
  MemberBehavior,
  MemberGrades,
  MemberPaycheck,
  MemberRosterEntry,
  PaycheckHistoryEntry,
  PaycheckLineItem,
  PayrollConfigInfo,
  RecentBountyHistoryEntry,
  ReportsData,
  SubjectCatalogEntry,
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

export interface HassAuthData {
  access_token: string;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  user?: HassUser;
  auth?: { data?: HassAuthData };
  hassUrl?: (path?: string) => string;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>
  ): Promise<unknown>;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
}

const DOMAIN = "hustle";

function entitiesWith(hass: HomeAssistant, attr: string): HassEntity[] {
  return Object.values(hass.states).filter(
    (e) => e.entity_id.startsWith("sensor.") && attr in e.attributes
  );
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ------------------------------------------------------------- parsing

/** Scans hass.states for every sensor.* entity that carries the discovery
 * attributes documented in sensor.py, groups them, and builds a fully typed
 * HustleState - mirroring parseFinanceState()'s "scan and group by attribute
 * key" approach rather than guessing entity_ids from naming. */
export function parseHustleState(hass: HomeAssistant): HustleState {
  const fixedByKey = new Map<string, HassEntity>();
  for (const entity of entitiesWith(hass, "hustle_key")) {
    fixedByKey.set(String(entity.attributes.hustle_key), entity);
  }

  const daysUntilPaydayEntity = fixedByKey.get("days_until_payday");
  const setupStatusEntity = fixedByKey.get("setup_status");
  const recentActivityEntity = fixedByKey.get("recent_activity");
  const memberRosterEntity = fixedByKey.get("member_roster");
  const householdEntity = fixedByKey.get("household");
  const payrollConfigEntity = fixedByKey.get("payroll_config");
  const gradeCatalogEntity = fixedByKey.get("grade_catalog");
  const behaviorCatalogEntity = fixedByKey.get("behavior_catalog");
  const reportsEntity = fixedByKey.get("reports");
  const recentBountiesHistoryEntity = fixedByKey.get("recent_bounties_history");

  let currentPeriod: CurrentPeriod | null = null;
  if (daysUntilPaydayEntity && daysUntilPaydayEntity.attributes.current_period_id) {
    currentPeriod = {
      id: str(daysUntilPaydayEntity.attributes.current_period_id),
      startDate: str(daysUntilPaydayEntity.attributes.start_date),
      endDate: str(daysUntilPaydayEntity.attributes.end_date),
      paydayDate: str(daysUntilPaydayEntity.attributes.payday_date),
      status: (daysUntilPaydayEntity.attributes.status as CurrentPeriod["status"]) ?? "open",
    };
  }

  const recentActivity: ActivityEntry[] = asArray(recentActivityEntity?.attributes.entries).map(
    (raw): ActivityEntry => {
      const a = raw as Record<string, unknown>;
      return {
        id: str(a.id),
        eventType: str(a.event_type),
        title: str(a.title),
        message: str(a.message),
        memberId: strOrNull(a.member_id),
        amountCents: numOrNull(a.amount_cents),
        payload: (a.payload as Record<string, unknown>) ?? {},
        occurredAt: str(a.occurred_at),
      };
    }
  );

  // Per-member sensors: pending_earnings / lifetime_earnings share
  // `hustle_key` + `member_id`. Group by member_id, keyed off whichever of
  // the two shows up first.
  const pendingEarningsByMember = new Map<string, HassEntity>();
  const lifetimeEarningsByMember = new Map<string, HassEntity>();
  for (const entity of entitiesWith(hass, "member_id")) {
    const key = entity.attributes.hustle_key;
    const memberId = String(entity.attributes.member_id);
    if (key === "pending_earnings") pendingEarningsByMember.set(memberId, entity);
    else if (key === "lifetime_earnings") lifetimeEarningsByMember.set(memberId, entity);
  }
  const memberIds = new Set([
    ...pendingEarningsByMember.keys(),
    ...lifetimeEarningsByMember.keys(),
  ]);
  const members: Member[] = Array.from(memberIds).map((memberId) => {
    const pending = pendingEarningsByMember.get(memberId);
    const lifetime = lifetimeEarningsByMember.get(memberId);
    return {
      entityId: (pending ?? lifetime)!.entity_id,
      memberId,
      pendingEarningsCents: num(pending?.state),
      lifetimeEarningsCents: num(lifetime?.state),
      potentialEarningsCents: num(pending?.attributes.potential_cents),
    };
  });

  // Per-member paycheck sensors: distinguished by `line_items` +
  // `paycheck_history` attribute shape.
  const paychecks: MemberPaycheck[] = entitiesWith(hass, "line_items")
    .filter((e) => "paycheck_history" in e.attributes)
    .map((e): MemberPaycheck => {
      const lineItems: PaycheckLineItem[] = asArray(e.attributes.line_items).map((raw) => {
        const li = raw as Record<string, unknown>;
        return {
          earningSourceType: str(li.earning_source_type),
          sourceRefId: str(li.source_ref_id),
          description: str(li.description),
          amountCents: num(li.amount_cents),
          lineMetadata: (li.line_metadata as Record<string, unknown>) ?? {},
        };
      });
      const paycheckHistory: PaycheckHistoryEntry[] = asArray(e.attributes.paycheck_history).map(
        (raw) => {
          const p = raw as Record<string, unknown>;
          return {
            id: str(p.id),
            payPeriodId: str(p.pay_period_id),
            grossCents: num(p.gross_cents),
            netCents: num(p.net_cents),
            status: (p.status as PaycheckHistoryEntry["status"]) ?? "draft",
          };
        }
      );
      return {
        entityId: e.entity_id,
        memberId: str(e.attributes.member_id),
        netCents: e.state === "unknown" || e.state === "" ? null : numOrNull(e.state),
        status: strOrNull(e.attributes.status) as MemberPaycheck["status"],
        grossCents: numOrNull(e.attributes.gross_cents),
        lineItems,
        paycheckHistory,
      };
    });

  // Per-member grades sensors: distinguished by `recent_grades` attribute.
  const grades: MemberGrades[] = entitiesWith(hass, "recent_grades").map((e): MemberGrades => {
    const recentGrades = asArray(e.attributes.recent_grades).map((raw) => {
      const g = raw as Record<string, unknown>;
      return {
        id: str(g.id),
        subjectId: str(g.subject_id),
        subjectName: str(g.subject_name),
        gradeLetter: str(g.grade_letter),
        gradeValueCents: num(g.grade_value_cents),
        periodLabel: str(g.period_label),
        enteredAt: str(g.entered_at),
      };
    });
    return {
      entityId: e.entity_id,
      memberId: str(e.attributes.member_id),
      gradeCount: num(e.state),
      recentGrades,
    };
  });

  // Per-member behavior sensors: distinguished by `recent_entries` attribute.
  const behavior: MemberBehavior[] = entitiesWith(hass, "recent_entries").map(
    (e): MemberBehavior => {
      const recentEntries = asArray(e.attributes.recent_entries).map((raw) => {
        const b = raw as Record<string, unknown>;
        return {
          id: str(b.id),
          behaviorTypeId: str(b.behavior_type_id),
          behaviorTypeLabel: str(b.behavior_type_label),
          amountCents: num(b.amount_cents),
          note: strOrNull(b.note),
          recordedAt: str(b.recorded_at),
        };
      });
      return {
        entityId: e.entity_id,
        memberId: str(e.attributes.member_id),
        totalAmountCents: num(e.state),
        recentEntries,
      };
    }
  );

  // Dynamic per-item sensors.
  const choreDefinitions: ChoreDefinition[] = entitiesWith(hass, "chore_definition_id")
    .filter((e) => !("chore_assignment_id" in e.attributes))
    .map((e): ChoreDefinition => ({
      entityId: e.entity_id,
      definitionId: str(e.attributes.chore_definition_id),
      title: str(e.attributes.title),
      description: strOrNull(e.attributes.description),
      payoutCents: num(e.state),
      category: strOrNull(e.attributes.category),
      recurrenceType: (e.attributes.recurrence_type as ChoreDefinition["recurrenceType"]) ?? "none",
      recurrenceConfig: (e.attributes.recurrence_config as ChoreDefinition["recurrenceConfig"]) ?? {},
      isBounty: Boolean(e.attributes.is_bounty),
      isRepeatable: Boolean(e.attributes.is_repeatable),
      isRotating: Boolean(e.attributes.is_rotating),
      defaultAssigneeIds: Array.isArray(e.attributes.default_assignee_ids)
        ? (e.attributes.default_assignee_ids as string[])
        : [],
      ageMin: numOrNull(e.attributes.age_min),
      ageMax: numOrNull(e.attributes.age_max),
      requiresApproval: Boolean(e.attributes.requires_approval),
      prerequisiteIds: Array.isArray(e.attributes.prerequisite_ids)
        ? (e.attributes.prerequisite_ids as string[])
        : [],
      dueTime: strOrNull(e.attributes.due_time),
      availableFromTime: strOrNull(e.attributes.available_from_time),
      availableUntilTime: strOrNull(e.attributes.available_until_time),
      overdueAction: (e.attributes.overdue_action as ChoreDefinition["overdueAction"]) ?? null,
      overdueDeductionCents: numOrNull(e.attributes.overdue_deduction_cents),
      overdueBountyHours: numOrNull(e.attributes.overdue_bounty_hours),
      overduePenaltyPct: numOrNull(e.attributes.overdue_penalty_pct),
      imagePath: strOrNull(e.attributes.image_path),
      updatedAt: str(e.attributes.updated_at),
    }));

  // Prefer the member's authoritative snapshot. Dynamic sensors remain a
  // fallback for older backends, never a source of stale duplicate records.
  const snapshotMembers = new Set<string>();
  const snapshotAssignments: ChoreAssignment[] = [];
  for (const [memberId, entity] of pendingEarningsByMember) {
    if (!Array.isArray(entity.attributes.assignments)) continue;
    snapshotMembers.add(memberId);
    for (const raw of entity.attributes.assignments) {
      const a = raw as Record<string, unknown>;
      if (str(a.member_id) !== memberId || !a.id) continue;
      snapshotAssignments.push({
        entityId: entity.entity_id,
        assignmentId: str(a.id),
        choreDefinitionId: str(a.chore_definition_id),
        memberId,
        status: str(a.status) as ChoreAssignment["status"],
        dueDate: str(a.due_date),
        dueTime: strOrNull(a.due_time),
        availableFromTime: strOrNull(a.available_from_time),
        availableUntilTime: strOrNull(a.available_until_time),
        payoutCents: num(a.payout_cents),
        submittedAt: strOrNull(a.submitted_at),
      });
    }
  }
  const choreAssignments: ChoreAssignment[] = snapshotAssignments.concat(entitiesWith(hass, "chore_assignment_id")
    .filter(e => !snapshotMembers.has(str(e.attributes.member_id)))
    .map(
    (e): ChoreAssignment => ({
      entityId: e.entity_id,
      assignmentId: str(e.attributes.chore_assignment_id),
      choreDefinitionId: str(e.attributes.chore_definition_id),
      memberId: str(e.attributes.member_id),
      status: (e.state as ChoreAssignment["status"]) ?? "assigned",
      dueDate: str(e.attributes.due_date),
      dueTime: strOrNull(e.attributes.due_time),
      availableFromTime: strOrNull(e.attributes.available_from_time),
      availableUntilTime: strOrNull(e.attributes.available_until_time),
      payoutCents: num(e.attributes.payout_cents),
      submittedAt: strOrNull(e.attributes.submitted_at),
    })
  ));

  const bounties: Bounty[] = entitiesWith(hass, "bounty_id").map((e): Bounty => {
    const acceptances: BountyAcceptance[] = asArray(e.attributes.acceptances).map((raw) => {
      const a = raw as Record<string, unknown>;
      return {
        memberId: str(a.member_id),
        status: (a.status as BountyAcceptance["status"]) ?? "accepted",
        acceptedAt: str(a.accepted_at),
        submittedAt: strOrNull(a.submitted_at),
        completedAt: strOrNull(a.completed_at),
        approvedByMemberId: strOrNull(a.approved_by_member_id),
        payoutCents: numOrNull(a.payout_cents),
      };
    });
    return {
      entityId: e.entity_id,
      bountyId: str(e.attributes.bounty_id),
      title: str(e.attributes.title),
      status: (e.attributes.status as Bounty["status"]) ?? "open",
      payoutCents: num(e.state),
      availableAt: str(e.attributes.available_at),
      deadlineAt: str(e.attributes.deadline_at),
      splitRule: (e.attributes.split_rule as Bounty["splitRule"]) ?? "first_come",
      requiresApproval: Boolean(e.attributes.requires_approval),
      originalAssigneeMemberId: strOrNull(e.attributes.original_assignee_member_id),
      overduePenaltyPct: numOrNull(e.attributes.overdue_penalty_pct),
      sourceChoreDefinitionId: strOrNull(e.attributes.source_chore_definition_id),
      isRepeatable: Boolean(e.attributes.is_repeatable),
      acceptances,
    };
  });

  // Member roster sensor: full roster including deactivated members.
  const memberRoster: MemberRosterEntry[] = asArray(memberRosterEntity?.attributes.members).map(
    (raw): MemberRosterEntry => {
      const m = raw as Record<string, unknown>;
      return {
        id: str(m.id),
        haDisplayName: str(m.ha_display_name),
        role: (m.role as MemberRosterEntry["role"]) ?? "child",
        permissionLevel: (m.permission_level as MemberRosterEntry["permissionLevel"]) ?? null,
        haUserId: str(m.ha_user_id),
        active: Boolean(m.active),
        avatarColor: strOrNull(m.avatar_color),
        dateOfBirth: strOrNull(m.date_of_birth),
        managedChildIds: Array.isArray(m.managed_child_ids) ? (m.managed_child_ids as string[]) : [],
        notifyTarget: strOrNull(m.notify_target),
      };
    }
  );

  // Household sensor.
  const household: HouseholdInfo | null = householdEntity
    ? {
        name: str(householdEntity.attributes.name),
        currency: str(householdEntity.attributes.currency, "USD"),
        timezone: str(householdEntity.attributes.timezone, "UTC"),
        setupCompleted: Boolean(householdEntity.attributes.setup_completed),
        notifyService: strOrNull(householdEntity.attributes.notify_service),
      }
    : null;

  // Payroll config sensor.
  const payrollConfig: PayrollConfigInfo | null = payrollConfigEntity
    ? {
        recurrence: (payrollConfigEntity.attributes.recurrence as PayrollConfigInfo["recurrence"]) ?? "weekly",
        paydayRule: {
          type: str((payrollConfigEntity.attributes.payday_rule as Record<string, unknown> | undefined)?.type),
          dayOfWeek: strOrNull(
            (payrollConfigEntity.attributes.payday_rule as Record<string, unknown> | undefined)?.day_of_week
          ),
          anchorDate: strOrNull(
            (payrollConfigEntity.attributes.payday_rule as Record<string, unknown> | undefined)?.anchor_date
          ),
          dayOfMonth: numOrNull(
            (payrollConfigEntity.attributes.payday_rule as Record<string, unknown> | undefined)?.day_of_month
          ),
        },
        requiresParentApproval: Boolean(payrollConfigEntity.attributes.requires_parent_approval),
        approvalThresholdCents: numOrNull(payrollConfigEntity.attributes.approval_threshold_cents),
        autoGenerate: Boolean(payrollConfigEntity.attributes.auto_generate),
        payParentsToo: Boolean(payrollConfigEntity.attributes.pay_parents_too),
        defaultInitiativeBonusPct: num(payrollConfigEntity.attributes.default_initiative_bonus_pct),
      }
    : null;

  // Grade catalog sensor: subjects + grade scale.
  const subjects: SubjectCatalogEntry[] = asArray(gradeCatalogEntity?.attributes.subjects).map((raw) => {
    const sub = raw as Record<string, unknown>;
    return { id: str(sub.id), name: str(sub.name), active: Boolean(sub.active) };
  });
  const gradeScale: GradeScaleCatalogEntry[] = asArray(gradeCatalogEntity?.attributes.grade_scale).map(
    (raw) => {
      const g = raw as Record<string, unknown>;
      return { letter: str(g.letter), valueCents: num(g.value_cents), sortOrder: num(g.sort_order) };
    }
  );

  // Behavior catalog sensor.
  const behaviorTypes: BehaviorTypeCatalogEntry[] = asArray(
    behaviorCatalogEntity?.attributes.behavior_types
  ).map((raw) => {
    const t = raw as Record<string, unknown>;
    return {
      id: str(t.id),
      label: str(t.label),
      category: (t.category as BehaviorTypeCatalogEntry["category"]) ?? "bonus",
      defaultAmountCents: num(t.default_amount_cents),
      icon: strOrNull(t.icon),
      active: Boolean(t.active),
    };
  });

  // Reports sensor.
  const reports: ReportsData | null = reportsEntity
    ? {
        earningsByChild: asArray(reportsEntity.attributes.earnings_by_child).map((raw) => {
          const e = raw as Record<string, unknown>;
          return { memberId: str(e.member_id), memberName: str(e.member_name), totalCents: num(e.total_cents) };
        }),
        earningsByPayPeriod: asArray(reportsEntity.attributes.earnings_by_pay_period).map((raw) => {
          const e = raw as Record<string, unknown>;
          return {
            payPeriodId: str(e.pay_period_id),
            startDate: str(e.start_date),
            endDate: str(e.end_date),
            paydayDate: str(e.payday_date),
            totalGrossCents: num(e.total_gross_cents),
            totalNetCents: num(e.total_net_cents),
          };
        }),
        highestPayingChores: asArray(reportsEntity.attributes.highest_paying_chores).map((raw) => {
          const c = raw as Record<string, unknown>;
          return {
            choreDefinitionId: str(c.chore_definition_id),
            title: str(c.title),
            completionCount: num(c.completion_count),
            totalPaidCents: num(c.total_paid_cents),
          };
        }),
        mostCompletedChores: asArray(reportsEntity.attributes.most_completed_chores).map((raw) => {
          const c = raw as Record<string, unknown>;
          return {
            choreDefinitionId: str(c.chore_definition_id),
            title: str(c.title),
            completionCount: num(c.completion_count),
            totalPaidCents: num(c.total_paid_cents),
          };
        }),
        reliability: asArray(reportsEntity.attributes.reliability).map((raw) => {
          const r = raw as Record<string, unknown>;
          return {
            memberId: str(r.member_id),
            memberName: str(r.member_name),
            approvedCount: num(r.approved_count),
            rejectedCount: num(r.rejected_count),
            totalCount: num(r.total_count),
            reliabilityPct: num(r.reliability_pct),
          };
        }),
      }
    : null;

  // Recent bounties history sensor: bounded closed/cancelled/expired bounties.
  const recentBountiesHistory: RecentBountyHistoryEntry[] = asArray(
    recentBountiesHistoryEntity?.attributes.bounties
  ).map((raw) => {
    const b = raw as Record<string, unknown>;
    const acceptances: BountyAcceptance[] = asArray(b.acceptances).map((rawA) => {
      const a = rawA as Record<string, unknown>;
      return {
        memberId: str(a.member_id),
        status: (a.status as BountyAcceptance["status"]) ?? "accepted",
        acceptedAt: str(a.accepted_at),
        submittedAt: strOrNull(a.submitted_at),
        completedAt: strOrNull(a.completed_at),
        approvedByMemberId: strOrNull(a.approved_by_member_id),
        payoutCents: numOrNull(a.payout_cents),
      };
    });
    return {
      id: str(b.id),
      title: str(b.title),
      status: (b.status as RecentBountyHistoryEntry["status"]) ?? "closed",
      payoutCents: num(b.payout_cents),
      splitRule: (b.split_rule as RecentBountyHistoryEntry["splitRule"]) ?? "first_come",
      updatedAt: str(b.updated_at),
      acceptances,
    };
  });

  return {
    pendingPayrollCount: num(fixedByKey.get("pending_payroll_count")?.state),
    daysUntilPayday: numOrNull(daysUntilPaydayEntity?.state),
    activeChoresCount: num(fixedByKey.get("active_chores_count")?.state),
    activeBountiesCount: num(fixedByKey.get("active_bounties_count")?.state),
    pendingApprovalCount: num(fixedByKey.get("pending_approval_count")?.state),
    setupStatus: strOrNull(setupStatusEntity?.state),
    householdName: strOrNull(setupStatusEntity?.attributes.household_name),
    memberCount: num(setupStatusEntity?.attributes.member_count),
    recentActivity,
    currentPeriod,
    memberRoster,
    household,
    payrollConfig,
    subjects,
    gradeScale,
    behaviorTypes,
    reports,
    recentBountiesHistory,
    members,
    choreDefinitions,
    choreAssignments,
    bounties,
    paychecks,
    grades,
    behavior,
  };
}

// -------------------------------------------------------------- services

/** Home Assistant's voluptuous service schemas use `vol.Optional(field)` to
 * mean "may be omitted", not "may be null" - a present key with a `null`/
 * `undefined` value still gets type-checked and fails (e.g. `cv.string`
 * rejects `None`). Views build payloads with `value || null` for blank
 * inputs, so strip those here rather than at every call site. */
function callHustleService(
  hass: HomeAssistant,
  service: string,
  data: Record<string, unknown>
): Promise<unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) cleaned[key] = value;
  }
  return hass.callService(DOMAIN, service, cleaned);
}

export const hustleApi = {
  // -------------------------------------------------------------- members
  addMember(
    hass: HomeAssistant,
    fields: {
      ha_user_id: string;
      ha_display_name: string;
      role: string;
      permission_level?: string;
      date_of_birth?: string;
      avatar_color?: string;
      managed_child_ids?: string[];
      notify_target?: string;
    }
  ) {
    return callHustleService(hass, "add_member", fields);
  },
  async listHaUsers(
    hass: HomeAssistant
  ): Promise<Array<{ id: string; name: string }>> {
    const users = await hass.callWS<
      Array<{ id: string; name: string; system_generated?: boolean }>
    >({ type: "config/auth/list" });
    return users.filter((u) => !u.system_generated).map((u) => ({ id: u.id, name: u.name }));
  },
  updateMember(hass: HomeAssistant, memberId: string, fields: Record<string, unknown>) {
    return callHustleService(hass, "update_member", { member_id: memberId, ...fields });
  },
  deactivateMember(hass: HomeAssistant, memberId: string) {
    return callHustleService(hass, "deactivate_member", { member_id: memberId });
  },

  // --------------------------------------------------------------- chores
  addChoreDefinition(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callHustleService(hass, "add_chore_definition", fields);
  },
  updateChoreDefinition(hass: HomeAssistant, definitionId: string, fields: Record<string, unknown>) {
    return callHustleService(hass, "update_chore_definition", {
      definition_id: definitionId,
      ...fields,
    });
  },
  regenerateChoreImage(hass: HomeAssistant, definitionId: string) {
    return callHustleService(hass, "regenerate_chore_image", { definition_id: definitionId });
  },
  assignChore(hass: HomeAssistant, definitionId: string, memberIds: string[], dueDate: string) {
    return callHustleService(hass, "assign_chore", {
      definition_id: definitionId,
      member_ids: memberIds,
      due_date: dueDate,
    });
  },
  submitChore(hass: HomeAssistant, assignmentId: string) {
    return callHustleService(hass, "submit_chore", { assignment_id: assignmentId });
  },
  approveChore(hass: HomeAssistant, assignmentId: string) {
    return callHustleService(hass, "approve_chore", { assignment_id: assignmentId });
  },
  rejectChore(hass: HomeAssistant, assignmentId: string, reason: string) {
    return callHustleService(hass, "reject_chore", { assignment_id: assignmentId, reason });
  },
  generateDueChoreOccurrences(hass: HomeAssistant) {
    return callHustleService(hass, "generate_due_chore_occurrences", {});
  },
  unassignAllChores(hass: HomeAssistant) {
    return callHustleService(hass, "unassign_all_chores", {});
  },

  // ------------------------------------------------------------- bounties
  addBounty(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callHustleService(hass, "add_bounty", fields);
  },
  addBountyFromChore(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callHustleService(hass, "add_bounty_from_chore", fields);
  },
  updateBounty(hass: HomeAssistant, bountyId: string, fields: Record<string, unknown>) {
    return callHustleService(hass, "update_bounty", { bounty_id: bountyId, ...fields });
  },
  cancelBounty(hass: HomeAssistant, bountyId: string) {
    return callHustleService(hass, "cancel_bounty", { bounty_id: bountyId });
  },
  closeBounty(hass: HomeAssistant, bountyId: string) {
    return callHustleService(hass, "close_bounty", { bounty_id: bountyId });
  },
  acceptBounty(hass: HomeAssistant, bountyId: string) {
    return callHustleService(hass, "accept_bounty", { bounty_id: bountyId });
  },
  submitBountyAcceptance(hass: HomeAssistant, bountyId: string, memberId: string) {
    return callHustleService(hass, "submit_bounty_acceptance", {
      bounty_id: bountyId,
      member_id: memberId,
    });
  },
  convertAssignmentToBounty(
    hass: HomeAssistant,
    assignmentId: string,
    fields: {
      available_at: string;
      deadline_at: string;
      initiative_bonus_pct?: number;
      split_rule?: string;
    }
  ) {
    return callHustleService(hass, "convert_assignment_to_bounty", {
      assignment_id: assignmentId,
      ...fields,
    });
  },
  completeBountyAcceptance(hass: HomeAssistant, bountyId: string, memberId: string) {
    return callHustleService(hass, "complete_bounty_acceptance", {
      bounty_id: bountyId,
      member_id: memberId,
    });
  },
  finalizeBountySplit(hass: HomeAssistant, bountyId: string, allocations: Record<string, number>) {
    return callHustleService(hass, "finalize_bounty_split", { bounty_id: bountyId, allocations });
  },
  expireStaleBounties(hass: HomeAssistant) {
    return callHustleService(hass, "expire_stale_bounties", {});
  },
  removeAllBounties(hass: HomeAssistant) {
    return callHustleService(hass, "remove_all_bounties", {});
  },

  // -------------------------------------------------------------- grades
  addSubject(hass: HomeAssistant, name: string) {
    return callHustleService(hass, "add_subject", { name });
  },
  updateSubject(hass: HomeAssistant, subjectId: string, fields: Record<string, unknown>) {
    return callHustleService(hass, "update_subject", { subject_id: subjectId, ...fields });
  },
  updateGradeScale(hass: HomeAssistant, entries: Array<{ letter: string; value_cents: number; sort_order?: number }>) {
    return callHustleService(hass, "update_grade_scale", { entries });
  },
  recordGrade(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callHustleService(hass, "record_grade", fields);
  },
  updateGradeEntry(hass: HomeAssistant, entryId: string, fields: Record<string, unknown>) {
    return callHustleService(hass, "update_grade_entry", { entry_id: entryId, ...fields });
  },
  deleteGradeEntry(hass: HomeAssistant, entryId: string) {
    return callHustleService(hass, "delete_grade_entry", { entry_id: entryId });
  },

  // ------------------------------------------------------------ behavior
  addBehaviorType(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callHustleService(hass, "add_behavior_type", fields);
  },
  updateBehaviorType(hass: HomeAssistant, typeId: string, fields: Record<string, unknown>) {
    return callHustleService(hass, "update_behavior_type", { type_id: typeId, ...fields });
  },
  recordBehaviorEntry(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callHustleService(hass, "record_behavior_entry", fields);
  },
  deleteBehaviorEntry(hass: HomeAssistant, entryId: string) {
    return callHustleService(hass, "delete_behavior_entry", { entry_id: entryId });
  },

  // ------------------------------------------------------------- payroll
  getOrCreateCurrentPeriod(hass: HomeAssistant) {
    return callHustleService(hass, "get_or_create_current_period", {});
  },
  generatePayPeriod(hass: HomeAssistant, periodId: string, regenerate = false) {
    return callHustleService(hass, "generate_pay_period", { period_id: periodId, regenerate });
  },
  approvePaycheck(hass: HomeAssistant, paycheckId: string) {
    return callHustleService(hass, "approve_paycheck", { paycheck_id: paycheckId });
  },
  markPaycheckPaid(hass: HomeAssistant, paycheckId: string) {
    return callHustleService(hass, "mark_paycheck_paid", { paycheck_id: paycheckId });
  },
  resetAccountEarnings(hass: HomeAssistant) {
    return callHustleService(hass, "reset_account_earnings", { confirm: true });
  },

  resetCurrentPeriodPaychecks(hass: HomeAssistant) {
    return callHustleService(hass, "reset_current_period_paychecks", {});
  },

  // ------------------------------------------------------------ household
  updateHousehold(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callHustleService(hass, "update_household", fields);
  },
  updatePayrollConfig(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callHustleService(hass, "update_payroll_config", fields);
  },
};

