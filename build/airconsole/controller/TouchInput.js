'use strict';

class TouchInput {
  constructor(touchElement, onInput, onProgress) {
    this.el = touchElement;
    this.onInput = onInput;
    this.onProgress = onProgress || null;

    // Config constants
    this.RATCHET_THRESHOLD = 48;
    this.TAP_MAX_DISTANCE = 15;
    this.TAP_MAX_DURATION = 300;
    this.FLICK_VELOCITY_THRESHOLD = 0.8;
    this.SOFT_DROP_DEAD_ZONE = 96;
    this.SOFT_DROP_MIN_SPEED = 3;
    this.SOFT_DROP_MAX_SPEED = 10;
    this.SOFT_DROP_MAX_DIST = 200;
    // Wheel config (for trackpad two-finger scroll)
    this.WHEEL_H_THRESHOLD = 60;
    this.WHEEL_V_THRESHOLD = 120;
    this.WHEEL_RESET_MS = 150;

    // Soft drop interval config
    this.SOFT_DROP_INTERVAL_MS = 50;

    // Pointer tracking state
    this.activeId = null;
    this.anchorX = 0;
    this.startX = 0;
    this.startY = 0;
    this.startTime = 0;
    this.isDragging = false;
    this.isSoftDropping = false;
    this.hasSoftDropped = false;
    this.hasMovedHorizontally = false;
    this._softDropIntervalId = null;
    this._lastDyFromStart = 0;

    // Ring buffer for velocity calculation (last 4 positions)
    this.posBuffer = [];
    this.POS_BUFFER_SIZE = 4;

    // Wheel accumulator state
    this._wheelAccumX = 0;
    this._wheelAccumY = 0;
    this._wheelTimer = null;
    this._wheelVCooldown = false;

    // Bind event handlers
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);

    // Pointer events (unified touch + mouse + pen)
    this.el.addEventListener('pointerdown', this._onPointerDown);
    this.el.addEventListener('pointermove', this._onPointerMove);
    this.el.addEventListener('pointerup', this._onPointerUp);
    this.el.addEventListener('pointercancel', this._onPointerCancel);

    // Wheel events for trackpad scroll gestures
    this.el.addEventListener('wheel', this._onWheel, { passive: false });

    // Prevent context menu on right-click
    this.el.addEventListener('contextmenu', this._onContextMenu);

    // Ensure touch-action none for pointer events to suppress browser gestures
    this.el.style.touchAction = 'none';
  }

  _resetState() {
    this.activeId = null;
    this.anchorX = 0;
    this.startX = 0;
    this.startY = 0;
    this.startTime = 0;
    this.isDragging = false;
    this.isSoftDropping = false;
    this.hasSoftDropped = false;
    this.hasMovedHorizontally = false;
    this._lastDyFromStart = 0;
    this._stopSoftDropInterval();
    this.posBuffer = [];
    if (this.onProgress) this.onProgress(null, 0);
  }

  _pushPos(x, y, t) {
    this.posBuffer.push({ x, y, t });
    if (this.posBuffer.length > this.POS_BUFFER_SIZE) {
      this.posBuffer.shift();
    }
  }

  _getVelocity() {
    if (this.posBuffer.length < 2) return { vx: 0, vy: 0 };
    const last = this.posBuffer[this.posBuffer.length - 1];
    const prev = this.posBuffer[this.posBuffer.length - 2];
    const dt = last.t - prev.t;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return {
      vx: (last.x - prev.x) / dt,
      vy: (last.y - prev.y) / dt
    };
  }

  _haptic(pattern) {
    if (!navigator.vibrate) return;
    navigator.vibrate(pattern);
  }

  _calcSoftDropSpeed(distY) {
    const range = this.SOFT_DROP_MAX_DIST - this.SOFT_DROP_DEAD_ZONE;
    const t = Math.min(Math.max((distY - this.SOFT_DROP_DEAD_ZONE) / range, 0), 1);
    return Math.round(this.SOFT_DROP_MIN_SPEED + t * (this.SOFT_DROP_MAX_SPEED - this.SOFT_DROP_MIN_SPEED));
  }

  _startSoftDropInterval() {
    this._stopSoftDropInterval();
    const speed = this._calcSoftDropSpeed(this._lastDyFromStart);
    this.onInput('soft_drop', { speed });
    this._softDropIntervalId = setInterval(() => {
      const s = this._calcSoftDropSpeed(this._lastDyFromStart);
      this.onInput('soft_drop', { speed: s });
    }, this.SOFT_DROP_INTERVAL_MS);
  }

  _stopSoftDropInterval() {
    if (this._softDropIntervalId !== null) {
      clearInterval(this._softDropIntervalId);
      this._softDropIntervalId = null;
    }
  }

  _isFreshFlingCandidate(totalDx, totalDy, duration, vx, vy) {
    const absVx = Math.abs(vx);
    const absVy = Math.abs(vy);
    return (
      duration < 250 &&
      absVy > absVx &&
      Math.abs(totalDy) > this.TAP_MAX_DISTANCE &&
      absVy > this.FLICK_VELOCITY_THRESHOLD
    );
  }

  _tryFreshFling(totalDx, totalDy, duration, vx, vy) {
    if (this.hasSoftDropped) return false;
    if (!this._isFreshFlingCandidate(totalDx, totalDy, duration, vx, vy)) return false;

    if (vy > 0 && totalDy > this.TAP_MAX_DISTANCE) {
      this.onInput(INPUT.HARD_DROP);
      this._haptic([5, 5, 5]);
      this._resetState();
      return true;
    }

    if (vy < 0 && totalDy < -this.TAP_MAX_DISTANCE) {
      this.onInput(INPUT.HOLD);
      this._haptic(15);
      this._resetState();
      return true;
    }

    return false;
  }

  _onContextMenu(e) {
    e.preventDefault();
  }

  _onPointerDown(e) {
    // Only primary button (left click / touch / pen contact)
    if (e.button !== 0) return;

    // Only track one pointer at a time
    if (this.activeId !== null) return;

    e.preventDefault();

    this.activeId = e.pointerId;
    // Capture pointer so move/up events fire even outside the element
    this.el.setPointerCapture(e.pointerId);

    const x = e.clientX;
    const y = e.clientY;
    const now = e.timeStamp;

    this.anchorX = x;
    this.startX = x;
    this.startY = y;
    this.startTime = now;
    this.isDragging = false;
    this.isSoftDropping = false;
    this.posBuffer = [];
    this._pushPos(x, y, now);
  }

  _onPointerMove(e) {
    if (e.pointerId !== this.activeId) return;

    const x = e.clientX;
    const y = e.clientY;
    const now = e.timeStamp;

    this._pushPos(x, y, now);

    const dxFromStart = x - this.startX;
    const dyFromStart = y - this.startY;
    const duration = now - this.startTime;

    // Detect dragging (exit tap dead zone)
    if (!this.isDragging) {
      if (Math.abs(dxFromStart) > this.TAP_MAX_DISTANCE || Math.abs(dyFromStart) > this.TAP_MAX_DISTANCE) {
        this.isDragging = true;
      } else {
        return;
      }
    }

    // Move phase only handles continuous controls.
    // Discrete fling gestures are resolved on pointerup if the session never committed.
    const dxFromAnchor = x - this.anchorX;
    const absDxFromAnchor = Math.abs(dxFromAnchor);
    const absDyFromStart = Math.abs(dyFromStart);
    const steps = Math.trunc(dxFromAnchor / this.RATCHET_THRESHOLD);
    if (steps !== 0 && (this.isSoftDropping || absDxFromAnchor >= absDyFromStart)) {
      const action = steps > 0 ? INPUT.RIGHT : INPUT.LEFT;
      for (let i = 0, n = Math.abs(steps); i < n; i++) {
        this.onInput(action);
      }
      this._haptic(10);
      this.anchorX += steps * this.RATCHET_THRESHOLD;
      this.hasMovedHorizontally = true;
    }

    const { vx, vy } = this._getVelocity();
    const freshFlingCandidate = !this.hasSoftDropped
      && this._isFreshFlingCandidate(dxFromStart, dyFromStart, duration, vx, vy);

    this._lastDyFromStart = dyFromStart;

    if (dyFromStart > this.SOFT_DROP_DEAD_ZONE && !freshFlingCandidate) {
      if (!this.isSoftDropping && !this.hasMovedHorizontally) {
        this.isSoftDropping = true;
        this.hasSoftDropped = true;
        this._haptic(15);
        this._startSoftDropInterval();
      }
    } else if (this.isSoftDropping) {
      this.isSoftDropping = false;
      this._stopSoftDropInterval();
      this.onInput('soft_drop_end');
    }

    // --- Visual progress feedback ---
    if (this.onProgress) {
      const hProgress = Math.abs(x - this.anchorX) / this.RATCHET_THRESHOLD;

      let vProgress = 0;
      if (!this.isSoftDropping && dyFromStart > 0) {
        vProgress = dyFromStart / this.SOFT_DROP_DEAD_ZONE;
      }

      if (hProgress > vProgress && hProgress > 0) {
        this.onProgress((x - this.anchorX) >= 0 ? 'right' : 'left', Math.min(hProgress, 1));
      } else if (vProgress > 0) {
        this.onProgress('down', Math.min(vProgress, 1));
      } else if (!this.isSoftDropping) {
        this.onProgress(null, 0);
      }
    }

  }

  _onPointerUp(e) {
    if (e.pointerId !== this.activeId) return;

    const x = e.clientX;
    const y = e.clientY;
    const now = e.timeStamp;
    this._pushPos(x, y, now);

    // End soft drop if active
    if (this.isSoftDropping) {
      this.isSoftDropping = false;
      this.onInput('soft_drop_end');
    }

    const duration = now - this.startTime;
    const totalDx = x - this.startX;
    const totalDy = y - this.startY;
    const totalDist = Math.sqrt(totalDx * totalDx + totalDy * totalDy);

    // 1. Tap: minimal movement + short duration → rotate
    if (totalDist < this.TAP_MAX_DISTANCE && duration < this.TAP_MAX_DURATION) {
      this.onInput(INPUT.ROTATE_CW);
      this._haptic(10);
      this._resetState();
      return;
    }

    // Once continuous drag control was recognized, this touch session cannot
    // also become a discrete fling gesture on release.
    if (this.hasSoftDropped) {
      this._resetState();
      return;
    }

    const { vx, vy } = this._getVelocity();
    if (this._tryFreshFling(totalDx, totalDy, duration, vx, vy)) {
      return;
    }

    // 2. Short downward swipe fallback → hard drop
    if (totalDy > 50 && duration < 300 && Math.abs(totalDy) > Math.abs(totalDx) * 1.5) {
      this.onInput(INPUT.HARD_DROP);
      this._haptic([5, 5, 5]);
      this._resetState();
      return;
    }

    // 3. Short upward swipe fallback → hold
    if (totalDy < -30 && duration < 400 && Math.abs(totalDy) > Math.abs(totalDx) * 1.5) {
      this.onInput(INPUT.HOLD);
      this._haptic(15);
      this._resetState();
      return;
    }

    this._resetState();
  }

  _onPointerCancel(e) {
    if (e.pointerId !== this.activeId) return;

    // End soft drop if active, but don't fire any final gesture
    if (this.isSoftDropping) {
      this.isSoftDropping = false;
      this.onInput('soft_drop_end');
    }

    if (this.onProgress) this.onProgress(null, 0);
    this._resetState();
  }

  // Wheel handler for trackpad two-finger scroll gestures.
  // Horizontal scroll → move piece left/right (ratcheted).
  // Fast vertical scroll down → hard drop, up → hold.
  _onWheel(e) {
    e.preventDefault();

    // Don't process wheel during active pointer drag
    if (this.activeId !== null) return;

    // Normalize deltaMode to pixels.
    // deltaX/deltaY reflect the *scroll direction* (content movement), not
    // finger direction.  With macOS natural scrolling, swiping fingers down
    // produces negative deltaY ("scroll up").  We negate so the mapping is
    // finger-relative: fingers down → positive → hard drop.
    let dx = -e.deltaX;
    let dy = -e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= 100; dy *= 100; }

    this._wheelAccumX += dx;
    this._wheelAccumY += dy;

    // Horizontal: ratcheted movement
    const hSteps = Math.trunc(this._wheelAccumX / this.WHEEL_H_THRESHOLD);
    if (hSteps !== 0) {
      const action = hSteps > 0 ? INPUT.RIGHT : INPUT.LEFT;
      const count = Math.abs(hSteps);
      for (let i = 0; i < count; i++) {
        this.onInput(action);
      }
      this._wheelAccumX -= hSteps * this.WHEEL_H_THRESHOLD;
    }

    // Vertical: hard drop (scroll down) / hold (scroll up).
    // Once fired, enter cooldown until the gesture ends (reset timeout)
    // to prevent a single swipe from triggering multiple actions.
    if (!this._wheelVCooldown) {
      if (this._wheelAccumY > this.WHEEL_V_THRESHOLD) {
        this.onInput(INPUT.HARD_DROP);
        this._wheelAccumY = 0;
        this._wheelVCooldown = true;
      } else if (this._wheelAccumY < -this.WHEEL_V_THRESHOLD) {
        this.onInput(INPUT.HOLD);
        this._wheelAccumY = 0;
        this._wheelVCooldown = true;
      }
    }

    // Reset accumulators after a scroll pause (gesture ended)
    clearTimeout(this._wheelTimer);
    this._wheelTimer = setTimeout(() => {
      this._wheelAccumX = 0;
      this._wheelAccumY = 0;
      this._wheelVCooldown = false;
    }, this.WHEEL_RESET_MS);
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this._onPointerDown);
    this.el.removeEventListener('pointermove', this._onPointerMove);
    this.el.removeEventListener('pointerup', this._onPointerUp);
    this.el.removeEventListener('pointercancel', this._onPointerCancel);
    this.el.removeEventListener('wheel', this._onWheel);
    this.el.removeEventListener('contextmenu', this._onContextMenu);
    this._stopSoftDropInterval();
    clearTimeout(this._wheelTimer);
  }
}

// Attach to window for browser use
if (typeof window !== 'undefined') {
  window.TouchInput = TouchInput;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TouchInput;
}
