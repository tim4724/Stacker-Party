'use strict';

// =====================================================================
// AirConsole Display Bootstrap
// Loaded AFTER all normal display scripts but BEFORE display.js init runs.
// Overrides PartyConnection so that connectAndCreateRoom() — which sets up
// callbacks and calls party.connect() — works with AirConsole instead.
// =====================================================================

var airconsole = new AirConsole({ orientation: AirConsole.ORIENTATION_LANDSCAPE });

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
// connectAndCreateRoom() calls `new PartyConnection(...)`, sets callbacks,
// then calls `party.connect()`. By replacing the constructor, we let the
// original function body run unchanged.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'display' });
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
