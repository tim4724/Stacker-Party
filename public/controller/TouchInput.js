'use strict';

class TouchInput {
  constructor(touchElement, onInput, onProgress) {
    this.el = touchElement;
    this.onInput = onInput;
    this.onProgress = onProgress || null;

    // Time-, rate-, and trackpad-wheel thresholds: fixed, independent of
    // the sensitivity slider.
    this.TAP_MAX_DURATION = 300;
    // Swipe-vs-hold timing. Release velocity is measured over the last
    // RECENT_VELOCITY_MS of movement (from the move history, NOT the pointerup
    // point — on real touch hardware pointerup repeats the last move's
    // coordinates, so up-vs-last-move is always ~0). If the finger's last
    // movement was more than RELEASE_IDLE_MS before lift, it had settled into
    // a hold and reads as not moving. The two are independently tunable; they
    // just happen to share a value.
    this.RECENT_VELOCITY_MS = 60;
    this.RELEASE_IDLE_MS = 60;
    this.SOFT_DROP_MIN_SPEED = 3;
    this.SOFT_DROP_MAX_SPEED = 10;
    this.WHEEL_H_THRESHOLD = 60;
    this.WHEEL_V_THRESHOLD = 120;
    this.WHEEL_RESET_MS = 150;

    // Distance + velocity thresholds: derived from the sensitivity slider so
    // raising sensitivity tightens the whole gesture space proportionally.
    // See _applySensitivity() for the ratios.
    var initial = (typeof ControllerSettings !== 'undefined' && ControllerSettings.getSensitivity)
      ? ControllerSettings.getSensitivity()
      : 48;
    this._applySensitivity(initial);

    this.SOFT_DROP_INTERVAL_MS = 50;

    // Pointer tracking state
    this.activeId = null;
    this.anchorX = 0;
    this.startX = 0;
    this.startY = 0;
    this.startTime = 0;
    this.isDragging = false;
    this.isSoftDropping = false;
    this.hasMovedHorizontally = false;
    this._softDropIntervalId = null;
    this._lastDyFromStart = 0;
    // Recent movement samples {x, y, t} (pointerdown + pointermoves, not the
    // up). The release velocity — and thus the swipe-vs-hold decision — is
    // computed from the tail of this list. Capped to keep it bounded.
    this._samples = [];
    this.MAX_SAMPLES = 16;

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

  // Re-derive every slider-tied threshold from the current sensitivity
  // value. Called once from the constructor and live from Settings.js on
  // slider change so changes take effect without rebuilding TouchInput.
  // Ratios calibrated so the default 48px keeps each constant close to its
  // pre-slider value (TAP=15, DEAD_ZONE=96, MAX_DIST=200, MOTION=0.3/ms).
  _applySensitivity(ratchet) {
    this.RATCHET_THRESHOLD = ratchet;
    this.TAP_MAX_DISTANCE = Math.max(5, Math.round(ratchet * 0.3));
    this.SOFT_DROP_DEAD_ZONE = ratchet * 2;
    this.SOFT_DROP_MAX_DIST = ratchet * 4;
    // Swipe-vs-hold boundary: minimum vertical speed (CSS px/ms) at release
    // for the gesture to count as "still moving" (→ hard drop / hold) rather
    // than a settled hold (→ soft drop). A held finger reads ~0.
    this.MOTION_VELOCITY = ratchet / 160;
  }

  _resetState() {
    this.activeId = null;
    this.anchorX = 0;
    this.startX = 0;
    this.startY = 0;
    this.startTime = 0;
    this.isDragging = false;
    this.isSoftDropping = false;
    this.hasMovedHorizontally = false;
    this._lastDyFromStart = 0;
    this._samples = [];
    this._stopSoftDropInterval();
    if (this.onProgress) this.onProgress(null, 0);
  }

  _haptic(pattern) {
    if (!navigator.vibrate) return;
    if (typeof ControllerSettings !== 'undefined' && ControllerSettings.scaleVibration) {
      const scaled = ControllerSettings.scaleVibration(pattern);
      if (scaled === null) return;
      navigator.vibrate(scaled);
      return;
    }
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

  // Velocity (CSS px/ms) of the finger just before lift — the swipe-vs-hold
  // signal. Measured over the last RECENT_VELOCITY_MS of *movement* (from the
  // sample history, never the pointerup coordinates, which on real hardware
  // just repeat the final move). If the last movement was longer than
  // RELEASE_IDLE_MS before lift, the finger had settled → reads as ~0 (hold).
  _releaseVelocity(upT) {
    const s = this._samples;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const last = s[s.length - 1];
    if (upT - last.t > this.RELEASE_IDLE_MS) return { vx: 0, vy: 0 };
    // Reference = the oldest sample still within the recent window, but never
    // newer than the previous sample, so we always span at least one segment.
    let ref = s[s.length - 2];
    for (let i = s.length - 3; i >= 0; i--) {
      if (last.t - s[i].t > this.RECENT_VELOCITY_MS) break;
      ref = s[i];
    }
    const dt = last.t - ref.t;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (last.x - ref.x) / dt, vy: (last.y - ref.y) / dt };
  }

  // Classify a release by its final-segment velocity: a vertical gesture still
  // moving (>= MOTION_VELOCITY) hard-drops (down) or holds (up). A settled
  // finger reads below the threshold and returns null (→ soft drop / nothing).
  // The net travel (totalDy) must agree with the velocity direction, so a tiny
  // reversal as the finger leaves the screen can't flip a downward soft drop
  // into a HOLD (or a hold gesture into a hard drop). Fires regardless of a
  // brief prior soft drop.
  _classifyRelease(vx, vy, totalDy) {
    const absVx = Math.abs(vx);
    const absVy = Math.abs(vy);
    if (absVy <= absVx || absVy < this.MOTION_VELOCITY) return null;
    if (vy > 0 && totalDy > 0) return INPUT.HARD_DROP;
    if (vy < 0 && totalDy < 0) return INPUT.HOLD;
    return null;
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
    this._samples = [{ x: x, y: y, t: now }];
  }

  _onPointerMove(e) {
    if (e.pointerId !== this.activeId) return;

    const x = e.clientX;
    const y = e.clientY;
    const now = e.timeStamp;

    const dxFromStart = x - this.startX;
    const dyFromStart = y - this.startY;

    // Detect dragging (exit tap dead zone)
    if (!this.isDragging) {
      if (Math.abs(dxFromStart) > this.TAP_MAX_DISTANCE || Math.abs(dyFromStart) > this.TAP_MAX_DISTANCE) {
        this.isDragging = true;
      } else {
        return;
      }
    }

    // Move phase handles continuous controls (ratchet + soft drop). The
    // discrete hard drop / hold is resolved on pointerup from release velocity.
    const dxFromAnchor = x - this.anchorX;
    const absDxFromAnchor = Math.abs(dxFromAnchor);
    const absDyFromStart = Math.abs(dyFromStart);
    const steps = Math.trunc(dxFromAnchor / this.RATCHET_THRESHOLD);
    // Fire a left/right step only when the gesture is horizontally dominant —
    // either overall (since the start) or in the latest movement segment. The
    // segment test lets you steer while soft-dropping (finger moving sideways)
    // without a vertical-dominant fling — which now also engages soft drop —
    // registering an accidental left/right on its way down to a hard drop.
    // _samples is seeded at pointerdown, so there is always a previous sample.
    const prev = this._samples[this._samples.length - 1];
    const segDx = x - prev.x;
    const segDy = y - prev.y;
    const horizontallyDominant = absDxFromAnchor >= absDyFromStart
      || Math.abs(segDx) >= Math.abs(segDy);
    if (steps !== 0 && horizontallyDominant) {
      const action = steps > 0 ? INPUT.RIGHT : INPUT.LEFT;
      for (let i = 0, n = Math.abs(steps); i < n; i++) {
        this.onInput(action);
      }
      this._haptic(15);
      this.anchorX += steps * this.RATCHET_THRESHOLD;
      this.hasMovedHorizontally = true;
    }

    this._lastDyFromStart = dyFromStart;
    this._samples.push({ x: x, y: y, t: now });
    if (this._samples.length > this.MAX_SAMPLES) this._samples.shift();

    // Soft drop engages once the finger passes the dead zone. Whether the
    // gesture ends as a soft drop or a hard drop is decided at release by
    // the finger's velocity (still moving → hard drop; settled → soft drop).
    if (dyFromStart > this.SOFT_DROP_DEAD_ZONE) {
      if (!this.isSoftDropping && !this.hasMovedHorizontally) {
        this.isSoftDropping = true;
        this._haptic(23);
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

    // End soft drop if active
    if (this.isSoftDropping) {
      this.isSoftDropping = false;
      this.onInput('soft_drop_end');
    }

    const duration = now - this.startTime;
    const totalDx = x - this.startX;
    // Only totalDy's *sign* is used (by _classifyRelease's direction guard),
    // not its magnitude. It reads pointerup.clientY, which on real hardware
    // repeats the last move's position and so agrees with the sample-derived
    // direction from _releaseVelocity.
    const totalDy = y - this.startY;
    const totalDist = Math.sqrt(totalDx * totalDx + totalDy * totalDy);

    // Tap: minimal movement + short duration → rotate.
    const isTap = totalDist < this.TAP_MAX_DISTANCE && duration < this.TAP_MAX_DURATION;

    // Swipe-vs-hold: a release still moving vertically is a hard drop (down)
    // or hold (up); a settled finger is left as the soft drop it already was.
    // Fires even if a soft drop was briefly active during the swipe.
    const rel = this._releaseVelocity(now);
    let action = isTap ? null : this._classifyRelease(rel.vx, rel.vy, totalDy);
    // A gesture that registered a left/right step is a move, not a drop or a
    // hold, so it can't also fire one on release — mirrors how horizontal
    // movement already blocks soft drop mid-gesture.
    if (action !== null && this.hasMovedHorizontally) action = null;

    if (isTap) {
      this.onInput(INPUT.ROTATE_CW);
      this._haptic(15);
    } else if (action === INPUT.HARD_DROP) {
      this.onInput(INPUT.HARD_DROP);
      this._haptic([8, 8, 8]);
    } else if (action === INPUT.HOLD) {
      this.onInput(INPUT.HOLD);
      this._haptic(23);
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
