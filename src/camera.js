import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP } from './collision.js';

/**
 * CameraRig
 * ---------
 * One camera, two behaviours:
 *   - ON_FOOT : mouse-controlled third-person orbit around the player, with a
 *               raycast so the camera does not clip through buildings.
 *   - DRIVING : the damped chase camera behind the car.
 *
 * Both modes damp toward their target, so switching between them reads as a
 * smooth glide instead of a cut.
 */

const ORBIT_LAMBDA = 5.5;  // position follow, on foot (soft, no snapping on turns)
const DRIVE_LAMBDA = 4.2;  // position follow, driving
const LOOK_LAMBDA = 4.5;   // look-at follow (slower = calmer camera on turns)
const SENSITIVITY = 0.0022;
const PITCH_MIN = -0.45;
const PITCH_MAX = 1.15;
const WALL_PAD = 0.35;

// GTA-style over-the-shoulder rig: 2.2 up and 4.5 back from the character, with
// a lateral shoulder bias so the character sits slightly off-centre.
const CAM_HEIGHT = 2.2;
const CAM_BACK = 4.5;
const CAM_SHOULDER = 0.55;
const PITCH_LIFT = 3.2;
const LOOK_HEIGHT = 0.4;

const CHASE_OFFSET = new THREE.Vector3(0, 3.1, -7.2); // car-local: behind + above
const CHASE_LOOK = new THREE.Vector3(0, 0.9, 4.0);

export class CameraRig {
  constructor(camera, physics) {
    this.camera = camera;
    this.physics = physics;

    this.yaw = Math.PI;   // start looking down +Z (toward the car)
    this.pitch = 0.3;

    this._focus = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._quat = new THREE.Quaternion();

    this._initialised = false;

    this._from = new CANNON.Vec3();
    this._to = new CANNON.Vec3();
    this._result = new CANNON.RaycastResult();
  }

  /** Accumulate a mouse delta into the orbit angles. */
  rotate(dx, dy) {
    this.yaw -= dx * SENSITIVITY;
    this.pitch = clamp(this.pitch + dy * SENSITIVITY, PITCH_MIN, PITCH_MAX);
  }

  /** Point the orbit camera along a given horizontal direction. */
  aimToDirection(x, z) {
    this.yaw = Math.atan2(-x, -z);
  }

  update(dt, { driving, player, vehicle }) {
    if (driving) {
      const p = vehicle.chassisBody.position;
      const q = vehicle.chassisBody.quaternion;
      this._focus.set(p.x, p.y, p.z);
      this._quat.set(q.x, q.y, q.z, q.w);
      this._desired.copy(CHASE_OFFSET).applyQuaternion(this._quat).add(this._focus);
      this._desiredLook.copy(CHASE_LOOK).applyQuaternion(this._quat).add(this._focus);
      this._follow(dt, DRIVE_LAMBDA);
      return;
    }

    // ON_FOOT: over-the-shoulder rig. The camera sits CAM_BACK behind and
    // CAM_HEIGHT above the character, offset CAM_SHOULDER to the right; the look
    // target carries the same lateral bias, which is what pushes the character
    // off-centre for the GTA read.
    player.getFocus(this._focus);

    const backX = Math.sin(this.yaw);
    const backZ = Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);

    const lift = Math.sin(this.pitch) * PITCH_LIFT;
    const squash = Math.cos(THREE.MathUtils.clamp(this.pitch, -0.6, 0.6));
    const back = CAM_BACK * squash;

    this._desired.set(
      this._focus.x + rightX * CAM_SHOULDER + backX * back,
      this._focus.y + CAM_HEIGHT + lift,
      this._focus.z + rightZ * CAM_SHOULDER + backZ * back
    );

    this._avoidWalls();

    this._desiredLook.set(
      this._focus.x + rightX * CAM_SHOULDER,
      this._focus.y + LOOK_HEIGHT,
      this._focus.z + rightZ * CAM_SHOULDER
    );
    this._follow(dt, ORBIT_LAMBDA);
  }

  /** Pull the camera in if something solid sits between it and the character. */
  _avoidWalls() {
    this._from.set(this._focus.x, this._focus.y, this._focus.z);
    this._to.set(this._desired.x, this._desired.y, this._desired.z);
    this._result.reset();
    this.physics.raycastClosest(
      this._from,
      this._to,
      { collisionFilterMask: GROUP.WORLD, skipBackfaces: true },
      this._result
    );

    if (!this._result.hasHit) return;

    // Clamp the camera along the focus -> desired ray, just short of the hit.
    this._dir.set(
      this._desired.x - this._focus.x,
      this._desired.y - this._focus.y,
      this._desired.z - this._focus.z
    );
    const full = this._dir.length();
    if (full < 1e-4) return;
    this._dir.multiplyScalar(1 / full);

    const dist = Math.max(0.6, this._result.distance - WALL_PAD);
    this._desired.copy(this._dir).multiplyScalar(dist).add(this._focus);
  }

  _follow(dt, lambda) {
    const posT = 1 - Math.exp(-lambda * dt);
    const lookT = 1 - Math.exp(-LOOK_LAMBDA * dt);

    this.camera.position.lerp(this._desired, posT);

    if (this._initialised) {
      this._lookAt.lerp(this._desiredLook, lookT);
    } else {
      this._lookAt.copy(this._desiredLook);
      this._initialised = true;
    }
    this.camera.lookAt(this._lookAt);
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
