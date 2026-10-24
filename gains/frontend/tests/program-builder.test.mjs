import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/program-builder.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const { programDefaults, programIssues, preferenceSlots, prepareProgramAnswers, moveCustomSession } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("new programs default to completion sequencing while explicit calendar choices survive", () => {
  assert.equal(prepareProgramAnswers(programDefaults({})).sequencing_policy,"completion");
  assert.equal(prepareProgramAnswers(programDefaults({sequencing_policy:"calendar"})).sequencing_policy,"calendar");
});

test("the athlete's saved preference supplies the builder default but does not replace explicit choices", () => {
  assert.equal(programDefaults({},45,"calendar").sequencing_policy,"calendar");
  assert.equal(programDefaults({sequencing_policy:"completion"},45,"calendar").sequencing_policy,"completion");
});

test("program defaults are valid without losing Geoffrey's explicit authored constraints", () => {
  assert.deepEqual(programIssues(programDefaults({})), []);
  const a = programDefaults({lifting_days:"Other",lifting_days_other:"5",split:"Custom Split",custom_split_days:"Chest/Triceps | Back/Biceps | Legs | Chest/Biceps Isolation | Arms/Forearms/Grip",session_preferences:{"4":{preferred_exercises:["floor_press"]}}});
  const payload = prepareProgramAnswers(a);
  assert.equal(payload.lifting_days,5);
  assert.equal(payload.days.length,5);
  assert.equal(preferenceSlots(payload).length,5);
  assert.deepEqual(payload.session_preferences["4"].preferred_exercises,["floor_press"]);
});
test("session count and day constraints are caught before generation", () => {
  assert.ok(programIssues(programDefaults({lifting_days:5,running_days:2,hiit:1,days:["Monday"]})).some(i => i.stage===0));
  assert.ok(programIssues(programDefaults({lifting_days:0,running_days:0,hiit:0})).length);
  assert.deepEqual(programIssues(programDefaults({lifting_days:0,running_days:3})), []);
});
test("a four-position split keeps position four when only three sessions fit each week", () => {
  const a = programDefaults({lifting_days:3,split:"PHUL",session_preferences:{"4":{duration:30,required_exercises:["floor_press"]}}});
  assert.equal(preferenceSlots(a).length,4);
  assert.deepEqual(prepareProgramAnswers(a).session_preferences["4"],a.session_preferences["4"]);
});
test("repeated split positions get the same rules in initial and later weeks", () => {
  const a = programDefaults({lifting_days:3,split:"Full Body",session_preferences:{"1":{excluded_exercises:["barbell_squat"]},"7":{duration:10}}});
  const prefs = prepareProgramAnswers(a).session_preferences;
  assert.deepEqual(Object.keys(prefs),["1","2","3"]);
  assert.deepEqual(prefs["1"],prefs["3"]);
});
test("reordering a custom session carries its exercise and duration rules", () => {
  const a = programDefaults({lifting_days:2,split:"Custom Split",custom_split_days:"Chest/Triceps | Legs",session_preferences:{"1":{duration:20,required_exercises:["floor_press"]}}});
  const moved = moveCustomSession(a,0,1);
  assert.equal(moved.custom_split_days,"Legs | Chest/Triceps");
  assert.deepEqual(moved.session_preferences["2"],a.session_preferences["1"]);
  assert.equal(moved.session_preferences["1"],undefined);
  assert.equal(a.custom_split_days,"Chest/Triceps | Legs");
});
test("effective session rules detect conflicts with inherited defaults and allow explicit overrides", () => {
  const a = programDefaults({required_exercises:["floor_press"],session_preferences:{"1":{excluded_exercises:["floor_press"]}}});
  assert.ok(programIssues(a).some(i => i.stage===1));
  a.session_preferences["1"].required_exercises=[];
  assert.deepEqual(programIssues(a),[]);
});
test("invalid focus, unsupported split, and out-of-range durations do not reach generation", () => {
  for(const patch of [{duration:181},{split:"Magic Split"},{split:"Custom Split",custom_split_days:"Chest | Anything | Legs"},{session_preferences:{"1":{duration:4}}}]) {
    assert.throws(() => prepareProgramAnswers(programDefaults(patch)));
  }
});
test("supported Geoffrey aliases remain editable and stale split_other does not override a new choice", () => {
  const a = programDefaults({split:"upper/lower",split_other:"Unsupported old input"});
  assert.equal(a.split,"Upper / Lower");
  assert.equal(prepareProgramAnswers(a).split_other,undefined);
});
test("typing spaces in custom focus preserves the draft and trims only for transport", () => {
  const a = programDefaults({lifting_days:1,split:"Custom Split",custom_split_days:"Power "});
  assert.equal(preferenceSlots(a)[0],"Power ");
  a.custom_split_days += "Upper";
  assert.equal(prepareProgramAnswers(a).custom_split_days,"Power Upper");
});
