'use strict';

// =====================================================================
// AirConsole Display Bootstrap
// Loaded AFTER all normal display scripts but BEFORE display.js init runs.
// Overrides PartyConnection so that connectAndCreateRoom() — which sets up
// callbacks and calls party.connect() — works with AirConsole instead.
// =====================================================================

var airconsole = new AirConsole({ orientation: AirConsole.ORIENTATION_LANDSCAPE });

// Capture early onReady — the SDK may fire it before our adapter is wired up.
var _acEarlyReadyCode = undefined;
var _acEarlyReady = false;
airconsole.onReady = function(code) {
  _acEarlyReady = true;
  _acEarlyReadyCode = code;
};

// Wire AirConsole pause/resume to existing game pause
airconsole.onPause = function() {
  if (roomState === ROOM_STATE.PLAYING && !paused) {
    pauseGame();
  }
};

airconsole.onResume = function() {
  if (paused) {
    resumeGame();
  }
};

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'display' });
};

// After connectAndCreateRoom() creates the adapter via new PartyConnection()
// and calls party.connect(), replay early onReady if the SDK fired before
// the adapter was wired.
var _originalConnectAndCreateRoom = connectAndCreateRoom;
connectAndCreateRoom = function() {
  _originalConnectAndCreateRoom();
  if (_acEarlyReady && party && !party._ready) {
    // The adapter's onReady handler was set by _wireAirConsole but the SDK
    // already fired. Replay it now.
    airconsole.onReady(_acEarlyReadyCode);
  }
};

// No local server APIs in AirConsole (QR, base URL)
fetchBaseUrl = function() {};
fetchQR = function(text, cb) { if (cb) cb(null); };

// renderQR no-op when qrMatrix is null
var _originalRenderQR = renderQR;
renderQR = function(canvas, matrix) {
  if (!matrix) return;
  _originalRenderQR(canvas, matrix);
};

// Skip welcome screen — go straight to lobby.
// onRoomCreated caches as preCreatedRoom when currentScreen === WELCOME,
// so setting it to LOBBY ensures the room is applied immediately.
currentScreen = SCREEN.LOBBY;

// Intercept showScreen(WELCOME) — in AirConsole there's no welcome screen.
// display.js defines resetToWelcome() which shows WELCOME; we redirect to LOBBY.
var _originalShowScreen = showScreen;
showScreen = function(name) {
  if (name === SCREEN.WELCOME) {
    _originalShowScreen(SCREEN.LOBBY);
    connectAndCreateRoom();
    return;
  }
  _originalShowScreen(name);
};
