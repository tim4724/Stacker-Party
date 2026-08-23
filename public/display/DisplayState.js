'use strict';

// =====================================================================
// Shared Display State — loaded first, all vars are globals
// =====================================================================

// --- Screen Constants ---
var SCREEN = { WELCOME: 'welcome', LOBBY: 'lobby', GAME: 'game', RESULTS: 'results' };

// --- URL Parameters ---
var urlParams = new URLSearchParams(window.location.search);
var debugCount = parseInt(urlParams.get('debug'), 10) || 0;

// --- State ---
var currentScreen = SCREEN.WELCOME;
var party = null;
// Optional P2P DataChannel layer keyed by controller peerIndex. Controllers
// initiate; the display auto-accepts via fastlane.handleSignal. Inbound
// fastlane messages funnel into the same handleControllerMessage as WS.
// Stays null in AirConsole mode (no WebRTC) and ?test=1 harness mode.
var fastlane = null;
var roomCode = null;
var joinUrl = null;
var lastRoomCode = null;
var lastInstance = null;       // relay instance id from `created` — pins reconnect / controller WS to the same shard
var gameState = null;
// RoomCore (server/RoomCore.js, shipped in dist/partycore.js) is the single
// source of truth for everything a controller renders: roster identity and join
// order, auto-naming, colour slots, host election, the pause/mute/results facts,
// and the retained room snapshot itself. tvOS and Android TV load the same
// module out of the same bundle, so the three displays cannot drift.
//
// It composes the generic PartyPlug RoomFlow (reachable as roomCore.flow, though
// nothing here should need it) and keeps liveness as pure nowMs-injected
// predicates; this file keeps the EFFECTS (QR fetch, pause/resume, returnToLobby).
var roomCore = new window.GameEngine.RoomCore({
  maxPlayers: GameConstants.MAX_PLAYERS,
  masterProvider: function () {
    return (party && typeof party.getMasterPeerIndex === 'function')
      ? party.getMasterPeerIndex() : null;
  },
  liveness: {
    timeoutMs: GameConstants.LIVENESS_TIMEOUT_MS,
    graceMs: GameConstants.LATE_JOINER_GRACE_MS,
    // MUST be a late-bound closure: display-airconsole.js sets window.airconsole
    // AFTER this file loads, so a construction-time `!window.airconsole` would
    // always be true and the AirConsole liveness no-op would be lost.
    enabledProvider: function () { return !window.airconsole; }
  }
});
// ROOM_STATE (protocol.js, shared with controllers) and the kit's STATES are
// separate copies of the same string set: protocol.js can't depend on the kit.
// Fail loudly if a future rename in one silently diverges from the other.
var _coreStates = window.GameEngine.RoomCore.STATES;
if (ROOM_STATE.LOBBY !== _coreStates.LOBBY ||
    ROOM_STATE.COUNTDOWN !== _coreStates.COUNTDOWN ||
    ROOM_STATE.PLAYING !== _coreStates.PLAYING ||
    ROOM_STATE.RESULTS !== _coreStates.RESULTS) {
  throw new Error('ROOM_STATE and RoomCore.STATES have drifted — keep the string values in sync');
}
// Pause reasons, from the room core so the strings are never retyped here.
var PAUSE = window.GameEngine.RoomCore.PAUSE;
// Roster backing store, aliased onto the room core's map so existing reads
// (players.get/has/size/for..of) keep working; writes go through the room core
// (peerJoined/hello/peerLeft/setColor/...). roomCore.reset() clears this same Map.
// peerIndex (1..N for controllers; the display owns slot 0, not in this map)
// -> { playerName, playerIndex (color slot), startLevel, helloSeen, joinedAt, connected }
var players = roomCore.players;

// The rest of the room's truth lives in the room core too. These properties keep the
// old global names so every read site stays untouched; the setters forward, so a
// stray write can't create a second source of truth. No `var` on any of them:
// a var declaration would make the window property non-configurable and this
// would throw.
//
// playerOrder: compact list of active controller peerIndices for game layout.
// Lobby cards and in-game boards both sort by joinedAt; playerIndex is the
// chosen color slot only. Deliberately NOT the same as the kit's internal
// participant order (empty in the lobby, where host eligibility is open).
Object.defineProperty(window, 'playerOrder', {
  configurable: true,
  get: function () { return roomCore.participants; },
  set: function (v) { roomCore.setParticipants(v); }
});

// The RAW sticky host slot. Use getHostPeerIndex() for the effective
// (fallback-resolved) host: the two differ during a mid-game blip when the
// sticky holder is disconnected but their slot stays pinned for their return.
Object.defineProperty(window, 'hostPeerIndex', {
  configurable: true,
  get: function () { return roomCore.stickyHost; },
  set: function () { throw new Error('hostPeerIndex is read-only; the host moves via the room core (hello/peerLeft/claim)'); }
});

// setRoomState() drives the machine; the transition table and sticky-host
// reconcile live in the kit. The setter throws so a stray `roomState = X` is
// caught loudly instead of silently lost.
Object.defineProperty(window, 'roomState', {
  configurable: true,
  get: function () { return roomCore.state; },
  set: function () { throw new Error('roomState is read-only; use setRoomState()'); }
});

function setRoomState(newState) {
  var result = roomCore.transitionTo(newState);
  // Controllers route their screens purely off snapshot.roomState, so every
  // transition publishes here, immediately, ahead of the level/colour throttle.
  // Routing them from one guaranteed publish per transition is what let the
  // GAME_START / COUNTDOWN / GAME_END / RETURN_TO_LOBBY broadcasts go.
  //
  // Through the hint rather than publishing directly, so a transition inside a
  // batch (the engine frame that ends a match) folds into that batch's single
  // publish instead of firing its own mid-drain. Outside a batch the hint is
  // always 'now', so this is unchanged.
  publishAs(result.publish);
  return result.changed;
}

// WHY we are paused, not just that we are: a link-drop pause and a host pressing
// Pause mean opposite things to a controller, and only the manual one is
// actionable (Continue). One field in the room core holds the reason;
// `paused` is derived from it and is what the render loop and input gate read.
// Never written here: the six pause/resume operations in DisplayGame.js are the
// only writers, and they run the room core's state machine.
Object.defineProperty(window, 'paused', {
  configurable: true,
  get: function () { return roomCore.paused; },
  set: function () { throw new Error('paused is read-only; use pauseGame()/resumeGame()'); }
});
Object.defineProperty(window, 'pauseReason', {
  configurable: true,
  get: function () { return roomCore.pauseReason; },
  set: function () { throw new Error('pauseReason is read-only; use pauseGame()/resumeGame()'); }
});
var boardRenderers = [];
var uiRenderers = [];
var animations = null;
var music = null;
var canvas = null;
var ctx = null;
var disconnectedQRs = new Map();
var garbageIndicatorEffects = new Map();
var garbageDefenceEffects = new Map();
var welcomeBg = null;
var displayGame = null;
var baseUrlOverride = null;    // LAN base URL from server (fetched on init)

// Countdown state (display manages countdown since server no longer does)
var countdown = { timer: null, remaining: 0, callback: null, goTimeout: null, overlayTimer: null };

// Controller liveness
var livenessInterval = null;

// True while we are IN the room, not merely holding an open socket. Gates the
// controller-liveness sweep: until the relay answers our create/join it routes
// nothing to us, so every lastSeen is stale through no fault of the controllers.
// Cleared on the socket dropping, restored by 'created'/'joined'. Starts true so
// the AirConsole adapter (which synthesizes 'created' but never drops) and the
// gallery/test harnesses behave as before.
var joinedRoom = true;

// Display heartbeat — send echo to self via relay to verify connection
var lastHeartbeatEcho = 0;
var lastHeartbeatSent = 0;
var heartbeatSent = false;
var disconnectedTimer = null;

// Relay region (from 'created' protocol msg) and RTT (measured via heartbeat
// self-echo in DisplayConnection.js). consecutiveBadRtt drives the lobby
// "report bad latency" CTA — revealed once the user has seen sustained pain
// rather than a single spike.
var relayRegion = null;
var lastRelayRtt = -1;
var consecutiveBadRtt = 0;
var RELAY_RTT_GOOD_MS = 100;
var RELAY_RTT_OK_MS = 200;
var RELAY_REPORT_THRESHOLD = 5;

// The final ranking, replayed in the RESULTS snapshot so a controller that
// rejoins on the results screen still sees it. Owned by the room core (which also
// re-keys it when a player rejoins from another device); this property keeps the
// old global name for the write sites.
Object.defineProperty(window, 'lastResults', {
  configurable: true,
  get: function () { return roomCore.results; },
  set: function (v) { roomCore.setResults(v); }
});

// Clear all room-local state — used when entering a fresh room or returning to welcome.
// Note: does not touch the publish throttle state (module-private to
// DisplayConnection) or roomCode.
// Calls clearCountdownTimers() (defined in DisplayGame.js) — only safe after all
// scripts load. roomCore.reset() clears the roster, presence set, and the
// late-joiner grace deadline.
function resetRoomData() {
  if (music) music.stop();
  clearCountdownTimers();
  countdown.callback = null;
  countdown.remaining = 0;
  // Resets the roster (the same Map `players` aliases), host slot, joinedAt
  // sequence, participant order, presence set, alive flags, results, the pause
  // reason, and the room state back to lobby. Mute survives (a device
  // preference, not room state).
  roomCore.reset();
  // Idempotent after reset(); called for the toolbar chrome it also drives.
  clearPause();
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
}

// Browser history navigation state
var popstateNavigating = false;
var suppressPopstate = false;

// Pre-created room state (ready before user clicks "New Game")
var preCreatedRoom = null;  // { roomCode, joinUrl }

// Mute. The room core holds it (the snapshot carries displayMuted); localStorage is
// this shell's business, so the persisted value is read here and pushed in.
//
// The setter deliberately drops the publish hint: its only writers are the two
// load-time seeds below (and display-airconsole.js), which run before there is a room
// to publish to. Every user-driven change goes through setDisplayMuted, which honours
// the hint like every other mutator on this display.
Object.defineProperty(window, 'muted', {
  configurable: true,
  get: function () { return roomCore.muted; },
  set: function (v) { roomCore.setMuted(v); }
});
try { muted = localStorage.getItem('stacker_muted') === '1'; } catch (e) { /* iframe sandbox */ }

// Render loop RAF handle (for stop/start)
var rafId = null;

// Cached window dimensions (updated on resize, avoids forced layout in render loop)
var cachedW = window.innerWidth;
var cachedH = window.innerHeight;

// Wake Lock — prevents screen sleep during active games
var wakeLock = null;

// RAF-driven game loop timing
var prevFrameTime = 0;

// Effective host (the master controller). The full election logic (sticky slot,
// AirConsole master priority, restricted-to-participants eligibility mid-game,
// disconnected fallback, and the LOBBY/RESULTS reconcile) lives in the kit's
// RoomFlow, reached through the room core. The AC master rule is injected via
// masterProvider; disconnection comes from the presence set (kept in sync with
// disconnectedQRs through markDisconnected/markReconnected/clearDisconnected).
// NOTE: tests/room-flow.test.js covers this algorithm.
function getHostPeerIndex() {
  return roomCore.host;
}

// A seat filled by a gamepad plugged into THIS machine (GamepadInput.js). It is
// a player like any other to the room core, but it has no peer on the relay, so
// every party.sendTo must skip it. The id range is the shared module's, because
// the TVs have a hard constraint on it that web-only code never meets: see
// LOCAL_SEAT_BASE in server/PadMapper.js.
// PadMapper is stripped from the AirConsole bundle along with GamepadInput, so
// the lookup is guarded the same way its other call sites are: with no pad
// support in the build there are no local seats, and false is the whole truth.
function isLocalSeat(peerIndex) {
  var padMapper = window.GameEngine && window.GameEngine.PadMapper;
  return !!padMapper && padMapper.isLocalSeat(peerIndex);
}

// A match whose every participant is a pad on this machine. Such a match has no
// presence at the relay AT ALL — local seats never join a room — so the relay
// retires the room the moment the display's own socket drops (a sleep, a network
// blip), and the rejoin answers "Room not found". The recovery's premise — a
// roster cannot follow the room, because those players were never in the new one
// — holds for relay members and fails for local seats, which were never in the
// OLD room either. So the room is replaced underneath the match and only the QR
// changes (DisplayConnection's error handler + applyRoomCreated), exactly as the
// two TV coordinators do. Requires a pad to still HOLD its seat, not merely to
// have held one: with the controller gone there is nobody left to carry the
// match for, and the ordinary reset is right.
function isLocalOnlyMatch() {
  if (roomState === ROOM_STATE.LOBBY) return false;
  if (typeof GamepadInput === 'undefined' || !GamepadInput.hasSeats()) return false;
  var active = roomCore.participants;
  if (!active.length) return false;
  for (var i = 0; i < active.length; i++) {
    if (!isLocalSeat(active[i])) return false;
  }
  return true;
}

// --- DOM References ---
var welcomeScreen = document.getElementById('welcome-screen');
var newGameBtn = document.getElementById('new-game-btn');
var lobbyScreen = document.getElementById('lobby-screen');
var gameScreen = document.getElementById('game-screen');
var resultsScreen = document.getElementById('results-screen');
var qrCode = document.getElementById('qr-code');
var joinUrlEl = document.getElementById('join-url');
var playerListEl = document.getElementById('player-list');
var startBtn = document.getElementById('start-btn');
var countdownOverlay = document.getElementById('countdown-overlay');
var countdownNumber = document.getElementById('countdown-number');
var resultsList = document.getElementById('results-list');
var playAgainBtn = document.getElementById('play-again-btn');
var newGameResultsBtn = document.getElementById('new-game-results-btn');
var gameToolbar = document.getElementById('game-toolbar');
var fullscreenBtn = document.getElementById('fullscreen-btn');
var pauseBtn = document.getElementById('pause-btn');
var pauseOverlay = document.getElementById('pause-overlay');
var pauseContinueBtn = document.getElementById('pause-continue-btn');
var pauseNewGameBtn = document.getElementById('pause-newgame-btn');
var reconnectOverlay = document.getElementById('reconnect-overlay');
var reconnectHeading = document.getElementById('reconnect-heading');
var reconnectStatus = document.getElementById('reconnect-status');
var reconnectBtn = document.getElementById('reconnect-btn');
var musicSwitch = document.getElementById('pause-music-btn');
var relayChip = document.getElementById('relay-chip');
var relayChipRegion = document.getElementById('relay-chip-region');
var relayChipDot = document.getElementById('relay-chip-dot');
var relayReportBtn = document.getElementById('relay-report-btn');

// Reflect stored mute state on the pause overlay's music switch immediately —
// the HTML default (aria-checked="true") matches the unmuted case; for a user
// with stacker_muted=1 persisted, this syncs the DOM before AT reads it and
// before the overlay is ever raised.
if (musicSwitch) {
  musicSwitch.setAttribute('aria-checked', muted ? 'false' : 'true');
}

// --- Overlay dismissal fade ---
// `.hidden` is display:none, so a pure-CSS exit fade is impossible: add
// `.closing` (CSS fadeOut) first, then flip to `.hidden` once the fade has
// played. Timer-based rather than animationend so a stripped animation
// (reduced-motion setups) can't strand an overlay visible forever. Every
// show site must call cancelFadeHide first, or a pending timer would
// re-hide the freshly shown element.
function fadeHide(el, ms, onHidden) {
  cancelFadeHide(el);
  el.classList.add('closing');
  el._closingTimer = setTimeout(function() {
    el._closingTimer = null;
    el.classList.remove('closing');
    el.classList.add('hidden');
    if (onHidden) onHidden();
  }, ms);
}

function cancelFadeHide(el) {
  if (el._closingTimer) {
    clearTimeout(el._closingTimer);
    el._closingTimer = null;
  }
  el.classList.remove('closing');
}

// --- Screen Management ---
// Full-screen swaps use a fade-through exit: the outgoing screen is promoted
// to a fixed layer (.closing in display.css lifts it out of flow) and fades
// out over the incoming screen, which is revealed synchronously beneath it.
// The synchronous reveal matters: callers measure the incoming screen right
// after showScreen returns (renderQR reads the canvas box), so only the
// departing screen is on a timer. Entrances are untouched; this adds the
// missing exit half. Overlay edges keep their cross-fades: GAME → RESULTS
// fades the results screen in over the live boards, and leaving RESULTS
// fades it out over the revealed target below.
var SCREEN_EXIT_MS = 180; // mirrors the .closing fadeOut in display.css

function showScreen(name) {
  var prev = currentScreen;
  currentScreen = name;
  // Suppress the mobile-hint overlay once the user is past the welcome
  // screen. Without this, narrowing a desktop browser during an active
  // lobby/game/results session would re-fire the size-based media query
  // in display.css and cover the board. Returning to WELCOME clears it
  // so the overlay can reappear for the next visitor on that device.
  document.documentElement.classList.toggle('in-session', name !== SCREEN.WELCOME);
  // The outgoing screen for the exit fade. GAME → RESULTS is excluded (the
  // boards stay visible beneath the results overlay), and leaving RESULTS
  // is the results cross-fade below.
  var exitEl = null;
  if (prev !== name) {
    if (prev === SCREEN.WELCOME) exitEl = welcomeScreen;
    else if (prev === SCREEN.LOBBY) exitEl = lobbyScreen;
    else if (prev === SCREEN.GAME && name !== SCREEN.RESULTS) exitEl = gameScreen;
  }
  // Per the fadeHide contract, every show site cancels a leftover exit fade
  // before unhiding (a pending timer would re-hide the screen). The exit
  // screen skips its instant hide; fadeHide flips it to .hidden at the end.
  if (exitEl === welcomeScreen) {
    fadeHide(welcomeScreen, SCREEN_EXIT_MS);
  } else {
    cancelFadeHide(welcomeScreen);
    welcomeScreen.classList.toggle('hidden', name !== SCREEN.WELCOME);
  }
  if (exitEl === lobbyScreen) {
    fadeHide(lobbyScreen, SCREEN_EXIT_MS);
  } else {
    cancelFadeHide(lobbyScreen);
    lobbyScreen.classList.toggle('hidden', name !== SCREEN.LOBBY);
  }
  // Match start from the lobby fades boards + countdown in as one unit
  // (.screen-enter replays on unhide). Re-entry from RESULTS keeps the
  // already-visible boards still and lets the countdown fade in alone.
  // Edge-triggered, not toggled: GAME → GAME calls (every countdown tick)
  // must not touch the class, or the countdown's suppressed animation
  // property would flip back on and replay mid-countdown.
  if (name === SCREEN.GAME && prev === SCREEN.LOBBY) {
    gameScreen.classList.add('screen-enter');
  } else if (name === SCREEN.GAME && prev === SCREEN.RESULTS) {
    gameScreen.classList.remove('screen-enter');
  }
  if (exitEl === gameScreen) {
    // The higher-specificity #game-screen.screen-enter animation would beat
    // .closing and hold the screen at full opacity, so it goes first (the
    // match presentation is over either way).
    gameScreen.classList.remove('screen-enter');
    fadeHide(gameScreen, SCREEN_EXIT_MS);
  } else {
    cancelFadeHide(gameScreen);
    gameScreen.classList.toggle('hidden', name !== SCREEN.GAME && name !== SCREEN.RESULTS);
  }
  if (prev === SCREEN.RESULTS && (name === SCREEN.GAME || name === SCREEN.LOBBY)) {
    // Leaving results is always a cross-fade. PLAY AGAIN: results fade out
    // while the countdown scrim fades in over the boards beneath. NEW GAME:
    // same fade over the entering lobby; the overlay is near-opaque, so the
    // boards hiding beneath it at the same instant stay invisible.
    fadeHide(resultsScreen, 300);
  } else {
    cancelFadeHide(resultsScreen);
    resultsScreen.classList.toggle('hidden', name !== SCREEN.RESULTS);
  }
  // Replay the results button fade on fresh entry. Re-entering
  // RESULTS from itself preserves the --ready class added by
  // visibilitychange.
  if (name === SCREEN.RESULTS && prev !== SCREEN.RESULTS) {
    resultsScreen.classList.remove('results-screen--ready');
  }
  gameToolbar.classList.toggle('hidden', name === SCREEN.WELCOME);
  pauseBtn.classList.toggle('hidden', name !== SCREEN.GAME);
  if (name !== SCREEN.GAME) {
    // A game-screen exit fade uncovers these gradually, so a visible overlay
    // fades out alongside it (200ms, the standard overlay dismissal). On
    // every other path they're covered by the incoming screen: instant, and
    // cancelling clears any in-flight dismissal timer/class.
    var dismissOverlay = function(el) {
      if (exitEl === gameScreen && !el.classList.contains('hidden')) {
        fadeHide(el, 200);
      } else {
        cancelFadeHide(el);
        el.classList.add('hidden');
      }
    };
    dismissOverlay(pauseOverlay);
    dismissOverlay(reconnectOverlay);
    gameToolbar.classList.remove('toolbar-autohide');
  }
  if (name === SCREEN.GAME || name === SCREEN.RESULTS) {
    if (!ctx) initCanvas();
    calculateLayout();
    startRenderLoop();
  } else {
    stopRenderLoop();
  }
  if (name === SCREEN.LOBBY) {
    updatePlayerList();
  }
  if (welcomeBg) {
    var bgCanvasEl = document.getElementById('bg-canvas');
    if (name === SCREEN.WELCOME || name === SCREEN.LOBBY) {
      if (bgCanvasEl) bgCanvasEl.classList.remove('hidden');
      welcomeBg.start();
    } else if (bgCanvasEl && !bgCanvasEl.classList.contains('hidden')) {
      // Deferred past the exit + entrance fades so the hex drift stays
      // beneath the cross-fading screens instead of popping off on frame
      // one. Re-checked at fire time: a quick return to welcome/lobby must
      // keep its restarted canvas. Hiding the canvas also drops the
      // full-viewport layer from the GPU during gameplay/results.
      setTimeout(function() {
        if (currentScreen !== SCREEN.GAME && currentScreen !== SCREEN.RESULTS) return;
        welcomeBg.stop();
        bgCanvasEl.classList.add('hidden');
      }, SCREEN_EXIT_MS + 320);
    }
  }
}

// --- Canvas Setup ---
function initCanvas() {
  canvas = document.getElementById('game-canvas');
  // alpha:false lets the browser skip the alpha blend on composite to screen.
  // Safe because renderFrame starts every frame with an opaque bg.primary
  // fillRect, so the canvas has no reason to be translucent.
  ctx = canvas.getContext('2d', { alpha: false });
  resizeCanvas();
}

function resizeCanvas() {
  if (!canvas) return;
  cachedW = window.innerWidth;
  cachedH = window.innerHeight;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = cachedW * dpr;
  canvas.height = cachedH * dpr;
  canvas.style.width = cachedW + 'px';
  canvas.style.height = cachedH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Assigning canvas.width above cleared the canvas: force a repaint even if
  // the scene signature is unchanged (e.g. a resize during RESULTS, where
  // calculateLayout below doesn't run).
  invalidateRenderSig();
  if (currentScreen === SCREEN.GAME) {
    calculateLayout();
  }
}
