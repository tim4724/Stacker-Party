'use strict';

// =====================================================================
// AirConsole Controller Bootstrap
// Loaded AFTER all normal controller scripts but BEFORE controller.js init.
// Overrides PartyConnection so that connect() — which sets up callbacks
// and calls party.connect() — works with AirConsole instead.
// =====================================================================

// AirConsole requires fresh audio state on each load (no persisted mute).
// Clear before controller.js reads it.
try { localStorage.removeItem('stacker_muted'); } catch (e) { /* iframe sandbox */ }

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

// controller.js reads roomCode from location.pathname. In AirConsole the URL
// is /controller.html which gets parsed as roomCode="controller.html".
// We can't use history.replaceState because it breaks AirConsole's SDK
// location matching (isDeviceInSameLocation_ compares URLs).
// Instead, pre-set roomCode and override showEndScreen to surface errors
// via the AirConsole status overlay instead of the end screen.
// controller.js will overwrite roomCode with "controller.html" — that's fine,
// we just need to ensure the if(roomCode) block executes.

// Pre-set clientId (adapter maps real AirConsole device IDs at message time)
clientId = 'ac_controller';

// Skip the name screen — AirConsole manages identity via the SDK.
skipNameScreen = true;

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'controller' });
};

// Wrap connect() to inject AirConsole nickname and replay early onReady
var _originalConnect = connect;
var _acOnReadyWrapped = false; // one-time setup — AirConsole onReady fires once per session
connect = function() {
  if (party && party.connected) return;
  // Set nickname before connect sends HELLO (early-ready race)
  var nick = airconsole.getNickname(airconsole.getDeviceId());
  if (nick) playerName = nick;
  _originalConnect();
  // Wrap onReady AFTER adapter is created to inject nickname from AirConsole profile
  if (!_acOnReadyWrapped) {
    _acOnReadyWrapped = true;
    var _adapterOnReady = airconsole.onReady;
    airconsole.onReady = function(code) {
      var nickname = airconsole.getNickname(airconsole.getDeviceId());
      if (nickname) playerName = nickname;
      if (_adapterOnReady) _adapterOnReady.call(airconsole, code);
    };
    // Replay early onReady if the SDK fired before the adapter was wired
    if (_acEarlyReady) {
      airconsole.onReady(_acEarlyReadyCode);
    }
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

