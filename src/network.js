import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP, MASK } from './collision.js';
import { isLand, ISLAND } from './island.js';

/**
 * network.js
 * ----------
 * The whole hierarchical road system, generated procedurally from GRID — no
 * hand-written street or building arrays anywhere.
 *
 *   ARTERIAL   six-lane elevated ring + two cross-island spines (y = 9), with
 *              concrete crash barriers, piers, yellow double-dividers and white
 *              dashed lane lines. These are the only roads that need physics
 *              colliders, because they are the only ones off the ground.
 *   BOULEVARD  four-lane avenues on a 500-unit pitch, at grade.
 *   LOCAL      two-lane streets on a 100-unit pitch, at grade.
 *
 * Grade-level roads are pure geometry sitting on the plateau collider, so they
 * cost ZERO physics bodies. Every elevated surface goes through `_slab`, which
 * builds the mesh and the CANNON.Box from one transform.
 */

const ASPHALT = 0x343a42;
const CONCRETE = 0xb4aea3;
const RAIL = 0xbfc4cb;
const WHITE = 0xe9e4d6;
const YELLOW = 0xe3b73a;

export const GRID = {
  // Six-lane elevated arterial ring + spines.
  ARTERIAL: {
    HALF: 1150,          // ring centre-line half extent
    CORNER: 300,         // quarter-arc radius at the ring corners
    WIDTH: 30,           // six lanes
    Y: 9,                // elevated deck height
    SEG: 14,             // segments per corner arc
    GUARD: 0.95,         // barrier height
  },
  NS: { X: 0, ELEV: [-700, 800], RAMP: 120 },
  EW: { Z: -300, ELEV: [-1000, 500], RAMP: 120 },
  BOULEVARD: { PITCH: 500, WIDTH: 20 },
  LOCAL: { PITCH: 100, WIDTH: 10 },
  EXTENT: 1100,          // outermost street line
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

/** Elevation of a cross-island spine at a coordinate along its axis. */
function spineProfile(coord, elevFrom, elevTo, ramp) {
  const up = smoothstep(clamp01((coord - (elevFrom - ramp)) / ramp));
  const down = smoothstep(clamp01((coord - elevTo) / ramp));
  return GRID.ARTERIAL.Y * (up - down);
}

export class RoadNetwork {
  constructor(scene, physics, groundMaterial) {
    this.scene = scene;
    this.physics = physics;
    this.groundMaterial = groundMaterial;

    this.materials = {
      asphalt: new THREE.MeshStandardMaterial({ color: ASPHALT, roughness: 0.85, metalness: 0.02 }),
      concrete: new THREE.MeshStandardMaterial({ color: CONCRETE, roughness: 0.9, metalness: 0.0 }),
      rail: new THREE.MeshStandardMaterial({ color: RAIL, roughness: 0.5, metalness: 0.5 }),
      white: new THREE.MeshStandardMaterial({ color: WHITE, roughness: 0.8, metalness: 0.0 }),
      yellow: new THREE.MeshStandardMaterial({ color: YELLOW, roughness: 0.75, metalness: 0.0 }),
    };

    this._geos = { asphalt: [], concrete: [], rail: [], white: [], yellow: [] };
    this._pierTransforms = [];
    this._pierShapes = [];
    this._lampTransforms = [];
    this.colliders = [];
    this.pierBodies = 0;
    this.crossings = [];   // boulevard x local intersections, for traffic lights
    this.respawn = [];     // safe spawn points on the network
  }

  build() {
    this._buildRing();
    this._buildSpines();
    this._buildGradeRoads();
    this._flushPiers();
    this._commit();
    return this;
  }

  // ------------------------------------------------------------------ helpers
  _slab(cx, topY, cz, size, quat, material = 'asphalt') {
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    geo.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(cx, topY - size[1] / 2, cz),
        quat,
        new THREE.Vector3(1, 1, 1)
      )
    );
    this._geos[material].push(geo);

    const body = new CANNON.Body({
      mass: 0,
      material: this.groundMaterial,
      shape: new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)),
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: MASK.WORLD,
    });
    body.position.set(cx, topY - size[1] / 2, cz);
    body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    body.aabbNeedsUpdate = true;
    this.physics.addBody(body);
    this.colliders.push(body);
    return body;
  }

  _paint(axis, x, y, z, len, w) {
    const g = new THREE.PlaneGeometry(axis === 'x' ? len : w, axis === 'x' ? w : len);
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    this._geos[this._paintMat].push(g);
  }

  _stripQuat(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dy = (b.y || 0) - (a.y || 0);
    const L = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dz, dx);
    const pitch = Math.atan2(dy, Math.max(L, 1e-6));
    return {
      q: new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0, yaw, 0))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch)),
      length: Math.hypot(L, dy),
    };
  }

  /** One asphalt strip between two {x,z,y} points, plus barriers + lane paint. */
  _run(a, b, width, opts = {}) {
    const { q, length } = this._stripQuat(a, b);
    if (length < 0.05) return;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const body = this._slab(mid.x, mid.y, mid.z, [length + 0.5, 1.2, width], q);

    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L;
    const nz = dx / L;

    if (opts.guard) {
      const guardQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-dz, dx), 0));
      // Shape offsets are in the BODY's local frame, so the world-side offset
      // has to be rotated back through the deck's inverse quaternion.
      const qInv = q.clone().invert();
      const lift = 0.6 + GRID.ARTERIAL.GUARD / 2; // deck centre -> barrier centre
      for (const side of [-1, 1]) {
        const ox = nx * side * (width / 2 - 0.3);
        const oz = nz * side * (width / 2 - 0.3);
        const g = new THREE.BoxGeometry(length + 0.4, GRID.ARTERIAL.GUARD, 0.45);
        g.applyMatrix4(
          new THREE.Matrix4().compose(
            new THREE.Vector3(mid.x + ox, mid.y + GRID.ARTERIAL.GUARD / 2, mid.z + oz),
            guardQ,
            new THREE.Vector3(1, 1, 1)
          )
        );
        this._geos.concrete.push(g);

        // A real collider on the SAME body as the deck: a car cannot slide off
        // the viaduct or the bridges, and it costs zero extra bodies.
        const local = new THREE.Vector3(ox, lift, oz).applyQuaternion(qInv);
        body.addShape(
          new CANNON.Box(new CANNON.Vec3((length + 0.4) / 2, GRID.ARTERIAL.GUARD / 2, 0.225)),
          new CANNON.Vec3(local.x, local.y, local.z)
        );
      }
      body.updateBoundingRadius();
      body.aabbNeedsUpdate = true;
    }

    if (opts.dividers) {
      // Yellow double centre divider (two solid lines).
      this._paintMat = 'yellow';
      const y = mid.y + 0.03;
      for (const off of [-0.35, 0.35]) {
        this._paint('x', mid.x + nx * off, y, mid.z + nz * off, length, 0.24);
      }
      // White dashed lane lines at +-quarter width.
      this._paintMat = 'white';
      const dash = 3.2;
      const gap = 6.8;
      const step = dash + gap;
      const n = Math.max(1, Math.floor(length / step));
      for (const off of [-width / 4, width / 4]) {
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n - 0.5;
          this._paint(
            'x',
            mid.x + (b.x - a.x) * t + nx * off,
            y,
            mid.z + (b.z - a.z) * t + nz * off,
            dash,
            0.24
          );
        }
      }
    }
  }

  _pier(x, z, topY, bottomY) {
    const h = topY - bottomY;
    if (h <= 0.5) return;
    this._pierTransforms.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, (topY + bottomY) / 2, z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, h / 2, 1)
      )
    );
    this._pierShapes.push({ x, z, y: (topY + bottomY) / 2, h });
  }

  /** Merge all piers into coarse compound bodies instead of one body each. */
  _flushPiers() {
    const CHUNK = 400;
    const buckets = new Map();
    for (const p of this._pierShapes) {
      const k = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p);
    }
    for (const list of buckets.values()) {
      const body = new CANNON.Body({
        mass: 0,
        material: this.groundMaterial,
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: MASK.WORLD,
      });
      for (const p of list) {
        body.addShape(new CANNON.Cylinder(0.75, 0.9, p.h, 8), new CANNON.Vec3(p.x, p.y, p.z));
      }
      body.aabbNeedsUpdate = true;
      this.physics.addBody(body);
      this.pierBodies++;
    }
  }

  _lamp(x, z, y, yaw) {
    this._lampTransforms.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
        new THREE.Vector3(1, 1, 1)
      )
    );
  }

  // --------------------------------------------------------------- arterial
  _buildRing() {
    const A = GRID.ARTERIAL;
    const straight = A.HALF - A.CORNER;
    const W = A.WIDTH;
    const Y = A.Y;

    // Piers + lamps along the ring, spaced so they never duplicate at corners.
    const pierSpacing = 40;

    // --- four straights ---
    const runs = [
      { a: { x: -straight, z: A.HALF }, b: { x: straight, z: A.HALF } },
      { a: { x: -straight, z: -A.HALF }, b: { x: straight, z: -A.HALF } },
      { a: { x: A.HALF, z: -straight }, b: { x: A.HALF, z: straight } },
      { a: { x: -A.HALF, z: -straight }, b: { x: -A.HALF, z: straight } },
    ];
    for (const r of runs) {
      const a = { x: r.a.x, z: r.a.z, y: Y };
      const b = { x: r.b.x, z: r.b.z, y: Y };
      this._run(a, b, W, { guard: true, dividers: true });

      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const L = Math.hypot(dx, dz);
      const n = Math.floor(L / pierSpacing);
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        for (const off of [-W / 4, W / 4]) {
          const nx = -dz / L;
          const nz = dx / L;
          const gx = px + nx * off;
          const gz = pz + nz * off;
          const bottom = isLand(gx, gz, -0.5) ? 0 : ISLAND.SEA_LEVEL - 4;
          this._pier(gx, gz, Y - 1.2, bottom);
        }
      }
      for (let i = 0; i <= Math.floor(L / 55); i++) {
        const t = i / Math.max(1, Math.floor(L / 55));
        this._lamp(a.x + dx * t, a.z + dz * t, Y, Math.atan2(-dz, dx));
      }
    }

    // --- four banked-ish corner arcs (kept flat: this is an urban ring) ---
    const corners = [
      { cx: straight, cz: straight, a0: 0 },
      { cx: -straight, cz: straight, a0: Math.PI / 2 },
      { cx: -straight, cz: -straight, a0: Math.PI },
      { cx: straight, cz: -straight, a0: Math.PI * 1.5 },
    ];
    for (const c of corners) {
      for (let i = 0; i < A.SEG; i++) {
        const t0 = i / A.SEG;
        const t1 = (i + 1) / A.SEG;
        const a0 = c.a0 + t0 * (Math.PI / 2);
        const a1 = c.a0 + t1 * (Math.PI / 2);
        const p0 = { x: c.cx + Math.cos(a0) * A.CORNER, z: c.cz + Math.sin(a0) * A.CORNER, y: Y };
        const p1 = { x: c.cx + Math.cos(a1) * A.CORNER, z: c.cz + Math.sin(a1) * A.CORNER, y: Y };
        this._run(p0, p1, W, { guard: true, dividers: true });

        const am = (a0 + a1) / 2;
        const px = c.cx + Math.cos(am) * A.CORNER;
        const pz = c.cz + Math.sin(am) * A.CORNER;
        const nx = Math.cos(am);
        const nz = Math.sin(am);
        for (const off of [-W / 4, W / 4]) {
          const gx = px + nx * off;
          const gz = pz + nz * off;
          const bottom = isLand(gx, gz, -0.5) ? 0 : ISLAND.SEA_LEVEL - 4;
          this._pier(gx, gz, Y - 1.2, bottom);
        }
        this._lamp(px + nx * (W / 2 + 1.2), pz + nz * (W / 2 + 1.2), Y, am + Math.PI / 2);
      }
    }
  }

  _buildSpines() {
    const A = GRID.ARTERIAL;
    const W = A.WIDTH;
    const N = 90;

    // North-south spine.
    {
      const S = GRID.NS;
      const z0 = -GRID.EXTENT - 60;
      const z1 = GRID.EXTENT + 60;
      for (let i = 0; i < N; i++) {
        const za = z0 + (i / N) * (z1 - z0);
        const zb = z0 + ((i + 1) / N) * (z1 - z0);
        const ya = spineProfile(za, S.ELEV[0], S.ELEV[1], S.RAMP);
        const yb = spineProfile(zb, S.ELEV[0], S.ELEV[1], S.RAMP);
        if (ya < 0.4 && yb < 0.4) continue;
        this._run({ x: S.X, z: za, y: ya }, { x: S.X, z: zb, y: yb }, W, { guard: true, dividers: true });
        const zm = (za + zb) / 2;
        const ym = (ya + yb) / 2;
        if (ym > 1.5 && i % 2 === 0) {
          for (const off of [-W / 4, W / 4]) {
            const bottom = isLand(S.X + off, zm, -0.5) ? 0 : ISLAND.SEA_LEVEL - 4;
            this._pier(S.X + off, zm, ym - 1.2, bottom);
          }
        }
        if (ym > 0.4) this._lamp(S.X + W / 2 + 1.2, zm, ym, Math.PI / 2);
      }
    }

    // East-west spine (bridges the western inlet).
    {
      const S = GRID.EW;
      const x0 = -GRID.EXTENT - 60;
      const x1 = GRID.EXTENT + 60;
      for (let i = 0; i < N; i++) {
        const xa = x0 + (i / N) * (x1 - x0);
        const xb = x0 + ((i + 1) / N) * (x1 - x0);
        const ya = spineProfile(xa, S.ELEV[0], S.ELEV[1], S.RAMP);
        const yb = spineProfile(xb, S.ELEV[0], S.ELEV[1], S.RAMP);
        if (ya < 0.4 && yb < 0.4) continue;
        this._run({ x: xa, z: S.Z, y: ya }, { x: xb, z: S.Z, y: yb }, W, { guard: true, dividers: true });
        const xm = (xa + xb) / 2;
        const ym = (ya + yb) / 2;
        if (ym > 1.5 && i % 2 === 0) {
          for (const off of [-W / 4, W / 4]) {
            const bottom = isLand(xm, S.Z + off, -0.5) ? 0 : ISLAND.SEA_LEVEL - 4;
            this._pier(xm, S.Z + off, ym - 1.2, bottom);
          }
        }
        if (ym > 0.4) this._lamp(xm, S.Z + W / 2 + 1.2, ym, 0);
      }
    }
  }

  // ----------------------------------------------------------- grade roads
  /**
   * Boulevards and local streets. These sit on the plateau collider so they are
   * pure geometry: no physics bodies at all. Each line is emitted only where the
   * ground is actually land, so streets stop at the coastline and the bay.
   */
  _buildGradeRoads() {
    const B = GRID.BOULEVARD;
    const L = GRID.LOCAL;
    const boulevardLines = [];
    for (let v = -1000; v <= 1000; v += B.PITCH) boulevardLines.push(v);
    const localLines = [];
    for (let v = -1000; v <= 1000; v += L.PITCH) {
      if (Math.abs(v % B.PITCH) < 1e-6) continue;
      localLines.push(v);
    }
    this.boulevardLines = boulevardLines;
    this.localLines = localLines;

    const STEP = 25;
    const emitLine = (axis, coord, width) => {
      // Walk the line and emit contiguous land segments.
      let runStart = null;
      for (let t = -GRID.EXTENT - 100; t <= GRID.EXTENT + 100; t += STEP) {
        const x = axis === 'x' ? t : coord;
        const z = axis === 'x' ? coord : t;
        const land = isLand(x, z, 0.5);
        if (land && runStart === null) runStart = t;
        if ((!land || t + STEP > GRID.EXTENT + 100) && runStart !== null) {
          const end = t;
          if (end - runStart > STEP) this._gradeStrip(axis, coord, runStart, end, width);
          runStart = null;
        }
      }
    };

    for (const v of boulevardLines) {
      emitLine('x', v, B.WIDTH);
      emitLine('z', v, B.WIDTH);
    }
    for (const v of localLines) {
      emitLine('x', v, L.WIDTH);
      emitLine('z', v, L.WIDTH);
    }

    // Lane paint on the boulevards (yellow centre + white dashes).
    this._paintMat = 'yellow';
    for (const v of boulevardLines) {
      for (const axis of ['x', 'z']) {
        for (let t = -GRID.EXTENT; t < GRID.EXTENT; t += 6) {
          const x = axis === 'x' ? t : v;
          const z = axis === 'x' ? v : t;
          if (!isLand(x, z, 0.5)) continue;
          for (const off of [-0.3, 0.3]) {
            this._paint(axis, x + (axis === 'x' ? 0 : off), 0.05, z + (axis === 'x' ? off : 0), 6, 0.24);
          }
        }
      }
    }

    // Crossings for traffic lights / props.
    for (const bx of boulevardLines) {
      for (const bz of boulevardLines) {
        if (isLand(bx, bz, 1)) this.crossings.push({ x: bx, z: bz });
      }
    }
    // Respawn points: a generous scatter along the street grid.
    for (let x = -1000; x <= 1000; x += 250) {
      for (let z = -1000; z <= 1000; z += 250) {
        if (isLand(x, z, 2)) this.respawn.push({ x, z });
      }
    }
  }

  _gradeStrip(axis, coord, from, to, width) {
    const len = to - from;
    if (len <= 0) return;
    const mid = (from + to) / 2;
    const g = new THREE.BoxGeometry(axis === 'x' ? len : width, 0.9, axis === 'x' ? width : len);
    g.translate(axis === 'x' ? mid : coord, 0.02 - 0.45, axis === 'x' ? coord : mid);
    this._geos.asphalt.push(g);
  }

  // ----------------------------------------------------------------- commit
  /**
   * Merge per material AND per 700-unit cell. A single merged mesh spanning the
   * whole 2.5 km map can never be frustum-culled, so the radar pass (and the
   * main camera) would submit every road vertex every frame. Chunking lets
   * three's own culling throw away almost all of it.
   */
  _commit() {
    const CELL = 700;
    const centre = new THREE.Vector3();
    for (const [name, geos] of Object.entries(this._geos)) {
      if (!geos.length) continue;
      const buckets = new Map();
      for (const g of geos) {
        g.computeBoundingBox();
        g.boundingBox.getCenter(centre);
        const k = `${Math.floor(centre.x / CELL)},${Math.floor(centre.z / CELL)}`;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(g);
      }
      for (const list of buckets.values()) {
        const merged = mergeGeometries(list, false);
        if (!merged) continue;
        merged.computeVertexNormals();
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, this.materials[name]);
        mesh.castShadow = name !== 'white' && name !== 'yellow';
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.meshCount = (this.meshCount || 0) + 1;
      }
    }
    this._commitInstances();
  }

  _commitInstances() {
    const pierGeo = new THREE.CylinderGeometry(0.7, 0.85, 2, 10);
    const piers = new THREE.InstancedMesh(pierGeo, this.materials.concrete, Math.max(1, this._pierTransforms.length));
    this._pierTransforms.forEach((m, i) => piers.setMatrixAt(i, m));
    piers.instanceMatrix.needsUpdate = true;
    piers.castShadow = true;
    piers.receiveShadow = true;
    this.scene.add(piers);
    this.pierInstances = this._pierTransforms.length;

    const pole = new THREE.CylinderGeometry(0.13, 0.18, 8, 6);
    pole.translate(0, 4, 0);
    const arm = new THREE.CylinderGeometry(0.09, 0.09, 1.8, 5);
    arm.rotateZ(Math.PI / 2);
    arm.translate(0.9, 8, 0);
    const head = new THREE.BoxGeometry(0.6, 0.2, 0.3);
    head.translate(1.8, 7.9, 0);
    const lampGeo = mergeGeometries([pole, arm, head], false);
    const lamps = new THREE.InstancedMesh(lampGeo, this.materials.rail, Math.max(1, this._lampTransforms.length));
    this._lampTransforms.forEach((m, i) => lamps.setMatrixAt(i, m));
    lamps.instanceMatrix.needsUpdate = true;
    lamps.castShadow = true;
    this.scene.add(lamps);
    this.lampInstances = this._lampTransforms.length;
  }
}
