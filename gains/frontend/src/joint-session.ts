import type { Workout, Effort } from "./types";

export interface JointSession {
  id: string;
  status: string;
  device_mode?: "same_device" | "different_devices";
  controller_profile_id?: string | null;
  turn: { profile_id: string; exercise_index: number; set_index: number } | null;
  participants: {
    profile_id: string;
    display_name: string;
    workout_id: string;
    status: string;
    units?: "imperial" | "metric";
    inventory_policy?: import("./inventory-policy").InventoryPolicy;
    exercises: { exercise_id: string; effort: string | null; notes?: string;
      selected_bar_equipment_id?: string | null; selected_bar_weight?: number | null; sets: {
      planned_reps?: number | null; planned_weight?: number | null; manual_weight?: boolean;
      actual_reps: number | null; actual_weight: number | null; completed: boolean;
      recorded_by_profile_id: string | null;
      is_personal_record?: boolean; personal_record_value?: number | null; previous_personal_record?: number | null;
    }[] }[];
  }[];
}

/** Adapt participant snapshots to the same controls used by solo workouts. */
export function participantWorkout(source: Workout, profileId: string): Workout | undefined {
  const participant = source.jointSession?.participants.find(p => p.profile_id === profileId);
  if (!participant) return undefined;
  return {
    ...source, id: participant.workout_id, profileId: participant.profile_id,
    status: participant.status === "active" ? "active" : participant.status === "completed" ? "completed" : "skipped",
    exercises: participant.exercises.map(e => ({
      exerciseId: e.exercise_id, effort: e.effort as Effort | null, notes: e.notes ?? "",
      selectedBarEquipmentId: e.selected_bar_equipment_id, selectedBarWeight: e.selected_bar_weight,
      sets: e.sets.map(s => ({
        manualWeight: s.manual_weight,
        plannedReps: s.planned_reps ?? null, plannedWeight: s.planned_weight ?? null,
        actualReps: s.actual_reps, actualWeight: s.actual_weight, completed: s.completed,
        recordedByProfileId: s.recorded_by_profile_id, isPersonalRecord: s.is_personal_record,
        personalRecordValue: s.personal_record_value, previousPersonalRecord: s.previous_personal_record,
      })),
    })),
  };
}

export function isSharedController(session: JointSession | undefined, profileId: string): boolean {
  return session?.status === "active" && session.device_mode === "same_device" &&
    session.controller_profile_id === profileId && session.participants.some(p=>p.profile_id===profileId && ["active","completed"].includes(p.status));
}

export function parseJointSession(raw: unknown): JointSession | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const session = raw as JointSession;
  if (typeof session.id !== "string" || !Array.isArray(session.participants) ||
      session.participants.some(p => !p || typeof p.profile_id !== "string" || !Array.isArray(p.exercises))) return undefined;
  return session;
}

export function isJointParticipant(session: JointSession | undefined, profileId: string): boolean {
  return session?.status === "active" && session.participants.some(p => p.profile_id === profileId && p.status === "active");
}

export function canLogJointSet(session: JointSession | undefined, profileId: string, exerciseIndex: number, setIndex: number, completed: boolean): boolean {
  if (!isJointParticipant(session, profileId) || completed) return true;
  return session?.turn?.profile_id === profileId && session.turn.exercise_index === exerciseIndex && session.turn.set_index === setIndex;
}
