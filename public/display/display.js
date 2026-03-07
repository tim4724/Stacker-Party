'use strict';

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
var muted = localStorage.getItem('tetris_muted') === '1';

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
  var totalCellsWide = 10 + 3 + 3;
  var totalCellsTall = 20 + 3.6;

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

// =====================================================================
// Party-Server Connection
// =====================================================================

// Pre-created room state (ready before user clicks "New Game")
var preCreatedRoom = null;  // { roomCode, joinUrl, qrMatrix }

function connectAndCreateRoom() {
  if (party) party.close();

  party = new PartyConnection(RELAY_URL, { clientId: 'display' });

  party.onOpen = function() {
    if (lastRoomCode) {
      party.join(lastRoomCode);
    } else {
      party.create(5);
    }
  };

  party.onClose = function(attempt, maxAttempts) {
    if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
      if (!paused) pauseGame();
      reconnectOverlay.classList.remove('hidden');
      pauseOverlay.classList.add('hidden');
      reconnectStatus.textContent = 'Attempt ' + attempt + ' of ' + maxAttempts;
    }
  };

  party.onProtocol = function(type, msg) {
    switch (type) {
      case 'created':
        onRoomCreated(msg.room);
        break;
      case 'joined':
        onDisplayRejoined(msg.room, msg.clients);
        break;
      case 'peer_joined':
        onPeerJoined(msg.clientId);
        break;
      case 'peer_left':
        onPeerLeft(msg.clientId);
        break;
      case 'error':
        console.error('Party-Server error:', msg.message);
        break;
    }
  };

  party.onMessage = function(from, data) {
    if (from === 'display' && data && data.type === '_heartbeat') {
      lastHeartbeatEcho = Date.now();
      return;
    }
    handleControllerMessage(from, data);
  };

  party.connect();
}

// =====================================================================
// Party-Server Protocol Handlers
// =====================================================================

function onRoomCreated(partyRoomCode) {
  var newJoinUrl = getBaseUrl() + '/' + partyRoomCode;

  // If still on welcome screen, cache the room for instant use later
  if (currentScreen === 'welcome') {
    preCreatedRoom = { roomCode: partyRoomCode, joinUrl: newJoinUrl, qrMatrix: null };
    fetchQR(newJoinUrl, function(qrMatrix) {
      if (preCreatedRoom && preCreatedRoom.roomCode === partyRoomCode) {
        preCreatedRoom.qrMatrix = qrMatrix;
      }
    });
    return;
  }

  applyRoomCreated(partyRoomCode, newJoinUrl);
}

function applyRoomCreated(partyRoomCode, newJoinUrl) {
  roomCode = partyRoomCode;
  lastRoomCode = partyRoomCode;
  roomState = ROOM_STATE.LOBBY;

  joinUrl = newJoinUrl;
  joinUrlEl.textContent = joinUrl;

  // Reset local state
  if (music) music.stop();
  players.clear();
  playerOrder = [];
  playerIndexCounter = 0;
  hostId = null;
  paused = false;
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  lastAliveState = {};
  lastResults = null;

  showScreen('lobby');
  updateStartButton();
  startLivenessCheck();

  // Fetch QR from HTTP server
  fetchQR(joinUrl, function(qrMatrix) {
    requestAnimationFrame(function() { renderTetrisQR(qrCode, qrMatrix); });
  });
}

function onDisplayRejoined(partyRoomCode, clients) {
  // Display reconnected to existing room — resync state
  roomCode = partyRoomCode;
  lastRoomCode = partyRoomCode;

  joinUrl = getBaseUrl() + '/' + roomCode;
  joinUrlEl.textContent = joinUrl;

  startLivenessCheck();

  // Clear reconnect overlay — connection restored
  reconnectOverlay.classList.add('hidden');
  if (paused && (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)) {
    resumeGame();
  }

  // Re-send WELCOME to all known players so controllers clear their reconnect overlay
  for (var entry of players) {
    var id = entry[0];
    var info = entry[1];
    party.sendTo(id, {
      type: MSG.WELCOME,
      playerColor: info.playerColor,
      isHost: id === hostId,
      playerCount: players.size,
      roomState: roomState,
      alive: lastAliveState[id] != null ? lastAliveState[id] : true,
      paused: paused
    });
  }

  if (roomState === ROOM_STATE.LOBBY) {
    showScreen('lobby');
    updateStartButton();
    fetchQR(joinUrl, function(qrMatrix) {
      requestAnimationFrame(function() { renderTetrisQR(qrCode, qrMatrix); });
    });
  }
}

function onPeerJoined(clientId) {
  if (players.has(clientId)) return;
  if (roomState !== ROOM_STATE.LOBBY) return;
  if (players.size >= GameConstants.MAX_PLAYERS) return;

  var index = playerIndexCounter++;
  var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
  var isHost = hostId === null;
  if (isHost) hostId = clientId;

  players.set(clientId, {
    playerName: 'P' + (index + 1),
    playerColor: color,
    playerIndex: index,
    lastPingTime: Date.now()
  });
  playerOrder.push(clientId);

  updatePlayerList();
  updateStartButton();
}

function onPeerLeft(clientId) {
  if (!players.has(clientId)) return;

  // Clear soft drop timer
  if (softDropTimers.has(clientId)) {
    clearTimeout(softDropTimers.get(clientId));
    softDropTimers.delete(clientId);
    if (displayGame) displayGame.handleSoftDropEnd(clientId);
  }

  if (roomState === ROOM_STATE.LOBBY) {
    // Grace period: hold slot for 5s so reconnecting controller can rejoin
    var timer = setTimeout(function() {
      graceTimers.delete(clientId);
      if (!players.has(clientId)) return;
      removeLobbyPlayer(clientId);
    }, 5000);
    graceTimers.set(clientId, timer);
  } else if (roomState === ROOM_STATE.RESULTS) {
    // Results screen — return to lobby
    var wasHost = clientId === hostId;
    stopDisplayGame();
    lastResults = null;
    roomState = ROOM_STATE.LOBBY;
    removeLobbyPlayer(clientId);
    if (!wasHost) {
      party.broadcast({ type: MSG.RETURN_TO_LOBBY, playerCount: players.size });
    }
    returnToLobbyUI();
  } else {
    // In game/countdown — show disconnect QR overlay
    showDisconnectQR(clientId);
  }
}

function removeLobbyPlayer(clientId) {
  if (clientId === hostId) {
    // Host disconnected — kick everyone back
    hostId = null;
    party.broadcast({ type: MSG.ERROR, code: 'HOST_DISCONNECTED', message: 'Host disconnected' });
    players.clear();
    playerOrder = [];
    playerIndexCounter = 0;
    garbageIndicatorEffects.clear();
    updatePlayerList();
    updateStartButton();
  } else {
    players.delete(clientId);
    playerOrder = playerOrder.filter(function(id) { return id !== clientId; });
    garbageIndicatorEffects.delete(clientId);
    updatePlayerList();
    updateStartButton();
    broadcastLobbyUpdate();
  }
}

// =====================================================================
// Controller Message Handlers
// =====================================================================

function handleControllerMessage(fromId, msg) {
  if (!msg || !msg.type) return;

  // Any message from a controller proves it's alive — clear disconnect overlay
  disconnectedQRs.delete(fromId);
  var senderPlayer = players.get(fromId);
  if (senderPlayer) senderPlayer.lastPingTime = Date.now();

  switch (msg.type) {
    case MSG.HELLO:
      onHello(fromId, msg);
      break;
    case MSG.INPUT:
      onInput(fromId, msg);
      break;
    case MSG.SOFT_DROP:
      onSoftDrop(fromId, msg.speed);
      break;
    case MSG.START_GAME:
      if (fromId === hostId) startGame();
      break;
    case MSG.PLAY_AGAIN:
      if (fromId === hostId) playAgain();
      break;
    case MSG.RETURN_TO_LOBBY:
      if (fromId === hostId) returnToLobby();
      break;
    case MSG.PAUSE_GAME:
      if (fromId === hostId) pauseGame();
      break;
    case MSG.RESUME_GAME:
      if (fromId === hostId) resumeGame();
      break;
    case MSG.LEAVE:
      removePlayer(fromId, true);
      break;
    case MSG.PING:
      party.sendTo(fromId, { type: MSG.PONG, t: msg.t });
      break;
  }
}

function onHello(fromId, msg) {
  var name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 16) : '';
  var playerName = name || 'Player';

  // Player already registered (from peer_joined or reconnect)
  if (players.has(fromId)) {
    var existing = players.get(fromId);

    // Clear grace timer if any
    if (graceTimers.has(fromId)) {
      clearTimeout(graceTimers.get(fromId));
      graceTimers.delete(fromId);
    }

    // Update name (replaces placeholder like "P1")
    existing.playerName = playerName;
    updatePlayerList();

    // Send welcome with current state
    party.sendTo(fromId, {
      type: MSG.WELCOME,
      playerColor: existing.playerColor,
      isHost: fromId === hostId,
      playerCount: players.size,
      roomState: roomState,
      alive: lastAliveState[fromId] != null ? lastAliveState[fromId] : true,
      paused: paused
    });

    broadcastLobbyUpdate();
    return;
  }

  // New player joining (peer_joined was missed or not used)
  if (roomState !== ROOM_STATE.LOBBY) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Game already in progress' });
    return;
  }

  if (players.size >= GameConstants.MAX_PLAYERS) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
    return;
  }

  var index = playerIndexCounter++;
  var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
  var isHost = hostId === null;
  if (isHost) hostId = fromId;

  players.set(fromId, {
    playerName: playerName,
    playerColor: color,
    playerIndex: index,
    lastPingTime: Date.now()
  });
  playerOrder.push(fromId);

  // Send welcome to new player
  party.sendTo(fromId, {
    type: MSG.WELCOME,
    playerColor: color,
    isHost: isHost,
    playerCount: players.size,
    roomState: roomState
  });

  // Update all controllers with new player count
  broadcastLobbyUpdate();

  // Update display UI
  updatePlayerList();
  updateStartButton();
}

function onInput(fromId, msg) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;
  displayGame.processInput(fromId, msg.action);
}

function onSoftDrop(fromId, speed) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;

  // Start or continue soft drop with speed
  displayGame.handleSoftDropStart(fromId, speed);

  // Reset auto-end timeout
  if (softDropTimers.has(fromId)) {
    clearTimeout(softDropTimers.get(fromId));
  }
  softDropTimers.set(fromId, setTimeout(function() {
    softDropTimers.delete(fromId);
    if (displayGame) displayGame.handleSoftDropEnd(fromId);
  }, 300));
}

function removePlayer(clientId, immediate) {
  if (!players.has(clientId)) return;

  if (roomState === ROOM_STATE.LOBBY) {
    if (immediate) {
      removeLobbyPlayer(clientId);
    } else {
      onPeerLeft(clientId);
    }
  } else {
    onPeerLeft(clientId);
  }
}

// =====================================================================
// Lobby Update Broadcast
// =====================================================================

function broadcastLobbyUpdate() {
  for (var entry of players) {
    var id = entry[0];
    party.sendTo(id, {
      type: MSG.LOBBY_UPDATE,
      playerCount: players.size,
      isHost: id === hostId
    });
  }
}

// =====================================================================
// Controller Liveness Check
// =====================================================================

function startLivenessCheck() {
  stopLivenessCheck();
  lastHeartbeatEcho = Date.now();
  heartbeatSent = false;
  livenessInterval = setInterval(function() {
    var now = Date.now();

    // Send heartbeat echo to self via relay
    party.sendTo('display', { type: '_heartbeat' });

    // Check if our own connection is dead (no echo back within timeout)
    var displayDead = heartbeatSent && (now - lastHeartbeatEcho > LIVENESS_TIMEOUT_MS);
    heartbeatSent = true;

    if (displayDead) {
      if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
        if (!paused) pauseGame();
        reconnectOverlay.classList.remove('hidden');
        pauseOverlay.classList.add('hidden');
      }
      // Force reconnect once (reconnectNow is idempotent via _discardOldWs,
      // but no point closing a WS that's still connecting)
      if (party.connected) {
        party.reconnectNow();
      }
      return;
    }

    // Check individual controller liveness
    for (var entry of players) {
      var id = entry[0];
      var player = entry[1];
      if (player.lastPingTime && (now - player.lastPingTime > LIVENESS_TIMEOUT_MS)) {
        if (roomState !== ROOM_STATE.LOBBY && !disconnectedQRs.has(id)) {
          showDisconnectQR(id);
        }
      }
    }
  }, 1000);
}

function stopLivenessCheck() {
  if (livenessInterval) {
    clearInterval(livenessInterval);
    livenessInterval = null;
  }
}

// =====================================================================
// QR Code Helpers
// =====================================================================

function getBaseUrl() {
  return baseUrlOverride || window.location.origin;
}

function fetchBaseUrl() {
  // Only fetch LAN IP override when running on localhost (dev mode).
  // In production, window.location.origin is already the correct public URL.
  var host = window.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return;

  fetch('/api/baseurl')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.baseUrl) baseUrlOverride = data.baseUrl;
    })
    .catch(function() { /* fall back to window.location.origin */ });
}

function fetchQR(text, callback) {
  fetch('/api/qr?text=' + encodeURIComponent(text))
    .then(function(r) { return r.json(); })
    .then(callback)
    .catch(function(err) { console.error('QR fetch failed:', err); });
}

function showDisconnectQR(clientId) {
  if (!joinUrl) {
    disconnectedQRs.set(clientId, null);
    return;
  }
  var rejoinUrl = joinUrl + '?rejoin=' + clientId;
  fetchQR(rejoinUrl, function(qrMatrix) {
    // Only apply if player is still disconnected
    if (!players.has(clientId)) return;
    var offscreen = document.createElement('canvas');
    renderTetrisQR(offscreen, qrMatrix);
    disconnectedQRs.set(clientId, offscreen);
  });
}

function renderTetrisQR(canvas, qrMatrix) {
  if (!qrMatrix || !qrMatrix.modules) return;
  var size = qrMatrix.size;
  var modules = qrMatrix.modules;

  var dpr = window.devicePixelRatio || 1;
  var cssSize = canvas.parentElement
    ? Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight, 280)
    : 280;
  var cellPx = Math.floor((cssSize * dpr) / size);
  var totalPx = cellPx * size;

  canvas.width = totalPx;
  canvas.height = totalPx;
  canvas.style.width = (totalPx / dpr) + 'px';
  canvas.style.height = (totalPx / dpr) + 'px';

  var qrCtx = canvas.getContext('2d');
  qrCtx.clearRect(0, 0, totalPx, totalPx);

  qrCtx.fillStyle = THEME.color.text.white;
  qrCtx.fillRect(0, 0, totalPx, totalPx);

  var color = THEME.color.bg.card;
  var inset = Math.max(0.5, cellPx * 0.03);
  var radius = Math.max(1, cellPx * 0.15);

  for (var row = 0; row < size; row++) {
    for (var col = 0; col < size; col++) {
      var idx = row * size + col;
      var isDark = modules[idx] & 1;
      if (!isDark) continue;

      var x = col * cellPx;
      var y = row * cellPx;
      var s = cellPx;

      var grad = qrCtx.createLinearGradient(x, y, x, y + s);
      grad.addColorStop(0, lightenColor(color, 15));
      grad.addColorStop(1, darkenColor(color, 10));

      qrCtx.fillStyle = grad;
      roundRect(qrCtx, x + inset, y + inset, s - inset * 2, s - inset * 2, radius);
      qrCtx.fill();

      qrCtx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      qrCtx.fillRect(x + inset + radius, y + inset, s - inset * 2 - radius * 2, Math.max(1, s * 0.08));

      qrCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      qrCtx.fillRect(x + inset, y + inset + radius, Math.max(1, s * 0.07), s - inset * 2 - radius * 2);

      qrCtx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      qrCtx.fillRect(x + inset + radius, y + s - inset - Math.max(1, s * 0.08), s - inset * 2 - radius * 2, Math.max(1, s * 0.08));

      qrCtx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      var shineSize = s * 0.25;
      qrCtx.fillRect(x + s * 0.25, y + s * 0.2, shineSize, shineSize * 0.5);
    }
  }
}

// =====================================================================
// Game Management
// =====================================================================

function startGame() {
  if (roomState !== ROOM_STATE.LOBBY) return;
  if (players.size < 1) return;
  startNewGame();
}

function playAgain() {
  if (roomState !== ROOM_STATE.RESULTS) return;
  startNewGame();
}

function startNewGame() {
  stopDisplayGame();
  paused = false;
  lastResults = null;
  lastAliveState = {};
  roomState = ROOM_STATE.COUNTDOWN;

  startCountdown(function() {
    roomState = ROOM_STATE.PLAYING;
    party.broadcast({ type: MSG.GAME_START });
    runGameLocally();

    // Show disconnect QR for any players that disconnected during countdown
    for (var entry of players) {
      if (entry[1].lastPingTime && Date.now() - entry[1].lastPingTime > LIVENESS_TIMEOUT_MS) {
        showDisconnectQR(entry[0]);
      }
    }
  });
}

function startCountdown(onComplete, startFrom) {
  var count = startFrom || GameConstants.COUNTDOWN_SECONDS;
  countdownCallback = onComplete;
  countdownRemaining = count;

  // Broadcast to controllers
  party.broadcast({ type: MSG.COUNTDOWN, value: count });
  // Handle locally on display
  onCountdownDisplay(count);

  countdownTimer = setInterval(function() {
    count--;
    countdownRemaining = count;
    if (count > 0) {
      party.broadcast({ type: MSG.COUNTDOWN, value: count });
      onCountdownDisplay(count);
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      countdownRemaining = 0;
      party.broadcast({ type: MSG.COUNTDOWN, value: 'GO' });
      onCountdownDisplay('GO');
      goTimeout = setTimeout(function() {
        goTimeout = null;
        onComplete();
      }, 500);
    }
  }, 1000);
}

function pauseGame() {
  if (paused) return;
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  paused = true;
  if (roomState === ROOM_STATE.COUNTDOWN) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (goTimeout) { clearTimeout(goTimeout); goTimeout = null; }
  }
  party.broadcast({ type: MSG.GAME_PAUSED });
  onGamePaused();
}

function resumeGame() {
  if (!paused) return;
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  paused = false;
  if (roomState === ROOM_STATE.COUNTDOWN && countdownCallback) {
    party.broadcast({ type: MSG.GAME_RESUMED });
    onGameResumed();
    if (countdownRemaining === 0) {
      party.broadcast({ type: MSG.COUNTDOWN, value: 'GO' });
      onCountdownDisplay('GO');
      goTimeout = setTimeout(function() {
        goTimeout = null;
        countdownCallback();
      }, 500);
    } else {
      startCountdown(countdownCallback, countdownRemaining);
    }
    return;
  }
  party.broadcast({ type: MSG.GAME_RESUMED });
  onGameResumed();
}

function returnToLobby() {
  // Clear countdown state
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (goTimeout) { clearTimeout(goTimeout); goTimeout = null; }
  graceTimers.forEach(clearTimeout);
  graceTimers.clear();
  countdownCallback = null;
  countdownRemaining = 0;
  paused = false;

  if (music) music.stop();
  stopDisplayGame();

  // Remove disconnected players
  var disconnectedIds = [];
  for (var entry of players) {
    if (entry[1].lastPingTime && Date.now() - entry[1].lastPingTime > LIVENESS_TIMEOUT_MS) {
      disconnectedIds.push(entry[0]);
    }
  }

  if (hostId !== null && disconnectedIds.indexOf(hostId) >= 0) {
    roomState = ROOM_STATE.LOBBY;
    party.broadcast({ type: MSG.ERROR, code: 'HOST_DISCONNECTED', message: 'Host disconnected' });
    players.clear();
    playerOrder = [];
    playerIndexCounter = 0;
    hostId = null;
    lastAliveState = {};
    updatePlayerList();
    updateStartButton();
    returnToLobbyUI();
    return;
  }

  for (var i = 0; i < disconnectedIds.length; i++) {
    players.delete(disconnectedIds[i]);
    playerOrder = playerOrder.filter(function(id) { return id !== disconnectedIds[i]; });
  }

  lastResults = null;
  lastAliveState = {};
  roomState = ROOM_STATE.LOBBY;

  broadcastLobbyUpdate();
  party.broadcast({ type: MSG.RETURN_TO_LOBBY, playerCount: players.size });

  returnToLobbyUI();
}

function returnToLobbyUI() {
  var wasInGame = currentScreen === 'game' || currentScreen === 'results';
  gameState = null;
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  showScreen('lobby');
  updateStartButton();
  if (wasInGame && !popstateNavigating) {
    suppressPopstate = true;
    history.back();
  }
  popstateNavigating = false;
}

// =====================================================================
// Local Game Engine
// =====================================================================

function stopDisplayGame() {
  if (displayGame) {
    displayGame.stop();
    displayGame = null;
  }
  // Clear all soft drop timers
  for (var entry of softDropTimers) {
    clearTimeout(entry[1]);
  }
  softDropTimers.clear();
}

function runGameLocally() {
  stopDisplayGame();

  var Game = window.GameEngine.Game;
  var gamePlayers = new Map();
  for (var i = 0; i < playerOrder.length; i++) {
    gamePlayers.set(playerOrder[i], {});
  }

  var seed = (Math.random() * 0xFFFFFFFF) >>> 0;

  displayGame = new Game(gamePlayers, {
    onGameState: function(state) {
      onGameState(state);
      // Relay per-player state to controllers
      if (state.players) {
        for (var k = 0; k < state.players.length; k++) {
          var p = state.players[k];
          party.sendTo(p.id, {
            type: MSG.PLAYER_STATE,
            score: p.score, level: p.level, lines: p.lines,
            alive: p.alive, garbageIncoming: p.pendingGarbage || 0
          });
        }
      }
    },
    onEvent: function(event) {
      if (event.type === 'line_clear') {
        onLineClear(event);
      } else if (event.type === 'player_ko') {
        onPlayerKO(event);
        lastAliveState[event.playerId] = false;
        party.sendTo(event.playerId, { type: MSG.GAME_OVER });
      } else if (event.type === 'garbage_sent') {
        onGarbageSent(event);
      }
    },
    onGameEnd: function(results) {
      // Enrich with player names
      if (results && results.results) {
        for (var j = 0; j < results.results.length; j++) {
          var r = results.results[j];
          var pInfo = players.get(r.playerId);
          if (pInfo) r.playerName = pInfo.playerName;
        }
      }
      roomState = ROOM_STATE.RESULTS;
      lastResults = results;
      party.broadcast({ type: MSG.GAME_END, elapsed: results.elapsed, results: results.results });
      onGameEnd(results);
    }
  }, seed);

  displayGame.start();
}

// =====================================================================
// Display-side Event Handlers (rendering)
// =====================================================================

function onCountdownDisplay(value) {
  gameState = null;
  if (currentScreen !== 'game') {
    history.pushState({ screen: 'game' }, '');
  }
  showScreen('game');
  countdownOverlay.classList.remove('hidden');
  countdownOverlay.textContent = value;
  playCountdownBeep(value === 'GO');
  if (value === 'GO') {
    if (music && !music.playing) {
      music.start();
      if (muted) music.masterGain.gain.setValueAtTime(0, music.ctx.currentTime);
    }
    setTimeout(function() {
      countdownOverlay.classList.add('hidden');
      countdownOverlay.textContent = '';
    }, 400);
  }
}

function onGameState(msg) {
  gameState = msg;
  if (msg.players) {
    for (var i = 0; i < msg.players.length; i++) {
      var p = msg.players[i];
      if (playerOrder.indexOf(p.id) < 0) {
        playerOrder.push(p.id);
      }
    }
  }
  if (msg.players && boardRenderers.length !== msg.players.length) {
    calculateLayout();
  }
  if (music && music.playing && msg.players && msg.players.length > 0) {
    var maxLevel = Math.max.apply(null, msg.players.map(function(p) { return p.level || 1; }));
    music.setSpeed(maxLevel);
  }
}

function onLineClear(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  var isTetris = msg.lines === 4;
  animations.addLineClear(br.x, br.y, br.cellSize, msg.rows || [], isTetris, msg.isTSpin);
  if (msg.combo >= 2) {
    animations.addCombo(br.x + br.boardWidth / 2, br.y + br.boardHeight / 2 - 30, msg.combo);
  }
}

function onGarbageSent(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.toId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  var attackerColor = players.get(msg.senderId)?.playerColor || '#ffffff';
  animations.addGarbageShake(br.x, br.y);
  var shifted = (garbageIndicatorEffects.get(msg.toId) || [])
    .map(function(effect) { return { ...effect, rowStart: effect.rowStart - msg.lines }; })
    .filter(function(effect) { return effect.rowStart + effect.lines > 0; });
  shifted.push({
    startTime: performance.now(),
    duration: 1000,
    maxAlpha: 0.94,
    color: attackerColor,
    lines: msg.lines,
    rowStart: Math.max(0, 20 - msg.lines)
  });
  garbageIndicatorEffects.set(msg.toId, shifted);
}

function onPlayerKO(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  animations.addKO(br.x, br.y, br.boardWidth, br.boardHeight);
}

function onGameEnd(msg) {
  if (music) music.stop();
  stopDisplayGame();
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  showScreen('results');
  resultsScreen.style.animation = 'none';
  resultsScreen.offsetHeight;
  resultsScreen.style.animation = '';
  renderResults(msg.results);
}

function onGamePaused() {
  if (displayGame) displayGame.pause();
  pauseOverlay.classList.remove('hidden');
  gameToolbar.classList.add('hidden');
  if (music) music.stop();
}

function onGameResumed() {
  if (displayGame) displayGame.resume();
  pauseOverlay.classList.add('hidden');
  if (currentScreen === 'game') {
    gameToolbar.classList.remove('hidden');
  }
  if (countdownOverlay.textContent) {
    countdownOverlay.classList.remove('hidden');
  } else if (music) {
    music.start();
    if (muted) music.masterGain.gain.setValueAtTime(0, music.ctx.currentTime);
  }
}

// =====================================================================
// Lobby UI
// =====================================================================

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

// =====================================================================
// Results UI
// =====================================================================

function renderResults(results) {
  resultsList.innerHTML = '';
  if (!results) return;

  var sorted = results.slice().sort(function(a, b) { return a.rank - b.rank; });

  var winner = sorted[0];
  if (winner) {
    var wInfo = players.get(winner.playerId);
    var winnerColor = wInfo?.playerColor || PLAYER_COLORS[wInfo?.playerIndex] || '#ffd700';
    var parsed = [
      parseInt(winnerColor.slice(1, 3), 16),
      parseInt(winnerColor.slice(3, 5), 16),
      parseInt(winnerColor.slice(5, 7), 16)
    ];
    var r = isNaN(parsed[0]) ? 255 : parsed[0];
    var g = isNaN(parsed[1]) ? 215 : parsed[1];
    var b = isNaN(parsed[2]) ? 0 : parsed[2];
    resultsScreen.style.setProperty('--winner-glow', 'rgba(' + r + ', ' + g + ', ' + b + ', 0.08)');
  }

  var solo = sorted.length === 1;

  for (var i = 0; i < sorted.length; i++) {
    var res = sorted[i];
    var row = document.createElement('div');
    row.className = solo ? 'result-row' : 'result-row rank-' + res.rank;
    row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');

    if (!solo) {
      var rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = res.rank <= 3 ? ['', '1st', '2nd', '3rd'][res.rank] : res.rank + 'th';
      row.appendChild(rank);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    var pInfo = players.get(res.playerId);
    nameEl.textContent = res.playerName || pInfo?.playerName || 'Player';
    if (pInfo) {
      nameEl.style.color = pInfo.playerColor || PLAYER_COLORS[pInfo.playerIndex];
    }

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    stats.innerHTML = '<span>' + (res.score || 0).toLocaleString() + ' points</span><span>' + (res.lines || 0) + ' lines</span><span>Lv ' + (res.level || 1) + '</span>';

    info.appendChild(nameEl);
    info.appendChild(stats);
    row.appendChild(info);
    resultsList.appendChild(row);
  }
}

// =====================================================================
// Music & Audio
// =====================================================================

function initMusic() {
  if (!music) {
    music = new Music();
  }
  music.init();
  music.muted = muted;
}

function playCountdownBeep(isGo) {
  if (muted) return;
  if (!music || !music.ctx) return;
  var actx = music.ctx;
  if (actx.state === 'suspended') actx.resume();

  var osc = actx.createOscillator();
  var gain = actx.createGain();
  osc.connect(gain);
  gain.connect(actx.destination);

  if (isGo) {
    osc.type = 'square';
    osc.frequency.setValueAtTime(600, actx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, actx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.18, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.3);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.3);
  } else {
    osc.type = 'square';
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0.15, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.12);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.12);
  }
}

// =====================================================================
// Welcome / UI Buttons
// =====================================================================

function resetToWelcome() {
  if (party) {
    party.close();
    party = null;
  }
  stopLivenessCheck();
  lastRoomCode = null;
  roomCode = null;
  joinUrl = null;
  hostId = null;
  paused = false;
  roomState = ROOM_STATE.LOBBY;
  players.clear();
  playerOrder = [];
  playerIndexCounter = 0;
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  lastAliveState = {};
  lastResults = null;
  preCreatedRoom = null;
  showScreen('welcome');
  // Pre-create a fresh room for next "New Game" click
  connectAndCreateRoom();
}

newGameBtn.addEventListener('click', function() {
  initMusic();
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  }

  if (preCreatedRoom) {
    // Room is already created — use it instantly
    var pre = preCreatedRoom;
    preCreatedRoom = null;
    applyRoomCreated(pre.roomCode, pre.joinUrl);
    // If QR was already fetched, render it immediately
    if (pre.qrMatrix) {
      requestAnimationFrame(function() { renderTetrisQR(qrCode, pre.qrMatrix); });
    }
  } else {
    // Fallback: create room now (e.g. if preconnect failed)
    connectAndCreateRoom();
  }

  history.pushState({ screen: 'lobby' }, '');
});

window.addEventListener('popstate', function(e) {
  if (suppressPopstate) {
    suppressPopstate = false;
    return;
  }
  var target = e.state && e.state.screen;
  if (currentScreen === 'welcome' && target === 'lobby') {
    connectAndCreateRoom();
    showScreen('lobby');
  } else if (currentScreen === 'lobby') {
    if (target === 'game') {
      suppressPopstate = true;
      history.back();
    } else {
      resetToWelcome();
    }
  } else if (currentScreen === 'game' || currentScreen === 'results') {
    popstateNavigating = true;
    if (music) music.stop();
    showScreen('lobby');
    returnToLobby();
  }
});

startBtn.addEventListener('click', function() {
  if (startBtn.disabled) return;
  initMusic();
  startGame();
});

playAgainBtn.addEventListener('click', function() {
  initMusic();
  playAgain();
});

newGameResultsBtn.addEventListener('click', function() {
  returnToLobby();
});

// --- Mute ---
if (muted) muteBtn.querySelector('.sound-waves').style.display = 'none';
muteBtn.addEventListener('click', function() {
  muted = !muted;
  localStorage.setItem('tetris_muted', muted ? '1' : '0');
  muteBtn.querySelector('.sound-waves').style.display = muted ? 'none' : '';
  if (music) {
    music.muted = muted;
    if (music.masterGain) {
      music.masterGain.gain.cancelScheduledValues(music.ctx.currentTime);
      music.masterGain.gain.setValueAtTime(music.masterGain.gain.value, music.ctx.currentTime);
      music.masterGain.gain.linearRampToValueAtTime(muted ? 0 : Music.MASTER_VOLUME, music.ctx.currentTime + 0.05);
    }
  }
});

// --- Fullscreen ---
fullscreenBtn.addEventListener('click', function() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  } else {
    document.exitFullscreen().catch(function() {});
  }
});

// --- Pause (display-side buttons) ---
pauseBtn.addEventListener('click', function() {
  pauseGame();
});

pauseContinueBtn.addEventListener('click', function() {
  resumeGame();
});

pauseNewGameBtn.addEventListener('click', function() {
  returnToLobby();
});

// =====================================================================
// Render Loop
// =====================================================================

function renderLoop(timestamp) {
  requestAnimationFrame(renderLoop);

  if ((currentScreen !== 'game' && currentScreen !== 'results') || !ctx) return;

  if (lastFrameTime === null) lastFrameTime = timestamp;
  var deltaMs = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  var w = window.innerWidth;
  var h = window.innerHeight;
  ctx.fillStyle = THEME.color.bg.primary;
  ctx.fillRect(0, 0, w, h);

  if (!renderLoop._vignette || renderLoop._vw !== w || renderLoop._vh !== h) {
    renderLoop._vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
    renderLoop._vignette.addColorStop(0, 'rgba(15, 15, 40, 0.3)');
    renderLoop._vignette.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
    renderLoop._vw = w;
    renderLoop._vh = h;
  }
  ctx.fillStyle = renderLoop._vignette;
  ctx.fillRect(0, 0, w, h);

  if (!gameState) {
    for (var i = 0; i < playerOrder.length; i++) {
      if (!boardRenderers[i] || !uiRenderers[i]) continue;
      var pInfo = players.get(playerOrder[i]);
      var empty = {
        id: playerOrder[i],
        alive: true,
        score: 0, lines: 0, level: 1,
        garbageIndicatorEffects: [],
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: pInfo?.playerColor || PLAYER_COLORS[i]
      };
      boardRenderers[i].render(empty);
      uiRenderers[i].render(empty);
    }
    return;
  }

  if (gameState.players) {
    for (var i = 0; i < gameState.players.length; i++) {
      var playerData = gameState.players[i];
      if (!boardRenderers[i] || !uiRenderers[i]) continue;

      var shake = animations
        ? animations.getShakeOffsetForBoard(boardRenderers[i].x, boardRenderers[i].y)
        : { x: 0, y: 0 };

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.save();
        ctx.translate(shake.x, shake.y);
      }

      var pInfo = players.get(playerData.id);
      var now = performance.now();
      var activeGarbageIndicatorEffects = (garbageIndicatorEffects.get(playerData.id) || [])
        .filter(function(effect) { return now - effect.startTime < effect.duration; });
      if (activeGarbageIndicatorEffects.length > 0) {
        garbageIndicatorEffects.set(playerData.id, activeGarbageIndicatorEffects);
      } else {
        garbageIndicatorEffects.delete(playerData.id);
      }
      var enriched = Object.assign({}, playerData, {
        garbageIndicatorEffects: activeGarbageIndicatorEffects,
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: pInfo?.playerColor || PLAYER_COLORS[i]
      });

      boardRenderers[i].render(enriched);
      uiRenderers[i].render(enriched);

      // Draw QR overlay for disconnected players
      if (disconnectedQRs.has(playerData.id)) {
        var br = boardRenderers[i];
        var bx = br.x;
        var by = br.y;
        var bw = 10 * br.cellSize;
        var bh = 20 * br.cellSize;

        ctx.fillStyle = 'rgba(0, 0, 0, ' + THEME.opacity.overlay + ')';
        ctx.fillRect(bx, by, bw, bh);

        var qrImg = disconnectedQRs.get(playerData.id);
        var labelSize = Math.max(10, br.cellSize * THEME.font.cellScale.name);
        var labelGap = labelSize * 1.2;
        var qrSize = Math.min(bw, bh) * 0.5;
        var qrRadius = qrSize * 0.08;
        var pad = qrSize * 0.06;
        var outerSize = qrSize + pad * 2;
        var totalH = outerSize + labelGap + labelSize;
        var groupY = by + (bh - totalH) / 2;
        var outerX = bx + (bw - outerSize) / 2;
        var outerY = groupY;

        ctx.fillStyle = THEME.color.text.white;
        ctx.beginPath();
        ctx.roundRect(outerX, outerY, outerSize, outerSize, qrRadius);
        ctx.fill();

        ctx.strokeStyle = 'rgba(0, 200, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (qrImg) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(outerX + pad, outerY + pad, qrSize, qrSize, Math.max(1, qrRadius - pad));
          ctx.clip();
          ctx.drawImage(qrImg, outerX + pad, outerY + pad, qrSize, qrSize);
          ctx.restore();
        }

        ctx.fillStyle = enriched.playerColor || 'rgba(0, 200, 255, 0.7)';
        ctx.font = '600 ' + labelSize + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = '0.1em';
        ctx.fillText('SCAN TO REJOIN', bx + bw / 2, outerY + outerSize + labelGap);
        ctx.letterSpacing = '0px';
      }

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.restore();
      }
    }
  }

  if (animations) {
    animations.update(deltaMs);
    animations.render();
  }

  if (gameState.elapsed != null) {
    drawTimer(gameState.elapsed);
  }
}

var _timerFontReady = false;
function drawTimer(elapsedMs) {
  var totalSeconds = Math.floor(elapsedMs / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  var timeStr = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');

  if (!_timerFontReady) {
    _timerFontReady = document.fonts?.check?.('14px Orbitron') ?? false;
  }
  var font = _timerFontReady ? 'Orbitron' : '"Courier New", monospace';

  var btnH = Math.min(52, Math.max(36, window.innerHeight * 0.04));
  var labelSize = Math.round(btnH * 0.6);
  var digitAdvance = labelSize * 0.92;
  var colonAdvance = labelSize * 0.52;
  var advances = [];
  var timerWidth = 0;
  for (var i = 0; i < timeStr.length; i++) {
    var advance = timeStr[i] === ':' ? colonAdvance : digitAdvance;
    advances.push(advance);
    timerWidth += advance;
  }
  var startX = window.innerWidth / 2 - timerWidth / 2;
  var btnTop = Math.min(20, Math.max(10, window.innerHeight * 0.015));
  var y = btnTop + (btnH - labelSize) / 2;

  ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
  ctx.font = '700 ' + labelSize + 'px ' + font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.letterSpacing = '0.15em';
  var cursorX = startX;
  for (var i = 0; i < timeStr.length; i++) {
    var charX = cursorX + advances[i] / 2;
    ctx.fillText(timeStr[i], charX, y);
    cursorX += advances[i];
  }
  ctx.letterSpacing = '0px';
}

// =====================================================================
// Cursor Auto-Hide
// =====================================================================

var cursorTimer = null;
function showCursor() {
  document.body.classList.remove('cursor-hidden');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(function() {
    document.body.classList.add('cursor-hidden');
  }, 3000);
}
document.addEventListener('mousemove', showCursor);
showCursor();

// --- Window Resize ---
window.addEventListener('resize', function() {
  resizeCanvas();
  if (welcomeBg) welcomeBg.resize(window.innerWidth, window.innerHeight);
});

// =====================================================================
// Test Mode API (window.__TEST__)
// =====================================================================

if (new URLSearchParams(window.location.search).get('test') === '1') {
  window.__TEST__ = {
    addPlayers: function(playerList) {
      for (var i = 0; i < playerList.length; i++) {
        var p = playerList[i];
        var index = playerIndexCounter++;
        var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
        players.set(p.id, {
          playerName: p.name,
          playerColor: color,
          playerIndex: index
        });
        playerOrder.push(p.id);
        if (!hostId) hostId = p.id;
      }
      updatePlayerList();
      updateStartButton();
    },

    injectGameState: function(state) {
      roomState = ROOM_STATE.PLAYING;
      gameState = state;
      countdownOverlay.classList.add('hidden');
      showScreen('game');
      calculateLayout();
    },

    injectResults: function(results) {
      roomState = ROOM_STATE.RESULTS;
      lastResults = results;
      onGameEnd(results);
    },

    injectPause: function() {
      onGamePaused();
    },

    injectKO: function(playerId) {
      onPlayerKO({ playerId: playerId });
    },

    injectGarbageSent: function(data) {
      onGarbageSent(data);
    },

    injectCountdownGo: function() {
      // Simulate countdown reaching GO (for entering game screen)
      onCountdownDisplay('GO');
    }
  };
}

// =====================================================================
// Initialize
// =====================================================================

fetch('/api/version').then(function(r) { return r.json(); }).then(function(data) {
  document.getElementById('version-label').textContent = 'v' + data.version;
}).catch(function() {});

var bgCanvas = document.getElementById('bg-canvas');
if (bgCanvas) {
  welcomeBg = new WelcomeBackground(bgCanvas);
  welcomeBg.resize(window.innerWidth, window.innerHeight);
  welcomeBg.start();
}

fetchBaseUrl();
connectAndCreateRoom();
requestAnimationFrame(renderLoop);
