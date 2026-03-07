'use strict';

// =====================================================================
// Controller IIFE — opened here in ControllerState.js (loaded first),
// closed in controller.js (loaded last). All vars stay private to the
// closure and are shared across the four controller script files.
// =====================================================================
(function () {

// =====================================================================
// Controller State
// =====================================================================

// --- State ---
var party = null;
var clientId = null;
var playerColor = null;
var playerName = null;
var roomCode = null;
var touchInput = null;
var currentScreen = 'name';
var isHost = false;
var playerCount = 0;
var gameCancelled = false;
var lastLines = 0;
var lastGameResults = null;
var hintsFadeTimer = null;
var hintsSawLeft = false;
var hintsSawRight = false;

// Ping/pong
var PING_INTERVAL_MS = 1000;
var PONG_TIMEOUT_MS = 3000;
var pingTimer = null;
var pongCheckTimer = null;
var lastPongTime = 0;
var disconnectedTimer = null;

// Gesture feedback state
var lastTouchX = 0, lastTouchY = 0;
var coordTracker = null;
var softDropActive = false;
var softDropWash = null;
var buildupEl = null;
var buildupDir = null;

// Rejoin
var rejoinId = new URLSearchParams(location.search).get('rejoin');

// --- Viewport ---
function getViewportMetrics() {
  if (window.visualViewport) {
    return {
      width: Math.round(window.visualViewport.width),
      height: Math.round(window.visualViewport.height),
      offsetTop: Math.round(window.visualViewport.offsetTop || 0),
    };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetTop: 0,
  };
}

function syncViewportLayout() {
  var metrics = getViewportMetrics();
  var keyboardInset = Math.max(0, window.innerHeight - metrics.height - metrics.offsetTop);
  var keyboardOpen = keyboardInset > 120
    && currentScreen === 'name'
    && document.activeElement === nameInput;

  document.documentElement.style.setProperty('--app-height', metrics.height + 'px');
  document.documentElement.style.setProperty('--keyboard-inset', keyboardInset + 'px');
  document.body.classList.toggle('keyboard-open', keyboardOpen);

  if (welcomeBg) {
    welcomeBg.resize(metrics.width, metrics.height);
  }
}

// --- Background ---
var bgCanvas = document.getElementById('bg-canvas');
var welcomeBg = null;
if (bgCanvas) {
  welcomeBg = new WelcomeBackground(bgCanvas, 8);
  var metrics = getViewportMetrics();
  welcomeBg.resize(metrics.width, metrics.height);
  welcomeBg.start();
}
window.addEventListener('resize', syncViewportLayout);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportLayout);
  window.visualViewport.addEventListener('scroll', syncViewportLayout);
}

// --- DOM Refs ---
var nameForm = document.getElementById('name-form');
var nameInput = document.getElementById('name-input');
var nameJoinBtn = document.getElementById('name-join-btn');
var nameStatusText = document.getElementById('name-status-text');
var nameStatusDetail = document.getElementById('name-status-detail');
var roomGoneMessage = document.getElementById('room-gone-message');
var roomGoneHeading = document.getElementById('room-gone-heading');
var roomGoneDetail = document.getElementById('room-gone-detail');
var nameScreen = document.getElementById('name-screen');
var lobbyScreen = document.getElementById('lobby-screen');
var lobbyBackBtn = document.getElementById('lobby-back-btn');
var lobbyTitle = document.getElementById('lobby-title');
var waitingActionText = document.getElementById('waiting-action-text');
var gameScreen = document.getElementById('game-screen');
var gameoverScreen = document.getElementById('gameover-screen');
var playerIdentity = document.getElementById('player-identity');
var startBtn = document.getElementById('start-btn');
var statusText = document.getElementById('status-text');
var statusDetail = document.getElementById('status-detail');
var playerNameEl = document.getElementById('player-name');
var playerIdentityName = document.getElementById('player-identity-name');
var touchArea = document.getElementById('touch-area');
var feedbackLayer = document.getElementById('feedback-layer');
var resultsList = document.getElementById('results-list');
var gameoverButtons = document.getElementById('gameover-buttons');
var playAgainBtn = document.getElementById('play-again-btn');
var newGameBtn = document.getElementById('new-game-btn');
var gameoverStatus = document.getElementById('gameover-status');
var pauseBtn = document.getElementById('pause-btn');
var pauseOverlay = document.getElementById('pause-overlay');
var pauseContinueBtn = document.getElementById('pause-continue-btn');
var pauseNewGameBtn = document.getElementById('pause-newgame-btn');
var pauseStatus = document.getElementById('pause-status');
var pauseButtons = document.getElementById('pause-buttons');
var reconnectOverlay = document.getElementById('reconnect-overlay');
var reconnectHeading = document.getElementById('reconnect-heading');
var reconnectStatus = document.getElementById('reconnect-status');
var reconnectRejoinBtn = document.getElementById('reconnect-rejoin-btn');
var pingDisplay = document.getElementById('ping-display');
var compassHints = document.getElementById('compass-hints');
var muteBtn = document.getElementById('mute-btn');

// --- Screen Management ---
var SCREEN_ORDER = { name: 0, lobby: 1, game: 2, gameover: 3 };

function showScreen(name) {
  var prev = currentScreen;
  currentScreen = name;
  nameScreen.classList.toggle('hidden', name !== 'name');
  lobbyScreen.classList.toggle('hidden', name !== 'lobby');
  gameScreen.classList.toggle('hidden', name !== 'game');
  gameoverScreen.classList.toggle('hidden', name !== 'gameover');

  if (welcomeBg) {
    if (name === 'name' || name === 'lobby') {
      bgCanvas.classList.remove('hidden');
      welcomeBg.start();
    } else {
      welcomeBg.stop();
      bgCanvas.classList.add('hidden');
    }
  }

  if ((SCREEN_ORDER[name] || 0) > (SCREEN_ORDER[prev] || 0)) {
    history.pushState({ screen: name }, '');
  }

  syncViewportLayout();
}

// --- Helpers ---
function vibrate(pattern) {
  if (!navigator.vibrate) return;
  navigator.vibrate(pattern);
}

function generateClientId() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var id = '';
  for (var i = 0; i < 12; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}
