import * as THREE from 'three';

/**
 * WorldMap
 * --------
 * Full-screen GTA-style pause menu map.
 *
 * Features:
 *   - Dedicated OrthographicCamera looking down at y=800 covering the full 2500x2500 island.
 *   - Renders the scene top-down into a full-screen overlay (separate render pass).
 *   - Mouse drag to pan, scroll wheel to zoom (0.3x–3.0x).
 *   - Spacebar / Center button snaps to player.
 *   - Right-click to place a custom waypoint (shown on minimap as directional arrow).
 *   - Player marker (blinking arrow), parked vehicle marker, landmark icons.
 *   - Legend banner + helper bar.
 *
 * Usage:
 *   const worldMap = new WorldMap(renderer, scene, { player, vehicle, minimap, cameraRig });
 *   worldMap.init();
 *   // In main loop:
 *   if (input.wasPressed('KeyM')) worldMap.toggle();
 *   worldMap.update(dt, input);
 *   worldMap.render();
 */
export class WorldMap {
  constructor(renderer, scene, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.player = opts.player;
    this.vehicle = opts.vehicle;
    this.minimap = opts.minimap;
    this.cameraRig = opts.cameraRig;

    // Map camera - orthographic, looking straight down
    this.viewUnits = 2800; // covers full island + margin
    this.zoom = 1.0;
    this.minZoom = 0.3;
    this.maxZoom = 3.0;
    this.targetX = 0;
    this.targetZ = 0;

    this.isOpen = false;
    this._wasPointerLocked = false;
    this._lastPointerLock = false;

    // Custom waypoint (world coordinates, or null)
    this.waypoint = null;

    // Landmark data
    this.landmarks = [
      { name: 'DOWNTOWN', x: 0, z: 250, type: 'downtown' },
      { name: 'BRIDGE', x: 24, z: 240, type: 'bridge' },
      { name: 'GAS STATION', x: -850, z: -900, type: 'gas' },
      { name: 'SUBURBAN DISTRICT', x: 600, z: 400, type: 'suburban' },
      { name: 'INDUSTRIAL ZONE', x: -700, z: -600, type: 'industrial' },
      { name: 'NORTHERN OUTPOST', x: 100, z: 950, type: 'outpost' },
    ];

    // Blinking state for player marker
    this._blinkTimer = 0;
    this._blinkVisible = true;

    this._buildDOM();
    this._buildCamera();
    this._bindEvents();
  }

  _buildCamera() {
    const half = this.viewUnits / 2;
    this.cam = new THREE.OrthographicCamera(
      -half, half, half, -half, 1, 2000
    );
    this.cam.position.set(0, 800, 0);
    this.cam.lookAt(0, 0, 0);
    this.cam.up.set(0, 0, -1); // world -Z = up on map (North up)
    this.cam.updateMatrixWorld(true);

    // Separate scene for map rendering (we can filter layers if needed)
    this.mapScene = this.scene; // use main scene, but we'll control layers via camera
  }

  _buildDOM() {
    // Full-screen overlay container
    this.overlay = document.createElement('div');
    this.overlay.id = 'worldmap-overlay';
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(8, 10, 16, 0.98);
      display: none; flex-direction: column;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #e8ecf4;
      opacity: 0; transition: opacity 180ms ease;
    `;
    this.overlay.innerHTML = `
      <div id="worldmap-header" style="
        padding: 14px 24px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex; justify-content: space-between; align-items: center;
        background: linear-gradient(180deg, rgba(15,18,26,0.95), transparent);
      ">
        <div style="display:flex; align-items:center; gap:16px;">
          <span style="font:700 18px/1 ui-monospace; letter-spacing:0.08em; color:#ffd166;">
            MAP — SAN ANDREAS / METROPOLIS
          </span>
          <span id="worldmap-coords" style="
            font:12px/1 ui-monospace; color:#9be7ff;
            background:rgba(255,255,255,0.06); padding:4px 10px; border-radius:4px;
          ">X: 0.0  Z: 0.0</span>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          <span id="worldmap-speed" style="font:14px/1 ui-monospace; color:#9be7ff;">Speed: 0 km/h</span>
          <button id="worldmap-center-btn" style="
            padding:6px 14px; border:1px solid rgba(255,209,102,0.4);
            background:rgba(255,209,102,0.12); color:#ffd166; font:600 11px ui-monospace;
            border-radius:4px; cursor:pointer; letter-spacing:0.04em;
          ">Center on Player (Space)</button>
        </div>
      </div>

      <div id="worldmap-canvas-wrap" style="
        flex:1; position:relative; overflow:hidden;
      "></div>

      <div id="worldmap-footer" style="
        padding:10px 24px; border-top:1px solid rgba(255,255,255,0.06);
        background:linear-gradient(0deg, rgba(15,18,26,0.95), transparent);
        font:11px/1 ui-monospace; color:#8a9ab0;
      ">
        [L-Drag] Pan &nbsp;|&nbsp; [Scroll] Zoom &nbsp;|&nbsp; [R-Click] Set Waypoint &nbsp;|&nbsp; [Space] Center &nbsp;|&nbsp; [M / ESC] Return to Game
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.canvasWrap = this.overlay.querySelector('#worldmap-canvas-wrap');
    this.coordsEl = this.overlay.querySelector('#worldmap-coords');
    this.speedEl = this.overlay.querySelector('#worldmap-speed');
    this.centerBtn = this.overlay.querySelector('#worldmap-center-btn');

    // Listen for center button
    this.centerBtn.addEventListener('click', () => this.centerOnPlayer(true));
  }

  _bindEvents() {
    // Mouse drag to pan
    let dragging = false;
    let lastX = 0, lastY = 0;

    this.canvasWrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // only left drag pans
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvasWrap.style.cursor = 'grabbing';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging || !this.isOpen) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      // Convert screen drag to world movement (inverted because camera moves opposite)
      const worldPerPx = (this.viewUnits / Math.max(window.innerWidth, window.innerHeight)) * this.zoom;
      this.targetX -= dx * worldPerPx;
      this.targetZ += dy * worldPerPx; // screen Y down = world Z up (since cam.up = -Z)
      this._clampTarget();
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      dragging = false;
      this.canvasWrap.style.cursor = '';
    });

    // Scroll to zoom
    this.canvasWrap.addEventListener('wheel', (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 0.89;
      this.zoom = THREE.MathUtils.clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    }, { passive: false });

    // Right-click to set waypoint
    this.canvasWrap.addEventListener('contextmenu', (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      this._setWaypointFromMouse(e.clientX, e.clientY);
    });

    // Close on overlay click (but not on canvas wrap)
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  _clampTarget() {
    const half = this.viewUnits / 2;
    const margin = half * 0.5; // allow panning slightly beyond edges
    this.targetX = THREE.MathUtils.clamp(this.targetX, -half - margin, half + margin);
    this.targetZ = THREE.MathUtils.clamp(this.targetZ, -half - margin, half + margin);
  }

  _setWaypointFromMouse(clientX, clientY) {
    const rect = this.canvasWrap.getBoundingClientRect();
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;

    // Normalized device coordinates (-1 to 1)
    const ndcX = (relX / rect.width) * 2 - 1;
    const ndcY = -(relY / rect.height) * 2 + 1;

    // Unproject using the map camera
    const half = this.viewUnits / 2;
    const worldX = this.targetX + ndcX * half * this.zoom;
    const worldZ = this.targetZ + ndcY * half * this.zoom;

    this.waypoint = { x: worldX, z: worldZ };
    this._updateMinimapWaypoint();

    // Visual feedback
    this._flashWaypointSet();
  }

  _updateMinimapWaypoint() {
    if (this.minimap && this.waypoint) {
      // The minimap has a carBlip for parked car; we'll add a waypoint property
      // or use a custom method. For now, set a custom property the minimap can read.
      this.minimap.waypoint = this.waypoint;
    } else if (this.minimap) {
      this.minimap.waypoint = null;
    }
  }

  _flashWaypointSet() {
    // Brief toast
    const toast = document.createElement('div');
    toast.textContent = 'Waypoint Set';
    toast.style.cssText = `
      position:fixed; left:50%; bottom:120px; transform:translateX(-50%);
      padding:10px 20px; background:rgba(180,120,255,0.95); color:#fff;
      font:600 12px ui-monospace; border-radius:6px; z-index:1002;
      box-shadow:0 4px 20px rgba(0,0,0,0.4); animation:fade 1.2s ease forwards;
    `;
    const style = document.createElement('style');
    style.textContent = `@keyframes fade { 0%{opacity:1} 70%{opacity:1} 100%{opacity:0;transform:translateX(-50%) translateY(-20px)} }`;
    document.head.appendChild(style);
    document.body.appendChild(toast);
    setTimeout(() => { toast.remove(); style.remove(); }, 1300);
  }

  init() {
    // Nothing extra needed at init; camera already built
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;

    // Store pointer lock state and release it
    this._wasPointerLocked = this.renderer.domElement.ownerDocument.pointerLockElement === this.renderer.domElement;
    if (this._wasPointerLocked) {
      document.exitPointerLock();
    }

    // Pause game: we'll handle dt=0 in main loop via a flag
    this.overlay.style.display = 'flex';
    requestAnimationFrame(() => { this.overlay.style.opacity = '1'; });

    // Initialize map position to player
    this.centerOnPlayer(false);

    // Disable game input (handled by main loop checking this.isOpen)
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;

    this.overlay.style.opacity = '0';
    setTimeout(() => {
      if (!this.isOpen) this.overlay.style.display = 'none';
    }, 180);

    // Restore pointer lock if it was active
    if (this._wasPointerLocked && this.renderer.domElement.requestPointerLock) {
      this.renderer.domElement.requestPointerLock().catch(() => {});
    }
  }

  centerOnPlayer(animate = true) {
    const pos = this.player ? this.player.position : this.vehicle?.chassisBody?.position;
    if (!pos) return;
    this.targetX = pos.x;
    this.targetZ = pos.z;
    if (!animate) {
      this.cam.position.x = this.targetX;
      this.cam.position.z = this.targetZ;
    }
  }

  update(dt, input) {
    if (!this.isOpen) return;

    this._blinkTimer += dt;
    if (this._blinkTimer > 0.5) {
      this._blinkTimer = 0;
      this._blinkVisible = !this._blinkVisible;
    }

    // Spacebar to center
    if (input.wasPressed('Space')) {
      this.centerOnPlayer(true);
    }

    // Close on M or Escape
    if (input.wasPressed('KeyM') || input.wasPressed('Escape')) {
      this.close();
      return;
    }

    // Smooth camera follow to target
    const lerp = 1 - Math.exp(-10 * dt);
    this.cam.position.x += (this.targetX - this.cam.position.x) * lerp;
    this.cam.position.z += (this.targetZ - this.cam.position.z) * lerp;
    this.cam.position.y = 800; // fixed height

    // Apply zoom by scaling the frustum
    const half = (this.viewUnits / 2) * this.zoom;
    this.cam.left = -half;
    this.cam.right = half;
    this.cam.top = half;
    this.cam.bottom = -half;
    this.cam.updateProjectionMatrix();

    // Update HUD info
    const pos = this.player ? this.player.position : this.vehicle?.chassisBody?.position;
    if (pos) {
      this.coordsEl.textContent = `X: ${pos.x.toFixed(1)}  Z: ${pos.z.toFixed(1)}`;
    }
    if (this.vehicle) {
      this.speedEl.textContent = `Speed: ${Math.round(this.vehicle.speedKmh)} km/h`;
    }
  }

  render() {
    if (!this.isOpen) return;

    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    const prevClearColor = r.getClearColor(new THREE.Color());
    const prevClearAlpha = r.getClearAlpha();

    // Render the main scene from the orthographic map camera
    // We render directly to the screen (no render target) filling the canvas
    r.autoClear = true;
    r.setClearColor(0x0a0d12, 1);
    r.clear(true, true, false);

    // Temporarily adjust camera layers if needed (main camera uses layer 0+1)
    // Map camera shows everything on layer 0 (world geometry)
    const prevLayers = this.cam.layers.mask;
    this.cam.layers.enable(0);
    this.cam.layers.disable(1); // hide props layer on big map for clarity

    r.render(this.mapScene, this.cam);

    // Restore
    this.cam.layers.mask = prevLayers;
    r.autoClear = prevAutoClear;
    r.setClearColor(prevClearColor, prevClearAlpha);

    // Now draw the UI overlays (markers, waypoint) on top via 2D canvas overlay
    // We'll do this by projecting world positions to screen and updating DOM elements
    this._renderMarkers();
  }

  _renderMarkers() {
    if (!this.canvasWrap) return;

    // Remove old marker elements
    this.canvasWrap.querySelectorAll('.worldmap-marker').forEach(el => el.remove());

    const rect = this.canvasWrap.getBoundingClientRect();
    const half = (this.viewUnits / 2) * this.zoom;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    // Helper: project world -> screen
    const project = (wx, wz) => {
      const dx = wx - this.cam.position.x;
      const dz = wz - this.cam.position.z;
      const sx = centerX + (dx / half) * centerX;
      const sy = centerY - (dz / half) * centerY; // world +Z = screen -Y
      return { x: sx, y: sy };
    };

    // 1. Player marker
    if (this.player && this._blinkVisible) {
      const pos = this.player.position;
      const p = project(pos.x, pos.z);
      const yaw = this.player.facing;
      const el = document.createElement('div');
      el.className = 'worldmap-marker';
      el.style.cssText = `
        position:absolute; left:${p.x}px; top:${p.y}px; transform:translate(-50%,-50%) rotate(${-yaw}rad);
        width:0; height:0; border-left:8px solid transparent; border-right:8px solid transparent;
        border-bottom:16px solid #ffd166; filter:drop-shadow(0 0 6px #ffd166);
        animation:pulse 1s ease-in-out infinite;
      `;
      this.canvasWrap.appendChild(el);
    }

    // 2. Parked vehicle marker (when not driving)
    if (this.vehicle && !this.vehicle.setControlEnabled) {
      // Actually check if player is driving
    }
    const driving = this.vehicle && this.vehicle.setControlEnabled !== false; // rough check
    if (this.vehicle && !driving) {
      const cpos = this.vehicle.chassisBody.position;
      const p = project(cpos.x, cpos.z);
      const el = document.createElement('div');
      el.className = 'worldmap-marker';
      el.style.cssText = `
        position:absolute; left:${p.x}px; top:${p.y}px; transform:translate(-50%,-50%);
        width:18px; height:18px; background:#6fd3ff; border:2px solid #0a0d12;
        border-radius:3px; box-shadow:0 0 8px #6fd3ff;
      `;
      el.title = 'Parked Vehicle';
      this.canvasWrap.appendChild(el);
    }

    // 3. Landmarks
    for (const lm of this.landmarks) {
      const p = project(lm.x, lm.z);
      const el = document.createElement('div');
      el.className = 'worldmap-marker';
      const colors = {
        downtown: '#ff6b6b', bridge: '#4ecdc4', gas: '#ffe66d',
        suburban: '#a8e6a8', industrial: '#ffa8a8', outpost: '#c8a8ff'
      };
      const color = colors[lm.type] || '#fff';
      el.style.cssText = `
        position:absolute; left:${p.x}px; top:${p.y}px; transform:translate(-50%,-50%);
        display:flex; flex-direction:column; align-items:center; pointer-events:none;
      `;
      el.innerHTML = `
        <div style="width:10px;height:10px;background:${color};border:2px solid #0a0d12;border-radius:50%;box-shadow:0 0 6px ${color};"></div>
        <span style="margin-top:2px;font:10px ui-monospace;color:#fff;text-shadow:0 0 4px #000;white-space:nowrap;">${lm.name}</span>
      `;
      this.canvasWrap.appendChild(el);
    }

    // 4. Custom waypoint
    if (this.waypoint) {
      const p = project(this.waypoint.x, this.waypoint.z);
      const el = document.createElement('div');
      el.className = 'worldmap-marker';
      el.style.cssText = `
        position:absolute; left:${p.x}px; top:${p.y}px; transform:translate(-50%,-50%);
        display:flex; flex-direction:column; align-items:center; pointer-events:none;
      `;
      el.innerHTML = `
        <div style="width:14px;height:14px;background:linear-gradient(135deg,#ffd166,#b87aff);border:2px solid #0a0d12;border-radius:50%;box-shadow:0 0 10px #b87aff;animation:ring 1.5s ease-out infinite;"></div>
        <span style="margin-top:3px;font:10px ui-monospace;color:#ffd166;text-shadow:0 0 4px #000;white-space:nowrap;">WAYPOINT</span>
      `;
      const style = document.createElement('style');
      style.textContent = `@keyframes ring { 0%{box-shadow:0 0 0 0 #b87aff80} 100%{box-shadow:0 0 0 16px #b87aff00} }`;
      if (!document.querySelector('#worldmap-ring-style')) {
        style.id = 'worldmap-ring-style';
        document.head.appendChild(style);
      }
      this.canvasWrap.appendChild(el);
    }
  }
}