import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/warmup.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
const {needsWarmup, warmupSets, snapDown} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const muscles = {
  deadlift: {primary: ["erector_spinae", "glutes", "hamstrings"], secondary: ["forearms"]},
  bench: {primary: ["chest"], secondary: ["triceps", "front_delts"]},
  fly: {primary: ["chest"], secondary: []},
  pushdown: {primary: ["triceps"], secondary: []},
  rdl: {primary: ["hamstrings", "glutes"], secondary: ["erector_spinae"]},
};
const musclesFor = (id) => muscles[id];

test("the first exercise for a muscle needs a warm-up, later ones don't", () => {
  const workout = ["deadlift", "bench", "fly", "pushdown", "rdl"];
  assert.equal(needsWarmup(workout, 0, musclesFor), true);
  assert.equal(needsWarmup(workout, 1, musclesFor), true);
  // Chest was just worked by bench press.
  assert.equal(needsWarmup(workout, 2, musclesFor), false);
  // Triceps were worked secondarily by bench press.
  assert.equal(needsWarmup(workout, 3, musclesFor), false);
  // Hamstrings and glutes were worked by deadlifts.
  assert.equal(needsWarmup(workout, 4, musclesFor), false);
  assert.equal(needsWarmup(["unknown"], 0, musclesFor), false);
});

test("a heavy deadlift ramps from the empty bar", () => {
  const sets = warmupSets(200, {start: 45, increment: 5});
  assert.deepEqual(sets, [
    {weight: 45, reps: 10}, {weight: 80, reps: 5}, {weight: 120, reps: 3}, {weight: 160, reps: 2},
  ]);
});

test("warm-ups snap down to loads the gym can make", () => {
  const ladder = [45, 50, 55, 65, 75, 95, 115, 135, 155, 185, 225];
  assert.deepEqual(warmupSets(200, {start: 45, ladder, increment: 5}).map((s) => s.weight), [45, 75, 115, 155]);
  assert.equal(snapDown(100, ladder, 5), 95);
  assert.equal(snapDown(10, ladder, 5), 45);
  assert.equal(snapDown(37, [], 2.5), 35);
});

test("light working weights get a short ramp or none", () => {
  // Close to the bar: the empty bar and one step, or nothing within 90%.
  assert.deepEqual(warmupSets(65, {start: 45, increment: 5}), [{weight: 45, reps: 10}, {weight: 50, reps: 2}]);
  assert.deepEqual(warmupSets(45, {start: 45, increment: 5}), []);
  assert.deepEqual(warmupSets(0, {start: 45, increment: 5}), []);
  assert.deepEqual(warmupSets(null, {increment: 5}), []);
});

test("dumbbell and machine work ramps by percentage", () => {
  assert.deepEqual(warmupSets(60, {increment: 5}), [{weight: 30, reps: 8}, {weight: 45, reps: 4}]);
  assert.deepEqual(warmupSets(60, {ladder: [10, 20, 25, 35, 40, 50, 60], increment: 5}),
    [{weight: 25, reps: 8}, {weight: 40, reps: 4}]);
  assert.deepEqual(warmupSets(5, {increment: 5}), []);
});
