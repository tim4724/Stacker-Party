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
// Optional P2P DataChannel layer to the display (slot 0) for input messages.
// Stays null in AirConsole mode (no WebRTC there) and during ?scenario= gallery
// previews. See ControllerConnection.js for setup; sendToDisplay routes
// MSG.INPUT / MSG.SOFT_DROP over fastlane when open and falls back to WS.
var fastlane = null;
var clientId = null;
var peerIndex = null;          // relay/AirConsole slot id; display-facing playerId
var playerColor = null;       // hex, resolved locally from colorIndex
var playerColorIndex = null;  // 0..7 index into PLAYER_COLORS
var playerName = null;
var playerNameIsAuto = false;
var roomCode = null;
var touchInput = null;
var currentScreen = 'name';
var playerCount = 0;
var gameCancelled = false;
var waitingForNextGame = false;
var lastLines = 0;
var lastGameResults = null;
var startLevel = 1;
// The level we last sent and are still waiting for the display to echo back in
// the room snapshot. While non-null, applyOwnIdentity keeps the local value
// rather than adopting the snapshot's. See the comment there for why.
var pendingLevel = null;
var takenColorIndices = [];   // indices currently claimed by other players (incl. self)
// Becomes true the first time the user taps a swatch in the picker. Gates
// persistColorIndex in applyOwnIdentity so we only persist *user-initiated*
// color changes — display-assigned slots (initial / reconnect default)
// must NOT clobber the previous-session preference, which reclaim still
// needs to read from the AC server snapshot.
var userPickedColor = false;

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

// Display absence (relay peer_left for slot 0). The display may be coming
// right back (relay blip, tvOS app backgrounded and reopened), so the
// controller waits on the reconnect overlay; if it stays gone this long,
// treat the party as over and bail.
var DISPLAY_GONE_BAIL_MS = 30000;
var displayGoneTimer = null;

// Gesture feedback state
var lastTouchX = 0, lastTouchY = 0;
var coordTracker = null;
var softDropActive = false;
var glowEl = null;

// QR rejoin claim. This is display-app data, distinct from the relay
// clientId stored in localStorage.
var rejoinToken = new URLSearchParams(location.search).get('claim');
// Backward-compatible only: older QR codes used ?rejoin=<peerIndex>.
var legacyRejoinId = new URLSearchParams(location.search).get('rejoin');
// Relay instance shard — set on the join URL/QR by the display (URL fragment,
// e.g. https://host/A3KX#00bb33ff) so this controller's WebSocket lands on
// the same shard that owns the room. Fragment keeps it out of HTTP requests.
var instanceId = (function() {
  var raw = (location.hash || '').slice(1);
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
})();
var skipNameScreen = false;

var PLAYER_NAME_STORAGE_KEY = 'stacker_player_name';
var AUTO_PLAYER_NAME_STORAGE_KEY = 'stacker_auto_player_name';
var AUTO_PLAYER_NAME_RE = /^HX-([1-9][0-9]?)$/i;

function getStoredTypedPlayerName() {
  try { return localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || ''; } catch (e) { return ''; }
}

function getStoredAutoPlayerName() {
  try { return localStorage.getItem(AUTO_PLAYER_NAME_STORAGE_KEY) || ''; } catch (e) { return ''; }
}

function rememberAutoPlayerName(name) {
  if (!AUTO_PLAYER_NAME_RE.test(name || '')) return;
  try { localStorage.setItem(AUTO_PLAYER_NAME_STORAGE_KEY, name); } catch (e) { /* iframe sandbox */ }
}

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
      // Layout viewport (innerWidth/innerHeight) — stable across iOS
      // keyboard show/hide and only changes once per Android keyboard
      // toggle. Using visualViewport here would re-clear the canvas on
      // every keyboard slide tick and visibly flicker the falling pieces.
      welcomeBg.resize(window.innerWidth, window.innerHeight);
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
if (bgCanvas && (function() {
  var p = new URLSearchParams(window.location.search);
  return p.get('test') !== '1' || p.get('bg') === '1';
}())) {
  welcomeBg = new WelcomeBackground(bgCanvas, 8);
  welcomeBg.resize(window.innerWidth, window.innerHeight);
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
var nameScreen = document.getElementById('name-screen');
var lobbyScreen = document.getElementById('lobby-screen');
var lobbyBackBtn = document.getElementById('lobby-back-btn');
var waitingActionText = document.getElementById('waiting-action-text');
var gameScreen = document.getElementById('game-screen');
var gameoverScreen = document.getElementById('gameover-screen');
var playerIdentity = document.getElementById('player-identity');
var startBtn = document.getElementById('start-btn');
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
var pauseButtons = document.getElementById('pause-buttons');
var reconnectOverlay = document.getElementById('reconnect-overlay');
var reconnectHeading = document.getElementById('reconnect-heading');
var reconnectStatus = document.getElementById('reconnect-status');
var reconnectRejoinBtn = document.getElementById('reconnect-rejoin-btn');
var latencyDisplay = document.getElementById('latency-display');
var pauseSettingsBtn = document.getElementById('pause-settings-btn');
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
var colorPickerEl = document.getElementById('color-picker');
var colorPickerOverlay = document.getElementById('color-picker-overlay');
var identityTrigger = document.getElementById('identity-trigger');
// Pending color pick (index) — set when the user taps a rose cell, cleared
// when the display echoes the accepted SET_COLOR back in the room snapshot.
// While non-null, the picker overlay stays open until the next render
// confirms playerColorIndex matches.
var pendingColorPick = null;

// --- Screen Management ---
var SCREEN_ORDER = { name: 0, lobby: 1, game: 1, gameover: 1 };

function showScreen(name) {
  var prev = currentScreen;
  currentScreen = name;
  nameScreen.classList.toggle('hidden', name !== 'name');
  lobbyScreen.classList.toggle('hidden', name !== 'lobby');
  gameScreen.classList.toggle('hidden', name !== 'game');
  gameoverScreen.classList.toggle('hidden', name !== 'gameover');
  // Re-arm the gameover anti-misclick gate on fresh entry. Re-entering
  // 'gameover' from itself (reconnect mid-results) preserves the --ready
  // class added by visibilitychange.
  if (name === 'gameover' && prev !== 'gameover') {
    gameoverScreen.classList.remove('gameover-screen--ready');
  }

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

// Tap activation for controller buttons. Buttons fire from the pointer
// stream, not the browser-synthesized click: after a message-driven screen
// swap (e.g. results arriving while the phone sits untouched) phones may
// withhold the compatibility click for the first tap, silently swallowing it.
// Arming on pointerdown keeps the click contract (press and release on the
// same element) without depending on click synthesis. The click listener
// stays as the non-pointer path (keyboard, assistive tech, programmatic
// .click() from tests and bootstraps); the compatibility click that trails a
// handled pointerup is suppressed by timestamp. Delegating callers read
// e.target, which on the pointer path is the release target.
function bindTap(el, handler) {
  var armed = false;
  var lastPointerFire = -Infinity;
  el.addEventListener('pointerdown', function (e) {
    armed = e.isPrimary && e.button === 0;
  });
  el.addEventListener('pointerleave', function () { armed = false; });
  el.addEventListener('pointercancel', function () { armed = false; });
  el.addEventListener('pointerup', function (e) {
    if (!armed || !e.isPrimary || el.disabled) { armed = false; return; }
    armed = false;
    lastPointerFire = e.timeStamp;
    handler(e);
  });
  el.addEventListener('click', function (e) {
    if (e.timeStamp - lastPointerFire < 700) return;
    handler(e);
  });
}

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
