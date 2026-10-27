import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/joint-session.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext}}).outputText;
const { parseJointSession, canLogJointSet, exerciseTurn, isJointParticipant, isSharedController } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const sets = (...done) => done.map(completed => ({actual_reps: null, actual_weight: null, completed, recorded_by_profile_id: null}));
const exercises = (...perExercise) => perExercise.map(done => ({exercise_id: "push_up", effort: null, sets: sets(...done)}));
const session = {
  id: "session", status: "active", turn: {profile_id: "a", exercise_index: 0, set_index: 0},
  participants: [
    {profile_id: "a", display_name: "A", workout_id: "wa", status: "active", exercises: exercises([false, false], [false])},
    {profile_id: "b", display_name: "B", workout_id: "wb", status: "active", exercises: exercises([false, false], [false])},
  ],
};

test("both account views enable only the next athlete's set on each exercise", () => {
  const parsed = parseJointSession(session);
  assert.equal(canLogJointSet(parsed, "a", 0, 0, false), true);
  assert.equal(canLogJointSet(parsed, "b", 0, 0, false), false);
  assert.equal(canLogJointSet(parsed, "a", 0, 1, false), false);
  const next = {...parsed, participants: [
    {...parsed.participants[0], exercises: exercises([true, false], [false])},
    parsed.participants[1],
  ]};
  assert.equal(canLogJointSet(next, "a", 0, 1, false), false);
  assert.equal(canLogJointSet(next, "b", 0, 0, false), true);
});

test("athletes can jump to another exercise and alternate there", () => {
  const parsed = parseJointSession(session);
  // Exercise 0 is unfinished, but exercise 1 has its own turn order.
  assert.equal(canLogJointSet(parsed, "a", 1, 0, false), true);
  assert.equal(canLogJointSet(parsed, "b", 1, 0, false), false);
  const jumped = {...parsed, participants: [
    {...parsed.participants[0], exercises: exercises([false, false], [true])},
    parsed.participants[1],
  ]};
  assert.deepEqual(exerciseTurn(jumped, 1), {profile_id: "b", set_index: 0});
  assert.deepEqual(exerciseTurn(jumped, 0), {profile_id: "a", set_index: 0});
  assert.equal(exerciseTurn(jumped, 5), null);
});

test("completed corrections and solo sessions remain available", () => {
  assert.equal(canLogJointSet(session, "b", 0, 0, true), true);
  assert.equal(canLogJointSet(undefined, "a", 0, 0, false), true);
  const left = {...session, participants: session.participants.map(p=>({...p, status: p.profile_id==="a" ? "left" : "active"}))};
  assert.equal(isJointParticipant(left,"a"),false);
  assert.equal(canLogJointSet(left,"a",1,2,false),true);
  assert.equal(canLogJointSet({...session,status:"ended"},"b",1,2,false),true);
  const allDone = {...session, participants: session.participants.map(p => ({...p, exercises: exercises([true, true], [true])}))};
  assert.equal(canLogJointSet(allDone,"a",0,1,false),false);
});

test("legacy and malformed sessions cannot create a turn restriction", () => {
  for (const raw of [null, {}, {id:"bad",participants:[null]}, {id:"bad",participants:[{profile_id:1,exercises:[]}]}, {id:"bad",participants:[{profile_id:"a"}]}]) {
    assert.equal(parseJointSession(raw),undefined);
  }
});

test("only the initiating account gets shared-device controls, including after its own finish", () => {
  const shared = {...session, device_mode:"same_device", controller_profile_id:"a"};
  assert.equal(isSharedController(shared,"a"),true);
  assert.equal(isSharedController(shared,"b"),false);
  assert.equal(isSharedController(session,"a"),false);
  assert.equal(isSharedController({...shared,status:"ended"},"a"),false);
  assert.equal(isSharedController({...shared,participants:shared.participants.map(p=>({...p,status:p.profile_id==="a"?"completed":"active"}))},"a"),true);
  assert.equal(isSharedController({...shared,participants:shared.participants.map(p=>({...p,status:p.profile_id==="a"?"left":"active"}))},"a"),false);
});
