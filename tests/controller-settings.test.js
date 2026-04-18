'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Settings.js references `localStorage` at load time via read() guards — they
// catch exceptions, so the absence of localStorage in Node is tolerated. No
// stubbing required.
const ControllerSettings = require('../public/controller/Settings.js');

describe('ControllerSettings — sensitivity scale', () => {
  test('1.00 on the slider maps to SENSITIVITY_DEFAULT pixels', () => {
    // The contract: when the user sees "1.00" in the settings panel, the
    // actual ratchet threshold in pixels is exactly SENSITIVITY_DEFAULT. If
    // the default ever drifts from 48, this assertion forces a review of the
    // TouchInput fallback + any other consumers that assume that value.
    assert.equal(ControllerSettings.SENSITIVITY_DEFAULT, 48);
    assert.equal(
      ControllerSettings.formatSensitivityScale(ControllerSettings.SENSITIVITY_DEFAULT),
      '1.00'
    );
  });

  test('scale values round to the nearest 0.05 detent', () => {
    // px snaps to the closest 5% multiplier — stored px is an integer so the
    // raw ratio can fall between detents (e.g. round(1.05 * 48) = 50, and
    // 50 / 48 = 1.0417 naively). The formatter must reconcile to "1.05".
    const d = ControllerSettings.SENSITIVITY_DEFAULT;
    assert.equal(ControllerSettings.formatSensitivityScale(Math.round(1.05 * d)), '1.05');
    assert.equal(ControllerSettings.formatSensitivityScale(Math.round(0.95 * d)), '0.95');
    assert.equal(ControllerSettings.formatSensitivityScale(Math.round(1.5 * d)), '1.50');
    assert.equal(ControllerSettings.formatSensitivityScale(Math.round(0.5 * d)), '0.50');
  });

  test('SENSITIVITY_DEFAULT matches the TouchInput fallback', () => {
    // TouchInput hardcodes 48 as its pre-ControllerSettings fallback. Keeping
    // these in lock-step prevents "1.00" from being treated as 48 in Settings
    // while the raw threshold is something else in TouchInput.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'public', 'controller', 'TouchInput.js'),
      'utf8'
    );
    const match = src.match(/:\s*(\d+)\s*;\s*\n\s*this\._applySensitivity\(initial\)/);
    assert.ok(match, 'TouchInput fallback line not found — update this test if the pattern changed');
    assert.equal(parseInt(match[1], 10), ControllerSettings.SENSITIVITY_DEFAULT);
  });
});

describe('ControllerSettings — haptic scaleVibration', () => {
  // Tier mutations go through setHapticStrength so each sub-test restores
  // the default afterwards to keep module state predictable across the suite.
  function withTier(tier, fn) {
    const prev = ControllerSettings.getHapticStrength();
    ControllerSettings.setHapticStrength(tier);
    try { fn(); } finally { ControllerSettings.setHapticStrength(prev); }
  }

  test("'off' returns null so callers skip navigator.vibrate entirely", () => {
    withTier('off', () => {
      assert.equal(ControllerSettings.scaleVibration(15), null);
      assert.equal(ControllerSettings.scaleVibration([5, 5, 5]), null);
    });
  });

  test('numeric patterns scale by the tier multiplier', () => {
    withTier('medium', () => {
      // Medium is 1.0 by convention — raw values pass through (round-tripped).
      assert.equal(ControllerSettings.scaleVibration(15), 15);
    });
    withTier('strong', () => {
      // Strong = 1.8 → 15 × 1.8 = 27
      assert.equal(ControllerSettings.scaleVibration(15), 27);
    });
    withTier('light', () => {
      // Light = 0.6 → 15 × 0.6 = 9
      assert.equal(ControllerSettings.scaleVibration(15), 9);
    });
  });

  test('enforces a 3 ms floor on each pulse so light doesn’t dip below hardware threshold', () => {
    withTier('light', () => {
      // 1 ms × 0.6 = 0.6 → clamped to 3ms floor (some devices drop sub-3ms pulses)
      assert.equal(ControllerSettings.scaleVibration(1), 3);
    });
  });

  test('array patterns are scaled element-wise', () => {
    withTier('medium', () => {
      assert.deepEqual(ControllerSettings.scaleVibration([8, 8, 8]), [8, 8, 8]);
    });
    withTier('strong', () => {
      // [8 × 1.8, 8 × 1.8, 8 × 1.8] = [14.4, 14.4, 14.4] → round → [14, 14, 14]
      assert.deepEqual(ControllerSettings.scaleVibration([8, 8, 8]), [14, 14, 14]);
    });
  });

  test('setHapticStrength rejects invalid tier names silently', () => {
    const prev = ControllerSettings.getHapticStrength();
    ControllerSettings.setHapticStrength('extreme');
    assert.equal(ControllerSettings.getHapticStrength(), prev);
    ControllerSettings.setHapticStrength(null);
    assert.equal(ControllerSettings.getHapticStrength(), prev);
  });
});
