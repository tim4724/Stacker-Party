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
        startGame();
        break;
      case MSG.PLAY_AGAIN:
        playAgain();
        break;
      case MSG.RETURN_TO_LOBBY:
        returnToLobby();
        break;
      case MSG.PAUSE_GAME:
        if (playerOrder.indexOf(fromId) >= 0) pauseGame();
        break;
      case MSG.RESUME_GAME:
        if (playerOrder.indexOf(fromId) >= 0) resumeGame();
        break;
      case MSG.SET_LEVEL:
        onSetLevel(fromId, msg);
        break;
      case MSG.LEAVE:
        removePlayer(fromId);
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

    // Update name, sanitizing "P1"–"P4" to match actual slot
    if (name) existing.playerName = sanitizePlayerName(name, existing.playerIndex);
    updatePlayerList();

    // Late joiner: registered via onPeerJoined during active game but never
    // participated. Omit alive/paused so controller shows waiting screen.
    var isLateJoiner = (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)
      && playerOrder.indexOf(fromId) < 0;

    // Send welcome with current state
    var welcomeMsg = {
      type: MSG.WELCOME,
      playerName: existing.playerName,
      playerColor: existing.playerColor,
      playerCount: players.size,
      roomState: roomState,
      startLevel: existing.startLevel || 1
    };
    if (!isLateJoiner) {
      welcomeMsg.alive = lastAliveState[fromId] != null ? lastAliveState[fromId] : true;
      welcomeMsg.paused = paused;
    }
    if (roomState === ROOM_STATE.RESULTS && lastResults) {
      welcomeMsg.results = lastResults.results;
    }
    party.sendTo(fromId, welcomeMsg);

    if (roomState === ROOM_STATE.LOBBY) broadcastLobbyUpdate();
    return;
  }

  // New player joining
  var index = nextAvailableSlot();
  if (index < 0) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
    return;
  }
  var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
  var playerName = sanitizePlayerName(name, index);

  players.set(fromId, {
    playerName: playerName,
    playerColor: color,
    playerIndex: index,
    startLevel: 1,
    lastPingTime: Date.now()
  });
  if (roomState === ROOM_STATE.LOBBY) {
    playerOrder.push(fromId);
  }

  var welcomeMsg = {
    type: MSG.WELCOME,
    playerName: playerName,
    playerColor: color,
    playerCount: players.size,
    roomState: roomState,
    startLevel: 1
  };
  if (roomState === ROOM_STATE.RESULTS && lastResults) {
    welcomeMsg.results = lastResults.results;
  }
  party.sendTo(fromId, welcomeMsg);

  if (roomState === ROOM_STATE.LOBBY) {
    broadcastLobbyUpdate();
    updatePlayerList();
    updateStartButton();
  }
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

function removePlayer(clientId) {
  onPeerLeft(clientId);
}
