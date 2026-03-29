'use strict';

// =====================================================================
// Shared Display State — loaded first, all vars are globals
// =====================================================================

// --- Screen Constants ---
var SCREEN = { WELCOME: 'welcome', LOBBY: 'lobby', GAME: 'game', RESULTS: 'results' };

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
var garbageDefenceEffects = new Map();
var welcomeBg = null;
var displayGame = null;
var baseUrlOverride = null;    // LAN base URL from server (fetched on init)

// Countdown state (display manages countdown since server no longer does)
var countdownTimer = null;
var countdownRemaining = 0;
var countdownCallback = null;
var goTimeout = null;
var goOverlayTimer = null;

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
var muted = localStorage.getItem('stacker_muted') === '1';

// Render loop RAF handle (for stop/start)
var rafId = null;

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
  var dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (currentScreen === SCREEN.GAME) {
    calculateLayout();
  }
}
