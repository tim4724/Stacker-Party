'use strict';

// =====================================================================
// AirConsole Controller Bootstrap
// Loaded AFTER all normal controller scripts but BEFORE controller.js init.
// Overrides PartyConnection so that connect() — which sets up callbacks
// and calls party.connect() — works with AirConsole instead.
// =====================================================================

var airconsole = new AirConsole({
  orientation: AirConsole.ORIENTATION_PORTRAIT,
  silence_inactive_players: false
});

// Replace window.localStorage with an AC-backed shim BEFORE Settings.init()
// runs in controller.js. The shim's allowlist excludes stacker_muted (the
// display's music key — defaults on every session), stacker_player_name,
// and clientId_* (AC owns identity); haptic, sensitivity, touch-sounds,
// and color-index round-trip via the SDK. We hold on to the returned shim
// directly: if Object.defineProperty silently fails (sealed window in some
// hosts), Settings.js falls back to real localStorage but our onLoad /
// requestLoad calls still need to work — `window.localStorage` would lack
// those methods.
var _acStorage = AirConsoleAdapter.installAirConsoleStorage(airconsole);

// Capture early onReady — the SDK may fire it before our adapter is wired up.
var replayEarlyReady = AirConsoleAdapter.captureEarlyReady(airconsole);

// controller.js reads roomCode from location.pathname and in AirConsole that
// parses to "controller.html". We live with it — the adapter routes messages
// by AC device ID, not roomCode, and bailToWelcome is overridden below to
// surface errors via the AirConsole status overlay. We can't normalize the
// URL via history.replaceState because the SDK's isDeviceInSameLocation_
// compares URLs and a mismatch breaks message routing silently.

// Skip the name screen — AirConsole manages identity via the SDK.
skipNameScreen = true;

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'controller' });
};

// Wrap connect() to inject AirConsole nickname + persistent-data load on
// top of the adapter's onReady. Re-wrap on every call — _originalConnect()
// creates a fresh AirConsoleAdapter whose _wireAirConsole overwrites
// ac.onReady, so a one-shot wrap would be silently dropped on reconnect.
var _originalConnect = connect;
connect = function() {
  // In AC mode party is created once by the first call to this wrapper and
  // the SDK owns the lifecycle — `performDisconnect` and `bailToWelcome` are
  // both overridden to skip the close-and-null path, so party stays set.
  // Bail on re-entry (e.g. visibilitychange refiring before the first onReady
  // lands) so we don't orphan an in-flight adapter with a replacement.
  if (party) return;
  _originalConnect();
  var _adapterOnReady = airconsole.onReady;
  airconsole.onReady = function(code) {
    // Pull the AC profile nickname into playerName before HELLO leaves.
    // The display falls back to "P<slot>" if this is empty, so the guard
    // here is just to avoid passing undefined into downstream code.
    var nickname = airconsole.getNickname(airconsole.getDeviceId());
    if (nickname) playerName = nickname;
    // getDeviceId() / getUID() are only valid after onReady — kick the
    // persistent-data fetch now. We don't hold HELLO: on reconnect the
    // SDK can fire onReady synchronously (cached state), at which point
    // adapter.connect() already ran fireReady and our wrap can't
    // intercept. Color reclaim is instead retried from the onLoad
    // callback below, which fires reliably whether or not WELCOME
    // already arrived.
    _adapterOnReady.call(airconsole, code);
    _acStorage.requestLoad();
  };
  // Captured-early replay: if the SDK already fired onReady before our
  // wrap was installed, run wrapped now. No-op otherwise.
  replayEarlyReady();
  // Re-apply persisted Settings and re-attempt color reclaim once the
  // shim's cache has hydrated. Either onWelcome already fired (HELLO
  // raced ahead) and reclaim was a no-op there because
  // _previousSessionColorIndex was still null — recapturing here and
  // reclaiming again catches up. Or onWelcome hasn't fired yet, in which
  // case its own reclaim call will see the captured value and fire
  // SET_COLOR. Either path lands on the user's preferred color.
  _acStorage.onLoad(function() {
    ControllerSettings.reload();
    captureSessionColorIndex();
    if (typeof reclaimPreferredColor === 'function') reclaimPreferredColor();
  });
};

AirConsoleAdapter.injectVersionLabel('settings-version');

// Drive the sensitivity slider via pointer events.
//
// Symptom (real phone, AC iframe): touch-down moves the thumb to the
// tap position, but a continued finger drag does nothing — the slider
// freezes after the initial set. Mouse drag works. CDP-injected touch
// also "works" in tests, so synthetic touch is a misleading proxy.
//
// Tested theories that did NOT fix it:
// - `touch-action: none` on the slider (cc02eaf, reverted) — page-level
//   touch-action is already `none` on body/html, and adding it to the
//   slider didn't change behavior. So the bug isn't the browser
//   reinterpreting the gesture as scroll/pan.
//
// What works: explicit pointer-event handling — capture the pointer on
// down, map clientX to slider value on every move, dispatch a synthetic
// 'input' event so controller.js's existing handler picks it up.
//
// Verify manually on a real phone in the AC simulator: open Settings,
// drag the sensitivity slider, watch the value display update and the
// touchpad ratchet retune. Don't trust an automated CDP touch test —
// see PR #115 thread for the false-positive history.
(function() {
  var slider = document.getElementById('sensitivity-slider');
  if (!slider) return;
  var dragging = false;
  function setFromPointer(e) {
    var rect = slider.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    var min = parseFloat(slider.min) || 0;
    var max = parseFloat(slider.max) || 1;
    var step = parseFloat(slider.step) || 0;
    var v = min + ratio * (max - min);
    if (step > 0) v = Math.round((v - min) / step) * step + min;
    v = Math.max(min, Math.min(max, v));
    // Assign first and compare browser-normalized strings — our raw float
    // (e.g. 1.1500000000000001) gets normalized to "1.15" by the slider,
    // so a String(v) === slider.value test would always differ and fire a
    // redundant 'input' (and accompanying vibrate) on every pointermove.
    var prev = slider.value;
    slider.value = String(v);
    if (slider.value !== prev) {
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  slider.addEventListener('pointerdown', function(e) {
    dragging = true;
    slider.setPointerCapture(e.pointerId);
    setFromPointer(e);
    e.preventDefault();
  });
  slider.addEventListener('pointermove', function(e) {
    if (!dragging) return;
    setFromPointer(e);
  });
  function end(e) {
    if (!dragging) return;
    dragging = false;
    try { slider.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  slider.addEventListener('pointerup', end);
  slider.addEventListener('pointercancel', end);
})();

// AirConsole status overlay: show "Loading..." until lobby, show errors.
var _acStatusOverlay = document.getElementById('ac-status-overlay');
var _origShowScreen = showScreen;
showScreen = function(name) {
  _origShowScreen(name);
  // Hide loading overlay once we leave the name screen
  if (_acStatusOverlay && name !== 'name') {
    _acStatusOverlay.classList.add('hidden');
  }
};

// `bailToWelcome` in ControllerConnection.js does `location.replace('/')`,
// which would break out of the AC-owned iframe. Surface the bail reason
// through the AC status overlay instead — AC owns home/lobby navigation.
// Clears game state so stale incoming messages can't re-trigger game logic.
// Closes the settings popup too — non-AC mode gets that for free via the
// page navigation, but here the page stays alive and a stale settings
// overlay would otherwise sit on top of the AC status overlay.
// `keepClientId` is deliberately ignored — the AC storage shim doesn't
// allowlist clientId_* keys, so there's nothing to keep or clear; identity
// is owned by the SDK (see AirConsoleAdapter.installAirConsoleStorage).
bailToWelcome = function(toastKey /*, keepClientId */) {
  if (gameCancelled) return;
  gameCancelled = true;
  stopPing();
  closeSettingsOverlay();
  if (_acStatusOverlay) {
    _acStatusOverlay.textContent = toastKey ? t(toastKey) : '';
    _acStatusOverlay.classList.toggle('hidden', !toastKey);
  }
};

// Don't create history entries in the AC iframe. ControllerState.js'
// showScreen() calls history.pushState on name→lobby so standalone web users
// can swipe/back to the name screen; in AC mode that "back" target is CSS-
// hidden and AC owns iframe navigation anyway. The entry we'd push is
// exactly what a spurious popstate (SDK location check, bfcache restore,
// phone back gesture) pops to, triggering performDisconnect. Skip the push
// and there's nothing for popstate to land on. performDisconnect stays a
// no-op as belt-and-suspenders in case some other history source pops.
history.pushState = function() {};
performDisconnect = function() {};

// Route haptics through the AirConsole SDK so the iframe's permissions policy
// can't silently block vibration. The SDK only accepts a single duration, so
// array patterns are summed (even indices = on-durations) and routed through
// `airconsole.vibrate` as the total ms. This loses the rhythm but preserves
// the total vibration energy — better than falling back to navigator.vibrate
// which the iframe permissions policy usually blocks outright.
function _acVibrate(pattern) {
  // Respect the user's haptic-strength setting (off/light/medium/strong).
  pattern = ControllerSettings.scaleVibration(pattern);
  if (pattern === null) return;
  // AirConsole SDK takes only a single duration. Collapse array patterns
  // (hard drop's [8, 8, 8]) by summing the on-durations — even indices are
  // vibrate, odd are pauses — so the total energy survives even though the
  // rhythm is lost.
  if (Array.isArray(pattern)) {
    var total = 0;
    for (var i = 0; i < pattern.length; i += 2) total += pattern[i];
    pattern = total;
  }
  // After the array-collapse above, `pattern` is always a number (or we
  // returned early on null). Skip 0 to avoid a no-op SDK call.
  if (pattern > 0) airconsole.vibrate(pattern);
}
// Overrides ControllerState.js#vibrate (global) and the TouchInput prototype.
vibrate = _acVibrate;
TouchInput.prototype._haptic = _acVibrate;

