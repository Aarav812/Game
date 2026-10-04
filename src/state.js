import * as THREE from 'three';

/**
 * state.js
 * --------
 * Enter / Exit vehicle state machine.
 *
 *   ON_FOOT  -> walk around; near the car show a floating "[F] Enter Vehicle"
 *   DRIVING  -> car controls; [F] exits, but only below 15 km/h
 *
 * Only two things are truly stateful here: which controller receives input, and
 * the camera mode. Everything else (prompt, handbrake, mesh visibility, player
 * collision) is derived at the moment of transition.
 */

export const STATE = {
  ON_FOOT: 'ON_FOOT',
  DRIVING: 'DRIVING',
};

const ENTER_RANGE = 3.5;          // metres from the car that [F] works
const EXIT_MAX_SPEED_KMH = 15;    // safety threshold for bailing out
const EXIT_OFFSET = 2.0;          // metres to the car's left
const PROMPT_HEIGHT = 1.9;        // world height above the car for the label
const WARN_MS = 1200;
// How long the car stays non-solid to the player while they climb in or step
// out. Long enough to cover the move, short enough to be imperceptible.
const TRANSITION_MS = 350;

export class VehicleStateMachine {
  constructor({ player, vehicle, cameraRig, camera, promptEl, onStateChange }) {
    this.player = player;
    this.vehicle = vehicle;
    this.cameraRig = cameraRig;
    this.camera = camera;

    this.promptEl = promptEl;
    this.onStateChange = onStateChange || (() => {});

    this.state = STATE.ON_FOOT;
    this._promptVisible = false;
    this._warningUntil = 0;
    this._transitionUntil = 0;

    // The game starts on foot, so the car must start locked and parked.
    // Without this the vehicle's controls are live from frame 0 and holding W
    // while walking would also drive the car away.
    this.vehicle.setControlEnabled(false);
    this.vehicle.setParkingBrake(true);

    // Scratch
    this._up = new THREE.Vector3(0, 1, 0);
    this._fwd = new THREE.Vector3();
    this._left = new THREE.Vector3();
    this._point = new THREE.Vector3();
    this._ndc = new THREE.Vector3();

    // Let the HUD render the state we start in.
    this.onStateChange(this.state);
  }

  get driving() {
    return this.state === STATE.DRIVING;
  }

  /** Run once per frame, before the physics steps. */
  update(input) {
    // Re-arm the car's collision with the player once the enter/exit move has
    // finished. It is switched off during the transition so the solver cannot
    // eject the player while they are being moved into or out of the cabin.
    if (this._transitionUntil && performance.now() >= this._transitionUntil) {
      this._transitionUntil = 0;
      this.vehicle.setPlayerCollision(true);
    }

    if (this.state === STATE.ON_FOOT) {
      const near = this.distanceToCar() <= ENTER_RANGE;
      if (near && input.wasPressed('KeyF')) {
        this._enter();
      } else {
        this._renderPrompt(near, '[F] Enter Vehicle', false);
      }
      return;
    }

    // DRIVING
    if (input.wasPressed('KeyF')) {
      if (this.vehicle.speedKmh < EXIT_MAX_SPEED_KMH) {
        this._exit();
        return;
      }
      this._warningUntil = performance.now() + WARN_MS;
    }

    const warning = performance.now() < this._warningUntil;
    this._renderPrompt(warning, '[!] Slow down to exit', true);
  }

  distanceToCar() {
    const p = this.player.position;
    const c = this.vehicle.chassisBody.position;
    return Math.hypot(p.x - c.x, p.z - c.z);
  }

  // --------------------------------------------------------------- ON_FOOT
  _enter() {
    // Make the car non-solid to the player for the climb-in, so the solver
    // cannot shove the capsule out as it is moved into the cabin.
    this.vehicle.setPlayerCollision(false);
    this.player.enterVehicle();
    this.vehicle.setControlEnabled(true);
    this.vehicle.setParkingBrake(false);
    this._setState(STATE.DRIVING);
  }

  // --------------------------------------------------------------- DRIVING
  _exit() {
    const yaw = this.vehicle.getForwardYaw();
    this._fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    this._left.crossVectors(this._up, this._fwd).normalize();

    const c = this.vehicle.chassisBody.position;
    const drop = new THREE.Vector3(
      c.x + this._left.x * EXIT_OFFSET,
      this.player.halfHeight + 0.05,
      c.z + this._left.z * EXIT_OFFSET
    );

    this.player.exitVehicle(drop, yaw);

    // Park the car so it does not roll away while the player walks off.
    this.vehicle.setParkingBrake(true);

    // Keep the car non-solid across the step-out, then re-arm it (see update()).
    this.vehicle.setPlayerCollision(false);
    this._transitionUntil = performance.now() + TRANSITION_MS;

    // Camera behind the player, looking the way the car was facing.
    this.cameraRig.aimToDirection(this._fwd.x, this._fwd.z);
    this.cameraRig.pitch = 0.3;

    this._setState(STATE.ON_FOOT);
  }

  _setState(next) {
    this.state = next;
    this.onStateChange(next);
  }

  // ---------------------------------------------------------------- prompt
  /** Project a world point above the car to the screen and place the label. */
  _renderPrompt(show, text, warn) {
    if (!show) {
      if (this._promptVisible) {
        this._promptVisible = false;
        this.promptEl.classList.remove('visible');
      }
      return;
    }

    const c = this.vehicle.chassisBody.position;
    this._point.set(c.x, c.y + PROMPT_HEIGHT, c.z);
    this._ndc.copy(this._point).project(this.camera);

    // Hide when behind the camera.
    if (this._ndc.z > 1 || this._ndc.z < -1) {
      this.promptEl.classList.remove('visible');
      this._promptVisible = false;
      return;
    }

    const x = (this._ndc.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this._ndc.y * 0.5 + 0.5) * window.innerHeight;

    this.promptEl.textContent = text;
    this.promptEl.classList.toggle('warn', !!warn);
    this.promptEl.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    this.promptEl.classList.add('visible');
    this._promptVisible = true;
  }
}
