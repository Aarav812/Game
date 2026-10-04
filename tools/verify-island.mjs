/**
 * verify-island.mjs
 * -----------------
 * Headless check of the 2500-unit island and the procedural road network. No
 * browser and no GLTF: it builds the real `Island` and `RoadNetwork` against a
 * real CANNON world and raycasts the PHYSICS surface.
 *
 * Run: node tools/verify-island.mjs
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import { Island, ISLAND, terrainHeight, isLand } from '../src/island.js';
import { RoadNetwork, GRID } from '../src/network.js';
import { GROUP, MASK } from '../src/collision.js';

const scene = new THREE.Scene();
const physics = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
const ground = new CANNON.Material('ground');

const network = new RoadNetwork(scene, physics, ground);
network.build();

const island = new Island(scene, physics, ground);
island.build(network.respawn);

// ------------------------------------------------------------------- helpers
const rayFrom = new CANNON.Vec3();
const rayTo = new CANNON.Vec3();
const rayResult = new CANNON.RaycastResult();

function surfaceAt(x, z, fromY = 80) {
  rayFrom.set(x, fromY, z);
  rayTo.set(x, -60, z);
  rayResult.reset();
  physics.raycastClosest(
    rayFrom,
    rayTo,
    { collisionFilterGroup: GROUP.WORLD, collisionFilterMask: MASK.WORLD, skipBackfaces: true },
    rayResult
  );
  return rayResult.hasHit ? rayResult.hitPointWorld.y : NaN;
}

let failures = 0;
function expect(label, actual, expected, tol) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(48)} ${(Number.isFinite(actual) ? actual.toFixed(3) : 'MISS').padStart(9)}  (want ${expected.toFixed(3)} ±${tol})`);
}
function expectNotHit(label, actual) {
  const ok = !Number.isFinite(actual);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(48)} ${(ok ? 'no hit' : actual.toFixed(3)).padStart(9)}  (want no hit)`);
}
function expectTrue(label, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label.padEnd(48)} ${detail}`);
}

// ------------------------------------------------------------------ scale
console.log('\nMap scale (minimum 2500 x 2500)');
{
  const span = ISLAND.PLATEAU * 2;
  expectTrue('land span is at least 2500 units', span >= 2500, `${span} x ${span} (plateau ${ISLAND.PLATEAU})`);
  expectTrue('ocean extends far beyond the coast', ISLAND.COAST - ISLAND.PLATEAU >= 80, `beach run ${ISLAND.COAST - ISLAND.PLATEAU}`);
}

// ----------------------------------------------------------------- terrain
console.log('\nTerrain: land, coastline, carved water');
expect('downtown ground is flat', surfaceAt(140, 250), 0, 0.06);
expect('far SE corner is flat land', surfaceAt(900, -900), 0, 0.06);
expect('far NW corner is flat land', surfaceAt(-950, 800), 0, 0.06);
expect('beach slopes toward the sea', surfaceAt(1320, 0), -5.0, 1.0);
expectNotHit('outside the island is open ocean', surfaceAt(1700, 1700));
expectNotHit('the northern bay is open water', surfaceAt(ISLAND.BAY.x, ISLAND.BAY.z));
expectNotHit('the western inlet is open water', surfaceAt((ISLAND.INLET.from + ISLAND.INLET.to) / 2, ISLAND.INLET.z - 30));
expect('land next to the inlet is solid', surfaceAt(-750, ISLAND.INLET.z - 120), 0, 0.06);

// ------------------------------------------------------------- arterials
console.log('\nArterial network (6-lane elevated, y = 9)');
const A = GRID.ARTERIAL;
expect('ring is elevated on the south edge', surfaceAt(0, -A.HALF), A.Y, 0.15);
expect('ring is elevated on the north edge', surfaceAt(0, A.HALF), A.Y, 0.15);
expect('ring is elevated on the west edge', surfaceAt(-A.HALF, 0), A.Y, 0.15);
expect('ring is elevated on the east edge', surfaceAt(A.HALF, 0), A.Y, 0.15);
{
  const c = A.HALF - A.CORNER;
  const a = Math.PI / 4;
  expect('ring corner arc is elevated', surfaceAt(c + Math.cos(a) * A.CORNER, c + Math.sin(a) * A.CORNER), A.Y, 0.2);
}
expect('NS spine is elevated mid-island', surfaceAt(GRID.NS.X, 100), A.Y, 0.15);
expect('EW spine is elevated over the inlet', surfaceAt((ISLAND.INLET.from + ISLAND.INLET.to) / 2, GRID.EW.Z), A.Y, 0.2);
{
  // Spine ramps must descend monotonically to grade at both ends.
  let worst = 0, reversals = 0, prev = null;
  for (let x = GRID.EW.ELEV[0] - GRID.EW.RAMP; x <= GRID.EW.ELEV[0] + 4; x += 4) {
    const y = surfaceAt(x, GRID.EW.Z);
    if (!Number.isFinite(y)) continue;
    if (prev !== null) {
      worst = Math.max(worst, Math.abs(y - prev));
      if (y < prev - 0.05) reversals++;
    }
    prev = y;
  }
  expectTrue('spine ramp has no vertical steps', worst < 0.9, `max step ${worst.toFixed(2)} m`);
  expectTrue('spine ramp climbs monotonically', reversals === 0, `${reversals} reversals`);
}

console.log('\nCrash barriers on every elevated edge');
{
  const W = A.WIDTH;
  // The west straight runs along Z, so its barriers are offset in X.
  const west = surfaceAt(-A.HALF - (A.WIDTH / 2 - 0.3), 0, 40);
  const east = surfaceAt(-A.HALF + (A.WIDTH / 2 - 0.3), 0, 40);
  expectTrue('west barrier stands above the deck', west > A.Y + 0.6 && west < A.Y + 1.3, `top ${west.toFixed(2)}`);
  expectTrue('east barrier stands above the deck', east > A.Y + 0.6 && east < A.Y + 1.3, `top ${east.toFixed(2)}`);
  expect('deck centre is still open tarmac', surfaceAt(-A.HALF, 0, 40), A.Y, 0.15);
  // Barrier over the inlet on the EW spine.
  const inletX = (ISLAND.INLET.from + ISLAND.INLET.to) / 2;
  const b = surfaceAt(inletX, GRID.EW.Z - (A.WIDTH / 2 - 0.3), 40);
  expectTrue('bridge barrier over water is solid', b > A.Y + 0.6 && b < A.Y + 1.3, `top ${b.toFixed(2)}`);
}

// ---------------------------------------------------------------- budget
console.log('\nPhysics budget and grade-level roads');
{
  const st = { bodies: physics.bodies.length };
  expectTrue('static bodies stay in the low hundreds', st.bodies < 700, `${st.bodies} bodies`);
  // The grade roads must NOT create bodies: flip the count either side.
  const before = physics.bodies.length;
  const net2 = new RoadNetwork(new THREE.Scene(), physics, ground);
  net2.build();
  const after = physics.bodies.length;
  const perNetwork = after - before;
  expectTrue('one network costs a bounded body count', perNetwork < 260, `${perNetwork} bodies per network`);
}

// --------------------------------------------------------------- instancing
console.log('\nInstancing');
{
  const inst = [];
  scene.traverse((o) => { if (o.isInstancedMesh) inst.push(o); });
  expectTrue('road furniture is instanced', inst.length === 2, `${inst.length} instanced meshes`);
  console.log(`  info  piers=${network.pierInstances}  lamps=${network.lampInstances}  colliders=${network.colliders.length}`);
  expectTrue('there are many piers', network.pierInstances > 150, `${network.pierInstances}`);
  expectTrue('there are many lamps', network.lampInstances > 80, `${network.lampInstances}`);
}

console.log('\nRespawn coverage');
{
  console.log(`  info  respawn points=${network.respawn.length}`);
  expectTrue('respawn points cover the map', network.respawn.length > 40, `${network.respawn.length}`);
  const r = island.nearestRespawn(900, -900);
  expectTrue('nearest respawn is on land', isLand(r.x, r.z, 2), `(${r.x}, ${r.z})`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
