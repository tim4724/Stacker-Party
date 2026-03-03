'use strict';

const { test, describe, beforeEach } = require('node:test');
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

  test('horizontal movement and soft drop can coexist in one touch session', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 90, timeStamp: 120 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 120, clientY: 120, timeStamp: 220 }));

    assert.deepEqual(actions.map(entry => entry.action), [
      'soft_drop_start',
      INPUT.RIGHT,
      INPUT.RIGHT,
      'soft_drop_start'
    ]);
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

  test('release flick still fires after horizontal input', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 60, clientY: 10, timeStamp: 40 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 60, clientY: -120, timeStamp: 80 }));

    assert.deepEqual(actions.map(entry => entry.action), [INPUT.RIGHT, INPUT.HOLD]);
  });

  test('release hard drop is blocked after soft drop was recognized', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 100, timeStamp: 140 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 180, timeStamp: 180 }));

    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop_start', 'soft_drop_end']);
  });

  test('slower downward drag still becomes soft drop instead of hard drop', () => {
    touchInput._onPointerDown(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 35, timeStamp: 80 }));
    touchInput._onPointerMove(pointerEvent({ clientX: 0, clientY: 90, timeStamp: 180 }));
    touchInput._onPointerUp(pointerEvent({ clientX: 0, clientY: 140, timeStamp: 260 }));

    assert.deepEqual(actions.map(entry => entry.action), ['soft_drop_start', 'soft_drop_end']);
  });
});
