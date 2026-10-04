// Verifies the player character GLB: native clips, rig binding, rest pose and
// — critically — that the animations do NOT contort the skeleton.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHARACTER } from '../src/models.js';
import { posedWorldBounds } from '../src/player.js';
import fs from 'node:fs';
import path from 'node:path';

if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent extends Event {
    constructor(t, i = {}) { super(t); this.lengthComputable = !!i.lengthComputable; this.loaded = i.loaded || 0; this.total = i.total || 0; }
  };
}

const file = path.resolve('public', CHARACTER.url.replace(/^\/+/, ''));
let fail = 0;
const ok = (cond, msg) => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'BAD '} ${msg}`); };

const gltf = await new GLTFLoader().loadAsync('data:model/gltf-binary;base64,' + fs.readFileSync(file).toString('base64'));
const root = gltf.scene;
root.updateMatrixWorld(true);

const bones = new Set();
let skinned = 0;
let tris = 0;
let hidden = 0;
root.traverse((o) => {
  if (o.isBone) bones.add(o.name);
  if (o.isSkinnedMesh) skinned++;
  if (o.isMesh) {
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (!o.visible) hidden++;
  }
});
console.log(`skinnedMeshes=${skinned}  bones=${bones.size}  triangles=${Math.round(tris)}  hiddenMeshes=${hidden}`);
console.log(`source size: ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);

// 1. The required clips must be NATIVE to this file (no retargeting).
const names = gltf.animations.map((c) => c.name);
console.log(`\nnative clips (${names.length}): ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`);
for (const state of ['idle', 'walk', 'run']) {
  const clipName = CHARACTER.clips[state];
  const clip = gltf.animations.find((c) => c.name === clipName);
  if (!clip) { fail++; console.log(`BAD  state "${state}" -> missing native clip "${clipName}"`); continue; }
  const targets = new Set(clip.tracks.map((t) => t.name.split('.')[0]));
  const unbindable = [...targets].filter((t) => !bones.has(t));
  ok(unbindable.length === 0,
    `${state.padEnd(5)} -> ${clipName.padEnd(34)} ${clip.duration.toFixed(2)}s tracks=${clip.tracks.length} unbindable=${unbindable.length}`);
}

// 2. Rest pose: a standing figure, fitted to the capsule.
const raw = posedWorldBounds(root);
const size = raw.getSize(new THREE.Vector3());
const s = CHARACTER.height / Math.max(size.y, 1e-6);
root.scale.setScalar(s);
root.updateMatrixWorld(true);
const fitted = posedWorldBounds(root);
console.log(`\nraw height=${size.y.toFixed(3)}m scale=${s.toFixed(3)} fitted=${(fitted.max.y - fitted.min.y).toFixed(3)}m`);
ok(Math.abs((fitted.max.y - fitted.min.y) - CHARACTER.height) < 0.06, `fitted to ${CHARACTER.height}m`);
ok(Math.abs(fitted.min.y) < 0.06, `feet at the capsule base (${fitted.min.y.toFixed(3)})`);

// 3. Per-clip limb sanity: sample each clip and check the limbs are not twisted
//    into impossible shapes. A pretzel collapses or inverts these relationships.
const boneByName = new Map();
root.traverse((o) => { if (o.isBone && !boneByName.has(o.name)) boneByName.set(o.name, o); });
const restQuat = new Map([...boneByName.values()].map((b) => [b, b.quaternion.clone()]));

const pick = (res) => {
  for (const [name, b] of boneByName) if (res.test(name)) return b;
  return null;
};
const head = pick(/head/i);
const hips = pick(/hips/i);
const footL = pick(/foot\.?l/i);
const footR = pick(/foot\.?r/i);
const handL = pick(/(hand|wrist).?l/i);
const handR = pick(/(hand|wrist).?r/i);

if (head && hips && footL && footR) {
  console.log('\nlimb sanity across each clip:');
  for (const clip of gltf.animations) {
    if (!/idle|walk|run/i.test(clip.name) || /gun|sword|shoot/i.test(clip.name)) continue;
    const tracks = clip.tracks.map((t) => [t.name.split('.')[0], t]);
    const N = 8;
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    let minArmSpan = Infinity;
    let worst = '';

    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * clip.duration;
      for (const b of boneByName.values()) b.quaternion.copy(restQuat.get(b));
      for (const [bn, track] of tracks) {
        const b = boneByName.get(bn);
        if (!b) continue;
        // nearest-frame quaternion sample
        const times = track.times;
        const vals = track.values;
        const n = times.length;
        let idx = 0;
        let bestD = Infinity;
        for (let k = 0; k < n; k++) { const d = Math.abs(times[k] - t); if (d < bestD) { bestD = d; idx = k; } }
        b.quaternion.fromArray(vals, idx * 4);
      }
      root.updateMatrixWorld(true);
      const y = (b) => b.getWorldPosition(new THREE.Vector3()).y;
      const w = (b) => b.getWorldPosition(new THREE.Vector3());
      const h = y(head) - Math.min(y(footL), y(footR));
      minHeight = Math.min(minHeight, h);
      maxHeight = Math.max(maxHeight, h);
      if (handL && handR) {
        const span = w(handL).distanceTo(w(handR));
        if (span < minArmSpan) { minArmSpan = span; worst = `t=${t.toFixed(2)}`; }
      }
    }
    const footSplit = Math.abs(footL.getWorldPosition(new THREE.Vector3()).y - footR.getWorldPosition(new THREE.Vector3()).y);
    const sane = minHeight > 1.1 && maxHeight < 2.1 && minArmSpan > 0.25 && footSplit < 0.6;
    if (!sane) fail++;
    console.log(
      `${sane ? 'ok  ' : 'BAD '} ${clip.name.padEnd(34)} height ${minHeight.toFixed(2)}-${maxHeight.toFixed(2)}m  ` +
      `minHandSpan=${minArmSpan.toFixed(2)}m  ${sane ? '' : `CONTORTED (${worst})`}`
    );
  }
} else {
  console.log('\n(note: could not identify head/hips/feet bones for the limb check)');
}

console.log(fail === 0 ? '\nCHARACTER OK' : `\n${fail} PROBLEM(S)`);
process.exit(fail ? 1 : 0);
