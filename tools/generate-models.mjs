/**
 * generate-models.mjs
 * -------------------
 * Authors the curved geometry the Kenney kits do not ship with, and exports it
 * as real .gltf assets that the runtime loads through GLTFLoader alongside the
 * Kenney models.
 *
 * Produces (into public/models/custom/):
 *   dome-landmark     large domed rotunda (landmark)
 *   spiral-tower      helical tower (landmark)
 *   round-shop        rounded-corner shop with an arched entrance
 *   arched-apartment  rounded corners, arcade of arches, diagonal roofline
 *   curved-hall       barrel-vaulted hall
 *   tree / pine       smooth stylised trees
 *   bin               round bin
 *   lamp              street lamp with a curved arm and a glowing globe
 *   hydrant           fire hydrant
 *
 * Everything is authored "base at y = 0, centred on XZ" so placement code can
 * treat all models (Kenney and custom) uniformly.
 *
 * Run: node tools/generate-models.mjs
 */
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('public/models/custom');

// ---------------------------------------------------------------------------
// GLTF writing
// ---------------------------------------------------------------------------

/** sRGB hex -> linear [r,g,b] (glTF colours are linear). */
function linearRGB(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

class ModelBuilder {
  constructor(name) {
    this.name = name;
    this.materials = [];   // { name, color, emissive, metallic, roughness }
    this.groups = new Map(); // materialName -> THREE.BufferGeometry[]
  }

  material(name, { color = 0xffffff, emissive = 0x000000, metallic = 0, roughness = 0.85 } = {}) {
    this.materials.push({ name, color, emissive, metallic, roughness });
    this.groups.set(name, []);
    return name;
  }

  /** Add a geometry (cloned, transformed) to a material group. */
  add(materialName, geometry, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
    const geo = geometry.clone();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(pos[0], pos[1], pos[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])),
      new THREE.Vector3(scale[0], scale[1], scale[2])
    );
    geo.applyMatrix4(m);
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    this.groups.get(materialName).push(geo);
    return this;
  }

  /** Merge each material group into one non-indexed vertex soup. */
  build({ doubleSided = false } = {}) {
    const primitives = [];

    for (const mat of this.materials) {
      const geos = this.groups.get(mat.name);
      if (!geos.length) continue;

      let vertexCount = 0;
      const flat = geos.map((g) => {
        const ng = g.index ? g.toNonIndexed() : g;
        vertexCount += ng.getAttribute('position').count;
        return ng;
      });

      const positions = new Float32Array(vertexCount * 3);
      const normals = new Float32Array(vertexCount * 3);
      let o = 0;
      for (const g of flat) {
        const p = g.getAttribute('position');
        const n = g.getAttribute('normal');
        for (let i = 0; i < p.count; i++) {
          positions[o] = p.getX(i);
          positions[o + 1] = p.getY(i);
          positions[o + 2] = p.getZ(i);
          normals[o] = n ? n.getX(i) : 0;
          normals[o + 1] = n ? n.getY(i) : 1;
          normals[o + 2] = n ? n.getZ(i) : 0;
          o += 3;
        }
      }

      primitives.push({
        positions,
        normals,
        material: {
          name: mat.name,
          baseColorFactor: [...linearRGB(mat.color), 1],
          emissiveFactor: linearRGB(mat.emissive),
          metallicFactor: mat.metallic,
          roughnessFactor: mat.roughness,
        },
      });
    }

    return writeGLTF(this.name, primitives, doubleSided);
  }
}

function writeGLTF(name, primitives, doubleSided) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];

  const pushView = (typedArray) => {
    const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const offset = byteLength;
    chunks.push(bytes);
    byteLength += bytes.length;
    // bufferViews must start on 4-byte boundaries; Float32 is already aligned.
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    return bufferViews.length - 1;
  };

  const meshPrimitives = [];

  for (const prim of primitives) {
    const posView = pushView(prim.positions);
    const nrmView = pushView(prim.normals);

    const bbox = new THREE.Box3().setFromBufferAttribute(
      new THREE.BufferAttribute(prim.positions, 3)
    );

    accessors.push({
      bufferView: posView,
      componentType: 5126,
      count: prim.positions.length / 3,
      type: 'VEC3',
      min: [bbox.min.x, bbox.min.y, bbox.min.z],
      max: [bbox.max.x, bbox.max.y, bbox.max.z],
    });
    const posAccessor = accessors.length - 1;

    accessors.push({
      bufferView: nrmView,
      componentType: 5126,
      count: prim.normals.length / 3,
      type: 'VEC3',
    });
    const nrmAccessor = accessors.length - 1;

    meshPrimitives.push({
      attributes: { POSITION: posAccessor, NORMAL: nrmAccessor },
      material: meshPrimitives.length,
      mode: 4,
    });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'city-drive model generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: meshPrimitives }],
    materials: primitives.map((p) => ({
      name: p.material.name,
      pbrMetallicRoughness: {
        baseColorFactor: p.material.baseColorFactor,
        metallicFactor: p.material.metallicFactor,
        roughnessFactor: p.material.roughnessFactor,
      },
      emissiveFactor: p.material.emissiveFactor,
      doubleSided,
    })),
    accessors,
    bufferViews,
    buffers: [
      {
        byteLength,
        uri: 'data:application/octet-stream;base64,' + Buffer.concat(chunks).toString('base64'),
      },
    ],
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.gltf`);
  fs.writeFileSync(file, JSON.stringify(gltf));
  const tris = primitives.reduce((a, p) => a + p.positions.length / 9, 0);
  console.log(
    `${name.padEnd(18)} prims=${primitives.length}  tris=${Math.round(tris).toString().padStart(5)}  ` +
      `${(fs.statSync(file).size / 1024).toFixed(1)}KB`
  );
}

// ---------------------------------------------------------------------------
// shape helpers
// ---------------------------------------------------------------------------

/** Rounded rectangle in XY, centred on the origin. */
function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  r = Math.min(r, w / 2 - 1e-3, d / 2 - 1e-3);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - r);
  s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + d);
  s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Extrude an XY shape upward (+Y) from y = 0. */
function extrudeUp(shape, height, curveSegments = 12) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments,
  });
  geo.rotateX(-Math.PI / 2); // extrusion axis +Z -> +Y
  return geo;
}

/** A wall panel with a real arched opening cut through it. */
function archWall(width, height, archW, archH, thickness) {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, 0);
  s.lineTo(width / 2, 0);
  s.lineTo(width / 2, height);
  s.lineTo(-width / 2, height);
  s.closePath();

  const r = archW / 2;
  const h = new THREE.Path();
  h.moveTo(-r, 0);
  h.lineTo(-r, archH - r);
  h.absarc(0, archH - r, r, Math.PI, 0, true);
  h.lineTo(r, 0);
  h.closePath();
  s.holes.push(h);

  const geo = new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false, curveSegments: 14 });
  geo.translate(0, 0, -thickness / 2);
  return geo;
}

/** Half-disc profile extruded along +Z: a barrel vault. */
function barrelVault(radius, length) {
  const s = new THREE.Shape();
  s.moveTo(-radius, 0);
  s.absarc(0, 0, radius, Math.PI, 0, true);
  s.lineTo(-radius, 0);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false, curveSegments: 20 });
  geo.translate(0, 0, -length / 2);
  return geo;
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

const STONE = 0xe9e2d0;
const STONE_DARK = 0xcfc6b0;
const ROOF = 0x3f7d8c;
const ROOF_WARM = 0xc0563f;
const GLASS = 0x9fd8e8;
const METAL = 0x9aa3ad;
const WOOD = 0x6b4f3a;
const LEAF = 0x5fa653;
const LEAF_DARK = 0x3f7a3a;

// 1. Domed rotunda --------------------------------------------------------
{
  const b = new ModelBuilder('dome-landmark');
  b.material('stone', { color: STONE, roughness: 0.9 });
  b.material('trim', { color: STONE_DARK, roughness: 0.9 });
  b.material('roof', { color: ROOF, roughness: 0.6, metallic: 0.15 });
  b.material('gold', { color: 0xf0c04a, roughness: 0.35, metallic: 0.8 });

  // stepped plinth
  b.add('trim', new THREE.CylinderGeometry(9.6, 9.9, 0.7, 40), { pos: [0, 0.35, 0] });
  b.add('stone', new THREE.CylinderGeometry(8.8, 9.0, 0.9, 40), { pos: [0, 1.0, 0] });
  // drum
  b.add('stone', new THREE.CylinderGeometry(7.0, 7.2, 5.4, 40), { pos: [0, 4.0, 0] });
  // colonnade
  const cols = 18;
  for (let i = 0; i < cols; i++) {
    const a = (i / cols) * Math.PI * 2;
    b.add('trim', new THREE.CylinderGeometry(0.42, 0.46, 5.2, 10), {
      pos: [Math.cos(a) * 7.75, 4.0, Math.sin(a) * 7.75],
    });
  }
  // architrave ring
  b.add('trim', new THREE.TorusGeometry(7.75, 0.55, 10, 40), { pos: [0, 6.7, 0], rot: [Math.PI / 2, 0, 0] });
  b.add('trim', new THREE.CylinderGeometry(8.0, 8.0, 0.5, 40), { pos: [0, 7.2, 0] });
  // dome (lathe profile)
  const profile = [];
  for (let i = 0; i <= 18; i++) {
    const t = i / 18;
    const ang = (t * Math.PI) / 2;
    profile.push(new THREE.Vector2(Math.cos(ang) * 7.2, Math.sin(ang) * 6.6));
  }
  b.add('roof', new THREE.LatheGeometry(profile, 40), { pos: [0, 7.4, 0] });
  // lantern + finial
  b.add('stone', new THREE.CylinderGeometry(1.5, 1.6, 1.6, 24), { pos: [0, 14.3, 0] });
  b.add('roof', new THREE.SphereGeometry(1.5, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), { pos: [0, 15.1, 0] });
  b.add('gold', new THREE.SphereGeometry(0.42, 14, 10), { pos: [0, 16.9, 0] });
  b.build();
}

// 2. Spiral tower ---------------------------------------------------------
{
  const b = new ModelBuilder('spiral-tower');
  b.material('concrete', { color: 0xdcd7cd, roughness: 0.92 });
  b.material('ramp', { color: 0xb9c0c7, roughness: 0.8 });
  b.material('roof', { color: ROOF_WARM, roughness: 0.55, metallic: 0.2 });
  b.material('glow', { color: 0xfff0b8, emissive: 0xffe08a, roughness: 0.4 });

  const TURNS = 3;
  const Y0 = 1.2;
  const Y1 = 17.0;
  const R = 4.0;
  const W = 1.5;
  const TH = 0.24;
  const SEG = 150;

  // Core
  b.add('concrete', new THREE.CylinderGeometry(1.7, 1.9, 19.5, 28), { pos: [0, 9.75, 0] });
  b.add('concrete', new THREE.CylinderGeometry(3.2, 3.4, 0.5, 28), { pos: [0, 0.25, 0] });
  // Cap
  b.add('roof', new THREE.CylinderGeometry(3.4, 3.9, 0.6, 28), { pos: [0, 19.8, 0] });
  b.add('glow', new THREE.SphereGeometry(0.5, 14, 10), { pos: [0, 20.4, 0] });

  // Helical ribbon, built as a swept quad ring.
  const positions = [];
  const indices = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const a = t * TURNS * Math.PI * 2;
    const y = Y0 + (Y1 - Y0) * t;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rIn = R - W / 2;
    const rOut = R + W / 2;
    const yT = y + TH / 2;
    const yB = y - TH / 2;
    // ring order: innerTop, outerTop, outerBot, innerBot
    positions.push(
      ca * rIn, yT, sa * rIn,
      ca * rOut, yT, sa * rOut,
      ca * rOut, yB, sa * rOut,
      ca * rIn, yB, sa * rIn
    );
  }
  const quad = (A, B, a, b2, c, d) => {
    indices.push(A + a, B + a, B + b2, A + a, B + b2, A + b2);
    indices.push(A + b2, B + b2, B + c, A + b2, B + c, A + c);
    indices.push(A + c, B + c, B + d, A + c, B + d, A + d);
    indices.push(A + d, B + d, B + a, A + d, B + a, A + a);
  };
  for (let i = 0; i < SEG; i++) quad(i * 4, (i + 1) * 4);

  const ribbon = new THREE.BufferGeometry();
  ribbon.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  ribbon.setIndex(indices);
  ribbon.computeVertexNormals();
  b.add('ramp', ribbon);
  // doubleSided so the swept ribbon shades correctly whichever way a face wound
  b.build({ doubleSided: true });
}

// 3. Rounded-corner shop with an arched entrance --------------------------
{
  const b = new ModelBuilder('round-shop');
  b.material('wall', { color: 0xf0e4d0, roughness: 0.9 });
  b.material('roof', { color: ROOF_WARM, roughness: 0.7 });
  b.material('trim', { color: 0x5a6b7a, roughness: 0.7 });
  b.material('glass', { color: GLASS, roughness: 0.15, metallic: 0.1, emissive: 0x0a2530 });

  const W = 7.2;
  const D = 6.0;
  const H = 3.4;

  b.add('wall', extrudeUp(roundedRect(W, D, 1.1), H));
  // overhanging rounded roof slab
  b.add('roof', extrudeUp(roundedRect(W + 0.7, D + 0.7, 1.3), 0.4), { pos: [0, H, 0] });
  // arched entrance cut through a front panel
  b.add('wall', archWall(3.2, 3.0, 1.7, 2.5, 0.35), { pos: [0, 0, D / 2 - 0.1] });
  // glazing either side
  for (const sx of [-2.2, 2.2]) {
    b.add('glass', new THREE.BoxGeometry(1.5, 1.7, 0.12), { pos: [sx, 1.55, D / 2 - 0.02] });
  }
  // awning over the entrance (curved)
  b.add('trim', new THREE.CylinderGeometry(1.55, 1.55, 2.6, 18, 1, true, 0, Math.PI), {
    pos: [0, 2.95, D / 2 + 0.35],
    rot: [0, 0, Math.PI / 2],
  });
  // side windows
  for (const sx of [-W / 2 + 0.02, W / 2 - 0.02]) {
    for (const z of [-1.5, 0, 1.5]) {
      b.add('glass', new THREE.BoxGeometry(0.12, 1.4, 1.1), { pos: [sx, 1.7, z] });
    }
  }
  b.add('trim', extrudeUp(roundedRect(W + 0.9, D + 0.9, 1.4), 0.35), { pos: [0, H + 0.4, 0] });
  b.build();
}

// 4. Arched apartment with a diagonal roofline ----------------------------
{
  const b = new ModelBuilder('arched-apartment');
  b.material('wall', { color: 0xd9c7ad, roughness: 0.9 });
  b.material('stone', { color: 0xb8a68c, roughness: 0.9 });
  b.material('roof', { color: ROOF, roughness: 0.65 });
  b.material('glass', { color: GLASS, roughness: 0.2, emissive: 0x0a2530 });

  const W = 8.4;
  const D = 7.0;
  const H = 8.2;

  b.add('wall', extrudeUp(roundedRect(W, D, 0.9), H));
  // ground-floor arcade: three real arched openings
  for (const x of [-2.6, 0, 2.6]) {
    b.add('stone', archWall(2.0, 3.4, 1.35, 2.6, 0.4), { pos: [x, 0, D / 2 - 0.12] });
  }
  b.add('stone', new THREE.BoxGeometry(W + 0.4, 0.35, 0.5), { pos: [0, 3.55, D / 2] });
  // upper windows
  for (const y of [4.6, 6.4]) {
    for (const x of [-2.7, -0.9, 0.9, 2.7]) {
      b.add('glass', new THREE.BoxGeometry(1.15, 1.25, 0.14), { pos: [x, y, D / 2 - 0.02] });
    }
  }
  // balconies
  for (const y of [4.0, 5.8]) {
    b.add('stone', extrudeUp(roundedRect(W - 1.0, 1.2, 0.35), 0.16), { pos: [0, y, D / 2 + 0.3] });
  }
  // diagonal roofline: extruded wedge
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-D / 2 - 0.35, 0);
  roofShape.lineTo(D / 2 + 0.35, 0);
  roofShape.lineTo(D / 2 + 0.35, 0.7);
  roofShape.lineTo(-D / 2 - 0.35, 2.6);
  roofShape.closePath();
  b.add('roof', extrudeUp(roofShape, W + 0.7), { pos: [0, H, 0], rot: [0, Math.PI / 2, 0] });
  b.build();
}

// 5. Barrel-vaulted hall --------------------------------------------------
{
  const b = new ModelBuilder('curved-hall');
  b.material('wall', { color: 0xe6dcc8, roughness: 0.9 });
  b.material('roof', { color: 0x6f8f6a, roughness: 0.6, metallic: 0.25 });
  b.material('stone', { color: 0xc2b49a, roughness: 0.9 });

  const W = 7.0;
  const D = 10.0;
  const WH = 3.0;
  const R = W / 2;

  b.add('wall', new THREE.BoxGeometry(W, WH, D), { pos: [0, WH / 2, 0] });
  b.add('roof', barrelVault(R, D), { pos: [0, WH, 0] });
  // arched end walls
  for (const sz of [-D / 2 - 0.15, D / 2 + 0.15]) {
    b.add('stone', archWall(W, WH + R * 0.75, 2.0, 3.6, 0.4), { pos: [0, 0, sz] });
  }
  b.add('stone', new THREE.BoxGeometry(W + 0.6, 0.4, 0.6), { pos: [0, WH + R * 0.78, 0] });
  b.build({ doubleSided: true });
}

// 6/7. Trees --------------------------------------------------------------
{
  const b = new ModelBuilder('tree');
  b.material('bark', { color: WOOD, roughness: 1 });
  b.material('leaf', { color: LEAF, roughness: 0.95 });
  b.material('leaf2', { color: LEAF_DARK, roughness: 0.95 });
  b.add('bark', new THREE.CylinderGeometry(0.16, 0.24, 1.5, 8), { pos: [0, 0.75, 0] });
  b.add('leaf2', new THREE.SphereGeometry(1.25, 14, 10), { pos: [0, 2.5, 0] });
  b.add('leaf', new THREE.SphereGeometry(0.95, 12, 9), { pos: [0.55, 2.15, 0.35] });
  b.add('leaf', new THREE.SphereGeometry(0.8, 12, 9), { pos: [-0.5, 2.85, -0.3] });
  b.build();

  const p = new ModelBuilder('pine');
  p.material('bark', { color: WOOD, roughness: 1 });
  p.material('leaf', { color: 0x2f6b46, roughness: 0.95 });
  p.material('leaf2', { color: 0x3f8a56, roughness: 0.95 });
  p.add('bark', new THREE.CylinderGeometry(0.15, 0.22, 1.1, 8), { pos: [0, 0.55, 0] });
  p.add('leaf', new THREE.ConeGeometry(1.5, 2.4, 12), { pos: [0, 2.0, 0] });
  p.add('leaf2', new THREE.ConeGeometry(1.15, 2.0, 12), { pos: [0, 3.2, 0] });
  p.add('leaf', new THREE.ConeGeometry(0.8, 1.6, 12), { pos: [0, 4.3, 0] });
  p.build();
}

// 8. Bin ------------------------------------------------------------------
{
  const b = new ModelBuilder('bin');
  b.material('body', { color: 0x4a5560, roughness: 0.85, metallic: 0.2 });
  b.material('lid', { color: 0x2f363d, roughness: 0.8, metallic: 0.25 });
  b.add('body', new THREE.CylinderGeometry(0.34, 0.3, 0.9, 16), { pos: [0, 0.45, 0] });
  b.add('lid', new THREE.CylinderGeometry(0.37, 0.37, 0.1, 16), { pos: [0, 0.93, 0] });
  b.add('lid', new THREE.SphereGeometry(0.16, 12, 8), { pos: [0, 1.0, 0] });
  b.build();
}

// 9. Street lamp ----------------------------------------------------------
{
  const b = new ModelBuilder('lamp');
  b.material('post', { color: 0x39424c, roughness: 0.7, metallic: 0.35 });
  b.material('glow', { color: 0xfff4cc, emissive: 0xffdf8a, roughness: 0.35 });
  b.add('post', new THREE.CylinderGeometry(0.13, 0.17, 3.4, 10), { pos: [0, 1.7, 0] });
  b.add('post', new THREE.CylinderGeometry(0.26, 0.3, 0.22, 12), { pos: [0, 0.11, 0] });
  // curved arm made from a quarter torus
  b.add('post', new THREE.TorusGeometry(0.8, 0.09, 8, 14, Math.PI / 2), {
    pos: [0.8, 3.4, 0],
    rot: [0, 0, Math.PI / 2],
  });
  b.add('glow', new THREE.SphereGeometry(0.3, 14, 10), { pos: [1.6, 3.15, 0] });
  b.add('post', new THREE.CylinderGeometry(0.34, 0.24, 0.18, 12), { pos: [1.6, 3.4, 0] });
  b.build();
}

// 10. Fire hydrant --------------------------------------------------------
{
  const b = new ModelBuilder('hydrant');
  b.material('red', { color: 0xc0392b, roughness: 0.6, metallic: 0.15 });
  b.material('cap', { color: 0xe4b04a, roughness: 0.5, metallic: 0.4 });
  b.add('red', new THREE.CylinderGeometry(0.3, 0.34, 0.16, 12), { pos: [0, 0.08, 0] });
  b.add('red', new THREE.CylinderGeometry(0.19, 0.22, 0.62, 12), { pos: [0, 0.47, 0] });
  b.add('red', new THREE.SphereGeometry(0.21, 14, 10), { pos: [0, 0.8, 0] });
  b.add('cap', new THREE.CylinderGeometry(0.09, 0.09, 0.12, 10), { pos: [0, 0.95, 0] });
  for (const a of [0, Math.PI / 2, Math.PI]) {
    b.add('cap', new THREE.CylinderGeometry(0.09, 0.09, 0.16, 10), {
      pos: [Math.cos(a) * 0.22, 0.55, Math.sin(a) * 0.22],
      rot: [0, 0, Math.PI / 2],
    });
  }
  b.build();
}

// 11. Suburban house -------------------------------------------------------
{
  const b = new ModelBuilder('house');
  b.material('wall', { color: 0xe8dcc4, roughness: 0.92 });
  b.material('brick', { color: 0xa9613f, roughness: 0.95 });
  b.material('roof', { color: 0x8c4a3a, roughness: 0.85 });
  b.material('trim', { color: 0xf4efe4, roughness: 0.85 });
  b.material('glass', { color: 0x9fd8e8, roughness: 0.2, emissive: 0x0a2530 });
  b.material('door', { color: 0x5a3a26, roughness: 0.8 });

  const W = 6.4;
  const D = 5.4;
  const H = 3.0;

  b.add('wall', new THREE.BoxGeometry(W, H, D), { pos: [0, H / 2, 0] });
  b.add('brick', new THREE.BoxGeometry(W + 0.3, 0.5, D + 0.3), { pos: [0, 0.25, 0] });

  // Pitched roof: two slanted slabs meeting at a ridge.
  const pitch = 0.55;
  const slabLen = Math.hypot(D / 2, pitch);
  for (const s of [-1, 1]) {
    b.add('roof', new THREE.BoxGeometry(W + 0.7, 0.22, slabLen), {
      pos: [0, H + pitch / 2, s * (D / 4)],
      rot: [s * Math.atan2(pitch, D / 2), 0, 0],
    });
  }
  // Gable ends
  for (const s of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(-D / 2, 0);
    shape.lineTo(D / 2, 0);
    shape.lineTo(0, pitch);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.15, bevelEnabled: false });
    g.rotateY(Math.PI / 2);
    b.add('wall', g, { pos: [s * (W / 2), H, 0] });
  }

  // Door, windows, chimney
  b.add('door', new THREE.BoxGeometry(1.0, 2.0, 0.12), { pos: [0, 1.0, D / 2 + 0.02] });
  for (const sx of [-2.0, 2.0]) {
    b.add('glass', new THREE.BoxGeometry(1.1, 1.0, 0.1), { pos: [sx, 1.7, D / 2 + 0.02] });
    b.add('trim', new THREE.BoxGeometry(1.3, 0.1, 0.14), { pos: [sx, 1.15, D / 2 + 0.03] });
  }
  for (const sz of [-1.4, 1.4]) {
    b.add('glass', new THREE.BoxGeometry(0.1, 1.0, 1.1), { pos: [W / 2 + 0.02, 1.7, sz] });
  }
  b.add('brick', new THREE.BoxGeometry(0.7, 1.6, 0.7), { pos: [-W / 2 + 1.2, H + 0.8, -1.2] });
  b.build();
}

// 12. Industrial warehouse ------------------------------------------------
{
  const b = new ModelBuilder('warehouse');
  b.material('wall', { color: 0xb9c1c7, roughness: 0.85, metallic: 0.15 });
  b.material('roof', { color: 0x6f7a83, roughness: 0.8, metallic: 0.25 });
  b.material('door', { color: 0x4a5560, roughness: 0.7, metallic: 0.3 });
  b.material('trim', { color: 0x8a949c, roughness: 0.7, metallic: 0.3 });

  const W = 12;
  const D = 8;
  const H = 5;

  b.add('wall', new THREE.BoxGeometry(W, H, D), { pos: [0, H / 2, 0] });
  const pitch = 1.1;
  const slabLen = Math.hypot(D / 2, pitch);
  for (const s of [-1, 1]) {
    b.add('roof', new THREE.BoxGeometry(W + 0.5, 0.3, slabLen), {
      pos: [0, H + pitch / 2, s * (D / 4)],
      rot: [s * Math.atan2(pitch, D / 2), 0, 0],
    });
  }
  for (const sx of [-3.2, 0, 3.2]) {
    b.add('door', new THREE.BoxGeometry(2.4, 3.2, 0.16), { pos: [sx, 1.6, D / 2 + 0.02] });
  }
  b.add('trim', new THREE.BoxGeometry(W + 0.6, 0.35, 0.4), { pos: [0, H - 0.2, D / 2] });
  for (const sx of [-3, 3]) {
    b.add('trim', new THREE.CylinderGeometry(0.35, 0.35, 0.7, 10), { pos: [sx, H + pitch + 0.3, 0] });
  }
  b.build();
}

// 13. Dockyard crane ------------------------------------------------------
{
  const b = new ModelBuilder('crane');
  b.material('steel', { color: 0xd9a12b, roughness: 0.55, metallic: 0.5 });
  b.material('dark', { color: 0x3b4046, roughness: 0.6, metallic: 0.4 });

  const baseY = 0.6;
  b.add('dark', new THREE.BoxGeometry(3.4, 0.6, 3.4), { pos: [0, baseY / 2, 0] });

  const mastH = 14;
  for (const sx of [-0.65, 0.65]) {
    for (const sz of [-0.65, 0.65]) {
      b.add('steel', new THREE.BoxGeometry(0.22, mastH, 0.22), { pos: [sx, baseY + mastH / 2, sz] });
    }
  }
  for (let y = 1.5; y < mastH; y += 1.8) {
    b.add('steel', new THREE.BoxGeometry(1.5, 0.12, 0.12), { pos: [0, baseY + y, 0.65] });
    b.add('steel', new THREE.BoxGeometry(1.5, 0.12, 0.12), { pos: [0, baseY + y, -0.65] });
  }

  const top = baseY + mastH;
  b.add('steel', new THREE.BoxGeometry(16, 0.35, 0.5), { pos: [5.5, top, 0] });
  b.add('steel', new THREE.BoxGeometry(5, 0.4, 0.7), { pos: [-4.5, top, 0] });
  b.add('dark', new THREE.BoxGeometry(1.6, 1.0, 1.6), { pos: [-6.4, top - 0.2, 0] });

  b.add('dark', new THREE.BoxGeometry(1.4, 1.3, 1.4), { pos: [0.6, top - 1.4, 1.0] });
  b.add('dark', new THREE.BoxGeometry(0.12, 4.2, 0.12), { pos: [10, top - 2.1, 0] });
  b.add('steel', new THREE.BoxGeometry(0.8, 0.8, 0.8), { pos: [10, top - 4.4, 0] });

  for (const s of [-1, 1]) {
    b.add('steel', new THREE.BoxGeometry(0.16, 10, 0.16), {
      pos: [0, top + 3, s * 0.5],
      rot: [s * 0.5, 0, 0],
    });
  }
  b.build();
}

// 14. Desert gas station --------------------------------------------------
{
  const b = new ModelBuilder('gas-station');
  b.material('canopy', { color: 0xd94f3d, roughness: 0.7, metallic: 0.1 });
  b.material('column', { color: 0xcfc9bd, roughness: 0.85 });
  b.material('shop', { color: 0xe6dcc6, roughness: 0.9 });
  b.material('glass', { color: 0x9fd8e8, roughness: 0.18, metallic: 0.1, emissive: 0x0a2530 });
  b.material('pump', { color: 0x4a5560, roughness: 0.6, metallic: 0.3 });
  b.material('trim', { color: 0xf2c14e, roughness: 0.6 });

  // Shop at the back.
  b.add('shop', new THREE.BoxGeometry(9.0, 3.4, 4.0), { pos: [0, 1.7, -5.0] });
  b.add('glass', new THREE.BoxGeometry(7.6, 1.8, 0.12), { pos: [0, 1.8, -2.96] });
  b.add('trim', new THREE.BoxGeometry(9.4, 0.3, 4.4), { pos: [0, 3.5, -5.0] });

  // Forecourt canopy on four columns.
  b.add('canopy', new THREE.BoxGeometry(11.0, 0.55, 7.0), { pos: [0, 4.6, 1.5] });
  b.add('trim', new THREE.BoxGeometry(11.3, 0.22, 7.3), { pos: [0, 4.3, 1.5] });
  for (const sx of [-4.4, 4.4]) {
    for (const sz of [-1.4, 4.4]) {
      b.add('column', new THREE.BoxGeometry(0.5, 4.4, 0.5), { pos: [sx, 2.2, sz] });
    }
  }

  // Pumps.
  for (const sx of [-2.2, 2.2]) {
    b.add('pump', new THREE.BoxGeometry(0.9, 1.5, 1.6), { pos: [sx, 0.75, 1.5] });
    b.add('trim', new THREE.BoxGeometry(1.0, 0.26, 1.7), { pos: [sx, 1.62, 1.5] });
  }
  b.build();
}

// 15. Roadside motel ------------------------------------------------------
{
  const b = new ModelBuilder('motel');
  b.material('wall', { color: 0xe3d3b4, roughness: 0.92 });
  b.material('roof', { color: 0x8a5a44, roughness: 0.85 });
  b.material('door', { color: 0x5c4030, roughness: 0.8 });
  b.material('glass', { color: 0x9fd8e8, roughness: 0.2, emissive: 0x0a2530 });
  b.material('trim', { color: 0xffffff, roughness: 0.8 });
  b.material('sign', { color: 0xe8552f, roughness: 0.5, emissive: 0x3a0f06 });

  const W = 20;
  const D = 6.5;
  const H = 6.2;

  b.add('wall', new THREE.BoxGeometry(W, H, D), { pos: [0, H / 2, 0] });
  // Shallow gable roof.
  const pitch = 0.9;
  const slabLen = Math.hypot(D / 2, pitch);
  for (const s of [-1, 1]) {
    b.add('roof', new THREE.BoxGeometry(W + 0.8, 0.26, slabLen), {
      pos: [0, H + pitch / 2, s * (D / 4)],
      rot: [s * Math.atan2(pitch, D / 2), 0, 0],
    });
  }
  // Two floors of doors and windows along the front, plus a walkway.
  for (const y of [1.15, 4.35]) {
    b.add('trim', new THREE.BoxGeometry(W - 0.2, 0.18, 0.9), { pos: [0, y - 0.75, D / 2 + 0.45] });
    for (let i = 0; i < 6; i++) {
      const x = -W / 2 + 2.0 + i * 3.2;
      b.add('door', new THREE.BoxGeometry(1.15, 2.05, 0.14), { pos: [x, y + 0.3, D / 2 + 0.02] });
      b.add('glass', new THREE.BoxGeometry(1.0, 0.95, 0.12), { pos: [x + 1.5, y + 0.75, D / 2 + 0.03] });
    }
  }
  // Posts holding the walkway.
  for (const x of [-W / 2 + 1, 0, W / 2 - 1]) {
    b.add('trim', new THREE.CylinderGeometry(0.12, 0.12, H, 8), { pos: [x, H / 2, D / 2 + 0.85] });
  }
  // Neon sign on a pole.
  b.add('trim', new THREE.BoxGeometry(0.4, 4.6, 0.4), { pos: [-W / 2 - 1.6, 2.3, D / 2 + 1.4] });
  b.add('sign', new THREE.BoxGeometry(4.6, 1.5, 0.3), { pos: [-W / 2 - 1.6, 5.0, D / 2 + 1.4] });
  b.build();
}

// 16. Multi-storey parking structure --------------------------------------
{
  const b = new ModelBuilder('parking');
  b.material('deck', { color: 0x9a958c, roughness: 0.92 });
  b.material('band', { color: 0x54595f, roughness: 0.85 });
  b.material('rail', { color: 0xc8ccd2, roughness: 0.6, metallic: 0.4 });

  const W = 22, D = 16, H = 15;
  b.add('deck', new THREE.BoxGeometry(W, H, D), { pos: [0, H / 2, 0] });
  // Open slot bands on all four faces.
  for (let y = 3.4; y < H - 1; y += 3.4) {
    b.add('band', new THREE.BoxGeometry(W + 0.3, 1.5, D - 1.2), { pos: [0, y, 0] });
    b.add('band', new THREE.BoxGeometry(W - 1.2, 1.5, D + 0.3), { pos: [0, y, 0] });
  }
  // Roof parapet + ramp tower.
  b.add('rail', new THREE.BoxGeometry(W + 0.6, 0.5, 0.4), { pos: [0, H + 0.2, D / 2] });
  b.add('rail', new THREE.BoxGeometry(W + 0.6, 0.5, 0.4), { pos: [0, H + 0.2, -D / 2] });
  b.add('deck', new THREE.BoxGeometry(6, 3, 6), { pos: [W / 2 - 3, H + 1.5, -D / 2 + 3] });
  b.build();
}

// 17. Roadside diner -------------------------------------------------------
{
  const b = new ModelBuilder('diner');
  b.material('wall', { color: 0xdfe3e6, roughness: 0.85 });
  b.material('trim', { color: 0xd8453a, roughness: 0.6 });
  b.material('glass', { color: 0xb8e4f0, roughness: 0.15, emissive: 0x14343f });
  b.material('roof', { color: 0x5b6068, roughness: 0.8 });
  b.material('sign', { color: 0xf2c14e, roughness: 0.4, emissive: 0x4a3406 });

  const W = 11, D = 6.5, H = 3.6;
  b.add('wall', new THREE.BoxGeometry(W, H, D), { pos: [0, H / 2, 0] });
  b.add('roof', new THREE.BoxGeometry(W + 1.2, 0.35, D + 1.2), { pos: [0, H + 0.18, 0] });
  // Wraparound glazing.
  for (const sx of [-W / 2 + 0.03, W / 2 - 0.03]) {
    b.add('glass', new THREE.BoxGeometry(0.14, 1.9, D - 1.4), { pos: [sx, 1.9, 0] });
  }
  b.add('glass', new THREE.BoxGeometry(W - 1.2, 1.9, 0.14), { pos: [0, 1.9, D / 2 + 0.02] });
  b.add('trim', new THREE.BoxGeometry(W + 1.6, 0.4, 0.5), { pos: [0, H - 0.1, D / 2 + 0.3] });
  // Roof sign.
  b.add('trim', new THREE.BoxGeometry(0.25, 2.2, 0.25), { pos: [-W / 2 + 1, H + 1.3, D / 2 - 1] });
  b.add('sign', new THREE.BoxGeometry(4.2, 1.3, 0.25), { pos: [-W / 2 + 1, H + 2.6, D / 2 - 1] });
  b.build();
}

console.log('\nDone. Assets written to public/models/custom/');
