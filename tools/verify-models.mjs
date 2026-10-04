// Structural validation of every GLTF/GLB asset: parses the JSON chunk directly
// (no DOM needed), checks primitives/accessors, resolves texture paths and
// unions the POSITION min/max to confirm the base-at-y=0 convention that the
// placement code relies on.
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_URLS, BUILDING_TYPES } from '../src/models.js';

function readAsset(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.glb')) {
    const jsonLen = buf.readUInt32LE(12);
    return JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  }
  return JSON.parse(buf.toString('utf8'));
}

let failures = 0;
const rows = [];
const known = new Set(Object.keys(MODEL_URLS));

for (const [key, url] of Object.entries(MODEL_URLS)) {
  const rel = url.replace(/^\/+/, '');
  const file = path.resolve('public', rel);
  const problems = [];

  if (!fs.existsSync(file)) {
    failures++;
    rows.push([key, `MISSING ${rel}`]);
    continue;
  }

  let json;
  try {
    json = readAsset(file);
  } catch (e) {
    failures++;
    rows.push([key, `PARSE FAIL: ${e.message}`]);
    continue;
  }

  if (json.asset?.version !== '2.0') problems.push('bad asset.version');

  // Textures must resolve on disk next to the model.
  for (const img of json.images || []) {
    if (!img.uri) continue;
    if (img.uri.startsWith('data:')) continue;
    const resolved = path.resolve(path.dirname(file), img.uri);
    if (!fs.existsSync(resolved)) problems.push(`missing texture ${img.uri}`);
  }

  // Union of POSITION accessor bounds across primitives.
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  let prims = 0;

  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      prims++;
      const posAcc = json.accessors[prim.attributes.POSITION];
      if (!posAcc) { problems.push('primitive without POSITION'); continue; }
      if (!posAcc.min || !posAcc.max) problems.push('POSITION accessor missing min/max');
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], posAcc.min?.[i] ?? 0);
        max[i] = Math.max(max[i], posAcc.max?.[i] ?? 0);
      }
      const idx = prim.indices !== undefined ? json.accessors[prim.indices].count : posAcc.count;
      tris += idx / 3;
      if (prim.mode !== undefined && prim.mode !== 4) problems.push(`primitive mode ${prim.mode}`);
    }
  }

  if (prims === 0) problems.push('no primitives');
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!(size[1] > 0)) problems.push('zero height');

  // Custom models are authored base-at-0; Kenney models are too.
  const custom = rel.includes('/custom/');
  if (custom && Math.abs(min[1]) > 0.05) problems.push(`base not at y=0 (${min[1].toFixed(2)})`);
  if (custom && Math.hypot((min[0] + max[0]) / 2, (min[2] + max[2]) / 2) > Math.max(size[0], size[2]) * 0.4) {
    problems.push('not centred on XZ');
  }

  if (problems.length) failures++;
  rows.push([
    key,
    problems.length ? problems.join('; ') : 'ok',
    `${prims}p/${Math.round(tris)}t  (${size[0].toFixed(1)}, ${size[1].toFixed(1)}, ${size[2].toFixed(1)})`,
  ]);
}

const w = Math.max(...rows.map((r) => r[0].length));
for (const r of rows) {
  console.log(`${r[1] === 'ok' ? 'ok  ' : 'BAD '} ${r[0].padEnd(w)}  ${(r[2] || '').padEnd(34)} ${r[1] === 'ok' ? '' : r[1]}`);
}

// Every building type must reference models that exist.
for (const [name, def] of Object.entries(BUILDING_TYPES)) {
  for (const k of def.pool) if (!known.has(k)) { failures++; console.log(`BAD  type ${name} -> unknown ${k}`); }
  for (const p of def.props || []) if (!known.has(p.key)) { failures++; console.log(`BAD  type ${name} prop -> unknown ${p.key}`); }
}

console.log(`\nmodels: ${known.size}   building types: ${Object.keys(BUILDING_TYPES).length}`);
console.log(failures === 0 ? 'ALL ASSETS VALID' : `${failures} PROBLEM(S)`);
process.exit(failures ? 1 : 0);
