import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GROUP, MASK } from './collision.js';
import { CAR } from './models.js';

/**
 * Vehicle
 * -------
 * A drivable car: CANNON.RaycastVehicle for the physics, and a real low-poly
 * GLTF body for the visuals.
 *
 * The Kenney kit model ships the body and all four wheels as separate nodes
 * (wheel-front-left, wheel-back-right, ...), so the wheels can be driven
 * independently from the raycast wheel transforms — which gives steering yaw on
 * the front pair and rolling spin on all four for free.
 *
 * Conventions: the chassis' visual "front" is local +Z. The car model is
 * authored the same way (its wheels sit at ±z for front/rear), so no yaw
 * correction is needed.
 *
 * Implementation notes (these keep the arcade handling stable):
 *  - Drive is AWD. Driving only the rear axle makes this raycast model
 *    wheelie and backflip immediately.
 *  - Braking is applied as a force at the centre of mass rather than with
 *    setBrake(), because a wheel-lock impulse at the contact patch nose-dives
 *    the car into an endo.
 *  - Air drag (quadratic) caps the top speed; downforce keeps it planted.
 *  - A light pitch/roll damping assist runs while at least one wheel is grounded.
 */

// Geometry is derived from the source asset so the physics wheels line up with
// the modelled wheel arches. See CAR in models.js.
const S = CAR.length / CAR.model.length;          // uniform scale: model -> world
const WHEEL_RADIUS = CAR.model.wheelRadius * S;
const WHEEL_HALF_WIDTH = 0.175 * S;
const WHEEL_X = CAR.model.wheelX * S;
const FRONT_Z = CAR.model.wheelZ * S;
const REAR_Z = -CAR.model.wheelZ * S;
const HUB_Y = CAR.model.hubY * S;                  // wheel centre above the model's ground

const CHASSIS_HALF = new CANNON.Vec3(0.9, 0.62, CAR.length / 2 - 0.05);
const CHASSIS_OFFSET = new CANNON.Vec3(0, 0.1, 0);
const CHASSIS_MASS = 150;

const WHEEL_Y = 0;               // suspension mount height in the body frame
const REST_LENGTH = 0.35;

const FORWARD_SIGN = -1; // engine force sign that drives the car toward local +Z
const STEER_SIGN = 1;    // steering sign that turns the car left

const ENGINE_FORCE = 550;
const REVERSE_FORCE = 80;
const BRAKE_DECEL = 9;
const HANDBRAKE_DECEL = 14;
const DRAG = 2.3;
const DOWNFORCE = 0.35;

const MAX_STEER = 0.5;
const STEER_FALLOFF = 0.045;
const STEER_RATE = 12;

const GRIP = 3.0;
const HANDBRAKE_GRIP = 0.7;
const STABILITY = 6;

// Ride height guess used until the car settles and self-calibrates.
const NOMINAL_RIDE = WHEEL_RADIUS + REST_LENGTH - WHEEL_Y - 0.05;

export class Vehicle {
  constructor(scene, physicsWorld, input, spawn = new THREE.Vector3(20, 0.85, 20)) {
    this.scene = scene;
    this.physics = physicsWorld;
    this.input = input;
    this.spawn = spawn.clone();
    this.speedKmh = 0;
    this._steer = 0;

    this.enabled = true;
    this.parkingBrake = false;
    this._playerCollision = true;

    this.scale = S;
    this.modelReady = false;
    this._rideOffset = -NOMINAL_RIDE;
    this._calibrated = false;
    this._calibrationFrames = 0;

    // Wheel bookkeeping
    this.wheelModels = [];   // { mesh, hub: THREE.Vector3 }
    this._wheelMap = [];     // raycast wheel index -> wheelModels index

    // Scratch
    this._cq = new THREE.Quaternion();
    this._cqInv = new THREE.Quaternion();
    this._cp = new THREE.Vector3();
    this._wp = new THREE.Vector3();
    this._wq = new THREE.Quaternion();

    this._createPhysics();
    this._createVisual();
    this.reset();
  }

  // ---------------------------------------------------------------- physics
  _createPhysics() {
    this.chassisBody = new CANNON.Body({
      mass: CHASSIS_MASS,
      angularDamping: 0.4,
      linearDamping: 0,
      collisionFilterGroup: GROUP.VEHICLE,
      collisionFilterMask: MASK.VEHICLE,
    });
    this.chassisBody.addShape(new CANNON.Box(CHASSIS_HALF), CHASSIS_OFFSET);
    this.chassisBody.position.set(this.spawn.x, this.spawn.y, this.spawn.z);

    this.raycastVehicle = new CANNON.RaycastVehicle({
      chassisBody: this.chassisBody,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    const makeWheel = (x, z) => ({
      radius: WHEEL_RADIUS,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: 35,
      suspensionRestLength: REST_LENGTH,
      frictionSlip: GRIP,
      dampingRelaxation: 2.5,
      dampingCompression: 4.5,
      maxSuspensionForce: 100000,
      rollInfluence: 0.015,
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(x, WHEEL_Y, z),
      maxSuspensionTravel: 0.3,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    });

    // Order: front-left(+x), front-right(-x), rear-left(+x), rear-right(-x).
    this.raycastVehicle.addWheel(makeWheel(WHEEL_X, FRONT_Z));
    this.raycastVehicle.addWheel(makeWheel(-WHEEL_X, FRONT_Z));
    this.raycastVehicle.addWheel(makeWheel(WHEEL_X, REAR_Z));
    this.raycastVehicle.addWheel(makeWheel(-WHEEL_X, REAR_Z));
    this.raycastVehicle.addToWorld(this.physics);

    this.frontWheels = [0, 1];
    this.rearWheels = [2, 3];
  }

  // ----------------------------------------------------------------- visual
  _createVisual() {
    // Placed at the chassis transform; the model and wheels are children.
    this.group = new THREE.Group();
    this.scene.add(this.group);
  }

  /**
   * Load the car GLB, split body from wheels, re-centre each wheel's geometry on
   * its hub (the source nodes pivot at the tyre's inner face), and match the four
   * modelled wheels to the raycast wheel indices.
   */
  async loadModel() {
    const gltf = await new GLTFLoader().loadAsync(CAR.url);
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    const bodyNodes = [];
    const wheelNodes = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) {
        o.material.roughness = 0.62;
        o.material.metalness = 0.12;
      }
      if (/^wheel/i.test(o.name || '')) wheelNodes.push(o);
      else bodyNodes.push(o);
    });

    // Body: kept as authored, wrapped so it can be scaled and offset as a unit.
    const bodyGroup = new THREE.Group();
    for (const n of bodyNodes) {
      n.position.copy(n.position); // keep authored offsets
      bodyGroup.add(n);
    }
    this.bodyGroup = bodyGroup;
    this.group.add(bodyGroup);

    // Wheels: re-centre geometry so the hub is the rotation pivot.
    for (const node of wheelNodes) {
      const geo = node.geometry;
      geo.computeBoundingBox();
      const c = geo.boundingBox.getCenter(new THREE.Vector3());
      geo.translate(-c.x, -c.y, -c.z);
      geo.computeBoundingSphere();

      // Hub in model space, then scaled into the chassis frame.
      const hub = new THREE.Vector3(
        node.position.x + c.x,
        node.position.y + c.y,
        node.position.z + c.z
      ).multiplyScalar(S);

      node.position.set(0, 0, 0);
      node.scale.setScalar(S);
      this.group.add(node);
      this.wheelModels.push({ mesh: node, hub, name: node.name });
    }

    // Match each modelled wheel to the nearest raycast wheel by hub position.
    this._wheelMap = this.raycastVehicle.wheelInfos.map((w) => {
      const cp = w.chassisConnectionPointLocal;
      let best = -1;
      let bestD = Infinity;
      this.wheelModels.forEach((m, i) => {
        const d = Math.hypot(m.hub.x - cp.x, m.hub.z - cp.z);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    });

    this.bodyGroup.scale.setScalar(S);
    this.bodyGroup.position.y = this._rideOffset;

    this.modelReady = true;
    return this;
  }

  // ---------------------------------------------------------------- control
  setControlEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      this._steer = 0;
      this.raycastVehicle.setSteeringValue(0, 0);
      this.raycastVehicle.setSteeringValue(0, 1);
    }
  }

  setParkingBrake(on) {
    this.parkingBrake = !!on;
  }

  /**
   * Toggle whether the car is solid to the on-foot player.
   *
   * On foot the car must be a real obstacle. During the Enter/Exit transition it
   * is switched off for a moment so the solver cannot shove the player out while
   * they are being moved into (or out of) the cabin.
   */
  setPlayerCollision(enabled) {
    this._playerCollision = !!enabled;
    this.chassisBody.collisionFilterMask = enabled ? MASK.VEHICLE : GROUP.WORLD;
  }

  getForwardYaw() {
    const f = new CANNON.Vec3(0, 0, 1);
    this.chassisBody.quaternion.vmult(f, f);
    return Math.atan2(f.x, f.z);
  }

  /** Put the car back at the spawn point, upright and at rest. */
  reset() {
    const b = this.chassisBody;
    b.position.set(this.spawn.x, this.spawn.y, this.spawn.z);
    b.quaternion.set(0, 0, 0, 1);
    b.velocity.setZero();
    b.angularVelocity.setZero();
    b.force.setZero();
    b.torque.setZero();
    b.previousPosition.set(this.spawn.x, this.spawn.y, this.spawn.z);
    b.interpolatedPosition.set(this.spawn.x, this.spawn.y, this.spawn.z);
    b.initPosition.set(this.spawn.x, this.spawn.y, this.spawn.z);

    this._steer = 0;
    for (const w of this.raycastVehicle.wheelInfos) {
      w.suspensionLength = w.suspensionRestLength;
      w.steering = 0;
      w.deltaRotation = 0;
      w.rotation = 0;
      w.sliding = false;
    }
    for (let i = 0; i < 4; i++) {
      this.raycastVehicle.setBrake(0, i);
      this.raycastVehicle.setSteeringValue(0, i);
      this.raycastVehicle.applyEngineForce(0, i);
      this.raycastVehicle.wheelInfos[i].frictionSlip = GRIP;
    }
  }

  /**
   * Drop the car upright at an arbitrary point and make that the new spawn —
   * used when it ends up in the sea and has to be put back on land.
   */
  teleport(position) {
    this.spawn.set(position.x, position.y, position.z);
    this.reset();
  }

  // ------------------------------------------------------------------- step
  /** Read input and apply forces. Must run BEFORE world.step(). */
  update(dt) {
    const { input, chassisBody, raycastVehicle } = this;

    if (this.enabled && input.wasPressed('KeyR')) this.reset();

    const v = chassisBody.velocity;
    const speed = Math.hypot(v.x, v.z);

    const fwd = new CANNON.Vec3(0, 0, 1);
    chassisBody.quaternion.vmult(fwd, fwd);
    const forwardSpeed = v.dot(fwd);

    const active = this.enabled && !this.parkingBrake;
    const forward = active && (input.isDown('KeyW') || input.isDown('ArrowUp'));
    const backward = active && (input.isDown('KeyS') || input.isDown('ArrowDown'));
    const left = active && (input.isDown('KeyA') || input.isDown('ArrowLeft'));
    const right = active && (input.isDown('KeyD') || input.isDown('ArrowRight'));
    const handbrake = this.parkingBrake || (active && input.isDown('Space'));

    let engine = 0;
    let brakeDecel = 0;
    if (forward) {
      if (forwardSpeed < -0.5) brakeDecel = BRAKE_DECEL;
      else engine = ENGINE_FORCE;
    }
    if (backward) {
      if (forwardSpeed > 0.5) brakeDecel = BRAKE_DECEL;
      else engine = -REVERSE_FORCE;
    }
    if (handbrake) brakeDecel = HANDBRAKE_DECEL;

    for (let i = 0; i < 4; i++) {
      raycastVehicle.applyEngineForce(engine * FORWARD_SIGN, i);
      raycastVehicle.setBrake(0, i);
      raycastVehicle.wheelInfos[i].frictionSlip = handbrake && i >= 2 ? HANDBRAKE_GRIP : GRIP;
    }

    const maxSteer = MAX_STEER / (1 + speed * STEER_FALLOFF);
    const target = (left ? maxSteer : 0) + (right ? -maxSteer : 0);
    this._steer += (target - this._steer) * Math.min(1, dt * STEER_RATE);
    raycastVehicle.setSteeringValue(this._steer * STEER_SIGN, 0);
    raycastVehicle.setSteeringValue(this._steer * STEER_SIGN, 1);

    const force = new CANNON.Vec3(
      -v.x * DRAG * speed,
      -DOWNFORCE * speed * speed,
      -v.z * DRAG * speed
    );
    if (brakeDecel > 0 && speed > 0.05) {
      const f = Math.min(brakeDecel, speed / dt) * CHASSIS_MASS;
      force.x -= (v.x / speed) * f;
      force.z -= (v.z / speed) * f;
    }
    chassisBody.applyForce(force);
  }

  /** Post-step physics correction: stability assist. Runs once per fixed step. */
  postStep(dt) {
    // NOTE: use suspension force rather than wheel.isInContact. cannon's
    // updateWheelTransformWorld() clears isInContact, and syncVisuals() calls it
    // every frame for the wheel meshes — so the flag is only trustworthy between
    // world.step() and the next visual sync.
    const grounded = this.raycastVehicle.wheelInfos.some((w) => w.suspensionForce > 0);
    if (grounded) {
      const f = Math.exp(-STABILITY * dt);
      this.chassisBody.angularVelocity.x *= f;
      this.chassisBody.angularVelocity.z *= f;
    }
  }

  /** Copy the simulated state into the meshes. Runs once per rendered frame. */
  syncVisuals() {
    const { position, quaternion } = this.chassisBody;
    this.group.position.set(position.x, position.y, position.z);
    this.group.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    this.speedKmh = this.chassisBody.velocity.length() * 3.6;

    if (!this.modelReady) return;

    // One-time ride-height calibration: once the car is settled on the ground,
    // drop the model so its wheels sit exactly on the road surface.
    if (!this._calibrated) {
      const grounded = this.raycastVehicle.wheelInfos.filter((w) => w.suspensionForce > 0).length >= 2;
      if (grounded && this.chassisBody.velocity.length() < 0.6) {
        this._calibrationFrames++;
        if (this._calibrationFrames > 20) {
          this._rideOffset = -position.y;
          this.bodyGroup.position.y = this._rideOffset;
          this._calibrated = true;
        }
      }
    }

    // Wheels: the raycast transform already carries steering yaw (front pair) and
    // rolling spin (all four), so map it into the chassis frame and apply it.
    this._cq.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    this._cqInv.copy(this._cq).invert();
    this._cp.set(position.x, position.y, position.z);

    for (let i = 0; i < 4; i++) {
      this.raycastVehicle.updateWheelTransform(i);
      const entry = this.wheelModels[this._wheelMap[i]];
      if (!entry) continue;
      const t = this.raycastVehicle.wheelInfos[i].worldTransform;

      this._wp.set(t.position.x, t.position.y, t.position.z).sub(this._cp).applyQuaternion(this._cqInv);
      entry.mesh.position.copy(this._wp);
      this._wq.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
      entry.mesh.quaternion.copy(this._cqInv).multiply(this._wq);
    }
  }

  get position() {
    return this.chassisBody.position;
  }
}
