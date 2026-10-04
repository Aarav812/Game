import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP, MASK } from './collision.js';

/**
 * roads.js
 * --------
 * The road network is real geometry, not a flat texture. Every piece is built
 * as a BufferGeometry and merged per material into a handful of meshes:
 *
 *   - straight asphalt strips along the grid
 *   - square intersection patches (offset 1 cm to avoid z-fighting)
 *   - a circular roundabout: asphalt ring + raised island + curbed planter
 *   - 90-degree curved "slip" roads that round off the outer ring corners
 *   - dashed lane markings
 *   - a raised concrete plinth per city block. Those plinths have ROUNDED
 *     corners (curved sidewalks) and a few are CHAMFERED at 45 degrees.
 *
 * The infinite physics plane still lives in world.js; these meshes are the
 * rendered road surface sitting a couple of centimetres above it.
 */

// ------------------------------------------------------------------ layout
export const LAYOUT = {
  // Road centre-lines (both axes). Blocks sit between them.
  LINES: [-120, -72, -24, 24, 72, 120],
  ROAD_W: 11,
  // Block pitch (distance between road centres).
  PITCH: 48,
  // 5x5 block centres.
  CENTRES: [-96, -48, 0, 48, 96],
  // Outer road ends are pulled in so a curved corner can join them.
  OUTER_STOP: 105,
  CORNER_RADIUS: 15,
  SLAB_SIZE: 30,
  SLAB_H: 0.12,
  FILLET: 3.5,
  CHAMFER: 7.0,
  ROUNDABOUT: { x: 24, z: 24, rOuter: 11, rInner: 4.5, island: 4.5 },
};

const ASPHALT = 0x353a41;
const SIDEWALK = 0xb8b2a6;
const MARKING = 0xe9e4d6;
const ISLAND = 0x5f8f4e;
const PLANTER = 0xc8bfae;

// -------------------------------------------------------------- primitives

/** Flat annulus sector centred at (cx, cz). Angles are world XZ radians. */
function annulusSector(cx, cz, r0, r1, a0, a1, y = 0) {
  // RingGeometry is authored in XY; rotateX(-90) maps world angle to -theta.
  const g = new THREE.RingGeometry(r0, r1, 48, 1, -a1, a1 - a0);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, cz);
  return g;
}

/** Flat rectangle lying in XZ, centred at (cx, cz), length along `axis`. */
function flatRect(cx, cz, width, length, axis, y = 0) {
  const g = new THREE.PlaneGeometry(
    axis === 'z' ? width : length,
    axis === 'z' ? length : width
  );
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, cz);
  return g;
}

/** Rounded-rectangle slab (XY shape, extruded up, base at y=0). */
function slabRounded(size, fillet, height) {
  const s = new THREE.Shape();
  const h = size / 2;
  const r = Math.min(fillet, h - 1e-3);
  s.moveTo(-h + r, -h);
  s.lineTo(h - r, -h);
  s.absarc(h - r, -h + r, r, -Math.PI / 2, 0, false);
  s.lineTo(h, h - r);
  s.absarc(h - r, h - r, r, 0, Math.PI / 2, false);
  s.lineTo(-h + r, h);
  s.absarc(-h + r, h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-h, -h + r);
  s.absarc(-h + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
  const g = new THREE.ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: 10 });
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Slab with three rounded corners and one corner cut at 45 degrees, so some
 * street corners are angled rather than curved.
 */
function slabChamfered(size, cut, radius, height) {
  const h = size / 2;
  const r = Math.min(radius, h - 1e-3, cut - 1e-3);
  const s = new THREE.Shape();

  s.moveTo(-h + r, -h);
  s.lineTo(h - r, -h);
  s.absarc(h - r, -h + r, r, -Math.PI / 2, 0, false);
  s.lineTo(h, h - cut);      // up the right side to the cut
  s.lineTo(h - cut, h);      // the 45-degree diagonal
  s.lineTo(-h + r, h);
  s.absarc(-h + r, h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-h, -h + r);
  s.absarc(-h + r, -h + r, r, Math.PI, Math.PI * 1.5, false);

  const g = new THREE.ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: 8 });
  g.rotateX(-Math.PI / 2);
  return g;
}

// ------------------------------------------------------------------ network
export class RoadNetwork {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    this.materials = {
      asphalt: new THREE.MeshStandardMaterial({ color: ASPHALT, roughness: 0.96, metalness: 0.0 }),
      sidewalk: new THREE.MeshStandardMaterial({ color: SIDEWALK, roughness: 0.92, metalness: 0.0 }),
      marking: new THREE.MeshStandardMaterial({ color: MARKING, roughness: 0.8, metalness: 0.0 }),
      island: new THREE.MeshStandardMaterial({ color: ISLAND, roughness: 1.0, metalness: 0.0 }),
      planter: new THREE.MeshStandardMaterial({ color: PLANTER, roughness: 0.9, metalness: 0.0 }),
    };
    this._groups = { asphalt: [], sidewalk: [], marking: [], island: [], planter: [] };
  }

  build() {
    this._buildStraights();
    this._buildIntersections();
    this._buildCornerCurves();
    this._buildRoundabout();
    this._buildMarkings();
    this._buildBlockSlabs();
    this._commit();
  }

  // Straight roads. The outer lines stop short so a curved corner can join them.
  _buildStraights() {
    const { LINES, ROAD_W, OUTER_STOP } = LAYOUT;
    for (const line of LINES) {
      const outer = Math.abs(line) >= 120;
      const half = outer ? OUTER_STOP : 120;
      this._groups.asphalt.push(flatRect(line, 0, ROAD_W, half * 2, 'z', 0.01)); // along Z
      this._groups.asphalt.push(flatRect(0, line, ROAD_W, half * 2, 'x', 0.01)); // along X
    }
  }

  // Slightly raised patches hide the seams where strips cross.
  _buildIntersections() {
    const { LINES, ROAD_W } = LAYOUT;
    for (const x of LINES) {
      for (const z of LINES) {
        const g = new THREE.PlaneGeometry(ROAD_W, ROAD_W);
        g.rotateX(-Math.PI / 2);
        g.translate(x, 0.02, z);
        // Skip the corner where the roundabout goes; it draws its own surface.
        const rb = LAYOUT.ROUNDABOUT;
        if (x === rb.x && z === rb.z) continue;
        this._groups.asphalt.push(g);
      }
    }
  }

  // 90-degree curved roads joining the outer ring's corners.
  _buildCornerCurves() {
    const { OUTER_STOP, CORNER_RADIUS, ROAD_W } = LAYOUT;
    const c = OUTER_STOP;
    const r0 = CORNER_RADIUS - ROAD_W / 2;
    const r1 = CORNER_RADIUS + ROAD_W / 2;
    const half = Math.PI / 2;
    // Four outer corners, each sweeping the quadrant that faces outward.
    this._groups.asphalt.push(annulusSector(c, c, r0, r1, 0, half, 0.01));
    this._groups.asphalt.push(annulusSector(-c, c, r0, r1, half, Math.PI, 0.01));
    this._groups.asphalt.push(annulusSector(-c, -c, r0, r1, Math.PI, Math.PI * 1.5, 0.01));
    this._groups.asphalt.push(annulusSector(c, -c, r0, r1, Math.PI * 1.5, Math.PI * 2, 0.01));
  }

  // Roundabout: asphalt ring, grass island, low curb planter (with a collider).
  _buildRoundabout() {
    const rb = LAYOUT.ROUNDABOUT;
    this._groups.asphalt.push(annulusSector(rb.x, rb.z, rb.rInner, rb.rOuter, 0, Math.PI * 2, 0.015));

    // Grass island disc.
    const island = new THREE.CircleGeometry(rb.island, 40);
    island.rotateX(-Math.PI / 2);
    island.translate(rb.x, 0.14, rb.z);
    this._groups.island.push(island);

    // Curb ring around the island.
    const curb = new THREE.CylinderGeometry(rb.island, rb.island + 0.15, 0.3, 40, 1, false);
    curb.translate(rb.x, 0.15, rb.z);
    this._groups.planter.push(curb);

    // Central planter + landmark tree, and a matching static collider so the
    // car cannot drive through the island.
    const planter = new THREE.CylinderGeometry(1.6, 1.9, 1.1, 24);
    planter.translate(rb.x, 0.55, rb.z);
    this._groups.planter.push(planter);

    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Cylinder(rb.island + 0.15, rb.island + 0.15, 0.32, 16),
      collisionFilterGroup: GROUP.WORLD,
      collisionFilterMask: MASK.WORLD,
    });
    body.position.set(rb.x, 0.16, rb.z);
    body.aabbNeedsUpdate = true;
    this.physics.addBody(body);
    this.islandCollider = body;
  }

  // Dashed centre lines along the straight stretches.
  _buildMarkings() {
    const { LINES, OUTER_STOP } = LAYOUT;
    const dash = 2.6;
    const gap = 3.4;
    const step = dash + gap;
    const w = 0.28;
    const y = 0.03;

    const pushDash = (x, z, along) => {
      const g = along === 'z'
        ? new THREE.PlaneGeometry(w, dash)
        : new THREE.PlaneGeometry(dash, w);
      g.rotateX(-Math.PI / 2);
      g.translate(x, y, z);
      this._groups.marking.push(g);
    };

    for (const line of LINES) {
      const outer = Math.abs(line) >= 120;
      const half = outer ? OUTER_STOP : 120;
      for (let t = -half + step / 2; t < half; t += step) {
        // Along Z on the vertical line, and along X on the horizontal line.
        pushDash(line, t, 'z');
        pushDash(t, line, 'x');
      }
    }
  }

  // A raised, rounded-corner plinth for every city block (the "sidewalk").
  _buildBlockSlabs() {
    const { CENTRES, SLAB_SIZE, SLAB_H, FILLET, CHAMFER } = LAYOUT;
    // Blocks whose corners are cut at 45 degrees instead of rounded.
    const chamfered = new Set(['-96,-96', '96,-96', '96,96', '-96,96', '-48,48', '48,-48']);

    for (const x of CENTRES) {
      for (const z of CENTRES) {
        const key = `${x},${z}`;
        let g;
        if (chamfered.has(key)) {
          g = slabChamfered(SLAB_SIZE, CHAMFER, FILLET, SLAB_H);
        } else {
          g = slabRounded(SLAB_SIZE, FILLET, SLAB_H);
        }
        g.translate(x, 0, z);
        this._groups.sidewalk.push(g);
      }
    }
  }

  /** Merge each material bucket into one mesh. */
  _commit() {
    this.meshes = {};
    for (const [name, geos] of Object.entries(this._groups)) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(merged, this.materials[name]);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      // Flatten onto a predictable render order; all road bits are near y=0.
      mesh.renderOrder = 0;
      this.scene.add(mesh);
      this.meshes[name] = mesh;
    }
  }
}
