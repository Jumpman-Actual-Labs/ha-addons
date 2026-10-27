import { buildPlateLoadout, nextSetSuggestion, replacementLibrary, type LibraryFilters } from "../inventory-policy";
import { workoutSurfaceStyles } from "../workout-surfaces";
import { defaultInventoryWeight } from "../inventory-units";
import { recoveryPercent } from "../recovery";
import type { GainsViewContext } from "../training-types";
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { gainsApi, serviceErrorMessage, trainingService } from "../ha-api";
import { canLogJointSet, exerciseTurn, isJointParticipant, isSharedController, participantWorkout } from "../joint-session";
import type { Effort, GainsState, Workout, WorkoutExercise, WorkoutSet } from "../types";
import { EFFORT_LEVELS, EQUIPMENT_CATALOG, EXERCISE_LIBRARY } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { MUSCLE_DICTIONARY, muscleCoverage, muscleLabels, musclesForExercise, type MuscleId } from "../muscles";
import "../components/muscle-map";

interface DraftExercise {
  exerciseId: string;
  sets: number;
  reps: number;
  weight: number;
}

interface DraftLog {
  reps?: number;
  weight?: number;
}

interface BarChoice {
  equipmentId: string;
  weight: number;
  label: string;
}

const PLATE_BAR_EQUIPMENT_IDS = new Set([
  "olympic_barbell",
  "ez_bar",
  "trap_bar",
  "short_bar",
  "safety_squat_bar",
]);

type ChipMenu = "category" | "equipment" | null;

function exerciseName(exerciseId: string): string {
  return EXERCISE_LIBRARY.find((e) => e.id === exerciseId)?.name ?? exerciseId;
}

function exerciseCategory(exerciseId: string): string {
  return EXERCISE_LIBRARY.find((e) => e.id === exerciseId)?.category ?? "";
}

function exerciseVideoUrl(exerciseId: string): string | undefined {
  return EXERCISE_LIBRARY.find((e) => e.id === exerciseId)?.videoUrl;
}

/** Pulls a video id out of the handful of URL shapes YouTube links come
 * in (watch?v=, youtu.be/, already an embed url) so a plain video/share
 * URL can be dropped into ExerciseDef.videoUrl without also hand-building
 * the embed url. Returns null for anything unrecognized rather than
 * guessing. */
function youtubeEmbedId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.slice(1) || null;
    }
    if (parsed.pathname.startsWith("/embed/")) {
      return parsed.pathname.replace("/embed/", "") || null;
    }
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

function exerciseEquipment(exerciseId: string): string {
  return EXERCISE_LIBRARY.find((e) => e.id === exerciseId)?.equipment ?? "";
}

function isTimedExercise(exerciseId: string): boolean {
  return EXERCISE_LIBRARY.find((e) => e.id === exerciseId)?.isTimed ?? false;
}

function muscleGroupsForExercise(exerciseId: string): string {
  return muscleLabels(muscleCoverage([exerciseId]).primary) || "Muscle detail unavailable";
}

function workoutTargetMuscles(exerciseIds: string[]) {
  const counts = new Map<string, number>();
  for (const exerciseId of exerciseIds) {
    const muscles = musclesForExercise(exerciseId);
    if (!muscles) continue;
    for (const muscle of [...muscles.primary, ...muscles.secondary]) {
      counts.set(muscle, (counts.get(muscle) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([muscle, count]) => ({
      muscle,
      count,
      label: muscleLabels([muscle as MuscleId]),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 4);
}

function compactExercisePrescription(
  exercise: Workout["exercises"][number],
  status: Workout["status"],
  units: "lb" | "kg",
): string {
  const sets = exercise.sets;
  const reps = sets
    .map((set) => status === "completed" ? set.actualReps : set.plannedReps)
    .filter((value): value is number => value != null);
  const weights = sets
    .map((set) => status === "completed" ? set.actualWeight : set.plannedWeight)
    .filter((value): value is number => value != null);
  const range = (values: number[]) => {
    if (!values.length) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? `${min}` : `${min}\u2013${max}`;
  };
  const pieces = [`${sets.length} set${sets.length === 1 ? "" : "s"}`];
  const repRange = range(reps);
  if (repRange) pieces.push(`${repRange} ${isTimedExercise(exercise.exerciseId) ? "sec" : "reps"}`);
  const weightRange = range(weights);
  if (weightRange && weights.some((value) => value > 0)) pieces.push(`${weightRange} ${units}`);
  return pieces.join(" \u00b7 ");
}

const IMPERIAL_BAR_WEIGHT = 45;
const METRIC_BAR_WEIGHT = 20;

interface PlateInventoryItem {
  weight: number;
  count: number;
}

interface PlateLoadout {
  perSide: number;
  counts: Array<{ plate: number; count: number }>;
  remainder: number;
  exact: boolean;
  belowBar: boolean;
}

function plateColor(weight: number, units: "lb" | "kg"): string {
  if (units === "lb") {
    const colors: Record<number, string> = {
      2.5: "#F4F6F8",
      5: "#25282D",
      10: "#C9D0D8",
      15: "#7A7F87",
      25: "#2E9B47",
      35: "#F2C230",
      45: "#2D7DD2",
      55: "#D64545",
    };
    return colors[weight] ?? "#69727D";
  }

  // Sensible fallback for metric gyms using common competition plate colors.
  const metricColors: Record<number, string> = {
    1.25: "#2E9B47",
    2.5: "#D64545",
    5: "#F4F6F8",
    10: "#2E9B47",
    15: "#F2C230",
    20: "#2D7DD2",
    25: "#D64545",
  };
  return metricColors[weight] ?? "#69727D";
}

function plateStyle(weight: number, units: "lb" | "kg"): string {
  const color = plateColor(weight, units);
  const outline = units === "lb" && weight === 5 ? "#8B929B" : "transparent";
  return `--plate-color:${color};--plate-outline:${outline}`;
}

function barbellPlateStyle(weight: number, units: "lb" | "kg"): string {
  const color = plateColor(weight, units);
  const outline = units === "lb" && weight === 5 ? "#8B929B" : "rgba(0,0,0,.18)";
  const reference = units === "lb" ? weight : weight * 2.20462;
  const height =
    reference >= 55 ? 84 :
    reference >= 45 ? 80 :
    reference >= 35 ? 72 :
    reference >= 25 ? 64 :
    reference >= 15 ? 56 :
    reference >= 10 ? 50 :
    reference >= 5 ? 44 : 38;
  const width =
    reference >= 45 ? 12 :
    reference >= 25 ? 10 :
    reference >= 10 ? 9 : 8;
  return `--plate-color:${color};--plate-outline:${outline};--bar-plate-height:${height}px;--bar-plate-width:${width}px`;
}

function expandPlateLoadout(counts: PlateLoadout["counts"]): number[] {
  return counts.flatMap(({ plate, count }) =>
    Array.from({ length: count }, () => plate),
  );
}



function labelize(value: string): string {
  return value
    .split("_")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

interface RecapExerciseStats {
  exerciseId: string;
  sets: WorkoutSet[];
  totalReps: number;
  volume: number;
  bestEstimated1RM: number | null;
  prCount: number;
}

function estimatedOneRepMax(weight: number | null, reps: number | null): number | null {
  if (weight == null || reps == null || reps < 1 || weight < 0) return null;
  return reps <= 1 ? weight : weight * (1 + reps / 30);
}

function recapExerciseStats(workout: Workout, exerciseId: string): RecapExerciseStats {
  const sets = workout.exercises
    .filter((exercise) => exercise.exerciseId === exerciseId)
    .flatMap((exercise) => exercise.sets)
    .filter((set) => set.completed);

  let totalReps = 0;
  let volume = 0;
  let bestEstimated1RM: number | null = null;
  let prCount = 0;
  const timed = isTimedExercise(exerciseId);

  for (const set of sets) {
    const reps = set.actualReps ?? 0;
    const weight = set.actualWeight ?? 0;
    totalReps += reps;
    if (!timed) volume += weight * reps;
    if (!timed) {
      const estimate = estimatedOneRepMax(set.actualWeight, set.actualReps);
      if (estimate != null && (bestEstimated1RM == null || estimate > bestEstimated1RM)) {
        bestEstimated1RM = estimate;
      }
    }
    if (set.isPersonalRecord) prCount += 1;
  }

  return { exerciseId, sets, totalReps, volume, bestEstimated1RM, prCount };
}

function recapWorkoutVolume(workout: Workout): number {
  return [...new Set(workout.exercises.map((exercise) => exercise.exerciseId))]
    .reduce((sum, exerciseId) => sum + recapExerciseStats(workout, exerciseId).volume, 0);
}

function previousWorkoutForExercise(
  workouts: Workout[],
  currentWorkout: Workout,
  exerciseId: string,
  currentCompletedAt?: string,
): Workout | undefined {
  const currentTime = Date.parse(
    currentWorkout.completedAt ?? currentCompletedAt ?? currentWorkout.startedAt ?? currentWorkout.createdAt,
  );
  return workouts
    .filter((candidate) =>
      candidate.id !== currentWorkout.id &&
      candidate.status === "completed" &&
      candidate.exercises.some((exercise) => exercise.exerciseId === exerciseId),
    )
    .filter((candidate) => {
      if (!Number.isFinite(currentTime)) return true;
      const candidateTime = Date.parse(candidate.completedAt ?? candidate.startedAt ?? candidate.createdAt);
      return !Number.isFinite(candidateTime) || candidateTime < currentTime;
    })
    .sort((a, b) =>
      Date.parse(b.completedAt ?? b.startedAt ?? b.createdAt) -
      Date.parse(a.completedAt ?? a.startedAt ?? a.createdAt),
    )[0];
}

const CATEGORY_OPTIONS = [...new Set(EXERCISE_LIBRARY.map((e) => e.category))];
const EQUIPMENT_OPTIONS = [...new Set(EXERCISE_LIBRARY.map((e) => e.equipment))].sort();

/** Deterministic accent color per category, evenly spaced around the hue
 * wheel -- no icon set to depend on (an MDI name can silently not exist;
 * a plain CSS color always renders). */
function categoryColor(category: string): string {
  const index = CATEGORY_OPTIONS.indexOf(category);
  const hue = Math.round((index / CATEGORY_OPTIONS.length) * 360);
  return `hsl(${hue}, 62%, 52%)`;
}

/**
 * Phase 2 (Strength MVP): build a manual workout, start it, log each set,
 * finish it. Deterministic planning/scheduling and running/cycling/AI
 * coach are later phases -- see ha-gains-integration's CLAUDE.md.
 */
@customElement("gains-workouts-view")
export class GainsWorkoutsView extends LitElement {
  @property({attribute:false}) viewContext?:GainsViewContext;
  private _lastFocus = "";
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;
  /** One-way trigger a parent (the Today dashboard's "Next Workout" card)
   * can set to jump straight into a given workout's logging view, without
   * this component exposing _openWorkoutId itself as a controlled prop. */
  @property({ attribute: false }) requestOpenWorkoutId: string | null = null;

  @state() private _name = "";
  @state() private _draftExercises: DraftExercise[] = [];
  @state() private _pendingExerciseId = EXERCISE_LIBRARY[0].id;
  @state() private _pendingSets = 3;
  @state() private _pendingReps = 8;
  @state() private _pendingWeight = 0;
  @state() private _openWorkoutId: string | null = null;
  @state() private _busy = false;
  @state() private _activeExerciseIndex: number | null = null;
  @state() private _effortPromptExerciseIndex: number | null = null;
  @state() private _videoModalOpen = false;
  @state() private _historyModalOpen = false;
  /** Workout the exercise picker is adding to, or null when the picker is
   * choosing for the Build a Workout draft. */
  @state() private _addingToWorkout: Workout | null = null;
  @state() private _loadingPicker: {
    workoutId: string;
    exerciseIndex: number;
    setIndex: number;
  } | null = null;
  @state() private _prTooltipKey: string | null = null;
  @state() private _timedSetTimer: {
    workoutId: string;
    exerciseIndex: number;
    setIndex: number;
    seconds: number;
  } | null = null;
  @state() private _timedSetTimerPhase: "ready" | "starting" | "running" | "logging" = "ready";
  @state() private _timedSetTimerRemaining = 0;
  @state() private _timedSetStartCountdown = 3;
  private _timedSetTimerIntervalId: number | null = null;
  private _timedSetCountdownEndsAt = 0;
  private _timedSetEndsAt = 0;
  /** Seconds left on the between-sets rest timer, or null when no timer
   * is running. Started by _logSet after a fresh (non-edit) set
   * completion that isn't the exercise's last set. */
  @state() private _restTimerSecondsLeft: number | null = null;
  private _restTimerIntervalId: number | null = null;

  @state() private _pickerOpen = false;
  @state() private _search = "";
  @state() private _categoryFilter: string | null = null;
  @state() private _equipmentFilter: string | null = null;
  @state() private _openChipMenu: ChipMenu = null;

  /** Workout currently open in the "share with" dialog, or null. */
  @state() private _sharingWorkout: Workout | null = null;
  @state() private _shareBusy = false;
  @state() private _respondShareBusy: string | null = null;
  @state() private _shareNotice = "";
  @state() private _overflowWorkout: Workout | null = null;
  @state() private _togetherWorkout: Workout | null = null;
  @state() private _jointBusy = false;
  @state() private _jointDeviceMode: "same_device" | "different_devices" | null = null;
  @state() private _effortPromptWorkoutId: string | null = null;

  /** Exercise slot currently open in the "replace with" dialog (scoped to
   * exercises sharing that exercise's category/muscle group), or null. */
  @state() private _replacementFilters: LibraryFilters = { search: "", muscle: "", equipment: "", movement: "", mode: "recommended", showUnavailable: false };
  @state() private _replacingExercise: {
    workout: Workout;
    exerciseIndex: number;
    category: string;
    currentExerciseId: string;
  } | null = null;

  /** Not reactive on purpose -- these are transient input values read at
   * "Log Set" click time, not something that needs its own re-render. */
  private _draftLogs: Record<string, DraftLog> = {};
  private _setSwipeStart: Record<string, { x: number; y: number }> = {};
  @state() private _setSwipeOffsets: Record<string, number> = {};
  @state() private _setSwipeDeletingKey: string | null = null;

  @state() private _building = false;
  @state() private _listFilter: "planned" | "active" | "history" = "planned";
  @state() private _error = "";
  @state() private _savingSet: string | null = null;
  @state() private _finishConfirm = false;
  @state() private _recapWorkoutId: string | null = null;
  @state() private _recapCompletedAt: string | null = null;
  @state() private _exerciseMenu: { workout: Workout; exerciseIndex: number; exerciseId: string } | null = null;
  @state() private _editingSet: string | null = null;
  private _restUntil = 0;
  private _restWorkoutId: string | null = null;
  private _athleteId: string | null = null;

  public openWorkout(id: string): void {
    this._openWorkoutId = id;
    this._activeExerciseIndex = null;
    this._error = ""; this._finishConfirm = false;
    this._persistSession();
  }
  private _persistSession(): void {
    if (!this._athleteId) return;
    try {
      sessionStorage.setItem(`gains-session:${this._athleteId}`, JSON.stringify({
        workoutId: this._openWorkoutId, exerciseIndex: this._activeExerciseIndex,
        drafts: this._draftLogs, restUntil: this._restUntil, restWorkoutId: this._restWorkoutId,
      }));
    } catch { /* Storage can be unavailable; in-memory session still works. */ }
  }
  private _restoreSession(): void {
    this._clearRestTimerInterval();
    this._openWorkoutId = null; this._activeExerciseIndex = null; this._draftLogs = {};
    this._restUntil = 0; this._restWorkoutId = null; this._restTimerSecondsLeft = null;
    this._error = ""; this._name = ""; this._draftExercises = []; this._building = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(`gains-session:${this._athleteId}`) || "null");
      if (!saved || typeof saved !== "object") return;
      const workout = this.gainsState.workouts.find(w => w.id === saved.workoutId);
      if (workout) {
        this._openWorkoutId = workout.id;
        if (Number.isInteger(saved.exerciseIndex) && saved.exerciseIndex >= 0 && saved.exerciseIndex < workout.exercises.length) this._activeExerciseIndex = saved.exerciseIndex;
      }
      if (saved.drafts && typeof saved.drafts === "object") {
        for (const [key, value] of Object.entries(saved.drafts)) {
          if (!value || typeof value !== "object") continue;
          const draft = value as DraftLog;
          this._draftLogs[key] = {
            reps: typeof draft.reps === "number" && Number.isFinite(draft.reps) ? draft.reps : undefined,
            weight: typeof draft.weight === "number" && Number.isFinite(draft.weight) ? draft.weight : undefined,
          };
        }
      }
      if (typeof saved.restUntil === "number" && saved.restUntil > Date.now() && saved.restUntil < Date.now() + 86400000 && this.gainsState.workouts.some(w => w.id === saved.restWorkoutId && w.status === "active")) {
        this._restUntil = saved.restUntil; this._restWorkoutId = saved.restWorkoutId;
        this._tickRest();
        this._restTimerIntervalId = window.setInterval(() => this._tickRest(), 1000);
      }
    } catch { /* Ignore corrupt or obsolete session drafts. */ }
  }
  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("_openWorkoutId") || changed.has("_activeExerciseIndex")) {
      this._persistSession();
      this.dispatchEvent(new CustomEvent("gains-page-change", { bubbles: true, composed: true }));
    }
  }
  private async _mutation(action: () => Promise<unknown>): Promise<boolean> {
    if (this._busy) return false;
    this._busy = true; this._error = "";
    try { await action(); return true; }
    catch { this._error = "Could not save. Check your connection and try again."; return false; }
    finally { this._busy = false; }
  }

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      .replacement-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 10px; margin: 12px 0; }
      .replacement-filters label { display: flex; flex-direction: column; gap: 4px; }
      .replacement-filters select { width: 100%; min-width: 0; }
      .exercise-row:disabled { opacity: .65; cursor: default; }
      /* The replace dialog has more controls above its list than the plain
         picker, so a fixed-height flex body left only a row or two of
         results visible. Let the dialog scroll as a whole instead. */
      .replace-body { height: auto; max-height: none; gap: 8px; }
      .replace-body .exercise-results { flex: none; overflow: visible; min-height: 0; }
      .replace-body .filter-chips { margin: 4px 0; }
      .replacement-more-filters summary { cursor: pointer; color: var(--secondary-text-color, #727272); font-size: .9rem; }
      .exercise-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; }
      .exercise-nav .session-progress { margin: 0; text-align: center; flex: 1; }
      .exercise-nav button { display: inline-flex; align-items: center; gap: 2px; }
      .add-exercise-button { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; margin-top: 12px; }
      .history-body { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
      .history-entry { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 12px; padding: 12px; }
      .history-entry-header { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; align-items: baseline; }
      .history-sets { margin: 8px 0; padding-left: 20px; }
      .history-sets li { padding: 2px 0; }
      .history-pr { --mdc-icon-size: 16px; color: var(--warning-color, #ffa600); }

      ha-card.panel {
        padding: 20px;
        margin-bottom: 20px;
        max-width: 640px;
      }
      .exercise-picker {
        margin-top: 12px;
      }
      .picker-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--divider-color, #e0e0e0);
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        font-size: 1rem;
        font-family: inherit;
        cursor: pointer;
        text-align: left;
        transition: border-color 0.15s ease;
      }
      .picker-toggle:hover {
        border-color: var(--primary-color, #03a9f4);
      }
      .picker-toggle ha-icon {
        color: var(--secondary-text-color, #727272);
        flex-shrink: 0;
      }

      /* -- exercise picker dialog (ha-dialog handles the overlay/sizing/
         animation itself; we only style what we slot into it) -- */
      ha-dialog {
        --mdc-dialog-min-width: min(480px, 100vw);
        --mdc-dialog-max-width: min(480px, 100vw);
        --dialog-content-padding: 0;
      }
      .picker-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 16px 12px;
        margin: -12px -16px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .picker-header h2 {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 500;
      }
      .picker-body {
        padding: 12px 16px 16px;
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 70vh;
        max-height: 600px;
        box-sizing: border-box;
      }
      .search-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 12px;
        border-radius: 24px;
        background: var(--secondary-background-color, #f5f5f5);
        flex-shrink: 0;
      }
      .search-row ha-icon {
        color: var(--secondary-text-color, #727272);
        flex-shrink: 0;
      }
      .search-row input {
        border: none;
        padding: 10px 0;
        background: none;
      }
      .filter-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 12px 0;
        position: relative;
        flex-shrink: 0;
      }
      .chip {
        background: var(--secondary-background-color, #f5f5f5);
        border: 1px solid transparent;
        border-radius: 20px;
        padding: 6px 14px;
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        color: var(--primary-text-color, #212121);
        transition: background-color 0.15s ease;
      }
      .chip.active {
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
      }
      .chip-menu {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 1;
        margin-top: 4px;
        max-height: 240px;
        overflow-y: auto;
        min-width: 180px;
        border-radius: 10px;
        border: 1px solid var(--divider-color, #e0e0e0);
        background: var(--card-background-color, #fff);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      }
      .chip-menu button {
        display: block;
        width: 100%;
        box-sizing: border-box;
        text-align: left;
        background: none;
        border: none;
        padding: 10px 14px;
        font-size: 0.9rem;
        cursor: pointer;
        color: var(--primary-text-color, #212121);
      }
      .chip-menu button:hover,
      .chip-menu button.selected {
        background: var(--secondary-background-color, #f5f5f5);
      }
      .exercise-results {
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        margin: 0 -8px;
      }
      .exercise-row {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        box-sizing: border-box;
        text-align: left;
        background: none;
        border: none;
        border-radius: 10px;
        padding: 10px 8px;
        cursor: pointer;
        color: var(--primary-text-color, #212121);
        transition: background-color 0.1s ease;
      }
      .exercise-row:hover {
        background: var(--secondary-background-color, #f5f5f5);
      }
      .exercise-row-swatch {
        width: 4px;
        height: 32px;
        border-radius: 4px;
        flex-shrink: 0;
      }
      .exercise-row-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .exercise-row-name {
        font-weight: 500;
      }
      .exercise-row-sub {
        font-size: 0.8rem;
        color: var(--secondary-text-color, #727272);
      }
      .exercise-controls {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr auto;
        gap: 8px;
        align-items: end;
        margin-top: 12px;
      }
      ul.draft-list,
      ul.workout-list {
        list-style: none;
        margin: 12px 0 0;
        padding: 0;
      }
      ul.draft-list li,
      ul.workout-list li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      /* Each exercise in the workout overview is a clickable row --
         tapping it navigates to that exercise's own dedicated page
         (_renderExerciseDetailPage) rather than expanding inline, so only
         one exercise's set editor is ever on screen at once. */
      .exercise-card-header {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        box-sizing: border-box;
        padding: 14px;
        border: none;
        border-radius: 14px;
        background: var(--card-background-color, #fff);
        cursor: pointer;
        text-align: left;
        font-family: inherit;
      }
      .exercise-list-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }
      .exercise-list-row .exercise-card-header {
        flex: 1;
        min-width: 0;
        border: 1px solid var(--divider-color, #e0e0e0);
      }
      .exercise-card-swatch {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .exercise-card-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .exercise-card-name {
        font-size: 1rem;
        font-weight: 500;
      }
      .exercise-card-summary {
        font-size: 0.85rem;
        color: var(--secondary-text-color, #727272);
      }
      .exercise-card-header ha-icon {
        color: var(--secondary-text-color, #727272);
        flex-shrink: 0;
      }
      .exercise-page-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      .exercise-page-header h2 {
        margin: 0;
      }
      .exercise-page-swatch {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .exercise-page-title {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      /* flex-wrap rather than a fixed grid -- on a narrow phone screen
         there isn't room for "Set N" + reps + weight + effort + a button
         all on one line without truncating their content (the bug this
         replaced: a rigid 5-column grid squeezed every field down to a
         single visible character). Wrapping lets reps/weight/effort keep
         a sane minimum width and pushes Log Set onto its own line
         instead. */
      .set-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        padding: 6px 8px;
        border-radius: 10px;
        border: 1px solid transparent;
        transition:
          opacity 0.15s ease,
          background-color 0.15s ease,
          border-color 0.15s ease;
      }
      .set-row .set-label {
        min-width: 46px;
        flex-shrink: 0;
        font-size: 0.9rem;
        color: var(--secondary-text-color, #727272);
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .set-row .reps-input {
        flex: 1 1 55px;
        min-width: 50px;
      }
      .set-row .weight-input {
        flex: 1 1 85px;
        min-width: 75px;
      }
      /* Already logged -- greyed out so the athlete's eye goes to what's
       * still ahead, not what's done. Dims the label/inputs individually
       * (rather than the whole row's opacity) so the checkmark itself
       * stays full-color -- a quick "yes, this is saved" signal. */
      .set-row.done .set-label {
        color: var(--secondary-text-color, #727272);
        opacity: 0.6;
      }
      .set-row.done .reps-input,
      .set-row.done .weight-input {
        opacity: 0.55;
      }
      .set-row.done .set-status-icon {
        color: #4caf50;
        --mdc-icon-size: 18px;
      }
      .pr-badge-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .pr-badge {
        min-width: 36px;
        min-height: 36px;
        padding: 4px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #d4af37;
        display: inline-grid;
        place-items: center;
      }
      .pr-badge ha-icon {
        --mdc-icon-size: 23px;
      }
      .pr-badge:hover {
        background: color-mix(in srgb, #d4af37 14%, transparent);
      }
      .pr-tooltip {
        position: absolute;
        right: 0;
        bottom: calc(100% + 8px);
        z-index: 30;
        width: max-content;
        max-width: min(290px, 78vw);
        padding: 9px 11px;
        border-radius: 9px;
        background: var(--primary-text-color, #212121);
        color: var(--card-background-color, #fff);
        font-size: 12px;
        font-weight: 600;
        line-height: 1.35;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.24);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transform: translateY(4px);
        transition: opacity 0.12s ease, transform 0.12s ease, visibility 0.12s ease;
      }
      .pr-badge-wrap:hover .pr-tooltip,
      .pr-badge-wrap:focus-within .pr-tooltip,
      .pr-badge-wrap.open .pr-tooltip {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
        transform: translateY(0);
      }
      /* The set the athlete should log right now -- an accent border/tint
       * so it visibly pops against the dimmed completed rows and the
       * plain not-yet-reached ones. */
      .set-row.active {
        background: color-mix(in srgb, var(--primary-color, #03a9f4) 12%, transparent);
        border-color: color-mix(in srgb, var(--primary-color, #03a9f4) 50%, transparent);
      }
      .set-row.active .set-label {
        color: var(--primary-color, #03a9f4);
        font-weight: 700;
      }
      .rest-timer-banner {
        background: color-mix(in srgb, var(--primary-color, #03a9f4) 15%, transparent);
        border: 1px solid color-mix(in srgb, var(--primary-color, #03a9f4) 45%, transparent);
      }
      .rest-timer-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .rest-timer-label {
        font-weight: 600;
        color: var(--primary-color, #03a9f4);
      }
      .rest-timer-countdown {
        font-size: 1.6rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--primary-color, #03a9f4);
      }
      .log-set-button {
        width: 100%;
        box-sizing: border-box;
        margin-top: 4px;
      }
      .timed-log-actions {
        display: grid;
        grid-template-columns: minmax(92px, .38fr) minmax(0, 1fr);
        gap: 10px;
        margin-top: 4px;
      }
      .timed-log-actions .log-set-button {
        margin-top: 0;
      }
      .timer-launch-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 50px;
      }
      .timer-launch-button ha-icon {
        --mdc-icon-size: 21px;
      }
      ha-dialog.timed-set-dialog {
        --mdc-dialog-min-width: min(430px, calc(100vw - 24px));
        --mdc-dialog-max-width: min(430px, calc(100vw - 24px));
      }
      .timed-set-modal {
        padding: 10px 18px 20px;
      }
      .timed-set-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 16px;
      }
      .timed-set-header h2 {
        margin: 2px 0 0;
        font-size: 22px;
      }
      .timed-set-header p {
        margin: 0;
      }
      .timed-set-adjust {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: end;
        gap: 8px;
        margin: 20px 0;
      }
      .timed-set-adjust label {
        margin: 0;
        text-align: center;
        color: var(--secondary-text-color, #727272);
        font-size: 12px;
      }
      .timed-set-adjust input {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        margin-top: 6px;
        padding: 12px 8px;
        text-align: center;
        font-size: 28px;
        font-weight: 750;
        font-variant-numeric: tabular-nums;
      }
      .timed-set-adjust button {
        min-height: 52px;
      }
      .timed-set-start {
        width: 100%;
        min-height: 52px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      .timed-set-countdown {
        min-height: 250px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      .timed-set-countdown strong {
        font-size: clamp(78px, 24vw, 132px);
        line-height: .9;
        letter-spacing: -5px;
        font-variant-numeric: tabular-nums;
        color: var(--primary-color, #03a9f4);
      }
      .timed-set-countdown.starting strong {
        color: var(--warning-color, #f0a02f);
      }
      .timed-set-countdown > ha-icon {
        color: var(--gains-success, #167750);
        --mdc-icon-size: 70px;
        margin-bottom: 16px;
      }
      .timed-set-phase {
        margin-bottom: 12px;
        color: var(--secondary-text-color, #727272);
        font-size: 18px;
        font-weight: 650;
      }
      .timed-set-unit {
        margin-top: 10px;
        color: var(--secondary-text-color, #727272);
        font-size: 14px;
      }
      .timed-set-cancel {
        width: 100%;
        min-height: 48px;
      }
      .effort-prompt-body {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        padding: 16px;
      }
      .effort-prompt-body button {
        padding: 14px;
        font-size: 1rem;
        text-transform: capitalize;
      }
      .video-modal-body gains-muscle-map { width: 100%; }
      .video-modal-body {
        padding: 12px 16px 16px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      .video-embed-wrapper {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        border-radius: 10px;
        overflow: hidden;
      }
      .video-embed-wrapper iframe {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: none;
      }
      .button-link {
        text-decoration: none;
        width: 100%;
      }
      .button-link button {
        width: 100%;
        box-sizing: border-box;
      }
      ha-dialog.recap-dialog {
        --mdc-dialog-min-width: min(680px, 100vw);
        --mdc-dialog-max-width: min(680px, 100vw);
      }
      .recap {
        max-height: min(82vh, 780px);
        overflow-y: auto;
        padding: 4px 18px 22px;
      }
      .recap-hero {
        position: relative;
        margin: 0 -18px 18px;
        padding: 24px 22px 22px;
        overflow: hidden;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        background:
          radial-gradient(circle at 85% 0%, color-mix(in srgb, var(--primary-color) 22%, transparent), transparent 42%),
          var(--card-background-color, #fff);
      }
      .recap-kicker {
        margin: 0 0 6px;
        color: var(--gains-success, #167750);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: .12em;
        text-transform: uppercase;
      }
      .recap-hero h2 {
        margin: 0;
        font-size: clamp(28px, 7vw, 42px);
        letter-spacing: -1.2px;
        line-height: 1.03;
      }
      .recap-hero .muted {
        margin: 8px 0 0;
      }
      .recap-close {
        position: absolute;
        top: 14px;
        right: 14px;
      }
      .recap-message {
        margin: 14px 0 0;
        max-width: 520px;
        font-size: 15px;
        line-height: 1.45;
      }
      .recap-stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 18px;
      }
      .recap-stat {
        min-width: 0;
        padding: 13px;
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 14px;
        background: var(--secondary-background-color, #f5f5f5);
      }
      .recap-stat strong {
        display: block;
        margin-top: 4px;
        font-size: 20px;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
      }
      .recap-stat span {
        color: var(--secondary-text-color, #727272);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .05em;
      }
      .recap-section {
        margin: 22px 0;
      }
      .recap-section h3 {
        margin: 0 0 10px;
        font-size: 18px;
      }
      .recap-highlight {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 14px;
        border: 1px solid color-mix(in srgb, #d4af37 46%, var(--divider-color));
        border-radius: 14px;
        background: color-mix(in srgb, #d4af37 10%, var(--card-background-color));
      }
      .recap-highlight ha-icon {
        flex-shrink: 0;
        color: #d4af37;
        --mdc-icon-size: 26px;
      }
      .recap-highlight strong {
        display: block;
        margin-bottom: 3px;
      }
      .recap-chart {
        padding: 14px;
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 16px;
        background: var(--secondary-background-color, #f5f5f5);
      }
      .recap-chart-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
      }
      .recap-chart-header strong {
        font-size: 14px;
      }
      .recap-chart-header span {
        color: var(--secondary-text-color, #727272);
        font-size: 12px;
      }
      .recap-chart svg {
        display: block;
        width: 100%;
        height: 116px;
        overflow: visible;
      }
      .recap-chart-grid {
        stroke: var(--divider-color, #d8dde5);
        stroke-width: 1;
      }
      .recap-chart-line {
        fill: none;
        stroke: var(--primary-color, #03a9f4);
        stroke-width: 3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .recap-chart-dot {
        fill: var(--card-background-color, #fff);
        stroke: var(--primary-color, #03a9f4);
        stroke-width: 3;
      }
      .recap-exercises {
        display: grid;
        gap: 10px;
      }
      .recap-exercise {
        padding: 14px;
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 16px;
        background: var(--card-background-color, #fff);
      }
      .recap-exercise-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }
      .recap-exercise h4 {
        margin: 0;
        font-size: 16px;
      }
      .recap-pr {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
        color: #d4af37;
        font-size: 12px;
        font-weight: 800;
      }
      .recap-pr ha-icon {
        --mdc-icon-size: 19px;
      }
      .recap-set-list {
        margin: 8px 0;
        color: var(--secondary-text-color, #727272);
        font-size: 13px;
        line-height: 1.5;
      }
      .recap-exercise-metrics {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        margin-top: 8px;
        font-size: 13px;
      }
      .recap-exercise-metrics strong {
        color: var(--primary-text-color, #212121);
      }
      .recap-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }
      .recap-chip {
        padding: 5px 8px;
        border-radius: 999px;
        background: var(--gains-success-bg, #eef8f2);
        color: var(--gains-success, #167750);
        font-size: 11px;
        font-weight: 750;
      }
      .recap-chip.pr {
        background: color-mix(in srgb, #d4af37 14%, var(--card-background-color));
        color: #a57d00;
      }
      .recap-next {
        padding: 14px;
        border-left: 4px solid var(--primary-color, #03a9f4);
        border-radius: 10px;
        background: var(--gains-tint, #edf3ff);
        line-height: 1.45;
      }
      .recap-actions {
        position: sticky;
        bottom: -22px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin: 20px -18px -22px;
        padding: 12px 18px max(14px, env(safe-area-inset-bottom));
        border-top: 1px solid var(--divider-color, #e0e0e0);
        background: var(--card-background-color, #fff);
      }
      .recap-actions .primary {
        grid-column: 1 / -1;
      }
      @media (max-width: 520px) {
        .recap {
          max-height: 86vh;
          padding-left: 14px;
          padding-right: 14px;
        }
        .recap-hero {
          margin-left: -14px;
          margin-right: -14px;
        }
        .recap-stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .recap-actions {
          margin-left: -14px;
          margin-right: -14px;
          padding-left: 14px;
          padding-right: 14px;
        }
      }
    `,
    css`
      .library{max-width:1000px}.library-header{display:flex;justify-content:space-between;align-items:center;gap:12px}.library h1{font-size:30px;margin:0;letter-spacing:-1px}
      .segments{display:flex;gap:5px;border-radius:12px;background:var(--secondary-background-color);padding:4px;margin:20px 0}.segments button{flex:1;border:0;background:none;padding:10px 8px;border-radius:9px;color:var(--secondary-text-color)}.segments button[aria-pressed="true"]{background:var(--card-background-color);color:var(--primary-text-color);font-weight:600}
      .library-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(290px,100%),1fr));gap:15px}.workout-tile{border:1px solid var(--divider-color);border-radius:18px;background:var(--card-background-color);padding:20px;text-align:left;display:grid;grid-template-columns:1fr 70px;align-items:center;gap:10px;color:var(--primary-text-color)}.workout-tile h2{font-size:20px;margin:10px 0 6px}.workout-tile p{margin:4px 0}.library-empty{padding:24px;text-align:center}
      .error-banner{color:var(--error-color,#b91c1c);padding:12px;border:1px solid currentColor;border-radius:10px;margin:12px 0}
      .overview{max-width:1000px}.overview-grid{display:grid;gap:22px}.summary-stats{display:flex;gap:22px;margin:14px 0;color:var(--secondary-text-color);font-size:13px}.summary-stats strong{font-size:24px;display:block;color:var(--primary-text-color)}
      .compact-workout-overview{max-width:820px;margin:0 auto;padding:4px 0 24px}
      .workout-overview-header{display:grid;grid-template-columns:44px minmax(0,1fr);align-items:start;gap:12px;margin:4px 0 8px}
      .overview-back{margin-top:1px}
      .workout-overview-title{min-width:0}.workout-overview-title h1{margin:0 0 8px;font-size:32px;line-height:1.05;letter-spacing:-1.1px}
      .compact-summary{margin:8px 0 20px;padding-left:56px;gap:24px}.compact-summary strong{font-size:20px}
      .target-muscle-section{margin:0 0 22px}.target-muscle-section h2,.workout-exercises-section h2{margin:0;font-size:19px;letter-spacing:-.35px}
      .target-muscle-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}
      .target-muscle-card{min-width:0;display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--divider-color);border-radius:14px;background:var(--card-background-color)}
      .target-muscle-thumbnail{width:48px;flex:0 0 48px;--gains-compact-muscle-width:42px;--gains-compact-muscle-height:52px}
      .target-muscle-copy{display:grid;gap:2px;min-width:0}.target-muscle-copy strong{font-size:12px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.target-muscle-copy span{font-size:12px;font-weight:800;color:var(--gains-success,var(--primary-color))}
      .workout-exercises-section{margin-top:6px}.workout-section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
      .exercise-overview-list{display:grid;gap:6px}
      .workout-overview-actions{display:flex;gap:8px;margin-top:14px}.workout-overview-actions .primary{flex:1}
      .workout-secondary-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px}.workout-secondary-actions button{min-height:40px;padding:8px 12px}.danger-text{color:var(--error-color,#d14343)!important}
      .finish-warning{margin-top:12px;padding:12px;border:1px solid var(--warning-color,#d78a1f);border-radius:12px;background:color-mix(in srgb,var(--warning-color,#d78a1f) 8%,transparent)}.finish-warning p{margin:0 0 10px}
      .exercise-page-title h2{font-size:26px;line-height:1.15;letter-spacing:-.7px}.exercise-page-swatch,.exercise-card-swatch{display:none}
      .set-grid-header{display:grid;grid-template-columns:52px minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:end;padding:0 10px 7px;margin-top:16px;color:var(--secondary-text-color);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;text-align:center}
      .set-grid-header.with-loading{grid-template-columns:52px minmax(0,1fr) minmax(0,1fr) 54px}
      .set-row.gravl-set-row{box-sizing:border-box;display:grid;grid-template-columns:52px minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:center;border:1px solid transparent;border-radius:14px;padding:8px;background:var(--secondary-background-color);margin-bottom:8px}
      .set-row.gravl-set-row.with-loading{grid-template-columns:52px minmax(0,1fr) minmax(0,1fr) 54px}
      .set-row.gravl-set-row.active{border-color:var(--primary-color);background:var(--gains-tint)}
      .set-row.gravl-set-row.done{background:var(--gains-success-bg)}
      .set-number-box{height:54px;border-radius:12px;display:grid;place-items:center;background:var(--card-background-color);font-size:18px;font-weight:750;font-variant-numeric:tabular-nums}
      .set-field{margin:0}.set-field input{box-sizing:border-box;min-width:0!important;width:100%;height:54px;margin:0!important;padding:8px;text-align:center;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;border-radius:12px}
      .set-field input:disabled{opacity:.84}
      .set-readonly-value{height:54px;border-radius:12px;display:grid;place-items:center;background:var(--card-background-color);font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
      .set-loading-button{width:54px;height:54px;padding:0;border:0;border-radius:12px;background:var(--card-background-color);color:var(--primary-text-color);display:grid;place-items:center;cursor:pointer}
      .set-loading-button:hover{background:color-mix(in srgb,var(--primary-color) 9%,var(--card-background-color))}
      .mini-barbell-icon{position:relative;display:block;width:34px;height:4px;border-radius:99px;background:currentColor;opacity:.92}
      .mini-barbell-icon::before,.mini-barbell-icon::after{content:"";position:absolute;top:50%;width:5px;height:22px;border-radius:2px;background:currentColor;transform:translateY(-50%);box-shadow:6px 0 0 -1px currentColor}
      .mini-barbell-icon::before{left:5px}.mini-barbell-icon::after{right:10px;transform:translateY(-50%) scaleX(-1)}
      .set-tools,.set-row-meta{grid-column:1/-1;display:flex;justify-content:flex-end;align-items:center;gap:8px}.set-row-meta{min-height:24px;padding:0 4px}.set-row-meta .set-status-icon{margin-right:auto;color:var(--gains-success)}
      .set-remove-button{width:34px;height:34px;padding:0;border:0;border-radius:10px;background:transparent;color:var(--secondary-text-color);display:grid;place-items:center;cursor:pointer}.set-remove-button:hover{background:color-mix(in srgb,var(--error-color,#d14343) 12%,transparent);color:var(--error-color,#d14343)}.set-remove-button ha-icon{--mdc-icon-size:20px}.set-row.swipe-remove{touch-action:pan-y}
      .visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
      ha-dialog.loading-picker-dialog{--mdc-dialog-min-width:min(460px,calc(100vw - 18px));--mdc-dialog-max-width:min(460px,calc(100vw - 18px))}
      .loading-picker-sheet{padding:6px 18px 22px}.loading-picker-handle{width:54px;height:5px;border-radius:99px;background:var(--divider-color);margin:0 auto 16px}
      .loading-picker-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;text-align:center}.loading-picker-header>div{flex:1}.loading-picker-header h2{font-size:40px;line-height:1;margin:4px 0 8px;letter-spacing:-1.5px}.loading-picker-header p{margin:0}.loading-per-side{color:var(--secondary-text-color)}
      .barbell-loading-visual{height:146px;display:flex;align-items:center;justify-content:center;padding:8px 10px;overflow:hidden}.barbell-shaft{height:7px;flex:1;min-width:72px;max-width:220px;border-radius:99px;background:linear-gradient(180deg,#d9d9d9,#9b9b9b 52%,#c9c9c9)}.barbell-sleeve{width:28px;height:14px;flex:0 0 28px;background:linear-gradient(180deg,#d7d7d7,#9f9f9f 55%,#c7c7c7);border-radius:4px}.barbell-collar{width:7px;height:50px;flex:0 0 7px;border-radius:3px;background:#8e8e8e;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}.barbell-plate-stack{display:flex;align-items:center;flex:0 0 auto;min-width:0}.barbell-plate-stack.left{justify-content:flex-end}.barbell-plate-stack.right{justify-content:flex-start}.barbell-loaded-plate{display:block;flex:0 0 var(--bar-plate-width,9px);width:var(--bar-plate-width,9px);height:var(--bar-plate-height,56px);margin:0 1px;border-radius:3px;background:linear-gradient(90deg,color-mix(in srgb,var(--plate-color) 76%,#000),var(--plate-color) 38%,color-mix(in srgb,var(--plate-color) 82%,#fff) 62%,color-mix(in srgb,var(--plate-color) 72%,#000));border:1px solid var(--plate-outline,rgba(0,0,0,.18));box-sizing:border-box;box-shadow:0 1px 2px rgba(0,0,0,.28)}
      .loading-status{display:flex;align-items:center;justify-content:center;gap:8px;min-height:36px;font-weight:650}.loading-status.exact{color:var(--gains-success)}.loading-status.warning{color:var(--warning-color,var(--primary-color))}.loading-status ha-icon{--mdc-icon-size:21px}
      .loading-section{padding:16px 0;border-top:1px solid var(--divider-color)}.loading-section-title{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:12px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
      .plate-loadout-chips{display:flex;gap:8px;flex-wrap:wrap}.plate-loadout-chip{display:inline-flex;align-items:center;gap:8px;padding:9px 12px;border-radius:999px;background:var(--secondary-background-color);font-weight:650}.plate-disc{position:relative;display:inline-block;width:24px;height:24px;border-radius:50%;background:var(--plate-color,#69727D);border:1px solid var(--plate-outline,transparent);box-sizing:border-box;box-shadow:inset 0 0 0 6px var(--plate-color,#69727D),inset 0 0 0 8px color-mix(in srgb,var(--plate-color,#69727D) 72%,#000)}.plate-disc::after{content:"";position:absolute;inset:50% auto auto 50%;width:5px;height:5px;border-radius:50%;background:#69727D;transform:translate(-50%,-50%);box-shadow:0 0 0 1px rgba(0,0,0,.28)}
      .available-plate-row{display:flex;gap:10px;overflow-x:auto;padding-bottom:2px}.available-plate{min-width:48px;display:grid;justify-items:center;gap:4px;color:var(--secondary-text-color)}.available-plate .plate-disc{width:38px;height:38px;box-shadow:inset 0 0 0 10px var(--plate-color,#69727D),inset 0 0 0 12px color-mix(in srgb,var(--plate-color,#69727D) 72%,#000)}.available-plate .plate-disc::after{width:7px;height:7px}.available-plate small{font-size:11px;font-weight:700}.available-plate .plate-inventory-count{font-size:9px;font-weight:650;white-space:nowrap;opacity:.8}
      .bar-choice-list{display:grid;gap:8px}.bar-choice-row{width:100%;display:grid;grid-template-columns:40px minmax(0,1fr) 24px;align-items:center;gap:10px;padding:12px;border:1px solid var(--divider-color);border-radius:12px;background:var(--card-background-color);color:var(--primary-text-color);text-align:left;font:inherit}.bar-choice-row>span:nth-child(2){display:grid;gap:2px}.bar-choice-row small{color:var(--secondary-text-color)}.bar-choice-row.active{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 10%,var(--card-background-color))}.bar-choice-row.active>ha-icon:last-child{color:var(--primary-color)}.bar-choice-row.static{cursor:default}
      .set-swipe-delete-lane{display:none}
      @media(min-width:521px){.set-swipe-shell{display:contents}}
      .set-row.done .set-status-icon{color:var(--gains-success)}.rest-timer-countdown{font-variant-numeric:tabular-nums;font-size:30px}.rest-timer-row{flex-wrap:wrap}.rest-timer-banner{background:var(--card-background-color);margin:18px 0 10px!important}.log-set-button{min-height:50px}.exercise-card-header{color:var(--primary-text-color)}
      .exercise-list-row{display:flex;flex-wrap:nowrap;gap:2px;width:100%;border:0;border-radius:14px;background:transparent;overflow:hidden}
      .exercise-list-row .exercise-card-header{display:grid;grid-template-columns:58px minmax(0,1fr) 18px;gap:10px;flex:1;min-width:0;padding:7px 4px 7px 2px;border:0;background:transparent}
      .exercise-list-row:hover{background:color-mix(in srgb,var(--primary-color) 5%,transparent)}
      .exercise-thumbnail{width:58px;--gains-compact-muscle-width:50px;--gains-compact-muscle-height:58px}.exercise-card-name{font-size:15px;font-weight:700;line-height:1.25}.exercise-card-summary{font-size:12px;line-height:1.35;color:var(--secondary-text-color)}.exercise-card-progress{font-size:11px;line-height:1.2;color:var(--primary-color);font-weight:700}
      .exercise-menu-trigger{align-self:center;width:40px;min-width:40px;height:40px;border:0;border-radius:12px;background:var(--secondary-background-color);color:var(--secondary-text-color);display:grid;place-items:center}.exercise-menu-trigger ha-icon{--mdc-icon-size:20px}
      .exercise-menu{display:grid;gap:10px;padding:12px 16px 20px}.exercise-menu button{width:100%;text-align:left;display:flex;align-items:center;gap:12px;justify-content:flex-start}.exercise-menu .danger{color:var(--error-color,#d14343)}
      .set-edit{min-height:34px!important;padding:5px 10px!important}
      .session-progress{font-size:12px;margin:10px 0;color:var(--secondary-text-color)}
      @media(max-width:520px){
        ha-card.panel{padding:16px}.overview-grid{gap:14px}.summary-stats{gap:14px}.summary-stats strong{font-size:20px}
        .compact-workout-overview{padding-top:0}.workout-overview-header{grid-template-columns:38px minmax(0,1fr);gap:10px}.workout-overview-title h1{font-size:28px}.compact-summary{padding-left:48px;margin-top:4px;gap:18px}.compact-summary strong{font-size:18px}
        .target-muscle-strip{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.target-muscle-card{padding:7px}.target-muscle-thumbnail{width:44px;flex-basis:44px;--gains-compact-muscle-width:40px;--gains-compact-muscle-height:48px}
        .exercise-overview-list{gap:3px}.exercise-list-row .exercise-card-header{grid-template-columns:54px minmax(0,1fr) 16px;padding-left:0}.exercise-thumbnail{width:54px;--gains-compact-muscle-width:48px;--gains-compact-muscle-height:56px}
        .workout-overview-actions{position:static;padding:8px 0 0;background:none}.workout-secondary-actions{justify-content:flex-start}
        .set-row.gravl-set-row{grid-template-columns:46px minmax(0,1fr) minmax(0,1fr)}.set-row.gravl-set-row.with-loading{grid-template-columns:46px minmax(0,1fr) minmax(0,1fr) 48px}.set-grid-header{grid-template-columns:46px minmax(0,1fr) minmax(0,1fr)}.set-grid-header.with-loading{grid-template-columns:46px minmax(0,1fr) minmax(0,1fr) 48px}.set-number-box,.set-field input,.set-readonly-value,.set-loading-button{height:50px}.set-loading-button{width:48px}.set-remove-button{display:none}
        .set-swipe-shell{position:relative;overflow:hidden;border-radius:10px;margin-bottom:12px}
        .set-swipe-shell .set-row{position:relative;z-index:1;margin-bottom:0;transition:transform .18s ease;will-change:transform}
        .set-swipe-shell.swiping .set-row{transition:none}
        .set-swipe-shell.deleting .set-row{transition:transform .18s ease-in}
        .set-swipe-shell .set-row:not(.active){background:var(--card-background-color,#fff)}
        .set-swipe-shell .set-row.active{background:var(--gains-tint)}
        .set-swipe-delete-lane{position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 20px;background:var(--error-color,#d14343);color:#fff;font-size:13px;font-weight:800;letter-spacing:.01em;box-sizing:border-box}
        .set-swipe-delete-lane ha-icon{--mdc-icon-size:21px}
        .set-swipe-shell.armed .set-swipe-delete-lane{background:#b42318}
      }
      @media(min-width:900px){.overview-grid{grid-template-columns:1fr 1fr}.target-muscle-strip{grid-template-columns:repeat(4,minmax(0,1fr))}}
    `,
    workoutSurfaceStyles,
  ];

  protected willUpdate(changedProps: Map<string, unknown>): void {
    const previous = changedProps.get("gainsState") as GainsState | undefined;
    if (previous) {
      // A remote coach/athlete edit wins over a stale locally cached target.
      for (const workout of this.gainsState.workouts) {
        const old = previous.workouts.find(w => w.id === workout.id);
        if (!old || old.revision === workout.revision) continue;
        workout.exercises.forEach((exercise, ei) => exercise.sets.forEach((set, si) => {
          const before = old.exercises[ei]?.sets[si];
          if (!before || before.plannedWeight !== set.plannedWeight ||
              before.plannedReps !== set.plannedReps || before.completed !== set.completed ||
              old.exercises[ei]?.exerciseId !== exercise.exerciseId) {
            delete this._draftLogs[`${workout.id}:${ei}:${si}`];
          }
        }));
      }
    }
    const athleteId = this.gainsState.profile?.profileId ?? null;
    const current=this.gainsState.workouts.find(w=>w.id===this._openWorkoutId);
    if(current?.status==="active") {
      const focus=current.id+":"+current.currentExerciseIndex;
      if(this._lastFocus && focus!==this._lastFocus)this._activeExerciseIndex=current.currentExerciseIndex??0;
      this._lastFocus=focus;
    }
    if (athleteId !== this._athleteId) { this._athleteId = athleteId; this._restoreSession(); }

    if (changedProps.has("requestOpenWorkoutId") && this.requestOpenWorkoutId) {
      this._openWorkoutId = this.requestOpenWorkoutId;
      this._activeExerciseIndex = null;
    }
  }

  private get _filteredExercises(): typeof EXERCISE_LIBRARY {
    const search = this._search.trim().toLowerCase();
    return EXERCISE_LIBRARY.filter((ex) => {
      if (this._categoryFilter && ex.category !== this._categoryFilter) return false;
      if (this._equipmentFilter && ex.equipment !== this._equipmentFilter) return false;
      if (search && !ex.name.toLowerCase().includes(search)) return false;
      return true;
    });
  }

  private _toggleChipMenu(menu: ChipMenu): void {
    this._openChipMenu = this._openChipMenu === menu ? null : menu;
  }

  private _selectExercise(exerciseId: string): void {
    const addingTo = this._addingToWorkout;
    if (addingTo) void this._addExerciseToWorkout(addingTo, exerciseId);
    else this._pendingExerciseId = exerciseId;
    this._addingToWorkout = null;
    this._pickerOpen = false;
    this._openChipMenu = null;
    this._search = "";
  }

  private _renderChipMenu(
    options: string[],
    current: string | null,
    onSelect: (value: string | null) => void
  ) {
    return html`
      <div class="chip-menu">
        <button class=${current === null ? "selected" : ""} @click=${() => onSelect(null)}>
          All
        </button>
        ${options.map(
          (option) => html`
            <button
              class=${current === option ? "selected" : ""}
              @click=${() => onSelect(option)}
            >
              ${labelize(option)}
            </button>
          `
        )}
      </div>
    `;
  }

  private _closePicker(): void {
    this._pickerOpen = false;
    this._addingToWorkout = null;
    this._openChipMenu = null;
    this._search = "";
  }

  private _renderPickerDialog() {
    const results = this._filteredExercises;
    return html`
      <ha-dialog
        .open=${this._pickerOpen}
        hideActions
        @closed=${() => this._closePicker()}
      >
        <div class="picker-header">
          <button class="icon-button" @click=${() => this._closePicker()}>
            <ha-icon icon="mdi:arrow-left"></ha-icon>
          </button>
          <h2>${this._addingToWorkout ? `Add to ${this._addingToWorkout.name}` : "Choose Exercise"}</h2>
        </div>
        <div class="picker-body">
          <div class="search-row">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input
              type="text"
              placeholder="Search"
              .value=${this._search}
              @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="filter-chips">
            <button
              class="chip ${this._categoryFilter ? "active" : ""}"
              @click=${() => this._toggleChipMenu("category")}
            >
              ${this._categoryFilter ? labelize(this._categoryFilter) : "Muscle"}
            </button>
            ${this._openChipMenu === "category"
              ? this._renderChipMenu(CATEGORY_OPTIONS, this._categoryFilter, (value) => {
                  this._categoryFilter = value;
                  this._openChipMenu = null;
                })
              : ""}
            <button
              class="chip ${this._equipmentFilter ? "active" : ""}"
              @click=${() => this._toggleChipMenu("equipment")}
            >
              ${this._equipmentFilter ? labelize(this._equipmentFilter) : "Equipment"}
            </button>
            ${this._openChipMenu === "equipment"
              ? this._renderChipMenu(EQUIPMENT_OPTIONS, this._equipmentFilter, (value) => {
                  this._equipmentFilter = value;
                  this._openChipMenu = null;
                })
              : ""}
          </div>
          <div class="exercise-results">
            ${results.length === 0 ? html`<p class="muted">No matches.</p>` : ""}
            ${results.map(
              (ex) => html`
                <button class="exercise-row" @click=${() => this._selectExercise(ex.id)}>
                  <span
                    class="exercise-row-swatch"
                    style="background: ${categoryColor(ex.category)}"
                  ></span>
                  <span class="exercise-row-text">
                    <span class="exercise-row-name">${ex.name}</span>
                    <span class="exercise-row-sub"
                      >${labelize(ex.category)} &middot; ${labelize(ex.equipment)}${ex.isTimed
                        ? " \u00b7 Timed"
                        : ""}</span
                    >
                  </span>
                </button>
              `
            )}
          </div>
        </div>
      </ha-dialog>
    `;
  }

  private _addExerciseToDraft(): void {
    this._draftExercises = [
      ...this._draftExercises,
      {
        exerciseId: this._pendingExerciseId,
        sets: this._pendingSets,
        reps: this._pendingReps,
        weight: this._pendingWeight,
      },
    ];
  }

  private _removeDraftExercise(index: number): void {
    this._draftExercises = this._draftExercises.filter((_, i) => i !== index);
  }

  private async _createWorkout(): Promise<void> {
    if (!this._name.trim() || this._draftExercises.length === 0) return;
    this._busy = true;
    try {
      await gainsApi.createWorkout(
        this.hass,
        this._name.trim(),
        this._draftExercises.map((d) => ({
          exerciseId: d.exerciseId,
          sets: Array.from({ length: d.sets }, () => ({ reps: d.reps, weight: d.weight })),
        }))
      );
      this._name = "";
      this._draftExercises = [];
      this._building = false;
    } catch { this._error = "Workout was not created. Please retry."; } finally {
      this._busy = false;
    }
  }

  private async _startWorkout(workoutId: string): Promise<void> {
    if (await this._mutation(() => gainsApi.startWorkout(this.hass, workoutId))) {
      this._openWorkoutId = workoutId; this._activeExerciseIndex = 0;
    }
  }

  private async _skipWorkout(workoutId: string): Promise<void> {
    await this._mutation(() => gainsApi.skipWorkout(this.hass, workoutId));
  }

  private async _deleteWorkout(workoutId: string, name: string): Promise<void> {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    if (await this._mutation(() => gainsApi.deleteWorkout(this.hass, workoutId))) {
      if (this._openWorkoutId === workoutId) this._openWorkoutId = null;
    }
  }

  private async _shareWorkout(targetProfileId: string): Promise<void> {
    const workout = this._sharingWorkout;
    if (!workout) return;
    this._shareBusy = true;
    try {
      await gainsApi.shareWorkout(this.hass, workout.id, targetProfileId);
      this._sharingWorkout = null;
      const recipient = this.gainsState.profile?.shareTargets.find(p=>p.profileId===targetProfileId);
      this._shareNotice = `Workout invite sent to ${recipient?.displayName ?? "the recipient"}. They can accept it in Workouts.`;
    } catch(e) {
      this._error = serviceErrorMessage(e);
    } finally {
      this._shareBusy = false;
    }
  }

  private async _completeWorkout(): Promise<void> {
    const workout = this.gainsState.workouts.find(w => w.id === this._openWorkoutId);
    if (!workout || workout.status !== "active") return;
    const remaining = workout.exercises.reduce((n,e) => n + e.sets.filter(s => !s.completed).length, 0);
    if (remaining && !this._finishConfirm) { this._finishConfirm = true; return; }
    if (await this._mutation(() => gainsApi.completeWorkout(this.hass,workout.id))) {
      this._finishConfirm = false;
      this._activeExerciseIndex = null;
      this._recapWorkoutId = workout.id;
      this._recapCompletedAt = new Date().toISOString();
      this._skipRestTimer();
    }
  }

  private async _removeExercise(
    workout: Workout,
    exerciseIndex: number,
    exerciseId: string
  ): Promise<void> {
    const together = isJointParticipant(workout.jointSession, workout.profileId);
    if (!window.confirm(together
      ? `Remove ${exerciseName(exerciseId)} for everyone in this Workout Together session?`
      : `Remove ${exerciseName(exerciseId)} from this workout?`)) return;
    if (!(await this._sessionEdit(workout, "remove_exercise", { exercise_index: exerciseIndex }))) return;
    this._draftLogs = Object.fromEntries(Object.entries(this._draftLogs).flatMap(([key, draft]) => {
      if (!key.startsWith(`${workout.id}:`)) return [[key, draft]];
      const [, rawIndex, rawSet] = key.split(":");
      const index = Number(rawIndex);
      if (index === exerciseIndex) return [];
      return [[index > exerciseIndex ? `${workout.id}:${index - 1}:${rawSet}` : key, draft]];
    }));
    this._persistSession();
  }

  private _openReplacePicker(workout: Workout, exerciseIndex: number, exerciseId: string): void {
    this._replacementFilters = { search: "", muscle: "", equipment: "", movement: "", mode: "recommended", showUnavailable: false };
    this._replacingExercise = {
      workout,
      exerciseIndex,
      category: exerciseCategory(exerciseId),
      currentExerciseId: exerciseId,
    };
  }

  private async _selectReplacementExercise(newExerciseId: string): Promise<void> {
    const target = this._replacingExercise;
    if (!target) return;
    try {
      await gainsApi.replaceExercise(this.hass, target.workout.id, target.exerciseIndex, newExerciseId);
      const inserted = target.workout.exercises[target.exerciseIndex].sets.some(s => s.completed);
      this._draftLogs = Object.fromEntries(Object.entries(this._draftLogs).flatMap(([key, draft]) => {
        if (!key.startsWith(`${target.workout.id}:`)) return [[key, draft]];
        const [, rawIndex] = key.split(":");
        const index = Number(rawIndex);
        if (index === target.exerciseIndex) return [];
        return [[inserted && index > target.exerciseIndex ? key.replace(`:${index}:`, `:${index + 1}:`) : key, draft]];
      }));
      this._replacingExercise = null;
    } catch (err) {
      this._error = serviceErrorMessage(err);
    }
  }

  private _updateDraftLog(key: string, patch: DraftLog): void {
    this._draftLogs[key] = { ...this._draftLogs[key], ...patch };
    this._persistSession();
  }

  private _startSetSwipe(event: TouchEvent, key: string): void {
    if (!window.matchMedia("(max-width: 520px)").matches || this._setSwipeDeletingKey) return;
    const touch = event.touches[0];
    if (!touch) return;
    this._setSwipeStart[key] = { x: touch.clientX, y: touch.clientY };
    this._setSwipeOffsets = { ...this._setSwipeOffsets, [key]: 0 };
  }

  private _moveSetSwipe(event: TouchEvent, key: string): void {
    const start = this._setSwipeStart[key];
    if (!start || !window.matchMedia("(max-width: 520px)").matches || this._setSwipeDeletingKey) return;
    const touch = event.touches[0];
    if (!touch) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (dx >= 0) {
      if (this._setSwipeOffsets[key]) {
        this._setSwipeOffsets = { ...this._setSwipeOffsets, [key]: 0 };
      }
      return;
    }

    const horizontalIntent = Math.abs(dx) > Math.abs(dy) * 1.1;
    if (!horizontalIntent) return;

    event.preventDefault();
    const offset = Math.max(-168, dx);
    this._setSwipeOffsets = { ...this._setSwipeOffsets, [key]: offset };
  }

  private _cancelSetSwipe(key: string): void {
    delete this._setSwipeStart[key];
    if ((this._setSwipeOffsets[key] ?? 0) !== 0) {
      this._setSwipeOffsets = { ...this._setSwipeOffsets, [key]: 0 };
    }
  }

  private _endSetSwipe(
    event: TouchEvent,
    key: string,
    workout: Workout,
    exerciseIndex: number,
    setIndex: number,
  ): void {
    const start = this._setSwipeStart[key];
    delete this._setSwipeStart[key];
    if (!start || !window.matchMedia("(max-width: 520px)").matches || this._setSwipeDeletingKey) return;
    const touch = event.changedTouches[0];
    if (!touch) {
      this._cancelSetSwipe(key);
      return;
    }

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const offset = this._setSwipeOffsets[key] ?? Math.max(-168, Math.min(0, dx));
    const crossedDeleteThreshold =
      offset <= -116 &&
      dx < 0 &&
      Math.abs(dx) > Math.abs(dy) * 1.1 &&
      workout.exercises[exerciseIndex]?.sets.length > 1;

    if (!crossedDeleteThreshold) {
      this._setSwipeOffsets = { ...this._setSwipeOffsets, [key]: 0 };
      return;
    }

    this._setSwipeDeletingKey = key;
    this._setSwipeOffsets = {
      ...this._setSwipeOffsets,
      [key]: -Math.max(window.innerWidth, 420),
    };
    delete this._draftLogs[key];

    window.setTimeout(() => {
      void this._sessionEdit(workout, "remove_set", {
        exercise_index: exerciseIndex,
        set_index: setIndex,
      }).finally(() => {
        const next = { ...this._setSwipeOffsets };
        delete next[key];
        this._setSwipeOffsets = next;
        this._setSwipeDeletingKey = null;
      });
    }, 180);
  }

  private _configuredBarChoices(exerciseId: string): BarChoice[] {
    const gymId = this.gainsState.profile?.gymProfileId;
    const gym = gymId ? this.gainsState.gymProfiles.find((candidate) => candidate.id === gymId) : null;
    if (!gym) return [];

    const definition = EXERCISE_LIBRARY.find((candidate) => candidate.id === exerciseId);
    const requiredBar =
      definition?.requiresEquipmentId && PLATE_BAR_EQUIPMENT_IDS.has(definition.requiresEquipmentId)
        ? definition.requiresEquipmentId
        : null;
    const choices: BarChoice[] = [];

    for (const equipmentId of PLATE_BAR_EQUIPMENT_IDS) {
      if (requiredBar && equipmentId !== requiredBar) continue;
      const configured = gym.equipment[equipmentId];
      if (!configured?.length) continue;
      const item = EQUIPMENT_CATALOG.find((candidate) => candidate.id === equipmentId);
      if (!item) continue;

      for (const configuredWeight of configured) {
        const weight = configuredWeight ?? defaultInventoryWeight(item.defaultWeight, this.gainsState.profile?.units ?? "imperial");
        if (weight == null || !Number.isFinite(weight) || weight <= 0) continue;
        if (choices.some((choice) => choice.equipmentId === equipmentId && Math.abs(choice.weight - weight) < 0.01)) {
          continue;
        }
        choices.push({ equipmentId, weight, label: item.name });
      }
    }
    return choices;
  }

  private _resolvedBar(exercise: WorkoutExercise): BarChoice {
    const choices = this._configuredBarChoices(exercise.exerciseId);
    if (exercise.selectedBarEquipmentId && exercise.selectedBarWeight != null) {
      const configured = choices.find(
        (choice) =>
          choice.equipmentId === exercise.selectedBarEquipmentId &&
          Math.abs(choice.weight - exercise.selectedBarWeight!) < 0.01,
      );
      if (configured) return configured;
      const item = EQUIPMENT_CATALOG.find((candidate) => candidate.id === exercise.selectedBarEquipmentId);
      return {
        equipmentId: exercise.selectedBarEquipmentId,
        weight: exercise.selectedBarWeight,
        label: item?.name ?? "Selected bar",
      };
    }

    const definition = EXERCISE_LIBRARY.find((candidate) => candidate.id === exercise.exerciseId);
    if (definition?.requiresEquipmentId) {
      const required = choices.find((choice) => choice.equipmentId === definition.requiresEquipmentId);
      if (required) return required;
    }

    if (this.gainsState.profile?.experienceLevel === "kids" && choices.length) {
      return [...choices].sort((a, b) => a.weight - b.weight)[0];
    }
    return (
      choices.find((choice) => choice.equipmentId === "olympic_barbell") ??
      choices[0] ?? {
        equipmentId: "standard_bar",
        weight: this.gainsState.profile?.units === "metric" ? METRIC_BAR_WEIGHT : IMPERIAL_BAR_WEIGHT,
        label: "Standard bar",
      }
    );
  }

  private _plateInventory(): PlateInventoryItem[] {
    const gymId = this.gainsState.profile?.gymProfileId;
    const gym = gymId ? this.gainsState.gymProfiles.find((candidate) => candidate.id === gymId) : null;
    const configured = gym?.equipment.plates ?? [];
    const counts = new Map<number, number>();
    for (const value of configured) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    if (counts.size) {
      return [...counts.entries()]
        .map(([weight, count]) => ({ weight, count }))
        .sort((a, b) => a.weight - b.weight);
    }

    return [];
  }

  private _loadingWeight(workout: Workout, exerciseIndex: number, setIndex: number): number {
    const exercise = workout.exercises[exerciseIndex];
    const set = exercise.sets[setIndex];
    if (!set) return 0;
    const key = `${workout.id}:${exerciseIndex}:${setIndex}`;
    const draft = this._draftLogs[key];
    const suggestion = set.completed
      ? { weight: set.actualWeight }
      : nextSetSuggestion(
          exercise,
          setIndex,
          workout.profileId === this.gainsState.profile?.profileId ? this.gainsState.profile.inventoryPolicy?.[exercise.exerciseId] : workout.jointSession?.participants.find(p => p.profile_id === workout.profileId)?.inventory_policy?.[exercise.exerciseId],
        );
    return draft?.weight ?? suggestion.weight ?? 0;
  }

  private _renderLoadingPickerDialog() {
    const picker = this._loadingPicker;
    if (!picker) return "";
    const workout = this._sessionWorkout(picker.workoutId);
    const exercise = workout?.exercises[picker.exerciseIndex];
    const set = exercise?.sets[picker.setIndex];
    if (!workout || !exercise || !set || exerciseEquipment(exercise.exerciseId) !== "barbell") return "";

    const units = this._workoutUnits(workout) === "metric" ? "kg" : "lb";
    const conversion = this._workoutUnits(workout) === this.gainsState.profile?.units ? 1 : this._workoutUnits(workout) === "metric" ? 0.45359237 : 1 / 0.45359237;
    const selected = exercise.selectedBarWeight != null ? this._resolvedBar(exercise) : {...this._resolvedBar(exercise), weight: this._resolvedBar(exercise).weight * conversion};
    const totalWeight = this._loadingWeight(workout, picker.exerciseIndex, picker.setIndex);
    const ownInventory = workout.profileId === this.gainsState.profile?.profileId;
    const policy = ownInventory ? this.gainsState.profile?.inventoryPolicy?.[exercise.exerciseId] : undefined;
    const ladder = policy?.bars?.[`${selected.equipmentId}:${selected.weight}`] ?? [];
    const verified = !!policy?.feasible && ladder.some(v => Math.abs(v - totalWeight) < 0.01);
    const plateInventory = ownInventory ? this._plateInventory().map(p => ({...p, weight: p.weight * conversion})) : [];
    const loadout = buildPlateLoadout(totalWeight, selected.weight, plateInventory);
    const barPlates = expandPlateLoadout(loadout.counts);
    const leftBarPlates = [...barPlates].reverse();
    const choices = this._configuredBarChoices(exercise.exerciseId).map(b => ({...b, weight: b.weight * conversion}));
    const editable = workout.status === "active" || workout.status === "planned";
    const perSideLabel = Number.isInteger(loadout.perSide)
      ? String(loadout.perSide)
      : loadout.perSide.toFixed(1);

    return html`
      <ha-dialog
        class="loading-picker-dialog"
        .open=${true}
        hideActions
        @closed=${() => (this._loadingPicker = null)}
      >
        <div class="loading-picker-sheet">
          <div class="loading-picker-handle" aria-hidden="true"></div>
          <div class="loading-picker-header">
            <div>
              <p class="muted small">${exerciseName(exercise.exerciseId)} \u00b7 Set ${picker.setIndex + 1}</p>
              <h2>${totalWeight} ${units}</h2>
              <p class="loading-per-side">
                ${loadout.belowBar
                  ? `Below the selected ${selected.label}`
                  : `${perSideLabel} ${units} per side`}
              </p>
            </div>
            <button class="icon-button" aria-label="Close loading setup" @click=${() => (this._loadingPicker = null)}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>

          <div class="barbell-loading-visual" aria-hidden="true">
            <span class="barbell-sleeve left"></span>
            <span class="barbell-plate-stack left">
              ${leftBarPlates.map((plate) => html`
                <span
                  class="barbell-loaded-plate"
                  style=${barbellPlateStyle(plate, units)}
                  title=${`${plate} ${units}`}
                ></span>
              `)}
            </span>
            <span class="barbell-collar left"></span>
            <span class="barbell-shaft"></span>
            <span class="barbell-collar right"></span>
            <span class="barbell-plate-stack right">
              ${barPlates.map((plate) => html`
                <span
                  class="barbell-loaded-plate"
                  style=${barbellPlateStyle(plate, units)}
                  title=${`${plate} ${units}`}
                ></span>
              `)}
            </span>
            <span class="barbell-sleeve right"></span>
          </div>

          <div class="loading-status ${verified && loadout.exact && !loadout.belowBar ? "exact" : "warning"}">
            <ha-icon icon=${verified && loadout.exact && !loadout.belowBar ? "mdi:check-circle-outline" : "mdi:alert-circle-outline"}></ha-icon>
            <span>
              ${!policy?.feasible
                ? "Loading inventory unverified for this athlete"
                : loadout.belowBar
                ? `${totalWeight} ${units} is below the ${selected.weight} ${units} bar`
                : verified && loadout.exact
                  ? "Exact weight"
                  : `${loadout.remainder.toFixed(1)} ${units} per side cannot be made with your configured plates`}
            </span>
          </div>

          <section class="loading-section">
            <div class="loading-section-title">
              <span>Plates per side</span>
              <span class="muted small">${perSideLabel} ${units}</span>
            </div>
            <div class="plate-loadout-chips">
              ${loadout.counts.length
                ? loadout.counts.map(({ plate, count }) => html`
                    <span class="plate-loadout-chip">
                      <span class="plate-disc" style=${plateStyle(plate, units)}></span>
                      ${count} \u00d7 ${plate} ${units}
                    </span>
                  `)
                : html`<span class="muted">${loadout.belowBar ? "Choose a lighter bar or increase total weight." : "No plates \u2014 bar only."}</span>`}
            </div>
          </section>

          <section class="loading-section">
            <div class="loading-section-title"><span>Available plates</span></div>
            <div class="available-plate-row">
              ${plateInventory.map(({ weight, count }) => html`
                <span class="available-plate">
                  <span class="plate-disc" style=${plateStyle(weight, units)}></span>
                  <small>${weight}</small>
                  ${Number.isFinite(count)
                    ? html`<small class="plate-inventory-count">${count} set${count === 1 ? "" : "s"}</small>`
                    : ""}
                </span>
              `)}
            </div>
          </section>

          <section class="loading-section">
            <div class="loading-section-title">
              <span>Bar</span>
              <span class="muted small">Remembered for this exercise</span>
            </div>
            <div class="bar-choice-list">
              ${choices.length
                ? choices.map((choice) => {
                    const active =
                      choice.equipmentId === selected.equipmentId &&
                      Math.abs(choice.weight - selected.weight) < 0.01;
                    return html`
                      <button
                        class="bar-choice-row ${active ? "active" : ""}"
                        ?disabled=${!editable}
                        @click=${async () => {
                          if (!editable) return;
                          await this._setBar(workout, picker.exerciseIndex, choice);
                          this._loadingPicker = null;
                        }}
                      >
                        <span class="mini-barbell-icon" aria-hidden="true"></span>
                        <span>
                          <strong>${choice.label}</strong>
                          <small>${choice.weight} ${units}</small>
                        </span>
                        ${active ? html`<ha-icon icon="mdi:check"></ha-icon>` : ""}
                      </button>
                    `;
                  })
                : html`
                    <div class="bar-choice-row active static">
                      <span class="mini-barbell-icon" aria-hidden="true"></span>
                      <span><strong>${selected.label}</strong><small>${selected.weight} ${units}</small></span>
                    </div>
                  `}
            </div>
          </section>
        </div>
      </ha-dialog>
    `;
  }

  private _clearInputForReplacement(event: FocusEvent): void {
    const input = event.currentTarget as HTMLInputElement;
    if (input.disabled) return;
    input.dataset.gainsRestoreValue = input.value;
    input.value = "";
  }

  private _restoreInputIfEmpty(event: FocusEvent): void {
    const input = event.currentTarget as HTMLInputElement;
    if (input.value.trim() === "") {
      input.value = input.dataset.gainsRestoreValue ?? "";
    }
    delete input.dataset.gainsRestoreValue;
  }

  private async _logSet(
    workout: Workout,
    exerciseIndex: number,
    setIndex: number,
    set: WorkoutSet
  ): Promise<void> {
    const key = `${workout.id}:${exerciseIndex}:${setIndex}`;
    const draft = this._draftLogs[key] ?? {};
    const exercise = workout.exercises[exerciseIndex];
    const fallback = set.completed
      ? { reps: set.actualReps, weight: set.actualWeight }
      : nextSetSuggestion(
          exercise,
          setIndex,
          workout.profileId === this.gainsState.profile?.profileId ? this.gainsState.profile.inventoryPolicy?.[exercise.exerciseId] : workout.jointSession?.participants.find(p => p.profile_id === workout.profileId)?.inventory_policy?.[exercise.exerciseId]
        );
    if (this._savingSet || workout.status !== "active") return;
    if (!canLogJointSet(workout.jointSession, workout.profileId, exerciseIndex, setIndex, set.completed)) {
      this._error = "Wait for your partner's turn to finish."; return;
    }
    const reps = draft.reps ?? fallback.reps;
    const weight = draft.weight ?? fallback.weight;
    if (weight == null && ["barbell", "dumbbell", "kettlebell", "machine", "cable"].includes(exerciseEquipment(exercise.exerciseId))) {
      this._error = "Load inventory unverified. Check gym settings or enter a manual weight."; return;
    }
    if (reps == null || !Number.isInteger(reps) || reps < 1 || (weight != null && (!Number.isFinite(weight) || weight < 0))) {
      this._error = "Enter a positive whole number of reps and a non-negative weight."; return;
    }
    this._savingSet = key; this._error = "";
    try {
      if (this._sharedController(workout)) await this._saveSharedSet(workout, exerciseIndex, setIndex, reps, weight ?? 0);
      else await gainsApi.logSet(this.hass,workout.id,exerciseIndex,setIndex,reps,weight ?? undefined);
    }
    catch { this._error = "Set was not saved. Your entries are still here; please retry."; return; }
    finally { this._savingSet = null; }
    delete this._draftLogs[key];
    if (set.completed) this._editingSet = null;
    this._persistSession();

    // Once every set in this exercise is logged, ask how the whole exercise
    // felt (once, not per set) -- see gainsApi.logExerciseEffort. Skipped
    // when editing an already-completed set (set.completed was already
    // true) so re-saving a correction doesn't re-open the prompt, and so
    // an edit never restarts the rest timer either.
    if (!set.completed) {
      const nowCompleted = exercise.sets.filter((s) => s.completed).length + 1;
      if (nowCompleted === exercise.sets.length) {
        this._effortPromptWorkoutId = workout.id;
        this._effortPromptExerciseIndex = exerciseIndex;
      }
      this._startRestTimer(exercise.restSeconds ?? this.gainsState.profile?.restTimerSeconds ?? 60);
    }
  }

  private _openTimedSetTimer(
    workout: Workout,
    exerciseIndex: number,
    setIndex: number,
    set: WorkoutSet,
  ): void {
    const key = `${workout.id}:${exerciseIndex}:${setIndex}`;
    const exercise = workout.exercises[exerciseIndex];
    const draft = this._draftLogs[key];
    const fallback = set.completed
      ? { reps: set.actualReps, weight: set.actualWeight }
      : nextSetSuggestion(
          exercise,
          setIndex,
          workout.profileId === this.gainsState.profile?.profileId ? this.gainsState.profile.inventoryPolicy?.[exercise.exerciseId] : workout.jointSession?.participants.find(p => p.profile_id === workout.profileId)?.inventory_policy?.[exercise.exerciseId],
        );
    const seconds = Math.max(1, Math.round(draft?.reps ?? fallback.reps ?? 1));

    this._clearTimedSetTimerInterval();
    this._timedSetTimer = { workoutId: workout.id, exerciseIndex, setIndex, seconds };
    this._timedSetTimerPhase = "ready";
    this._timedSetTimerRemaining = seconds;
    this._timedSetStartCountdown = 3;
    this._timedSetCountdownEndsAt = 0;
    this._timedSetEndsAt = 0;
  }

  private _adjustTimedSetTimer(seconds: number): void {
    if (!this._timedSetTimer || this._timedSetTimerPhase !== "ready") return;
    const normalized = Math.max(1, Math.min(3600, Math.round(seconds)));
    this._timedSetTimer = { ...this._timedSetTimer, seconds: normalized };
    this._timedSetTimerRemaining = normalized;
  }

  private _startTimedSetTimer(): void {
    if (!this._timedSetTimer || this._timedSetTimerPhase !== "ready") return;
    this._clearTimedSetTimerInterval();
    this._timedSetTimerPhase = "starting";
    this._timedSetStartCountdown = 3;
    this._timedSetTimerRemaining = this._timedSetTimer.seconds;
    this._timedSetCountdownEndsAt = Date.now() + 3000;
    this._timedSetEndsAt = 0;
    this._timedSetTimerIntervalId = window.setInterval(() => this._tickTimedSetTimer(), 200);
    this._tickTimedSetTimer();
  }

  private _tickTimedSetTimer(): void {
    if (!this._timedSetTimer) {
      this._clearTimedSetTimerInterval();
      return;
    }
    const now = Date.now();
    if (this._timedSetTimerPhase === "starting") {
      const milliseconds = this._timedSetCountdownEndsAt - now;
      if (milliseconds <= 0) {
        this._timedSetTimerPhase = "running";
        this._timedSetEndsAt = now + this._timedSetTimer.seconds * 1000;
        this._timedSetTimerRemaining = this._timedSetTimer.seconds;
      } else {
        this._timedSetStartCountdown = Math.max(1, Math.ceil(milliseconds / 1000));
      }
      return;
    }
    if (this._timedSetTimerPhase !== "running") return;

    const milliseconds = this._timedSetEndsAt - now;
    if (milliseconds <= 0) {
      this._timedSetTimerRemaining = 0;
      this._timedSetTimerPhase = "logging";
      this._clearTimedSetTimerInterval();
      void this._finishTimedSetTimer();
      return;
    }
    this._timedSetTimerRemaining = Math.max(1, Math.ceil(milliseconds / 1000));
  }

  private async _finishTimedSetTimer(): Promise<void> {
    const timer = this._timedSetTimer;
    if (!timer) return;
    const workout = this._sessionWorkout(timer.workoutId);
    const exercise = workout?.exercises[timer.exerciseIndex];
    const set = exercise?.sets[timer.setIndex];
    if (!workout || workout.status !== "active" || !exercise || !set || set.completed) {
      this._closeTimedSetTimer();
      return;
    }

    const key = `${timer.workoutId}:${timer.exerciseIndex}:${timer.setIndex}`;
    this._draftLogs[key] = { ...this._draftLogs[key], reps: timer.seconds };
    this._persistSession();
    await this._logSet(workout, timer.exerciseIndex, timer.setIndex, set);
    this._closeTimedSetTimer();
  }

  private _closeTimedSetTimer(): void {
    this._clearTimedSetTimerInterval();
    this._timedSetTimer = null;
    this._timedSetTimerPhase = "ready";
    this._timedSetTimerRemaining = 0;
    this._timedSetStartCountdown = 3;
    this._timedSetCountdownEndsAt = 0;
    this._timedSetEndsAt = 0;
  }

  private _clearTimedSetTimerInterval(): void {
    if (this._timedSetTimerIntervalId !== null) {
      window.clearInterval(this._timedSetTimerIntervalId);
      this._timedSetTimerIntervalId = null;
    }
  }

  private _renderTimedSetTimerDialog() {
    const timer = this._timedSetTimer;
    if (!timer) return "";
    const workout = this._sessionWorkout(timer.workoutId);
    const exercise = workout?.exercises[timer.exerciseIndex];
    const exerciseLabel = exercise ? exerciseName(exercise.exerciseId) : "Timed set";
    const running = this._timedSetTimerPhase === "running";
    const starting = this._timedSetTimerPhase === "starting";
    const logging = this._timedSetTimerPhase === "logging";
    const displaySeconds = running ? this._timedSetTimerRemaining : timer.seconds;

    return html`
      <ha-dialog
        class="timed-set-dialog"
        .open=${true}
        hideActions
        @closed=${() => this._closeTimedSetTimer()}
      >
        <div class="timed-set-modal">
          <div class="timed-set-header">
            <div>
              <p class="muted small">Set ${timer.setIndex + 1}</p>
              <h2>${exerciseLabel} timer</h2>
            </div>
            <button
              class="icon-button"
              aria-label="Close timer"
              ?disabled=${logging}
              @click=${() => this._closeTimedSetTimer()}
            ><ha-icon icon="mdi:close"></ha-icon></button>
          </div>

          ${this._timedSetTimerPhase === "ready"
            ? html`
                <p class="muted">Adjust the hold time, then start when you're in position.</p>
                <div class="timed-set-adjust">
                  <button class="secondary" @click=${() => this._adjustTimedSetTimer(timer.seconds - 5)}>-5s</button>
                  <label>
                    Seconds
                    <input
                      type="number"
                      inputmode="numeric"
                      min="1"
                      max="3600"
                      step="1"
                      .value=${String(timer.seconds)}
                      @focus=${this._clearInputForReplacement}
                      @blur=${this._restoreInputIfEmpty}
                      @input=${(event: Event) => this._adjustTimedSetTimer(Number((event.target as HTMLInputElement).value))}
                    />
                  </label>
                  <button class="secondary" @click=${() => this._adjustTimedSetTimer(timer.seconds + 5)}>+5s</button>
                </div>
                <button class="primary timed-set-start" @click=${() => this._startTimedSetTimer()}>
                  <ha-icon icon="mdi:timer-play-outline"></ha-icon> Start timer
                </button>
              `
            : html`
                <div class="timed-set-countdown ${starting ? "starting" : ""}">
                  ${starting
                    ? html`<span class="timed-set-phase">Starting in</span><strong>${this._timedSetStartCountdown}</strong>`
                    : logging
                      ? html`<ha-icon icon="mdi:check-circle-outline"></ha-icon><span class="timed-set-phase">Logging set\u2026</span>`
                      : html`<span class="timed-set-phase">Hold</span><strong>${displaySeconds}</strong><span class="timed-set-unit">seconds</span>`}
                </div>
                ${!logging ? html`
                  <button class="secondary timed-set-cancel" @click=${() => this._closeTimedSetTimer()}>
                    Cancel timer
                  </button>
                ` : ""}
              `}
        </div>
      </ha-dialog>
    `;
  }

  private _startRestTimer(seconds: number): void {
    this._clearRestTimerInterval();
    this._restUntil = Date.now() + seconds * 1000;
    this._restWorkoutId = this._openWorkoutId;
    this._tickRest();
    this._restTimerIntervalId = window.setInterval(() => this._tickRest(),1000);
    this._persistSession();
  }
  private _tickRest(): void {
    const left = Math.max(0,Math.ceil((this._restUntil-Date.now())/1000));
    this._restTimerSecondsLeft = left;
    if (!left) this._skipRestTimer();
  }
  private _skipRestTimer(): void {
    this._clearRestTimerInterval(); this._restTimerSecondsLeft = null; this._restUntil = 0; this._restWorkoutId = null;
    this._persistSession();
  }

  private _clearRestTimerInterval(): void {
    if (this._restTimerIntervalId !== null) {
      window.clearInterval(this._restTimerIntervalId);
      this._restTimerIntervalId = null;
    }
  }

  private _recoveryIntervalId: number | undefined;

  connectedCallback(): void {
    super.connectedCallback();
    this._recoveryIntervalId = window.setInterval(() => this.requestUpdate(), 60000);
    if (this._restUntil > Date.now() && this._restTimerIntervalId === null) {
      this._tickRest();
      this._restTimerIntervalId = window.setInterval(() => this._tickRest(),1000);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this._recoveryIntervalId);
    this._clearRestTimerInterval();
    this._clearTimedSetTimerInterval();
  }

  private _renderRestTimerBanner() {
    if (this._restTimerSecondsLeft === null || this._restWorkoutId !== this._openWorkoutId) return "";
    const minutes = Math.floor(this._restTimerSecondsLeft / 60);
    const seconds = this._restTimerSecondsLeft % 60;
    return html`
      <ha-card class="panel rest-timer-banner">
        <div class="rest-timer-row">
          <span class="rest-timer-label">Rest</span>
          <span class="rest-timer-countdown">${minutes}:${String(seconds).padStart(2, "0")}</span>
          <button class="secondary" @click=${() => { this._restUntil += 15000; this._tickRest(); this._persistSession(); }}>+15s</button>
          <button class="secondary" @click=${() => this._skipRestTimer()}>Skip</button>
        </div>
      </ha-card>
    `;
  }

  private async _logExerciseEffort(
    workout: Workout,
    exerciseIndex: number,
    effort: Effort
  ): Promise<void> {
    try {
      if (this._sharedController(workout)) {
        const controller = this._sharedController(workout)!;
        await trainingService(this.hass, "joint_session_action", {action: "log_effort", fields: {
          workout_id: controller.id, expected_revision: controller.revision,
          participant_profile_id: workout.profileId, exercise_index: exerciseIndex, effort,
        }});
        this.dispatchEvent(new CustomEvent("training-refresh", {bubbles: true, composed: true}));
      } else await gainsApi.logExerciseEffort(this.hass, workout.id, exerciseIndex, effort);
    } catch { this._error = "Effort was not saved. Please retry."; return; }
    this._effortPromptExerciseIndex = null;
    this._effortPromptWorkoutId = null;
    if (this._sharedController(workout)) return;
    // Nothing left to do on this exercise's page once effort is logged --
    // back to the workout's exercise list.
    this._activeExerciseIndex = null;
    this._videoModalOpen = false;
  }

  render() {
    if (!this.gainsState.profile) {
      return html`<ha-card class="panel"><p class="muted">Loading&hellip;</p></ha-card>`;
    }

    const workouts = this.gainsState.workouts;
    const openWorkout = this._openWorkoutId
      ? workouts.find((w) => w.id === this._openWorkoutId)
      : undefined;

    if (openWorkout) {
      return this._renderActiveWorkout(openWorkout);
    }

    if (!this._building) return this._renderLibrary();
    return html`
      ${this._renderError()}
      <ha-card class="panel">
        <button class="secondary" @click=${() => this._building = false}>Back to Workouts</button>
        <h2>Build a Workout</h2>
        <label for="workout-name">Name</label>
        <input
          id="workout-name"
          type="text"
          placeholder="Leg Day"
          .value=${this._name}
          @input=${(e: Event) => (this._name = (e.target as HTMLInputElement).value)}
        />

        <div class="exercise-picker">
          <label>Exercise</label>
          <button class="picker-toggle" @click=${() => (this._pickerOpen = true)}>
            ${exerciseName(this._pendingExerciseId)}
            <ha-icon icon="mdi:chevron-right"></ha-icon>
          </button>
        </div>

        <div class="exercise-controls">
          <div>
            <label for="sets">Sets</label>
            <input
              id="sets"
              type="number"
              min="1"
              .value=${String(this._pendingSets)}
              @input=${(e: Event) =>
                (this._pendingSets = Number((e.target as HTMLInputElement).value))}
            />
          </div>
          <div>
            <label for="reps"
              >${isTimedExercise(this._pendingExerciseId) ? "Seconds" : "Reps"}</label
            >
            <input
              id="reps"
              type="number"
              min="1"
              .value=${String(this._pendingReps)}
              @input=${(e: Event) =>
                (this._pendingReps = Number((e.target as HTMLInputElement).value))}
            />
          </div>
          <div>
            <label for="weight">Weight</label>
            <input
              id="weight"
              type="number"
              min="0"
              .value=${String(this._pendingWeight)}
              @input=${(e: Event) =>
                (this._pendingWeight = Number((e.target as HTMLInputElement).value))}
            />
          </div>
          <button class="secondary" @click=${this._addExerciseToDraft}>Add</button>
        </div>

        <ul class="draft-list">
          ${this._draftExercises.map(
            (d, i) => html`
              <li>
                <span
                  >${exerciseName(d.exerciseId)} &mdash; ${d.sets}&times;${d.reps}${isTimedExercise(
                    d.exerciseId
                  )
                    ? "s"
                    : ""} @ ${d.weight}</span
                >
                <button class="secondary" @click=${() => this._removeDraftExercise(i)}>
                  Remove
                </button>
              </li>
            `
          )}
        </ul>

        <div class="actions">
          <button
            class="primary"
            ?disabled=${this._busy || !this._name.trim() || this._draftExercises.length === 0}
            @click=${this._createWorkout}
          >
            Create Workout
          </button>
        </div>
      </ha-card>

      ${this._renderPickerDialog()} ${this._renderShareDialog()}
    `;
  }

  private _renderError() {
    return this._error ? html`<p class="error-banner" role="alert">${this._error}</p>` : "";
  }
  private _renderLibrary() {
    const workouts = this.gainsState.workouts.filter(w => this._listFilter === "history" ? ["completed","skipped"].includes(w.status) : w.status === this._listFilter).slice().reverse();
    return html`<div class="library">${this._renderError()}<div class="library-header"><h1>Workouts</h1><button class="primary" @click=${() => this._building = true}>+ New workout</button></div><p class="muted">Your training, one session at a time.</p>
      ${this._shareNotice ? html`<p role="status">${this._shareNotice}</p>` : ""}
      ${this._renderWorkoutInvites()}
      <div class="segments" aria-label="Workout status">${(["planned","active","history"] as const).map(status => html`<button aria-pressed=${this._listFilter === status} @click=${() => this._listFilter = status}>${status === "active" ? "In progress" : status === "planned" ? "Planned" : "History"}</button>`)}</div>
      <style>.workout-card{position:relative}.workout-card .workout-tile{width:100%;height:100%;padding-right:60px}.card-overflow{position:absolute;right:12px;top:12px}.joint-banner{padding:16px;border:1px solid var(--divider-color);border-radius:12px;margin:12px 0}</style>
      <div class="library-grid">${workouts.map(w => html`<div class="workout-card"><button class="workout-tile" @click=${() => this.openWorkout(w.id)}><div><span class="badge">${w.status}</span><h2>${w.name}</h2><p class="muted small">${w.exercises.length} exercises \u00b7 ${w.exercises.reduce((n,e)=>n+e.sets.length,0)} sets</p>${w.jointSession ? html`<p class="small">Workout Together \u00b7 ${w.jointSession.participants.map(p=>p.display_name).join(" & ")}</p>` : ""}<p class="small">${w.status === "active" ? "Resume session" : "View workout"} \u2192</p></div><gains-muscle-map compact .exerciseIds=${w.exercises.filter(e => w.status !== "completed" || e.sets.some(s => s.completed)).map(e=>e.exerciseId)}></gains-muscle-map></button><button class="icon-button card-overflow" aria-label=${`Options for ${w.name}`} aria-haspopup="dialog" @click=${()=>this._overflowWorkout=w}><ha-icon icon="mdi:dots-vertical"></ha-icon></button></div>`)}</div>
      ${!workouts.length ? html`<div class="library-empty"><p class="muted">${this._listFilter === "planned" ? "No planned workouts yet. Create one or ask Geoffrey." : "No workouts here yet."}</p></div>` : ""}
      <div class="actions"><button class="secondary" @click=${() => this.dispatchEvent(new CustomEvent("gains-switch-tab",{detail:{tab:"coach"},bubbles:true,composed:true}))}>Build with Geoffrey</button></div>
      ${this._renderOverflowDialog()}${this._renderTogetherDialog()}${this._renderShareDialog()}</div>`;
  }

  private async _respondWorkoutInvite(shareId: string, accept: boolean) {
    if (this._respondShareBusy) return;
    this._respondShareBusy = shareId;
    this._error = "";
    const joint = this.gainsState.profile?.incomingShares.find(s=>s.id===shareId)?.kind === "joint_workout";
    try {
      await gainsApi.respondShare(this.hass,shareId,accept);
      this._shareNotice = accept ? joint ? "Workout Together invite accepted. The shared session is in In progress." : "Workout invite accepted. Your copy is in Planned workouts." : "Workout invite declined.";
      if (accept) this._listFilter=joint ? "active" : "planned";
      this.dispatchEvent(new CustomEvent("training-refresh",{bubbles:true,composed:true}));
    } catch(e) {this._error=serviceErrorMessage(e);}
    finally {this._respondShareBusy=null;}
  }

  private _renderWorkoutInvites() {
    const invites = (this.gainsState.profile?.incomingShares ?? []).filter(s=>["workout","joint_workout"].includes(s.kind));
    if (!invites.length) return "";
    return html`<section aria-label="Workout invites"><h2>Workout invites</h2><p class="muted small">Nothing is added or started until you accept. Declining leaves your workouts unchanged.</p><ul class="draft-list">${invites.map(invite=>html`<li><div><strong>${invite.name}</strong><p class="muted small">${invite.kind==="joint_workout" ? "Workout Together" : "Workout share"} from ${invite.fromDisplayName}</p>${invite.kind==="joint_workout" ? html`<p class="small">Accepting starts a shared session for both athletes. ${invite.deviceMode==="same_device" ? `${invite.fromDisplayName}'s account will record sets for both athletes on the shared device.` : "Each athlete logs on their own device."}</p>${this.viewContext?.mode==="coach" ? html`<p class="muted small">Switch to this athlete's own account to respond.</p>` : ""}` : html`<p class="small">Accepting adds a separate copy to your Planned workouts.</p>`}</div><div class="actions"><button class="primary" ?disabled=${this._respondShareBusy!==null || (invite.kind==="joint_workout" && this.viewContext?.mode==="coach")} @click=${()=>this._respondWorkoutInvite(invite.id,true)}>${invite.kind==="joint_workout" ? "Accept and train together" : "Accept workout"}</button><button class="secondary" ?disabled=${this._respondShareBusy!==null || (invite.kind==="joint_workout" && this.viewContext?.mode==="coach")} @click=${()=>this._respondWorkoutInvite(invite.id,false)}>Decline</button></div></li>`)}</ul></section>`;
  }

  private _renderOverflowDialog() {
    const w = this._overflowWorkout;
    const joint = w && isJointParticipant(w.jointSession, w.profileId);
    return html`<ha-dialog .open=${!!w} hideActions @closed=${()=>this._overflowWorkout=null}>
      ${w ? html`<div class="picker-header"><h2>${w.name}</h2><button class="icon-button" aria-label="Close options" @click=${()=>this._overflowWorkout=null}><ha-icon icon="mdi:close"></ha-icon></button></div>
      <div class="picker-body"><div class="actions">
        <button class="secondary" ?disabled=${joint || !["planned","active"].includes(w.status)} @click=${()=>{this._overflowWorkout=null;void this._skipWorkout(w.id);}}>Skip workout</button>
        <button class="secondary danger-text" ?disabled=${joint} @click=${()=>{this._overflowWorkout=null;void this._deleteWorkout(w.id,w.name);}}>Delete workout</button>
        <button class="secondary" @click=${()=>{this._overflowWorkout=null;this._sharingWorkout=w;}}>Share workout</button>
        <button class="secondary" ?disabled=${w.status!=="planned" || !!w.jointSession || this.viewContext?.mode==="coach"} @click=${()=>{this._overflowWorkout=null;this._jointDeviceMode=null;this._togetherWorkout=w;}}>Workout together</button>
      </div>${joint ? html`<p class="muted">Leave the joint session before skipping or deleting your workout.</p>` : ""}${this.viewContext?.mode==="coach" ? html`<p class="muted">Switch to your own profile to train together.</p>` : ""}</div>` : ""}
    </ha-dialog>`;
  }

  private async _jointAction(workout: Workout, action: string, partnerProfileId?: string, fields: Record<string,unknown> = {}) {
    if (this._jointBusy) return;
    this._jointBusy = true;
    this._error = "";
    try {
      await trainingService(this.hass,"joint_session_action",{action,fields:{workout_id:workout.id,expected_revision:workout.revision,...(partnerProfileId ? {partner_profile_id:partnerProfileId} : {}),...(action==="join" ? {device_mode:this._jointDeviceMode} : {}),...fields}});
      this._togetherWorkout = null;
      if (action === "join") {this._shareNotice="Workout Together invite sent. The session starts only after your partner accepts.";}
      this.dispatchEvent(new CustomEvent("training-refresh",{bubbles:true,composed:true}));
    } catch(e) {this._error=serviceErrorMessage(e);}
    finally {this._jointBusy=false;}
  }

  private _renderTogetherDialog() {
    const w = this.gainsState.workouts.find(w=>w.id===this._togetherWorkout?.id) ?? this._togetherWorkout;
    const targets = this.gainsState.profile?.shareTargets ?? [];
    return html`<ha-dialog .open=${!!w} hideActions @closed=${()=>this._togetherWorkout=null}>
      <div class="picker-header"><h2>Workout Together</h2><button class="icon-button" aria-label="Close partner picker" @click=${()=>this._togetherWorkout=null}><ha-icon icon="mdi:close"></ha-icon></button></div>
      <div class="picker-body">${this._renderError()}<p>Invite any Gains profile and choose how you will log. The session starts only after they accept in Workouts. Each athlete keeps their own reps, weight, effort and history.</p><p class="muted small">No linked account, coach grant, matching units or matching gym equipment is needed to receive an invite.</p>
      <fieldset><legend>Will you use the same device or different devices?</legend>
        <label><input style="width:auto" type="radio" name="joint-device" value="same_device" .checked=${this._jointDeviceMode==="same_device"} @change=${()=>this._jointDeviceMode="same_device"}> Same device</label>
        <p class="muted small">Take turns on this device. The shared controls label whose reps, weight and effort you are recording.</p>
        <label><input style="width:auto" type="radio" name="joint-device" value="different_devices" .checked=${this._jointDeviceMode==="different_devices"} @change=${()=>this._jointDeviceMode="different_devices"}> Different devices</label>
        <p class="muted small">Each athlete opens the workout in their own account and logs their own sets.</p>
      </fieldset>
      ${targets.length ? html`<ul class="draft-list">${targets.map(p=>html`<li><span>${p.displayName}</span><button class="primary" ?disabled=${this._jointBusy || this._jointDeviceMode===null} @click=${()=>w && this._jointAction(w,"join",p.profileId)}>Send invite</button></li>`)}</ul>` : html`<p>No other Gains profiles yet. They will appear after opening Gains once.</p>`}</div>
    </ha-dialog>`;
  }

  private _sharedController(workout: Workout): Workout | undefined {
    if (this.viewContext?.mode === "coach") return undefined;
    return this.gainsState.workouts.find(w => w.jointSession?.id === workout.jointSession?.id &&
      isSharedController(w.jointSession, w.profileId));
  }

  private _sessionWorkout(id: string): Workout | undefined {
    const owned = this.gainsState.workouts.find(w => w.id === id);
    if (owned) return owned;
    for (const source of this.gainsState.workouts) {
      if (!this._sharedController(source)) continue;
      const participant = source.jointSession?.participants.find(p => p.workout_id === id);
      if (participant) return participantWorkout(source, participant.profile_id);
    }
    return undefined;
  }

  private _workoutUnits(workout: Workout): "imperial" | "metric" {
    return workout.jointSession?.participants.find(p => p.profile_id === workout.profileId)?.units ??
      this.gainsState.profile?.units ?? "imperial";
  }

  private async _saveSharedSet(workout: Workout, exerciseIndex: number, setIndex: number, reps: number, weight: number, effort?: Effort) {
    const controller = this._sharedController(workout);
    if (!controller) throw new Error("Shared session is no longer available");
    await trainingService(this.hass, "joint_session_action", {action: "log_set", fields: {
      workout_id: controller.id, expected_revision: controller.revision,
      participant_profile_id: workout.profileId, exercise_index: exerciseIndex,
      set_index: setIndex, reps, weight, ...(effort ? {effort} : {}),
    }});
    this.dispatchEvent(new CustomEvent("training-refresh", {bubbles: true, composed: true}));
  }

  private _renderSharedFinish(workout: Workout) {
    if (!this._sharedController(workout)) return "";
    return html`<div class="actions">${workout.jointSession!.participants.filter(p=>p.status==="active").map(p=>html`<button class="primary" ?disabled=${this._jointBusy || this._savingSet !== null} @click=${()=>{const missing=p.exercises.reduce((n,e)=>n+e.sets.filter(s=>!s.completed).length,0);if(!missing || window.confirm(`Finish ${p.display_name}'s workout with ${missing} unlogged sets?`)) void this._jointAction(workout,"complete_workout",undefined,{participant_profile_id:p.profile_id});}}>Finish ${p.display_name}'s workout</button>`)}</div>`;
  }

  private _renderJointBanner(workout: Workout) {
    const session = workout.jointSession;
    if (!session) return "";
    const turn = session.turn;
    const partner = session.participants.find(p=>p.profile_id===turn?.profile_id);
    const active = isJointParticipant(session, workout.profileId);
    const sharedController = this.viewContext?.mode!=="coach" && isSharedController(session,workout.profileId);
    if (sharedController) return html`<section class="joint-banner" aria-label="Workout Together">
      <p role="status"><strong>${turn ? `${partner?.display_name}'s turn - Set ${turn.set_index + 1}` : "All sets logged"}</strong></p>
      <details><summary>Workout Together - ${session.participants.map(p=>p.display_name).join(" & ")}</summary>
        <p class="muted small">Take turns using the usual set controls below. Each athlete's results save to their own history.</p>
        ${active ? html`<div class="actions"><button class="secondary" ?disabled=${this._jointBusy} @click=${()=>this._jointAction(workout,"leave")}>Leave joint session</button><button class="secondary" ?disabled=${this._jointBusy} @click=${()=>{if(window.confirm("End Workout Together for both athletes? Both can continue their own workout solo.")) void this._jointAction(workout,"end");}}>End joint session for both</button></div>` : ""}
      </details>
    </section>`;
    return html`<section class="joint-banner" style="padding:16px;border:1px solid var(--divider-color);border-radius:12px;margin:12px 0" aria-label="Workout Together">
      <h2>Workout Together</h2><p>${session.participants.map(p=>`${p.display_name} (${p.status})`).join(" \u00b7 ")}</p>
      <p role="status">${session.status!=="active" ? `Joint session ${session.status}.` : !active && !sharedController ? "You have left or finished. Your workout and history remain yours." : turn ? `${partner?.display_name}'s turn \u00b7 ${exerciseName(workout.exercises[turn.exercise_index]?.exerciseId ?? "")} \u00b7 set ${turn.set_index+1}` : "All working sets logged. Each athlete can finish their workout."}</p>
      <p class="muted small">${sharedController ? "Same device: log each labeled set below. The next athlete takes over automatically." : `The set fields below belong to ${this.gainsState.profile?.displayName}.`} Finishing saves that athlete's history and lets the partner continue.</p>
      ${active && this.viewContext?.mode!=="coach" ? html`<div class="actions"><button class="secondary" ?disabled=${this._jointBusy} @click=${()=>this._jointAction(workout,"leave")}>Leave joint session</button><button class="secondary" ?disabled=${this._jointBusy} @click=${()=>{if(window.confirm("End Workout Together for both athletes? Both can continue their own workout solo.")) void this._jointAction(workout,"end");}}>End joint session for both</button></div><p class="muted small">Leaving lets both athletes continue separately; your logged sets stay saved.</p>` : ""}
      <details><summary>Participant logs</summary>${session.participants.map(p=>html`<h3>${p.display_name}</h3>${p.exercises.map(e=>html`<p>${exerciseName(e.exercise_id)} \u00b7 effort: ${e.effort ?? "not logged"}</p><ul>${e.sets.map((s,i)=>s.completed ? html`<li>Set ${i+1}: ${s.actual_reps} reps \u00b7 ${s.actual_weight ?? 0} ${(p.units ?? this.gainsState.profile?.units)==="metric" ? "kg" : "lb"} \u00b7 recorded by ${session.participants.find(person=>person.profile_id===s.recorded_by_profile_id)?.display_name ?? "coach"}</li>` : "")}</ul>`)}`)}</details>
    </section>`;
  }

  private _renderShareDialog() {
    const workout = this._sharingWorkout;
    const shareTargets = this.gainsState.profile?.shareTargets ?? [];

    return html`
      <ha-dialog
        .open=${workout !== null}
        hideActions
        @closed=${() => (this._sharingWorkout = null)}
      >
        ${workout
          ? html`
              <div class="picker-header">
                <button class="icon-button" @click=${() => (this._sharingWorkout = null)}>
                  <ha-icon icon="mdi:arrow-left"></ha-icon>
                </button>
                <h2>Share Workout</h2>
              </div>
              <div class="picker-body">
                ${this._renderError()}
                <p class="muted small">Invite any Gains profile to receive "${workout.name}". No linked account, coach permission, matching units or available gym equipment is required to receive an invite. They must accept it in Workouts before a copy is added.</p>
                ${shareTargets.length === 0
                  ? html`<p class="muted">No other Gains profiles yet. They will appear after opening Gains once.</p>`
                  : html`
                      <ul class="draft-list">
                        ${shareTargets.map(
                          (p) => html`
                            <li>
                              <span>${p.displayName}</span>
                              <button
                                class="secondary"
                                ?disabled=${this._shareBusy}
                                @click=${() => this._shareWorkout(p.profileId)}
                              >
                                Send workout invite
                              </button>
                            </li>
                          `
                        )}
                      </ul>
                    `}
              </div>
            `
          : ""}
      </ha-dialog>
    `;
  }

  private _recapChartSeries(workout: Workout, exerciseId: string): { label: string; value: number }[] {
    const completedAt = this._recapCompletedAt ?? workout.completedAt ?? new Date().toISOString();
    const currentTime = Date.parse(completedAt);
    const previous = this.gainsState.workouts
      .filter((candidate) =>
        candidate.id !== workout.id &&
        candidate.status === "completed" &&
        candidate.exercises.some((exercise) => exercise.exerciseId === exerciseId),
      )
      .filter((candidate) => {
        const time = Date.parse(candidate.completedAt ?? candidate.startedAt ?? candidate.createdAt);
        return !Number.isFinite(currentTime) || !Number.isFinite(time) || time < currentTime;
      })
      .sort((a, b) =>
        Date.parse(a.completedAt ?? a.startedAt ?? a.createdAt) -
        Date.parse(b.completedAt ?? b.startedAt ?? b.createdAt),
      )
      .slice(-5);

    return [...previous, workout]
      .map((session, index) => {
        const stats = recapExerciseStats(session, exerciseId);
        if (stats.bestEstimated1RM == null) return null;
        const when = session.id === workout.id
          ? completedAt
          : session.completedAt ?? session.startedAt ?? session.createdAt;
        const parsed = new Date(when);
        return {
          label: Number.isNaN(parsed.getTime())
            ? `Session ${index + 1}`
            : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          value: stats.bestEstimated1RM,
        };
      })
      .filter((point): point is { label: string; value: number } => point !== null);
  }

  private _renderRecapChart(workout: Workout, exerciseId: string) {
    const series = this._recapChartSeries(workout, exerciseId);
    if (series.length < 2) return "";
    const values = series.map((point) => point.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const range = Math.max(high - low, high * 0.05, 1);
    const left = 12;
    const right = 288;
    const top = 12;
    const bottom = 88;
    const points = series.map((point, index) => {
      const x = left + (index / (series.length - 1)) * (right - left);
      const y = bottom - ((point.value - low) / range) * (bottom - top);
      return { ...point, x, y };
    });
    const units = this.gainsState.profile?.units === "metric" ? "kg" : "lb";
    return html`
      <div class="recap-chart">
        <div class="recap-chart-header">
          <strong>${exerciseName(exerciseId)} \u00b7 estimated 1RM trend</strong>
          <span>${series.length} sessions</span>
        </div>
        <svg viewBox="0 0 300 108" role="img" aria-label=${`${exerciseName(exerciseId)} estimated one rep max progress`}>
          <line class="recap-chart-grid" x1="12" y1="88" x2="288" y2="88"></line>
          <line class="recap-chart-grid" x1="12" y1="50" x2="288" y2="50"></line>
          <polyline class="recap-chart-line" points=${points.map((point) => `${point.x},${point.y}`).join(" ")}></polyline>
          ${points.map((point) => html`<circle class="recap-chart-dot" cx=${point.x} cy=${point.y} r="4"></circle>`)}
        </svg>
        <div class="recap-chart-header">
          <span>${points[0].label} \u00b7 ${points[0].value.toFixed(1)} ${units}</span>
          <span>${points[points.length - 1].label} \u00b7 ${points[points.length - 1].value.toFixed(1)} ${units}</span>
        </div>
      </div>
    `;
  }

  private _renderWorkoutRecap() {
    const workout = this.gainsState.workouts.find((candidate) => candidate.id === this._recapWorkoutId);
    if (!workout) return "";
    const units = this.gainsState.profile?.units === "metric" ? "kg" : "lb";
    const completedAt = workout.completedAt ?? this._recapCompletedAt ?? new Date().toISOString();
    const started = workout.startedAt ? Date.parse(workout.startedAt) : NaN;
    const finished = Date.parse(completedAt);
    const durationMinutes = Number.isFinite(started) && Number.isFinite(finished)
      ? Math.max(0, Math.round((finished - started) / 60000))
      : null;
    const exerciseIds = [...new Set(workout.exercises.map((exercise) => exercise.exerciseId))];
    const exerciseRows = exerciseIds.map((exerciseId) => {
      const stats = recapExerciseStats(workout, exerciseId);
      const previousWorkout = previousWorkoutForExercise(
        this.gainsState.workouts,
        workout,
        exerciseId,
        completedAt,
      );
      const previous = previousWorkout ? recapExerciseStats(previousWorkout, exerciseId) : null;
      const oneRmDelta = stats.bestEstimated1RM != null && previous?.bestEstimated1RM != null
        ? stats.bestEstimated1RM - previous.bestEstimated1RM
        : null;
      const volumeDelta = previous ? stats.volume - previous.volume : null;
      const repDelta = previous ? stats.totalReps - previous.totalReps : null;
      const improvements = [
        stats.prCount > 0 ? `${stats.prCount} new PR${stats.prCount === 1 ? "" : "s"}` : null,
        oneRmDelta != null && oneRmDelta > 0.05 ? `+${oneRmDelta.toFixed(1)} ${units} est. 1RM` : null,
        volumeDelta != null && volumeDelta > 0.5 ? `+${Math.round(volumeDelta).toLocaleString()} ${units} volume` : null,
        repDelta != null && repDelta > 0 ? `+${repDelta} reps` : null,
        !previous ? "First tracked session" : null,
      ].filter((value): value is string => value !== null);
      return { stats, previous, oneRmDelta, improvements };
    });

    const totalVolume = recapWorkoutVolume(workout);
    const completedSets = workout.exercises.reduce(
      (sum, exercise) => sum + exercise.sets.filter((set) => set.completed).length,
      0,
    );
    const prCount = exerciseRows.reduce((sum, row) => sum + row.stats.prCount, 0);
    const improvedCount = exerciseRows.filter((row) =>
      row.improvements.some((item) => !item.startsWith("First tracked")),
    ).length;
    const bestImprovement = exerciseRows
      .filter((row) => row.oneRmDelta != null && row.oneRmDelta > 0.05)
      .sort((a, b) => (b.oneRmDelta ?? 0) - (a.oneRmDelta ?? 0))[0];
    const chartExercise = bestImprovement?.stats.exerciseId ??
      exerciseRows.find((row) => this._recapChartSeries(workout, row.stats.exerciseId).length >= 2)?.stats.exerciseId;
    const headline = prCount > 0
      ? `${prCount} new PR${prCount === 1 ? "" : "s"}.`
      : improvedCount > 0
        ? "You moved forward."
        : "Work banked.";
    const message = prCount > 0
      ? "You set a new standard today. Recover well, then come back ready to make these numbers the ones you chase."
      : improvedCount > 0
        ? "No all-time PR was required to make progress. You improved measurable work today\u2014keep stacking sessions."
        : "Not every session needs a record. You finished the work, and consistency gives the next hard session somewhere to build from.";
    const targetRow = bestImprovement ?? exerciseRows.find((row) => row.stats.bestEstimated1RM != null);
    const nextTarget = targetRow?.stats.bestEstimated1RM != null
      ? `Next target: beat ${targetRow.stats.bestEstimated1RM.toFixed(1)} ${units} estimated 1RM on ${exerciseName(targetRow.stats.exerciseId)}.`
      : "Next target: repeat the session with clean form and add a little more quality work where it makes sense.";

    return html`
      <ha-dialog
        class="recap-dialog"
        .open=${!!this._recapWorkoutId}
        hideActions
        @closed=${() => { this._recapWorkoutId = null; this._recapCompletedAt = null; }}
      >
        <div class="recap">
          <div class="recap-hero">
            <button class="icon-button recap-close" aria-label="Close workout recap"
              @click=${() => { this._recapWorkoutId = null; this._recapCompletedAt = null; }}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
            <p class="recap-kicker">Workout complete</p>
            <h2>${headline}</h2>
            <p class="muted">${workout.name}${durationMinutes !== null ? ` \u00b7 ${durationMinutes} min` : ""}</p>
            <p class="recap-message">${message}</p>
          </div>

          <div class="recap-stats">
            <div class="recap-stat"><span>Volume</span><strong>${Math.round(totalVolume).toLocaleString()} ${units}</strong></div>
            <div class="recap-stat"><span>Sets</span><strong>${completedSets}</strong></div>
            <div class="recap-stat"><span>PRs</span><strong>${prCount}</strong></div>
            <div class="recap-stat"><span>Improved</span><strong>${improvedCount}</strong></div>
          </div>

          ${prCount > 0 ? html`
            <div class="recap-highlight">
              <ha-icon icon="mdi:arm-flex"></ha-icon>
              <div>
                <strong>Personal record${prCount === 1 ? "" : "s"} unlocked</strong>
                <span class="muted small">Gold markers below show where you raised your best estimated 1RM.</span>
              </div>
            </div>` : ""}

          ${chartExercise ? html`
            <section class="recap-section">
              <h3>Progress trend</h3>
              ${this._renderRecapChart(workout, chartExercise)}
            </section>` : ""}

          <section class="recap-section">
            <h3>Exercise breakdown</h3>
            <div class="recap-exercises">
              ${exerciseRows.map(({ stats, previous, improvements }) => {
                const setText = stats.sets.map((set) => {
                  const reps = set.actualReps ?? 0;
                  if (isTimedExercise(stats.exerciseId)) return `${reps}s`;
                  return set.actualWeight == null ? `${reps} reps` : `${set.actualWeight} ${units} \u00d7 ${reps}`;
                }).join(" \u00b7 ");
                return html`
                  <div class="recap-exercise">
                    <div class="recap-exercise-head">
                      <div>
                        <h4>${exerciseName(stats.exerciseId)}</h4>
                        <div class="recap-set-list">${setText || "No logged sets"}</div>
                      </div>
                      ${stats.prCount > 0 ? html`<span class="recap-pr"><ha-icon icon="mdi:arm-flex"></ha-icon>PR</span>` : ""}
                    </div>
                    <div class="recap-exercise-metrics">
                      ${!isTimedExercise(stats.exerciseId) ? html`<span>Volume <strong>${Math.round(stats.volume).toLocaleString()} ${units}</strong></span>` : ""}
                      ${stats.bestEstimated1RM != null ? html`<span>Best est. 1RM <strong>${stats.bestEstimated1RM.toFixed(1)} ${units}</strong></span>` : ""}
                      ${previous?.bestEstimated1RM != null ? html`<span>Previous <strong>${previous.bestEstimated1RM.toFixed(1)} ${units}</strong></span>` : ""}
                    </div>
                    ${improvements.length ? html`
                      <div class="recap-chips">
                        ${improvements.map((item) => html`<span class="recap-chip ${item.includes("PR") ? "pr" : ""}">${item}</span>`)}
                      </div>` : html`<p class="muted small">Solid work. No measurable increase over the most recent comparable session.</p>`}
                  </div>
                `;
              })}
            </div>
          </section>

          <section class="recap-section">
            <h3>Bring this to the next one</h3>
            <div class="recap-next">${nextTarget}</div>
          </section>

          <div class="recap-actions">
            <button class="secondary" @click=${() => {
              this._recapWorkoutId = null;
              this._recapCompletedAt = null;
              this.dispatchEvent(new CustomEvent("gains-switch-tab", {
                detail: { tab: "progress" },
                bubbles: true,
                composed: true,
              }));
            }}>View progress</button>
            <button class="secondary" @click=${() => {
              this._recapWorkoutId = null;
              this._recapCompletedAt = null;
              this._sharingWorkout = workout;
            }}>Share workout</button>
            <button class="primary" @click=${() => {
              this._recapWorkoutId = null;
              this._recapCompletedAt = null;
              this._openWorkoutId = null;
            }}>Done</button>
          </div>
        </div>
      </ha-dialog>
    `;
  }
  private _renderActiveWorkout(workout: Workout) {
    if (this._activeExerciseIndex !== null) {
      const exercise = workout.exercises[this._activeExerciseIndex];
      if (exercise) return html`${this._renderError()}${this._renderJointBanner(workout)}${this._renderExerciseDetailPage(workout,exercise,this._activeExerciseIndex)}${this._renderHistoryModal(exercise)}${this._renderEffortPromptDialog(workout)}${this._renderWorkoutRecap()}`;
      this._activeExerciseIndex = null;
    }
    const shared = this._sharedController(workout);
    const overviewSets = shared ? shared.jointSession!.participants.flatMap(p=>p.exercises.flatMap(e=>e.sets)) : workout.exercises.flatMap(e=>e.sets);
    const total = overviewSets.length;
    const completed = overviewSets.filter(s=>s.completed).length;
    const elapsed = workout.startedAt && workout.completedAt ? Math.max(0,Math.round((Date.parse(workout.completedAt)-Date.parse(workout.startedAt))/60000)) : null;
    const mapped = workout.exercises.filter(e=>workout.status!=="completed" || e.sets.some(s=>s.completed));
    const targetMuscles = workoutTargetMuscles(mapped.map((exercise) => exercise.exerciseId));
    return html`
      <div class="overview compact-workout-overview">
        ${this._renderError()}
        ${this._renderJointBanner(workout)}
        <div class="workout-overview-header">
          <button class="icon-button overview-back" aria-label="Back to workouts" @click=${() => this._openWorkoutId = null}>
            <ha-icon icon="mdi:arrow-left"></ha-icon>
          </button>
          <div class="workout-overview-title">
            <h1>${workout.name}</h1>
            <span class="badge">${workout.status}</span>
          </div>
        </div>

        <div class="summary-stats compact-summary">
          <span><strong>${workout.exercises.length}</strong>exercises</span>
          <span><strong>${workout.status === "planned" ? total : `${completed}/${total}`}</strong>${workout.status === "planned" ? "sets" : "sets logged"}</span>
          ${elapsed !== null && Number.isFinite(elapsed) ? html`<span><strong>${elapsed}</strong>minutes</span>` : ""}
        </div>

        ${targetMuscles.length ? html`
          <section class="target-muscle-section">
            <h2>Target muscles</h2>
            <p class="muted small">Estimated readiness from logged sets \u00b7 100% means recovered</p>
            <div class="target-muscle-strip">
              ${targetMuscles.map((target) => html`
                <div class="target-muscle-card">
                  <gains-muscle-map
                    class="target-muscle-thumbnail"
                    compact
                    both
                    .muscleIds=${[target.muscle]}
                  ></gains-muscle-map>
                  <div class="target-muscle-copy">
                    <strong>${target.label}</strong>
                    <span>${recoveryPercent(this.gainsState.muscleRecovery, target.muscle) === undefined ? "Recovery unavailable" : `${recoveryPercent(this.gainsState.muscleRecovery, target.muscle)}% recovered`}</span>
                  </div>
                </div>
              `)}
            </div>
          </section>
        ` : ""}

        <section class="workout-exercises-section">
          <div class="workout-section-heading">
            <h2>${workout.exercises.length} exercise${workout.exercises.length === 1 ? "" : "s"}</h2>
          </div>
          <div class="exercise-overview-list">
            ${workout.exercises.map((exercise,index)=>this._renderExerciseListRow(workout,exercise,index))}
          </div>
          ${["planned", "active"].includes(workout.status) ? html`
            <button class="secondary add-exercise-button" @click=${() => { this._addingToWorkout = workout; this._pickerOpen = true; }}>
              <ha-icon icon="mdi:plus"></ha-icon>Add exercise
            </button>
            ${isJointParticipant(workout.jointSession, workout.profileId) ? html`<p class="muted small">Adding or removing an exercise applies to everyone in this Workout Together session.</p>` : ""}
          ` : ""}
        </section>

        ${this._renderRestTimerBanner()}
        ${this._renderSharedFinish(workout)}
        <div class="workout-overview-actions">
          ${workout.status === "planned" ? html`
            <button class="primary" ?disabled=${this._busy} @click=${()=>this._startWorkout(workout.id)}>Start workout</button>
            <button class="secondary" @click=${()=>this._skipWorkout(workout.id)}>Skip workout</button>
          ` : workout.status === "active" && !isSharedController(workout.jointSession,workout.profileId) ? html`
            <button class="primary" ?disabled=${this._busy} @click=${this._completeWorkout}>Finish workout</button>
          ` : ""}
        </div>
        ${this._finishConfirm && workout.status === "active" ? html`
          <div class="finish-warning" role="alert">
            <p>Finish with ${total-completed} unlogged sets? They will stay incomplete.</p>
            <div class="actions">
              <button class="primary" ?disabled=${this._busy} @click=${this._completeWorkout}>Finish and save</button>
              <button class="secondary" @click=${()=>this._finishConfirm=false}>Keep training</button>
            </div>
          </div>
        ` : ""}
        <div class="workout-secondary-actions">
          ${workout.status === "completed" ? html`<button class="secondary" @click=${()=>{this._recapWorkoutId=workout.id;this._recapCompletedAt=workout.completedAt;}}>Workout recap</button>` : ""}
          <button class="secondary" @click=${()=>this._sharingWorkout=workout}>Share</button>
          <button class="secondary danger-text" @click=${()=>this._deleteWorkout(workout.id,workout.name)}>Delete</button>
        </div>
        ${this._renderEffortPromptDialog(workout)}${this._renderExerciseMenuDialog()}${this._renderReplaceExerciseDialog()}${this._renderPickerDialog()}${this._renderShareDialog()}${this._renderWorkoutRecap()}
      </div>
    `;
  }

  private _renderExerciseListRow(
    workout: Workout,
    exercise: Workout["exercises"][number],
    exerciseIndex: number
  ) {
    const shared = this._sharedController(workout);
    const sets = shared ? shared.jointSession!.participants.flatMap(p=>p.exercises[exerciseIndex]?.sets ?? []) : exercise.sets;
    const loggedCount = sets.filter((set) => set.completed).length;
    const units = this.gainsState.profile?.units === "metric" ? "kg" : "lb";
    const prescription = compactExercisePrescription(exercise, workout.status, units);
    const progress = workout.status === "active" || shared
      ? `${loggedCount}/${sets.length} logged`
      : exercise.effort
        ? `Felt ${exercise.effort}`
        : "";

    return html`
      <div class="exercise-list-row">
        <button class="exercise-card-header" @click=${() => this._goToExercise(workout, exerciseIndex)}>
          <gains-muscle-map class="exercise-thumbnail" compact both .exerciseIds=${[exercise.exerciseId]}></gains-muscle-map>
          <span class="exercise-card-info">
            <span class="exercise-card-name">${exerciseName(exercise.exerciseId)}</span>
            <span class="exercise-card-summary">${prescription}</span>
            ${progress ? html`<span class="exercise-card-progress">${progress}</span>` : ""}
          </span>
          <ha-icon icon="mdi:chevron-right"></ha-icon>
        </button>
        ${["planned", "active"].includes(workout.status) ? html`
          <button class="exercise-menu-trigger" aria-label=${`Options for ${exerciseName(exercise.exerciseId)}`}
            @click=${() => { this._exerciseMenu = { workout, exerciseIndex, exerciseId: exercise.exerciseId }; }}>
            <ha-icon icon="mdi:dots-vertical"></ha-icon>
          </button>` : ""}
      </div>
    `;
  }

  private _renderExerciseMenuDialog() {
    const target = this._exerciseMenu;
    return html`
      <ha-dialog .open=${!!target} hideActions @closed=${() => (this._exerciseMenu = null)}>
        <div class="picker-header">
          <div><p class="muted small">Exercise options</p><h2>${target ? exerciseName(target.exerciseId) : ""}</h2></div>
          <button class="icon-button" aria-label="Close exercise options" @click=${() => (this._exerciseMenu = null)}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>
        ${target ? html`<div class="exercise-menu">
          <button class="secondary" ?disabled=${isJointParticipant(target.workout.jointSession, target.workout.profileId)} @click=${() => {
            this._exerciseMenu = null;
            this._openReplacePicker(target.workout, target.exerciseIndex, target.exerciseId);
          }}><ha-icon icon="mdi:swap-horizontal"></ha-icon>Change exercise</button>
          <button class="secondary danger" @click=${() => {
            this._exerciseMenu = null;
            void this._removeExercise(target.workout, target.exerciseIndex, target.exerciseId);
          }}><ha-icon icon="mdi:trash-can-outline"></ha-icon>Remove exercise</button>
          ${isJointParticipant(target.workout.jointSession, target.workout.profileId) ? html`<p class="muted small">While working out together, swap an exercise by removing it and adding the new one -- that keeps both athletes on the same list. Removing applies to everyone.</p>` : ""}
        </div>` : ""}
      </ha-dialog>
    `;
  }
  private _renderReplaceExerciseDialog() {
    const target = this._replacingExercise;
    const filters = this._replacementFilters;
    const options = target ? replacementLibrary(EXERCISE_LIBRARY,
      EXERCISE_LIBRARY.find(e => e.id === target.currentExerciseId),
      target.workout.profileId === this.gainsState.profile?.profileId ? this.gainsState.profile.inventoryPolicy ?? {} : {}, filters) : [];
    const update = (patch: Partial<LibraryFilters>) => { this._replacementFilters = { ...filters, ...patch }; };
    const gym = this.gainsState.gymProfiles.find(g => g.id === this.gainsState.profile?.gymProfileId);
    return html`
      <ha-dialog
        .open=${!!target}
        hideActions
        @closed=${() => (this._replacingExercise = null)}
      >
        <div class="picker-header">
          <button class="icon-button" @click=${() => (this._replacingExercise = null)}>
            <ha-icon icon="mdi:arrow-left"></ha-icon>
          </button>
          <h2>Replace exercise</h2>
        </div>
        <div class="picker-body replace-body">
          <p class="muted small">Equipment checked for ${gym?.name ?? "your selected gym"}. Logged sets stay with the original exercise.</p>
          <div class="search-row">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input type="search" aria-label="Search exercises" placeholder="Search exercises" .value=${filters.search}
              @input=${(e: Event) => update({ search: (e.target as HTMLInputElement).value })}>
          </div>
          <div class="filter-chips" role="group" aria-label="Which exercises to show">
            <button class="chip ${filters.mode === "recommended" ? "active" : ""}" aria-pressed=${filters.mode === "recommended"} @click=${() => update({ mode: "recommended" })}>Similar</button>
            <button class="chip ${filters.mode === "all" ? "active" : ""}" aria-pressed=${filters.mode === "all"} @click=${() => update({ mode: "all" })}>All exercises</button>
            <button class="chip ${filters.showUnavailable ? "active" : ""}" aria-pressed=${filters.showUnavailable} @click=${() => update({ showUnavailable: !filters.showUnavailable })}>Show unavailable</button>
          </div>
          <details class="replacement-more-filters" ?open=${!!(filters.muscle || filters.equipment || filters.movement)}>
            <summary>More filters</summary>
            <div class="replacement-filters">
              <label>Muscle<select @change=${(e: Event) => update({ muscle: (e.target as HTMLSelectElement).value, mode: "all" })}>
                <option value="" ?selected=${!filters.muscle}>All muscles</option>${Object.keys(MUSCLE_DICTIONARY).map(id => html`<option value=${id} ?selected=${filters.muscle === id}>${muscleLabels([id as MuscleId])}</option>`)}</select></label>
              <label>Equipment<select @change=${(e: Event) => update({ equipment: (e.target as HTMLSelectElement).value, mode: "all" })}>
                <option value="" ?selected=${!filters.equipment}>All equipment</option>${EQUIPMENT_OPTIONS.map(id => html`<option value=${id} ?selected=${filters.equipment === id}>${labelize(id)}</option>`)}</select></label>
              <label>Movement<select @change=${(e: Event) => update({ movement: (e.target as HTMLSelectElement).value, mode: "all" })}>
                <option value="" ?selected=${!filters.movement}>All movements</option>${[...CATEGORY_OPTIONS].sort().map(id => html`<option value=${id} ?selected=${filters.movement === id}>${labelize(id)}</option>`)}</select></label>
              <label>Sort<select @change=${(e: Event) => update({ sort: (e.target as HTMLSelectElement).value as "recommended" | "name" })}>
                <option value="recommended" ?selected=${filters.sort !== "name"}>Best match</option><option value="name" ?selected=${filters.sort === "name"}>Exercise name</option></select></label>
            </div>
          </details>
          <p role="status" class="muted small">${options.length} exercise${options.length === 1 ? "" : "s"}${filters.mode === "recommended" ? " similar to this one" : ""}</p>
          ${filters.mode === "recommended" && options.length < 8 ? html`<button class="secondary" @click=${() => update({ mode: "all" })}>Browse the entire library</button>` : ""}
          ${!options.length && !filters.showUnavailable ? html`<button class="secondary" @click=${() => update({ showUnavailable: true })}>Show exercises missing equipment</button>` : ""}
          <div class="exercise-results">
            ${options.map(
              ({ exercise: ex, availability, score }) => html`
                <button
                  class="exercise-row"
                  ?disabled=${!(availability.selectable || availability.feasible)}
                  @click=${() => this._selectReplacementExercise(ex.id)}
                >
                  <span
                    class="exercise-row-swatch"
                    style="background: ${categoryColor(ex.category)}"
                  ></span>
                  <span class="exercise-row-text">
                    <span class="exercise-row-name">${ex.name}</span>
                    <span class="exercise-row-sub"
                      >${labelize(ex.equipment)}${score >= 10 ? " \u00b7 Similar muscles" : ""}${availability.feasible ? "" : " \u00b7 " + (availability.selectable ? "Enter weight manually; load inventory unverified" : availability.reasons.join("; "))}</span
                    >
                  </span>
                </button>
              `
            )}
          </div>
        </div>
      </ha-dialog>
    `;
  }

  private _renderEffortPromptDialog(workout: Workout) {
    workout = (this._effortPromptWorkoutId && this._sessionWorkout(this._effortPromptWorkoutId)) || workout;
    const exerciseIndex = this._effortPromptExerciseIndex;
    const exercise = exerciseIndex !== null ? workout.exercises[exerciseIndex] : undefined;
    const open = exerciseIndex !== null && !!exercise;

    return html`
      <ha-dialog
        .open=${open}
        hideActions
        @closed=${() => (this._effortPromptExerciseIndex = null)}
      >
        ${exercise
          ? html`
              <div class="picker-header">
                <h2>${this._sharedController(workout) ? `${workout.jointSession?.participants.find(p=>p.profile_id===workout.profileId)?.display_name}: ` : ""}How did ${exerciseName(exercise.exerciseId)} feel?</h2>
              </div>
              <div class="effort-prompt-body">
                ${EFFORT_LEVELS.map(
                  (level) => html`
                    <button
                      class="secondary"
                      @click=${() =>
                        this._logExerciseEffort(workout, exerciseIndex as number, level)}
                    >
                      ${level[0].toUpperCase()}${level.slice(1)}
                    </button>
                  `
                )}
              </div>
            `
          : ""}
      </ha-dialog>
    `;
  }

  private _renderExerciseDetailPage(
    workout: Workout,
    exercise: Workout["exercises"][number],
    exerciseIndex: number
  ) {
    const shared = this._sharedController(workout);
    const allSets = shared ? shared.jointSession!.participants.flatMap(p => p.exercises[exerciseIndex]?.sets ?? []) : exercise.sets;
    const loggedCount = allSets.filter(s => s.completed).length;
    const setCount = allSets.length;
    const nextSetIndex = exercise.sets.findIndex((s) => !s.completed);
    const controller = this._sharedController(workout);
    const turn = controller ? exerciseTurn(controller.jointSession, exerciseIndex) : null;
    const turnWorkout = controller && turn ? participantWorkout(controller, turn.profile_id) : undefined;
    const loggingWorkout = turnWorkout ?? workout;
    const loggingExercise = loggingWorkout.exercises[exerciseIndex];
    const loggingSetIndex = controller ? (turn ? turn.set_index : -1) : nextSetIndex;
    const jointLocked = isJointParticipant(workout.jointSession, workout.profileId);
    const canLogNext = loggingSetIndex >= 0 && canLogJointSet(loggingWorkout.jointSession, loggingWorkout.profileId, exerciseIndex, loggingSetIndex, false);
    const timedExercise = isTimedExercise(exercise.exerciseId);
    const barbellExercise = exerciseEquipment(exercise.exerciseId) === "barbell";
    const units = this.gainsState.profile?.units === "metric" ? "kg" : "lb";

    return html`
      <ha-card class="panel">
        <div class="exercise-page-header">
          <button
            class="icon-button"
            aria-label="Back to workout exercises"
            @click=${() => {
              this._activeExerciseIndex = null;
              this._videoModalOpen = false;
            }}
          >
            <ha-icon icon="mdi:arrow-left"></ha-icon>
          </button>
          <span
            class="exercise-page-swatch"
            style="background: ${categoryColor(exerciseCategory(exercise.exerciseId))}"
          ></span>
          <div class="exercise-page-title">
            <h2>${exerciseName(exercise.exerciseId)}</h2>
            <span class="muted small"
              >${setCount} sets \u00b7 ${loggedCount}/${setCount} logged${exercise.effort
                ? ` \u00b7 felt ${exercise.effort}`
                : ""}</span
            >
          </div>
          <button
            class="icon-button"
            title="How to perform this exercise"
            @click=${() => (this._videoModalOpen = true)}
          >
            <ha-icon icon="mdi:information-outline"></ha-icon>
          </button>
        </div>
        <div class="exercise-focus"><div><p>Target muscles</p><strong>${muscleGroupsForExercise(exercise.exerciseId)}</strong></div><gains-muscle-map compact both .exerciseIds=${[exercise.exerciseId]}></gains-muscle-map></div>
        <div class="exercise-nav">
          <button class="secondary" aria-label="Previous exercise" ?disabled=${exerciseIndex === 0} @click=${() => this._goToExercise(workout, exerciseIndex - 1)}><ha-icon icon="mdi:chevron-left"></ha-icon>Prev</button>
          <p class="session-progress">${exerciseIndex+1} of ${workout.exercises.length} exercises \u00b7 ${loggedCount}/${setCount} sets logged</p>
          <button class="secondary" aria-label="Next exercise" ?disabled=${exerciseIndex >= workout.exercises.length - 1} @click=${() => this._goToExercise(workout, exerciseIndex + 1)}>Next<ha-icon icon="mdi:chevron-right"></ha-icon></button>
        </div>
        <button class="secondary" @click=${() => this._historyModalOpen = true}><ha-icon icon="mdi:history"></ha-icon> History</button>
        ${workout.status === "active" ? html`<div class="actions"><button class="secondary" ?disabled=${jointLocked} title=${jointLocked ? "Sets stay matched while working out together" : ""} @click=${()=>this._sessionEdit(workout,"add_set",{exercise_index:exerciseIndex})}>Add set</button><button class="secondary" @click=${()=>this._skipExercise(workout,exerciseIndex)}>Skip exercise</button></div><details><summary>Exercise notes</summary><textarea .value=${exercise.notes} @change=${(e:Event)=>this._sessionEdit(workout,"notes",{exercise_index:exerciseIndex,notes:(e.target as HTMLTextAreaElement).value})}></textarea></details>`:""}
        <div class="set-grid-header ${barbellExercise ? "with-loading" : ""}">
          <span>Set</span>
          <span>${timedExercise ? "Seconds" : "Reps"}</span>
          <span>${controller ? "Weight" : barbellExercise ? `Total ${units}` : `Weight ${units}`}</span>
          ${barbellExercise ? html`<span aria-hidden="true"></span>` : ""}
        </div>
        ${controller ? exercise.sets.map((_, setIndex) => controller.jointSession!.participants.map(p => {
          const target = participantWorkout(controller, p.profile_id)!;
          const set = target.exercises[exerciseIndex]?.sets[setIndex];
          if (!set) return "";
          const current = p.profile_id === turn?.profile_id && setIndex === turn.set_index;
          return html`<div class="participant-set"><p class="muted small">${p.display_name}${current ? " - Your turn" : ""} (${this._workoutUnits(target) === "metric" ? "kg" : "lb"})</p>${this._renderSetRow(target, exerciseIndex, setIndex, set, current)}</div>`;
        })) : exercise.sets.map((set, setIndex) =>
          this._renderSetRow(workout, exerciseIndex, setIndex, set, setIndex === nextSetIndex)
        )}
        ${workout.status === "active" ? this._renderRestTimerBanner() : ""}
        ${loggingSetIndex !== -1 && (workout.status === "active" || !!controller)
          ? timedExercise
            ? html`
                <div class="timed-log-actions">
                  <button
                    class="secondary timer-launch-button"
                    ?disabled=${this._savingSet !== null || !canLogNext}
                    @click=${() =>
                      this._openTimedSetTimer(loggingWorkout, exerciseIndex, loggingSetIndex, loggingExercise.sets[loggingSetIndex])}
                  >
                    <ha-icon icon="mdi:timer-outline"></ha-icon>
                    Timer
                  </button>
                  <button
                    class="primary log-set-button"
                    ?disabled=${this._savingSet !== null || !canLogNext}
                    @click=${() =>
                      this._logSet(loggingWorkout, exerciseIndex, loggingSetIndex, loggingExercise.sets[loggingSetIndex])}
                  >
                    ${this._savingSet ? "Saving\u2026" : `Log set ${loggingSetIndex + 1}${controller ? ` - ${controller.jointSession!.participants.find(p => p.profile_id === loggingWorkout.profileId)?.display_name}` : ""}`}
                  </button>
                </div>
              `
            : html`
                <button
                  class="primary log-set-button"
                  ?disabled=${this._savingSet !== null || !canLogNext}
                  @click=${() =>
                    this._logSet(loggingWorkout, exerciseIndex, loggingSetIndex, loggingExercise.sets[loggingSetIndex])}
                >
                  ${this._savingSet ? "Saving\u2026" : `Log set ${loggingSetIndex + 1}${controller ? ` - ${controller.jointSession!.participants.find(p => p.profile_id === loggingWorkout.profileId)?.display_name}` : ""}`}
                </button>
              `
          : ""}
      </ha-card>
      ${this._renderVideoModal(exercise)}
      ${this._renderTimedSetTimerDialog()}
      ${this._renderLoadingPickerDialog()}
    `;
  }

  private _renderVideoModal(exercise: Workout["exercises"][number]) {
    const name = exerciseName(exercise.exerciseId);
    const videoUrl = exerciseVideoUrl(exercise.exerciseId);
    const embedId = videoUrl ? youtubeEmbedId(videoUrl) : null;
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} exercise form`)}`;
    const muscleGroups = muscleGroupsForExercise(exercise.exerciseId);


    return html`
      <ha-dialog
        .open=${this._videoModalOpen}
        hideActions
        @closed=${() => (this._videoModalOpen = false)}
      >
        <div class="picker-header">
          <button class="icon-button" @click=${() => (this._videoModalOpen = false)}>
            <ha-icon icon="mdi:arrow-left"></ha-icon>
          </button>
          <h2>${name}</h2>
        </div>
        <div class="video-modal-body">
          <p class="muted small">Muscles worked: ${muscleGroups}</p>
          <gains-muscle-map .exerciseIds=${[exercise.exerciseId]}></gains-muscle-map>

          ${embedId
            ? html`
                <div class="video-embed-wrapper">
                  <iframe
                    src="https://www.youtube.com/embed/${embedId}"
                    title="${name} how-to video"
                    frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowfullscreen
                  ></iframe>
                </div>
              `
            : html`
                <p class="muted">No demo video linked for ${name} yet.</p>
                <a class="button-link" href=${searchUrl} target="_blank" rel="noopener noreferrer">
                  <button class="secondary">Search YouTube for ${name}</button>
                </a>
              `}
        </div>
      </ha-dialog>
    `;
  }

  private async _sessionEdit(workout:Workout,action:string,fields:Record<string,unknown>):Promise<boolean>{
    this._error="";
    try {await trainingService(this.hass,"session_action",{action,fields:{workout_id:workout.id,expected_revision:workout.revision,...fields},...this._coachTarget()});
      this.dispatchEvent(new CustomEvent("training-refresh",{bubbles:true,composed:true}));
      return true;
    } catch(e) {this._error=serviceErrorMessage(e); return false;}
  }

  private _coachTarget(): Record<string, string> {
    return this.viewContext?.mode==="coach" ? {target_profile_id:this.viewContext.activeProfileId} : {};
  }

  private _goToExercise(workout: Workout, exerciseIndex: number): void {
    if (exerciseIndex < 0 || exerciseIndex >= workout.exercises.length) return;
    this._activeExerciseIndex = exerciseIndex;
    this._videoModalOpen = false;
    this._historyModalOpen = false;
    this._error = "";
    if (workout.status !== "active") return;
    // No expected_revision: focus only moves the "current exercise" pointer
    // (and Workout Together's turn), so quick Prev/Next taps shouldn't trip
    // the stale-revision check. Best effort -- navigation works regardless.
    void trainingService(this.hass, "session_action", {action: "focus",
      fields: {workout_id: workout.id, exercise_index: exerciseIndex, set_index: 0}, ...this._coachTarget()})
      .then(() => this.dispatchEvent(new CustomEvent("training-refresh", {bubbles: true, composed: true})))
      .catch(() => undefined);
  }

  private async _skipExercise(workout: Workout, exerciseIndex: number): Promise<void> {
    if (!(await this._sessionEdit(workout, "skip_exercise", {exercise_index: exerciseIndex}))) return;
    // The backend already moved its focus forward; follow it on screen.
    this._videoModalOpen = false;
    this._historyModalOpen = false;
    this._activeExerciseIndex = exerciseIndex < workout.exercises.length - 1 ? exerciseIndex + 1 : null;
  }

  private async _addExerciseToWorkout(workout: Workout, exerciseId: string): Promise<void> {
    await this._sessionEdit(workout, "add_exercise", {exercise_id: exerciseId});
  }

  private async _setBar(workout: Workout, exerciseIndex: number, choice: BarChoice): Promise<void> {
    const controller = this._sharedController(workout);
    if (!controller || controller.id === workout.id) {
      await this._sessionEdit(workout, "set_bar", {exercise_index: exerciseIndex, equipment_id: choice.equipmentId, bar_weight: choice.weight});
      return;
    }
    // Same-device Workout Together: the partner's workout isn't this
    // account's, so it goes through the shared session controller.
    this._error = "";
    try {
      await trainingService(this.hass, "joint_session_action", {action: "set_bar", fields: {
        workout_id: controller.id, expected_revision: controller.revision,
        participant_profile_id: workout.profileId, exercise_index: exerciseIndex,
        equipment_id: choice.equipmentId, bar_weight: choice.weight,
      }});
      this.dispatchEvent(new CustomEvent("training-refresh", {bubbles: true, composed: true}));
    } catch (e) { this._error = serviceErrorMessage(e); }
  }

  /** Most recent completed sessions that logged this exercise, newest first. */
  private _exerciseHistory(exerciseId: string): { workout: Workout; stats: RecapExerciseStats }[] {
    const when = (w: Workout) => Date.parse(w.completedAt ?? w.startedAt ?? w.createdAt) || 0;
    return this.gainsState.workouts
      .filter(w => w.status === "completed" && w.exercises.some(e => e.exerciseId === exerciseId && e.sets.some(set => set.completed)))
      .sort((a, b) => when(b) - when(a))
      .slice(0, 10)
      .map(workout => ({ workout, stats: recapExerciseStats(workout, exerciseId) }));
  }

  private _renderHistoryModal(exercise: Workout["exercises"][number]) {
    if (!this._historyModalOpen) return "";
    const name = exerciseName(exercise.exerciseId);
    const timed = isTimedExercise(exercise.exerciseId);
    const units = this.gainsState.profile?.units === "metric" ? "kg" : "lb";
    const history = this._exerciseHistory(exercise.exerciseId);
    return html`
      <ha-dialog .open=${true} hideActions @closed=${() => (this._historyModalOpen = false)}>
        <div class="picker-header">
          <button class="icon-button" aria-label="Close history" @click=${() => (this._historyModalOpen = false)}>
            <ha-icon icon="mdi:arrow-left"></ha-icon>
          </button>
          <div><p class="muted small">History \u00b7 ${this.gainsState.profile?.displayName ?? ""}</p><h2>${name}</h2></div>
        </div>
        <div class="history-body">
          ${history.length ? history.map(({ workout, stats }) => {
            const date = new Date(workout.completedAt ?? workout.startedAt ?? workout.createdAt);
            const effort = workout.exercises.find(e => e.exerciseId === exercise.exerciseId && e.effort)?.effort;
            return html`
              <section class="history-entry">
                <div class="history-entry-header">
                  <strong>${Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</strong>
                  <span class="muted small">${workout.name}</span>
                </div>
                <ol class="history-sets">
                  ${stats.sets.map(set => html`<li>${set.actualReps ?? "\u2014"}${timed ? "s" : " reps"}${!timed || set.actualWeight ? ` \u00d7 ${set.actualWeight ?? 0} ${units}` : ""}${set.isPersonalRecord ? html` <ha-icon class="history-pr" icon="mdi:arm-flex" title="Personal record"></ha-icon>` : ""}</li>`)}
                </ol>
                <p class="muted small">
                  ${timed ? `${stats.totalReps}s total` : `${Math.round(stats.volume)} ${units} volume`}${stats.bestEstimated1RM != null ? ` \u00b7 est. 1RM ${stats.bestEstimated1RM.toFixed(1)} ${units}` : ""}${effort ? ` \u00b7 felt ${effort}` : ""}
                </p>
              </section>`;
          }) : html`<p class="muted">No completed sessions with ${name} yet. Finish a workout with it and it will show up here.</p>`}
        </div>
      </ha-dialog>
    `;
  }

  private _renderSetRow(
    workout: Workout,
    exerciseIndex: number,
    setIndex: number,
    set: WorkoutSet,
    isActive: boolean
  ) {
    const key = `${workout.id}:${exerciseIndex}:${setIndex}`;
    const exercise = workout.exercises[exerciseIndex];
    const isBarbell = exerciseEquipment(exercise.exerciseId) === "barbell";
    const isTimed = isTimedExercise(exercise.exerciseId);
    const { reps: suggestedReps, weight: suggestedSetWeight } = set.completed
      ? { reps: set.actualReps, weight: set.actualWeight }
      : nextSetSuggestion(
          exercise,
          setIndex,
          workout.profileId === this.gainsState.profile?.profileId ? this.gainsState.profile.inventoryPolicy?.[exercise.exerciseId] : workout.jointSession?.participants.find(p => p.profile_id === workout.profileId)?.inventory_policy?.[exercise.exerciseId]
        );
    const draft = this._draftLogs[key];
    const rowClass = set.completed ? "done" : isActive ? "active" : "";
    const editing = this._editingSet === key;
    const editable = workout.status === "active" && (!set.completed || editing) &&
      canLogJointSet(workout.jointSession,workout.profileId,exerciseIndex,setIndex,set.completed);
    const reps = draft?.reps ?? suggestedReps;
    const weight = draft?.weight ?? suggestedSetWeight;
    const units = this._workoutUnits(workout) === "metric" ? "kg" : "lb";
    const repsFieldLabel = isTimed ? "Seconds" : "Reps";
    const prValue = set.personalRecordValue;
    const previousPr = set.previousPersonalRecord;
    const prMessage = set.isPersonalRecord && prValue != null
      ? previousPr != null
        ? `Personal record \u00b7 Estimated 1RM ${prValue.toFixed(1)} ${units} \u00b7 Previous PR ${previousPr.toFixed(1)} ${units}`
        : `Personal record \u00b7 Estimated 1RM ${prValue.toFixed(1)} ${units} \u00b7 No previous PR`
      : "";
    const loadingButton = isBarbell
      ? html`
          <button
            class="set-loading-button"
            type="button"
            aria-label=${`Open plate and bar setup for set ${setIndex + 1}`}
            title="Plate & bar setup"
            @click=${() => (this._loadingPicker = {
              workoutId: workout.id,
              exerciseIndex,
              setIndex,
            })}
          ><span class="mini-barbell-icon" aria-hidden="true"></span></button>
        `
      : "";

    if (set.completed && !editing) {
      return html`
        <div class="set-row gravl-set-row done ${isBarbell ? "with-loading" : ""}">
          <span class="set-number-box">${setIndex + 1}</span>
          <span class="set-readonly-value">${reps ?? "\u2014"}${isTimed ? "s" : ""}</span>
          <span class="set-readonly-value">${weight != null ? `${weight}` : "\u2014"}</span>
          ${loadingButton}
          <div class="set-row-meta">
            <ha-icon icon="mdi:check-circle" class="set-status-icon" title="Logged"></ha-icon>
            ${set.isPersonalRecord ? html`
              <span class="pr-badge-wrap ${this._prTooltipKey === key ? "open" : ""}">
                <button
                  class="pr-badge"
                  type="button"
                  aria-label=${prMessage}
                  aria-expanded=${this._prTooltipKey === key}
                  @click=${() => (this._prTooltipKey = this._prTooltipKey === key ? null : key)}
                ><ha-icon icon="mdi:arm-flex"></ha-icon></button>
                <span class="pr-tooltip" role="tooltip">${prMessage}</span>
              </span>
            ` : ""}
            ${workout.status === "active"
              ? html`<button class="secondary set-edit" @click=${() => (this._editingSet = key)}>Edit</button>`
              : ""}
          </div>
        </div>
      `;
    }

    const removable = !isJointParticipant(workout.jointSession,workout.profileId) && !set.completed && workout.status === "active" && exercise.sets.length > 1;
    const swipeOffset = removable ? (this._setSwipeOffsets[key] ?? 0) : 0;
    const swipeArmed = swipeOffset <= -116;
    const swipeDeleting = this._setSwipeDeletingKey === key;
    return html`
      <div class="set-swipe-shell ${swipeOffset < 0 ? "swiping" : ""} ${swipeArmed ? "armed" : ""} ${swipeDeleting ? "deleting" : ""}">
        ${removable ? html`
          <div class="set-swipe-delete-lane" aria-hidden="true">
            <ha-icon icon="mdi:trash-can-outline"></ha-icon>
            <span>${swipeArmed ? "Release to delete" : "Swipe to delete"}</span>
          </div>
        ` : ""}
        <div
          class="set-row gravl-set-row ${rowClass} ${isBarbell ? "with-loading" : ""} ${removable ? "swipe-remove" : ""}"
          style=${`transform: translateX(${swipeOffset}px)`}
          @touchstart=${removable ? (event: TouchEvent) => this._startSetSwipe(event, key) : undefined}
          @touchmove=${removable ? (event: TouchEvent) => this._moveSetSwipe(event, key) : undefined}
          @touchend=${removable ? (event: TouchEvent) => this._endSetSwipe(event, key, workout, exerciseIndex, setIndex) : undefined}
          @touchcancel=${removable ? () => this._cancelSetSwipe(key) : undefined}
        >
          <span class="set-number-box">${setIndex + 1}</span>
          <label class="set-field reps-field">
            <span class="visually-hidden">${repsFieldLabel}</span>
            <input
              class="reps-input"
              type="number"
              inputmode="numeric"
              min="1"
              step="1"
              aria-label=${`Set ${setIndex + 1} ${isTimed ? "seconds held" : "repetitions"}`}
              ?disabled=${!editable || this._savingSet !== null}
              .value=${reps != null ? String(reps) : ""}
              @focus=${this._clearInputForReplacement}
              @blur=${this._restoreInputIfEmpty}
              @input=${(e:Event)=>this._updateDraftLog(key,{reps:Number((e.target as HTMLInputElement).value)})}
            />
          </label>
          <label class="set-field weight-field">
            <span class="visually-hidden">Weight in ${units}</span>
            <input
              class="weight-input"
              type="number"
              inputmode="decimal"
              min="0"
              step="any"
              aria-label=${`Set ${setIndex + 1} weight in ${units}`}
              ?disabled=${!editable || this._savingSet !== null}
              .value=${weight != null ? String(weight) : ""}
              @focus=${this._clearInputForReplacement}
              @blur=${this._restoreInputIfEmpty}
              @input=${(e:Event)=>this._updateDraftLog(key,{weight:Number((e.target as HTMLInputElement).value)})}
            />
          </label>
          ${loadingButton}
          ${removable || editing ? html`
            <div class="set-tools">
              ${removable ? html`
                <button
                  class="set-remove-button"
                  type="button"
                  aria-label=${`Remove set ${setIndex + 1}`}
                  title="Remove set"
                  @click=${()=>{delete this._draftLogs[key];void this._sessionEdit(workout,"remove_set",{exercise_index:exerciseIndex,set_index:setIndex});}}
                ><ha-icon icon="mdi:minus"></ha-icon></button>
              ` : ""}
              ${editing ? html`
                <button class="secondary" @click=${()=>{this._editingSet=null;delete this._draftLogs[key];}}>Cancel</button>
                <button class="primary" ?disabled=${this._savingSet !== null} @click=${()=>this._logSet(workout,exerciseIndex,setIndex,set)}>Save</button>
              ` : ""}
            </div>
          ` : ""}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gains-workouts-view": GainsWorkoutsView;
  }
}


