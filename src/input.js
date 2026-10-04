/**
 * input.js
 * --------
 * Centralised keyboard + mouse-look input for the whole game.
 *
 * Both the player and the vehicle read from one instance, so there are never
 * two sets of listeners fighting over the same keys. Mouse-look supports pointer
 * lock (click to capture, Esc to release) and falls back to click-drag orbit
 * when the pointer is not locked.
 */

// Keys the game consumes, so the browser does not scroll/activate on them.
const HANDLED = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyF', 'KeyR', 'KeyH', 'KeyM',
]);

export class Input {
  constructor(domElement) {
    this.dom = domElement;

    this.down = new Set();     // keys currently held
    this.pressed = new Set();  // keys that went down this frame (edge trigger)
    this.mouseDX = 0;
    this.mouseDY = 0;

    this.pointerLocked = false;
    this.dragging = false;

    this._onKeyDown = (e) => {
      if (HANDLED.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    };
    this._onKeyUp = (e) => {
      if (HANDLED.has(e.code)) e.preventDefault();
      this.down.delete(e.code);
    };
    this._onMouseDown = (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      // Ask for pointer lock as part of the same user gesture. In modern
      // browsers this returns a Promise that can reject (document not focused,
      // or the post-Esc cooldown), so swallow both sync throws and rejections.
      if (!this.pointerLocked && this.dom.requestPointerLock) {
        try {
          const request = this.dom.requestPointerLock();
          if (request && typeof request.catch === 'function') request.catch(() => {});
        } catch { /* ignored */ }
      }
    };
    this._onMouseUp = (e) => { if (e.button === 0) this.dragging = false; };
    this._onMouseMove = (e) => {
      if (this.pointerLocked || this.dragging) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    };
    this._onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
      if (!this.pointerLocked) this.dragging = false;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  isDown(code) {
    return this.down.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  /** Clear per-frame state. Call once at the very end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
