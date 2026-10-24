import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/recovery.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext}}).outputText;
const { parseMuscleRecovery, recoveryPercent } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const stamp = "2026-10-08T12:00:00Z";
const raw = { model_version: 1, calculated_at: stamp, half_life_hours: 24,
  muscles: {chest: {recovery_percent: 60}, triceps: {recovery_percent: 84}} };
test("readiness and elapsed recovery come from API", () => {
  const state = parseMuscleRecovery(raw);
  assert.equal(recoveryPercent(state, "chest", Date.parse(stamp)), 60);
  assert.equal(recoveryPercent(state, "chest", Date.parse(stamp) + 86400000), 80);
  assert.equal(recoveryPercent(state, "chest", Date.parse(stamp) - 86400000), 60);
  assert.equal(recoveryPercent(state, "chest", Date.parse(stamp) + 14*86400000), 100);
});
test("legacy and invalid payloads remain unavailable", () => {
  for (const invalid of [null, {}, {model_version: 2}, {...raw, calculated_at: "bad"}, {...raw, half_life_hours: 0}]) assert.equal(parseMuscleRecovery(invalid), undefined);
  const state = parseMuscleRecovery({...raw, muscles: {chest: null, triceps: {recovery_percent: 101}, lats: {recovery_percent: "80"}}});
  assert.equal(recoveryPercent(state, "chest"), undefined);
  assert.equal(recoveryPercent(state, "triceps"), undefined);
  assert.equal(recoveryPercent(undefined, "chest"), undefined);
});
