// Ground-truth measurement of the exported character: evaluates skinning
// directly (no Box3 caching) to report the real rest-pose height and foot level.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent extends Event {
    constructor(t, i = {}) { super(t); this.lengthComputable = !!i.lengthComputable; this.loaded = i.loaded || 0; this.total = i.total || 0; }
  };
}

const file = path.resolve('public/models/characters/character.glb');
const gltf = await new GLTFLoader().loadAsync('data:model/gltf-binary;base64,' + fs.readFileSync(file).toString('base64'));
const scene = gltf.scene;
scene.updateMatrixWorld(true);

// ---- bone rest positions -------------------------------------------------
const bones = [];
scene.traverse((o) => { if (o.isBone) bones.push(o); });
const show = ['Root', 'Hips', 'Chest', 'Head', 'UpperLegL', 'LowerLegL', 'FootL', 'FootR'];
console.log('=== bone rest positions (model space) ===');
for (const b of bones) {
  if (!show.includes(b.name)) continue;
  const w = new THREE.Vector3();
  b.getWorldPosition(w);
  console.log(`  ${b.name.padEnd(12)} (${w.x.toFixed(3)}, ${w.y.toFixed(3)}, ${w.z.toFixed(3)})`);
}

// ---- real skinned bounds -------------------------------------------------
const v = new THREE.Vector3();
const min = new THREE.Vector3(Infinity, Infinity, Infinity);
const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
let skinned = 0;

scene.traverse((o) => {
  if (!o.isSkinnedMesh) return;
  skinned++;
  const pos = o.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    o.applyBoneTransform(i, v);      // skin it
    v.applyMatrix4(o.matrixWorld);   // then place it
    min.min(v);
    max.max(v);
  }
});

console.log(`\n=== skinned bounds (${skinned} meshes, evaluated per-vertex) ===`);
console.log(`  min (${min.x.toFixed(3)}, ${min.y.toFixed(3)}, ${min.z.toFixed(3)})`);
console.log(`  max (${max.x.toFixed(3)}, ${max.y.toFixed(3)}, ${max.z.toFixed(3)})`);
console.log(`  height = ${(max.y - min.y).toFixed(3)} m,  feet at y = ${min.y.toFixed(3)}`);

const ok = Math.abs(min.y) < 0.05 && max.y > 1.5 && (max.y - min.y) > 1.5;
console.log(ok ? '\nREST POSE OK' : '\nREST POSE BROKEN (skeleton collapsed or floating)');
process.exit(ok ? 0 : 1);
