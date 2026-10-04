import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP, MASK } from './collision.js';
import { ISLAND } from './island.js';

/**
 * highways.js
 * -----------
 * The long inter-city route that links the two hubs, all as real geometry with
 * matched colliders.
 *
 *   - one continuous multi-lane highway running north along x = AXIS_X. It is
 *     an ordinary street through the Metropolis, climbs a smooth ramp onto an
 *     elevated concrete VIADUCT, crosses a long SUSPENSION BRIDGE over the
 *     strait, then descends into the northern town.
 *   - cloverleaf-style interchanges at each end: a curved loop ramp plus a pair
 *     of diagonal on/off slip roads.
 *   - concrete parapets with real colliders down every elevated edge so a car
 *     cannot slide off unless it is rammed hard.
 *   - InstancedMesh piers, highway streetlamps and suspension cable hangers.
 *
 * Materials are deliberately the SAME dark asphalt as the ground roads (see
 * ASPHALT below, matched to roads.js) so no deck, ramp or bridge renders as a
 * bare white mesh. `concrete` is only ever used for piers, parapets and towers.
 *
 * Every driveable surface goes through `_slab`, which builds the mesh and the
 * CANNON.Box from the SAME transform, so a suspension ray can never find the
 * visible road offset from the physical one.
 */

// Matched to roads.js ASPHALT so the viaduct/bridge read as the same tarmac.
const ASPHALT = 0x343a42;
const CONCRETE = 0xada79c;
const RAIL = 0xb9bec6;
const MARKING = 0xe9e4d6;

export const HIGHWAY = {
  // North-south axis of the inter-city route (a Metropolis street centre-line).
  AXIS_X: 24,
  WIDTH: 15,
  DECK_Y: 9,
  // Ground feet of the route.
  Z_SOUTH: -360,
  Z_NORTH: 420,
  // Ramp feet and crests, and the strait the bridge spans.
  RAMP_S0: -266, RAMP_S1: -190,   // south ramp up
  RAMP_N0: 280, RAMP_N1: 356,     // north ramp down
  BRIDGE_Z0: 200, BRIDGE_Z1: 280,
  TOWER_ZS: [214, 266],
  PIER_STEP: 24,
  LAMP_STEP: 30,
  // Interchange centres, and how much of the deck parapet is left open either
  // side of one so the ramps can actually join the carriageway.
  INTERCHANGE: { SOUTH: -150, NORTH: 165, GAP: 24 },
  STRAIT: ISLAND.STRAIT,
};

const smoothstep = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Top-of-road height of the inter-city route at a given z. One continuous
 * smoothstep profile: flat, ramp up, flat viaduct, flat bridge, ramp down,
 * flat. Both ramps leave and meet the ground with ZERO slope, so nothing
 * launches or pitches the car.
 */
export function routeProfile(z) {
  const H = HIGHWAY.DECK_Y;
  const up = smoothstep(clamp01((z - HIGHWAY.RAMP_S0) / (HIGHWAY.RAMP_S1 - HIGHWAY.RAMP_S0)));
  const down = smoothstep(clamp01((z - HIGHWAY.RAMP_N0) / (HIGHWAY.RAMP_N1 - HIGHWAY.RAMP_N0)));
  return H * (up - down);
}

/** True when z is over the strait (bridge, not viaduct). */
function overWater(z) {
  const S = HIGHWAY.STRAIT;
  return z > S.z0 - 8 && z < S.z1 + 8;
}

export class HighwayNetwork {
  constructor(scene, physics, groundMaterial) {
    this.scene = scene;
    this.physics = physics;
    this.groundMaterial = groundMaterial;

    this.materials = {
      asphalt: new THREE.MeshStandardMaterial({ color: ASPHALT, roughness: 0.85, metalness: 0.02 }),
      concrete: new THREE.MeshStandardMaterial({ color: CONCRETE, roughness: 0.9, metalness: 0.0 }),
      rail: new THREE.MeshStandardMaterial({ color: RAIL, roughness: 0.5, metalness: 0.55 }),
      marking: new THREE.MeshStandardMaterial({ color: MARKING, roughness: 0.8, metalness: 0.0 }),
    };

    this._geos = { asphalt: [], concrete: [], rail: [], marking: [] };
    this._pierTransforms = [];
    this._lampTransforms = [];
    this.colliders = [];
  }

  build() {
    this._buildMainLine();
    this._buildBridgeFurniture();
    this._buildInterchange(-1);
    this._buildInterchange(1);
    this._buildStreetlamps();
    this._commitMeshes();
    this._commitInstances();
  }

  // ------------------------------------------------------------------ helpers
  /**
   * A box whose TOP FACE sits at `topY`, oriented by `quat`. Mesh and static
   * collider are built together so they can never drift apart.
   */
  _slab(x, topY, z, size, quat, material = 'asphalt') {
    const cy = topY - size[1] / 2;

    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    geo.applyMatrix4(
      new THREE.Matrix4().compose(new THREE.Vector3(x, cy, z), quat, new THREE.Vector3(1, 1, 1))
    );
    this._geos[material].push(geo);

    const body = new CANNON.Body({
      mass: 0,
      material: this.groundMaterial,
      shape: new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)),
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: MASK.WORLD,
    });
    body.position.set(x, cy, z);
    body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    body.aabbNeedsUpdate = true;
    this.physics.addBody(body);
    this.colliders.push(body);
    return body;
  }

  /** A flat painted marking lying on a slab (no collider). */
  _paint(x, y, z, w, d, yaw = 0) {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
        new THREE.Vector3(1, 1, 1)
      )
    );
    this._geos.marking.push(g);
  }

  /**
   * Orientation for a surface strip that runs from a->b (a and b are
   * {x,z,y}); local +X follows the strip and is pitched to the gradient.
   */
  _stripQuat(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dy = b.y - a.y;
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

  /** Build a run of asphalt strips through a polyline of {x,z,y} points. */
  _rampStrip(pts, width, material = 'asphalt') {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const { q, length } = this._stripQuat(a, b);
      if (length < 1e-3) continue;
      this._slab(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        (a.z + b.z) / 2,
        [length + 0.45, 1.2, width],
        q,
        material
      );
    }
  }

  /** A concrete parapet box between two {x,z,y} points, offset sideways. */
  _parapetBetween(a, b, side, offsetFromCentre) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-3) return;
    // Unit normal to the run in XZ.
    const nx = -dz / L;
    const nz = dx / L;
    const ax = a.x + nx * side * offsetFromCentre;
    const az = a.z + nz * side * offsetFromCentre;
    const bx = b.x + nx * side * offsetFromCentre;
    const bz = b.z + nz * side * offsetFromCentre;
    const p0 = { x: ax, z: az, y: a.y };
    const p1 = { x: bx, z: bz, y: b.y };
    const { q, length } = this._stripQuat(p0, p1);
    // 0.9 m tall wall whose BASE sits on the deck surface. Pitched with the run
    // so ramp parapets follow the incline instead of stepping.
    this._slab(
      (ax + bx) / 2,
      (a.y + b.y) / 2 + 0.9,
      (az + bz) / 2,
      [length + 0.4, 0.9, 0.4],
      q,
      'concrete'
    );
  }

  // ------------------------------------------------------------- main line
  _buildMainLine() {
    const X = HIGHWAY.AXIS_X;
    const W = HIGHWAY.WIDTH;
    const H = HIGHWAY.DECK_Y;
    const half = W / 2;

    // ---- flat approach + ramps ------------------------------------------
    const RAMP_SEG = 14;
    const rampPts = (z0, z1) => {
      const pts = [];
      for (let i = 0; i <= RAMP_SEG; i++) {
        const z = z0 + (i / RAMP_SEG) * (z1 - z0);
        pts.push({ x: X, z, y: routeProfile(z) });
      }
      return pts;
    };

    // South approach (street level).
    this._slab(X, 0.02, (HIGHWAY.Z_SOUTH + HIGHWAY.RAMP_S0) / 2, [W, 1.2, HIGHWAY.RAMP_S0 - HIGHWAY.Z_SOUTH], new THREE.Quaternion());
    // North approach.
    this._slab(X, 0.02, (HIGHWAY.RAMP_N1 + HIGHWAY.Z_NORTH) / 2, [W, 1.2, HIGHWAY.Z_NORTH - HIGHWAY.RAMP_N1], new THREE.Quaternion());

    // Ramps (segmented so the smoothstep stays smooth in physics too).
    const southRamp = rampPts(HIGHWAY.RAMP_S0, HIGHWAY.RAMP_S1);
    const northRamp = rampPts(HIGHWAY.RAMP_N1, HIGHWAY.RAMP_N0);
    this._rampStrip(southRamp, W);
    this._rampStrip(northRamp, W);

    // ---- elevated viaduct + bridge deck ---------------------------------
    const deckZ0 = HIGHWAY.RAMP_S1;
    const deckZ1 = HIGHWAY.RAMP_N0;
    const deckMid = (deckZ0 + deckZ1) / 2;
    this._slab(X, H, deckMid, [W, 1.2, deckZ1 - deckZ0], new THREE.Quaternion());

    // ---- lane markings along the whole route ----------------------------
    for (let z = HIGHWAY.Z_SOUTH + 4; z < HIGHWAY.Z_NORTH; z += 7) {
      const y = routeProfile(z) + 0.03;
      for (const dx of [-3.9, 0, 3.9]) {
        this._paint(X + dx, y, z, 0.28, 3.0);
      }
    }

    // ---- parapets down every elevated edge ------------------------------
    const off = half - 0.25;
    const parapetPts = (pts) => {
      for (let i = 0; i < pts.length - 1; i++) {
        for (const side of [-1, 1]) {
          this._parapetBetween(pts[i], pts[i + 1], side, off);
        }
      }
    };
    const flatRun = (z0, z1) => {
      const a = { x: X, z: z0, y: routeProfile(z0) };
      const b = { x: X, z: z1, y: routeProfile(z1) };
      for (const side of [-1, 1]) this._parapetBetween(a, b, side, off);
    };
    parapetPts(southRamp);
    parapetPts(northRamp);

    // Deck parapets, left OPEN either side of each interchange so the entry and
    // exit ramps can meet the carriageway instead of being walled off.
    const zcS = HIGHWAY.INTERCHANGE.SOUTH;
    const zcN = HIGHWAY.INTERCHANGE.NORTH;
    const gap = HIGHWAY.INTERCHANGE.GAP;
    for (const side of [-1, 1]) {
      for (const [a, b] of [
        [deckZ0, zcS - gap],
        [zcS + gap, zcN - gap],
        [zcN + gap, deckZ1],
      ]) {
        if (b - a > 1) flatRun(a, b);
      }
    }

    // ---- piers under everything that is off the ground ------------------
    for (let z = deckZ0 + 4; z < deckZ1; z += HIGHWAY.PIER_STEP) {
      const top = routeProfile(z) - 1.2;
      if (top < 1.2) continue;
      const bottom = overWater(z) ? -10 : 0;
      for (const dx of [-4.6, 4.6]) this._pier(X + dx, z, top, bottom);
    }
  }

  // --------------------------------------------------------------- bridge
  _buildBridgeFurniture() {
    const X = HIGHWAY.AXIS_X;
    const H = HIGHWAY.DECK_Y;
    const halfW = HIGHWAY.WIDTH / 2;

    // Two suspension towers straddling the deck, out of the carriageway.
    for (const z of HIGHWAY.TOWER_ZS) {
      for (const side of [-1, 1]) {
        const tx = X + side * (halfW + 1.6);
        // Two legs + a cross-beam, visual + collider.
        for (const lz of [-1.1, 1.1]) {
          this._slab(tx, 26, z + lz, [1.5, 35, 1.5], new THREE.Quaternion(), 'concrete');
        }
        this._slab(tx, 24, z, [1.4, 2.0, 5.0], new THREE.Quaternion(), 'concrete');
      }
    }

    // Main suspension cables: tower tops down to the deck at the bridge ends.
    const cable = (from, to) => {
      const dir = new THREE.Vector3().subVectors(to, from);
      const len = dir.length();
      const g = new THREE.CylinderGeometry(0.16, 0.16, len, 6);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      g.applyMatrix4(
        new THREE.Matrix4().compose(
          new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5),
          q,
          new THREE.Vector3(1, 1, 1)
        )
      );
      this._geos.rail.push(g);
    };
    const [t0, t1] = HIGHWAY.TOWER_ZS;
    for (const dz of [-1.1, 1.1]) {
      const topA = new THREE.Vector3(X, 26, t0 + dz);
      const topB = new THREE.Vector3(X, 26, t1 + dz);
      cable(topA, new THREE.Vector3(X, H + 0.6, HIGHWAY.BRIDGE_Z0));
      cable(topB, new THREE.Vector3(X, H + 0.6, HIGHWAY.BRIDGE_Z1));
      cable(topA, topB); // main span cable
      // Hangers from the main span down to the deck.
      for (let z = HIGHWAY.BRIDGE_Z0 + 12; z < HIGHWAY.BRIDGE_Z1; z += 12) {
        const t = (z - t0) / (t1 - t0);
        const sag = t >= 0 && t <= 1 ? 0 : 1;
        void sag;
        this._geos.rail.push(
          new THREE.CylinderGeometry(0.07, 0.07, H + 0.6 - 24 + 17, 4).applyMatrix4(
            new THREE.Matrix4().compose(
              new THREE.Vector3(X, (24 + H) / 2, z),
              new THREE.Quaternion(),
              new THREE.Vector3(1, 1, 1)
            )
          )
        );
      }
    }
  }

  // ----------------------------------------------------------- interchange
  /**
   * A partial cloverleaf interchange: a curved LOOP ramp on one side of the
   * carriageway and a diagonal slip ramp on the other.
   *
   * The ramps are laid OUTSIDE the deck edge and abut it, so their parapets
   * never cross the carriageway. The deck parapet is left open at the junction
   * (see _buildMainLine) so a car can actually get on and off.
   *
   * @param dir -1 = south end, +1 = north end
   */
  _buildInterchange(dir) {
    const X = HIGHWAY.AXIS_X;
    const H = HIGHWAY.DECK_Y;
    const edge = HIGHWAY.WIDTH / 2;
    const zc = dir < 0 ? HIGHWAY.INTERCHANGE.SOUTH : HIGHWAY.INTERCHANGE.NORTH;

    // --- curved LOOP ramp (the cloverleaf element) -----------------------
    const loopSide = dir < 0 ? -1 : 1;
    const loopHalf = 4.25;
    const R = 20;
    // Centreline starts flush with the deck edge and curves away from it.
    const startX = X + loopSide * (edge + loopHalf);
    // For the west loop the arc runs a=0..PI from cx+R down to cx-R, so the
    // centre sits R beyond the abutment; mirrored for the east loop.
    const loopCx = startX + loopSide * R;
    const a0 = loopSide < 0 ? 0 : Math.PI;
    const a1 = loopSide < 0 ? Math.PI : Math.PI * 2;
    const SEG = 16;
    const loopPts = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const a = a0 + (a1 - a0) * t;
      loopPts.push({
        x: loopCx + Math.cos(a) * R,
        z: zc + Math.sin(a) * R,
        y: H * (1 - smoothstep(t)),
      });
    }
    this._rampStrip(loopPts, loopHalf * 2);
    for (let i = 0; i < loopPts.length - 1; i++) {
      for (const side of [-1, 1]) this._parapetBetween(loopPts[i], loopPts[i + 1], side, loopHalf - 0.25);
    }

    // --- diagonal slip ramp on the other side ----------------------------
    const s = -loopSide;
    const slipHalf = 4.5;
    const startSx = X + s * (edge + slipHalf);
    const slip = [
      { x: startSx, z: zc, y: H },
      { x: X + s * 38, z: zc + dir * 7, y: H * 0.6 },
      { x: X + s * 60, z: zc + dir * 15, y: H * 0.22 },
      { x: X + s * 78, z: zc + dir * 24, y: 0 },
    ];
    this._rampStrip(slip, slipHalf * 2);
    for (let i = 0; i < slip.length - 1; i++) {
      for (const side of [-1, 1]) this._parapetBetween(slip[i], slip[i + 1], side, slipHalf - 0.25);
    }
  }

  // ----------------------------------------------------------- streetlamps
  _buildStreetlamps() {
    const X = HIGHWAY.AXIS_X;
    const halfW = HIGHWAY.WIDTH / 2;
    let side = 1;
    for (let z = HIGHWAY.Z_SOUTH + 20; z < HIGHWAY.Z_NORTH; z += HIGHWAY.LAMP_STEP) {
      const y = routeProfile(z);
      const x = X + side * (halfW + 1.1);
      this._lampTransforms.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, y, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, side > 0 ? Math.PI : 0, 0)),
          new THREE.Vector3(1, 1, 1)
        )
      );
      side = -side;
    }
  }

  _pier(x, z, topY, bottomY) {
    const h = topY - bottomY;
    if (h <= 0.3) return;
    this._pierTransforms.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, (topY + bottomY) / 2, z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, h / 2, 1)
      )
    );
    const body = new CANNON.Body({
      mass: 0,
      material: this.groundMaterial,
      shape: new CANNON.Cylinder(0.62, 0.72, h, 10),
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: MASK.WORLD,
    });
    body.position.set(x, (topY + bottomY) / 2, z);
    body.aabbNeedsUpdate = true;
    this.physics.addBody(body);
  }

  // ----------------------------------------------------------------- commit
  _commitMeshes() {
    for (const [name, geos] of Object.entries(this._geos)) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(merged, this.materials[name]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  _commitInstances() {
    // Piers.
    const pierGeo = new THREE.CylinderGeometry(0.62, 0.72, 2, 12);
    const piers = new THREE.InstancedMesh(pierGeo, this.materials.concrete, Math.max(1, this._pierTransforms.length));
    this._pierTransforms.forEach((m, i) => piers.setMatrixAt(i, m));
    piers.instanceMatrix.needsUpdate = true;
    piers.castShadow = true;
    piers.receiveShadow = true;
    this.scene.add(piers);
    this.pierInstances = this._pierTransforms.length;

    // Highway streetlamps: pole + arm + head merged into one geometry so a
    // single InstancedMesh draws them all.
    const pole = new THREE.CylinderGeometry(0.11, 0.15, 7, 8);
    pole.translate(0, 3.5, 0);
    const arm = new THREE.CylinderGeometry(0.08, 0.08, 1.6, 6);
    arm.rotateZ(Math.PI / 2);
    arm.translate(0.8, 7, 0);
    const head = new THREE.BoxGeometry(0.5, 0.18, 0.28);
    head.translate(1.6, 6.9, 0);
    const lampGeo = mergeGeometries([pole, arm, head], false);
    const lamps = new THREE.InstancedMesh(lampGeo, this.materials.rail, Math.max(1, this._lampTransforms.length));
    this._lampTransforms.forEach((m, i) => lamps.setMatrixAt(i, m));
    lamps.instanceMatrix.needsUpdate = true;
    lamps.castShadow = true;
    this.scene.add(lamps);
    this.lampInstances = this._lampTransforms.length;
  }
}
