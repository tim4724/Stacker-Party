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
      party.create(9);
    }
  };

  party.onClose = function(attempt, maxAttempts) {
    preCreatedRoom = null;
    if (currentScreen === SCREEN.WELCOME) return;
    clearTimeout(disconnectedTimer);

    if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
      if (!paused) pauseGame();
      pauseOverlay.classList.add('hidden');
    }

    reconnectOverlay.classList.remove('hidden');
    if (attempt === 1) reconnectHeading.textContent = 'RECONNECTING';
    reconnectStatus.textContent = 'Attempt ' + Math.min(attempt, maxAttempts) + ' of ' + maxAttempts;
    reconnectBtn.classList.add('hidden');
    if (attempt > maxAttempts) {
      disconnectedTimer = setTimeout(function () {
        reconnectHeading.textContent = 'DISCONNECTED';
        reconnectStatus.textContent = '';
        reconnectBtn.classList.remove('hidden');
      }, 1000);
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
        if (msg.message === 'Room not found' || msg.message === 'Room is full') {
          console.error('Party-Server error:', msg.message);
          resetToWelcome();
        } else {
          console.warn('Party-Server:', msg.message);
        }
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
  if (currentScreen === SCREEN.WELCOME) {
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
  hostId = null;
  paused = false;
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  lastAliveState = {};
  lastResults = null;

  showScreen(SCREEN.LOBBY);
  updateStartButton();
  startLivenessCheck();

  // Fetch QR from HTTP server
  fetchQR(joinUrl, function(qrMatrix) {
    requestAnimationFrame(function() { renderQR(qrCode, qrMatrix); });
  });
}

function onDisplayRejoined(partyRoomCode, clients) {
  // Display reconnected to existing room — resync state
  roomCode = partyRoomCode;
  lastRoomCode = partyRoomCode;

  joinUrl = getBaseUrl() + '/' + roomCode;
  joinUrlEl.textContent = joinUrl;

  // Reset liveness for clients still in the room; handle missing ones
  var now = Date.now();
  var connectedSet = new Set(clients || []);
  var disconnectedIds = [];
  for (const pEntry of players) {
    if (connectedSet.has(pEntry[0])) {
      pEntry[1].lastPingTime = now;
    } else {
      disconnectedIds.push(pEntry[0]);
    }
  }
  for (var i = 0; i < disconnectedIds.length; i++) {
    onPeerLeft(disconnectedIds[i]);
  }

  startLivenessCheck();

  // Clear reconnect overlay — connection restored
  clearTimeout(disconnectedTimer);
  party.resetReconnectCount();
  reconnectOverlay.classList.add('hidden');
  if (paused && (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)) {
    // Clear any surviving countdown interval to prevent duplicates
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (goTimeout) { clearTimeout(goTimeout); goTimeout = null; }
    resumeGame();
  }

  // Re-send WELCOME to all known players so controllers clear their reconnect overlay
  for (const entry of players) {
    const id = entry[0];
    const info = entry[1];
    var welcomeMsg = {
      type: MSG.WELCOME,
      playerName: info.playerName,
      playerColor: info.playerColor,
      isHost: id === hostId,
      playerCount: players.size,
      roomState: roomState,
      startLevel: info.startLevel || 1,
      alive: lastAliveState[id] != null ? lastAliveState[id] : true,
      paused: paused
    };
    // lastResults is { elapsed, results: [...] } — send the results array
    if (roomState === ROOM_STATE.RESULTS && lastResults) {
      welcomeMsg.results = lastResults.results;
    }
    party.sendTo(id, welcomeMsg);
  }

  if (roomState === ROOM_STATE.LOBBY) {
    showScreen(SCREEN.LOBBY);
    updateStartButton();
    fetchQR(joinUrl, function(qrMatrix) {
      requestAnimationFrame(function() { renderQR(qrCode, qrMatrix); });
    });
  }
}

function onPeerJoined(clientId) {
  if (players.has(clientId)) return;
  if (roomState !== ROOM_STATE.LOBBY) return;
  if (players.size >= GameConstants.MAX_PLAYERS) return;

  var index = nextAvailableSlot();
  if (index < 0) return;
  var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
  var isHost = hostId === null;
  if (isHost) hostId = clientId;

  players.set(clientId, {
    playerName: 'P' + (index + 1),
    playerColor: color,
    playerIndex: index,
    startLevel: 1,
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
    if (clientId === hostId) {
      // Host left — kick everyone back to lobby
      lastResults = null;
      setRoomState(ROOM_STATE.LOBBY);
      removeLobbyPlayer(clientId);
    } else {
      // Non-host left — stay on results screen, just remove them
      players.delete(clientId);
      var idx = playerOrder.indexOf(clientId);
      if (idx !== -1) playerOrder.splice(idx, 1);
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
    garbageIndicatorEffects.clear();
    garbageDefenceEffects.clear();
    updatePlayerList();
    updateStartButton();
    returnToLobbyUI();
  } else {
    players.delete(clientId);
    playerOrder = playerOrder.filter(function(id) { return id !== clientId; });
    garbageIndicatorEffects.delete(clientId);
    garbageDefenceEffects.delete(clientId);
    updatePlayerList();
    updateStartButton();
    broadcastLobbyUpdate();
  }
}

// =====================================================================
// Lobby Update Broadcast
// =====================================================================

function broadcastLobbyUpdate() {
  for (const entry of players) {
    const id = entry[0];
    party.sendTo(id, {
      type: MSG.LOBBY_UPDATE,
      playerCount: players.size,
      isHost: id === hostId,
      startLevel: entry[1].startLevel || 1
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
    var displayDead = heartbeatSent && (now - lastHeartbeatEcho > GameConstants.LIVENESS_TIMEOUT_MS);
    heartbeatSent = true;

    if (displayDead) {
      if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
        if (!paused) pauseGame();
        pauseOverlay.classList.add('hidden');
      }
      // Don't overwrite DISCONNECTED state after attempts exhausted
      if (party.reconnectAttempt >= party.maxReconnectAttempts) return;
      // Show overlay once on first dead detection; don't overwrite
      // attempt text that onClose sets on subsequent ticks
      if (reconnectOverlay.classList.contains('hidden')) {
        reconnectOverlay.classList.remove('hidden');
        reconnectHeading.textContent = 'RECONNECTING';
        reconnectStatus.textContent = '';
        reconnectBtn.classList.add('hidden');
      }
      // Force reconnect — subsequent ticks skip because
      // party.connected is false while the new WS is connecting
      if (party.connected) {
        party.reconnectNow();
      }
      return;
    }

    // Check individual controller liveness
    for (const entry of players) {
      const id = entry[0];
      const player = entry[1];
      if (player.lastPingTime && (now - player.lastPingTime > GameConstants.LIVENESS_TIMEOUT_MS)) {
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
    renderQR(offscreen, qrMatrix);
    disconnectedQRs.set(clientId, offscreen);
  });
}

// renderQR() lives in DisplayUI.js (rendering helper)
