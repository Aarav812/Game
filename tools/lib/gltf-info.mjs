// glTF JSON inspector (no texture decoding): bounds, node hierarchy, skin joints.
import fs from 'node:fs';
import path from 'node:path';

function readJSON(file) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 4).toString('ascii') === 'glTF') {
    const len = buf.readUInt32LE(12);
    return JSON.parse(buf.slice(20, 20 + len).toString('utf8'));
  }
  return JSON.parse(buf.toString('utf8'));
}

// Compose parent transforms (translation/rotation/scale) for a node chain.
function mat4TRS(t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
  return m;
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = v;
  }
  return o;
}
function xform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
function applyScale(m, s) {
  return m.map((v, i) => (i % 4 === 3 ? v : v * s[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2]));
}

export function inspect(file, { showNodes = false } = {}) {
  const j = readJSON(file);
  const nodes = j.nodes || [];

  // World transforms
  const parents = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach((c) => { parents[c] = i; }));
  const world = nodes.map((n, i) => {
    let m = mat4TRS(n.translation, n.rotation, n.scale);
    let p = parents[i];
    while (p !== -1) {
      m = mul(mat4TRS(nodes[p].translation, nodes[p].rotation, nodes[p].scale), m);
      p = parents[p];
    }
    return m;
  });

  // Per-node bounds from mesh POSITION accessors
  const bounds = nodes.map((n, i) => {
    if (n.mesh === undefined) return null;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const prim of j.meshes[n.mesh].primitives || []) {
      const acc = j.accessors[prim.attributes.POSITION];
      if (!acc?.min) continue;
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], acc.min[k]); max[k] = Math.max(max[k], acc.max[k]); }
    }
    if (!isFinite(min[0])) return null;
    // 8 corners through the world matrix
    const wmin = [Infinity, Infinity, Infinity];
    const wmax = [-Infinity, -Infinity, -Infinity];
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
      const w = xform(world[i], [x, y, z]);
      for (let k = 0; k < 3; k++) { wmin[k] = Math.min(wmin[k], w[k]); wmax[k] = Math.max(wmax[k], w[k]); }
    }
    return { local: { min, max }, world: { min: wmin, max: wmax } };
  });

  const all = bounds.filter(Boolean);
  const gmin = [Infinity, Infinity, Infinity];
  const gmax = [-Infinity, -Infinity, -Infinity];
  for (const b of all) for (let k = 0; k < 3; k++) { gmin[k] = Math.min(gmin[k], b.world.min[k]); gmax[k] = Math.max(gmax[k], b.world.max[k]); }
  const size = [gmax[0] - gmin[0], gmax[1] - gmin[1], gmax[2] - gmin[2]];

  const out = {
    file: path.basename(file),
    nodes: nodes.length,
    meshes: (j.meshes || []).length,
    materials: (j.materials || []).length,
    images: (j.images || []).length,
    textures: (j.textures || []).length,
    skins: (j.skins || []).length,
    joints: j.skins?.[0]?.joints?.map((idx) => nodes[idx].name) || [],
    bounds: { min: gmin.map((v) => +v.toFixed(3)), max: gmax.map((v) => +v.toFixed(3)), size: size.map((v) => +v.toFixed(3)) },
    parts: bounds.map((b, i) => b && { name: nodes[i].name, size: [b.world.max[0] - b.world.min[0], b.world.max[1] - b.world.min[1], b.world.max[2] - b.world.min[2]].map((v) => +v.toFixed(3)), centre: [0, 1, 2].map((k) => +((b.world.min[k] + b.world.max[k]) / 2).toFixed(3)) }).filter(Boolean),
  };
  if (showNodes) out.nodeNames = nodes.map((n) => n.name);
  out.meshNames = (j.meshes || []).map((m) => m.name);
  return out;
}

if (process.argv[2]) {
  console.log(JSON.stringify(inspect(process.argv[2], { showNodes: true }), null, 2));
}
