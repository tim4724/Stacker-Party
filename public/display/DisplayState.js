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
var roomCode = null;
var joinUrl = null;
var lastRoomCode = null;
var gameState = null;
var players = new Map();       // clientId -> { playerName, playerColor, playerIndex }
var playerOrder = [];          // compact list of active clientIds for game layout (join order)
                               // lobby UI uses playerIndex on each player for slot positioning
var roomState = ROOM_STATE.LOBBY;

// Valid room state transitions
var VALID_TRANSITIONS = {};
VALID_TRANSITIONS[ROOM_STATE.LOBBY] = [ROOM_STATE.COUNTDOWN];
VALID_TRANSITIONS[ROOM_STATE.COUNTDOWN] = [ROOM_STATE.PLAYING, ROOM_STATE.LOBBY];
VALID_TRANSITIONS[ROOM_STATE.PLAYING] = [ROOM_STATE.RESULTS, ROOM_STATE.LOBBY];
VALID_TRANSITIONS[ROOM_STATE.RESULTS] = [ROOM_STATE.COUNTDOWN, ROOM_STATE.LOBBY];

function setRoomState(newState) {
  if (newState === roomState) return true;
  var allowed = VALID_TRANSITIONS[roomState];
  if (!allowed || allowed.indexOf(newState) < 0) {
    console.warn('Invalid room state transition: ' + roomState + ' → ' + newState);
    return false;
  }
  roomState = newState;
  return true;
}

var paused = false;
var autoPaused = false;
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

// Display heartbeat — send echo to self via relay to verify connection
var lastHeartbeatEcho = 0;
var heartbeatSent = false;
var disconnectedTimer = null;

// Last alive state per player (for reconnect)
var lastAliveState = {};

// Last results (for reconnect)
var lastResults = null;

// Clear all room-local state — used when entering a fresh room or returning to welcome.
// Note: does not touch _lastBroadcastedHostId (module-private to DisplayConnection) or roomCode.
// Calls clearCountdownTimers() (defined in DisplayGame.js) — only safe after all scripts load.
function resetRoomData() {
  if (music) music.stop();
  clearCountdownTimers();
  countdown.callback = null;
  countdown.remaining = 0;
  players.clear();
  playerOrder = [];
  paused = false;
  setAutoPaused(false);
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  lastAliveState = {};
  lastResults = null;
}

// Browser history navigation state
var popstateNavigating = false;
var suppressPopstate = false;

// Pre-created room state (ready before user clicks "New Game")
var preCreatedRoom = null;  // { roomCode, joinUrl, qrMatrix }

// Mute
var muted = false;
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

// --- Slot Helpers ---
// Find the first available player slot (0–3) not used by any current player
function nextAvailableSlot() {
  var used = [];
  for (const entry of players) {
    used.push(entry[1].playerIndex);
  }
  for (var i = 0; i < GameConstants.MAX_PLAYERS; i++) {
    if (used.indexOf(i) < 0) return i;
  }
  return -1;
}

// Sanitize player name: replace "P1"–"P4" with the correct slot label
function sanitizePlayerName(name, slotIndex) {
  if (!name || /^P[1-8]$/i.test(name)) return 'P' + (slotIndex + 1);
  return name;
}

// Host = the connected player designated as master controller (AirConsole rule:
// "menus can only be controlled by the Master Controller"). In AirConsole mode
// we defer to the platform (premium devices get priority); otherwise we fall
// back to the player with the lowest playerIndex. Only the host can trigger
// menu actions (start / play again / return-to-lobby). Returns null when no
// players are connected.
//
// During COUNTDOWN/PLAYING/RESULTS the candidate set is restricted to active
// game participants (playerOrder). Otherwise a late joiner — promoted to AC
// master, or one who reclaims slot 0 after an original player leaves mid-
// results — would control menu actions they can't even reach: their screen
// is a "Game in progress" waiting banner with no pause overlay, so gating
// RETURN_TO_LOBBY on them would deadlock the game. Host opens back up to
// everyone in LOBBY where late joiners have already been folded into
// playerOrder (see DisplayGame.js#returnToLobby).
// NOTE: tests/display-state.test.js mirrors this algorithm — keep in sync.
function getHostClientId() {
  var restricted = (roomState === ROOM_STATE.PLAYING
                 || roomState === ROOM_STATE.COUNTDOWN
                 || roomState === ROOM_STATE.RESULTS)
                && playerOrder.length > 0;
  var eligible = restricted ? new Set(playerOrder) : null;

  if (party && typeof party.getMasterClientId === 'function') {
    var acHost = party.getMasterClientId();
    // Only trust it if the device has completed HELLO and (when restricted) is
    // an active participant; otherwise fall through until they qualify.
    if (acHost && players.has(acHost) && (!restricted || eligible.has(acHost))) {
      return acHost;
    }
  }
  var hostId = null;
  var hostIdx = Infinity;
  for (const entry of players) {
    if (restricted && !eligible.has(entry[0])) continue;
    if (entry[1].playerIndex < hostIdx) {
      hostIdx = entry[1].playerIndex;
      hostId = entry[0];
    }
  }
  return hostId;
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
var muteBtn = document.getElementById('mute-btn');

// --- Screen Management ---
function showScreen(name) {
  currentScreen = name;
  welcomeScreen.classList.toggle('hidden', name !== SCREEN.WELCOME);
  lobbyScreen.classList.toggle('hidden', name !== SCREEN.LOBBY);
  gameScreen.classList.toggle('hidden', name !== SCREEN.GAME && name !== SCREEN.RESULTS);
  resultsScreen.classList.toggle('hidden', name !== SCREEN.RESULTS);
  gameToolbar.classList.toggle('hidden', name === SCREEN.WELCOME);
  muteBtn.classList.toggle('hidden', name === SCREEN.LOBBY);
  pauseBtn.classList.toggle('hidden', name !== SCREEN.GAME);
  if (name !== SCREEN.GAME) {
    pauseOverlay.classList.add('hidden');
    reconnectOverlay.classList.add('hidden');
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
    if (name === SCREEN.WELCOME || name === SCREEN.LOBBY) welcomeBg.start();
    else welcomeBg.stop();
  }
}

// --- Canvas Setup ---
function initCanvas() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
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
  if (currentScreen === SCREEN.GAME) {
    calculateLayout();
  }
}
