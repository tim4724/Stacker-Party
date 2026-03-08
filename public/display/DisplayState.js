'use strict';

// =====================================================================
// Shared Display State — loaded first, all vars are globals
// DOM queries are deferred to initDOM() for testability.
// =====================================================================

// --- State ---
var currentScreen = 'welcome';
var party = null;
var roomCode = null;
var joinUrl = null;
var lastRoomCode = null;
var gameState = null;
var players = new Map();       // clientId -> { playerName, playerColor, playerIndex }
var playerOrder = [];          // compact list of active clientIds for game layout (join order)
                               // lobby UI uses playerIndex on each player for slot positioning
var hostId = null;             // clientId of host (first joiner)
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
var boardRenderers = [];
var uiRenderers = [];
var animations = null;
var music = null;
var canvas = null;
var ctx = null;
var disconnectedQRs = new Map();
var garbageIndicatorEffects = new Map();
var welcomeBg = null;
var displayGame = null;
var baseUrlOverride = null;    // LAN base URL from server (fetched on init)

// Countdown state (display manages countdown since server no longer does)
var countdownTimer = null;
var countdownRemaining = 0;
var countdownCallback = null;
var goTimeout = null;

// Soft drop auto-timeout
var softDropTimers = new Map();

// Controller liveness
var livenessInterval = null;

// Display heartbeat — send echo to self via relay to verify connection
var lastHeartbeatEcho = 0;
var heartbeatSent = false;
var disconnectedTimer = null;

// Grace period timers for disconnected players in lobby
var graceTimers = new Map();

// Last alive state per player (for reconnect)
var lastAliveState = {};

// Last results (for reconnect)
var lastResults = null;

// Browser history navigation state
var popstateNavigating = false;
var suppressPopstate = false;

// Pre-created room state (ready before user clicks "New Game")
var preCreatedRoom = null;  // { roomCode, joinUrl, qrMatrix }

// Mute
var muted = localStorage.getItem('tetris_muted') === '1';

// Render loop RAF handle (for stop/start)
var rafId = null;

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
  if (!name || /^P[1-4]$/i.test(name)) return 'P' + (slotIndex + 1);
  return name;
}

// --- DOM References (deferred to initDOM for testability) ---
var welcomeScreen = null;
var newGameBtn = null;
var lobbyScreen = null;
var gameScreen = null;
var resultsScreen = null;
var qrCode = null;
var joinUrlEl = null;
var playerListEl = null;
var startBtn = null;
var countdownOverlay = null;
var resultsList = null;
var playAgainBtn = null;
var newGameResultsBtn = null;
var gameToolbar = null;
var fullscreenBtn = null;
var pauseBtn = null;
var pauseOverlay = null;
var pauseContinueBtn = null;
var pauseNewGameBtn = null;
var reconnectOverlay = null;
var reconnectHeading = null;
var reconnectStatus = null;
var reconnectBtn = null;
var muteBtn = null;

function initDOM() {
  welcomeScreen = document.getElementById('welcome-screen');
  newGameBtn = document.getElementById('new-game-btn');
  lobbyScreen = document.getElementById('lobby-screen');
  gameScreen = document.getElementById('game-screen');
  resultsScreen = document.getElementById('results-screen');
  qrCode = document.getElementById('qr-code');
  joinUrlEl = document.getElementById('join-url');
  playerListEl = document.getElementById('player-list');
  startBtn = document.getElementById('start-btn');
  countdownOverlay = document.getElementById('countdown-overlay');
  resultsList = document.getElementById('results-list');
  playAgainBtn = document.getElementById('play-again-btn');
  newGameResultsBtn = document.getElementById('new-game-results-btn');
  gameToolbar = document.getElementById('game-toolbar');
  fullscreenBtn = document.getElementById('fullscreen-btn');
  pauseBtn = document.getElementById('pause-btn');
  pauseOverlay = document.getElementById('pause-overlay');
  pauseContinueBtn = document.getElementById('pause-continue-btn');
  pauseNewGameBtn = document.getElementById('pause-newgame-btn');
  reconnectOverlay = document.getElementById('reconnect-overlay');
  reconnectHeading = document.getElementById('reconnect-heading');
  reconnectStatus = document.getElementById('reconnect-status');
  reconnectBtn = document.getElementById('reconnect-btn');
  muteBtn = document.getElementById('mute-btn');
}

// --- Screen Management ---
function showScreen(name) {
  currentScreen = name;
  welcomeScreen.classList.toggle('hidden', name !== 'welcome');
  lobbyScreen.classList.toggle('hidden', name !== 'lobby');
  gameScreen.classList.toggle('hidden', name !== 'game' && name !== 'results');
  resultsScreen.classList.toggle('hidden', name !== 'results');
  gameToolbar.classList.toggle('hidden', name === 'welcome');
  pauseBtn.classList.toggle('hidden', name !== 'game');
  if (name !== 'game') {
    pauseOverlay.classList.add('hidden');
    reconnectOverlay.classList.add('hidden');
  }
  if (name === 'game' || name === 'results') {
    initCanvas();
    calculateLayout();
    startRenderLoop();
  } else {
    stopRenderLoop();
  }
  if (name === 'lobby') {
    updatePlayerList();
  }
  if (welcomeBg) {
    if (name === 'welcome' || name === 'lobby') welcomeBg.start();
    else welcomeBg.stop();
  }
}

// --- State Namespace (read-only accessor for testing and debugging) ---
var DS = {
  get roomState() { return roomState; },
  get currentScreen() { return currentScreen; },
  get players() { return players; },
  get playerOrder() { return playerOrder; },
  get hostId() { return hostId; },
  get paused() { return paused; },
  get gameState() { return gameState; },
  get muted() { return muted; },
  get roomCode() { return roomCode; }
};

// --- Canvas Setup ---
function initCanvas() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
}

function resizeCanvas() {
  if (!canvas) return;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (currentScreen === 'game') {
    calculateLayout();
  }
}
