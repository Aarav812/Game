import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP, MASK } from './collision.js';

/**
 * island.js
 * ---------
 * A 2500 x 2500 landmass sitting inside an endless ocean.
 *
 *   - a rounded-square plateau (walkable half-extent 1200) with a beach that
 *     slopes into the sea all the way round, with matching sloped colliders
 *   - a NORTHERN BAY and a WESTERN INLET carved out of the interior, so the
 *     arterial network has real water to bridge
 *   - a QUADTREE land collider: flat ground becomes a few big boxes, coastlines
 *     and the carved water become small ones, water becomes none. This keeps
 *     the static body count in the low hundreds instead of thousands.
 *   - an animated ocean plane far larger than the island
 */

// ------------------------------------------------------------------ profile
export const ISLAND = {
  PLATEAU: 1260,   // half-extent of the flat, walkable land (>= 2500 across)
  COAST: 1380,     // half-extent where the beach reaches sea level
  DROP: 10,        // how far the beach descends
  SEA_LEVEL: -3.2,
  KILL_Y: -1.5,    // below this the player/car is considered drowned
  // Northern bay: gives Zone D its scenic coastal stretch and a bridge.
  BAY: { x: 430, z: 1010, rx: 330, rz: 280 },
  // Western inlet: a river the east-west arterial bridges.
  INLET: { z: -300, half: 44, from: -900, to: -420, blend: 14 },
  // Collider quadtree limits.
  MIN_CELL: 60,
};

const OUTER = ISLAND.COAST + 20;
// 160 segments is plenty for a mostly-flat shelf and keeps the terrain under
// ~50k triangles, which matters because the ground is drawn by both the main
// camera and the radar.
const SEGMENTS = 160;

const WATER_SIZE = 7000;
const WATER_SEGMENTS = 64;
const WAVE = { amp: 0.42, len: 74, speed: 0.8, amp2: 0.19, len2: 31, speed2: 1.35 };
const NORMAL_INTERVAL = 3;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

/** Height of the terrain at a point: island, minus the bay and the inlet. */
export function terrainHeight(x, z) {
  const n = 6;
  const d = Math.pow(Math.pow(Math.abs(x), n) + Math.pow(Math.abs(z), n), 1 / n);

  let h;
  if (d <= ISLAND.PLATEAU) h = 0;
  else if (d >= ISLAND.COAST) h = -ISLAND.DROP;
  else h = -ISLAND.DROP * smoothstep((d - ISLAND.PLATEAU) / (ISLAND.COAST - ISLAND.PLATEAU));

  // Northern bay (ellipse, hard-edged so the collider quadtree stays tight).
  const B = ISLAND.BAY;
  const bd = Math.hypot((x - B.x) / B.rx, (z - B.z) / B.rz);
  if (bd < 1) h = -ISLAND.DROP;

  // Western inlet (a river channel running inland).
  const I = ISLAND.INLET;
  if (x > I.from && x < I.to) {
    const across = clamp01((I.half + I.blend - Math.abs(z - I.z)) / I.blend);
    const along = clamp01((x - I.from) / I.blend) * clamp01((I.to - x) / I.blend);
    const carve = clamp01(across * along);
    if (carve > 0) h = h * (1 - carve) + -ISLAND.DROP * carve;
  }

  return h;
}

/**
 * True where the ground is solid land. The optional `clearance` is accepted for
 * call-site readability but does not change the test: the plateau is exactly
 * y = 0 and anything carved is below sea level, so the only meaningful question
 * is whether a point is on the plateau.
 */
export function isLand(x, z, clearance = 0) {
  void clearance;
  return terrainHeight(x, z) > -0.5;
}

export class Island {
  constructor(scene, physics, groundMaterial) {
    this.scene = scene;
    this.physics = physics;
    this.groundMaterial = groundMaterial;
    this._time = 0;
    this._frame = 0;
    this._colliders = [];
    this.landCells = 0;
  }

  build(respawnPoints = []) {
    this._buildTerrain();
    this._buildLandColliders();
    this._buildBeachColliders();
    this._buildWater();
    this._buildRespawnPoints(respawnPoints);
    return this;
  }

  // ----------------------------------------------------------------- terrain
  _buildTerrain() {
    const geo = new THREE.PlaneGeometry(OUTER * 2, OUTER * 2, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(0x53704a);
    const dry = new THREE.Color(0x8f8a55);
    const sand = new THREE.Color(0xd8c48f);
    const wet = new THREE.Color(0x9c8a63);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = terrainHeight(x, z);
      pos.setY(i, y);
      let c;
      if (y <= -0.05) c = y > ISLAND.SEA_LEVEL - 0.5 ? sand : wet;
      else c = grass.clone().lerp(dry, clamp01((z - 200) / 900));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.0 })
    );
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.terrain = mesh;
  }

  // --------------------------------------------------------------- colliders
  /**
   * Quadtree over the plateau. A cell that is entirely land becomes ONE box at
   * y = 0; a cell that is entirely water becomes nothing (so the bay and inlet
   * are genuinely open); a mixed cell is subdivided down to MIN_CELL. Flat
   * ground therefore costs a handful of bodies while the coastline stays tight.
   */
  _buildLandColliders() {
    const half = ISLAND.PLATEAU;
    const thickness = ISLAND.DROP + 12;
    const cells = [];
    const MIN = ISLAND.MIN_CELL;

    const walk = (x0, z0, size) => {
      // A 9x9 sample per cell. A 5-point sample is far too sparse at these
      // scales: a 630-unit cell could straddle the whole inlet and still read
      // "all land", which would leave invisible ground over the water.
      const N = 9;
      let land = 0;
      let total = 0;
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N; j++) {
          total++;
          if (terrainHeight(x0 + (i / N) * size, z0 + (j / N) * size) > -0.6) land++;
        }
      }
      if (land === 0) return;                     // open water: no collider
      // ONLY a fully-land cell gets a box. A mixed cell is subdivided; once it
      // hits MIN_CELL it is dropped, which leaves a thin open strip along the
      // bay, the inlet and the coastline rather than invisible ground over
      // water. The outer plateau edge is exactly PLATEAU and aligns with the
      // cell grid, so the true coastline is never lost.
      if (land === total) { cells.push({ x0, z0, size }); return; }
      if (size <= MIN) return;
      const s2 = size / 2;
      walk(x0, z0, s2);
      walk(x0 + s2, z0, s2);
      walk(x0, z0 + s2, s2);
      walk(x0 + s2, z0 + s2, s2);
    };

    // Start from a coarse grid so flat interior tiles stay large.
    const ROOT = half / 2;
    for (let gx = -2; gx < 2; gx++) {
      for (let gz = -2; gz < 2; gz++) walk(gx * ROOT, gz * ROOT, ROOT);
    }

    // One merged static body per coarse group keeps the body count tiny while
    // still giving the narrowphase exactly the boxes it needs.
    const GROUP_SIZE = 300;
    const groups = new Map();
    for (const c of cells) {
      const gx = Math.floor(c.x0 / GROUP_SIZE);
      const gz = Math.floor(c.z0 / GROUP_SIZE);
      const key = `${gx},${gz}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    for (const list of groups.values()) {
      const body = new CANNON.Body({
        mass: 0,
        material: this.groundMaterial,
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: MASK.WORLD,
      });
      for (const c of list) {
        const s = c.size / 2;
        body.addShape(
          new CANNON.Box(new CANNON.Vec3(s, thickness / 2, s)),
          new CANNON.Vec3(c.x0 + s, -thickness / 2, c.z0 + s)
        );
      }
      body.aabbNeedsUpdate = true;
      this.physics.addBody(body);
      this._colliders.push(body);
      this.landCells += list.length;
    }
    this.landBodies = groups.size;
  }

  // Sloped beach ring, segmented so it follows the terrain profile.
  _buildBeachColliders() {
    const { PLATEAU, COAST, DROP } = ISLAND;
    const run = COAST - PLATEAU;
    const N = 6;
    const prof = (t) => -DROP * smoothstep(t);

    const add = (a, b) => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dz);
      const yaw = Math.atan2(-dz, dx);
      const pitch = Math.atan2(dy, Math.max(L, 1e-6));
      const q = new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0, yaw, 0))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch));
      const len = Math.hypot(L, dy);
      const thickness = 2;
      const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const body = new CANNON.Body({
        mass: 0,
        material: this.groundMaterial,
        shape: new CANNON.Box(new CANNON.Vec3(len / 2, thickness / 2, PLATEAU)),
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: MASK.WORLD,
      });
      body.quaternion.set(q.x, q.y, q.z, q.w);
      body.position.set(
        (a.x + b.x) / 2 - normal.x * (thickness / 2),
        (a.y + b.y) / 2 - normal.y * (thickness / 2),
        (a.z + b.z) / 2 - normal.z * (thickness / 2)
      );
      body.aabbNeedsUpdate = true;
      this.physics.addBody(body);
      this._colliders.push(body);
    };

    for (let j = 0; j < N; j++) {
      const r0 = PLATEAU + (j / N) * run;
      const r1 = PLATEAU + ((j + 1) / N) * run;
      const y0 = prof(j / N);
      const y1 = prof((j + 1) / N);
      add({ x: r0, z: 0, y: y0 }, { x: r1, z: 0, y: y1 });
      add({ x: -r0, z: 0, y: y0 }, { x: -r1, z: 0, y: y1 });
      add({ x: 0, z: r0, y: y0 }, { x: 0, z: r1, y: y1 });
      add({ x: 0, z: -r0, y: y0 }, { x: 0, z: -r1, y: y1 });
    }
  }

  // -------------------------------------------------------------------- water
  _buildWater() {
    const geo = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, WATER_SEGMENTS, WATER_SEGMENTS);
    geo.rotateX(-Math.PI / 2);

    this.waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x1d6288,
      roughness: 0.16,
      metalness: 0.6,
      transparent: true,
      opacity: 0.92,
    });
    this.water = new THREE.Mesh(geo, this.waterMaterial);
    this.water.position.y = ISLAND.SEA_LEVEL;
    this.scene.add(this.water);
    this._waterBase = geo.attributes.position.array.slice();
  }

  updateWater(dt) {
    this._time += dt;
    this._frame++;
    const t = this._time;
    const pos = this.water.geometry.attributes.position;
    const base = this._waterBase;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      const z = base[i * 3 + 2];
      pos.setY(
        i,
        Math.sin(x / WAVE.len + t * WAVE.speed) * WAVE.amp +
          Math.sin((x + z) / WAVE.len2 - t * WAVE.speed2) * WAVE.amp2
      );
    }
    pos.needsUpdate = true;
    if (this._frame % NORMAL_INTERVAL === 0) this.water.geometry.computeVertexNormals();
  }

  // ----------------------------------------------------------------- respawn
  _buildRespawnPoints(points) {
    this.respawnPoints = points.length ? points.slice() : [{ x: 0, z: 0 }];
    this._respawnGrid = new Map();
    const CELL = 250;
    this.respawnPoints.forEach((p, i) => {
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
      if (!this._respawnGrid.has(key)) this._respawnGrid.set(key, []);
      this._respawnGrid.get(key).push(i);
    });
    this._respawnCell = CELL;
  }

  /** Nearest road spawn point to a world position. */
  nearestRespawn(x, z) {
    const C = this._respawnCell;
    const gx = Math.floor(x / C);
    const gz = Math.floor(z / C);
    for (let ring = 0; ring < 40; ring++) {
      let best = null;
      let bestD = Infinity;
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (ring > 0 && Math.abs(i) !== ring && Math.abs(j) !== ring) continue;
          const list = this._respawnGrid.get(`${gx + i},${gz + j}`);
          if (!list) continue;
          for (const idx of list) {
            const p = this.respawnPoints[idx];
            const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
            if (d < bestD) { bestD = d; best = p; }
          }
        }
      }
      if (best) return best;
    }
    return this.respawnPoints[0];
  }

  isDrowned(y) {
    return y < ISLAND.KILL_Y;
  }
}
