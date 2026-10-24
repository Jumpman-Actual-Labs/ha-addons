import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../src/builder-questions.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { builderQuestions, effectiveAnswers } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("general fitness does not ask race or sport questions", () => {
  const ids = builderQuestions("program", {
    training_for: "Nothing Specific",
  }).map((q) => q.id);
  assert.ok(!ids.includes("race_distance"));
  assert.ok(!ids.includes("event_date"));
  assert.ok(!ids.includes("sport"));
});

test("Geoffrey race prefill preserves known answers and exposes missing event details", () => {
  const answers = {
    training_for: "Race/Event",
    race_distance: "10K",
    lifting_days: 4,
  };
  const questions = builderQuestions("program", answers);
  assert.ok(questions.some((q) => q.id === "event_date"));
  assert.deepEqual(effectiveAnswers("program", answers), answers);
  const missing = questions.filter((q) => !(q.id in answers));
  assert.ok(!missing.some((q) => q.id === "race_distance"));
});

test("two lifting days never recommends push pull legs", () => {
  const split = builderQuestions("program", { lifting_days: 2 }).find(
    (q) => q.id === "split",
  );
  assert.ok(!split.options.some((o) => o.value === "Push / Pull / Legs"));
  assert.ok(split.options.some((o) => o.value === "Full Body"));
});

test("changing branches drops stale sport and muscle answers from generation", () => {
  assert.deepEqual(
    effectiveAnswers("program", {
      training_for: "Nothing Specific",
      race_distance: "10K",
      sport: "Football",
    }),
    { training_for: "Nothing Specific" },
  );
  assert.deepEqual(
    effectiveAnswers("workout", {
      focus: "Full Body",
      muscle: "Chest",
      muscle_other: "Something else",
    }),
    { focus: "Full Body" },
  );
});

test("programs are ongoing and never ask for a duration in weeks", () => {
  const ids = builderQuestions("program", {}).map((q) => q.id);
  assert.ok(!ids.includes("weeks"));
  assert.deepEqual(
    effectiveAnswers("program", {
      weeks: "Other",
      weeks_other: "Unlimited",
      lifting_days: 4,
    }),
    { lifting_days: 4 },
  );
});

test("Other numeric answers reach the backend as numbers", () => {
  const answers = effectiveAnswers("program", {lifting_days: "Other", lifting_days_other: "5", duration: "Other", duration_other: "15"});
  assert.equal(answers.lifting_days, 5);
  assert.equal(answers.duration, 15);
});

test("Other day count controls split options and planning preferences survive", () => {
  const questions = builderQuestions("program", {lifting_days: "Other", lifting_days_other: "2"});
  assert.ok(!questions.find(q => q.id === "split").options.some(o => o.value === "Push / Pull / Legs"));
  const answers = effectiveAnswers("workout", {focus: "Chest", variety: "Variety", seed: 7, required_exercises: ["floor_press"]});
  assert.equal(answers.variety, "Variety");
  assert.equal(answers.seed, 7);
  assert.deepEqual(answers.required_exercises, ["floor_press"]);
});

test("program authoring controls survive the shared request boundary", () => {
  const answers = {intensity:"Hard",variety:"Balanced",sequencing_policy:"completion",deload_every:4,session_preferences:{"4":{duration:30,required_exercises:["floor_press"]}},instructions:"Prefer morning sessions",start_date:"2026-11-02"};
  assert.deepEqual(effectiveAnswers("program",answers),answers);
});
