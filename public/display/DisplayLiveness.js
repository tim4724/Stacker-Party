'use strict';

// =====================================================================
// Display Liveness — heartbeat monitoring for display and controllers
// Depends on: DisplayState.js (globals), DisplayConnection.js (showDisconnectQR),
//             DisplayGame.js (pauseGame, checkAllPlayersDisconnected,
//             returnToLobby)
// =====================================================================

function startLivenessCheck() {
  stopLivenessCheck();
  lastHeartbeatEcho = Date.now();
  heartbeatSent = false;
  livenessInterval = setInterval(function() {
    var now = Date.now();

    // Send heartbeat echo to self via relay. Stamp the send time so the
    // echo handler in DisplayConnection.js can compute relay RTT.
    lastHeartbeatSent = now;
    party.sendTo(0, { type: '_heartbeat' });

    // Check if our own connection is dead (no echo back within timeout).
    // Uses SELF_HEARTBEAT_DEAD_MS, not LIVENESS_TIMEOUT_MS: with fastlane the
    // WS carries only ~1 Hz traffic, so the self-loop is the lone canary and
    // needs a wider margin than the per-controller liveness check below.
    var displayDead = heartbeatSent && (now - lastHeartbeatEcho > GameConstants.SELF_HEARTBEAT_DEAD_MS);
    heartbeatSent = true;

    if (displayDead) {
      if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
        // Our own socket is silently dead — same category as onClose above.
        connectionPaused = true;
        if (!paused) pauseGame();
        // Cross-fade with the reconnect overlay appearing above (see onClose).
        fadeHide(pauseOverlay, 200);
      }
      // Don't overwrite DISCONNECTED state after attempts exhausted
      if (party.reconnectAttempt >= party.maxReconnectAttempts) return;
      // Show overlay once on first dead detection; don't overwrite
      // attempt text that onClose sets on subsequent ticks. A mid-dismissal
      // overlay (.closing, not yet .hidden) counts as hidden here — without
      // that, the pending fadeHide timer would hide the overlay this tick
      // just decided to show.
      if (reconnectOverlay.classList.contains('hidden') ||
          reconnectOverlay.classList.contains('closing')) {
        cancelFadeHide(reconnectOverlay);
        reconnectOverlay.classList.remove('hidden');
        reconnectHeading.textContent = t('reconnecting');
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

    // Our link dropped and the rejoin hasn't landed: the relay routes nothing to
    // us, so every controller looks silent through no fault of its own. The
    // displayDead check above is NOT sufficient cover — it needs
    // SELF_HEARTBEAT_DEAD_MS (6s) of self-echo silence while a controller expires
    // after LIVENESS_TIMEOUT_MS (3s), leaving a window that flagged the whole
    // roster, raised rejoin QRs, and (via checkAllPlayersDisconnected, with a
    // late joiner waiting) could grace-return a live match to the lobby.
    // Restored by 'created'/'joined' — see joinedRoom. The heartbeat above still
    // runs, so the display's own reconnect detection is unaffected.
    if (!joinedRoom) return;

    // Check individual controller liveness. brain.expiredPeers already applies
    // the state!==LOBBY + not-already-disconnected gates and the AirConsole
    // no-op (its enabledProvider closure), so the SDK's onDisconnect
    // (→ peer_left → onPeerLeft) becomes the only disconnect trigger there.
    var newDisconnect = false;
    var expired = brain.expiredPeers(now);
    for (const id of expired) {
      showDisconnectQR(id);
      newDisconnect = true;
    }
    if (newDisconnect) {
      checkAllPlayersDisconnected();
      // A silent heartbeat timeout can take out the host — republish so the
      // handoff reaches the remaining controllers' isHost flags.
      publishRoomState();
    }
    // Poll the flow-owned late-joiner grace deadline (armed by
    // checkAllPlayersDisconnected on the event path). Replaces the old
    // setTimeout: fires within one tick of the 5s window elapsing, and
    // graceTick re-checks all-disconnected so a reconnect can't strand us. A
    // no-op if the event path already fired between ticks (deadline cleared).
    if (brain.graceTick(now)) returnToLobby();
  }, 1000);
}

function stopLivenessCheck() {
  if (livenessInterval) {
    clearInterval(livenessInterval);
    livenessInterval = null;
  }
}
