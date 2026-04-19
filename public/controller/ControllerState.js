'use strict';

// =====================================================================
// Controller State — shared globals across all controller script files.
// All four files execute in global scope (no IIFE), matching the display
// pattern. Variables declared here are accessible to the other files.
//
// LOAD ORDER (required): ControllerState → ControllerConnection →
//   ControllerGame → controller.js
// See controller/index.html <script> tags for the canonical order.
// =====================================================================

// Gallery previews load the controller in iframes and trigger screen
// transitions + fake gameplay as they render. Silence haptics in ?test=1
// mode so every card load doesn't buzz the phone. navigator.vibrate may be
// non-writable in some strict-mode contexts — swallow the assignment error
// so the harness still boots even if we can't silence it.
if (new URLSearchParams(location.search).get('test') === '1' && navigator.vibrate) {
  try { navigator.vibrate = function() { return false; }; } catch (_) { /* best effort */ }
}

// --- State ---
var party = null;
var clientId = null;
var playerColor = null;
var playerName = null;
var roomCode = null;
var touchInput = null;
var currentScreen = 'name';
var playerCount = 0;
var gameCancelled = false;
var waitingForNextGame = false;
var lastLines = 0;
var lastGameResults = null;
var startLevel = 1;

// Host (AirConsole master controller) — lowest-slot connected player.
// Only the host can trigger menu actions (start, play again, return to lobby).
var isHost = false;
var hostName = null;
var hostColor = null;

// Ping/pong
var PING_INTERVAL_MS = 1000;
var PONG_TIMEOUT_MS = 3000;
var pingTimer = null;
var lastPongTime = 0;
var disconnectedTimer = null;

// Gesture feedback state
var lastTouchX = 0, lastTouchY = 0;
var coordTracker = null;
var softDropActive = false;
var glowEl = null;

// Rejoin
var rejoinId = new URLSearchParams(location.search).get('rejoin');
var skipNameScreen = false;

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

var _syncViewportRaf = null;
function syncViewportLayout() {
  if (_syncViewportRaf) return;
  _syncViewportRaf = requestAnimationFrame(function() {
    _syncViewportRaf = null;
    var metrics = getViewportMetrics();
    document.documentElement.style.setProperty('--app-height', metrics.height + 'px');
    if (welcomeBg) {
      welcomeBg.resize(metrics.width, metrics.height);
    }
    if (endScreenBg && currentScreen === 'end') {
      var endRect = endScreenBgCanvas.getBoundingClientRect();
      endScreenBg.resize(endRect.width, endRect.height);
    }
    // iOS Safari doesn't support interactive-widget=resizes-content,
    // so the CSS media query won't fire. Use visualViewport as fallback.
    var isLandscape = metrics.width > metrics.height;
    var keyboardOpen = isLandscape && metrics.height < 220;
    document.documentElement.classList.toggle('keyboard-compact', keyboardOpen);
  });
}

// --- Background ---
var bgCanvas = document.getElementById('bg-canvas');
var welcomeBg = null;
var endScreenBgCanvas = document.getElementById('end-screen-bg');
var endScreenBg = null;
if (bgCanvas && (function() {
  var p = new URLSearchParams(window.location.search);
  return p.get('test') !== '1' || p.get('bg') === '1';
}())) {
  welcomeBg = new WelcomeBackground(bgCanvas, 8);
  var metrics = getViewportMetrics();
  welcomeBg.resize(metrics.width, metrics.height);
  welcomeBg.start();
  if (endScreenBgCanvas) {
    endScreenBg = new WelcomeBackground(endScreenBgCanvas, 6);
  }
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
var nameScreen = document.getElementById('name-screen');
var lobbyScreen = document.getElementById('lobby-screen');
var lobbyBackBtn = document.getElementById('lobby-back-btn');
var waitingActionText = document.getElementById('waiting-action-text');
var gameScreen = document.getElementById('game-screen');
var gameoverScreen = document.getElementById('gameover-screen');
var endScreen = document.getElementById('end-screen');
var endToast = document.getElementById('end-toast');
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
var settingsBtn = document.getElementById('settings-btn');
var lobbySettingsBtn = document.getElementById('lobby-settings-btn');
var settingsOverlay = document.getElementById('settings-overlay');
var settingsCloseBtn = document.getElementById('settings-close');
var rowMuteDisplay = document.getElementById('row-mute-display');
var toggleMuteDisplay = document.getElementById('toggle-mute-display');
var toggleMuteController = document.getElementById('toggle-mute-controller');
var rowHaptics = document.getElementById('row-haptics');
var sensitivitySlider = document.getElementById('sensitivity-slider');
var sensitivityValueEl = document.getElementById('sensitivity-value');
var sensitivityPreview = document.getElementById('sensitivity-preview');
var settingsVersionEl = document.getElementById('settings-version');
var levelDisplay = document.getElementById('level-display');
var levelMinusBtn = document.getElementById('level-minus-btn');
var levelPlusBtn = document.getElementById('level-plus-btn');

// --- Screen Management ---
var SCREEN_ORDER = { name: 0, lobby: 1, game: 1, gameover: 1, end: 0 };

function showScreen(name) {
  var prev = currentScreen;
  currentScreen = name;
  nameScreen.classList.toggle('hidden', name !== 'name');
  lobbyScreen.classList.toggle('hidden', name !== 'lobby');
  gameScreen.classList.toggle('hidden', name !== 'game');
  gameoverScreen.classList.toggle('hidden', name !== 'gameover');
  endScreen.classList.toggle('hidden', name !== 'end');

  if (welcomeBg) {
    if (name === 'name' || name === 'lobby') {
      bgCanvas.classList.remove('hidden');
      welcomeBg.start();
    } else {
      welcomeBg.stop();
      bgCanvas.classList.add('hidden');
    }
  }
  if (endScreenBg) {
    if (name === 'end') {
      var rect = endScreenBgCanvas.getBoundingClientRect();
      endScreenBg.resize(rect.width, rect.height);
      endScreenBg.start();
    } else {
      endScreenBg.stop();
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
  if (typeof ControllerSettings !== 'undefined' && ControllerSettings.scaleVibration) {
    var scaled = ControllerSettings.scaleVibration(pattern);
    if (scaled === null) return;
    navigator.vibrate(scaled);
    return;
  }
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
