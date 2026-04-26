'use strict';

// =====================================================================
// AirConsole Display Bootstrap
// Loaded AFTER all normal display scripts but BEFORE display.js init runs.
// Overrides PartyConnection so that connectAndCreateRoom() — which sets up
// callbacks and calls party.connect() — works with AirConsole instead.
// =====================================================================

// DisplayState.js already read muted from real localStorage before this
// bootstrap ran — reset it here so AC starts unmuted regardless. The
// storage shim is installed below but excludes stacker_muted, so future
// reads return null and music defaults on every session.
muted = false;

var airconsole = new AirConsole({
  orientation: AirConsole.ORIENTATION_LANDSCAPE,
  silence_inactive_players: false
});

// Install the AC-backed localStorage shim. The display itself doesn't
// read or write any allowlisted key — `muted = false` above resets the
// display's music mute directly — but installing the shim guarantees
// any incidental localStorage call from shared code (e.g. CSP-enabled
// libraries) silently no-ops instead of bleeding state into the AC
// iframe storage partition.
AirConsoleAdapter.installAirConsoleStorage(airconsole);

// Capture early onReady — the SDK may fire it before our adapter is wired up.
var replayEarlyReady = AirConsoleAdapter.captureEarlyReady(airconsole);

// Wire AirConsole pause/resume — silently freeze the game engine.
// No overlay, no broadcast to controllers. AirConsole auto-resumes
// when the connection stabilizes.
var _acPaused = false;
var _adPaused = false;
var _adMutedByUs = false;

airconsole.onPause = function() {
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  _acPaused = true;
  if (paused) return;
  paused = true;
  setAutoPaused(true);
  if (roomState === ROOM_STATE.COUNTDOWN) clearCountdownTimers();
  if (displayGame) displayGame.pause();
  if (music) music.pause();
};

airconsole.onResume = function() {
  if (!_acPaused) return;
  _acPaused = false;
  if (_adPaused) return;
  if (autoPaused) { setAutoPaused(false); resumeGame(); }
};

// Wire ad events — pause and mute during ads, resume after.
airconsole.onAdShow = function() {
  if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
    _adPaused = true;
    if (!paused) {
      paused = true;
      setAutoPaused(true);
      if (roomState === ROOM_STATE.COUNTDOWN) clearCountdownTimers();
      if (displayGame) displayGame.pause();
    }
  }
  if (music && !muted) { music.pause(); _adMutedByUs = true; }
};

airconsole.onAdComplete = function() {
  var adWasMuted = _adMutedByUs;
  if (_adMutedByUs) _adMutedByUs = false;
  if (!_adPaused) { if (adWasMuted && music) music.resume(); return; }
  _adPaused = false;
  if (_acPaused) return;
  var canResume = autoPaused && !allPlayersDisconnected();
  if (adWasMuted && (canResume || !paused)) { if (music) music.resume(); }
  if (canResume) { setAutoPaused(false); resumeGame(); }
};

// Guard checkAutoResume — don't resume while ad or platform pause is active.
var _origCheckAutoResume = checkAutoResume;
checkAutoResume = function() {
  if (_adPaused || _acPaused) return;
  _origCheckAutoResume();
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
  // The adapter's own onReady applies AC-profile locale before firing
  // 'created'; we just need to replay any captured-early onReady so a
  // fresh adapter on reconnect / Play Again reaches ready.
  replayEarlyReady();
};

// No /api/qr in AirConsole — short-circuit so callers see qrMatrix=null
// instead of a doomed fetch + console.error. fetchBaseUrl already returns
// early outside of localhost; renderQR already null-guards on its own.
fetchQR = function(text, cb) { if (cb) cb(null); };

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

AirConsoleAdapter.injectVersionLabel('lobby-version-label');

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

// Don't touch session history in the AC iframe. The standalone web build
// pushes {screen:'game'} on countdown and pops it with history.back() on
// returnToLobby so the browser back button moves between lobby/game/results;
// inside AirConsole the platform watches the screen iframe's history and
// interprets history.back() as "game ended, reset the master controller",
// which tears down the master controller's iframe (observed in the
// simulator: the new-host late-joiner lands on about:blank on NEW GAME).
// Neutralize pushState so nothing ever lands on the stack, back so
// returnToLobbyUI's cleanup is a no-op, replaceState for good measure.
// Compare controller-airconsole.js which no-ops only pushState — the
// controller never calls history.back() from our code, so the simulator
// kill doesn't reach it.
history.pushState = function() {};
history.replaceState = function() {};
history.back = function() {};
