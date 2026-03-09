'use strict';

// =====================================================================
// Display Input — controller message handling and input validation
// Depends on: DisplayState.js, DisplayUI.js, DisplayConnection.js, DisplayGame.js
// =====================================================================

// Input validation: only accept known game actions (derived from protocol.js INPUT)
var VALID_ACTIONS = new Set(Object.values(INPUT));

function handleControllerMessage(fromId, msg) {
  try {
    if (!msg || !msg.type) return;

    // Any message from a controller proves it's alive
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
  } catch (err) {
    console.error('[input] Error handling message from', fromId, ':', err);
  }
}

function onHello(fromId, msg) {
  var name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 16) : '';

  // Player already registered (from peer_joined or reconnect)
  if (players.has(fromId)) {
    var existing = players.get(fromId);

    // Clear grace timer if any
    if (graceTimers.has(fromId)) {
      clearTimeout(graceTimers.get(fromId));
      graceTimers.delete(fromId);
    }

    // Update name, sanitizing "P1"–"P4" to match actual slot
    if (name) existing.playerName = sanitizePlayerName(name, existing.playerIndex);
    updatePlayerList();

    // Send welcome with current state
    var welcomeMsg = {
      type: MSG.WELCOME,
      playerName: existing.playerName,
      playerColor: existing.playerColor,
      isHost: fromId === hostId,
      playerCount: players.size,
      roomState: roomState,
      alive: lastAliveState[fromId] != null ? lastAliveState[fromId] : true,
      paused: paused
    };
    if (roomState === ROOM_STATE.RESULTS && lastResults) {
      welcomeMsg.results = lastResults.results;
    }
    party.sendTo(fromId, welcomeMsg);

    broadcastLobbyUpdate();
    return;
  }

  // New player joining
  if (roomState !== ROOM_STATE.LOBBY) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Game already in progress' });
    return;
  }

  var index = nextAvailableSlot();
  if (index < 0) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
    return;
  }
  var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
  var playerName = sanitizePlayerName(name, index);
  var isHost = hostId === null;
  if (isHost) hostId = fromId;

  players.set(fromId, {
    playerName: playerName,
    playerColor: color,
    playerIndex: index,
    lastPingTime: Date.now()
  });
  playerOrder.push(fromId);

  party.sendTo(fromId, {
    type: MSG.WELCOME,
    playerName: playerName,
    playerColor: color,
    isHost: isHost,
    playerCount: players.size,
    roomState: roomState
  });

  broadcastLobbyUpdate();
  updatePlayerList();
  updateStartButton();
}

function onInput(fromId, msg) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;
  if (!VALID_ACTIONS.has(msg.action)) return;
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
