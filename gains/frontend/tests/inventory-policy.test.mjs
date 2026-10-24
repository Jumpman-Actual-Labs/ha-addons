import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/inventory-policy.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const { buildPlateLoadout, nextSetSuggestion, replacementLibrary, parseInventoryPolicy } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const policy = { feasible: true, reasons: [], loads: [20, 25, 30] };
const exercise = { exerciseId: "dumbbell_bench_press", sets: [
  { plannedReps: 10, actualReps: 8, actualWeight: 30, completed: true },
  { plannedReps: 10, actualReps: 8, actualWeight: 25, completed: true },
  { plannedReps: 10, plannedWeight: 22.5, completed: false },
] };
test("30 then 25 lb missed targets select the next owned dumbbell, never 22.5", () => {
  assert.equal(nextSetSuggestion(exercise, 2, policy).weight, 20);
  assert.equal(exercise.sets[2].plannedWeight, 22.5);
  assert.equal(exercise.sets[1].actualWeight, 25);
});
test("prefill snaps plans and unknown inventory never invents a load", () => {
  assert.equal(nextSetSuggestion({...exercise, sets:[{plannedWeight:22.5, plannedReps:8}]},0,policy).weight,20);
  assert.equal(nextSetSuggestion(exercise,2).weight,null);
  assert.equal(nextSetSuggestion(exercise,2,{...policy,loads:[25,30]}).weight,25);
});
test("selected bar ladder wins over another bar, explicit manual plans survive", () => {
  const e = {...exercise, selectedBarEquipmentId:"short_bar", selectedBarWeight:20};
  assert.equal(nextSetSuggestion(e,2,{...policy,bars:{"short_bar:20":[20,40]}}).weight,20);
  assert.equal(nextSetSuggestion({...exercise,sets:[{plannedReps:8,plannedWeight:22.5,manualWeight:true}]},0,policy).weight,22.5);
});
const library = [
  {id:"original",name:"Bench",category:"push",equipment:"barbell",muscles:{primary:["chest"],secondary:[]}},
  {id:"floor",name:"Floor Press",category:"push",equipment:"dumbbell",muscles:{primary:["chest"],secondary:[]}},
  {id:"row",name:"Cable Row",category:"pull",equipment:"cable",muscles:{primary:["back"],secondary:[]}},
  {id:"fly",name:"Cable Fly",category:"push",equipment:"cable",muscles:{primary:["chest"],secondary:[]}},
];
const availability = {floor:policy,row:policy,fly:{feasible:false,reasons:["Missing two cable handles"],loads:[]}};
const filters = {search:"",muscle:"",equipment:"",movement:"",mode:"recommended",showUnavailable:false};
test("recommendations prioritize shared muscles and hide unavailable options by default", () => {
  assert.deepEqual(replacementLibrary(library,library[0],availability,filters).map(x=>x.exercise.id),["floor"]);
});
test("entire library permits other movements, combined filters and unavailable explanations", () => {
  const all = {...filters, mode:"all"};
  assert.equal(replacementLibrary(library,library[0],availability,{...all,search:"row",movement:"pull",muscle:"back",equipment:"cable"})[0].exercise.id,"row");
  const unavailable = replacementLibrary(library,library[0],availability,{...all,showUnavailable:true,search:"fly"})[0];
  assert.deepEqual(unavailable.availability.reasons,["Missing two cable handles"]);
  assert.equal(replacementLibrary(library,library[0],{},all).length,0);
});
test("policy parsing rejects non-numeric ladders and does not infer feasibility", () => {
  assert.deepEqual(parseInventoryPolicy(null),{});
  assert.equal(parseInventoryPolicy({x:{loads:[25,"30",null,Infinity]}}).x.feasible,false);
  assert.deepEqual(parseInventoryPolicy({x:{loads:[25,"30",null,Infinity]}}).x.loads,[25]);
});


test("plate diagrams consume saved pair quantities and solve non-greedy combinations", () => {
  assert.equal(buildPlateLoadout(40,20,[{weight:10,count:0}]).exact,false);
  assert.equal(buildPlateLoadout(40,20,[{weight:10,count:1}]).exact,true);
  const result = buildPlateLoadout(36,20,[{weight:6,count:2},{weight:4,count:4}]);
  assert.equal(result.exact,true);
  assert.deepEqual(result.counts,[{plate:4,count:2}]);
  assert.equal(buildPlateLoadout(40,20,[]).exact,false);
});


test("owned equipment with unknown loads stays selectable without suggesting weights", () => {
  const p = parseInventoryPolicy({floor:{feasible:false,selectable:true,reasons:["Load inventory unverified"],loads:[]}});
  const result = replacementLibrary(library,library[0],p,filters);
  assert.equal(result[0].exercise.id,"floor");
  assert.equal(result[0].availability.selectable,true);
  assert.equal(nextSetSuggestion(exercise,2,p.floor).weight,null);
});


test("150 lb squat uses 45 + 5 + 2.5 per side from the reported gym inventory", () => {
  const inventory = [[2.5,1],[5,2],[10,3],[15,1],[25,1],[35,1],[45,1]]
    .map(([weight,count]) => ({weight,count}));
  const result = buildPlateLoadout(150,45,inventory);
  assert.equal(result.perSide,52.5);
  assert.equal(result.exact,true);
  assert.equal(result.remainder,0);
  assert.deepEqual(result.counts,[{plate:45,count:1},{plate:5,count:1},{plate:2.5,count:1}]);
  assert.equal(buildPlateLoadout(85,45,[{weight:10,count:1}]).exact,false);
});
