'use strict';

// =====================================================================
// AirConsole Display Bootstrap
// Loaded AFTER all normal display scripts but BEFORE display.js init runs.
// Overrides PartyConnection so that connectAndCreateRoom() — which sets up
// callbacks and calls party.connect() — works with AirConsole instead.
// =====================================================================

var airconsole = new AirConsole({
  orientation: AirConsole.ORIENTATION_LANDSCAPE,
  silence_inactive_players: false
});

// Capture early onReady — the SDK may fire it before our adapter is wired up.
var _acEarlyReadyCode;
var _acEarlyReady = false;
airconsole.onReady = function(code) {
  _acEarlyReady = true;
  _acEarlyReadyCode = code;
};

// Wire AirConsole pause/resume — silently freeze the game engine.
// No overlay, no broadcast to controllers. AirConsole auto-resumes
// when the connection stabilizes.
var _acPaused = false;
airconsole.onPause = function() {
  console.log('[AirConsole] onPause — connection unstable');
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  if (paused) return;
  _acPaused = true;
  paused = true;
  autoPaused = true;
  if (roomState === ROOM_STATE.COUNTDOWN) clearCountdownTimers();
  if (displayGame) displayGame.pause();
  if (music) music.pause();
};

airconsole.onResume = function() {
  console.log('[AirConsole] onResume — connection restored');
  if (!_acPaused) return;
  _acPaused = false;
  if (autoPaused) { autoPaused = false; resumeGame(); }
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
  if (_acEarlyReady && party && !party.connected) {
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

// Init music when game starts — AirConsole's iframe has allow="autoplay" so we
// don't need a user gesture. In standalone mode, initMusic() is called on button click.
// startGame is defined in DisplayGame.js which loads before this script.
var _origStartGame = startGame;
startGame = function() {
  initMusic();
  _origStartGame();
};

// Skip welcome screen — go straight to lobby.
// onRoomCreated caches as preCreatedRoom when currentScreen === WELCOME,
// so setting it to LOBBY ensures the room is applied immediately.
currentScreen = SCREEN.LOBBY;

// Populate lobby version label. Build script replaces __AC_VERSION__
// with the actual version. Falls back to /api/version for local dev.
var _lobbyVersionLabel = document.getElementById('lobby-version-label');
if (_lobbyVersionLabel) {
  var _acVersion = '__AC_VERSION__';
  if (_acVersion.indexOf('__') !== 0) {
    _lobbyVersionLabel.textContent = _acVersion;
  } else {
    fetch('/api/version').then(function(r) { return r.json(); }).then(function(data) {
      _lobbyVersionLabel.textContent = data.version || '';
    }).catch(function() {});
  }
}

// Intercept showScreen(WELCOME) — in AirConsole there's no welcome screen.
// display.js defines resetToWelcome() which shows WELCOME; we redirect to LOBBY.
// No connectAndCreateRoom() here — resetToWelcome() already calls it after showScreen().
var _originalShowScreen = showScreen;
showScreen = function(name) {
  if (name === SCREEN.WELCOME) {
    _originalShowScreen(SCREEN.LOBBY);
    return;
  }
  _originalShowScreen(name);
};
