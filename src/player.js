import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GROUP, MASK } from './collision.js';
import { CHARACTER } from './models.js';

/**
 * Player
 * ------
 * Third-person character controller.
 *
 * Physics body: a capsule approximated by a CANNON.Cylinder plus two
 * CANNON.Sphere caps. The material has friction 0 so the character never
 * sticks to walls; horizontal velocity is driven directly instead of through
 * friction, which is what makes that safe.
 *
 * Visuals: a rigged, skinned low-poly humanoid (see models.js CHARACTER) driven
 * by an AnimationMixer. The mesh is parented to `this.group`, whose origin is
 * the capsule centre, so mesh and physics body can never drift apart — the
 * body is authoritative and the mesh is snapped to it every frame.
 *
 * Grounding is a short raycast straight down against the WORLD group only, so
 * the character can only jump when actually standing on something.
 */

const RADIUS = 0.4;              // capsule radius
const CYL_HALF = 0.5;            // half-height of the cylindrical section
const HALF = CYL_HALF + RADIUS;  // centre -> cap distance (0.9 => 1.8m tall)
const EYE = 0.8;                 // camera focus height above the body centre

const MASS = 5;
const RUN_SPEED = 6.5;
const WALK_THRESHOLD = 0.6;      // above this the character is moving
const RUN_THRESHOLD = 5.0;       // above this the Run clip replaces Walk
const JUMP_SPEED = 4.3;          // apex ≈ 0.94 m (v² / 2g), a normal athletic hop
const FALL_GRAVITY = 1.7;        // extra gravity while descending, for a snappy fall
const ACCEL = 16;                // m/s^2 while a direction is held
const DECEL = 24;                // m/s^2 when releasing (so Walk shows on stop)
const AIR_CONTROL = 0.55;
const GROUND_RAY = HALF + 0.18;
const TURN_LAMBDA = 14;
const AIR_TURN_LAMBDA = 5;

const BLEND = 0.2;               // cross-fade duration, seconds
const BLEND_LAND = 0.15;         // shorter blend when landing out of the jump
const MODEL_YAW = 0;             // model already faces +Z, like the body
const SHADOW_SIZE = 1.7;

/**
 * World-space bounds of a rigged object at its CURRENT pose.
 *
 * Box3.setFromObject reuses a SkinnedMesh's cached boundingBox, which is computed
 * on first call — potentially before the bones' world matrices are up to date —
 * so it can report the bind pose rather than what is actually drawn. This walks
 * the skeleton properly: refresh world matrices first, then let each skinned mesh
 * skin its own vertices.
 */
export function posedWorldBounds(root, out = new THREE.Box3()) {
  root.updateMatrixWorld(true);
  out.makeEmpty();

  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.isSkinnedMesh) {
      o.computeBoundingBox(); // applies bone transforms to the vertices
      if (!o.boundingBox) return;
      box.copy(o.boundingBox);
    } else {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.copy(o.geometry.boundingBox);
    }
    // A skinned box is already in this object's local space.
    box.applyMatrix4(o.matrixWorld);
    out.union(box);
  });

  return out;
}

export class Player {
  constructor(scene, physics, groundMaterial, spawn = new THREE.Vector3(24, HALF + 0.1, 57)) {
    this.scene = scene;
    this.physics = physics;
    this.spawn = spawn.clone();

    this.enabled = true;
    this.grounded = false;
    this.facing = 0;
    this.speed = 0;
    this._targetFacing = 0;
    this._jumping = false;   // true while airborne from a Space jump

    this._rayFrom = new CANNON.Vec3();
    this._rayTo = new CANNON.Vec3();
    this._rayResult = new CANNON.RaycastResult();
    this._up = new THREE.Vector3(0, 1, 0);

    // animation state
    this.mixer = null;
    this.actions = {};
    this._action = null;
    this._actionName = null;
    this._modelReady = false;

    this._createPhysics(groundMaterial);
    this._createVisual();
    this._createContactShadow();
    this.teleport(this.spawn);
  }

  // ---------------------------------------------------------------- physics
  _createPhysics(groundMaterial) {
    this.material = new CANNON.Material('player');

    if (groundMaterial) {
      this.physics.addContactMaterial(
        new CANNON.ContactMaterial(this.material, groundMaterial, { friction: 0, restitution: 0 })
      );
    }

    this.body = new CANNON.Body({
      mass: MASS,
      material: this.material,
      collisionFilterGroup: GROUP.PLAYER,
      collisionFilterMask: MASK.PLAYER,
      fixedRotation: true,
      linearDamping: 0,
      allowSleep: false,
    });

    this.body.addShape(new CANNON.Cylinder(RADIUS, RADIUS, CYL_HALF * 2, 12));
    this.body.addShape(new CANNON.Sphere(RADIUS), new CANNON.Vec3(0, CYL_HALF, 0));
    this.body.addShape(new CANNON.Sphere(RADIUS), new CANNON.Vec3(0, -CYL_HALF, 0));
    this.body.updateMassProperties();

    this.physics.addBody(this.body);
  }

  // ----------------------------------------------------------------- visual
  _createVisual() {
    // Empty until the GLTF arrives; a placeholder keeps the character visible
    // for the split second before load completes.
    this.group = new THREE.Group();

    const placeholder = new THREE.Mesh(
      new THREE.CapsuleGeometry(RADIUS * 0.8, CYL_HALF * 2, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x2ec4b6, roughness: 0.8, flatShading: true })
    );
    placeholder.castShadow = true;
    placeholder.name = 'placeholder';
    this.group.add(placeholder);

    this.scene.add(this.group);
  }

  /**
   * Load the rigged character and wire up the AnimationMixer.
   * Resolves once the mesh is in the scene and Idle is playing.
   */
  async loadModel() {
    const gltf = await new GLTFLoader().loadAsync(CHARACTER.url);
    const model = gltf.scene;

    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.visible = true; // never ship a hidden limb
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false; // skinned bounds are unreliable while animating
        // The character comes with its own modelled clothing and per-material
        // colours, so we only tune the surface response.
        for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!mat) continue;
          mat.roughness = CHARACTER.material.roughness;
          mat.metalness = CHARACTER.material.metalness;
        }
      }
    });

    // Strip any held-item meshes (weapons) before fitting, so the bounds and the
    // rendered character are weapon-free.
    this._stripHeldItems(model);

    // Scale to the target height, then place the soles exactly at the bottom cap
    // of the physics capsule (y = -HALF in this group's frame, whose origin is the
    // capsule centre). Measured at the real posed bounds, not the bind pose.
    const raw = posedWorldBounds(model);
    const size = raw.getSize(new THREE.Vector3());
    model.scale.setScalar(CHARACTER.height / Math.max(size.y, 1e-6));
    model.updateMatrixWorld(true);

    const fitted = posedWorldBounds(model);
    const centre = fitted.getCenter(new THREE.Vector3());
    model.position.x -= centre.x;
    model.position.z -= centre.z;
    model.position.y += -HALF - fitted.min.y; // soles on the capsule's bottom cap

    // Drop the placeholder and attach the real model.
    const ph = this.group.getObjectByName('placeholder');
    if (ph) {
      this.group.remove(ph);
      ph.geometry.dispose();
      ph.material.dispose();
    }
    this.group.add(model);
    this.model = model;

    // Animation state machine. The clips are the model's OWN, played natively —
    // never retargeted from another rig.
    this.mixer = new THREE.AnimationMixer(model);
    const byName = Object.fromEntries(gltf.animations.map((c) => [c.name, c]));

    const make = (clipName, { once = false } = {}) => {
      if (!clipName) return null;
      const clip = byName[clipName];
      if (!clip) return null;
      const action = this.mixer.clipAction(clip);
      if (once) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      return action;
    };

    this.actions.idle = make(CHARACTER.clips.idle);
    this.actions.walk = make(CHARACTER.clips.walk);
    this.actions.run = make(CHARACTER.clips.run);

    // Jump: ONLY a genuine native clip from the model's own file. This
    // character ships no `Jump` clip, so `actions.jump` stays null and the
    // locomotion cycle keeps playing while airborne. Nothing composes a pose,
    // edits a bone, or touches a material — so the rig can never contort and no
    // limb can disappear.
    this.actions.jump = CHARACTER.clips.jump ? make(CHARACTER.clips.jump) : null;
    this.jumpClipSource = this.actions.jump ? 'native' : 'locomotion';

    this.clipNames = gltf.animations.map((c) => c.name);
    this._modelReady = true;
    this._fadeTo('idle');

    // Prime the mixer so this frame's pose is baked before the first render.
    this.mixer.update(0);
    return this;
  }

  /** Soft contact shadow that keeps the character feeling planted. */
  _createContactShadow() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    this.contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(SHADOW_SIZE, SHADOW_SIZE),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: 1,
        toneMapped: false,
      })
    );
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.renderOrder = 2;
    this.contactShadow.visible = false;
    this.scene.add(this.contactShadow);
  }

  /**
   * Remove any weapon / held-item mesh.
   *
   * This is a safety net rather than a fix for the current model (which has
   * none): it matches on mesh *and* material names, and also drops anything
   * parented under a hand/wrist bone that isn't a body part, so a sword can
   * never end up skinned to the right hand again.
   */
  _stripHeldItems(model) {
    const pattern = CHARACTER.heldItemPattern;
    if (!pattern) return;
    const doomed = new Set();

    model.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (pattern.test(o.name || '') || mats.some((m) => m && pattern.test(m.name || ''))) {
        doomed.add(o);
      }
    });

    // Anything attached beneath a hand/wrist bone that is not a body part.
    model.traverse((o) => {
      if (!o.isBone || !/hand|wrist|thumb|index|middle|ring|pinky|finger/i.test(o.name)) return;
      o.traverse((child) => {
        if (child === o) return;
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        const isBody = mats.some((m) => m && /skin|hand/i.test(m.name || ''));
        if (!isBody && !/skin/i.test(child.name || '')) doomed.add(child);
      });
    });

    for (const mesh of doomed) {
      mesh.removeFromParent();
      if (mesh.geometry) mesh.geometry.dispose();
    }
    this.strippedItems = [...doomed].map((m) => m.name || '(unnamed)');
  }

  // ------------------------------------------------------------------- step
  /** Read input and drive the capsule. Runs once per fixed physics step. */
  update(dt, input, cameraYaw) {
    const body = this.body;
    const v = body.velocity;

    this._updateGroundCheck();

    if (!this.enabled) {
      v.setZero();
      this.speed = 0;
      return;
    }

    const fwdInput =
      (input.isDown('KeyW') || input.isDown('ArrowUp') ? 1 : 0) -
      (input.isDown('KeyS') || input.isDown('ArrowDown') ? 1 : 0);
    const sideInput =
      (input.isDown('KeyD') || input.isDown('ArrowRight') ? 1 : 0) -
      (input.isDown('KeyA') || input.isDown('ArrowLeft') ? 1 : 0);

    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    const rx = Math.cos(cameraYaw);
    const rz = -Math.sin(cameraYaw);

    let dx = fx * fwdInput + rx * sideInput;
    let dz = fz * fwdInput + rz * sideInput;
    const len = Math.hypot(dx, dz);

    let targetX = 0;
    let targetZ = 0;
    if (len > 1e-4) {
      dx /= len;
      dz /= len;
      const speed = RUN_SPEED * (this.grounded ? 1 : AIR_CONTROL);
      targetX = dx * speed;
      targetZ = dz * speed;
      this._targetFacing = Math.atan2(dx, dz);
    }

    if (this.grounded) {
      // Ramp toward the target instead of snapping: gives the character some
      // weight on start/stop and lets the Walk clip actually play during the
      // acceleration band.
      const dx = targetX - v.x;
      const dz = targetZ - v.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-4) {
        const rate = (targetX !== 0 || targetZ !== 0) ? ACCEL : DECEL;
        const step = Math.min(1, (rate * dt) / dist);
        v.x += dx * step;
        v.z += dz * step;
      }
    } else {
      const k = Math.min(1, dt * 3.5);
      v.x += (targetX - v.x) * k;
      v.z += (targetZ - v.z) * k;
    }

    if (this.grounded && input.wasPressed('Space')) {
      v.y = JUMP_SPEED;
      this.grounded = false;
      // Remember that this airborne phase came from a deliberate jump, so the
      // animation state machine can play the Jump pose rather than just holding
      // the locomotion pose (which is what happens when walking off a ledge).
      this._jumping = true;
    }

    // Snappier descent: extra gravity past the apex so the jump never feels
    // floaty. Applied per fixed step, so it stays frame-rate independent.
    if (!this.grounded && v.y < 0) {
      v.y -= (FALL_GRAVITY - 1) * 9.82 * dt;
    }

    const lambda = this.grounded ? TURN_LAMBDA : AIR_TURN_LAMBDA;
    this.facing = angleLerp(this.facing, this._targetFacing, 1 - Math.exp(-lambda * dt));

    this.speed = Math.hypot(v.x, v.z);
  }

  /** Short downward raycast: only the WORLD group counts as ground. */
  _updateGroundCheck() {
    const p = this.body.position;
    this._rayFrom.set(p.x, p.y, p.z);
    this._rayTo.set(p.x, p.y - GROUND_RAY, p.z);

    this._rayResult.reset();
    this.physics.raycastClosest(
      this._rayFrom,
      this._rayTo,
      { collisionFilterMask: GROUP.WORLD, skipBackfaces: true },
      this._rayResult
    );

    this.grounded = this._rayResult.hasHit && this.body.velocity.y <= 0.5;
  }

  // -------------------------------------------------------------- animation
  /**
   * Idle / Walk / Run selection with 0.2 s cross-fades. A native Jump clip, if
   * one ever exists, is selected by `updateAnimation`; otherwise the locomotion
   * cycle is kept while airborne.
   */
  _fadeTo(name, duration = BLEND) {
    const next = this.actions[name];
    if (!next || next === this._action) return;

    if (this._action) {
      this._action.fadeOut(duration);
    }
    next
      .reset()
      .setEffectiveTimeScale(1)
      .setEffectiveWeight(1)
      .fadeIn(duration)
      .play();

    this._action = next;
    this._actionName = name;
  }

  updateAnimation(dt) {
    if (!this._modelReady) return;
    if (!this.enabled) return; // hidden inside the car

    let want = 'idle';
    let landBlend = false;
    if (!this.grounded) {
      // Airborne. A deliberate jump plays a native Jump clip when the model has
      // one; this one does not, so the Walk/Run cycle simply keeps playing while
      // the capsule rises and falls. Walking off a ledge behaves the same way.
      // Nothing here touches bones, poses or materials.
      if (this._jumping && this.actions.jump) want = 'jump';
      else if (this.speed > RUN_THRESHOLD) want = 'run';
      else if (this.speed > WALK_THRESHOLD) want = 'walk';
    } else {
      // Landing: clear the jump latch so Run/Walk take over again, and use the
      // shorter blend so the touch-down reads snappily.
      landBlend = this._jumping;
      this._jumping = false;
      if (this.speed > RUN_THRESHOLD) want = 'run';
      else if (this.speed > WALK_THRESHOLD) want = 'walk';
    }

    if (want !== this._actionName) this._fadeTo(want, landBlend ? BLEND_LAND : BLEND);

    // Keep the stride in step with actual ground speed.
    if (want === 'run' && this.actions.run) {
      this.actions.run.setEffectiveTimeScale(
        THREE.MathUtils.clamp(this.speed / 4.6, 0.85, 1.6)
      );
    } else if (want === 'walk' && this.actions.walk) {
      this.actions.walk.setEffectiveTimeScale(
        THREE.MathUtils.clamp(this.speed / 1.9, 0.7, 1.5)
      );
    }

    this.mixer.update(dt);
  }

  /** Copy the simulated body into the mesh + contact shadow. */
  syncVisuals() {
    const p = this.body.position;
    this.group.position.set(p.x, p.y, p.z);
    this.group.quaternion.setFromAxisAngle(this._up, this.facing + MODEL_YAW);

    // Contact shadow: fades and shrinks as the character rises off the road.
    const cs = this.contactShadow;
    if (!cs) return;
    const height = Math.max(0, p.y - HALF);
    const fade = Math.max(0, 1 - height / 2.2);
    cs.visible = this.enabled && fade > 0.02;
    if (cs.visible) {
      cs.position.set(p.x, 0.02, p.z);
      const s = 1 - Math.min(0.45, height * 0.18);
      cs.scale.setScalar(s);
      cs.material.opacity = fade * 0.75;
    }
  }

  // ------------------------------------------------------------------ state
  teleport(position, facing = this.facing) {
    const b = this.body;
    b.position.set(position.x, position.y, position.z);
    b.velocity.setZero();
    b.angularVelocity.setZero();
    b.force.setZero();
    b.torque.setZero();
    b.previousPosition.copy(b.position);
    b.interpolatedPosition.copy(b.position);

    this.facing = facing;
    this._targetFacing = facing;
    this.grounded = false;
    this._jumping = false;
    this.syncVisuals();
  }

  enterVehicle() {
    this.enabled = false;
    this.group.visible = false;
    if (this.contactShadow) this.contactShadow.visible = false;
    this.body.collisionResponse = false;
    this.body.collisionFilterMask = 0;
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    if (this._actionName !== 'idle') this._fadeTo('idle');
  }

  exitVehicle(position, facing) {
    this.body.collisionResponse = true;
    this.body.collisionFilterMask = MASK.PLAYER;
    this.enabled = true;
    this.group.visible = true;
    this.teleport(position, facing);
  }

  followVehicle(chassisBody) {
    const p = chassisBody.position;
    this.body.position.set(p.x, p.y + 0.1, p.z);
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
  }

  get position() {
    return this.body.position;
  }

  get halfHeight() {
    return HALF;
  }

  getFocus(out = new THREE.Vector3()) {
    const p = this.body.position;
    return out.set(p.x, p.y + EYE, p.z);
  }
}

function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
