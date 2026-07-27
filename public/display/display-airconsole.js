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
// The display reads/writes no allowlisted keys (muted is reset above), so the
// shim installs with an empty allowlist purely to no-op incidental
// localStorage calls inside the AC iframe storage partition.
AirConsoleStorage.install(airconsole, { allowlist: [] });

// Apply the AC-profile locale before the lobby's first paint. Passed to the
// adapter as its onReady hook so the kit stays i18n-agnostic.
function applyAcLocale() {
  if (typeof airconsole.getLanguage !== 'function') return;
  if (typeof LOCALES === 'undefined' || typeof setLocale !== 'function' || typeof translatePage !== 'function') return;
  var acLang = airconsole.getLanguage();
  var acCode = acLang && acLang.toLowerCase().split('-')[0];
  if (acCode && LOCALES[acCode]) { setLocale(acLang); translatePage(); }
}

// AirConsole fires onReady at most once per page load. The display needs
// multi-shot replay because New Game / reconnect creates fresh adapters; the
// controller can use AirConsoleAdapter.captureEarlyReady's one-shot replay.
var _cachedAcReadyCode;
airconsole.onReady = function(code) { _cachedAcReadyCode = code; };

// Wire AirConsole pause/resume — silently freeze the game engine.
// No overlay, no broadcast to controllers. AirConsole auto-resumes
// when the connection stabilizes.
var _acPaused = false;
var _adPaused = false;
var _adMutedByUs = false;

airconsole.onPause = function() {
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  _acPaused = true;
  // The platform froze us, not the host: the same display-internal category as
  // an all-disconnected auto-pause, so it reuses that reason. Only when nothing
  // else has us frozen, though — AUTO absorbs a manual pause (deliberately, so
  // its stranded overlay comes down), and here that would quietly discard the
  // host's pause when the platform resumes us again.
  if (!paused) autoPause();
};

airconsole.onResume = function() {
  if (!_acPaused) return;
  _acPaused = false;
  if (_adPaused) return;
  autoResume();   // the AC freeze rides the AUTO reason, so this is what lifts it
};

// Wire ad events — pause and mute during ads, resume after.
airconsole.onAdShow = function() {
  if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
    _adPaused = true;
    if (!paused) autoPause();   // display-internal, like onPause above
  }
  if (music && !muted) { music.pause(); _adMutedByUs = true; }
};

airconsole.onAdComplete = function() {
  var adWasMuted = _adMutedByUs;
  _adMutedByUs = false;
  if (!_adPaused) { if (adWasMuted && music) music.resume(); return; }
  _adPaused = false;
  if (_acPaused) return;
  // Refused unless the ad's own freeze is what's left (a host pause or a link
  // drop stands), and unless somebody is back to play. A successful thaw resumes
  // the music itself; the check below covers the case where we never froze.
  autoResume();
  if (adWasMuted && music && !paused) music.resume();
};

// Guard checkAutoResume — don't resume while ad or platform pause is active.
var _origCheckAutoResume = checkAutoResume;
checkAutoResume = function() {
  if (_adPaused || _acPaused) return;
  _origCheckAutoResume();
};

// Request an ad break on game-end. All paths into RESULTS funnel through
// setRoomState, so this single hook covers natural finish, test harness, and
// replay. Hooking the *exit* from RESULTS (Play Again, New Game) would race:
// showAd is async, onAdShow would arrive after we've already transitioned into
// COUNTDOWN, and would clearCountdownTimers() without a restart path on resume.
// AirConsole rate-limits showAd internally, so no extra throttle is needed.
var _origSetRoomState = setRoomState;
setRoomState = function(newState) {
  var before = roomState;
  var ok = _origSetRoomState(newState);
  // Only request the ad break on a real transition into RESULTS.
  if (ok && before !== ROOM_STATE.RESULTS && newState === ROOM_STATE.RESULTS) {
    try { airconsole.showAd(); } catch (e) {}
  }
  return ok;
};

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
// `window.` qualifier is required: PartyConnection.js is stripped from the AC
// build, so no prior binding exists and strict-mode would reject a bare
// assignment with ReferenceError.
window.PartyConnection = function() {
  var adapter = new AirConsoleAdapter(airconsole, { role: 'display', onReady: applyAcLocale });
  var adapterOnReady = airconsole.onReady;
  airconsole.onReady = function(code) {
    _cachedAcReadyCode = code;
    adapterOnReady.call(airconsole, code);
  };
  return adapter;
};

// After connectAndCreateRoom() creates the adapter via new PartyConnection()
// and calls party.connect(), replay early onReady if the SDK fired before
// the adapter was wired.
var _originalConnectAndCreateRoom = connectAndCreateRoom;
connectAndCreateRoom = function() {
  _originalConnectAndCreateRoom();
  if (_cachedAcReadyCode !== undefined) airconsole.onReady(_cachedAcReadyCode);
};

// AirConsole players join via the AC app, not by scanning — suppress the QR so
// callers see qrMatrix=null (renderQR already null-guards on its own).
buildQRMatrix = function() { return null; };

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

injectVersionLabel('lobby-version-label');

function appVersion() {
  var meta = document.querySelector('meta[name="app-version"]');
  return meta ? meta.getAttribute('content') : '';
}

function injectVersionLabel(elementId) {
  var el = document.getElementById(elementId);
  if (el) el.textContent = appVersion();
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
