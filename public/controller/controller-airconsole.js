'use strict';

// =====================================================================
// AirConsole Controller Bootstrap
// Loaded AFTER all normal controller scripts but BEFORE controller.js init.
// Overrides PartyConnection so that connect() — which sets up callbacks
// and calls party.connect() — works with AirConsole instead.
// =====================================================================

AirConsoleAdapter.neutralizeLocalStorage();

var airconsole = new AirConsole({
  orientation: AirConsole.ORIENTATION_PORTRAIT,
  silence_inactive_players: false
});

// Capture early onReady — the SDK may fire it before our adapter is wired up.
var _acEarlyReadyCode;
var _acEarlyReady = false;
airconsole.onReady = function(code) {
  _acEarlyReady = true;
  _acEarlyReadyCode = code;
};

// controller.js reads roomCode from location.pathname and in AirConsole that
// parses to "controller.html". We live with it — the adapter routes messages
// by AC device ID, not roomCode, and showEndScreen is overridden below to
// surface errors via the AirConsole status overlay. We can't normalize the
// URL via history.replaceState because the SDK's isDeviceInSameLocation_
// compares URLs and a mismatch breaks message routing silently.

// Skip the name screen — AirConsole manages identity via the SDK.
skipNameScreen = true;

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'controller' });
};

// Wrap connect() to inject AirConsole nickname/locale on top of the adapter's
// onReady. Re-wrap on every call — _originalConnect() creates a fresh
// AirConsoleAdapter whose _wireAirConsole overwrites ac.onReady, so a one-shot
// wrap would be silently dropped on reconnect.
var _originalConnect = connect;
connect = function() {
  // In AC mode party is created once by the first call to this wrapper and
  // the SDK owns the lifecycle — `performDisconnect` and `showEndScreen` are
  // both overridden to skip the close-and-null path, so party stays set.
  // Bail on re-entry (e.g. visibilitychange refiring before the first onReady
  // lands) so we don't orphan an in-flight adapter with a replacement.
  if (party) return;
  // Set nickname before connect sends HELLO (early-ready race)
  var nick = airconsole.getNickname(airconsole.getDeviceId());
  if (nick) playerName = nick;
  _originalConnect();
  var _adapterOnReady = airconsole.onReady;
  airconsole.onReady = function(code) {
    var nickname = airconsole.getNickname(airconsole.getDeviceId());
    if (nickname) playerName = nickname;
    // Per the AirConsole checklist: "the game and the controller may have
    // different languages" — each device uses its own.
    AirConsoleAdapter.applyLocale(airconsole);
    // Now that getUID() is valid, load the user's persisted settings.
    // ControllerSettings.init already tried at page load but UID was null;
    // initAirConsolePersistence is idempotent (re-installs onPersistentDataLoaded
    // and re-issues requestPersistentData).
    if (typeof ControllerSettings !== 'undefined' && ControllerSettings.initAirConsolePersistence) {
      ControllerSettings.initAirConsolePersistence();
    }
    if (_adapterOnReady) _adapterOnReady.call(airconsole, code);
  };
  // Replay the captured-early onReady into the freshly-wired adapter.
  // The SDK fires onReady at most once per session, so reconnect paths rely
  // on this manual replay to bring a new adapter to ready. Guard on
  // !party.connected so already-connected sessions don't double-fire; the
  // adapter's _fireReady is itself idempotent, so this is belt-and-suspenders.
  if (_acEarlyReady && party && !party.connected) {
    airconsole.onReady(_acEarlyReadyCode);
  }
};

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

// Override showEndScreen to surface errors via the AirConsole status overlay
// instead of the end screen (AirConsole has its own home/lobby navigation).
// Still clear game state so stale incoming messages can't re-trigger game logic.
// keepClientId (second arg) is deliberately ignored — AirConsole manages
// device identity via its SDK, not via localStorage. party.close() is also
// skipped because the AirConsole adapter's lifecycle is owned by the SDK.
showEndScreen = function(toastKey /*, keepClientId */) {
  gameCancelled = true;
  stopPing();
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
  if (typeof ControllerSettings !== 'undefined' && ControllerSettings.scaleVibration) {
    pattern = ControllerSettings.scaleVibration(pattern);
    if (pattern === null) return;
  }
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
  // returned early on null). Nothing else reaches this point.
  if (typeof pattern === 'number' && pattern > 0) {
    airconsole.vibrate(pattern);
  }
}
// Overrides ControllerState.js#vibrate (global) and the TouchInput prototype.
vibrate = _acVibrate;
if (window.TouchInput) TouchInput.prototype._haptic = _acVibrate;

