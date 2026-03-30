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
// Instead, pre-set roomCode and override showRoomGone to be a no-op.
// controller.js will overwrite roomCode with "controller.html" — that's fine,
// we just need to ensure the if(roomCode) block executes.
// AirConsole has no room concept — showRoomGone would show a "Room Not Found"
// error when controller.js can't find a room code in the URL. Safe to silence.
showRoomGone = function() {};

// Pre-set clientId (adapter maps real AirConsole device IDs at message time)
clientId = 'ac_controller';

// Force hadStoredId so controller.js auto-connects on load (skips name screen).
// controller.js parses location.pathname to get roomCode (e.g. "controller.html")
// and checks sessionStorage['clientId_' + roomCode]. We pre-set that key here.
// Coupling: depends on controller.html filename and controller.js line ~89 parsing logic.
var _acRoomCode = location.pathname.split('/').filter(Boolean)[0] || 'airconsole';
sessionStorage.setItem('clientId_' + _acRoomCode, clientId);

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'controller' });
};

// Wrap connect() to inject AirConsole nickname and replay early onReady
var _originalConnect = connect;
var _acOnReadyWrapped = false; // one-time setup — AirConsole onReady fires once per session
connect = function() {
  if (party && party.connected) return;
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

