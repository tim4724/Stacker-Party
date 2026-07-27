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
    var wasDisconnected = disconnectedQRs.has(fromId);
    disconnectedQRs.delete(fromId);
    if (wasDisconnected) flow.markReconnected(fromId);
    flow.onSeen(fromId, Date.now());

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
      case MSG.SOFT_DROP_END:
        endSoftDrop(fromId);
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
      case MSG.SET_NAME:
        onSetName(fromId, msg);
        break;
      case MSG.LEAVE:
        onPeerLeft(fromId);
        break;
      case MSG.SET_DISPLAY_MUTE:
        onSetDisplayMute(fromId, msg);
        break;
      case MSG.PING:
        // PING/PONG measures relay-mediated RTT (WS). Input-path RTT is
        // measured separately via fastlane acks (PartyFastlane onRtt).
        party.sendTo(fromId, { type: MSG.PONG, t: msg.t });
        break;
    }

    // Auto-resume after processing the message, so the reconnecting controller
    // has already been sent a snapshot describing the paused game before the
    // resume publishes over the top of it.
    if (wasDisconnected && playerOrder.indexOf(fromId) >= 0) {
      // The reconnect already dropped flow's disconnect flag (markReconnected
      // above), so allParticipantsDisconnected is now false and the next
      // graceTick clears the late-joiner deadline — no explicit cancel needed.
      if (autoPaused) checkAutoResume();
    }
  } catch (err) {
    console.error('[input] Error handling message from', fromId, ':', err);
  }
}

// Strip control characters (incl. \x00) — defensive against names that would
// render weirdly in textContent or confuse downstream serialization.
// ControllerGame.js#renderHostBanner uses \x00 as a template-split sentinel;
// a \x00 in a player name would survive to the controller and reach that
// split. Every inbound name (HELLO + SET_NAME) passes through here — keep it
// the single sanitizing chokepoint.
function cleanInboundName(raw) {
  return typeof raw === 'string'
    ? raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16)
    : '';
}

// Preferred color carried on HELLO (the controller's persisted favorite).
// Returns a valid, un-taken palette index or null. Mirrors onSetColor's
// validation: silently skip collisions, the room snapshot carries the truth
// either way. Honoring it here (instead of waiting for the controller's
// follow-up SET_COLOR reclaim) removes a full round trip during which both the
// TV and the controller showed the default slot color.
function helloPreferredColor(fromId, msg) {
  var idx = parseInt(msg.colorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= PLAYER_COLORS.length) return null;
  for (const entry of players) {
    if (entry[0] !== fromId && entry[1].playerIndex === idx) return null;
  }
  return idx;
}

function onHello(fromId, msg) {
  var name = cleanInboundName(msg.name);
  var claimedReconnect = claimReconnectPeer(fromId, msg);

  // Player already registered (from peer_joined or reconnect)
  if (players.has(fromId)) {
    var existing = players.get(fromId);
    // Their identity is authoritative from here on, not the placeholder
    // peer_joined guessed. Their own controller renders itself once it sees
    // this in the snapshot.
    existing.helloSeen = true;

    // Update name. Empty submissions and legacy P1-P8 fallbacks resolve to
    // room-unique HX names; custom names stay as entered.
    if (name || (msg.autoName === true && !claimedReconnect)) {
      // For the peer_joined-before-HELLO path, preserve the HX name already
      // assigned on the player's Map entry while excluding that entry from
      // collision checks.
      var requestedName = name || existing.playerName;
      existing.playerName = sanitizePlayerName(requestedName, fromId, msg.autoName === true);
    }
    // Honor the preferred color right away, so the snapshot we publish below
    // already names the color the controller will actually keep — no round
    // trip through the controller's reclaimPreferredColor.
    var preferredColor = helloPreferredColor(fromId, msg);
    if (preferredColor != null && existing.playerIndex !== preferredColor) {
      existing.playerIndex = preferredColor;
    }
    updatePlayerList();

    // One publish settles everything a HELLO can move: this controller's own
    // identity (name, colour, level), the roster the others render, and the
    // host — a reconnecting ex-host reclaims the role their pinned slot held
    // through the disconnect (or, in AirConsole mode, whatever
    // getMasterPeerIndex now dictates), so the temp host's Return-to-lobby
    // button switches off in the same update.
    publishRoomState();
    if (claimedReconnect && autoPaused) checkAutoResume();
    return;
  }

  // New player joining. Their preferred color wins over the default slot when
  // it's free; a free color implies a free slot, so the room-full check only
  // guards the fallback.
  var index = helloPreferredColor(fromId, msg);
  if (index == null) index = nextAvailableSlot();
  if (index < 0) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
    return;
  }
  var playerName = sanitizePlayerName(name, fromId, msg.autoName === true);

  // flow.addPlayer assigns joinedAt + connected and makes the first joiner the
  // sticky host. This branch only runs if HELLO beats the relay's peer_joined
  // event; normally onPeerJoined gets here first and onHello takes the
  // reconnect path (flow.addPlayer merges fields on the existing record).
  flow.addPlayer(fromId, {
    playerName: playerName,
    playerIndex: index,
    startLevel: 1,
    helloSeen: true
  });
  flow.onSeen(fromId, Date.now());
  if (roomState === ROOM_STATE.LOBBY) {
    playerOrder.push(fromId);
  }

  if (roomState === ROOM_STATE.LOBBY) {
    updatePlayerList();
    updateStartButton();
  }
  // Publishes in every room state: the joiner needs the snapshot to learn who
  // they are and which screen to show, and a new low-slot player can take over
  // as host, which moves the other controllers' "Waiting for {name}" banners.
  publishRoomState();
}

function onInput(fromId, msg) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;
  if (!VALID_ACTIONS.has(msg.action)) return;

  // The engine owns hard-drop rate-limiting and soft-drop supersede.
  displayGame.processInput(fromId, msg.action);
}

function onSoftDrop(fromId, speed) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;

  // The engine arms its own auto-end fallback in case the explicit
  // SOFT_DROP_END is lost (PlayerBoard.softDropDeadlineMs).
  displayGame.handleSoftDropStart(fromId, speed);
}

// End a player's soft drop now: stop the accelerated fall. Driven by the
// explicit SOFT_DROP_END message (immediate on touch-up) or disconnect
// cleanup. The engine's own deadline still covers a lost SOFT_DROP_END.
function endSoftDrop(fromId) {
  if (displayGame) displayGame.handleSoftDropEnd(fromId);
}

function onSetDisplayMute(fromId, msg) {
  // Host-only: non-host controllers can't mute the shared display.
  var hostId = getHostPeerIndex();
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
    // Held-finger control: the 500ms throttle collapses a burst of +/- taps
    // into at most ~2 publishes per second no matter how fast they come, and
    // the trailing one always carries the final level.
    publishRoomStateSoon();
  }
}

// Re-claim a palette slot. Silently rejects collisions so concurrent picks
// don't spam the sender with errors; the next snapshot carries the truth.
// Not state-gated: the controller's color picker is reachable only in the
// lobby, so a mid-game pick can't occur in practice — no guard needed.
function onSetColor(fromId, msg) {
  if (!players.has(fromId)) return;
  var idx = parseInt(msg.colorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= PLAYER_COLORS.length) return;

  var player = players.get(fromId);
  if (player.playerIndex === idx) return;

  for (const entry of players) {
    if (entry[0] !== fromId && entry[1].playerIndex === idx) return;
  }

  player.playerIndex = idx;
  updatePlayerList();
  // Retint the host-tinted CTAs in the same paint as the roster card. The
  // publish below applies the tint too, but on the throttled path that can be
  // up to 500ms later — long enough to see the card recolor without the button.
  applyHostTint();
  // Throttled like the level stepper: the picker overlay closes on the echoed
  // colour, so the leading edge keeps a deliberate pick feeling instant while a
  // flurry of picks still collapses to the last one.
  publishRoomStateSoon();
}

// Live rename from an already-registered controller (e.g. an AirConsole profile
// edit). Unlike SET_COLOR this is allowed in every state — including mid-game —
// because it only relabels the player and never touches game state.
function onSetName(fromId, msg) {
  if (!players.has(fromId)) return;
  var player = players.get(fromId);
  var prevName = player.playerName;
  // requestedAutoName is hardcoded false: SET_NAME always means "I have a real
  // name now". Honoring an autoName:true here would make sanitizePlayerName
  // discard the name and hand back an HX fallback — the opposite of a rename.
  // Empty/legacy names still resolve to an HX name via the !name branch.
  player.playerName = sanitizePlayerName(cleanInboundName(msg.name), fromId, false);
  if (player.playerName === prevName) return;
  updatePlayerList();
  publishRoomState();
}

function cleanupPlayerInput(clientId) {
  endSoftDrop(clientId);
}
