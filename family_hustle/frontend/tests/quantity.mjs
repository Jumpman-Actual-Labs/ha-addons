import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/utils/quantity.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { parseAmount, parseNumber, formatAmount, scaleLine } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

// Reading amounts.
assert.equal(parseNumber("1 1/2"), 1.5);
assert.equal(parseNumber("1½"), 1.5);
assert.equal(parseNumber("3/4"), 0.75);
assert.equal(parseNumber(".5"), 0.5);
assert.equal(parseNumber("lots"), null);
assert.equal(parseAmount("2 lbs Ground Chuck").value, 2);
assert.equal(parseAmount("1/2 Cup Crackers or Panko").value, 0.5);
assert.deepEqual(
  (({ value, to }) => ({ value, to }))(parseAmount("2-3 cloves garlic")),
  { value: 2, to: 3 }
);
assert.equal(parseAmount("Salt to taste"), null);
assert.equal(parseAmount("0 calories"), null);

// Writing them the way a cook would.
assert.equal(formatAmount(1.5), "1 1/2");
assert.equal(formatAmount(1 / 3), "1/3");
assert.equal(formatAmount(0.66), "2/3");
assert.equal(formatAmount(2.98), "3");
assert.equal(formatAmount(0.05), "1/8");
assert.equal(formatAmount(37.4), "37");

// Scaling a whole line keeps the words.
assert.equal(scaleLine("2 lbs Ground Chuck", 1.5), "3 lbs Ground Chuck");
assert.equal(scaleLine("1/2 Cup Crackers or Panko", 1.5), "3/4 Cup Crackers or Panko");
assert.equal(scaleLine("1 Egg", 1.5), "1 1/2 Egg");
assert.equal(scaleLine("2-3 cloves garlic", 2), "4-6 cloves garlic");
assert.equal(scaleLine("1½ cups flour", 2), "3 cups flour");
assert.equal(scaleLine("Salt to taste", 3), "Salt to taste");
assert.equal(scaleLine("2 Tablespoon Milk", 1), "2 Tablespoon Milk");

console.log("PASS: ingredient amounts parse, format and scale");
