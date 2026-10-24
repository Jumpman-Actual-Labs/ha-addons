import type { BuilderAnswers } from "./training-types";

/** Mirrors the owned Gains backend's supported split contracts, not a third-party catalog. */
export const PROGRAM_SPLITS: Record<string, string[]> = {
  "Full Body": ["Full Body"],
  "Upper / Lower": ["Upper", "Lower"],
  "Push / Pull / Legs": ["Push", "Pull", "Legs"],
  "Upper / Lower / Push / Pull": ["Upper", "Lower", "Push", "Pull"],
  "Arnold Split": ["Chest/Back", "Shoulders/Arms", "Legs"],
  "Body-Part Split": ["Chest", "Back", "Shoulders", "Legs", "Arms"],
  PHUL: ["Power Upper", "Power Lower", "Hypertrophy Upper", "Hypertrophy Lower"],
  PHAT: ["Power Upper", "Power Lower", "Hypertrophy Back/Shoulders", "Hypertrophy Legs", "Hypertrophy Chest/Arms"],
  "Hybrid PPL + Upper/Lower": ["Push", "Pull", "Legs", "Upper", "Lower"],
  "Strength-Focused": ["Full Body", "Upper", "Lower"],
  "Powerlifting Hybrid": ["Chest/Triceps", "Back/Biceps", "Legs", "Chest/Biceps Isolation", "Arms/Forearms/Grip"],
};
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const EXERCISE_RULES = ["required_exercises", "preferred_exercises", "excluded_exercises"] as const;
export type ExerciseRule = typeof EXERCISE_RULES[number];
export type SessionPreferences = Record<string, BuilderAnswers>;
export interface ProgramIssue { stage: number; message: string }

function canonicalSplit(value: unknown): unknown {
  const raw = String(value ?? "").toLowerCase().replace(/\s/g, "");
  const aliases: Record<string, string> = {
    ppl: "Push / Pull / Legs", arnold: "Arnold Split", "bodypart": "Body-Part Split",
    "bodypartsplit": "Body-Part Split", "brosplit": "Body-Part Split",
    "ppl+upper/lower": "Hybrid PPL + Upper/Lower", "ppl/upper/lower": "Hybrid PPL + Upper/Lower",
    "strength+conditioning": "Strength-Focused", "powerliftinghybridsplit": "Powerlifting Hybrid",
  };
  return Object.keys(PROGRAM_SPLITS).find(k => k.toLowerCase().replace(/\s/g, "") === raw)
    ?? aliases[raw] ?? (raw === "customsplit" ? "Custom Split" : raw === "geoffreydecide" ? "Geoffrey Decide" : value);
}

export function programDefaults(prefill: BuilderAnswers, duration = 45, sequencing: "calendar" | "completion" = "completion"): BuilderAnswers {
  const answers: BuilderAnswers = {
    goal: "Get Stronger", training_for: "Nothing Specific", lifting_days: 3,
    running_days: 0, hiit: 0, cardio: "Minimal", split: "Full Body", duration,
    intensity: "Moderate", variety: "Balanced", sequencing_policy: sequencing, deload_every: 0,
    ...prefill,
  };
  for (const [key, value] of Object.entries(answers)) {
    if (["lifting_days", "running_days", "hiit", "duration", "split", "goal"].includes(key) && value === "Other" && answers[key + "_other"] !== undefined) answers[key] = answers[key + "_other"];
  }
  answers.split = canonicalSplit(answers.split);
  if (!Array.isArray(answers.days)) {
    const total = Number(answers.lifting_days) + Number(answers.running_days) + Number(answers.hiit);
    answers.days = total === 3 ? ["Monday", "Wednesday", "Friday"] : WEEKDAYS.slice(0, Math.min(7, total || 3));
  }
  return answers;
}

export function splitCycle(answers: BuilderAnswers): string[] {
  if (!Number(answers.lifting_days)) return [];
  if (answers.split === "Custom Split") {
    const names = String(answers.custom_split_days ?? "").split("|");
    return Array.from({ length: Math.min(7, Math.max(0, Number(answers.lifting_days) || 0)) }, (_, i) => names[i] ?? "");
  }
  const requested = String((answers.split === "Other" ? answers.split_other : answers.split) || "");
  if (requested === "Geoffrey Decide") {
    return Number(answers.lifting_days) <= 2 ? PROGRAM_SPLITS["Full Body"] : Number(answers.lifting_days) === 3 ? PROGRAM_SPLITS["Push / Pull / Legs"] : PROGRAM_SPLITS["Upper / Lower"];
  }
  return PROGRAM_SPLITS[requested] ?? [];
}

/** Preferences follow split positions, even when a cycle spans more than one week. */
export function preferenceSlots(answers: BuilderAnswers): string[] {
  return splitCycle(answers);
}

export function moveCustomSession(answers: BuilderAnswers, from: number, to: number): BuilderAnswers {
  const cycle = splitCycle(answers);
  if (answers.split !== "Custom Split" || to < 0 || to >= cycle.length) return answers;
  [cycle[from], cycle[to]] = [cycle[to], cycle[from]];
  const prefs = { ...(answers.session_preferences as SessionPreferences ?? {}) };
  const previous = prefs[String(from + 1)];
  const next = prefs[String(to + 1)];
  delete prefs[String(from + 1)]; delete prefs[String(to + 1)];
  if (next) prefs[String(from + 1)] = next;
  if (previous) prefs[String(to + 1)] = previous;
  return { ...answers, custom_split_days: cycle.map(s => s.trim()).join(" | "), session_preferences: prefs };
}

export function programIssues(answers: BuilderAnswers): ProgramIssue[] {
  const issues: ProgramIssue[] = [];
  const add = (stage: number, message: string) => issues.push({ stage, message });
  const counts = [answers.lifting_days, answers.running_days, answers.hiit].map(Number);
  if (counts.some(n => !Number.isInteger(n) || n < 0 || n > 7)) add(0, "Choose between 0 and 7 sessions for each activity.");
  const total = counts.reduce((a, b) => a + b, 0);
  const days = Array.isArray(answers.days) ? WEEKDAYS.filter(d => (answers.days as unknown[]).includes(d)) : [];
  if (!total || total > days.length) add(0, "Choose at least as many available days as your total weekly sessions. This builder plans one session per day.");
  if (!String(answers.goal ?? "").trim() || answers.goal === "Other") add(0, "Choose your main training goal.");
  if (answers.training_for === "Race/Event" && (!answers.race_distance || (answers.race_distance === "Other" && !answers.race_distance_other) || !answers.event_date)) add(0, "Add the race distance and event date.");
  if (["Sport", "Fitness Test"].includes(String(answers.training_for)) && !String(answers.sport ?? "").trim()) add(0, "Name your sport or fitness test.");
  if (counts[0] && !splitCycle(answers).length) add(1, "Choose a supported split or create a custom split.");
  if (answers.split === "Custom Split" && counts[0]) {
    const allowed = new Set("full_body upper lower push pull legs chest back shoulders arms biceps triceps forearms grip power hypertrophy isolation focused strength core".split(" "));
    splitCycle(answers).forEach((name, i) => {
      const words = name.toLowerCase().replaceAll("full body", "full_body").replace(/[/&-]/g, " ").split(/\s+/).filter(w => w && !["and", "day", "training"].includes(w));
      if (!words.length || name.length > 60 || words.some(w => !allowed.has(w))) add(1, `Session ${i + 1} needs a supported muscle focus, such as Chest/Triceps or Power Upper.`);
    });
  }
  const durationOK = (v: unknown) => Number.isInteger(Number(v)) && Number(v) >= 5 && Number(v) <= 180;
  if (!durationOK(answers.duration)) add(2, "Choose a lifting-session duration between 5 and 180 minutes.");
  const prefs = (answers.session_preferences ?? {}) as SessionPreferences;
  const validateRules = (rules: BuilderAnswers, label: string, stage: number) => {
    const required = Array.isArray(rules.required_exercises) ? rules.required_exercises : [];
    const excluded = Array.isArray(rules.excluded_exercises) ? rules.excluded_exercises : [];
    if (required.some(id => excluded.includes(id))) add(stage, `${label}: an exercise cannot be both required and excluded.`);
  };
  validateRules(answers, "Default rules", 2);
  preferenceSlots(answers).forEach((_, i) => {
    const p = prefs[String(i + 1)] ?? {};
    if (p.duration !== undefined && !durationOK(p.duration)) add(1, `Session ${i + 1} needs a duration between 5 and 180 minutes.`);
    validateRules({ ...answers, ...p }, `Session ${i + 1}`, 1);
  });
  return issues;
}

export function prepareProgramAnswers(answers: BuilderAnswers): BuilderAnswers {
  const issues = programIssues(answers);
  if (issues.length) throw new Error(issues[0].message);
  const result = { ...answers };
  delete result.split_other;
  const slots = preferenceSlots(answers);
  const prefs = (answers.session_preferences ?? {}) as SessionPreferences;
  const count = slots.length ? Math.max(slots.length, Number(answers.lifting_days)) : 0;
  result.session_preferences = Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const p = prefs[String(i % slots.length + 1)];
    return p ? [String(i + 1), p] : null;
  }).filter((p): p is [string, BuilderAnswers] => p !== null));
  if (answers.split === "Custom Split") result.custom_split_days = splitCycle(answers).map(s => s.trim()).join(" | ");
  else delete result.custom_split_days;
  result.days = WEEKDAYS.filter(d => (answers.days as unknown[]).includes(d));
  for (const key of ["lifting_days", "running_days", "hiit", "duration", "deload_every"]) result[key] = Number(answers[key]);
  return result;
}
