import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const toUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const compile = async (file) => ts.transpileModule(
  await readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
  {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}},
).outputText;
const policyUrl = toUrl(await compile("inventory-policy.ts"));
const loading = await import(toUrl((await compile("plate-loading.ts")).replace('"./inventory-policy"', `"${policyUrl}"`)));
const {planLoad, loadTotal, addPlate, removePlate, remainingPlates, plateLoadedStation, isSingleSleeve, groupPlates} = loading;

const plates = [{weight: 45, count: 1}, {weight: 25, count: 1}, {weight: 10, count: 3}, {weight: 2.5, count: 1}];

test("a barbell total plans mirrored plates and adds back up", () => {
  const plan = planLoad(135, 45, plates, 2);
  assert.deepEqual(plan.points, [[45], [45]]);
  assert.equal(loadTotal(45, plan.points), 135);
});

test("a landmine loads one sleeve and still counts the bar", () => {
  assert.equal(isSingleSleeve("landmine_press"), true);
  assert.equal(isSingleSleeve("meadows_row"), true);
  assert.equal(isSingleSleeve("barbell_row"), false);
  // 70 lb on a 45 lb bar is 25 lb on the one sleeve, not 12.5 per side.
  const plan = planLoad(70, 45, plates, 1);
  assert.deepEqual(plan.points, [[25]]);
  assert.equal(plan.exact, true);
  // A single sleeve can use both plates of a pair.
  assert.deepEqual(planLoad(135, 45, plates, 1).points, [[45, 45]]);
});

test("tapping plates builds the weight; a barbell adds to both sleeves", () => {
  let points = [[], []];
  points = addPlate("barbell", plates, points, 45, 0);
  assert.deepEqual(points, [[45], [45]]);
  points = addPlate("barbell", plates, points, 10, 0);
  assert.equal(loadTotal(45, points), 155);
  // Only one pair of 45s: another pair isn't available.
  assert.equal(addPlate("barbell", plates, points, 45, 0), null);
  points = removePlate("barbell", points, 45, 0);
  assert.deepEqual(points, [[10], [10]]);
});

test("pulleys can be loaded unevenly, base weight included", () => {
  let points = [[], []];
  points = addPlate("pulley", plates, points, 10, "all");
  points = addPlate("pulley", plates, points, 2.5, 1);
  assert.deepEqual(points, [[10], [10, 2.5]]);
  assert.equal(loadTotal(5, points), 27.5);
  assert.equal(remainingPlates(plates, points).get(2.5), 1);
  points = removePlate("pulley", points, 10, 0);
  assert.deepEqual(points, [[], [10, 2.5]]);
  assert.deepEqual(groupPlates([10, 45, 10]), [{plate: 45, count: 1}, {plate: 10, count: 2}]);
});

test("only plate-loaded cable stations get a plate loader", () => {
  const equipment = {crossover_cable: [null], cable_tower: [null], lat_pulldown_cable: [null]};
  const config = {
    crossover_cable: {loadType: "plate_loaded", baseWeight: 10, loadingPoints: 2},
    cable_tower: {loadType: "weight_stack", stackIncrement: 10, stackMax: 200},
    lat_pulldown_cable: {loadType: "plate_loaded", baseWeight: 0, loadingPoints: 1},
  };
  assert.deepEqual(plateLoadedStation("cable_fly", null, equipment, config),
    {equipmentId: "crossover_cable", baseWeight: 10, loadingPoints: 2, assumed: false});
  assert.deepEqual(plateLoadedStation("lat_pulldown", null, equipment, config).equipmentId, "crossover_cable");
  assert.equal(plateLoadedStation("cable_fly", "cable_tower", equipment, config), null);
  assert.equal(plateLoadedStation("cable_fly", null, {}, config), null);
  // Blank loading points / base load in the gym editor: still a loader,
  // assuming one pin and no base.
  assert.deepEqual(plateLoadedStation("close_grip_lat_pulldown", null, {lat_pulldown_cable: [null]},
    {lat_pulldown_cable: {loadType: "plate_loaded", baseWeight: null, loadingPoints: null}}),
    {equipmentId: "lat_pulldown_cable", baseWeight: 0, loadingPoints: 1, assumed: true});
  assert.equal(plateLoadedStation("cable_fly", null, equipment,
    {crossover_cable: {loadType: "plate_loaded", baseWeight: 15, loadingPoints: null}}).assumed, true);
});
