import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP, MASK } from './collision.js';
import { GRID } from './network.js';
import { isLand, mulberry32 } from './island.js';
import {
  GRADE_LINES,
  halfWidthForLine,
  sidewalkOffsetFor,
  isOnTarmac,
  distToArterialRing,
} from './city.js';

/**
 * npcs.js
 * -------
 * Ambient life for the open world: sidewalk pedestrians + road traffic.
 *
 *   PedestrianSystem  20-30 low-poly walkers confined to the sidewalk network.
 *                     States: wander (1.5 m/s) / idle (3-5 s at corners and
 *                     shop fronts) / panic (sprint from fast cars and honks) /
 *                     down (kinematic tumble when struck by the player car).
 *   TrafficSystem     10-15 ambient cars on lane centerlines (city streets at
 *                     30-40 km/h, elevated highways at 70-80 km/h) with an 8 m
 *                     forward raycast (analytic segment test) for braking.
 *
 * Performance:
 *   - ONE InstancedMesh for all pedestrians, TWO for all traffic cars
 *     (painted bodies with per-instance colour + shared dark glass/wheels).
 *   - Traffic cars are single CANNON kinematic boxes (no RaycastVehicle).
 *   - Pedestrians have no physics bodies at all; hits are distance tests.
 *   - No per-frame allocations in the hot loop (module scratch objects).
 */

export const NPC_TUNING = {
  PED_TARGET: 24,
  PED_MAX: 28,
  PED_DESPAWN: 150,
  PED_SPAWN_MIN: 25,
  PED_SPAWN_RANGE: 120,
  PED_WALK: 1.5,
  PED_PANIC: 4.2,
  PED_IDLE_MIN: 3,
  PED_IDLE_MAX: 5,
  PED_PANIC_RADIUS: 9,
  PED_PANIC_SPEED: 9,      // car speed (m/s) that scares pedestrians
  PED_HONK_RADIUS: 15,
  PED_HIT_RADIUS: 2.3,
  PED_HIT_SPEED: 2.5,
  TRAFFIC_COUNT: 12,
  TRAFFIC_MAX: 14,
  SCAN_LENGTH: 8,          // forward raycast length (m)
  SCAN_HALF_WIDTH: 2.4,    // lateral tolerance of the raycast (m)
  STREET_SPEED_MIN: 30 / 3.6,
  STREET_SPEED_MAX: 40 / 3.6,
  HIGHWAY_SPEED_MIN: 70 / 3.6,
  HIGHWAY_SPEED_MAX: 80 / 3.6,
};

// ------------------------------------------------------------------ scratch
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ------------------------------------------------------------ road helpers
/** Lane centre offset for right-hand traffic (fraction of road width). */
export function laneOffsetFor(axis, dirSign, lineCoord) {
  const w = halfWidthForLine(lineCoord) * 2;
  const off = w / 4;
  // Facing +X the right hand is +Z; facing +Z the right hand is -X.
  if (axis === 'x') return dirSign > 0 ? off : -off;
  return dirSign > 0 ? -off : off;
}

/** True when (x,z) is underneath / on the elevated arterial footprint. */
export function underElevated(x, z, pad = 2.5) {
  if (distToArterialRing(x, z) < GRID.ARTERIAL.WIDTH / 2 + pad) return true;
  if (z >= -1160 && z <= 1160 && Math.abs(x - GRID.NS.X) < GRID.ARTERIAL.WIDTH / 2 + pad) return true;
  if (x >= -1160 && x <= 1160 && Math.abs(z - GRID.EW.Z) < GRID.ARTERIAL.WIDTH / 2 + pad) return true;
  return false;
}

const _clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const _smooth = (t) => t * t * (3 - 2 * t);

/** Deck height of a cross-island spine (mirrors network.js spineProfile). */
export function spineProfileY(coord, elevFrom, elevTo, ramp) {
  const up = _smooth(_clamp01((coord - (elevFrom - ramp)) / ramp));
  const down = _smooth(_clamp01((coord - elevTo) / ramp));
  return GRID.ARTERIAL.Y * (up - down);
}

/** Rounded-rectangle centre-line loop of the elevated ring (y = deck). */
export function ringLoopPoints() {
  const H = GRID.ARTERIAL.HALF;
  const C = H - GRID.ARTERIAL.CORNER;
  const R = GRID.ARTERIAL.CORNER;
  const Y = GRID.ARTERIAL.Y;
  const pts = [];
  const push = (x, z) => pts.push({ x, y: Y, z });
  push(-C, -H);
  push(C, -H);
  for (let a = -90; a <= 0; a += 15) {
    const r = (a * Math.PI) / 180;
    push(C + Math.cos(r) * R, -C + Math.sin(r) * R);
  }
  push(H, C);
  for (let a = 0; a <= 90; a += 15) {
    const r = (a * Math.PI) / 180;
    push(C + Math.cos(r) * R, C + Math.sin(r) * R);
  }
  push(-C, H);
  for (let a = 90; a <= 180; a += 15) {
    const r = (a * Math.PI) / 180;
    push(-C + Math.cos(r) * R, C + Math.sin(r) * R);
  }
  push(-H, -C);
  for (let a = 180; a <= 270; a += 15) {
    const r = (a * Math.PI) / 180;
    push(-C + Math.cos(r) * R, -C + Math.sin(r) * R);
  }
  return pts;
}

// ------------------------------------------------------------ geometry
function tinted(geo, hex) {
  const col = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = col.r;
    arr[i * 3 + 1] = col.g;
    arr[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function box(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return tinted(g, hex);
}

/** Low-poly person (~1.78 m): legs + torso + arms + head, vertex colours. */
function buildPedestrianGeometry() {
  const parts = [
    box(0.24, 0.78, 0.22, -0.14, 0.39, 0, 0x2a3242),
    box(0.24, 0.78, 0.22, 0.14, 0.39, 0, 0x2a3242),
    box(0.52, 0.62, 0.3, 0, 1.08, 0, 0xf2f2f2),   // shirt (tinted per instance)
    box(0.14, 0.55, 0.14, -0.35, 1.06, 0, 0xd8d8d8),
    box(0.14, 0.55, 0.14, 0.35, 1.06, 0, 0xd8d8d8),
  ];
  const head = new THREE.SphereGeometry(0.16, 10, 8);
  head.translate(0, 1.62, 0);
  parts.push(tinted(head, 0xe8b98a));
  const merged = mergeGeometries(parts, false);
  merged.computeVertexNormals();
  return merged;
}

/** Low-poly car (~4.3 m long): body + cabin + wheels, vertex colours. */
function buildTrafficCarGeometry() {
  const parts = [
    box(1.9, 0.7, 4.3, 0, 0.65, 0, 0xffffff),      // paint (tinted per instance)
    box(1.65, 0.55, 2.0, 0, 1.25, -0.2, 0x1a2433), // glasshouse
  ];
  for (const sx of [-0.85, 0.85]) {
    for (const sz of [1.35, -1.35]) {
      const w = new THREE.CylinderGeometry(0.34, 0.34, 0.25, 10);
      w.rotateZ(Math.PI / 2);
      w.translate(sx, 0.34, sz);
      parts.push(tinted(w, 0x14161a));
    }
  }
  const merged = mergeGeometries(parts, false);
  merged.computeVertexNormals();
  return merged;
}

const PED_PALETTE = [0xffd9c2, 0xc2e0ff, 0xd6ffc2, 0xffe9a8, 0xe4c2ff, 0xffc2d9, 0xc2fff1, 0xf0f0f0];
const CAR_PALETTE = [0xc0392b, 0x2980b9, 0xf1c40f, 0x7f8c8d, 0x2c3e50, 0x27ae60, 0xe67e22, 0x8e44ad, 0xecf0f1, 0x16a085];

// ============================================================ pedestrians
const PED_WANDER = 'wander';
const PED_IDLE = 'idle';
const PED_PANIC = 'panic';
const PED_DOWN = 'down';
const PED_CROSS = 'crossing';

export class PedestrianSystem {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.city = opts.city || null;
    this.seed = opts.seed ?? 20261004;
    this.rng = mulberry32(this.seed);
    this.peds = [];
    this.mesh = null;
    this._spawnTimer = 0;
  }

  init() {
    const geo = buildPedestrianGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, NPC_TUNING.PED_MAX);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < NPC_TUNING.PED_MAX; i++) {
      _c.setHex(PED_PALETTE[i % PED_PALETTE.length]).offsetHSL(0, 0, (this.rng() - 0.5) * 0.08);
      this.mesh.setColorAt(i, _c);
      this.peds.push({
        active: false, x: 0, z: 0, y: 0, yaw: 0,
        state: PED_WANDER, timer: 0, phase: this.rng() * Math.PI * 2,
        axis: 'x', line: 0, side: 1, dir: 1, speed: NPC_TUNING.PED_WALK,
        panicX: 0, panicZ: 0, fallX: 0, fallZ: 0, downTimer: 0,
        crossFromX: 0, crossFromZ: 0, crossToX: 0, crossToZ: 0, crossT: 0, crossDur: 1,
      });
      _m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.scene.add(this.mesh);
    return this;
  }

  get activeCount() {
    let n = 0;
    for (const p of this.peds) if (p.active) n++;
    return n;
  }

  /** Sidewalk point near (fx,fz): {x,z,axis,line,side}. Null when none found. */
  findSidewalk(fx, fz, spread = NPC_TUNING.PED_SPAWN_RANGE) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const axis = this.rng() < 0.5 ? 'x' : 'z';
      const f = axis === 'x' ? fz : fx;
      const t0 = axis === 'x' ? fx : fz;
      const near = GRADE_LINES.filter((L) => Math.abs(L - f) < spread + 40);
      if (!near.length) continue;
      const line = near[Math.floor(this.rng() * near.length)];
      const side = this.rng() < 0.5 ? -1 : 1;
      const off = sidewalkOffsetFor(line);
      let t = t0 + (this.rng() * 2 - 1) * spread;
      t = this._nudgeOffCrossing(t);
      const x = axis === 'x' ? t : line + side * off;
      const z = axis === 'x' ? line + side * off : t;
      if (!isLand(x, z, 1)) continue;
      if (isOnTarmac(x, z, 0.3)) continue;
      if (underElevated(x, z)) continue;
      return { x, z, axis, line, side };
    }
    return null;
  }

  /** Push a coordinate away from road centre-lines so spawns avoid junctions. */
  _nudgeOffCrossing(t) {
    const n = Math.round(t / 100) * 100;
    if (n < -1000 || n > 1000) return t;
    const half = halfWidthForLine(n);
    const d = t - n;
    if (Math.abs(d) < half + 3) {
      return n + (d >= 0 ? half + 3 + this.rng() * 4 : -(half + 3 + this.rng() * 4));
    }
    return t;
  }

  spawnPed(ped, fx, fz, aheadX = 0, aheadZ = 0) {
    const spot = this.findSidewalk(fx + aheadX, fz + aheadZ);
    if (!spot) return false;
    ped.active = true;
    ped.x = spot.x;
    ped.z = spot.z;
    ped.axis = spot.axis;
    ped.line = spot.line;
    ped.side = spot.side;
    ped.dir = this.rng() < 0.5 ? -1 : 1;
    ped.state = PED_WANDER;
    ped.timer = 0;
    ped.speed = NPC_TUNING.PED_WALK * (0.9 + this.rng() * 0.2);
    ped.yaw = ped.axis === 'x' ? (ped.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (ped.dir > 0 ? 0 : Math.PI);
    return true;
  }

  update(dt, ctx = {}) {
    const fx = ctx.focusX ?? 0;
    const fz = ctx.focusZ ?? 0;
    const fYaw = ctx.focusYaw ?? 0;
    const aheadX = Math.sin(fYaw) * 55;
    const aheadZ = Math.cos(fYaw) * 55;

    // ---- pool maintenance (staggered so spawns pop in ahead of the player)
    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = 0.4;
      for (const ped of this.peds) {
        if (!ped.active) {
          if (this.activeCount < NPC_TUNING.PED_TARGET) this.spawnPed(ped, fx, fz, aheadX, aheadZ);
        } else if (Math.hypot(ped.x - fx, ped.z - fz) > NPC_TUNING.PED_DESPAWN) {
          // Recycle far walkers to a fresh sidewalk ahead of the player.
          if (!this.spawnPed(ped, fx, fz, aheadX, aheadZ)) ped.active = false;
        }
      }
    }

    const carX = ctx.carX ?? Infinity;
    const carZ = ctx.carZ ?? Infinity;
    const carSpeed = ctx.carSpeed ?? 0;
    const carVX = ctx.carVelX ?? 0;
    const carVZ = ctx.carVelZ ?? 0;
    const carY = ctx.carY ?? 0;
    const honk = !!ctx.honk;

    for (const ped of this.peds) {
      if (!ped.active) continue;
      const dx = ped.x - carX;
      const dz = ped.z - carZ;
      const distCar = Math.hypot(dx, dz);
      const carNear = Math.abs(carY) < 2.5;

      switch (ped.state) {
        case PED_WANDER: {
          // Hit by the player's car? -> knockdown + alert.
          if (carNear && distCar < NPC_TUNING.PED_HIT_RADIUS && carSpeed > NPC_TUNING.PED_HIT_SPEED) {
            this._knockDown(ped, carVX, carVZ);
            if (ctx.onAlert) ctx.onAlert({ type: 'ped-hit', x: ped.x, z: ped.z });
            break;
          }
          // Fast car close by, or a honk -> panic sprint away from the car.
          if (
            (carNear && distCar < NPC_TUNING.PED_PANIC_RADIUS && carSpeed > NPC_TUNING.PED_PANIC_SPEED) ||
            (honk && distCar < NPC_TUNING.PED_HONK_RADIUS)
          ) {
            ped.state = PED_PANIC;
            ped.timer = 1.6 + this.rng() * 0.8;
            const l = Math.max(distCar, 0.01);
            ped.panicX = dx / l;
            ped.panicZ = dz / l;
            ped.yaw = Math.atan2(ped.panicX, ped.panicZ);
            break;
          }
          this._stepWander(ped, dt);
          break;
        }
        case PED_IDLE: {
          ped.timer -= dt;
          if (honk && distCar < NPC_TUNING.PED_HONK_RADIUS) {
            ped.state = PED_PANIC;
            ped.timer = 1.6;
            const l = Math.max(distCar, 0.01);
            ped.panicX = dx / l;
            ped.panicZ = dz / l;
            ped.yaw = Math.atan2(ped.panicX, ped.panicZ);
          } else if (ped.timer <= 0) {
            ped.state = PED_WANDER;
          }
          break;
        }
        case PED_CROSS: {
          ped.crossT += dt / ped.crossDur;
          if (ped.crossT >= 1) {
            ped.x = ped.crossToX;
            ped.z = ped.crossToZ;
            ped.side = -ped.side;
            ped.state = PED_WANDER;
          } else {
            const t = ped.crossT;
            ped.x = ped.crossFromX + (ped.crossToX - ped.crossFromX) * t;
            ped.z = ped.crossFromZ + (ped.crossToZ - ped.crossFromZ) * t;
          }
          ped.phase += dt * (NPC_TUNING.PED_WALK * 4.2);
          break;
        }
        case PED_PANIC: {
          ped.timer -= dt;
          ped.x += ped.panicX * NPC_TUNING.PED_PANIC * dt;
          ped.z += ped.panicZ * NPC_TUNING.PED_PANIC * dt;
          ped.phase += dt * (NPC_TUNING.PED_PANIC * 4.2);
          if (!isLand(ped.x, ped.z, 0.5) || isOnTarmac(ped.x, ped.z, 0.2) || underElevated(ped.x, ped.z)) {
            // Panic stays on safe ground: back off and calm down.
            ped.x -= ped.panicX * NPC_TUNING.PED_PANIC * dt;
            ped.z -= ped.panicZ * NPC_TUNING.PED_PANIC * dt;
            ped.timer = Math.min(ped.timer, 0.3);
          }
          if (ped.timer <= 0) {
            // Rejoin the nearest sidewalk instead of wandering into traffic.
            const spot = this.findSidewalk(ped.x, ped.z, 30);
            if (spot) {
              ped.x = spot.x;
              ped.z = spot.z;
              ped.axis = spot.axis;
              ped.line = spot.line;
              ped.side = spot.side;
              ped.dir = this.rng() < 0.5 ? -1 : 1;
            }
            ped.state = PED_WANDER;
          }
          break;
        }
        case PED_DOWN: {
          ped.downTimer -= dt;
          // Kinematic tumble: slide along the fall vector with friction, then rest.
          if (ped.downTimer > 3.2) {
            const k = Math.max(0, ped.downTimer - 3.2);
            ped.x += ped.fallX * k * dt * 3;
            ped.z += ped.fallZ * k * dt * 3;
          }
          if (ped.downTimer <= 0) {
            if (!this.spawnPed(ped, fx, fz, aheadX, aheadZ)) ped.active = false;
          }
          break;
        }
        default:
          ped.state = PED_WANDER;
          break;
      }
    }

    this._separate();
    this._writeMatrices();
  }

  _knockDown(ped, carVX, carVZ) {
    ped.state = PED_DOWN;
    ped.downTimer = 4.0;
    const l = Math.max(Math.hypot(carVX, carVZ), 0.01);
    ped.fallX = carVX / l;
    ped.fallZ = carVZ / l;
  }

  /** Walk along the current sidewalk; turn / idle / cross at corners. */
  _stepWander(ped, dt) {
    const step = ped.speed * dt;
    // Occasionally pause mid-block to window-shop before carrying on.
    if (this.rng() < dt * 0.03) {
      this._startIdle(ped);
      return;
    }
    // Next intersection ahead along the travel direction.
    const t = ped.axis === 'x' ? ped.x : ped.z;
    let nextCross = Infinity;
    for (const L of GRADE_LINES) {
      const d = (L - t) * ped.dir;
      if (d > 0.5 && d < nextCross) nextCross = d;
    }
    if (nextCross < 3.5) {
      const roll = this.rng();
      if (roll < 0.22) {
        this._startIdle(ped);
        return;
      }
      if (roll < 0.42) {
        this._turnCorner(ped);
        return;
      }
      if (roll < 0.52) {
        this._startCrossing(ped);
        return;
      }
    }
    let nx = ped.x;
    let nz = ped.z;
    if (ped.axis === 'x') nx += ped.dir * step;
    else nz += ped.dir * step;
    // Never step onto highways or under the deck: U-turn instead.
    if (underElevated(nx, nz) || !isLand(nx, nz, 0.5)) {
      ped.dir *= -1;
      ped.yaw += Math.PI;
      return;
    }
    ped.x = nx;
    ped.z = nz;
    ped.yaw = ped.axis === 'x' ? (ped.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (ped.dir > 0 ? 0 : Math.PI);
    ped.phase += dt * (ped.speed * 4.2);
    // Ran past the block with no junction (map edge): recycle direction.
    const tt = ped.axis === 'x' ? ped.x : ped.z;
    if (tt < -1080 || tt > 1080) ped.dir *= -1;
  }

  /** Turn from the current sidewalk onto the crossing road's sidewalk. */
  _turnCorner(ped) {
    const t = ped.axis === 'x' ? ped.x : ped.z;
    let best = null;
    let bestD = Infinity;
    for (const L of GRADE_LINES) {
      const d = Math.abs(L - t);
      if (d < bestD) {
        bestD = d;
        best = L;
      }
    }
    if (best === null || bestD > 12) return;
    if (ped.axis === 'x') {
      ped.axis = 'z';
      ped.line = best;
      const off = sidewalkOffsetFor(best);
      ped.side = ped.x >= best ? 1 : -1;
      ped.x = best + ped.side * off;
      ped.dir = this.rng() < 0.5 ? -1 : 1;
    } else {
      ped.axis = 'x';
      ped.line = best;
      const off = sidewalkOffsetFor(best);
      ped.side = ped.z >= best ? 1 : -1;
      ped.z = best + ped.side * off;
      ped.dir = this.rng() < 0.5 ? -1 : 1;
    }
    if (underElevated(ped.x, ped.z) || isOnTarmac(ped.x, ped.z, 0.3)) {
      ped.dir *= -1; // corner pocketed by a flyover: head back out
    }
  }

  /** Cross the current road on a crosswalk to the opposite sidewalk. */
  _startCrossing(ped) {
    const off = sidewalkOffsetFor(ped.line);
    if (ped.axis === 'x') {
      ped.crossFromX = ped.x;
      ped.crossFromZ = ped.z;
      ped.crossToX = ped.x;
      ped.crossToZ = ped.line - ped.side * off;
    } else {
      ped.crossFromX = ped.x;
      ped.crossFromZ = ped.z;
      ped.crossToX = ped.line - ped.side * off;
      ped.crossToZ = ped.z;
    }
    if (underElevated(ped.crossToX, ped.crossToZ)) return; // no crossing under decks
    ped.crossT = 0;
    ped.crossDur = (off * 2) / 1.6 + 0.4;
    ped.state = PED_CROSS;
    ped.yaw = Math.atan2(ped.crossToX - ped.crossFromX, ped.crossToZ - ped.crossFromZ);
  }

  /** Pause at a corner or shop front for 3-5 s, facing the interest point. */
  _startIdle(ped) {
    ped.state = PED_IDLE;
    ped.timer = NPC_TUNING.PED_IDLE_MIN + this.rng() * (NPC_TUNING.PED_IDLE_MAX - NPC_TUNING.PED_IDLE_MIN);
    const shop = this._nearestShop(ped.x, ped.z, 26);
    if (shop) ped.yaw = Math.atan2(shop.x - ped.x, shop.z - ped.z);
  }

  _nearestShop(x, z, maxD) {
    if (!this.city || !this.city.buildings) return null;
    let best = null;
    let bestD = maxD;
    for (const b of this.city.buildings) {
      if (b.type !== 'Shop' && b.type !== 'Cafe' && b.type !== 'Diner') continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** Cheap O(n^2) separation so walkers never stack inside each other. */
  _separate() {
    const list = this.peds;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.active || a.state === PED_DOWN) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.active || b.state === PED_DOWN) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 0.81 && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = ((0.9 - d) / d) * 0.5;
          a.x -= dx * push * 0.5;
          a.z -= dz * push * 0.5;
          b.x += dx * push * 0.5;
          b.z += dz * push * 0.5;
        }
      }
    }
  }

  _writeMatrices() {
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      let y = 0;
      let roll = 0;
      let pitch = 0;
      if (p.state === PED_WANDER || p.state === PED_CROSS) {
        y = Math.abs(Math.sin(p.phase)) * 0.055;         // looped stride bob
        roll = Math.sin(p.phase) * 0.045;                 // hip sway
      } else if (p.state === PED_PANIC) {
        y = Math.abs(Math.sin(p.phase)) * 0.09;
        roll = Math.sin(p.phase) * 0.07;
        pitch = -0.22;                                     // forward sprint lean
      } else if (p.state === PED_DOWN) {
        pitch = -Math.PI / 2 + 0.12;                       // flat on the ground
        y = 0.32;
      }
      _v1.set(p.x, p.y + y, p.z);
      _q.setFromEuler(_e.set(pitch, p.yaw, roll, 'YXZ'));
      _s.set(1, 1, 1);
      // Procedural height variety without extra draw calls.
      const h = 0.94 + ((i * 37) % 10) * 0.014;
      _s.set(h, 0.92 + ((i * 53) % 10) * 0.016, h);
      _m.compose(_v1, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ================================================================ traffic
export class TrafficSystem {
  constructor(scene, physics, opts = {}) {
    this.scene = scene;
    this.physics = physics;
    this.seed = opts.seed ?? 20261005;
    this.rng = mulberry32(this.seed);
    this.cars = [];
    this.bodyMesh = null;
    this.ringPts = ringLoopPoints();
  }

  init() {
    const geo = buildTrafficCarGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 });
    this.bodyMesh = new THREE.InstancedMesh(geo, mat, NPC_TUNING.TRAFFIC_MAX);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.receiveShadow = false;
    this.bodyMesh.frustumCulled = false;
    this.bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const boxShape = new CANNON.Box(new CANNON.Vec3(0.95, 0.6, 2.15));
    for (let i = 0; i < NPC_TUNING.TRAFFIC_MAX; i++) {
      _c.setHex(CAR_PALETTE[i % CAR_PALETTE.length]).offsetHSL(0, 0, (this.rng() - 0.5) * 0.06);
      this.bodyMesh.setColorAt(i, _c);
      const body = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        shape: boxShape,
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: MASK.WORLD,
      });
      body.position.set(0, -50, 0);
      this.physics.addBody(body);
      // Pool: 8 street cars + 4 highway cars active, 2 spare slots.
      const highway = i >= 8 && i < NPC_TUNING.TRAFFIC_COUNT;
      this.cars.push({
        active: false, highway, body,
        x: 0, y: 0, z: 0, yaw: 0, speed: 0, cruise: 10,
        pts: null, seg: 0, segT: 0, dir: 1, lane: 2.5, mode: 'loop',
        blocked: false, blockDist: Infinity,
      });
      _m.makeScale(0, 0, 0);
      this.bodyMesh.setMatrixAt(i, _m);
    }
    this.bodyMesh.instanceColor.needsUpdate = true;
    this.scene.add(this.bodyMesh);
    // Seed the active pool onto routes immediately so the streets are alive
    // on load. The two spare slots stay parked until needed.
    for (let i = 0; i < this.cars.length; i++) {
      if (i >= NPC_TUNING.TRAFFIC_COUNT) break;
      const car = this.cars[i];
      let ok = false;
      if (car.highway) ok = this._assignHighway(car, 0, 0);
      else {
        // Retry around several anchors so even a water pick finds a lane.
        for (let t = 0; t < 6 && !ok; t++) {
          ok = this._assignStreet(car, (this.rng() * 2 - 1) * 900, (this.rng() * 2 - 1) * 900);
        }
      }
      car.active = ok;
    }
    return this;
  }

  get activeCount() {
    let n = 0;
    for (const c of this.cars) if (c.active) n++;
    return n;
  }

  /** Street route: straight lane run near (cx,cz), returned as centre-line pts. */
  planStreetRoute(cx, cz) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const axis = this.rng() < 0.5 ? 'x' : 'z';
      const f = axis === 'x' ? cz : cx;
      const t0base = axis === 'x' ? cx : cz;
      const near = GRADE_LINES.filter((L) => Math.abs(L - f) < 170);
      if (!near.length) continue;
      const line = near[Math.floor(this.rng() * near.length)];
      const dir = this.rng() < 0.5 ? -1 : 1;
      const len = 180 + this.rng() * 140;
      let a = t0base - dir * len * 0.35;
      let b = t0base + dir * len * 0.65;
      a = clamp(a, -1090, 1090);
      b = clamp(b, -1090, 1090);
      if ((b - a) * dir < 60) continue;
      const mx = axis === 'x' ? (a + b) / 2 : line;
      const mz = axis === 'x' ? line : (a + b) / 2;
      if (!isLand(mx, mz, 2)) continue;
      // Skip lanes buried under the elevated deck.
      const lane = laneOffsetFor(axis, dir, line);
      const ox = axis === 'x' ? (a + b) / 2 : line + lane;
      const oz = axis === 'x' ? line + lane : (a + b) / 2;
      if (underElevated(ox, oz, 1.0)) continue;
      // Store the centre-line ascending so `dir` alone sets travel direction.
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const pts = axis === 'x'
        ? [{ x: lo, y: 0.05, z: line }, { x: hi, y: 0.05, z: line }]
        : [{ x: line, y: 0.05, z: lo }, { x: line, y: 0.05, z: hi }];
      return {
        pts, axis, line, dir,
        lane,
        cruise: NPC_TUNING.STREET_SPEED_MIN + this.rng() * (NPC_TUNING.STREET_SPEED_MAX - NPC_TUNING.STREET_SPEED_MIN),
        mode: 'replan',
      };
    }
    return null;
  }

  _assignStreet(car, cx, cz) {
    const r = this.planStreetRoute(cx, cz);
    if (!r) {
      car.active = false;
      return false;
    }
    car.pts = r.pts;
    car.axis = r.axis;
    car.line = r.line;
    car.lane = r.lane;
    car.cruise = r.cruise;
    car.mode = 'replan';
    car.seg = 0;
    car.dir = r.dir;
    car.segT = 0.4; // start mid-run so fresh cars appear already on the road
    car.speed = car.cruise * 0.5;
    this._placeOnRoute(car);
    return true;
  }

  _assignHighway(car, fx, fz) {
    const kind = this.rng();
    if (kind < 0.5) {
      // Elevated ring loop, either circulation direction.
      car.pts = this.ringPts;
      car.dir = this.rng() < 0.5 ? 1 : -1;
      car.mode = 'loop';
      car.seg = Math.floor(this.rng() * (this.ringPts.length - 1));
      car.lane = GRID.ARTERIAL.WIDTH / 4;
    } else if (kind < 0.75) {
      // North-south spine shuttle.
      car.pts = [];
      for (let z = -800; z <= 880; z += 40) {
        car.pts.push({ x: GRID.NS.X, y: Math.max(spineProfileY(z, GRID.NS.ELEV[0], GRID.NS.ELEV[1], GRID.NS.RAMP), 0.05), z });
      }
      car.dir = this.rng() < 0.5 ? 1 : -1;
      car.mode = 'pingpong';
      car.seg = Math.floor(this.rng() * (car.pts.length - 1));
      car.lane = GRID.ARTERIAL.WIDTH / 4;
    } else {
      // East-west spine shuttle.
      car.pts = [];
      for (let x = -1100; x <= 600; x += 40) {
        car.pts.push({ x, y: Math.max(spineProfileY(x, GRID.EW.ELEV[0], GRID.EW.ELEV[1], GRID.EW.RAMP), 0.05), z: GRID.EW.Z });
      }
      car.dir = this.rng() < 0.5 ? 1 : -1;
      car.mode = 'pingpong';
      car.seg = Math.floor(this.rng() * (car.pts.length - 1));
      car.lane = GRID.ARTERIAL.WIDTH / 4;
    }
    car.cruise = NPC_TUNING.HIGHWAY_SPEED_MIN + this.rng() * (NPC_TUNING.HIGHWAY_SPEED_MAX - NPC_TUNING.HIGHWAY_SPEED_MIN);
    car.speed = car.cruise * 0.6;
    car.segT = 0;
    void fx;
    void fz;
    this._placeOnRoute(car);
    return true;
  }

  /** Snap the car to its current route position (used on (re)assignment). */
  _placeOnRoute(car) {
    const p = this._routePoint(car, car.seg, car.segT, car.dir);
    car.x = p.x;
    car.z = p.z;
    car.y = p.y;
    car.yaw = p.yaw;
  }

  /** Centre-line point + right-hand lane offset for segment seg at fraction t. */
  _routePoint(car, seg, t, dir) {
    const pts = car.pts;
    const n = pts.length;
    const i0 = ((seg % (n - 1)) + (n - 1)) % (n - 1);
    const i1 = i0 + 1;
    const from = dir > 0 ? pts[i0] : pts[i1];
    const to = dir > 0 ? pts[i1] : pts[i0];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.max(Math.hypot(dx, dz), 1e-6);
    const ux = dx / len;
    const uz = dz / len;
    // Right of travel: facing +X right is +Z -> right = (-uz, ux).
    const rx = -uz;
    const rz = ux;
    return {
      x: from.x + dx * t + rx * car.lane,
      y: from.y + (to.y - from.y) * t,
      z: from.z + dz * t + rz * car.lane,
      yaw: Math.atan2(ux, uz),
      segLen: len,
    };
  }

  update(dt, ctx = {}, peds = []) {
    const fx = ctx.focusX ?? 0;
    const fz = ctx.focusZ ?? 0;
    const obstacles = this._gatherObstacles(ctx, peds);

    for (const car of this.cars) {
      if (!car.active) continue;

      // ---- recycle far cars so the pool hugs the player
      const dFocus = Math.hypot(car.x - fx, car.z - fz);
      if (car.highway) {
        if (dFocus > 520) this._assignHighway(car, fx, fz);
      } else if (dFocus > 320) {
        if (!this._assignStreet(car, fx + (this.rng() * 2 - 1) * 120, fz + (this.rng() * 2 - 1) * 120)) continue;
      }

      // ---- forward raycast: nearest obstacle inside the corridor.
      // The base length is 8 m; it stretches with speed (≈0.7 s headway) so a
      // car at cruise still has room for its full stopping distance.
      const dirX = Math.sin(car.yaw);
      const dirZ = Math.cos(car.yaw);
      const look = NPC_TUNING.SCAN_LENGTH + car.speed * 0.7;
      let nearest = Infinity;
      for (const o of obstacles) {
        if (o.ref === car) continue;
        if (Math.abs((o.y ?? 0) - car.y) > 3.5) continue; // other deck level
        const rx = o.x - car.x;
        const rz = o.z - car.z;
        const fwd = rx * dirX + rz * dirZ;
        if (fwd < 0 || fwd > look + o.r) continue;
        const lat = Math.abs(rx * dirZ - rz * dirX);
        if (lat > NPC_TUNING.SCAN_HALF_WIDTH) continue;
        const gap = fwd - o.r - 2.0; // stop with the bumper ~2 m short
        if (gap < nearest) nearest = gap;
      }
      car.blocked = nearest < NPC_TUNING.SCAN_LENGTH;
      car.blockDist = nearest;
      // Follow profile: cap speed at what stops inside the remaining gap
      // (v^2 = 2*a*d), so braking is smooth yet never overshoots the queue.
      const STOP_MARGIN = 1.0;
      const BRAKE_DECEL = 8;
      let target = car.cruise;
      if (car.blocked) {
        const avail = Math.max(0, nearest - STOP_MARGIN);
        target = Math.min(car.cruise, Math.sqrt(2 * BRAKE_DECEL * avail));
      }
      const accel = target > car.speed ? (car.highway ? 4 : 3) : 8;
      const dv = clamp(target - car.speed, -accel * dt, accel * dt);
      car.speed = Math.max(0, car.speed + dv);

      // ---- advance along the route
      let remaining = car.speed * dt;
      let guard = 0;
      while (remaining > 0 && guard++ < 6) {
        const p = this._routePoint(car, car.seg, car.segT, car.dir);
        const left = (1 - car.segT) * p.segLen;
        if (remaining < left) {
          car.segT += remaining / p.segLen;
          remaining = 0;
        } else {
          remaining -= left;
          if (!this._advanceSegment(car)) break;
        }
      }
      const p = this._routePoint(car, car.seg, car.segT, car.dir);
      car.x = p.x;
      car.y = p.y;
      car.z = p.z;
      car.yaw = angleLerp(car.yaw, p.yaw, 1 - Math.exp(-8 * dt));
    }

    this._writeMatrices();
    this._syncBodies();
  }

  /** Move to the next route segment; returns false when the route ended. */
  _advanceSegment(car) {
    const n = car.pts.length;
    if (car.mode === 'loop') {
      car.seg = (((car.seg + car.dir) % (n - 1)) + (n - 1)) % (n - 1);
      car.segT = 0;
      return true;
    }
    if (car.mode === 'pingpong') {
      const next = car.seg + car.dir;
      if (next < 0 || next >= n - 1) {
        car.dir *= -1; // shuttle back; lane offset flips sides automatically
        car.segT = 0;
        return true;
      }
      car.seg = next;
      car.segT = 0;
      return true;
    }
    // 'replan': street run finished -> turn onto a crossing street when handy.
    const endX = car.dir > 0 ? car.pts[car.pts.length - 1].x : car.pts[0].x;
    const endZ = car.dir > 0 ? car.pts[car.pts.length - 1].z : car.pts[0].z;
    const keep = car;
    const r = this.planStreetRoute(endX, endZ);
    if (r && this.rng() < 0.75) {
      keep.pts = r.pts;
      keep.axis = r.axis;
      keep.line = r.line;
      keep.lane = r.lane;
      keep.cruise = r.cruise;
      keep.dir = r.dir;
      keep.seg = 0;
      // Start exactly where the old run ended (continuity through the turn).
      keep.segT = r.dir > 0 ? 0.35 : 0.65;
    } else {
      // U-turn in place and head back along the same lane run.
      keep.dir *= -1;
      keep.lane = laneOffsetFor(keep.axis, keep.dir, keep.line);
      keep.seg = 0;
      keep.segT = 0; // `from` is the end the car just reached
    }
    return true;
  }

  _gatherObstacles(ctx, peds) {
    const list = [];
    if (ctx.carX !== undefined && ctx.driving !== false) {
      list.push({ x: ctx.carX, z: ctx.carZ, y: ctx.carY ?? 0, r: 2.2, ref: 'player' });
    }
    if (ctx.onFoot && ctx.playerX !== undefined) {
      list.push({ x: ctx.playerX, z: ctx.playerZ, y: 0, r: 0.6, ref: 'walker' });
    }
    for (const car of this.cars) {
      if (!car.active) continue;
      list.push({ x: car.x, z: car.z, y: car.y, r: 2.2, ref: car });
    }
    for (const p of peds) {
      if (!p.active) continue;
      list.push({ x: p.x, z: p.z, y: 0, r: 0.5, ref: p });
    }
    return list;
  }

  _writeMatrices() {
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (!c.active) {
        _m.makeScale(0, 0, 0);
        this.bodyMesh.setMatrixAt(i, _m);
        continue;
      }
      _v1.set(c.x, c.y, c.z);
      _q.setFromEuler(_e.set(0, c.yaw, 0));
      _s.set(1, 1, 1);
      _m.compose(_v1, _q, _s);
      this.bodyMesh.setMatrixAt(i, _m);
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true;
  }

  _syncBodies() {
    for (const c of this.cars) {
      if (!c.active) {
        c.body.position.set(0, -50, 0);
        c.body.velocity.setZero();
        continue;
      }
      c.body.position.set(c.x, c.y + 0.7, c.z);
      c.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), c.yaw);
      c.body.velocity.set(Math.sin(c.yaw) * c.speed, 0, Math.cos(c.yaw) * c.speed);
      c.body.aabbNeedsUpdate = true;
    }
  }
}

// ================================================================ facade
export class AmbientNPCs {
  constructor(scene, physics, opts = {}) {
    this.scene = scene;
    this.physics = physics;
    this.peds = new PedestrianSystem(scene, { city: opts.city, seed: opts.seed });
    this.traffic = new TrafficSystem(scene, physics, { seed: (opts.seed ?? 20261004) + 1 });
    this._alerts = [];
  }

  init() {
    this.peds.init();
    this.traffic.init();
    return this;
  }

  update(dt, ctx = {}) {
    const step = Math.min(Math.max(dt, 0), 0.1);
    // Pedestrians first so traffic sees fresh walker positions in its scan.
    this.peds.update(step, {
      ...ctx,
      onAlert: (a) => this._alerts.push(a),
    });
    this.traffic.update(step, ctx, this.peds.peds);
  }

  pollAlerts() {
    if (!this._alerts.length) return [];
    const out = this._alerts.slice();
    this._alerts.length = 0;
    return out;
  }

  stats() {
    const states = { wander: 0, idle: 0, panic: 0, down: 0, crossing: 0 };
    for (const p of this.peds.peds) {
      if (!p.active) continue;
      if (states[p.state] !== undefined) states[p.state]++;
    }
    let speed = 0;
    let n = 0;
    for (const c of this.traffic.cars) {
      if (!c.active) continue;
      speed += c.speed;
      n++;
    }
    return {
      peds: this.peds.activeCount,
      pedStates: states,
      traffic: this.traffic.activeCount,
      trafficAvgKmh: n ? (speed / n) * 3.6 : 0,
    };
  }
}
