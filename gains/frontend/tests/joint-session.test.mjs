import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/joint-session.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext}}).outputText;
const { parseJointSession, canLogJointSet, isJointParticipant, isSharedController } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const session = {
  id: "session", status: "active", turn: {profile_id: "a", exercise_index: 0, set_index: 0},
  participants: [
    {profile_id: "a", display_name: "A", workout_id: "wa", status: "active", exercises: []},
    {profile_id: "b", display_name: "B", workout_id: "wb", status: "active", exercises: []},
  ],
};

test("both account views enable only the next athlete's set", () => {
  const parsed = parseJointSession(session);
  assert.equal(canLogJointSet(parsed, "a", 0, 0, false), true);
  assert.equal(canLogJointSet(parsed, "b", 0, 0, false), false);
  assert.equal(canLogJointSet(parsed, "a", 0, 1, false), false);
  assert.equal(canLogJointSet(parsed, "a", 1, 0, false), false);
  const next = {...parsed, turn: {profile_id: "b", exercise_index: 0, set_index: 0}};
  assert.equal(canLogJointSet(next, "a", 0, 1, false), false);
  assert.equal(canLogJointSet(next, "b", 0, 0, false), true);
});

test("completed corrections and solo sessions remain available", () => {
  assert.equal(canLogJointSet(session, "b", 0, 0, true), true);
  assert.equal(canLogJointSet(undefined, "a", 0, 0, false), true);
  const left = {...session, participants: session.participants.map(p=>({...p, status: p.profile_id==="a" ? "left" : "active"}))};
  assert.equal(isJointParticipant(left,"a"),false);
  assert.equal(canLogJointSet(left,"a",1,2,false),true);
  assert.equal(canLogJointSet({...session,status:"ended"},"b",1,2,false),true);
  assert.equal(canLogJointSet({...session,turn:null},"a",0,0,false),false);
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
