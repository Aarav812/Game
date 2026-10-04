import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { World } from './world.js';
import { Vehicle } from './vehicle.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { CameraRig } from './camera.js';
import { VehicleStateMachine, STATE } from './state.js';
import { SunFlare } from './sunflare.js';
import { Minimap } from './minimap.js';
import { WorldMap } from './worldmap.js';

/**
 * main.js
 * -------
 * Renderer, scene, environment, car, character and the Enter/Exit state machine.
 *
 * Rendering goes through an EffectComposer so a subtle SSAO pass can pick out
 * the curved silhouettes (domes, arches, rounded corners) that the old box city
 * did not have, followed by an OutputPass that applies tone mapping.
 */

const app = document.getElementById('app');
const loadingEl = document.getElementById('loading');

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// r186 removed PCFSoftShadowMap; PCFShadowMap + a shadow radius is the soft path.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // The minimap's second render() reuses the map instead of regenerating it.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

// ------------------------------------------------------------------- scene
const SKY = 0xa6c6dc;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
// Exponential distance fog matched to the sky/ocean horizon so the 2.5 km map
// fades into haze instead of popping in. Camera far = 3000 below.
scene.fog = new THREE.FogExp2(SKY, 0.00055);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 3000);
camera.position.set(24, 6, 48);
// Layer 1 carries the small instanced props (trees, lamps, hydrants). The main
// camera shows them; the radar camera deliberately does not.
camera.layers.enable(1);

// ------------------------------------------------------------------ lights
scene.add(new THREE.HemisphereLight(0xdcebff, 0x4a5a44, 0.85));

const sun = new THREE.DirectionalLight(0xfff3dd, 2.2);
sun.layers.enable(1); // props on layer 1 must still cast shadows
sun.position.set(80, 130, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 520;
sun.shadow.camera.left = -170;
sun.shadow.camera.right = 170;
sun.shadow.camera.top = 170;
sun.shadow.camera.bottom = -170;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.05;
sun.shadow.radius = 3; // softens the PCF kernel
scene.add(sun, sun.target);

// ------------------------------------------------------------------- world
const world = new World(scene);
const input = new Input(renderer.domElement);

const vehicle = new Vehicle(scene, world.physics, input, new THREE.Vector3(24, 0.9, 60));
const player = new Player(scene, world.physics, world.groundMaterial, new THREE.Vector3(24, 1.0, 57));

const cameraRig = new CameraRig(camera, world.physics);

// --------------------------------------------------------------------- UI
const promptEl = document.getElementById('prompt');
const lockHintEl = document.getElementById('lock-hint');
const hudEl = document.getElementById('hud');
const speedEl = document.getElementById('speed');
const alertEl = document.getElementById('alert');
let alertUntil = 0;

/** Flash a full-width alert banner (pedestrian struck, etc.). */
function showAlert(text, ms = 3000) {
  if (!alertEl) return;
  alertEl.textContent = text;
  alertEl.classList.add('visible');
  alertUntil = performance.now() + ms;
}

function pollNpcAlerts() {
  if (!alertEl) return;
  for (const a of world.pollAlerts()) {
    if (a.type === 'ped-hit') showAlert('⚠ PEDESTRIAN STRUCK — slow down!', 3200);
  }
  if (alertEl.classList.contains('visible') && performance.now() > alertUntil) {
    alertEl.classList.remove('visible');
  }
}

function applyHud(state) {
  if (state === STATE.DRIVING) {
    hudEl.innerHTML =
      '<div><b>W / S</b> drive &amp; reverse</div>' +
      '<div><b>A / D</b> steer</div>' +
      '<div><b>Space</b> handbrake &nbsp;&middot;&nbsp; <b>H</b> honk</div>' +
      '<div><b>F</b> exit &nbsp;&middot;&nbsp; <b>R</b> reset car</div>';
  } else {
    hudEl.innerHTML =
      '<div><b>W A S D</b> run</div>' +
      '<div><b>Space</b> jump</div>' +
      '<div><b>Mouse</b> look &mdash; click to capture</div>' +
      '<div><b>F</b> enter vehicle when close</div>';
  }
}

const state = new VehicleStateMachine({
  player,
  vehicle,
  cameraRig,
  camera,
  promptEl,
  onStateChange: applyHud,
});

// ------------------------------------------------------- post-processing
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));

// SSAO is the expensive pass, so it renders at half resolution and a modest
// kernel, then upscales. Subtle by design: it just catches the curves.
const AO_SCALE = 0.5;
const ssao = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight, 16);
ssao.kernelRadius = 6;
ssao.minDistance = 0.004;
ssao.maxDistance = 0.09;
composer.addPass(ssao);
composer.addPass(new OutputPass());

// A subtle, occlusion-aware sun flare (see sunflare.js).
const sunFlare = new SunFlare(camera, world.physics);
sunFlare.setSize(window.innerWidth, window.innerHeight);

// Top-right GTA-style radar (see minimap.js).
const minimap = new Minimap(renderer, scene, { size: 190, viewUnits: 230, margin: 20 });

// Full-screen World Map (M key)
const worldMap = new WorldMap(renderer, scene, {
  player,
  vehicle,
  minimap,
  cameraRig,
});
worldMap.init();

function sizeSSAO(w, h) {
  ssao.setSize(Math.max(2, Math.floor(w * AO_SCALE)), Math.max(2, Math.floor(h * AO_SCALE)));
}
sizeSSAO(window.innerWidth, window.innerHeight);

// ------------------------------------------------------------ sun follow
const SUN_OFFSET = new THREE.Vector3(80, 130, 60);
function updateSun(focus) {
  sun.position.set(focus.x + SUN_OFFSET.x, SUN_OFFSET.y, focus.z + SUN_OFFSET.z);
  sun.target.position.set(focus.x, 0, focus.z);
  sun.target.updateMatrixWorld();
}

// ------------------------------------------------------------------- loop
const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

const CAR_RESPAWN_Y = 0.9;
const PLAYER_RESPAWN_Y = 1.0;

/**
 * Safety net for the island: anything below the waterline is put back on the
 * nearest road-grid intersection. The car is checked first, because on foot the
 * player follows it while driving.
 */
function rescueDrowned() {
  const carPos = vehicle.position;
  if (world.isDrowned(carPos.y)) {
    const r = world.nearestRespawn(carPos.x, carPos.z);
    vehicle.teleport(new THREE.Vector3(r.x, CAR_RESPAWN_Y, r.z));
  }
  if (!state.driving) {
    const p = player.position;
    if (world.isDrowned(p.y)) {
      const r = world.nearestRespawn(p.x, p.z);
      player.teleport(new THREE.Vector3(r.x, PLAYER_RESPAWN_Y, r.z));
    }
  }
}

let last = performance.now();
let accumulator = 0;
let speedTimer = 0;
let running = false;

function frame(now) {
  requestAnimationFrame(frame);
  if (!running) return;

  // Guard against a rAF timestamp that lags performance.now(): a negative dt
  // would drive the accumulator negative and silently stall all physics.
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.25));
  last = now;

  // Toggle full-screen map with M key
  if (input.wasPressed('KeyM')) {
    worldMap.toggle();
  }

  // When map is open: pause physics, unlock pointer, update/render map only
  if (worldMap.isOpen) {
    worldMap.update(dt, input);
    worldMap.render();
    // Still update sun flare for background continuity
    sunFlare.update(sun.position);
    // Don't run physics, input, or main render
    input.endFrame();
    return;
  }

  cameraRig.rotate(input.mouseDX, input.mouseDY);
  state.update(input);
  const driving = state.driving;

  accumulator += dt;
  let steps = 0;
  while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
    vehicle.update(FIXED_STEP);
    if (driving) player.followVehicle(vehicle.chassisBody);
    else player.update(FIXED_STEP, input, cameraRig.yaw);
    world.step(FIXED_STEP);
    vehicle.postStep(FIXED_STEP);
    accumulator -= FIXED_STEP;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

  vehicle.syncVisuals();
  player.syncVisuals();
  player.updateAnimation(dt);

  const focus = driving ? vehicle.position : player.position;
  const cpos = vehicle.chassisBody.position;
  const cvel = vehicle.chassisBody.velocity;
  world.update(dt, {
    focusX: focus.x,
    focusZ: focus.z,
    focusYaw: driving ? vehicle.getForwardYaw() : player.facing,
    carX: cpos.x,
    carZ: cpos.z,
    carY: cpos.y,
    carSpeed: Math.hypot(cvel.x, cvel.z),
    carVelX: cvel.x,
    carVelZ: cvel.z,
    carYaw: vehicle.getForwardYaw(),
    driving,
    honk: driving && input.wasPressed('KeyH'),
    onFoot: !driving,
    playerX: player.position.x,
    playerZ: player.position.z,
  });
  pollNpcAlerts();
  rescueDrowned();
  cameraRig.update(dt, { driving, player, vehicle });
  updateSun(focus);
  sunFlare.update(sun.position);

  lockHintEl.classList.toggle('visible', !input.pointerLocked && !driving);

  speedTimer += dt;
  if (speedTimer > 0.1) {
    speedTimer = 0;
    const kmh = driving ? vehicle.speedKmh : player.speed * 3.6;
    speedEl.innerHTML = `${Math.round(kmh)} <span>km/h</span>`;
  }

  input.endFrame();
  // Raise once per frame so the shadow map updates exactly once (for the
  // composer pass); the minimap's second render() then reuses it without
  // regenerating — and without toggling shadowMap.enabled (which would
  // compile a second shader variant of every material).
  renderer.shadowMap.needsUpdate = true;
  composer.render();
  sunFlare.render(renderer);

  // Radar: focus the driven car, or the character on foot. While on foot the
  // parked car shows as a blip so it is always findable.
  if (driving) {
    minimap.update(dt, { x: vehicle.position.x, z: vehicle.position.z, yaw: vehicle.getForwardYaw() });
  } else {
    minimap.update(
      dt,
      { x: player.position.x, z: player.position.z, yaw: player.facing },
      { x: vehicle.position.x, z: vehicle.position.z }
    );
  }
  minimap.render();
}

// --------------------------------------------------------------- bootstrap
async function start() {
  // Snap the camera before the first present so we never see a fly-in.
  cameraRig.update(1, { driving: false, player, vehicle });
  player.syncVisuals(1);
  vehicle.syncVisuals();

  applyHud(STATE.ON_FOOT);
  await world.load();
  await player.loadModel();
  await vehicle.loadModel();
  applyHud(state.state);

  loadingEl.classList.add('hidden');
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);

  // Dev-only handle for inspecting the scene from the console/tests.
  if (import.meta.env.DEV) {
    window.__game = { scene, world, vehicle, player, state, camera, cameraRig, renderer, composer, input, sunFlare, minimap };
  }
}

requestAnimationFrame(frame); // keeps the loop warm; `running` gates the work
start();

// ----------------------------------------------------------------- resize
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  sizeSSAO(w, h);
  sunFlare.setSize(w, h);
});
