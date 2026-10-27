import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const jointSource = await readFile(new URL("../src/joint-session.ts", import.meta.url), "utf8");
const jointCode = ts.transpileModule(jointSource, {compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const joint = await import(`data:text/javascript;base64,${Buffer.from(jointCode).toString("base64")}`);
const source = await readFile(new URL("../src/views/workouts-view.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("view.ts", source, ts.ScriptTarget.Latest, true);
const view = tree.statements.find(ts.isClassDeclaration);
const names = ["_sharedController", "_sessionWorkout", "_workoutUnits", "_saveSharedSet", "_logSet", "_renderExerciseDetailPage", "_finishTimedSetTimer", "_logExerciseEffort"];
const methods = view.members.filter(m=>names.includes(m.name?.getText(tree))).map(m=>m.getText(tree)).join("\n");
const code = ts.transpileModule(`class View {${methods}}`, {compilerOptions:{target:ts.ScriptTarget.ES2021}}).outputText;
const calls = [];
const html = (strings,...values)=>strings.reduce((out,s,i)=>out+s+(typeof values[i]==="function"?"":values[i]??""),"");
const dependencies = {
  ...joint, html,
  gainsApi: {logSet:async(...args)=>calls.push({solo:args}), logExerciseEffort:async(...args)=>calls.push({soloEffort:args})},
  trainingService: async(_hass, service, payload)=>calls.push({service,...payload}),
  nextSetSuggestion: (exercise,index)=>({reps:exercise.sets[index].plannedReps,weight:exercise.sets[index].plannedWeight}),
  isTimedExercise:()=>true, exerciseEquipment:()=>"bodyweight", exerciseName:id=>id,
  categoryColor:()=>"red", exerciseCategory:()=>"strength", muscleGroupsForExercise:()=>"Core",
};
const View = new Function(...Object.keys(dependencies),code+";return View")(...Object.values(dependencies));

function fixture() {
  calls.length = 0;
  const session = {id:"joint",status:"active",device_mode:"same_device",controller_profile_id:"a",
    turn:{profile_id:"a",exercise_index:0,set_index:0}, participants:["a","b"].map(id=>({
      profile_id:id,display_name:id.toUpperCase(),workout_id:`w${id}`,status:"active",units:id==="a"?"imperial":"metric",
      exercises:[{exercise_id:"plank",effort:null,sets:[0,1].map(()=>({planned_reps:id==="a"?30:20,planned_weight:id==="a"?10:5,actual_reps:null,actual_weight:null,completed:false,recorded_by_profile_id:null}))}],
    }))};
  const base = {id:"wa",profileId:"a",status:"active",jointSession:session,revision:7,exercises:[]};
  const workout = joint.participantWorkout(base,"a");
  const screen = new View();
  Object.assign(screen,{gainsState:{workouts:[workout],profile:{profileId:"a",units:"imperial",personalRecords:{},restTimerSeconds:60}},
    hass:{},_draftLogs:{},_savingSet:null,_error:"",_effortPromptExerciseIndex:null,
    _persistSession(){},_startRestTimer(){},dispatchEvent(){},_closeTimedSetTimer(){this._timedSetTimer=null;},
    _renderVideoModal:()=>"",_renderTimedSetTimerDialog:()=>"",_renderLoadingPickerDialog:()=>"",_renderRestTimerBanner:()=>"",
  });
  return {screen,workout,session};
}

test("same-device screen renders ordinary set rows interleaved and solo keeps its layout",()=>{
  const {screen,workout}=fixture();
  const rows=[];
  screen._renderSetRow=(w,_ei,si,set,active)=>{rows.push([w.profileId,si,active,set.plannedReps]);return "normal-row";};
  const rendered=screen._renderExerciseDetailPage(workout,workout.exercises[0],0);
  assert.deepEqual(rows,[["a",0,true,30],["b",0,false,20],["a",1,false,30],["b",1,false,20]]);
  assert.match(rendered,/log-set-button/);
  assert.match(rendered,/Log set 1 - A/);
  assert.match(rendered,/timer-launch-button/);
  assert.doesNotMatch(rendered,/shared-device-controls/);
  rows.length=0;
  workout.jointSession=undefined;
  screen._renderExerciseDetailPage(workout,workout.exercises[0],0);
  assert.deepEqual(rows.map(r=>r.slice(0,3)),[["a",0,true],["a",1,false]]);
});

test("normal log button and timed completion keep drafts, athlete and units separate",async()=>{
  const {screen,workout,session}=fixture();
  screen._draftLogs["wa:0:0"]={reps:31,weight:12};
  await screen._logSet(workout,0,0,workout.exercises[0].sets[0]);
  assert.equal(calls[0].fields.participant_profile_id,"a");
  assert.equal(calls[0].fields.reps,31);
  session.participants[0].exercises[0].sets[0].completed=true;
  session.turn={profile_id:"b",exercise_index:0,set_index:0};
  screen._draftLogs["wb:0:0"]={weight:6};
  screen._timedSetTimer={workoutId:"wb",exerciseIndex:0,setIndex:0,seconds:22};
  await screen._finishTimedSetTimer();
  assert.deepEqual(calls[1].fields,{workout_id:"wa",expected_revision:7,participant_profile_id:"b",exercise_index:0,set_index:0,reps:22,weight:6});
  assert.equal(screen._workoutUnits(screen._sessionWorkout("wb")),"metric");
  assert.equal(screen._timedSetTimer,null);
  assert.equal(Object.keys(screen._draftLogs).length,0);
});

test("effort after turn handoff targets the finished athlete without logging another set",async()=>{
  const {screen,workout,session}=fixture();
  session.turn={profile_id:"b",exercise_index:0,set_index:1};
  const a=joint.participantWorkout(workout,"a");
  screen._effortPromptWorkoutId="wa";
  await screen._logExerciseEffort(a,0,"easy");
  assert.equal(calls[0].action,"log_effort");
  assert.equal(calls[0].fields.participant_profile_id,"a");
  assert.equal(calls[0].fields.effort,"easy");
  assert.equal(calls[0].fields.reps,undefined);
  assert.equal(screen._effortPromptWorkoutId,null);
});

test("coach, recipient and ended sessions cannot obtain controller actions",()=>{
  const {screen,workout,session}=fixture();
  screen.viewContext={mode:"coach"};
  assert.equal(screen._sharedController(workout),undefined);
  screen.viewContext=undefined;
  session.status="ended";
  assert.equal(screen._sharedController(workout),undefined);
  session.status="active";
  screen.gainsState.workouts=[joint.participantWorkout(workout,"b")];
  assert.equal(screen._sharedController(screen.gainsState.workouts[0]),undefined);
});
