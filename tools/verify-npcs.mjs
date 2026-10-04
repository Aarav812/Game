/**
 * verify-npcs.mjs
 * ---------------
 * Headless check of the ambient NPC systems (pedestrians + traffic).
 * No browser and no GLTF: procedural InstancedMesh geometry only.
 *
 * Run: node tools/verify-npcs.mjs
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import { RoadNetwork, GRID } from '../src/network.js';
import { AmbientNPCs, PedestrianSystem, TrafficSystem, NPC_TUNING, laneOffsetFor, underElevated } from '../src/npcs.js';
import { isOnTarmac, GRADE_LINES } from '../src/city.js';

const scene = new THREE.Scene();
const physics = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
const ground = new CANNON.Material('ground');

const network = new RoadNetwork(scene, physics, ground);
network.build();

// Fake city: a couple of shop fronts for idle-facing + building list shape.
const city = { buildings: [{ type: 'Shop', x: 60, z: 62, height: 10 }] };

let failures = 0;
function expectTrue(label, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label.padEnd(52)} ${detail}`);
}

const DT = 1 / 60;
function actorsAt(x, z, extra = {}) {
  return {
    focusX: x, focusZ: z, focusYaw: 0,
    carX: 9999, carZ: 9999, carY: 0, carSpeed: 0, carVelX: 0, carVelZ: 0,
    carYaw: 0, driving: false, honk: false, onFoot: true,
    playerX: x, playerZ: z,
    ...extra,
  };
}

// ---------------------------------------------------------- pool & spawn
console.log('\nPedestrian pool (20-30 around the player, despawn > 150)');
const npcs = new AmbientNPCs(scene, physics, { network, city, seed: 7 });
npcs.init();
for (let i = 0; i < 300; i++) npcs.update(DT, actorsAt(60, 60));
const st = npcs.stats();
expectTrue('ped pool populated to target', st.peds >= NPC_TUNING.PED_TARGET && st.peds <= NPC_TUNING.PED_MAX, `${st.peds} peds`);
expectTrue('traffic pool populated', st.traffic >= 10 && st.traffic <= 15, `${st.traffic} cars`);

// All peds near the focus?
{
  let far = 0;
  for (const p of npcs.peds.peds) {
    if (!p.active) continue;
    if (Math.hypot(p.x - 60, p.z - 60) > NPC_TUNING.PED_DESPAWN + 1) far++;
  }
  expectTrue('no ped beyond despawn radius', far === 0, `${far} far`);
}

// Sidewalk adherence: outside tarmac (crossing peds excepted), never under deck.
{
  let onRoad = 0;
  let under = 0;
  for (const p of npcs.peds.peds) {
    if (!p.active || p.state === 'crossing') continue;
    if (isOnTarmac(p.x, p.z, 0.3)) onRoad++;
    if (underElevated(p.x, p.z, 0.5)) under++;
  }
  expectTrue('walkers stay off the tarmac', onRoad === 0, `${onRoad} on tarmac`);
  expectTrue('walkers stay out from under flyovers', under === 0, `${under} under deck`);
}

// Wander/idle mix emerges over time.
{
  for (let i = 0; i < 1200; i++) npcs.update(DT, actorsAt(60, 60));
  const s2 = npcs.stats();
  expectTrue('idle behaviour occurs', (s2.pedStates.idle || 0) > 0, JSON.stringify(s2.pedStates));
  expectTrue('wander behaviour dominates', (s2.pedStates.wander || 0) > 10, JSON.stringify(s2.pedStates));
}

// ---------------------------------------------------------------- panic
console.log('\nPanic / flee behaviour');
{
  const ped = npcs.peds.peds.find((p) => p.active && p.state === 'wander');
  // Park a fast car right next to the pedestrian.
  const ax = { ...actorsAt(ped.x + 4, ped.z), carX: ped.x + 4, carZ: ped.z, carSpeed: 14, carVelX: -14, carVelZ: 0, driving: true };
  let panicked = false;
  for (let i = 0; i < 30; i++) {
    npcs.peds.update(DT, ax);
    if (ped.state === 'panic') { panicked = true; break; }
  }
  expectTrue('fast car triggers panic sprint', panicked, `state=${ped.state}`);
  const px0 = ped.x;
  const pz0 = ped.z;
  for (let i = 0; i < 60; i++) npcs.peds.update(DT, actorsAt(ped.x, ped.z));
  expectTrue('panicking ped sprints away', Math.hypot(ped.x - px0, ped.z - pz0) > 1.5,
    `${Math.hypot(ped.x - px0, ped.z - pz0).toFixed(2)} m`);
}

// Honk scares nearby walkers.
{
  const ped = npcs.peds.peds.find((p) => p.active && (p.state === 'wander' || p.state === 'idle'));
  const ax = { ...actorsAt(ped.x, ped.z), carX: ped.x + 6, carZ: ped.z, carSpeed: 0, carVelX: 0, carVelZ: 0, driving: true, honk: true };
  npcs.peds.update(DT, ax);
  expectTrue('honk triggers panic', ped.state === 'panic', `state=${ped.state}`);
  for (let i = 0; i < 30; i++) npcs.peds.update(DT, actorsAt(0, 0));
}

// ------------------------------------------------------------- hit react
console.log('\nHit reaction + alert');
{
  const alerts = [];
  const ped = npcs.peds.peds.find((p) => p.active && p.state === 'wander');
  const ax = {
    ...actorsAt(ped.x, ped.z), carX: ped.x + 1, carZ: ped.z, carSpeed: 10,
    carVelX: -10, carVelZ: 0, driving: true, onAlert: (a) => alerts.push(a),
  };
  for (let i = 0; i < 10 && ped.state !== 'down'; i++) npcs.peds.update(DT, ax);
  expectTrue('car strike knocks pedestrian down', ped.state === 'down', `state=${ped.state}`);
  expectTrue('hit queues a player alert', alerts.some((a) => a.type === 'ped-hit'), `${alerts.length} alerts`);
  const facadeAlerts = [];
  npcs._alerts.push({ type: 'ped-hit', x: 0, z: 0 });
  facadeAlerts.push(...npcs.pollAlerts());
  expectTrue('facade drains alert queue', facadeAlerts.length === 1 && npcs.pollAlerts().length === 0, '');
}

// --------------------------------------------------------------- traffic
console.log('\nTraffic: lanes, speeds, braking');
{
  // Lane discipline: street cars sit at quarter-width offsets off centre-lines.
  let offLane = 0;
  let checked = 0;
  for (const c of npcs.traffic.cars) {
    if (!c.active || c.highway || !c.axis) continue;
    const want = laneOffsetFor(c.axis, c.dir, c.line);
    const got = c.axis === 'x' ? c.z - c.line : c.x - c.line;
    // (sign may flip after U-turns; compare magnitudes)
    if (Math.abs(Math.abs(got) - Math.abs(want)) > 0.6) offLane++;
    checked++;
  }
  expectTrue('street cars straddle lane centerlines', offLane === 0, `${checked} checked, ${offLane} off-lane`);

  // Speed limits.
  let badSpeed = 0;
  for (let i = 0; i < 600; i++) npcs.update(DT, actorsAt(60, 60));
  for (const c of npcs.traffic.cars) {
    if (!c.active) continue;
    const kmh = c.speed * 3.6;
    const lo = c.highway ? 0 : 0;
    const hi = c.highway ? 82 : 42;
    if (kmh < lo - 1 || kmh > hi + 1) badSpeed++;
  }
  expectTrue('cruise speeds within limits', badSpeed === 0, `${badSpeed} violations`);

  // Braking: put a car on a known straight lane, drop an obstacle 6 m
  // ahead, expect a full stop; then clear it and expect resume.
  const car = npcs.traffic.cars.find((c) => !c.highway && c.active);
  car.pts = [{ x: 0, y: 0.05, z: 500 }, { x: 200, y: 0.05, z: 500 }];
  car.axis = 'x';
  car.line = 500;
  car.dir = 1;
  car.lane = laneOffsetFor('x', 1, 500);
  car.mode = 'replan';
  car.seg = 0;
  car.segT = 0.5;
  car.speed = car.cruise;
  car.yaw = Math.PI / 2;
  npcs.traffic._placeOnRoute(car);
  const dirX = Math.sin(car.yaw);
  const dirZ = Math.cos(car.yaw);
  // 14 m ahead: at the edge of the speed-scaled raycast with room to stop.
  const ox = car.x + dirX * 14;
  const oz = car.z + dirZ * 14;
  const ctx = {
    ...actorsAt(car.x, car.z),
    carX: ox, carZ: oz, carY: car.y, carSpeed: 0, carVelX: 0, carVelZ: 0, driving: true,
    onFoot: false, playerX: 9999, playerZ: 9999,
  };
  // Silence other obstacles: move focus far so peds recycle away is slow; instead
  // directly exercise one update burst and watch this car's speed.
  const v0 = car.speed;
  for (let i = 0; i < 240; i++) npcs.traffic.update(DT, ctx, []);
  expectTrue('obstacle ahead brakes the car to a stop', car.speed < 0.3, `${v0.toFixed(1)} -> ${car.speed.toFixed(2)} m/s`);
  expectTrue('car flagged blocked while obstructed', car.blocked && car.blockDist < NPC_TUNING.SCAN_LENGTH, `dist=${car.blockDist.toFixed(2)}`);
  // Path clears -> resumes.
  const ctx2 = { ...actorsAt(car.x, car.z), driving: false, onFoot: false, playerX: 9999, playerZ: 9999 };
  for (let i = 0; i < 240; i++) npcs.traffic.update(DT, ctx2, []);
  expectTrue('car resumes when path clears', car.speed > car.cruise * 0.7, `${car.speed.toFixed(1)} m/s vs cruise ${car.cruise.toFixed(1)}`);
}

// ------------------------------------------------------------ performance
console.log('\nPerformance shape');
{
  let instanced = 0;
  scene.traverse((o) => { if (o.isInstancedMesh) instanced++; });
  expectTrue('NPCs render via InstancedMesh', instanced >= 2, `${instanced} instanced meshes`);
  expectTrue('traffic uses kinematic boxes, not vehicles', npcs.traffic.cars.every((c) => c.body.type === CANNON.Body.KINEMATIC), '');
  const bodies = physics.bodies.length;
  expectTrue('NPC physics stays bounded', bodies < 700, `${bodies} bodies`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
