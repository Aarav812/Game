import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP } from './collision.js';

/**
 * SunFlare
 * --------
 * A subtle directional-light flare, drawn as a tiny orthographic overlay after
 * the main (post-processed) render.
 *
 * three's Lensflare addon renders a full scene depth prepass every frame, which
 * roughly doubles draw calls. This instead tests occlusion with a single physics
 * raycast toward the sun, then lays out a core glow plus ghost sprites along the
 * sun -> screen-centre axis. Cheap, and it needs no external textures.
 */

const SUN_DISTANCE = 600;

function radialTexture(inner, mid, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, mid);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SunFlare {
  constructor(camera, physics) {
    this.camera = camera;
    this.physics = physics;

    this.scene = new THREE.Scene();
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._aspect = 1;

    const coreTex = radialTexture('rgba(255,246,214,0.95)', 'rgba(255,214,140,0.45)');
    const ghostTex = radialTexture('rgba(180,214,255,0.55)', 'rgba(140,180,255,0.18)');

    const makeSprite = (tex, scale, opacity) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthTest: false,
          depthWrite: false,
          opacity,
          toneMapped: false,
        })
      );
      sprite.scale.setScalar(scale);
      sprite.visible = false;
      this.scene.add(sprite);
      return sprite;
    };

    this.core = makeSprite(coreTex, 0.62, 0.55);
    this.coreInner = makeSprite(coreTex, 0.2, 0.5);
    this.ghosts = [
      makeSprite(ghostTex, 0.1, 0.22),
      makeSprite(ghostTex, 0.16, 0.16),
      makeSprite(ghostTex, 0.07, 0.2),
    ];
    this._ghostOffsets = [0.3, 0.62, 0.95];
    this._ghostScales = [0.1, 0.16, 0.07];

    this._camPos = new THREE.Vector3();
    this._toSun = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._ndc = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();

    this._from = new CANNON.Vec3();
    this._to = new CANNON.Vec3();
    this._result = new CANNON.RaycastResult();
  }

  setSize(w, h) {
    this._aspect = w / Math.max(1, h);
  }

  /** @param {THREE.Vector3} sunWorldPos position of the directional light */
  update(sunWorldPos) {
    this.camera.getWorldPosition(this._camPos);
    this._toSun.copy(sunWorldPos).sub(this._camPos);
    const dist = this._toSun.length();
    this._sunDir.copy(this._toSun).multiplyScalar(dist > 1e-4 ? 1 / dist : 0);

    // project() flips sign for points behind the camera, so test facing
    // explicitly rather than trusting the NDC z.
    this.camera.getWorldDirection(this._forward);
    const facing = dist > 1e-4 ? this._toSun.dot(this._forward) / dist : -1;

    let intensity = 0;
    if (facing > 0.05) {
      this._ndc.copy(sunWorldPos).project(this.camera);
      const edge = Math.max(Math.abs(this._ndc.x), Math.abs(this._ndc.y));
      if (edge < 1.3) intensity = THREE.MathUtils.clamp(1.3 - edge, 0, 1);
    }
    if (intensity > 0 && this._isOccluded()) intensity = 0;

    const sx = this._ndc.x;
    const sy = this._ndc.y;
    // Keep sprites circular despite the -1..1 ortho covering a wide frame.
    const aspect = this._aspect < 1 ? 1 : this._aspect;

    const place = (sprite, x, y, scale, opacity) => {
      const visible = opacity > 0.01;
      sprite.visible = visible;
      if (!visible) return;
      sprite.position.set(x, y, 0);
      sprite.scale.set(scale / aspect, scale, 1);
      sprite.material.opacity = opacity;
    };

    place(this.core, sx, sy, 0.62, 0.5 * intensity);
    place(this.coreInner, sx, sy, 0.2, 0.45 * intensity);

    for (let i = 0; i < this.ghosts.length; i++) {
      const t = this._ghostOffsets[i];
      place(
        this.ghosts[i],
        sx + (0 - sx) * t,
        sy + (0 - sy) * t,
        this._ghostScales[i],
        0.2 * intensity
      );
    }
  }

  /** One raycast: is a building standing between the camera and the sun? */
  _isOccluded() {
    const p = this._camPos;
    this._from.set(p.x, p.y, p.z);
    this._to.set(
      p.x + this._sunDir.x * SUN_DISTANCE,
      p.y + this._sunDir.y * SUN_DISTANCE,
      p.z + this._sunDir.z * SUN_DISTANCE
    );
    this._result.reset();
    this.physics.raycastClosest(
      this._from,
      this._to,
      { collisionFilterMask: GROUP.WORLD, skipBackfaces: true },
      this._result
    );
    return this._result.hasHit;
  }

  /** Draw the overlay on top of whatever the composer produced. */
  render(renderer) {
    renderer.autoClear = false;
    renderer.render(this.scene, this.ortho);
    renderer.autoClear = true;
  }
}
