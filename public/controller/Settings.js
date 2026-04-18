'use strict';

// =====================================================================
// Controller Settings — per-device preferences persisted to localStorage.
// Applied to ControllerAudio (mute), TouchInput (ratchet threshold), and
// the global vibrate() helper (haptic strength). Load order: after
// TouchInput + Audio, before ControllerState so `vibrate()` can consult it.
// In AirConsole mode the adapter neutralizes localStorage — settings won't
// persist across sessions there, but runtime behavior is unchanged.
// =====================================================================

var ControllerSettings = (function () {
  var KEY_MUTED = 'stacker_muted';
  var KEY_HAPTIC = 'stacker_haptic_strength';
  var KEY_SENSITIVITY = 'stacker_touch_sensitivity';

  var HAPTIC_TIERS = ['off', 'light', 'medium', 'strong'];
  // Web vibration only exposes duration, not amplitude, so "stronger" means
  // longer pulses. Medium is 1.0 by convention — raw pattern values at each
  // call site are therefore the Medium-tier ms. Light and Strong are plain
  // multipliers around it.
  var HAPTIC_SCALE = { off: 0, light: 0.6, medium: 1, strong: 1.8 };

  // Absolute clamp for persisted values. The UI slider narrows this further
  // to [touchpadWidth * 0.1, touchpadWidth * 0.5] each time Settings opens
  // so the range always matches the available drag distance on this device.
  // Upper bound deliberately tight: at 200px, TAP_MAX_DISTANCE in TouchInput
  // would hit 60px (vs 15 at default) which already makes rotation demanding
  // — any higher and taps become nearly impossible. Wide landscape tablets
  // max out at ~180px via the slider formula anyway.
  var SENSITIVITY_MIN = 10;
  var SENSITIVITY_MAX = 200;
  var SENSITIVITY_DEFAULT = 48; // matches TouchInput.RATCHET_THRESHOLD

  // Display format for the sensitivity value. The slider remains a log-scaled
  // abstract position driven by touchpad width; only the user-facing number
  // is the scaled multiplier (px / SENSITIVITY_DEFAULT). Snapped to 0.05 so
  // the displayed digits don't jitter between neighbouring integer-rounded
  // px values (e.g. 50/48 = 1.0417 reads as 1.05 instead of 1.04).
  var SENSITIVITY_SCALE_STEP = 0.05;

  function formatSensitivityScale(px) {
    var scaled = px / SENSITIVITY_DEFAULT;
    var snapped = Math.round(scaled / SENSITIVITY_SCALE_STEP) * SENSITIVITY_SCALE_STEP;
    return snapped.toFixed(2);
  }

  var state = {
    muted: false,
    haptic: 'medium',
    sensitivity: SENSITIVITY_DEFAULT
  };

  var listeners = [];

  // AirConsole persistent-data key — nested JSON under a single namespaced
  // key so we don't collide with other AirConsole games or future HexStacker
  // preferences. AC persists per-UID across sessions (unlike localStorage,
  // which is neutralized in AC mode). Populated async on init.
  var AC_KEY = 'stacker_settings';
  var _acWriteTimer = null;
  // True once the user has interacted with any setter. Blocks the async
  // AirConsole persistent-data load from clobbering a change that was
  // made between init() and the data arriving.
  var _dirty = false;

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* iframe sandbox */ }
  }

  function load() {
    state.muted = read(KEY_MUTED) === '1';
    var h = read(KEY_HAPTIC);
    state.haptic = HAPTIC_TIERS.indexOf(h) >= 0 ? h : 'medium';
    var s = parseInt(read(KEY_SENSITIVITY), 10);
    state.sensitivity = (!isNaN(s) && s >= SENSITIVITY_MIN && s <= SENSITIVITY_MAX)
      ? s
      : SENSITIVITY_DEFAULT;
  }

  function applyToSubsystems() {
    if (typeof ControllerAudio !== 'undefined' && ControllerAudio.setMuted) {
      ControllerAudio.setMuted(state.muted);
    }
    if (typeof touchInput !== 'undefined' && touchInput && touchInput._applySensitivity) {
      touchInput._applySensitivity(state.sensitivity);
    }
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { console.error('[settings] listener', e); }
    }
  }

  // --- AirConsole persistent storage ---
  // In AirConsole mode localStorage is neutralized (see AirConsoleAdapter).
  // We load the same three prefs from AC's per-user persistent store instead.
  // The request is async, so initial state comes from localStorage (defaults
  // in AC mode), then gets overwritten when AC data arrives and listeners
  // are notified so any open UI re-syncs.
  function hasAirConsole() {
    return typeof airconsole !== 'undefined'
      && airconsole
      && typeof airconsole.requestPersistentData === 'function'
      && typeof airconsole.storePersistentData === 'function';
  }

  function getOwnUid() {
    if (!hasAirConsole() || typeof airconsole.getUID !== 'function') return null;
    try {
      var id = airconsole.getDeviceId();
      return airconsole.getUID(id) || null;
    } catch (e) { return null; }
  }

  function initAirConsolePersistence() {
    if (!hasAirConsole()) return;
    var uid = getOwnUid();
    if (!uid) return;

    var prevOnLoaded = airconsole.onPersistentDataLoaded;
    airconsole.onPersistentDataLoaded = function (data) {
      try {
        // User has already touched a setting locally — don't clobber it.
        // The next setSensitivity/setMuted/setHapticStrength call will
        // persist the user's value to AC instead.
        if (_dirty) {
          if (prevOnLoaded) prevOnLoaded.call(airconsole, data);
          return;
        }
        var entry = data && data[uid];
        var saved = entry && entry[AC_KEY];
        if (typeof saved === 'string') {
          try { saved = JSON.parse(saved); } catch (_) { saved = null; }
        }
        if (saved && typeof saved === 'object') {
          if (typeof saved.muted === 'boolean') state.muted = saved.muted;
          if (HAPTIC_TIERS.indexOf(saved.haptic) >= 0) state.haptic = saved.haptic;
          if (typeof saved.sensitivity === 'number'
              && saved.sensitivity >= SENSITIVITY_MIN
              && saved.sensitivity <= SENSITIVITY_MAX) {
            state.sensitivity = saved.sensitivity;
          }
          applyToSubsystems();
          notify();
        }
      } catch (e) {
        console.warn('[settings] AC persistent-data parse failed', e);
      }
      if (prevOnLoaded) prevOnLoaded.call(airconsole, data);
    };

    try { airconsole.requestPersistentData([uid]); } catch (e) { /* ignore */ }
  }

  function writeAirConsolePersistent() {
    if (!hasAirConsole()) return;
    try {
      airconsole.storePersistentData(AC_KEY, JSON.stringify({
        muted: state.muted,
        haptic: state.haptic,
        sensitivity: state.sensitivity
      }));
    } catch (e) { /* ignore */ }
  }

  function schedulePersist() {
    // Debounce rapid changes (e.g. slider drag) so we don't spam the SDK.
    if (_acWriteTimer) clearTimeout(_acWriteTimer);
    _acWriteTimer = setTimeout(writeAirConsolePersistent, 300);
  }

  function init() {
    load();
    applyToSubsystems();
    initAirConsolePersistence();
  }

  function setMuted(val) {
    var next = !!val;
    // Only mark dirty on an actual change — syncSensitivityControls calls
    // the setters on every settings-open to round-trip the clamped value,
    // and a no-op shouldn't block the pending AC persistent-data load.
    if (next !== state.muted) _dirty = true;
    state.muted = next;
    write(KEY_MUTED, state.muted ? '1' : '0');
    if (typeof ControllerAudio !== 'undefined' && ControllerAudio.setMuted) {
      ControllerAudio.setMuted(state.muted);
    }
    schedulePersist();
    notify();
  }

  function setHapticStrength(tier) {
    if (HAPTIC_TIERS.indexOf(tier) < 0) return;
    if (tier !== state.haptic) _dirty = true;
    state.haptic = tier;
    write(KEY_HAPTIC, tier);
    schedulePersist();
    notify();
  }

  function setSensitivity(px) {
    var n = parseInt(px, 10);
    if (isNaN(n)) return;
    n = Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, n));
    if (n !== state.sensitivity) _dirty = true;
    state.sensitivity = n;
    write(KEY_SENSITIVITY, String(n));
    // Live-apply to the active TouchInput instance if present. Calls the
    // derived-threshold method so TAP / SOFT_DROP / FLICK all retune too.
    if (typeof touchInput !== 'undefined' && touchInput && touchInput._applySensitivity) {
      touchInput._applySensitivity(n);
    }
    schedulePersist();
    notify();
  }

  // Scale a vibration pattern by the configured haptic strength.
  // Returns null when the user has picked the 'off' tier. Callers are
  // expected to guard `navigator.vibrate` existence themselves — feature
  // detection on this API is unreliable across devices, so we just pass
  // the pattern through and let the platform decide.
  // Enforces a 3ms floor so 'light' tier never produces patterns too
  // short for some hardware to trigger.
  function scaleVibration(pattern) {
    var scale = HAPTIC_SCALE[state.haptic];
    if (scale <= 0) return null;
    if (Array.isArray(pattern)) {
      return pattern.map(function (p) { return Math.max(3, Math.round(p * scale)); });
    }
    return Math.max(3, Math.round(pattern * scale));
  }

  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  return {
    init: init,
    isMuted: function () { return state.muted; },
    setMuted: setMuted,
    getHapticStrength: function () { return state.haptic; },
    setHapticStrength: setHapticStrength,
    getSensitivity: function () { return state.sensitivity; },
    setSensitivity: setSensitivity,
    scaleVibration: scaleVibration,
    onChange: onChange,
    SENSITIVITY_MIN: SENSITIVITY_MIN,
    SENSITIVITY_MAX: SENSITIVITY_MAX,
    SENSITIVITY_DEFAULT: SENSITIVITY_DEFAULT,
    SENSITIVITY_SCALE_STEP: SENSITIVITY_SCALE_STEP,
    formatSensitivityScale: formatSensitivityScale,
    HAPTIC_TIERS: HAPTIC_TIERS
  };
})();

if (typeof window !== 'undefined') {
  window.ControllerSettings = ControllerSettings;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ControllerSettings;
}
