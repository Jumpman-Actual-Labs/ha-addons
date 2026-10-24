import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/inventory-units.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { defaultInventoryWeight } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("a catalog bar has the same physical mass in both unit systems", () => {
  assert.equal(defaultInventoryWeight(45, "imperial"), 45);
  assert.ok(Math.abs(defaultInventoryWeight(45, "metric") - 20.4117) < 0.0001);
  assert.equal(defaultInventoryWeight(null, "metric"), null);
});
