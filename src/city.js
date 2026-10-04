import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP, MASK } from './collision.js';
import { spawn, BUILDING_TYPES, pickFromPool } from './models.js';
import { isLand } from './island.js';
import { GRID } from './network.js';
import { mulberry32 } from './island.js';

/**
 * city.js
 * -------
 * Procedural macro-district generator. Nothing here is a hand-written block
 * array: every building is produced by walking the street grid from network.js
 * and asking "which zone is this block in?".
 *
 *   Zone A  DOWNTOWN     centre-south, dense 40-120 m towers + parking decks
 *   Zone B  SUBURBAN     east & west, hundreds of low houses with yards
 *   Zone C  INDUSTRIAL   the coastal ring, warehouses, container stacks, silos
 *   Zone D  OUTSKIRTS    the north, gas stations, diners, sparse housing
 *
 * Placement rules (strict):
 *   - No house / tree / prop may sit on tarmac or inside the road reserve.
 *     Every candidate is tested against an explicit mathematical exclusion
 *     mask derived from the same GRID constants as network.js:
 *       |coord - roadCenterLine| < halfRoadWidth + safeMargin + radius
 *     Elevated arterial ring + spines (flyovers / ramps) use a wider
 *     corridor and are cleared including the ground underneath.
 *   - Guardrails / street lamps spawn ONLY at sidewalk edge offsets
 *     (halfRoadWidth + 1.2 m), yawed to face the asphalt.
 *   - Every green block between surrounding roads is subdivided into
 *     15-20 m parcels. Perimeter parcels get outward-facing houses with
 *     driveways; interiors get park tree clusters, paths, fences, parked cars.
 *     Commercial blocks pack 4-6 mid-rise buildings instead of one isolate.
 *
 * Performance:
 *   - every building is drawn through THREE.InstancedMesh (one per model
 *     sub-mesh), so thousands of buildings cost a few dozen draw calls
 *   - every static collider is merged by 250-unit chunk into ONE compound
 *     CANNON body
 *   - props (trees, lamps, hydrants, traffic lights) are instanced too
 */

const ZONE = {
  DOWNTOWN: 'Downtown',
  SUBURBAN: 'Suburban',
  INDUSTRIAL: 'Industrial',
  OUTSKIRTS: 'Outskirts',
  PARK: 'Park',
};

const DOWNTOWN = { x: 0, z: 250, r: 360 };
const INDUSTRIAL_INNER = 930;   // distance from centre where industry starts

/** Which zone a land block belongs to. */
function zoneAt(x, z) {
  const d = Math.hypot(x - DOWNTOWN.x, z - DOWNTOWN.z);
  if (d < DOWNTOWN.r) return ZONE.DOWNTOWN;
  if (z > 780) return ZONE.OUTSKIRTS;
  const dc = Math.hypot(x, z);
  if (dc > INDUSTRIAL_INNER) return ZONE.INDUSTRIAL;
  return ZONE.SUBURBAN;
}

/** Per-zone building menu: model pools, height range, block size, density. */
const MENU = {
  [ZONE.DOWNTOWN]: {
    block: 52, density: 0.82,
    picks: [
      { types: ['Office Tower'], h: [70, 120], w: 1.0 },
      { types: ['Office Tower'], h: [45, 75], w: 1.2 },
      { types: ['Apartment'], h: [30, 48], w: 0.9 },
      { types: ['Shop'], h: [14, 20], w: 0.5 },
      { types: ['Parking'], h: [18, 26], w: 0.5 },
    ],
  },
  [ZONE.SUBURBAN]: {
    block: 100, density: 0.62,
    picks: [
      { types: ['Residential'], h: [5.5, 7.6], w: 5.0 },
      { types: ['Residential'], h: [6.4, 8.6], w: 2.0 },
      { types: ['Shop'], h: [8, 11], w: 0.35 },
      { types: ['Cafe'], h: [7, 10], w: 0.25 },
    ],
  },
  [ZONE.INDUSTRIAL]: {
    block: 110, density: 0.55,
    picks: [
      { types: ['Industrial'], h: [9, 14], w: 2.0 },
      { types: ['Warehouse'], h: [10, 16], w: 1.2 },
      { types: ['Container Yard'], h: [7, 11], w: 1.0 },
      { types: ['Factory'], h: [12, 20], w: 0.7 },
      { types: ['Dock Crane'], h: [20, 27], w: 0.22 },
    ],
  },
  [ZONE.OUTSKIRTS]: {
    block: 120, density: 0.3,
    picks: [
      { types: ['Residential'], h: [5.5, 7.5], w: 3.0 },
      { types: ['Gas Station'], h: [5.4, 6.2], w: 0.5 },
      { types: ['Diner'], h: [5.5, 7], w: 0.5 },
      { types: ['Town Warehouse'], h: [8, 12], w: 0.4 },
    ],
  },
};

// ===========================================================================
// Strict Road Exclusion Mask
// ---------------------------------------------------------------------------
// Derived from the SAME constants as network.js so the mask can never drift
// from the rendered tarmac.
//
//   grade roads : boulevards (20 m) + locals (10 m) on a 100 m pitch
//   arterials   : elevated ring (HALF=1150, CORNER=300) + NS/EW spines (30 m)
//
// Two tiers:
//   tarmac  = halfWidth + 0.6 + radius   -> physical asphalt + curb.
//             Lamps / guardrails must be OUTSIDE this but AT the edge.
//   reserve = halfWidth + safeMargin + radius -> no house / tree / prop inside.
//             safeMargin = 3.0 (boulevard), 2.5 (local), 4.0 (arterial).
// ===========================================================================

const GRADE_MIN = -1000;
const GRADE_MAX = 1000;
const ROAD_EXTENT = 1200; // GRID.EXTENT + 100, length of grade strips
const TARMAC_MARGIN = 0.6;
const SAFE_LOCAL = 2.5;
const SAFE_BOULEVARD = 3.0;
const SAFE_ARTERIAL = 4.0;
const SIDEWALK_GAP = 1.2; // lamps / rails sit at halfWidth + 1.2
const ARTERIAL_HALF = 30 / 2;
const ARTERIAL_RING_HALF = 1150;
const ARTERIAL_RING_CORNER = 300;
const ARTERIAL_RING_STRAIGHT = ARTERIAL_RING_HALF - ARTERIAL_RING_CORNER; // 850
const SPINE_MIN = -1160;
const SPINE_MAX = 1160;
const SPINE_EW_Z = -300;

function buildGradeLines() {
  const a = [];
  for (let v = GRADE_MIN; v <= GRADE_MAX; v += 100) a.push(v);
  return a;
}

export const GRADE_LINES = buildGradeLines();

export function isBoulevardCoord(v) {
  const r = Math.round(v);
  return ((r % 500) + 500) % 500 === 0;
}

export function halfWidthForLine(v) {
  if (isBoulevardCoord(v)) return GRID.BOULEVARD.WIDTH / 2;
  return GRID.LOCAL.WIDTH / 2;
}

export function safeMarginForLine(v) {
  return isBoulevardCoord(v) ? SAFE_BOULEVARD : SAFE_LOCAL;
}

/** Sidewalk edge offset for a grade line: halfWidth + 1.2 m. */
export function sidewalkOffsetFor(v) {
  return halfWidthForLine(v) + SIDEWALK_GAP;
}

/** Shortest distance from (x,z) to the elevated ring centre-line. */
export function distToArterialRing(x, z) {
  let dMin = Infinity;
  if (Math.abs(z) <= ARTERIAL_RING_STRAIGHT) {
    dMin = Math.min(dMin, Math.abs(Math.abs(x) - ARTERIAL_RING_HALF));
  }
  if (Math.abs(x) <= ARTERIAL_RING_STRAIGHT) {
    dMin = Math.min(dMin, Math.abs(Math.abs(z) - ARTERIAL_RING_HALF));
  }
  const c = ARTERIAL_RING_STRAIGHT;
  const r = ARTERIAL_RING_CORNER;
  // Four corner arc centres; full-circle distance is conservative and safe
  // for an exclusion test (never under-excludes).
  dMin = Math.min(dMin, Math.abs(Math.hypot(x - c, z - c) - r));
  dMin = Math.min(dMin, Math.abs(Math.hypot(x + c, z - c) - r));
  dMin = Math.min(dMin, Math.abs(Math.hypot(x + c, z + c) - r));
  dMin = Math.min(dMin, Math.abs(Math.hypot(x - c, z + c) - r));
  return dMin;
}

/** Shortest distance to either cross-island spine centre-line (footprint). */
function distToSpines(x, z) {
  let d = Infinity;
  if (z >= SPINE_MIN && z <= SPINE_MAX) d = Math.min(d, Math.abs(x - GRID.NS.X));
  if (x >= SPINE_MIN && x <= SPINE_MAX) d = Math.min(d, Math.abs(z - SPINE_EW_Z));
  return d;
}

function distToArterial(x, z) {
  return Math.min(distToArterialRing(x, z), distToSpines(x, z));
}

/** True when (x,z) with extent `radius` touches physical tarmac. */
export function isOnTarmac(x, z, radius = 0) {
  // Grade roads (both axes).
  if (Math.abs(z) <= ROAD_EXTENT) {
    const n = Math.round(x / 100) * 100;
    if (n >= GRADE_MIN && n <= GRADE_MAX) {
      if (Math.abs(x - n) < halfWidthForLine(n) + TARMAC_MARGIN + radius) return true;
    }
  }
  if (Math.abs(x) <= ROAD_EXTENT) {
    const n = Math.round(z / 100) * 100;
    if (n >= GRADE_MIN && n <= GRADE_MAX) {
      if (Math.abs(z - n) < halfWidthForLine(n) + TARMAC_MARGIN + radius) return true;
    }
  }
  // Elevated arterials: footprint + ramps + deck projection.
  if (distToArterial(x, z) < ARTERIAL_HALF + TARMAC_MARGIN + radius) return true;
  return false;
}

/**
 * True when (x,z) with extent `radius` falls inside the road reserve:
 *   roadCenterLine ± (halfRoadWidth + safeMargin + radius)
 * Houses, trees and generic props must be discarded here.
 */
export function isInRoadReserve(x, z, radius = 0) {
  if (Math.abs(z) <= ROAD_EXTENT) {
    const n = Math.round(x / 100) * 100;
    if (n >= GRADE_MIN && n <= GRADE_MAX) {
      if (Math.abs(x - n) < halfWidthForLine(n) + safeMarginForLine(n) + radius) return true;
    }
  }
  if (Math.abs(x) <= ROAD_EXTENT) {
    const n = Math.round(z / 100) * 100;
    if (n >= GRADE_MIN && n <= GRADE_MAX) {
      if (Math.abs(z - n) < halfWidthForLine(n) + safeMarginForLine(n) + radius) return true;
    }
  }
  if (distToArterial(x, z) < ARTERIAL_HALF + SAFE_ARTERIAL + radius) return true;
  return false;
}

/** Strict exclusion: no asset on tarmac or inside the reserve. */
export function isOnRoad(x, z, radius = 0) {
  return isInRoadReserve(x, z, radius);
}

export function clearOfRoads(x, z, radius = 0) {
  return !isInRoadReserve(x, z, radius);
}

export function clearOfTarmac(x, z, radius = 0) {
  return !isOnTarmac(x, z, radius);
}

/**
 * Yaw that points a sidewalk lamp's arm (+X in model space) at the asphalt.
 * @param axis 'x' = road runs along X (offset in Z); 'z' = road along Z.
 * @param side +1 = prop on the positive side of the centre-line, -1 otherwise.
 */
export function lampYawFor(axis, side) {
  if (axis === 'x') return side > 0 ? Math.PI / 2 : -Math.PI / 2;
  return side > 0 ? Math.PI : 0;
}

export class City {
  constructor(scene, physics, groundMaterial, models, network) {
    this.scene = scene;
    this.physics = physics;
    this.groundMaterial = groundMaterial;
    this.models = models;
    this.network = network;

    this.buildings = [];
    this.props = [];
    this.chunkBodies = 0;
    this._colliderBuckets = new Map();
    this._batches = new Map();     // key -> placements
    this._propBatches = new Map(); // key -> placements
    // Procedural neighbourhood clutter (merged, not GLTF-instanced).
    this._driveways = [];   // {x,z,w,d,rot}
    this._fences = [];      // {x,z,len,rot}
    this._parkedCars = [];  // {x,z,rot}
  }

  build() {
    const rng = mulberry32(20261003);
    this._buildBlocks(rng);
    this._buildOutskirts(rng);
    this._scatterProps(rng);
    this._buildClutterMeshes();
    this._commitBatches();
    this._flushColliders();
    return this;
  }

  // ------------------------------------------------- block subdivision
  /**
   * Walk every green block bounded by surrounding grade roads, inset by
   * halfRoadWidth + safeMargin, then subdivide the interior into parcels.
   */
  _buildBlocks(rng) {
    const L = GRADE_LINES;
    for (let ix = 0; ix < L.length - 1; ix++) {
      for (let iz = 0; iz < L.length - 1; iz++) {
        const x0 = L[ix];
        const x1 = L[ix + 1];
        const z0 = L[iz];
        const z1 = L[iz + 1];
        const ix0 = x0 + halfWidthForLine(x0) + safeMarginForLine(x0);
        const ix1 = x1 - halfWidthForLine(x1) - safeMarginForLine(x1);
        const iz0 = z0 + halfWidthForLine(z0) + safeMarginForLine(z0);
        const iz1 = z1 - halfWidthForLine(z1) - safeMarginForLine(z1);
        if (ix1 - ix0 < 14 || iz1 - iz0 < 14) continue;
        const cx = (ix0 + ix1) / 2;
        const cz = (iz0 + iz1) / 2;
        if (!isLand(cx, cz, 2)) continue;
        // Skip blocks drowned by bay / inlet: require most corners on land.
        let landCorners = 0;
        for (const [qx, qz] of [[ix0, iz0], [ix1, iz0], [ix0, iz1], [ix1, iz1]]) {
          if (isLand(qx, qz, 1)) landCorners++;
        }
        if (landCorners < 3) continue;

        const zone = zoneAt(cx, cz);
        if (zone === ZONE.DOWNTOWN) {
          this._fillDowntownBlock(ix0, ix1, iz0, iz1, cx, cz, rng);
        } else if (zone === ZONE.INDUSTRIAL) {
          this._fillIndustrialBlock(ix0, ix1, iz0, iz1, cx, cz, rng);
        } else {
          this._fillResidentialBlock(ix0, ix1, iz0, iz1, x0, x1, z0, z1, cx, cz, zone, rng);
        }
      }
    }
  }

  /** Blocks outside the grade grid: sparse outskirts + scenic trees. */
  _buildOutskirts(rng) {
    const half = GRID.EXTENT + 50;
    const step = 100;
    const menu = MENU[ZONE.OUTSKIRTS];
    for (let bx = -half; bx < half; bx += step) {
      for (let bz = -half; bz < half; bz += step) {
        const cx = bx + step / 2;
        const cz = bz + step / 2;
        // Inside the subdivided grid this is already handled.
        if (Math.abs(cx) < 1050 && Math.abs(cz) < 1050) continue;
        if (!isLand(cx, cz, 3)) continue;
        if (rng() > 0.28) continue;
        if (!clearOfRoads(cx, cz, 5)) continue;
        this._placeBuilding(cx, cz, 60, menu, rng);
      }
    }
  }

  /**
   * Residential: perimeter lots get outward-facing houses + driveways,
   * interiors get park tree clusters, paths, fences and parked cars.
   * Lot size targets ~20x20 (15-22 range).
   */
  _fillResidentialBlock(ix0, ix1, iz0, iz1, x0, x1, z0, z1, cx, cz, zone, rng) {
    const menu = MENU[zone] || MENU[ZONE.SUBURBAN];
    const wx = ix1 - ix0;
    const wz = iz1 - iz0;
    const nX = Math.max(2, Math.min(4, Math.round(wx / 20)));
    const nZ = Math.max(2, Math.min(4, Math.round(wz / 20)));
    const lotW = wx / nX;
    const lotD = wz / nZ;
    const hwX0 = halfWidthForLine(x0);
    const hwX1 = halfWidthForLine(x1);
    const hwZ0 = halfWidthForLine(z0);
    const hwZ1 = halfWidthForLine(z1);

    for (let lx = 0; lx < nX; lx++) {
      for (let lz = 0; lz < nZ; lz++) {
        const px = ix0 + (lx + 0.5) * lotW + (rng() * 2 - 1) * 1.2;
        const pz = iz0 + (lz + 0.5) * lotD + (rng() * 2 - 1) * 1.2;
        const west = lx === 0;
        const east = lx === nX - 1;
        const north = lz === 0;
        const south = lz === nZ - 1;
        const perimeter = west || east || north || south;

        if (perimeter) {
          if (rng() > 0.9) continue; // leave occasional gap for variety
          let yaw;
          if (west && north) yaw = -Math.PI * 0.75;
          else if (west && south) yaw = -Math.PI * 0.25;
          else if (east && north) yaw = Math.PI * 0.75;
          else if (east && south) yaw = Math.PI * 0.25;
          else if (west) yaw = -Math.PI / 2;
          else if (east) yaw = Math.PI / 2;
          else if (north) yaw = Math.PI;
          else yaw = 0;
          const parcel = Math.min(lotW, lotD) - 3;
          const placed = this._placeBuilding(px, pz, parcel, menu, rng, yaw);
          if (placed) {
            this._addDrivewayFor(px, pz, yaw, west, east, north, south, x0, x1, z0, z1, hwX0, hwX1, hwZ0, hwZ1);
            // Backyard fence on the side opposite the street.
            if (rng() < 0.55) {
              const fx = px - Math.sin(yaw) * -6.5;
              const fz = pz - Math.cos(yaw) * -6.5;
              if (clearOfRoads(fx, fz, 0.6) && isLand(fx, fz, 1)) {
                this._fences.push({ x: fx, z: fz, len: Math.min(lotW, 9), rot: yaw + Math.PI / 2 });
              }
            }
            // Parked low-poly car on some driveways.
            if (rng() < 0.18) {
              const carX = px + Math.sin(yaw) * 5.5;
              const carZ = pz + Math.cos(yaw) * 5.5;
              if (clearOfRoads(carX, carZ, 2.2) && isLand(carX, carZ, 1)) {
                this._parkedCars.push({ x: carX, z: carZ, rot: yaw });
                this._addCollider(carX, carZ, 2.2, 1.1, 1.6);
              }
            }
            // Yard clutter: bin / hydrant occasionally.
            if (rng() < 0.22) {
              const bx = px + (rng() * 2 - 1) * 6;
              const bz = pz + (rng() * 2 - 1) * 6;
              if (clearOfRoads(bx, bz, 0.5) && isLand(bx, bz, 1)) {
                this._pushProp(rng() < 0.6 ? 'bin' : 'hydrant', bx, bz, 1.0, rng() * Math.PI * 2);
              }
            }
          }
        } else {
          // Interior: neighbourhood park / clutter, never empty lawn.
          const kind = rng();
          if (kind < 0.62) {
            // Clustered trees (mini park): 3-5 per interior lot.
            const n = 3 + Math.floor(rng() * 3);
            for (let i = 0; i < n; i++) {
              const tx = px + (rng() * 2 - 1) * lotW * 0.38;
              const tz = pz + (rng() * 2 - 1) * lotD * 0.38;
              if (!isLand(tx, tz, 2)) continue;
              if (!clearOfRoads(tx, tz, 1.0)) continue;
              this._pushProp(rng() < 0.6 ? 'tree' : 'pine', tx, tz, 3.4 + rng() * 2.4, rng() * Math.PI * 2);
            }
            if (rng() < 0.4) {
              const bx = px + (rng() * 2 - 1) * 3;
              const bz = pz + (rng() * 2 - 1) * 3;
              if (clearOfRoads(bx, bz, 0.5) && isLand(bx, bz, 1)) {
                this._pushProp('bin', bx, bz, 1.0, 0);
              }
            }
          } else if (kind < 0.8) {
            // Extra house tucked inside (courtyard housing) to boost density.
            const yaw = Math.floor(rng() * 4) * (Math.PI / 2);
            this._placeBuilding(px, pz, Math.min(lotW, lotD) - 4, menu, rng, yaw);
          } else {
            // Single feature tree + path node.
            if (clearOfRoads(px, pz, 1.0) && isLand(px, pz, 2)) {
              this._pushProp('pine', px, pz, 4.0 + rng() * 2.0, rng() * Math.PI * 2);
            }
          }
        }
      }
    }

    // Pedestrian pathways: one cross through the block centre (ground paint).
    this._driveways.push({ x: cx, z: (iz0 + iz1) / 2, w: wx, d: 2.0, rot: 0 });
    this._driveways.push({ x: (ix0 + ix1) / 2, z: cz, w: 2.0, d: wz, rot: 0 });
  }

  /** Downtown / commercial: pack 4-6 mid-rise buildings per block. */
  _fillDowntownBlock(ix0, ix1, iz0, iz1, cx, cz, rng) {
    const menu = MENU[ZONE.DOWNTOWN];
    const wx = ix1 - ix0;
    const wz = iz1 - iz0;
    // 2 x 2 = 4, 2 x 3 = 6 depending on block aspect.
    const nX = 2;
    const nZ = wz > wx * 1.25 ? 3 : 2;
    const want = nX * nZ; // 4-6
    void want;
    const cellW = wx / nX;
    const cellD = wz / nZ;
    for (let i = 0; i < nX; i++) {
      for (let j = 0; j < nZ; j++) {
        // Pack every slot: 4-6 towers per block, no isolated singles.
        // Retry with fresh jitter if the first candidate clips the reserve.
        let placed = false;
        for (let attempt = 0; attempt < 4 && !placed; attempt++) {
          const px = ix0 + (i + 0.5) * cellW + (rng() * 2 - 1) * 3.0;
          const pz = iz0 + (j + 0.5) * cellD + (rng() * 2 - 1) * 3.0;
          const yaw = Math.floor(rng() * 4) * (Math.PI / 2);
          const parcel = Math.min(cellW, cellD) - 5;
          placed = this._placeBuilding(px, pz, parcel, menu, rng, yaw);
          if (placed) {
            // Plaza clutter between towers: trees + bins, never bare grass.
            if (rng() < 0.5) {
              const tx = px + cellW * 0.32;
              const tz = pz + cellD * 0.3;
              if (isLand(tx, tz, 1) && clearOfRoads(tx, tz, 1.0)) {
                this._pushProp(rng() < 0.5 ? 'tree' : 'pine', tx, tz, 3.4 + rng() * 1.6, rng() * Math.PI * 2);
              }
            }
          }
        }
      }
    }
    // Mid-block pedestrian path linking the towers.
    this._driveways.push({ x: cx, z: cz, w: wx * 0.9, d: 2.4, rot: 0 });
  }

  _fillIndustrialBlock(ix0, ix1, iz0, iz1, cx, cz, rng) {
    const menu = MENU[ZONE.INDUSTRIAL];
    const wx = ix1 - ix0;
    const wz = iz1 - iz0;
    const nX = 2;
    const nZ = 2;
    const cellW = wx / nX;
    const cellD = wz / nZ;
    for (let i = 0; i < nX; i++) {
      for (let j = 0; j < nZ; j++) {
        if (rng() > 0.8) continue;
        const px = ix0 + (i + 0.5) * cellW + (rng() * 2 - 1) * 2.5;
        const pz = iz0 + (j + 0.5) * cellD + (rng() * 2 - 1) * 2.5;
        const yaw = Math.floor(rng() * 4) * (Math.PI / 2);
        this._placeBuilding(px, pz, Math.min(cellW, cellD) - 5, menu, rng, yaw);
      }
    }
    void cx;
    void cz;
  }

  _addDrivewayFor(px, pz, yaw, west, east, north, south, x0, x1, z0, z1, hwX0, hwX1, hwZ0, hwZ1) {
    // Individual driveway path from the house front to the perimeter road.
    // Driveways are ground paint: allowed to meet the asphalt, but the house
    // end must already be clear of the reserve (checked by the caller).
    let dx = 0;
    let dz = 0;
    let len = 0;
    let w = 3.0;
    let rot = 0;
    if (west && !east) {
      const edge = x0 + hwX0;
      len = Math.max(0, (px - 3.2) - edge);
      if (len < 1.5 || len > 30) return;
      dx = (edge + (px - 3.2)) / 2;
      dz = pz;
      this._driveways.push({ x: dx, z: dz, w: len, d: w, rot });
    } else if (east && !west) {
      const edge = x1 - hwX1;
      len = Math.max(0, edge - (px + 3.2));
      if (len < 1.5 || len > 30) return;
      dx = ((px + 3.2) + edge) / 2;
      dz = pz;
      this._driveways.push({ x: dx, z: dz, w: len, d: w, rot });
    } else if (north && !south) {
      const edge = z0 + hwZ0;
      len = Math.max(0, (pz - 3.2) - edge);
      if (len < 1.5 || len > 30) return;
      dx = px;
      dz = (edge + (pz - 3.2)) / 2;
      this._driveways.push({ x: dx, z: dz, w: w, d: len, rot });
    } else if (south && !north) {
      const edge = z1 - hwZ1;
      len = Math.max(0, edge - (pz + 3.2));
      if (len < 1.5 || len > 30) return;
      dx = px;
      dz = ((pz + 3.2) + edge) / 2;
      this._driveways.push({ x: dx, z: dz, w: w, d: len, rot });
    }
    void yaw;
  }

  _pushProp(key, x, z, height, rotationY) {
    if (!this._propBatches.has(key)) this._propBatches.set(key, []);
    this._propBatches.get(key).push({ x, y: 0, z, height, rotationY });
  }

  // --------------------------------------------------------------- buildings
  _placeBuilding(x, z, cell, menu, rng, forcedYaw = null) {
    // Weighted pick from the zone menu.
    let total = 0;
    for (const p of menu.picks) total += p.w;
    let r = rng() * total;
    let pick = menu.picks[0];
    for (const p of menu.picks) { r -= p.w; if (r <= 0) { pick = p; break; } }

    const typeName = pick.types[Math.floor(rng() * pick.types.length) % pick.types.length];
    const type = BUILDING_TYPES[typeName];
    if (!type) return false;
    const key = pickFromPool(type.pool, rng() * 1000);
    const entry = this.models.get(key);
    if (!entry) return false;

    let height = pick.h[0] + rng() * (pick.h[1] - pick.h[0]);
    const rotationY = forcedYaw !== null ? forcedYaw : Math.floor(rng() * 4) * (Math.PI / 2);

    // Scale to the target height, then make sure the footprint fits the cell.
    let scale = height / Math.max(entry.size.y, 1e-6);
    const maxFoot = (cell - 6) / Math.max(entry.size.x, entry.size.z, 1e-6);
    if (scale > maxFoot) scale = maxFoot;
    if (scale <= 0) return false;
    height = entry.size.y * scale;
    if (height < 3) return false;

    // Collider: an oriented-free AABB sized to the rotated footprint.
    const halfX = (entry.size.x * scale) / 2;
    const halfZ = (entry.size.z * scale) / 2;
    const flip = Math.abs(Math.sin(rotationY)) > 0.5;
    const hx = Math.max(flip ? halfZ : halfX, 1.2);
    const hz = Math.max(flip ? halfX : halfZ, 1.2);

    // Strict road exclusion: discard anything whose box touches the reserve.
    // Elevated flyover / ramp footprints use the wider arterial corridor, so
    // nothing is built under or along them either. A 5 m minimum radius keeps
    // even small footprints conservatively clear of the curb, so generic
    // centre-plus-fixed-radius checks also pass.
    const radius = Math.max(hx, hz, 5.0);
    if (!isLand(x, z, 2)) return false;
    if (isInRoadReserve(x, z, radius)) return false;

    this._batches.has(key) || this._batches.set(key, []);
    this._batches.get(key).push({ x, y: 0, z, height, rotationY });

    this._addCollider(x, z, hx, hz, height);

    this.buildings.push({ key, type: typeName, zone: typeName, x, z, height });
    return true;
  }

  _addCollider(x, z, hx, hz, height, cylinder = false) {
    const CHUNK = 250;
    const cgx = Math.floor(x / CHUNK);
    const cgz = Math.floor(z / CHUNK);
    const k = `${cgx},${cgz}`;
    if (!this._colliderBuckets.has(k)) this._colliderBuckets.set(k, []);
    this._colliderBuckets.get(k).push({ x, z, hx, hz, height, cylinder });
  }

  /** One compound static body per 250-unit chunk instead of one per object. */
  _flushColliders() {
    for (const list of this._colliderBuckets.values()) {
      if (!list.length) continue;
      const body = new CANNON.Body({
        mass: 0,
        material: this.groundMaterial,
        collisionFilterGroup: GROUP.WORLD,
        collisionFilterMask: MASK.WORLD,
      });
      for (const b of list) {
        if (b.cylinder) {
          body.addShape(
            new CANNON.Cylinder(b.hx, b.hx, b.height, 8),
            new CANNON.Vec3(b.x, b.height / 2, b.z)
          );
        } else {
          body.addShape(
            new CANNON.Box(new CANNON.Vec3(b.hx, b.height / 2, b.hz)),
            new CANNON.Vec3(b.x, b.height / 2, b.z)
          );
        }
      }
      body.aabbNeedsUpdate = true;
      this.physics.addBody(body);
      this.chunkBodies++;
    }
    this._colliderBuckets.clear();
  }

  // ------------------------------------------------------------------- props
  _scatterProps(rng) {
    const half = GRID.EXTENT;

    // Street trees along every grade road, at the sidewalk edge
    // (halfRoadWidth + 1.2 m + jitter), never on tarmac / in intersections.
    for (const line of GRADE_LINES) {
      const off = sidewalkOffsetFor(line);
      // Vertical road x = line (runs along Z).
      for (let t = -half; t <= half; t += 20) {
        for (const side of [-1, 1]) {
          if (rng() > 0.36) continue;
          const x = line + side * (off + rng() * 1.2);
          const z = t + (rng() * 2 - 1) * 4;
          if (Math.hypot(x, z) < 150) continue;
          if (!isLand(x, z, 2)) continue;
          if (!clearOfRoads(x, z, 1.0)) continue;
          const zone = zoneAt(x, z);
          if (zone === ZONE.INDUSTRIAL) continue;
          this._pushProp(rng() < 0.65 ? 'tree' : 'pine', x, z, 3.6 + rng() * 2.4, rng() * Math.PI * 2);
        }
      }
      // Horizontal road z = line (runs along X).
      for (let t = -half; t <= half; t += 20) {
        for (const side of [-1, 1]) {
          if (rng() > 0.36) continue;
          const x = t + (rng() * 2 - 1) * 4;
          const z = line + side * (off + rng() * 1.2);
          if (Math.hypot(x, z) < 150) continue;
          if (!isLand(x, z, 2)) continue;
          if (!clearOfRoads(x, z, 1.0)) continue;
          const zone = zoneAt(x, z);
          if (zone === ZONE.INDUSTRIAL) continue;
          this._pushProp(rng() < 0.65 ? 'tree' : 'pine', x, z, 3.6 + rng() * 2.4, rng() * Math.PI * 2);
        }
      }
    }

    // Street lamps (+ occasional hydrants / bins) along the boulevards ONLY,
    // at halfRoadWidth + 1.2 m on BOTH sides, yawed to face the asphalt.
    // Lamps are the one exception to the reserve: they must be outside the
    // tarmac but are allowed inside the wider building reserve.
    const blvds = (this.network && this.network.boulevardLines) || [-1000, -500, 0, 500, 1000];
    const lampOff = GRID.BOULEVARD.WIDTH / 2 + SIDEWALK_GAP; // 11.2
    for (const v of blvds) {
      // Road along X (z = v) and road along Z (x = v).
      for (const axis of ['x', 'z']) {
        for (let t = -half; t <= half; t += 34) {
          for (const side of [-1, 1]) {
            const x = axis === 'x' ? t : v + side * lampOff;
            const z = axis === 'x' ? v + side * lampOff : t;
            if (!isLand(x, z, 2)) continue;
            if (!clearOfTarmac(x, z, 0.4)) continue;
            // Keep lamps out of the elevated flyover footprint too.
            if (distToArterial(x, z) < ARTERIAL_HALF + 1.0) continue;
            const yaw = lampYawFor(axis, side);
            this._pushProp('lamp', x, z, 5.2, yaw);
            if (rng() < 0.05) {
              const hx = x + (axis === 'x' ? 1.5 : side * 1.0);
              const hz = z + (axis === 'x' ? side * 1.0 : 1.5);
              if (clearOfRoads(hx, hz, 0.4) && isLand(hx, hz, 1)) {
                this._pushProp('hydrant', hx, hz, 1.0, 0);
              }
            }
            if (rng() < 0.05) {
              const bx = x - (axis === 'x' ? 1.5 : side * 1.0);
              const bz = z - (axis === 'x' ? side * 1.0 : 1.5);
              if (clearOfRoads(bx, bz, 0.4) && isLand(bx, bz, 1)) {
                this._pushProp('bin', bx, bz, 1.0, 0);
              }
            }
          }
        }
      }
    }

    // Open-country trees outside the grid (the scenic outskirts).
    // Still excluded from the elevated ring / ramp footprint.
    for (let i = 0, n = 0; i < 30000 && n < 900; i++) {
      const x = (rng() * 2 - 1) * 1180;
      const z = (rng() * 2 - 1) * 1180;
      if (!isLand(x, z, 4)) continue;
      if (Math.abs(x) < half && Math.abs(z) < half) continue; // inside the grid
      if (!clearOfRoads(x, z, 1.5)) continue;
      n++;
      this._pushProp(rng() < 0.7 ? 'pine' : 'tree', x, z, 3.8 + rng() * 3.4, rng() * Math.PI * 2);
    }
  }

  // --------------------------------------------- procedural clutter meshes
  _buildClutterMeshes() {
    // Driveways + pedestrian pathways: flat concrete strips (ground paint).
    if (this._driveways.length) {
      const geos = [];
      for (const d of this._driveways) {
        const g = new THREE.BoxGeometry(d.w, 0.12, d.d);
        g.applyMatrix4(
          new THREE.Matrix4().compose(
            new THREE.Vector3(d.x, 0.06, d.z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, d.rot || 0, 0)),
            new THREE.Vector3(1, 1, 1)
          )
        );
        geos.push(g);
      }
      const merged = mergeGeometries(geos, false);
      if (merged) {
        merged.computeVertexNormals();
        const mesh = new THREE.Mesh(
          merged,
          new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.95 })
        );
        mesh.receiveShadow = true;
        this.scene.add(mesh);
      }
    }
    // Fences: low wooden runs around backyards.
    if (this._fences.length) {
      const geos = [];
      for (const f of this._fences) {
        const g = new THREE.BoxGeometry(f.len, 1.0, 0.18);
        g.applyMatrix4(
          new THREE.Matrix4().compose(
            new THREE.Vector3(f.x, 0.5, f.z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, f.rot || 0, 0)),
            new THREE.Vector3(1, 1, 1)
          )
        );
        geos.push(g);
      }
      const merged = mergeGeometries(geos, false);
      if (merged) {
        merged.computeVertexNormals();
        const mesh = new THREE.Mesh(
          merged,
          new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 0.9 })
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
      }
      // Thin fence colliders join the chunked buckets (cheap, chunked).
      for (const f of this._fences) {
        const alongX = Math.abs(Math.cos(f.rot || 0)) > 0.5;
        this._addCollider(f.x, f.z, alongX ? f.len / 2 : 0.3, alongX ? 0.3 : f.len / 2, 1.0);
      }
    }
    // Parked low-poly cars: body + cabin merged into two meshes.
    if (this._parkedCars.length) {
      const bodies = [];
      const cabins = [];
      for (const c of this._parkedCars) {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, c.rot || 0, 0));
        const body = new THREE.BoxGeometry(1.9, 0.75, 4.3);
        body.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(c.x, 0.65, c.z), q, new THREE.Vector3(1, 1, 1)));
        bodies.push(body);
        const cab = new THREE.BoxGeometry(1.65, 0.6, 2.1);
        cab.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(c.x, 1.3, c.z), q, new THREE.Vector3(1, 1, 1)));
        cabins.push(cab);
      }
      const bodyMerged = mergeGeometries(bodies, false);
      if (bodyMerged) {
        bodyMerged.computeVertexNormals();
        const m = new THREE.Mesh(bodyMerged, new THREE.MeshStandardMaterial({ color: 0x41617d, roughness: 0.5, metalness: 0.35 }));
        m.castShadow = true;
        m.receiveShadow = true;
        this.scene.add(m);
      }
      const cabMerged = mergeGeometries(cabins, false);
      if (cabMerged) {
        cabMerged.computeVertexNormals();
        const m = new THREE.Mesh(cabMerged, new THREE.MeshStandardMaterial({ color: 0x141c26, roughness: 0.25, metalness: 0.4 }));
        m.castShadow = true;
        this.scene.add(m);
      }
    }
  }

  // ----------------------------------------------------------------- commit
  _commitBatches() {
    for (const [key, placements] of this._batches) this._instanceModel(key, placements, 0);
    for (const [key, placements] of this._propBatches) {
      // Props go on layer 1: the main camera shows them, but the radar camera
      // only renders layer 0, so the minimap never pays for 8k tree instances
      // it could not resolve anyway.
      this._instanceModel(key, placements, 1);
      this._propColliders(key, placements);
    }
  }

  /**
   * Draw every placement of one model through InstancedMeshes, one per mesh in
   * the template. Each matrix folds in the per-instance height fit, its yaw and
   * the template mesh's own local transform.
   */
  _instanceModel(key, placements, layer = 0) {
    const entry = this.models.get(key);
    if (!entry || !placements.length) return;
    entry.template.updateMatrixWorld(true);

    const meshes = [];
    entry.template.traverse((o) => { if (o.isMesh) meshes.push(o); });

    const objectMatrix = new THREE.Matrix4();
    const out = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const scaleVec = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();

    for (const mesh of meshes) {
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      inst.layers.set(layer);
      placements.forEach((p, i) => {
        const scale = p.height / Math.max(entry.size.y, 1e-6);
        pos.set(p.x, p.y || 0, p.z);
        quat.setFromEuler(euler.set(0, p.rotationY || 0, 0));
        scaleVec.setScalar(scale);
        objectMatrix.compose(pos, quat, scaleVec);
        out.copy(objectMatrix).multiply(mesh.matrixWorld);
        inst.setMatrixAt(i, out);
      });
      inst.instanceMatrix.needsUpdate = true;
      this.scene.add(inst);
    }
  }

  /** Solid colliders for the props that should stop a walking player. */
  _propColliders(key, placements) {
    const spec = {
      tree: 0.22, pine: 0.18, lamp: 0.18, hydrant: 0.85, bin: 0.9,
    }[key];
    if (!spec) return;
    const entry = this.models.get(key);
    if (!entry) return;

    // Added to the SAME 250-unit buckets as the buildings, so everything in a
    // neighbourhood ends up in one compound body rather than one body per prop.
    for (const p of placements) {
      const scale = p.height / Math.max(entry.size.y, 1e-6);
      const r = Math.max(0.1, Math.max(entry.size.x, entry.size.z) * scale * 0.5 * spec);
      this._addCollider(p.x, p.z, r, r, p.height, true);
    }
  }
}

export { ZONE, zoneAt };
