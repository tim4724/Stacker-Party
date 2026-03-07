'use strict';

// =====================================================================
// Display Connection — PartyConnection lifecycle, liveness, QR helpers
// Depends on: DisplayState.js (globals), DisplayGame.js (pauseGame, resumeGame, etc.)
// Called by: display.js (handleControllerMessage dispatches here)
// =====================================================================

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
  // Ensure we're in LOBBY (may already be if coming from welcome screen)
  if (roomState !== ROOM_STATE.LOBBY) setRoomState(ROOM_STATE.LOBBY);

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
    // Clear any surviving countdown interval to prevent duplicates
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (goTimeout) { clearTimeout(goTimeout); goTimeout = null; }
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
    var graceTimer = setTimeout(function() {
      graceTimers.delete(clientId);
      if (!players.has(clientId)) return;
      removeLobbyPlayer(clientId);
    }, 5000);
    graceTimers.set(clientId, graceTimer);
  } else if (roomState === ROOM_STATE.RESULTS) {
    // Results screen — return to lobby
    var peerWasHost = clientId === hostId;
    stopDisplayGame();
    lastResults = null;
    setRoomState(ROOM_STATE.LOBBY);
    removeLobbyPlayer(clientId);
    // removeLobbyPlayer handles UI + broadcast for host disconnect;
    // for non-host, we still need to notify controllers and update UI.
    if (!peerWasHost) {
      party.broadcast({ type: MSG.RETURN_TO_LOBBY, playerCount: players.size });
      returnToLobbyUI();
    }
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
    returnToLobbyUI();
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
      // Force reconnect once
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
  var rejoinUrl = joinUrl + '?rejoin=' + encodeURIComponent(clientId);
  fetchQR(rejoinUrl, function(qrMatrix) {
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
