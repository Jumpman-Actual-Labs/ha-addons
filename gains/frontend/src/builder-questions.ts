import type { BuildType, BuilderAnswers } from "./training-types";
export interface BuilderOption {
  label: string;
  value: string | number;
}
export interface BuilderQuestion {
  id: string;
  title: string;
  options: BuilderOption[];
  multiple?: boolean;
  input?: "date" | "text";
  showWhen?: (answers: BuilderAnswers) => boolean;
  optionsFor?: (answers: BuilderAnswers) => BuilderOption[];
}
const options = (labels: (string | number)[]): BuilderOption[] =>
  labels.map((value) => ({ value, label: String(value) }));
const q = (
  id: string,
  title: string,
  choices: (string | number)[],
  extra: Partial<BuilderQuestion> = {},
): BuilderQuestion => ({ id, title, options: options(choices), ...extra });
const duration = q("duration", "How many minutes do you have?", [
  30,
  45,
  60,
  90,
  "Geoffrey Decide",
  "Other",
]);
const goal = q("goal", "What is your main goal?", [
  "Get Stronger",
  "Build Muscle",
  "Improve Endurance",
  "Hybrid / Athletic Performance",
  "General Fitness",
  "Other",
]);
const target = q("training_for", "What are you training for?", [
  "Nothing Specific",
  "Race/Event",
  "Sport",
  "Fitness Test",
  "Other",
]);
const event: BuilderQuestion[] = [
  q(
    "race_distance",
    "What race distance?",
    ["5K", "10K", "Half Marathon", "Marathon", "Other"],
    { showWhen: (a) => a.training_for === "Race/Event" },
  ),
  q("event_date", "When is the event?", [], {
    input: "date",
    showWhen: (a) => a.training_for === "Race/Event",
  }),
  q(
    "goal_time",
    "Do you have a goal time?",
    ["Finish comfortably", "Geoffrey Decide", "Other"],
    { showWhen: (a) => a.training_for === "Race/Event" },
  ),
  q("sport", "Which sport or fitness test?", [], {
    input: "text",
    showWhen: (a) =>
      a.training_for === "Sport" || a.training_for === "Fitness Test",
  }),
];
const intensity = q("intensity", "How hard should this session feel?", [
  "Light",
  "Moderate",
  "Hard",
  "Max Effort",
  "Geoffrey Decide",
]);
const variety = q("variety", "How much exercise variety do you prefer?", [
  "Consistency", "Balanced", "Variety",
]);
const workout = [
  q("focus", "What do you want to train?", [
    "Full Body",
    "Upper Body",
    "Lower Body",
    "Specific Muscle Group",
    "Geoffrey Decide",
    "Other",
  ]),
  q(
    "muscle",
    "Choose your focus",
    ["Chest", "Back", "Legs", "Shoulders", "Arms", "Core", "Other"],
    { showWhen: (a) => a.focus === "Specific Muscle Group" },
  ),
  goal,
  duration,
  intensity,
  variety,
];
const run = [
  q("run_type", "What kind of run?", [
    "Easy",
    "Speed",
    "Endurance",
    "Recovery",
    "Geoffrey Decide",
    "Other",
  ]),
  goal,
  q("training_for", "Is this for a race?", ["Nothing Specific", "Race/Event"]),
  ...event,
  q("duration", "How many minutes?", [
    20,
    30,
    45,
    60,
    "Geoffrey Decide",
    "Other",
  ]),
  intensity,
];
const program = [
  goal,
  target,
  ...event,
  q("lifting_days", "Lifting days per week?", [2, 3, 4, 5, "Other"]),
  q("running_days", "Running days per week?", [0, 1, 2, 3, 4, "Other"]),
  q("cardio", "How much additional cardio?", [
    "Minimal",
    "Moderate",
    "High",
    "Geoffrey Decide",
  ]),
  q("hiit", "HIIT days per week?", [0, 1, 2, "Geoffrey Decide"]),
  q("split", "Which lifting split?", [], {
    optionsFor: (a) =>
      options(
        Number(a.lifting_days) <= 2
          ? ["Full Body", "Upper / Lower", "Geoffrey Decide", "Custom Split", "Other"]
          : Number(a.lifting_days) === 3
            ? [
                "Full Body",
                "Upper / Lower",
                "Push / Pull / Legs",
                "Geoffrey Decide",
                "Custom Split",
                "Other",
              ]
            : [
                "Upper / Lower",
                "Push / Pull / Legs",
                "Upper / Lower / Push / Pull",
                "Strength-Focused",
                "Arnold Split",
                "Body-Part Split",
                "PHUL",
                "PHAT",
                "Hybrid PPL + Upper/Lower",
                "Powerlifting Hybrid",
                "Geoffrey Decide",
                "Custom Split",
                "Other",
              ],
      ),
  }),
  q("custom_split_days", "Name each workout day in order (separate with |)", [], {
    input: "text",
    showWhen: (a) => a.split === "Custom Split",
  }),
  duration,
  intensity,
  variety,
  q("sequencing_policy", "How should your split advance?", [], {
    options: [
      { label: "Follow scheduled days", value: "calendar" },
      { label: "After completed or skipped sessions", value: "completion" },
    ],
  }),
  q("deload_every", "Schedule lighter weeks?", [], {
    options: [
      { label: "No scheduled lighter weeks", value: 0 },
      { label: "Every fourth week", value: 4 },
      { label: "Every sixth week", value: 6 },
      { label: "Every eighth week", value: 8 },
    ],
  }),
  q(
    "days",
    "Which days can you train?",
    [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
    { multiple: true },
  ),
];
export function builderQuestions(
  type: BuildType,
  answers: BuilderAnswers,
): BuilderQuestion[] {
  answers = { ...answers };
  if (answers.lifting_days === "Other" && answers.lifting_days_other) {
    answers.lifting_days = Number(answers.lifting_days_other);
  }
  return { workout, run, program }[type]
    .filter((question) => !question.showWhen || question.showWhen(answers))
    .map((question) => ({
      ...question,
      options: question.optionsFor?.(answers) ?? question.options,
    }));
}
export function effectiveAnswers(
  type: BuildType,
  answers: BuilderAnswers,
): BuilderAnswers {
  const keys = new Set(
    builderQuestions(type, answers).flatMap((q) => [q.id, q.id + "_other"]),
  );
  const result = Object.fromEntries(
    Object.entries(answers).filter(
      ([key]) =>
        keys.has(key) ||
        ["existing", "instructions", "start_date", "seed", "required_exercises", "preferred_exercises", "excluded_exercises", "session_preferences"].includes(key),
    ),
  );
  for (const [key, value] of Object.entries(result)) {
    if (value === "Other" && result[key + "_other"] !== undefined) {
      result[key] = result[key + "_other"];
    }
  }
  for (const key of ["duration", "lifting_days", "running_days", "hiit"]) {
    const value = result[key];
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      result[key] = Number(value);
    }
  }
  return result;
}
