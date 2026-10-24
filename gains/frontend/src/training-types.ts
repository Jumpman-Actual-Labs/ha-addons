export type BuildType = "workout" | "run" | "program";
export type BuilderAnswers = Record<string, unknown>;
export interface TrainingBuildRequest {
  type: BuildType;
  source: "wizard" | "geoffrey";
  answers: BuilderAnswers;
}
export interface GeoffreyAction {
  type: "start_builder";
  builder: BuildType;
  prefill: BuilderAnswers;
}
export interface GainsViewContext {
  viewerProfileId: string;
  activeProfileId: string;
  mode: "self" | "coach";
}
export type Permission =
  "view_workouts" | "coach_workouts" | "view_progress" | "manage_programs";
export interface RunSegment {
  phase: "warmup" | "main" | "cooldown";
  label: string;
  repetitions: number;
  distance_m?: number;
  duration_seconds?: number;
  recovery_seconds?: number;
  pace_min_seconds_per_km?: number;
  pace_max_seconds_per_km?: number;
  rpe?: number;
  notes?: string;
}
export interface WorkoutPrescription {
  planning?: {
    estimated_duration_minutes?: number;
    warnings?: string[];
    reasons?: Record<string, string[]>;
  };
  name: string;
  exercises: {
    exercise_id: string;
    rest_seconds?: number;
    sets: { reps: number; weight: number }[];
  }[];
}
export interface RunPrescription {
  name: string;
  run_type: string;
  target_distance?: number | null;
  target_duration_minutes?: number | null;
  notes?: string;
  segments: RunSegment[];
}
export interface ProgramSession {
  id: string;
  day: number;
  type: "workout" | "run" | "hiit" | "conditioning" | "recovery" | "rest";
  name: string;
  prescription: WorkoutPrescription | RunPrescription | { notes: string };
  actual_id?: string;
  completed_at?: string;
  notes?: string;
  template_id?: string;
  week_number?: number;
  scheduled_date?: string;
  actual_status?: string;
}
export interface ProgramWeek {
  week_number: number;
  focus: string;
  sessions: ProgramSession[];
}
export interface ProgramPrescription {
  name: string;
  goal: string;
  start_date: string;
  weeks: ProgramWeek[];
}
export interface TrainingProgram extends ProgramPrescription {
  origin_request?: TrainingBuildRequest;
  sequencing_policy?: "calendar" | "completion";
  manual_overrides?: boolean;
  rotation_events?: Record<string, "completed" | "skipped">;
  current_week?: number;
  generated_weeks?: Record<string, ProgramWeek>;
  cycle_week?: number;
  current_schedule?: ProgramWeek;
  upcoming_sessions?: ProgramSession[];
  completed_sessions?: number;
  id: string;
  profile_id: string;
  status: "draft" | "active" | "paused" | "completed";
  revision: number;
}
export type TrainingPayload =
  WorkoutPrescription | RunPrescription | ProgramPrescription;
export interface TrainingProposal {
  manual_override?: boolean;
  id: string;
  profile_id: string;
  viewer_profile_id: string;
  type: BuildType;
  request: TrainingBuildRequest;
  payload: TrainingPayload;
  accepted_id?: string;
}
export interface TrainingSnapshot {
  attributes: Record<string, unknown>;
  viewer_profile_id: string;
  active_profile_id: string;
  mode: "self" | "coach";
  permissions: Record<Permission, boolean>;
  /** picture: the athlete's Home Assistant account picture (a path on HA's
   * own origin), or null when their person has none. */
  coachable_profiles: { profile_id: string; display_name: string; picture?: string | null }[];
  grants: Record<
    string,
    { role: string; permissions: Record<Permission, boolean> }
  >;
  programs: TrainingProgram[];
  proposals: TrainingProposal[];
}
export interface StrengthScoreExercise {
  exercise_id: string;
  exercise_name: string;
  score: number;
  tier: string;
  one_rep_max: number;
}
export interface StrengthScoreGroup {
  muscle_group: string;
  label: string;
  score: number | null;
  tier: string | null;
  exercises: StrengthScoreExercise[];
}
export interface StrengthScoreState {
  overall_score: number | null;
  overall_tier: string | null;
  groups: StrengthScoreGroup[];
}
export interface MostImprovedExercise {
  exercise_id: string;
  exercise_name: string;
  from_one_rep_max: number;
  to_one_rep_max: number;
  percent_improved: number;
}
export interface MuscleGroupFrequency {
  muscle_group: string;
  label: string;
  days: number;
  sets: number;
}
export interface MonthlyReport {
  year: number;
  month: number;
  workouts_completed: number;
  duration_minutes: number;
  volume: number;
  sets: number;
  most_improved: MostImprovedExercise[];
  muscle_breakdown: MuscleGroupFrequency[];
}
export interface ProgressState {
  strength_score: StrengthScoreState;
  streak_days: number;
  this_month: MonthlyReport;
}
