'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { INPUT } = require('../public/shared/protocol');

global.INPUT = INPUT;
Object.defineProperty(globalThis, 'navigator', {
  value: { vibrate() {} },
  configurable: true
});

const TouchInput = require('../public/controller/TouchInput.js');

function createMockElement() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {}
  };
}

function pointerEvent(overrides) {
  return {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    preventDefault() {},
    ...overrides
  };
}

describe('TouchInput gesture sessions', () => {
  let actions;
  let touchInput;

  beforeEach(() => {
    actions = [];
    touchInput = new TouchInput(createMockElement(), (action, data) => {
      actions.push({ action, data });
    });
  });

  afterEach(() => {
    touchInput.destroy();
  });

  test('fresh downward flick triggers hard drop', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 10, clientY: 40, timeStamp: 40 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 10, clientY: 140, timeStamp: 80 }));

    assert.equal(actions.some(entry => entry.action === INPUT.LEFT || entry.action === INPUT.RIGHT), false);
    assert.equal(actions[actions.length - 1].action, INPUT.HARD_DROP);
  });

  test('fresh downward flick with intermediate move events hard drops only on release', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 5, clientY: 30, timeStamp: 20 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 8, clientY: 60, timeStamp: 40 }));
    assert.deepEqual(actions.map(entry => entry.action), []);
    touchInput._onPointerUp(pointerEvent({ clientX: 10, clientY: 140, timeStamp: 80 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.HARD_DROP]);
  });

  test('fast fresh downward swipe does not soft-drop before release', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 2, clientY: 18, timeStamp: 16 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 4, clientY: 45, timeStamp: 32 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 5, clientY: 78, timeStamp: 48 }));

    assert.deepEqual(actions.map(entry => entry.action), []);

    touchInput._onPointerUp(pointerEvent({ clientX: 5, clientY: 130, timeStamp: 72 }));
    assert.deepEqual(actions.map(entry => entry.action), [INPUT.HARD_DROP]);
  });

  test('diagonal downward fling hard-drops without an accidental sideways move', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // Mostly downward with a smaller rightward component (>RATCHET_THRESHOLD of
    // 48px), crossing the soft-drop dead zone. Each segment stays vertical, so
    // the soft drop must not let the horizontal drift register a move.
    touchInput._onPointerMove(pointerEvent({ clientX: 12, clientY: 40, timeStamp: 20 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 30, clientY: 100, timeStamp: 40 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 55, clientY: 160, timeStamp: 60 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 55, clientY: 160, timeStamp: 75 }));

    assert.equal(actions.some(e => e.action === INPUT.LEFT || e.action === INPUT.RIGHT), false);
    assert.equal(actions[actions.length - 1].action, INPUT.HARD_DROP);
  });

  test('a gesture that moved horizontally cannot also hard drop on release', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 10, timeStamp: 40 }));   // RIGHT
    // Same gesture then flings downward — must not hard drop (it's a move).
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 120, timeStamp: 80 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 60, clientY: 120, timeStamp: 100 }));

    assert.equal(actions.some(e => e.action === INPUT.HARD_DROP), false);
    assert.equal(actions.some(e => e.action === INPUT.RIGHT), true);
  });

  test('horizontal drag still emits ratcheted movement', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 20, timeStamp: 80 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.RIGHT]);
  });

  test('horizontal movement keeps working after vertical drift in the same touch', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 10, timeStamp: 40 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 50, clientY: 56, timeStamp: 80 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 140, clientY: 56, timeStamp: 120 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.RIGHT, INPUT.RIGHT]);
  });

  test('soft drop started before horizontal movement continues during it', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // Vertical dominates first → soft drop activates (dy must exceed SOFT_DROP_DEAD_ZONE=96)
    touchInput._onPointerMove(pointerEvent({ clientX: 10, clientY: 100, timeStamp: 260 }));
    // Then horizontal catches up → ratchet fires, soft drop continues
    touchInput._onPointerMove(pointerEvent({ clientX: 120, clientY: 130, timeStamp: 360 }));

    // Two ratchet steps crossed inside ONE pointermove, so ONE counted emit:
    // the AirConsole budget is spent per message, not per step.
    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop', INPUT.RIGHT]);
    assert.equal(actions[1].data.n, 2);
  });

  test('a multi-step ratchet crossing emits once, carrying the count', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // 200px in one event = 4 x RATCHET_THRESHOLD(48), the shape a fast drag (or an
    // ordinary one across a stalled frame) produces once pointermove coalesces.
    touchInput._onPointerMove(pointerEvent({ clientX: 200, clientY: 10, timeStamp: 32 }));

    assert.deepEqual(actions, [{ action: INPUT.RIGHT, data: { n: 4 } }]);
    // The remainder carries: the anchor lands on the lattice, not on the finger.
    assert.equal(touchInput.anchorX, 4 * touchInput.RATCHET_THRESHOLD);
  });

  test('a single-step crossing still reports n = 1', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: -60, clientY: 10, timeStamp: 40 }));

    assert.deepEqual(actions, [{ action: INPUT.LEFT, data: { n: 1 } }]);
  });

  test('horizontal movement first prevents soft drop from activating', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // Horizontal ratchet fires first (dx=60 > 48, dy=10 small)
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 10, timeStamp: 80 }));
    // Then finger drifts down past dead zone — soft drop should NOT activate
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 100, timeStamp: 300 }));

    assert.deepEqual(actions.map(entry => entry.action), [
      INPUT.RIGHT,
    ]);
  });

  test('soft_drop includes speed based on finger distance', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 100, timeStamp: 140 }));

    const softDropEntry = actions.find(entry => entry.action === 'soft_drop');
    assert.ok(softDropEntry, 'soft_drop action emitted');
    assert.ok(softDropEntry.data && typeof softDropEntry.data.speed === 'number', 'speed is a number');
    assert.ok(softDropEntry.data.speed >= 3 && softDropEntry.data.speed <= 10, 'speed in range 3-10');
  });

  test('fresh upward flick still triggers hold', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: -40, timeStamp: 40 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: -120, timeStamp: 80 }));

    assert.equal(actions[actions.length - 1].action, INPUT.HOLD);
  });

  test('fresh upward flick with intermediate move events holds only on release', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: -4, clientY: -30, timeStamp: 20 }));
    touchInput._onPointerMove(pointerEvent({ clientX: -6, clientY: -60, timeStamp: 40 }));
    assert.deepEqual(actions.map(entry => entry.action), []);
    touchInput._onPointerUp(pointerEvent({ clientX: -10, clientY: -140, timeStamp: 80 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.HOLD]);
  });

  test('upward release flick after horizontal input does not fire hold', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 10, timeStamp: 40 }));
    // Upward flick recorded as movement before lift (pointerup coords aren't used).
    // The gesture already registered a RIGHT step, so it is a move — the upward
    // lift must not also fire a hold (same rule as hard drop).
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: -120, timeStamp: 80 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 60, clientY: -120, timeStamp: 110 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.RIGHT]);
  });

  test('swipe still moving at release hard-drops even after a soft drop engaged', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 100, timeStamp: 140 }));
    // Sample history shows ~0.71 px/ms (100px over 140ms). The pointerup coords
    // are intentionally the same as the last move — _releaseVelocity ignores
    // them and reads movement from _samples only.
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 100, timeStamp: 180 }));

    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop', 'soft_drop_end', INPUT.HARD_DROP]);
  });

  test('a slow moderate swipe that keeps moving hard-drops (the regression case)', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 60, timeStamp: 120 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 120, timeStamp: 240 }));
    // Finger still moving right up to the lift (last move 10ms before up, well
    // within the idle gate). Recent-window velocity ~0.8 px/ms → hard drop.
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 160, timeStamp: 290 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 160, timeStamp: 300 }));

    assert.equal(actions[actions.length - 1].action, INPUT.HARD_DROP);
  });

  test('down then up with no intervening move events fires nothing (no misfire)', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // Jump straight to release past the tap distance with no pointermove —
    // the only sample is the pointerdown, so release velocity is unknown.
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 140, timeStamp: 60 }));

    assert.deepEqual(actions.map(entry => entry.action), []);
  });

  test('downward hold (finger settled at release) stays a soft drop', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 150, timeStamp: 200 }));
    // Finger held still (same position) then lifted → release velocity ~0.
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 150, timeStamp: 320 }));

    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop', 'soft_drop_end']);
  });

  test('finger that moved fast then idled past RELEASE_IDLE_MS does not hard drop', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    // Fast approach downward...
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 50, timeStamp: 20 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 100, timeStamp: 40 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 150, timeStamp: 60 }));
    // ...then the finger sits still for 90ms (> RELEASE_IDLE_MS=60) before lift.
    // The idle gate overrides the fast approach velocity → no hard drop.
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 150, timeStamp: 150 }));

    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop', 'soft_drop_end']);
  });

  test('net-downward gesture that twitches up on lift does not misfire a hold', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 150, timeStamp: 100 }));
    // Finger eases back upward as it leaves the screen — recent velocity is
    // upward but net travel is downward, so this must NOT register as a hold.
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 135, timeStamp: 130 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 120, timeStamp: 160 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 120, timeStamp: 180 }));

    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop', 'soft_drop_end']);
    assert.equal(actions.some(entry => entry.action === INPUT.HOLD), false);
  });
});
