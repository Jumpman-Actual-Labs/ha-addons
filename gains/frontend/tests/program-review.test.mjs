import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/program-review.ts",import.meta.url),"utf8");
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const { programNeedsExercises } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const program = {name:"Automatic",goal:"Strength",start_date:"2026-10-15",weeks:[{week_number:1,focus:"Base",sessions:[{id:"s1",type:"workout",day:0,name:"Upper",prescription:{name:"Upper",exercises:[{exercise_id:"floor_press",sets:[{reps:8,weight:20}]}]}}]}]};
test("a generated program is accepted as filled without asking for exercise choices or mutating it",()=>{
  const before=JSON.stringify(program);
  assert.equal(programNeedsExercises(program),false);
  assert.equal(JSON.stringify(program),before);
});
test("empty generated lifting sessions require regeneration instead of manual filling",()=>{
  for(const exercises of [[],[{exercise_id:"floor_press",sets:[]}]]) {
    const p=structuredClone(program);
    p.weeks[0].sessions[0].prescription.exercises=exercises;
    assert.equal(programNeedsExercises(p),true);
  }
});
test("run and recovery sessions do not require lifting exercises",()=>{
  const p=structuredClone(program);
  p.weeks[0].sessions=[{id:"run",type:"run",day:0,prescription:{name:"Easy",run_type:"easy",segments:[]}},{id:"rest",type:"recovery",day:1,prescription:{notes:"Rest"}}];
  assert.equal(programNeedsExercises(p),false);
});
