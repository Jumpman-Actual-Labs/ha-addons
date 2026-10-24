import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

test("workout text stays ASCII in source and produces correct Unicode display strings", async () => {
  const bytes = await readFile(new URL("../src/views/workouts-view.ts", import.meta.url));
  const source = new TextDecoder("utf-8", {fatal:true}).decode(bytes);
  assert.doesNotMatch(source, /[^\x00-\x7f]/, "Use Unicode escapes for workout UI text to avoid Windows code-page corruption");
  assert.doesNotMatch(source, /\\u00(?:c2|c3|e2)|\\ufffd/i);
  const file = ts.createSourceFile("workouts-view.ts",source,ts.ScriptTarget.Latest,true);
  const text = [];
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text.push(node.text);
    ts.forEachChild(node,visit);
  }
  visit(file);
  const displayed = text.join("\n");
  assert.match(displayed, /\u00b7/);
  assert.match(displayed, /\u2192/);
  assert.doesNotMatch(displayed, /[\u00c2\u00c3\u00e2\ufffd]/);
});
