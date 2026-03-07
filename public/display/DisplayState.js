'use strict';

// =====================================================================
// Shared Display State — loaded first, all vars are globals
// =====================================================================

// --- State ---
var currentScreen = 'welcome';
var party = null;
var roomCode = null;
var joinUrl = null;
var lastRoomCode = null;
var gameState = null;
var players = new Map();       // clientId -> { playerName, playerColor, playerIndex }
var playerOrder = [];          // ordered clientIds for layout
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
var lastFrameTime = null;
var playerIndexCounter = 0;
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

// Soft drop auto-timeout (200ms without a soft_drop message ends soft drop)
var softDropTimers = new Map();

// Controller liveness (3s without ping -> show disconnect QR)
var LIVENESS_TIMEOUT_MS = 3000;
var livenessInterval = null;

// Display heartbeat — send echo to self via relay to verify connection
var lastHeartbeatEcho = 0;
var heartbeatSent = false;

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
var muteBtn = document.getElementById('mute-btn');

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
  }
  if (name === 'lobby') {
    updatePlayerList();
  }
  if (welcomeBg) {
    if (name === 'welcome' || name === 'lobby') welcomeBg.start();
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
  if (currentScreen === 'game') {
    calculateLayout();
  }
}

// --- Layout Calculation ---
function calculateLayout() {
  if (!ctx || playerOrder.length === 0) return;

  var n = playerOrder.length;
  var w = window.innerWidth;
  var h = window.innerHeight;
  var padding = THEME.size.canvasPad;
  var totalCellsWide = GameConstants.BOARD_WIDTH + 3 + 3;
  var totalCellsTall = GameConstants.VISIBLE_HEIGHT + 3.6;

  function cellSizeFor(cols, rows) {
    var aw = (w - padding * (cols + 1)) / cols;
    var ah = (h - padding * (rows + 1)) / rows;
    return Math.floor(Math.min(aw / totalCellsWide, ah / totalCellsTall));
  }

  var gridCols, gridRows;
  if (n === 1) { gridCols = 1; gridRows = 1; }
  else if (n === 2) { gridCols = 2; gridRows = 1; }
  else if (n === 3) { gridCols = 3; gridRows = 1; }
  else {
    if (cellSizeFor(4, 1) >= cellSizeFor(2, 2)) {
      gridCols = 4; gridRows = 1;
    } else {
      gridCols = 2; gridRows = 2;
    }
  }

  var cellSize = cellSizeFor(gridCols, gridRows);
  var boardWidthPx = 10 * cellSize;
  var boardHeightPx = 20 * cellSize;

  boardRenderers = [];
  uiRenderers = [];
  animations = new Animations(ctx);

  for (var i = 0; i < n; i++) {
    var col = i % gridCols;
    var row = Math.floor(i / gridCols);
    var cellAreaW = w / gridCols;
    var cellAreaH = h / gridRows;
    var boardX = cellAreaW * col + (cellAreaW - boardWidthPx) / 2;
    var boardY = cellAreaH * row + (cellAreaH - boardHeightPx) / 2 + 10;
    var playerIndex = players.get(playerOrder[i])?.playerIndex ?? i;
    boardRenderers.push(new BoardRenderer(ctx, boardX, boardY, cellSize, playerIndex));
    uiRenderers.push(new UIRenderer(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex));
  }
}

// --- Lobby UI ---
var SLOT_LABELS = ['P1', 'P2', 'P3', 'P4'];
var MAX_SLOTS = 4;

function updatePlayerList() {
  if (playerListEl.children.length === 0) {
    for (var i = 0; i < MAX_SLOTS; i++) {
      var card = document.createElement('div');
      card.className = 'player-card empty';
      var name = document.createElement('span');
      name.textContent = SLOT_LABELS[i];
      card.appendChild(name);
      playerListEl.appendChild(card);
    }
  }

  for (var i = 0; i < MAX_SLOTS; i++) {
    var card = playerListEl.children[i];
    var nameEl = card.querySelector('span');
    var playerId = playerOrder[i];
    var info = playerId ? players.get(playerId) : null;
    var wasEmpty = card.classList.contains('empty');

    if (info) {
      var color = info.playerColor || PLAYER_COLORS[info.playerIndex] || '#fff';
      card.style.setProperty('--player-color', color);
      nameEl.textContent = info.playerName || PLAYER_NAMES[info.playerIndex] || 'Player';
      card.classList.remove('empty');
      card.dataset.playerId = playerId;
      if (wasEmpty) {
        card.classList.remove('join-pop');
        void card.offsetWidth;
        card.classList.add('join-pop');
      }
    } else {
      card.style.removeProperty('--player-color');
      nameEl.textContent = SLOT_LABELS[i];
      card.classList.add('empty');
      card.classList.remove('join-pop');
      delete card.dataset.playerId;
    }
  }
}

function updateStartButton() {
  var hasPlayers = players.size > 0;
  startBtn.disabled = !hasPlayers;
  startBtn.textContent = hasPlayers
    ? 'START (' + players.size + ' player' + (players.size > 1 ? 's' : '') + ')'
    : 'Waiting for players...';
}
