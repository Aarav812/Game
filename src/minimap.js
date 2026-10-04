import * as THREE from 'three';

/**
 * minimap.js
 * ----------
 * GTA-style radar in the top-right corner.
 *
 * Two passes per frame, both on the EXISTING WebGL context:
 *
 *   A. the world is rendered top-down into a small WebGLRenderTarget with a
 *      dedicated OrthographicCamera that tracks the focus point and rolls with
 *      its heading, so "forward" is always up on the radar.
 *   B. a tiny HUD scene (a circular-masked quad sampling that target, plus the
 *      player arrow and any blips) is composited into the top-right corner of
 *      the main canvas with a scissor rect and viewport.
 *
 * Nothing here goes through EffectComposer, so the radar never pays for SSAO,
 * bloom or the OutputPass. The shadow map is rendered exactly once per frame
 * (for the main view) and then reused by the radar pass — no second shadow
 * pass, no toggling shadowMap.enabled (which would recompile shaders). The
 * radar camera's frustum is only ~230 units wide, so three's own frustum
 * culling throws away almost the entire 2.5 km world for free.
 *
 * The glass ring, tick marks and the 'N' marker are DOM elements in index.html;
 * 'N' is positioned by projecting world-north through the radar camera each
 * frame, so it always matches what is actually drawn.
 */

const RT_SIZE = 256;
const _v = new THREE.Vector3();

function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Minimap {
  constructor(renderer, scene, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.size = opts.size ?? 190;          // radar diameter in CSS px
    this.viewUnits = opts.viewUnits ?? 230; // world units across the radar
    this.margin = opts.margin ?? 20;

    this.follow = null;
    this._yaw = 0;
    this._northEl = document.getElementById('minimap-n');
    this._buildTicks();

    // ---------------------------------------------------- pass A: the world
    this.rt = new THREE.WebGLRenderTarget(RT_SIZE, RT_SIZE, {
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    const half = this.viewUnits / 2;
    this.cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 700);
    this.cam.up.set(0, 0, 1); // world +Z reads "up" before the heading roll

    // ---------------------------------------------------- pass B: the HUD
    this.hud = new THREE.Scene();
    const s = this.size;
    this.hudCam = new THREE.OrthographicCamera(-s / 2, s / 2, s / 2, -s / 2, -10, 10);

    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(s, s),
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: this.rt.texture },
          uTint: { value: new THREE.Color(0x0a0d12) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          uniform vec3 uTint;
          varying vec2 vUv;
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r2 = dot(p, p);
            // Circular alpha mask, feathered so the rim is smooth.
            float a = 1.0 - smoothstep(0.80, 0.985, r2);
            if (a <= 0.003) discard;
            vec3 c = texture2D(uMap, vUv).rgb;
            c = mix(c, uTint, 0.18);                       // glass tint
            c *= 1.0 - smoothstep(0.30, 1.0, r2) * 0.42;   // vignette
            // The target holds LINEAR light (it never went through OutputPass),
            // so convert to sRGB by hand or the radar renders far too dark.
            c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
            gl_FragColor = vec4(c, a);
          }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
    );
    quad.renderOrder = 0;
    this.hud.add(quad);

    // Centre arrow: the player/vehicle, always pointing up the radar.
    this.playerBlip = this._triangle(0xffd166);
    this.hud.add(this.playerBlip);

    // Parked-vehicle blip (only while on foot).
    this.carBlip = new THREE.Group();
    // NOTE: blips must be transparent materials. The radar quad (the circular
    // world image) is transparent, and three.js always draws the opaque pass
    // before the transparent pass — an opaque blip would render first and be
    // completely covered by the opaque centre of the quad.
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 20),
      new THREE.MeshBasicMaterial({ color: 0x0a0d12, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false })
    );
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(5.5, 20),
      new THREE.MeshBasicMaterial({ color: 0x6fd3ff, transparent: true, toneMapped: false, depthTest: false, depthWrite: false })
    );
    halo.renderOrder = 2;
    dot.renderOrder = 3;
    this.carBlip.add(halo, dot);
    this.carBlip.renderOrder = 2;
    this.carBlip.visible = false;
    this.hud.add(this.carBlip);

    // Waypoint blip (custom GPS marker from full-screen map)
    this.waypointBlip = this._createWaypointBlip();
    this.hud.add(this.waypointBlip);
    this.waypoint = null; // { x, z } in world coords
  }

  _createWaypointBlip() {
    const group = new THREE.Group();
    // Outer pulsing ring
    const ringGeo = new THREE.RingGeometry(8, 10, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xb87aff,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 5;

    // Inner arrow triangle pointing up (will be rotated to face waypoint)
    const arrowGeo = new THREE.BufferGeometry();
    arrowGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 12, 0, -7, -4, 0, 7, -4, 0], 3)
    );
    const arrowMat = new THREE.MeshBasicMaterial({
      color: 0xb87aff,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    arrow.rotation.x = -Math.PI / 2;
    arrow.renderOrder = 6;

    group.add(ring, arrow);
    group.visible = false;
    return group;
  }

  // ------------------------------------------------------------------ setup
  _buildTicks() {
    const host = document.getElementById('minimap');
    if (!host || host.querySelector('.tick')) return;
    for (let i = 0; i < 8; i++) {
      const t = document.createElement('div');
      t.className = 'tick';
      t.style.transform = `rotate(${i * 45}deg) translateY(-${this.size / 2 - 2}px)`;
      host.appendChild(t);
    }
  }

  _triangle(color) {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 10, 0, -6.5, -7, 0, 6.5, -7, 0], 3)
    );
    const m = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      // Transparent so it sorts into the transparent pass with the radar quad
      // (renderOrder 4 keeps it on top); toneMapped:false keeps it a crisp,
      // saturated GTA-yellow instead of being dimmed by ACES.
      transparent: true,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 4;
    return mesh;
  }

  // ----------------------------------------------------------------- update
  /**
   * @param dt   seconds
   * @param focus { x, z, yaw }  - the player or the car being driven
   * @param parked { x, z } | null - the parked car, shown only while on foot
   */
  update(dt, focus, parked = null) {
    if (!this.follow) this.follow = { x: focus.x, z: focus.z };
    const k = 1 - Math.exp(-dt * 9);
    this.follow.x += (focus.x - this.follow.x) * k;
    this.follow.z += (focus.z - this.follow.z) * k;
    this._yaw = angleLerp(this._yaw, focus.yaw, 1 - Math.exp(-dt * 9));

    // Top-down camera, rolled so the focus heading points up the radar.
    this.cam.position.set(this.follow.x, 340, this.follow.z);
    this.cam.up.set(0, 0, 1);
    this.cam.lookAt(this.follow.x, 0, this.follow.z);
    this.cam.rotateZ(this._yaw);
    this.cam.updateMatrixWorld(true);

    // Parked-vehicle blip, in the radar's own (rotating) frame.
    if (parked) {
      const dx = parked.x - this.follow.x;
      const dz = parked.z - this.follow.z;
      const fx = Math.sin(this._yaw);
      const fz = Math.cos(this._yaw);
      const rx = Math.cos(this._yaw);
      const rz = -Math.sin(this._yaw);
      const fwd = dx * fx + dz * fz;
      const right = dx * rx + dz * rz;
      const scale = this.size / this.viewUnits;
      let bx = right * scale;
      let by = fwd * scale;
      const rim = this.size / 2 - 15;
      const len = Math.hypot(bx, by);
      if (len > rim) { bx = (bx / len) * rim; by = (by / len) * rim; }
      this.carBlip.position.set(bx, by, 0);
      this.carBlip.visible = true;
    } else {
      this.carBlip.visible = false;
    }

    // Waypoint blip (custom GPS marker from full-screen map)
    if (this.waypoint) {
      const dx = this.waypoint.x - this.follow.x;
      const dz = this.waypoint.z - this.follow.z;
      const dist = Math.hypot(dx, dz);
      const fx = Math.sin(this._yaw);
      const fz = Math.cos(this._yaw);
      const rx = Math.cos(this._yaw);
      const rz = -Math.sin(this._yaw);
      const fwd = dx * fx + dz * fz;
      const right = dx * rx + dz * rz;
      const scale = this.size / this.viewUnits;
      let bx = right * scale;
      let by = fwd * scale;
      const rim = this.size / 2 - 15;
      const len = Math.hypot(bx, by);

      if (len > rim) {
        // Outside radar range: show as directional arrow on the rim
        const angle = Math.atan2(bx, by);
        bx = Math.sin(angle) * rim;
        by = Math.cos(angle) * rim;
        this.waypointBlip.rotation.z = -angle;
        this.waypointBlip.scale.setScalar(1);
      } else {
        // Inside radar range: show at actual position, arrow points to waypoint
        this.waypointBlip.rotation.z = 0;
        this.waypointBlip.scale.setScalar(0.7);
      }
      this.waypointBlip.position.set(bx, by, 0);
      this.waypointBlip.visible = true;
    } else {
      this.waypointBlip.visible = false;
    }

    this._updateNorth();
  }

  /** Project world north and slide the 'N' marker around the rim to match. */
  _updateNorth() {
    const el = this._northEl;
    if (!el) return;
    _v.set(this.follow.x, 0, this.follow.z - 60).project(this.cam);
    const len = Math.hypot(_v.x, _v.y) || 1;
    const R = this.size / 2 - 14;
    const px = (_v.x / len) * R;
    const py = -(_v.y / len) * R; // CSS y grows downward
    el.style.transform = `translate(calc(-50% + ${px.toFixed(1)}px), calc(-50% + ${py.toFixed(1)}px))`;
  }

  // ------------------------------------------------------------------ render
  /**
   * The radar's world pass is the expensive half (~480k triangles of city), so
   * it runs at half rate — a GTA radar does not need 60 Hz world updates, and
   * the follow/camera smoothing keeps it looking continuous. The cheap HUD pass
   * (circular mask + blips + 'N') still runs every frame.
   */
  render() {
    this._frame = (this._frame || 0) + 1;
    if (this._frame % (this.worldInterval || 2) === 0) this._renderWorld();
    this._renderHud();
  }

  _renderWorld() {
    const r = this.renderer;
    const prevBg = this.scene.background;
    const prevClear = new THREE.Color();
    r.getClearColor(prevClear);
    const prevAlpha = r.getClearAlpha();

    // Shadow map is now controlled globally via autoUpdate/needsUpdate in main.js.
    // No toggling here — avoids compiling a second shader variant of every material.
    this.scene.background = null;
    r.setClearColor(0x0d1014, 1);
    r.setRenderTarget(this.rt);
    r.clear(true, true, false);
    r.render(this.scene, this.cam);
    r.setRenderTarget(null);

    this.scene.background = prevBg;
    r.setClearColor(prevClear, prevAlpha);
  }

  _renderHud() {
    const r = this.renderer;
    const size = this.size;
    const m = this.margin;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const x = w - size - m;
    const y = h - size - m; // viewport origin is bottom-left

    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setScissorTest(true);
    r.setViewport(x, y, size, size);
    r.setScissor(x, y, size, size);
    r.render(this.hud, this.hudCam);
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.autoClear = prevAuto;
  }
}
