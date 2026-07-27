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
    if (wasDisconnected) brain.markReconnected(fromId);
    brain.onSeen(fromId, Date.now());

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

function onHello(fromId, msg) {
  // Everything a HELLO decides lives in the brain: the name (sanitized, with
  // empty and legacy P1-P8 submissions resolving to room-unique HX names), the
  // preferred colour (honoured right away, so the snapshot below already names
  // the colour the controller will keep, with no round trip through its own
  // reclaimPreferredColor), whether a cross-device rejoin claim is valid, and
  // whether the room is full.
  var res = brain.hello(fromId, msg, Date.now());

  // The room half of a claim moved inside; the game half is ours.
  if (res.claimed) applyReconnectClaim(res.oldPeerIndex, fromId);

  if (!res.accepted) {
    if (res.roomFull) party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
    return;
  }

  if (!res.isNew || roomState === ROOM_STATE.LOBBY) updatePlayerList();
  if (res.isNew && roomState === ROOM_STATE.LOBBY) updateStartButton();

  // One publish settles everything a HELLO can move: this controller's own
  // identity (name, colour, level), the roster the others render, and the host,
  // since a reconnecting ex-host reclaims the role their pinned slot held
  // through the disconnect (or, in AirConsole mode, whatever getMasterPeerIndex
  // now dictates), so the temp host's Return-to-lobby button switches off in the
  // same update. A brand-new joiner needs it too: it is how they learn who they
  // are and which screen to show.
  publishAs(res.publish);
  if (res.claimed && autoPaused) checkAutoResume();
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
  // Held-finger control: the brain's 'soon' hint routes this through the 500ms
  // throttle, so a burst of +/- taps collapses to at most ~2 publishes per
  // second and the trailing one always carries the final level. Outside the
  // lobby the stepper is unreachable and the hint is 'none'.
  var res = brain.setLevel(fromId, msg.level);
  if (!res.changed) return;
  if (roomState === ROOM_STATE.LOBBY) updatePlayerList();
  publishAs(res.publish);
}

// Re-claim a palette slot. The brain silently rejects collisions so concurrent
// picks don't spam the sender with errors; the next snapshot carries the truth.
function onSetColor(fromId, msg) {
  var res = brain.setColor(fromId, msg.colorIndex);
  if (!res.changed) return;
  updatePlayerList();
  // Retint the host-tinted CTAs in the same paint as the roster card. The
  // publish below applies the tint too, but on the throttled path that can be
  // up to 500ms later, long enough to see the card recolor without the button.
  applyHostTint();
  publishAs(res.publish);
}

// Live rename from an already-registered controller (e.g. an AirConsole profile
// edit). Unlike SET_COLOR this is allowed in every state, including mid-game,
// because it only relabels the player and never touches game state.
function onSetName(fromId, msg) {
  var res = brain.setName(fromId, msg.name);
  if (!res.changed) return;
  updatePlayerList();
  publishAs(res.publish);
}

function cleanupPlayerInput(clientId) {
  endSoftDrop(clientId);
}
