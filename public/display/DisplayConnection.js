'use strict';

// =====================================================================
// Display Connection — PartyConnection lifecycle, peer management, QR helpers
// Depends on: DisplayState.js (globals), DisplayGame.js (pauseGame, resumeGame, etc.)
// Called by: display.js (handleControllerMessage dispatches here)
// See also: DisplayLiveness.js (heartbeat monitoring, extracted)
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
    if (attempt === 1) reconnectHeading.textContent = t('reconnecting');
    reconnectStatus.textContent = t('attempt_n_of_m', { attempt: Math.min(attempt, maxAttempts), max: maxAttempts });
    reconnectBtn.classList.add('hidden');
    if (attempt > maxAttempts) {
      disconnectedTimer = setTimeout(function () {
        reconnectHeading.textContent = t('disconnected');
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
      case 'master_changed':
        // AirConsole re-picked the master controller (e.g. premium upgrade).
        // Fires in any room state by design: menu-gate checks query host live
        // at message time, but controllers' isHost flags for their lobby /
        // results banners only refresh via LOBBY_UPDATE. A mid-game onPremium
        // is intentional — we always follow what getMasterClientId dictates.
        // Dedupe: onConnect + onPremium can fire back-to-back for a new
        // premium device; skip if the host ID is unchanged since last broadcast.
        if (players.size > 0 && getHostClientId() !== _lastBroadcastedHostId) {
          broadcastLobbyUpdate();
        }
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

var _copyTimer = null;

// Render the join URL into the two-span pill (small host + big room code).
// Called from both applyRoomCreated and onDisplayRejoined so the structure
// is preserved after a reconnect.
function renderJoinUrl(url) {
  var hostEl = joinUrlEl.querySelector('.join-url__host');
  var codeEl = joinUrlEl.querySelector('.join-url__code');
  if (hostEl && codeEl) {
    try {
      var u = new URL(url);
      // Trailing slash kept on the host span so it never wraps away from
      // the hostname onto the code line.
      hostEl.textContent = u.host + '/';
      codeEl.textContent = u.pathname.replace(/^\//, '') || url;
    } catch (e) {
      hostEl.textContent = '';
      codeEl.textContent = url;
    }
  } else {
    joinUrlEl.textContent = url;
  }
}

function applyRoomCreated(partyRoomCode, newJoinUrl) {
  roomCode = partyRoomCode;
  lastRoomCode = partyRoomCode;
  // Ensure we're in LOBBY (may already be if coming from welcome screen)
  if (roomState !== ROOM_STATE.LOBBY) setRoomState(ROOM_STATE.LOBBY);

  joinUrl = newJoinUrl;
  renderJoinUrl(joinUrl);
  // Click to copy the full join URL — handler is idempotent, attached
  // once on the first room creation.
  if (!joinUrlEl.dataset.copyBound) {
    joinUrlEl.dataset.copyBound = '1';
    joinUrlEl.setAttribute('role', 'button');
    joinUrlEl.setAttribute('tabindex', '0');
    joinUrlEl.setAttribute('aria-label', 'Copy join URL');
    var showCopiedToast = function() {
      var copiedLabel = t('copied') || 'Copied';
      joinUrlEl.setAttribute('data-copied-label', copiedLabel);
      joinUrlEl.setAttribute('data-copied', '1');
      // Reflect the success state for screen readers — the ::after toast
      // is purely visual, so aria-label is the only cue they see.
      joinUrlEl.setAttribute('aria-label', copiedLabel);
      clearTimeout(_copyTimer);
      _copyTimer = setTimeout(function() {
        joinUrlEl.removeAttribute('data-copied');
        joinUrlEl.setAttribute('aria-label', 'Copy join URL');
      }, 1600);
    };
    var copyToClipboard = function() {
      if (!joinUrl) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(joinUrl).then(showCopiedToast, tryExecCommandFallback);
      } else {
        tryExecCommandFallback();
      }
    };
    // Legacy fallback: offscreen textarea + execCommand('copy'). Reports
    // success via document.execCommand's return value so the toast only
    // shows when the copy actually landed.
    var tryExecCommandFallback = function() {
      var ta = document.createElement('textarea');
      ta.value = joinUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      if (ok) showCopiedToast();
    };
    joinUrlEl.addEventListener('click', copyToClipboard);
    joinUrlEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyToClipboard(); }
    });
  }

  // Reset local state
  resetRoomData();
  _lastBroadcastedHostId = null;

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
  renderJoinUrl(joinUrl);

  // Reset the master_changed dedup sentinel — on rejoin we re-push WELCOME
  // to everyone below, and any subsequent LOBBY_UPDATE / master_changed
  // should broadcast regardless of what the sentinel held pre-disconnect.
  _lastBroadcastedHostId = null;

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
    // Clear any surviving countdown timers to prevent duplicates on resume
    clearCountdownTimers();
    resumeGame();
  }

  // Re-send WELCOME to all known players so controllers clear their reconnect overlay
  var hostId = getHostClientId();
  var hostPlayer = hostId ? players.get(hostId) : null;
  var hostName = hostPlayer ? hostPlayer.playerName : null;
  var hostColor = hostPlayer ? hostPlayer.playerColor : null;
  for (const entry of players) {
    const id = entry[0];
    const info = entry[1];
    var isLateJoiner = (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)
      && playerOrder.indexOf(id) < 0;
    var welcomeMsg = {
      type: MSG.WELCOME,
      playerName: info.playerName,
      playerColor: info.playerColor,
      playerCount: players.size,
      roomState: roomState,
      startLevel: info.startLevel || 1,
      isHost: id === hostId,
      hostName: hostName,
      hostColor: hostColor
    };
    if (!isLateJoiner) {
      welcomeMsg.alive = lastAliveState[id] != null ? lastAliveState[id] : true;
      welcomeMsg.paused = paused;
    }
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
  if (players.size >= GameConstants.MAX_PLAYERS) return;

  var index = nextAvailableSlot();
  if (index < 0) return;
  var color = PLAYER_COLORS[index % PLAYER_COLORS.length];

  players.set(clientId, {
    playerName: 'P' + (index + 1),
    playerColor: color,
    playerIndex: index,
    startLevel: 1,
    lastPingTime: Date.now()
  });

  // Only add to playerOrder in lobby — late joiners wait for next game.
  // playerOrder is snapshotted at game start by runGameLocally().
  if (roomState === ROOM_STATE.LOBBY) {
    playerOrder.push(clientId);
    updatePlayerList();
    updateStartButton();
  }
}

function onPeerLeft(clientId) {
  if (!players.has(clientId)) return;

  cleanupPlayerInput(clientId);

  if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
    if (playerOrder.indexOf(clientId) >= 0) {
      // Active game participant — keep in Map for seamless reconnect
      showDisconnectQR(clientId);
      checkAllPlayersDisconnected();
    } else {
      // Late joiner (never in the game) — remove silently
      players.delete(clientId);
      garbageIndicatorEffects.delete(clientId);
      garbageDefenceEffects.delete(clientId);
    }
  } else if (roomState === ROOM_STATE.LOBBY) {
    removeLobbyPlayer(clientId);
  } else if (roomState === ROOM_STATE.RESULTS) {
    players.delete(clientId);
    var idx = playerOrder.indexOf(clientId);
    if (idx !== -1) playerOrder.splice(idx, 1);
    garbageIndicatorEffects.delete(clientId);
    garbageDefenceEffects.delete(clientId);
    // Return to lobby when no game participants remain (late joiners don't count)
    var hasParticipants = false;
    for (var i = 0; i < playerOrder.length; i++) {
      if (players.has(playerOrder[i])) { hasParticipants = true; break; }
    }
    if (!hasParticipants) {
      lastResults = null;
      setRoomState(ROOM_STATE.LOBBY);
      broadcastLobbyUpdate();
      party.broadcast({ type: MSG.RETURN_TO_LOBBY, playerCount: players.size });
      returnToLobbyUI();
    } else if (players.size > 0) {
      // Host may have changed — let remaining controllers refresh their
      // "waiting for host" banner on the results screen.
      broadcastLobbyUpdate();
    }
  }
}

function removeLobbyPlayer(clientId) {
  players.delete(clientId);
  playerOrder = playerOrder.filter(function(id) { return id !== clientId; });
  garbageIndicatorEffects.delete(clientId);
  garbageDefenceEffects.delete(clientId);
  updatePlayerList();
  updateStartButton();
  if (players.size > 0) {
    broadcastLobbyUpdate();
  }
}

// =====================================================================
// Lobby Update Broadcast
// =====================================================================

var _lastBroadcastedHostId = null;

function broadcastLobbyUpdate() {
  var hostId = getHostClientId();
  var hostPlayer = hostId ? players.get(hostId) : null;
  var hostName = hostPlayer ? hostPlayer.playerName : null;
  var hostColor = hostPlayer ? hostPlayer.playerColor : null;
  _lastBroadcastedHostId = hostId;
  applyHostTint();
  for (const entry of players) {
    const id = entry[0];
    party.sendTo(id, {
      type: MSG.LOBBY_UPDATE,
      playerCount: players.size,
      startLevel: entry[1].startLevel || 1,
      isHost: id === hostId,
      hostName: hostName,
      hostColor: hostColor
    });
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
  // Set immediately so allPlayersDisconnected() can check synchronously
  disconnectedQRs.set(clientId, null);
  if (!joinUrl) return;
  var rejoinUrl = joinUrl + '?rejoin=' + encodeURIComponent(clientId);
  fetchQR(rejoinUrl, function(qrMatrix) {
    if (!players.has(clientId)) return;
    if (!qrMatrix) {
      disconnectedQRs.set(clientId, null);
      return;
    }
    var offscreen = document.createElement('canvas');
    renderQR(offscreen, qrMatrix, 512);
    disconnectedQRs.set(clientId, offscreen);
  });
}

// renderQR() lives in DisplayUI.js (rendering helper)
