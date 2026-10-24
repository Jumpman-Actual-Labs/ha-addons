import { parseInventoryPolicy } from "./inventory-policy";
import { parseMuscleRecovery } from "./recovery";
import { parseJointSession } from "./joint-session";
import type {
  TrainingSnapshot,
  TrainingBuildRequest,
  TrainingPayload,
  TrainingProposal,
  GeoffreyAction,
  ProgressState,
  RunSegment,
} from "./training-types";
import type {
  ActivityLevel,
  AICoachMessage,
  AthleteProfile,
  Effort,
  ExperienceLevel,
  GainsState,
  GymProfile,
  IncomingShare,
  LinkedProfileSummary,
  ProposedRun,
  ProposedWorkout,
  Run,
  RunStatus,
  RunType,
  ShareKind,
  Units,
  Workout,
  WorkoutExercise,
  WorkoutSet,
  WorkoutStatus,
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

export interface HassEntityRegistryEntry {
  platform: string;
}

export interface HomeAssistant {
  callWS?<T>(message: Record<string, unknown>): Promise<T>;
  themes?: { darkMode?: boolean };
  states: Record<string, HassEntity>;
  entities?: Record<string, HassEntityRegistryEntry>;
  user?: HassUser;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
  ): Promise<unknown>;
}

const DOMAIN = "gains";

function str(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value: unknown): boolean {
  return Boolean(value);
}

function recordOfEquipmentConfig(
  value: unknown,
): Record<string, import("./types").EquipmentConfig> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, import("./types").EquipmentConfig> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const config = raw as Record<string, unknown>;
    const loadType =
      config.load_type === "plate_loaded" || config.load_type === "weight_stack"
        ? config.load_type
        : undefined;
    result[key] = {
      loadType,
      pulleyRatio: numOrNull(config.pulley_ratio) ?? undefined,
      stackMax: numOrNull(config.stack_max),
      stackIncrement: numOrNull(config.stack_increment),
      stackMin: numOrNull(config.stack_min),
      baseWeight: numOrNull(config.base_weight),
      loadingPoints: numOrNull(config.loading_points),
    };
  }
  return result;
}

function recordOfNumbers(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n)) result[key] = n;
  }
  return result;
}

/** Equipment is keyed by equipment_id -> a list of weights, one per
 * physical unit owned of that item (e.g. two Short Bars at different
 * weights) -- null in the list is meaningful (that unit is checked but
 * has no custom weight, use the catalog default), so it's kept rather
 * than dropped. A key whose list ends up empty is dropped entirely. */
function recordOfOptionalNumberLists(
  value: unknown,
): Record<string, (number | null)[]> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, (number | null)[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const weights: (number | null)[] = [];
    for (const item of raw) {
      if (item === null) {
        weights.push(null);
        continue;
      }
      const n = Number(item);
      if (Number.isFinite(n)) weights.push(n);
    }
    if (weights.length > 0) result[key] = weights;
  }
  return result;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
  );
}

function parseWorkoutSet(raw: Record<string, unknown>): WorkoutSet {
  return {
    recordedByProfileId: strOrNull(raw.recorded_by_profile_id),
    plannedReps: numOrNull(raw.planned_reps),
    plannedWeight: numOrNull(raw.planned_weight),
    manualWeight: raw.manual_weight === true,
    actualReps: numOrNull(raw.actual_reps),
    actualWeight: numOrNull(raw.actual_weight),
    completed: bool(raw.completed),
    isPersonalRecord: bool(raw.is_personal_record),
    personalRecordValue: numOrNull(raw.personal_record_value),
    previousPersonalRecord: numOrNull(raw.previous_personal_record),
  };
}

function parseWorkoutExercise(raw: Record<string, unknown>): WorkoutExercise {
  return {
    exerciseId: str(raw.exercise_id),
    sets: asRecords(raw.sets).map(parseWorkoutSet),
    notes: str(raw.notes),
    effort: strOrNull(raw.effort) as Effort | null,
    selectedBarEquipmentId: strOrNull(raw.selected_bar_equipment_id),
    selectedBarWeight: numOrNull(raw.selected_bar_weight),
    restSeconds: numOrNull(raw.rest_seconds),
  };
}

function parseRun(raw: Record<string, unknown>): Run {
  return {
    id: str(raw.id),
    profileId: str(raw.profile_id),
    name: str(raw.name, "Run"),
    segments: asRecords(raw.segments) as unknown as RunSegment[],
    runType: (str(raw.run_type, "easy") || "easy") as RunType,
    status: (str(raw.status, "planned") || "planned") as RunStatus,
    targetDistance: numOrNull(raw.target_distance),
    targetDurationMinutes: numOrNull(raw.target_duration_minutes),
    actualDistance: numOrNull(raw.actual_distance),
    actualDurationMinutes: numOrNull(raw.actual_duration_minutes),
    notes: str(raw.notes),
    createdAt: str(raw.created_at),
    completedAt: strOrNull(raw.completed_at),
  };
}

function parseWorkout(raw: Record<string, unknown>): Workout {
  return {
    jointSession: parseJointSession(raw.joint_session),
    id: str(raw.id),
    profileId: str(raw.profile_id),
    name: str(raw.name, "Workout"),
    status: (str(raw.status, "planned") || "planned") as WorkoutStatus,
    currentExerciseIndex: numOrNull(raw.current_exercise_index) ?? 0,
    currentSetIndex: numOrNull(raw.current_set_index) ?? 0,
    revision: numOrNull(raw.revision) ?? 0,
    exercises: asRecords(raw.exercises).map(parseWorkoutExercise),
    notes: str(raw.notes),
    createdAt: str(raw.created_at),
    startedAt: strOrNull(raw.started_at),
    completedAt: strOrNull(raw.completed_at),
  };
}

function parseProposedWorkout(raw: unknown): ProposedWorkout | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    name: str(record.name, "AI-Suggested Workout"),
    exercises: asRecords(record.exercises).map((exercise) => ({
      exerciseId: str(exercise.exercise_id),
      sets: asRecords(exercise.sets).map((s) => ({
        reps: numOrNull(s.reps),
        weight: numOrNull(s.weight),
      })),
    })),
  };
}

function parseProposedRun(raw: unknown): ProposedRun | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    segments: asRecords(record.segments) as unknown as RunSegment[],
    name: str(record.name, "AI-Suggested Run"),
    runType: (str(record.run_type, "easy") as RunType) ?? "easy",
    targetDistance: numOrNull(record.target_distance),
    targetDurationMinutes: numOrNull(record.target_duration_minutes),
  };
}

function parseAICoachMessage(raw: Record<string, unknown>): AICoachMessage {
  const role = raw.role === "assistant" ? "assistant" : "user";
  return {
    actions: asRecords(raw.actions) as unknown as GeoffreyAction[],
    role,
    content: str(raw.content),
    createdAt: str(raw.created_at),
    proposedWorkouts: asRecords(raw.proposed_workouts)
      .map(parseProposedWorkout)
      .filter((w): w is ProposedWorkout => w !== null),
    proposedRuns: asRecords(raw.proposed_runs)
      .map(parseProposedRun)
      .filter((r): r is ProposedRun => r !== null),
  };
}

/**
 * ha_user_id is a discovery attribute shared by convention across several
 * sibling integrations (Cache, Hustle, Stash, Gains all use it), so it is
 * NOT enough on its own to identify a Gains entity -- a household running
 * more than one of these will have several unrelated sensors that also
 * carry ha_user_id, and naively matching the first one whose ha_user_id
 * equals hass.user.id can silently pick a different integration's sensor
 * entirely (observed in production: it matched a finance integration's
 * entity, which has no ai_conversation, so the Coach tab silently looked
 * empty). hass.entities (the entity registry) tells us which integration
 * actually owns an entity_id, which is the only non-heuristic way to
 * scope this -- attributes are just data, not proof of ownership.
 */
function isGainsEntity(hass: HomeAssistant, entity: HassEntity): boolean {
  const registryEntry = hass.entities?.[entity.entity_id];
  if (registryEntry) return registryEntry.platform === DOMAIN;
  // No registry available (older core) -- fall back to requiring the
  // specific combination of fields only Gains' AthleteProfileSensor sets,
  // which is far less likely to collide than ha_user_id alone.
  const a = entity.attributes;
  return "profile_id" in a && "onboarding_complete" in a && "ha_user_id" in a;
}

function entitiesWith(hass: HomeAssistant, attr: string): HassEntity[] {
  return Object.values(hass.states).filter(
    (e) =>
      e.entity_id.startsWith("sensor.") &&
      attr in e.attributes &&
      isGainsEntity(hass, e),
  );
}

function parseLinkedProfile(
  raw: Record<string, unknown>,
): LinkedProfileSummary {
  return {
    profileId: str(raw.profile_id),
    displayName: str(raw.display_name, "Athlete"),
  };
}

function parseIncomingShare(raw: Record<string, unknown>): IncomingShare {
  return {
    deviceMode: raw.device_mode === "same_device" ? "same_device" : raw.device_mode === "different_devices" ? "different_devices" : undefined,
    id: str(raw.id),
    kind: str(raw.kind, "workout") as ShareKind,
    name: str(raw.name, "Shared item"),
    fromProfileId: str(raw.from_profile_id),
    fromDisplayName: str(raw.from_display_name, "Someone"),
    createdAt: str(raw.created_at),
  };
}

function parseGymProfile(raw: Record<string, unknown>): GymProfile {
  return {
    id: str(raw.id),
    name: str(raw.name, "Gym"),
    equipment: recordOfOptionalNumberLists(raw.equipment),
    equipmentConfig: recordOfEquipmentConfig(raw.equipment_config),
    createdByProfileId: str(raw.created_by_profile_id),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

function parseProfile(entity: HassEntity): AthleteProfile {
  const a = entity.attributes;
  return {
    profileId: str(a.profile_id),
    haUserId: str(a.ha_user_id),
    displayName: str(a.display_name, "Athlete"),
    units: (str(a.units, "imperial") as Units) ?? "imperial",
    experienceLevel: strOrNull(a.experience_level) as ExperienceLevel | null,
    activityLevel: strOrNull(a.activity_level) as ActivityLevel | null,
    preferredDurationMinutes: numOrNull(a.preferred_duration_minutes),
    restTimerSeconds: numOrNull(a.rest_timer_seconds) ?? 60,
    preferredSequencingPolicy: a.preferred_sequencing_policy === "calendar" || a.preferred_sequencing_policy === "completion" ? a.preferred_sequencing_policy : undefined,
    isAdmin: bool(a.is_admin),
    onboardingComplete: bool(a.onboarding_complete),
    createdAt: str(a.created_at),
    updatedAt: str(a.updated_at),
    bodyweight: numOrNull(a.bodyweight),
    age: numOrNull(a.age),
    personalRecords: recordOfNumbers(a.personal_records),
    inventoryPolicy: parseInventoryPolicy(a.inventory_policy),
    aiConversation: asRecords(a.ai_conversation).map(parseAICoachMessage),
    gymProfileId: strOrNull(a.gym_profile_id),
    linkedProfiles: asRecords(a.linked_profiles).map(parseLinkedProfile),
    linkableProfiles: asRecords(a.linkable_profiles).map(parseLinkedProfile),
    shareTargets: asRecords(a.share_targets).map(parseLinkedProfile),
    jointTargets: asRecords(a.joint_targets).map(p=>({...parseLinkedProfile(p),
      eligibleWorkoutIds: Array.isArray(p.eligible_workout_ids) ? p.eligible_workout_ids.filter((id): id is string=>typeof id==="string") : []})),
    incomingShares: asRecords(a.incoming_shares).map(parseIncomingShare),
  };
}

/**
 * Reads hass.states, finds Gains' sensors by their stable discovery
 * attributes (ha_user_id, added specifically so the frontend never has to
 * guess a slugified entity_id), and returns a typed GainsState scoped to
 * the currently logged-in HA user -- matches ha-cache-frontend's
 * parseCacheState() convention.
 */
export function parseGainsState(hass: HomeAssistant): GainsState {
  const currentUserId = hass.user?.id ?? null;

  let profile: AthleteProfile | null = null;
  let workouts: Workout[] = [];
  let runs: Run[] = [];
  let gymProfiles: GymProfile[] = [];
  let muscleRecovery: GainsState["muscleRecovery"];
  if (currentUserId) {
    const match = entitiesWith(hass, "ha_user_id").find(
      (e) => e.attributes.ha_user_id === currentUserId,
    );
    if (match) {
      profile = parseProfile(match);
      muscleRecovery = parseMuscleRecovery(match.attributes.muscle_recovery);
      workouts = asRecords(match.attributes.workouts).map(parseWorkout);
      runs = asRecords(match.attributes.runs).map(parseRun);
      gymProfiles = asRecords(match.attributes.gym_profiles).map(
        parseGymProfile,
      );
    }
  }

  const profileCount = entitiesWith(hass, "ha_user_id").length;

  return { profile, profileCount, workouts, runs, gymProfiles, muscleRecovery };
}

function callGainsService(
  hass: HomeAssistant,
  service: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) cleaned[key] = value;
  }
  return hass.callService(DOMAIN, service, cleaned);
}

export const gainsApi = {
  /** Safe to call on every panel mount -- idempotent on the backend. */
  ensureProfile(hass: HomeAssistant, displayName?: string) {
    return callGainsService(hass, "ensure_profile", {
      display_name: displayName,
    });
  },

  updateProfile(
    hass: HomeAssistant,
    fields: {
      display_name?: string;
      units?: Units;
      experience_level?: ExperienceLevel;
      activity_level?: ActivityLevel;
      preferred_duration_minutes?: number;
      rest_timer_seconds?: number;
      preferred_sequencing_policy?: "calendar" | "completion";
      onboarding_complete?: boolean;
      bodyweight?: number;
      age?: number;
    },
  ) {
    return callGainsService(hass, "update_profile", fields);
  },

  /** Creates a new gym profile -- shared instance-wide immediately, any
   * Home Assistant member on this instance can select or edit it. */
  createGymProfile(
    hass: HomeAssistant,
    name: string,
    equipment?: Record<string, (number | null)[]>,
    equipmentConfig?: Record<string, import("./types").EquipmentConfig>,
  ) {
    const serializedConfig = equipmentConfig
      ? Object.fromEntries(
          Object.entries(equipmentConfig).map(([id, config]) => [id, {
            load_type: config.loadType,
            pulley_ratio: config.pulleyRatio,
            stack_max: config.stackMax,
            stack_increment: config.stackIncrement,
            stack_min: config.stackMin,
            base_weight: config.baseWeight,
            loading_points: config.loadingPoints,
          }]),
        )
      : undefined;
    return callGainsService(hass, "create_gym_profile", {
      name,
      equipment,
      equipment_config: serializedConfig,
    });
  },

  /** Edits any gym profile on the instance (name and/or its whole
   * checked-equipment set, wholesale-replacing what was there before). */
  updateGymProfile(
    hass: HomeAssistant,
    gymProfileId: string,
    fields: {
      name?: string;
      equipment?: Record<string, (number | null)[]>;
      equipmentConfig?: Record<string, import("./types").EquipmentConfig>;
    },
  ) {
    const serializedConfig = fields.equipmentConfig
      ? Object.fromEntries(
          Object.entries(fields.equipmentConfig).map(([id, config]) => [id, {
            load_type: config.loadType,
            pulley_ratio: config.pulleyRatio,
            stack_max: config.stackMax,
            stack_increment: config.stackIncrement,
            stack_min: config.stackMin,
            base_weight: config.baseWeight,
            loading_points: config.loadingPoints,
          }]),
        )
      : undefined;
    return callGainsService(hass, "update_gym_profile", {
      gym_profile_id: gymProfileId,
      name: fields.name,
      equipment: fields.equipment,
      equipment_config: serializedConfig,
    });
  },

  deleteGymProfile(hass: HomeAssistant, gymProfileId: string) {
    return callGainsService(hass, "delete_gym_profile", {
      gym_profile_id: gymProfileId,
    });
  },

  /** Sets which shared gym profile the calling user has selected as their
   * own -- pass null (or omit) to clear the selection (bodyweight-only).
   * Called directly rather than through callGainsService since that helper
   * strips null values, but here null is a meaningful "clear it" signal
   * the backend's schema already defaults to when omitted -- either way
   * works, this just says the intent explicitly. */
  selectGymProfile(hass: HomeAssistant, gymProfileId: string | null) {
    return hass.callService(DOMAIN, "select_gym_profile", {
      gym_profile_id: gymProfileId,
    });
  },

  createWorkout(
    hass: HomeAssistant,
    name: string,
    exercises: {
      exerciseId: string;
      sets: { reps?: number; weight?: number }[];
    }[],
  ) {
    return callGainsService(hass, "create_workout", {
      name,
      exercises: exercises.map((exercise) => ({
        exercise_id: exercise.exerciseId,
        sets: exercise.sets.map((s) => ({ reps: s.reps, weight: s.weight })),
      })),
    });
  },

  startWorkout(hass: HomeAssistant, workoutId: string) {
    return callGainsService(hass, "start_workout", { workout_id: workoutId });
  },

  logSet(
    hass: HomeAssistant,
    workoutId: string,
    exerciseIndex: number,
    setIndex: number,
    reps?: number,
    weight?: number,
  ) {
    return callGainsService(hass, "log_set", {
      workout_id: workoutId,
      exercise_index: exerciseIndex,
      set_index: setIndex,
      reps,
      weight,
    });
  },

  /** Asked once, after every set in the exercise is logged -- see
   * ha-gains-integration's coordinator.async_log_exercise_effort. */
  logExerciseEffort(
    hass: HomeAssistant,
    workoutId: string,
    exerciseIndex: number,
    effort: Effort,
  ) {
    return callGainsService(hass, "log_exercise_effort", {
      workout_id: workoutId,
      exercise_index: exerciseIndex,
      effort,
    });
  },

  /** Drops one exercise (and any sets already logged for it) from a
   * workout. */
  removeExercise(
    hass: HomeAssistant,
    workoutId: string,
    exerciseIndex: number,
  ) {
    return callGainsService(hass, "remove_exercise", {
      workout_id: workoutId,
      exercise_index: exerciseIndex,
    });
  },

  /** Swaps one exercise slot for a different exercise -- see
   * ha-gains-integration's coordinator.async_replace_exercise. Resets
   * that slot's sets to unlogged. */
  replaceExercise(
    hass: HomeAssistant,
    workoutId: string,
    exerciseIndex: number,
    newExerciseId: string,
  ) {
    return callGainsService(hass, "replace_exercise", {
      workout_id: workoutId,
      exercise_index: exerciseIndex,
      new_exercise_id: newExerciseId,
    });
  },

  completeWorkout(hass: HomeAssistant, workoutId: string) {
    return callGainsService(hass, "complete_workout", {
      workout_id: workoutId,
    });
  },

  skipWorkout(hass: HomeAssistant, workoutId: string) {
    return callGainsService(hass, "skip_workout", { workout_id: workoutId });
  },

  deleteWorkout(hass: HomeAssistant, workoutId: string) {
    return callGainsService(hass, "delete_workout", { workout_id: workoutId });
  },

  /** Offers a copy of this workout's planned exercises/sets to any other
   * Home Assistant member on the instance -- never actual/completed
   * progress, and the source workout is untouched. Creates a pending
   * share the target must accept (gainsApi.respondShare) before anything
   * lands in their own workouts; no linking required first.
   * actingProfileId (coach mode): share on behalf of the athlete being
   * coached instead of the caller's own workout -- only needed when
   * calling through an unscoped hass (scopedTrainingHass already adds
   * this automatically for a hass it wraps). */
  shareWorkout(
    hass: HomeAssistant,
    workoutId: string,
    targetProfileId: string,
    actingProfileId?: string,
  ) {
    return callGainsService(hass, "share_workout", {
      workout_id: workoutId,
      target_profile_id: targetProfileId,
      acting_profile_id: actingProfileId,
    });
  },

  createRun(
    hass: HomeAssistant,
    name: string,
    runType: RunType,
    targetDistance?: number,
    targetDurationMinutes?: number,
    notes?: string,
  ) {
    return callGainsService(hass, "create_run", {
      name,
      run_type: runType,
      target_distance: targetDistance,
      target_duration_minutes: targetDurationMinutes,
      notes,
    });
  },

  logRun(
    hass: HomeAssistant,
    runId: string,
    actualDistance?: number,
    actualDurationMinutes?: number,
  ) {
    return callGainsService(hass, "log_run", {
      run_id: runId,
      actual_distance: actualDistance,
      actual_duration_minutes: actualDurationMinutes,
    });
  },

  skipRun(hass: HomeAssistant, runId: string) {
    return callGainsService(hass, "skip_run", { run_id: runId });
  },

  /** Offers a copy of this run's planned targets/segments to any other
   * Home Assistant member on the instance -- never actual/completed
   * progress, and the source run is untouched. Creates a pending share
   * the target must accept (gainsApi.respondShare) before anything lands
   * in their own runs; no linking required first. */
  shareRun(
    hass: HomeAssistant,
    runId: string,
    targetProfileId: string,
    actingProfileId?: string,
  ) {
    return callGainsService(hass, "share_run", {
      run_id: runId,
      target_profile_id: targetProfileId,
      acting_profile_id: actingProfileId,
    });
  },

  /** Offers a copy of this program's week/session prescriptions to any
   * other Home Assistant member on the instance, starting fresh (no
   * progress, no coaching grants) once accepted -- the source program is
   * untouched. Creates a pending share the target must accept
   * (gainsApi.respondShare); no linking required first. actingProfileId:
   * see shareWorkout. */
  shareProgram(
    hass: HomeAssistant,
    programId: string,
    targetProfileId: string,
    actingProfileId?: string,
  ) {
    return callGainsService(hass, "share_program", {
      program_id: programId,
      target_profile_id: targetProfileId,
      acting_profile_id: actingProfileId,
    });
  },

  /** Accepts or declines a pending share from GainsState.profile.incomingShares
   * -- accepting copies it into the calling user's own workouts/runs/
   * programs, declining just dismisses the offer. Either way the
   * sender's original item is untouched. actingProfileId: see
   * shareWorkout -- respond on behalf of the athlete being coached. */
  respondShare(
    hass: HomeAssistant,
    shareId: string,
    accept: boolean,
    actingProfileId?: string,
  ) {
    return callGainsService(hass, "respond_share", {
      share_id: shareId,
      accept,
      acting_profile_id: actingProfileId,
    });
  },

  aiChat(hass: HomeAssistant, message: string) {
    return callGainsService(hass, "ai_chat", { message });
  },

  linkAccount(hass: HomeAssistant, profileId: string) {
    return callGainsService(hass, "link_account", { profile_id: profileId });
  },

  unlinkAccount(hass: HomeAssistant, profileId: string) {
    return callGainsService(hass, "unlink_account", { profile_id: profileId });
  },
};

/** Response services carry target context explicitly; HA still supplies actor identity. */
export function serviceErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (
    error instanceof Error &&
    error.message &&
    error.message !== "[object Object]"
  )
    return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "body"]) {
      if (value[key] && value[key] !== error) {
        const message = serviceErrorMessage(value[key]);
        if (!message.startsWith("Home Assistant rejected")) return message;
      }
    }
  }
  return "Home Assistant rejected the request. Check the Gains logs for details.";
}

export async function trainingService<T>(
  hass: HomeAssistant,
  service: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  if (!hass.callWS)
    throw new Error(
      "Home Assistant service responses are unavailable. Refresh the app.",
    );
  const result = await hass.callWS<{ response: T }>({
    type: "call_service",
    domain: "gains",
    service,
    service_data: data,
    return_response: true,
  });
  return result.response;
}
export const trainingApi = {
  state: (hass: HomeAssistant, target?: string) =>
    trainingService<TrainingSnapshot>(
      hass,
      "training_state",
      target ? { target_profile_id: target } : {},
    ),
  build: (
    hass: HomeAssistant,
    request: TrainingBuildRequest,
    target?: string,
  ) =>
    trainingService<TrainingProposal>(hass, "build_training", {
      request,
      ...(target ? { target_profile_id: target } : {}),
    }),
  accept: (
    hass: HomeAssistant,
    id: string,
    fields: TrainingPayload,
    target?: string,
  ) =>
    trainingService<{ id: string; type: string }>(hass, "accept_training", {
      id,
      fields,
      ...(target ? { target_profile_id: target } : {}),
    }),
};
export const progressApi = {
  state: (hass: HomeAssistant, target?: string) =>
    trainingService<ProgressState>(
      hass,
      "progress_state",
      target ? { target_profile_id: target } : {},
    ),
};
export function parseTrainingState(snapshot: TrainingSnapshot): GainsState {
  const attrs = snapshot.attributes;
  const entity: HassEntity = {
    entity_id: "sensor.gains_context",
    state: "ready",
    attributes: attrs,
  };
  return {
    profile: parseProfile(entity),
    profileCount: 1,
    muscleRecovery: parseMuscleRecovery(attrs.muscle_recovery),
    workouts: asRecords(attrs.workouts).map(parseWorkout),
    runs: asRecords(attrs.runs).map(parseRun),
    gymProfiles: asRecords(attrs.gym_profiles).map(parseGymProfile),
  };
}
/** An API adapter only: never replace hass.user or invent athlete authentication. */
export function scopedTrainingHass(
  hass: HomeAssistant,
  snapshot: TrainingSnapshot,
  refreshed: () => Promise<void>,
): HomeAssistant {
  const target =
    snapshot.mode === "coach" ? snapshot.active_profile_id : undefined;
  const args = target ? { target_profile_id: target } : {};
  const sessionActions = new Set([
    "start_workout",
    "complete_workout",
    "skip_workout",
    "delete_workout",
    "log_set",
    "log_exercise_effort",
    "remove_exercise",
    "replace_exercise",
    "log_run",
    "skip_run",
    "create_workout",
    "create_run",
  ]);
  // These take their own target_profile_id (who receives the share/who
  // shared it), so coach mode is threaded through as acting_profile_id
  // instead -- who the coach is acting on behalf of -- rather than
  // colliding with that field like session_action's shared "target_profile_id"
  // convention would.
  const shareActions = new Set([
    "share_workout",
    "share_run",
    "share_program",
    "respond_share",
  ]);
  return {
    ...hass,
    callWS: hass.callWS?.bind(hass),
    callService: async (domain, service, data = {}) => {
      let result: unknown;
      if (domain === "gains" && service === "ai_chat")
        result = await trainingService(hass, "ask_geoffrey", {
          ...args,
          fields: data,
        });
      else if (domain === "gains" && sessionActions.has(service)) {
        const workouts = asRecords(snapshot.attributes.workouts);
        const workout = workouts.find((w) => w.id === data.workout_id);
        result = await trainingService(hass, "session_action", {
          ...args,
          action: service,
          fields: {
            ...data,
            ...(workout ? { expected_revision: workout.revision } : {}),
          },
        });
      } else if (domain === "gains" && shareActions.has(service))
        result = await hass.callService(domain, service, {
          ...data,
          ...(target ? { acting_profile_id: target } : {}),
        });
      else if (target)
        throw new Error(
          "This account action is only available in your own profile.",
        );
      else result = await hass.callService(domain, service, data);
      await refreshed();
      return result;
    },
  };
}
