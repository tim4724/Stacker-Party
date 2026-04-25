'use strict';

// =====================================================================
// Display Input — controller message handling and input validation
// Depends on: DisplayState.js, DisplayUI.js, DisplayConnection.js, DisplayGame.js
// =====================================================================

// Input validation: only accept known game actions (derived from protocol.js INPUT)
var VALID_ACTIONS = new Set(Object.values(INPUT));

// Per-player hard_drop rate limit — prevents queued messages from firing multiple drops
var HARD_DROP_MIN_INTERVAL_MS = 150;
var lastHardDropTime = new Map();

// Soft drop auto-timeout (owned here, used only by input handling)
var softDropTimers = new Map();

function handleControllerMessage(fromId, msg) {
  try {
    if (!msg || !msg.type) return;

    // Any message from a controller proves it's alive
    var wasDisconnected = disconnectedQRs.has(fromId);
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
        startGame();
        break;
      case MSG.PLAY_AGAIN:
        playAgain();
        break;
      case MSG.RETURN_TO_LOBBY:
        returnToLobby();
        break;
      case MSG.PAUSE_GAME:
        pauseGame();
        break;
      case MSG.RESUME_GAME:
        resumeGame();
        break;
      case MSG.SET_LEVEL:
        onSetLevel(fromId, msg);
        break;
      case MSG.SET_COLOR:
        onSetColor(fromId, msg);
        break;
      case MSG.LEAVE:
        onPeerLeft(fromId);
        break;
      case MSG.SET_DISPLAY_MUTE:
        onSetDisplayMute(fromId, msg);
        break;
      case MSG.PING:
        party.sendTo(fromId, { type: MSG.PONG, t: msg.t });
        break;
    }

    // Auto-resume after processing the message (e.g. after onHello sends
    // WELCOME with paused state) so the controller gets proper state sync
    // before the GAME_RESUMED broadcast.
    if (wasDisconnected && playerOrder.indexOf(fromId) >= 0) {
      clearLateJoinerGraceTimer();
      if (autoPaused) checkAutoResume();
    }
  } catch (err) {
    console.error('[input] Error handling message from', fromId, ':', err);
  }
}

function onHello(fromId, msg) {
  // Strip control characters (incl. \x00) — defensive against names that would
  // render weirdly in textContent or confuse downstream serialization.
  // ControllerGame.js#renderHostBanner uses \x00 as a template-split sentinel;
  // a \x00 in a player name would survive to the controller and reach that
  // split. Stripping here is the single chokepoint — all inbound names pass
  // through onHello.
  var name = typeof msg.name === 'string'
    ? msg.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16)
    : '';

  // Player already registered (from peer_joined or reconnect)
  if (players.has(fromId)) {
    var existing = players.get(fromId);

    // Update name, sanitizing "P1"–"P4" to match actual slot
    if (name) existing.playerName = sanitizePlayerName(name, existing.playerIndex);
    updatePlayerList();

    // Late joiner: registered via onPeerJoined during active game but never
    // participated. Omit alive/paused so controller shows waiting screen.
    var isLateJoiner = (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)
      && playerOrder.indexOf(fromId) < 0;

    // Send welcome with current state
    var hostId = getHostClientId();
    var hostPlayer = hostId ? players.get(hostId) : null;
    var welcomeMsg = {
      type: MSG.WELCOME,
      playerName: existing.playerName,
      colorIndex: existing.playerIndex,
      playerCount: players.size,
      roomState: roomState,
      startLevel: existing.startLevel || 1,
      isHost: fromId === hostId,
      hostName: hostPlayer ? hostPlayer.playerName : null,
      hostColorIndex: hostPlayer ? hostPlayer.playerIndex : null,
      takenColorIndices: collectTakenColorIndices(),
      displayMuted: !!muted
    };
    if (!isLateJoiner) {
      welcomeMsg.alive = lastAliveState[fromId] != null ? lastAliveState[fromId] : true;
      welcomeMsg.paused = paused;
    }
    if (roomState === ROOM_STATE.RESULTS && lastResults) {
      welcomeMsg.results = lastResults.results;
    }
    party.sendTo(fromId, welcomeMsg);

    // Refresh host info on the other controllers too.
    //
    // - Standard mode: a reconnecting ex-host does NOT reclaim — onPeerLeft
    //   already handed hostClientId off via electNextHost when they dropped.
    //   The call is still useful here to flip the temp host's Return-to-
    //   lobby button visibility back, since getHostClientId's read-only
    //   fallback (oldest-joined) was the host while the slot's owner was
    //   disconnected, and now resolves cleanly to the stored hostClientId.
    // - AirConsole mode: getMasterClientId() takes priority in
    //   getHostClientId, so the platform CAN re-elect the reconnecting
    //   player as master if they were the AC master before. The dedup
    //   sentinel inside maybeBroadcastHostChange suppresses the broadcast
    //   when nothing actually changed.
    maybeBroadcastHostChange();
    return;
  }

  // New player joining
  var index = nextAvailableSlot();
  if (index < 0) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
    return;
  }
  var playerName = sanitizePlayerName(name, index);

  players.set(fromId, {
    playerName: playerName,
    playerIndex: index,
    startLevel: 1,
    lastPingTime: Date.now(),
    // Tiebreaker for sticky host election — see onPeerJoined. This branch
    // only runs if HELLO beats the relay's peer_joined event; normally
    // onPeerJoined gets here first and onHello takes the reconnect path.
    joinedAt: ++_joinSequence
  });
  if (hostClientId == null) hostClientId = fromId;
  if (roomState === ROOM_STATE.LOBBY) {
    playerOrder.push(fromId);
  }

  var hostId = getHostClientId();
  var hostPlayer = hostId ? players.get(hostId) : null;
  var welcomeMsg = {
    type: MSG.WELCOME,
    playerName: playerName,
    colorIndex: index,
    playerCount: players.size,
    roomState: roomState,
    startLevel: 1,
    isHost: fromId === hostId,
    hostName: hostPlayer ? hostPlayer.playerName : null,
    hostColorIndex: hostPlayer ? hostPlayer.playerIndex : null,
    takenColorIndices: collectTakenColorIndices(),
    displayMuted: !!muted
  };
  if (roomState === ROOM_STATE.RESULTS && lastResults) {
    welcomeMsg.results = lastResults.results;
  }
  party.sendTo(fromId, welcomeMsg);

  if (roomState === ROOM_STATE.LOBBY) {
    broadcastLobbyUpdate();
    updatePlayerList();
    updateStartButton();
  } else if (roomState === ROOM_STATE.RESULTS) {
    // A new low-slot player can become host — notify existing controllers so
    // their "Waiting for {name}" banners and Play Again buttons stay accurate.
    broadcastLobbyUpdate();
  }
}

function onInput(fromId, msg) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;
  if (!VALID_ACTIONS.has(msg.action)) return;

  // Rate-limit hard drops to prevent queued messages from rapid-firing after reconnect
  if (msg.action === INPUT.HARD_DROP) {
    var now = Date.now();
    var last = lastHardDropTime.get(fromId) || 0;
    if (now - last < HARD_DROP_MIN_INTERVAL_MS) return;
    lastHardDropTime.set(fromId, now);
  }

  displayGame.processInput(fromId, msg.action);
}

function onSoftDrop(fromId, speed) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;

  displayGame.handleSoftDropStart(fromId, speed);

  // Reset auto-end timeout
  if (softDropTimers.has(fromId)) {
    clearTimeout(softDropTimers.get(fromId));
  }
  softDropTimers.set(fromId, setTimeout(function() {
    softDropTimers.delete(fromId);
    if (displayGame) displayGame.handleSoftDropEnd(fromId);
  }, GameConstants.SOFT_DROP_TIMEOUT_MS));
}

function onSetDisplayMute(fromId, msg) {
  // Host-only: non-host controllers can't mute the shared display.
  var hostId = getHostClientId();
  if (fromId !== hostId) {
    console.warn('[input] non-host SET_DISPLAY_MUTE rejected from', fromId);
    return;
  }
  if (typeof setDisplayMuted === 'function') {
    setDisplayMuted(msg.muted === true);
  }
}

function onSetLevel(fromId, msg) {
  var player = players.get(fromId);
  if (!player) return;
  var level = parseInt(msg.level, 10);
  if (isNaN(level) || level < 1 || level > 15) return;
  player.startLevel = level;
  if (roomState === ROOM_STATE.LOBBY) {
    updatePlayerList();
    broadcastLobbyUpdate();
  }
}

// Re-claim a palette slot. Active game participants (in playerOrder during
// COUNTDOWN/PLAYING/RESULTS) are locked — color is baked into the running
// game. Late joiners sitting in waitingForNextGame can still pre-pick.
// Silently rejects collisions so concurrent picks don't spam the sender with
// errors; the next LOBBY_UPDATE carries the truth.
function onSetColor(fromId, msg) {
  if (!players.has(fromId)) return;
  var idx = parseInt(msg.colorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= PLAYER_COLORS.length) return;

  var isActiveParticipant = playerOrder.indexOf(fromId) >= 0 && roomState !== ROOM_STATE.LOBBY;
  if (isActiveParticipant) return;

  var player = players.get(fromId);
  if (player.playerIndex === idx) return;

  for (const entry of players) {
    if (entry[0] !== fromId && entry[1].playerIndex === idx) return;
  }

  player.playerIndex = idx;
  updatePlayerList();
  broadcastLobbyUpdate();
}

function cleanupPlayerInput(clientId) {
  if (softDropTimers.has(clientId)) {
    clearTimeout(softDropTimers.get(clientId));
    softDropTimers.delete(clientId);
    if (displayGame) displayGame.handleSoftDropEnd(clientId);
  }
  lastHardDropTime.delete(clientId);
}

function resetAllPlayerInput() {
  for (const entry of softDropTimers) {
    clearTimeout(entry[1]);
  }
  softDropTimers.clear();
  lastHardDropTime.clear();
}
