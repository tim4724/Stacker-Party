'use strict';

// =====================================================================
// Display Connection — PartyConnection lifecycle, peer management, QR helpers
// Depends on: DisplayState.js (globals), DisplayGame.js (pauseGame, resumeGame, etc.)
// Called by: display.js (handleControllerMessage dispatches here)
// See also: DisplayLiveness.js (heartbeat monitoring, extracted)
// =====================================================================


// A socket can upgrade fine but leave `create` unanswered (wedged relay shard).
// onclose never fires, so an explicit deadline is the only canary during the
// create window (the self-heartbeat only starts after `created`). The native
// ports use 6s (RelayConfig.HANDSHAKE_TIMEOUT_MS) and arm it for `join` too;
// here it guards only the fresh create, where a slow first connect is more
// likely and a bit more slack costs nothing.
var CREATE_TIMEOUT_MS = 8000;
var createTimeout = null;

// Arm the silent-socket deadline for a fresh create. Join/reconnect (lastRoomCode
// set) rides PartyConnection's own onclose backoff, and AirConsole has no relay
// socket to time out — both skip it.
function armCreateTimeout() {
  clearTimeout(createTimeout);
  if (lastRoomCode || window.airconsole) return;
  createTimeout = setTimeout(function() {
    if (party && !roomCode) party.failAttempt();
  }, CREATE_TIMEOUT_MS);
}

function connectAndCreateRoom() {
  if (party) party.close();
  clearTimeout(createTimeout);
  if (fastlane) { fastlane.closeAll(); fastlane = null; }

  // If we already know the instance (reconnect path), open the WS on the
  // sharded URL so the relay routes us back to the same instance. Fresh
  // creates use the bare URL — the relay picks an instance and tells us
  // which one in the `created` reply.
  var initialUrl = (lastRoomCode && lastInstance)
    ? RELAY_URL + '/' + encodeURIComponent(lastRoomCode) + '?instance=' + encodeURIComponent(lastInstance)
    : RELAY_URL;
  // The display's clientId acts as a per-slot bearer secret on reconnect.
  // 'display' is a stable string the relay matches to slot 0 across reloads.
  // It never crosses the wire to peers — peers see only numeric indices.
  party = new PartyConnection(initialUrl, { clientId: 'display' });

  // Display is always slot 0. Controllers initiate the SDP/ICE handshake on
  // join; the display only needs to auto-accept inbound offers and forward
  // received DataChannel messages to handleControllerMessage. Skipped in
  // AirConsole mode (no WS to piggyback on) or when ?fastlane=0 is set
  // (debug toggle for A/B comparison; controllers honor the same flag).
  var fastlaneEnabled = new URLSearchParams(location.search).get('fastlane') !== '0';
  if (fastlaneEnabled && typeof PartyFastlane !== 'undefined' && !window.airconsole) {
    fastlane = new PartyFastlane({
      // Symmetric ICE config with the controller (both sides need to know
      // about the same STUN server for cross-network handshakes to work).
      iceServers: [{ urls: STUN_URL }],
      selfIndex: 0,
      sendSignal: function (toIdx, data) { if (party) party.sendTo(toIdx, data); },
      onInput: function (fromIdx, data) { handleControllerMessage(fromIdx, data); },
    });
  }

  party.onOpen = function() {
    if (lastRoomCode) {
      party.join(lastRoomCode);
    } else {
      party.create(9, controllerUrlTemplate());
      armCreateTimeout();
    }
  };

  party.onClose = function(attempt, maxAttempts) {
    preCreatedRoom = null;
    clearTimeout(createTimeout);
    // We are out of the room until the relay answers the next create/join. Set
    // before the welcome-screen early-return: the sweep must be gated in every screen.
    joinedRoom = false;
    // Welcome-screen pre-creates keep retrying silently until the user lands
    // on the lobby. From there a failed *create* (no room yet) and a lost room
    // both drive the same overlay: RECONNECTING with the attempt counter while
    // backoff runs, then DISCONNECTED + RECONNECT once attempts are exhausted.
    if (currentScreen === SCREEN.WELCOME) return;
    clearTimeout(disconnectedTimer);

    if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
      // Mark WHY before pausing: this is our link dying, not a host decision, so
      // it must not reach controllers as an actionable pause (see userVisiblePaused).
      connectionPaused = true;
      if (!paused) pauseGame();
      // Cross-fade: the pause scrim fades out under the reconnect overlay
      // fading in, instead of flashing the boards between the two.
      fadeHide(pauseOverlay, 200);
    }

    cancelFadeHide(reconnectOverlay);
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
        relayRegion = msg.region || null;
        updateRelayChip();
        onRoomCreated(msg.room, msg.instance);
        break;
      case 'joined':
        onDisplayRejoined(msg.room, msg.peers);
        break;
      case 'peer_joined':
        onPeerJoined(msg.index);
        break;
      case 'peer_left':
        onPeerLeft(msg.index);
        break;
      case 'master_changed':
        // AirConsole re-picked the master controller (e.g. premium upgrade).
        // Fires in any room state by design: menu-gate checks query the host
        // live at message time, but controllers' isHost flags for their lobby /
        // results banners only refresh from the snapshot. A mid-game onPremium
        // is intentional — we always follow what getMasterPeerIndex dictates.
        publishRoomState();
        break;
      case 'error':
        if (!lastRoomCode) {
          // Relay rejected the create (bad url template, server error, etc.).
          // Fail this attempt so it retries with backoff via the reconnect
          // overlay — "Room not found"/"Room is full" only apply to join below.
          console.warn('Party-Server (create):', msg.message);
          if (party) party.failAttempt();
        } else if (msg.message === 'Room not found' || msg.message === 'Room is full') {
          console.error('Party-Server error:', msg.message);
          resetToWelcome();
        } else {
          console.warn('Party-Server:', msg.message);
        }
        break;
    }
  };

  party.onMessage = function(from, data) {
    // Intercept RTC signaling envelopes for the optional fastlane before app
    // dispatch. handleSignal returns true iff the message was an __rtc one.
    if (fastlane && fastlane.handleSignal(from, data)) return;
    if (from === 0 && data && data.type === '_heartbeat') {
      lastHeartbeatEcho = Date.now();
      if (lastHeartbeatSent) {
        var rtt = lastHeartbeatEcho - lastHeartbeatSent;
        lastRelayRtt = rtt;
        consecutiveBadRtt = (rtt > RELAY_RTT_OK_MS) ? consecutiveBadRtt + 1 : 0;
        updateRelayChip();
      }
      return;
    }
    handleControllerMessage(from, data);
  };

  party.connect();
}

// =====================================================================
// Party-Server Protocol Handlers
// =====================================================================

function onRoomCreated(partyRoomCode, instance) {
  // The relay put us in a room (fresh, or the room-gone recovery path), so the
  // liveness sweep can run again. A fresh room has an empty roster, so there is
  // nothing to re-stamp — unlike the rejoin path below.
  joinedRoom = true;
  // A create can succeed after earlier attempts failed, which would have put
  // the reconnect overlay up (RECONNECTING / DISCONNECTED). Clear it and reset
  // the backoff counter so a later lost room starts counting from attempt 1.
  clearTimeout(createTimeout);
  clearTimeout(disconnectedTimer);
  fadeHide(reconnectOverlay, 200);
  if (party) party.resetReconnectCount();
  lastInstance = instance || null;
  // Pin the WS URL so PartyConnection's auto-reconnect lands on the same
  // instance (the relay's bare endpoint would otherwise route to whichever
  // shard is currently least-loaded). The kit owns the sharded-URL shape.
  if (party && lastInstance) {
    party.pinInstance(RELAY_URL, partyRoomCode, lastInstance);
  }

  // Stash the instance in the URL fragment so it never hits the server in
  // requests/logs/CDN caches; the controller reads it from location.hash and
  // expands back to ?instance= when talking to the relay.
  var newJoinUrl = getBaseUrl() + '/' + partyRoomCode + (lastInstance ? '#' + encodeURIComponent(lastInstance) : '');

  // If still on welcome screen, cache the room for instant use later
  if (currentScreen === SCREEN.WELCOME) {
    preCreatedRoom = { roomCode: partyRoomCode, joinUrl: newJoinUrl };
    return;
  }

  applyRoomCreated(partyRoomCode, newJoinUrl);
}

var _copyTimer = null;

// Render the join URL into the two-span pill (small host + big room code).
// Called from both applyRoomCreated and onDisplayRejoined so the structure
// is preserved after a reconnect.
function renderJoinUrl(url) {
  // Load fade (tvOS/Android parity): a rejoin can land in a fresh room and
  // swap the code in place — fade the line instead of popping. The first
  // render stays instant (the lobby entrance carries it).
  if (joinUrlEl.dataset.joinUrl && joinUrlEl.dataset.joinUrl !== url) {
    joinUrlEl.classList.remove('qr-swap');
    void joinUrlEl.offsetWidth;   // restart the animation
    joinUrlEl.classList.add('qr-swap');
  }
  joinUrlEl.dataset.joinUrl = url;
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
    joinUrlEl.setAttribute('aria-label', t('copy_url'));
    var showCopiedToast = function() {
      var copiedLabel = t('copied') || 'Copied';
      // Pin the URL while the toast is up so the user sees what landed
      // in their clipboard (the hint cycle also skips data-copied ticks).
      var jl = document.getElementById('join-line');
      if (jl) jl.classList.remove('show-hint');
      joinUrlEl.setAttribute('data-copied-label', copiedLabel);
      joinUrlEl.setAttribute('data-copied', '1');
      // Reflect the success state for screen readers — the ::after toast
      // is purely visual, so aria-label is the only cue they see.
      joinUrlEl.setAttribute('aria-label', copiedLabel);
      clearTimeout(_copyTimer);
      _copyTimer = setTimeout(function() {
        joinUrlEl.removeAttribute('data-copied');
        joinUrlEl.setAttribute('aria-label', t('copy_url'));
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

    // Alternate the join line between the URL and the localized "scan to
    // join" hint. Starts on the URL so the address is the first thing a
    // player can act on; holds the URL while the copied toast is visible.
    var joinLineEl = document.getElementById('join-line');
    if (joinLineEl) {
      setInterval(function() {
        if (joinUrlEl.hasAttribute('data-copied')) {
          joinLineEl.classList.remove('show-hint');
          return;
        }
        joinLineEl.classList.toggle('show-hint');
      }, 4500);
    }
  }

  // Reset local state
  resetRoomData();

  showScreen(SCREEN.LOBBY);
  updateStartButton();
  startLivenessCheck();

  // Generate + paint the QR synchronously so it's on screen the instant the
  // lobby is revealed — reading the canvas box inside renderQR forces the one
  // layout it needs, so there's no blank first frame. Generation is a sub-ms
  // in-browser encode, so there's nothing worth deferring.
  renderQR(qrCode, buildQRMatrix(joinUrl));
}

function onDisplayRejoined(partyRoomCode, peers) {
  // Display reconnected to existing room — resync state
  roomCode = partyRoomCode;
  lastRoomCode = partyRoomCode;

  joinUrl = getBaseUrl() + '/' + roomCode + (lastInstance ? '#' + encodeURIComponent(lastInstance) : '');
  renderJoinUrl(joinUrl);

  // Reset liveness for peers still in the room; handle missing ones.
  // peers is the relay's list of other-peer indices (excludes self, i.e. 0).
  var now = Date.now();
  var connectedSet = new Set(peers || []);
  var disconnectedIds = [];
  for (const pEntry of players) {
    if (connectedSet.has(pEntry[0])) {
      flow.onSeen(pEntry[0], now);
    } else {
      disconnectedIds.push(pEntry[0]);
    }
  }
  for (var i = 0; i < disconnectedIds.length; i++) {
    onPeerLeft(disconnectedIds[i]);
  }

  // Only now, with the roster reconciled and the survivors re-stamped above, is
  // the sweep safe to re-arm. Gating on the socket instead would reopen the hole
  // this closes: the socket comes back ~1s into a drop but the relay routes
  // nothing to us until this reply, so a slow `joined` would expire the roster
  // (LIVENESS_TIMEOUT_MS is 3s; displayDead alone doesn't bite until 6s).
  // Mirrors tvOS roomLinkRestored / Android handleJoined.
  joinedRoom = true;

  startLivenessCheck();

  // Clear reconnect overlay — connection restored
  clearTimeout(disconnectedTimer);
  party.resetReconnectCount();
  fadeHide(reconnectOverlay, 200);
  if (paused && (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)) {
    // Clear any surviving countdown timers to prevent duplicates on resume
    clearCountdownTimers();
    resumeGame();
  }

  // Republish so every controller sees a fresh snapshot: it is what clears
  // their reconnect overlay and their display-gone bail timer, and (after the
  // resume above) what tells them the game is running again.
  publishRoomState();

  if (roomState === ROOM_STATE.LOBBY) {
    showScreen(SCREEN.LOBBY);
    updateStartButton();
    renderQR(qrCode, buildQRMatrix(joinUrl));
  }
}

function onPeerJoined(peerIndex) {
  if (players.has(peerIndex)) return;
  if (players.size >= GameConstants.MAX_PLAYERS) return;

  var index = nextAvailableSlot();
  if (index < 0) return;

  // flow.addPlayer assigns joinedAt + connected and makes the first joiner the
  // sticky host. The game fields (name, color slot, level, ping) ride along on
  // the same record; the kit never reads them.
  //
  // helloSeen: false marks this a placeholder. The relay hands us peer_joined
  // before the controller's HELLO, so the name and colour here are our guesses,
  // not the player's. Other controllers still need the row (it claims a palette
  // slot), but the joiner's own controller must not render a guessed identity
  // and then visibly correct itself a round trip later.
  flow.addPlayer(peerIndex, {
    playerName: generateAutoPlayerName(peerIndex),
    playerIndex: index,
    startLevel: 1,
    helloSeen: false
  });
  flow.onSeen(peerIndex, Date.now());

  // Only add to playerOrder in lobby — late joiners wait for next game.
  // playerOrder is snapshotted at game start by runGameLocally().
  if (roomState === ROOM_STATE.LOBBY) {
    playerOrder.push(peerIndex);
    updatePlayerList();
    updateStartButton();
  }
  // The roster changed: a palette slot is claimed and (in an empty room) the
  // host moved. The joiner's own HELLO republishes a moment later, but the
  // other controllers' pickers must not wait for it.
  publishRoomState();
}

function onPeerLeft(peerIndex) {
  if (fastlane) fastlane.close(peerIndex);
  if (!players.has(peerIndex)) return;

  cleanupPlayerInput(peerIndex);

  // Sticky-host handoff is owned by RoomFlow: flow.removePlayer re-elects only
  // when the player leaves in LOBBY/RESULTS. Mid-game (PLAYING/COUNTDOWN) the
  // participant stays in the roster (flagged disconnected via showDisconnectQR
  // -> flow.markDisconnected) so the slot stays pinned and a reconnect via
  // claimReconnectPeer (flow.rekey) reclaims it; flow's host fallback elects a
  // present player for any host action needed during the blip.
  if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
    if (playerOrder.indexOf(peerIndex) >= 0) {
      // Active game participant — keep in Map for seamless reconnect
      showDisconnectQR(peerIndex);
      checkAllPlayersDisconnected();
    } else {
      // Late joiner (never in the game) — remove silently
      flow.removePlayer(peerIndex);
      garbageIndicatorEffects.delete(peerIndex);
      garbageDefenceEffects.delete(peerIndex);
    }
  } else if (roomState === ROOM_STATE.LOBBY) {
    removeLobbyPlayer(peerIndex);
  } else if (roomState === ROOM_STATE.RESULTS) {
    flow.removePlayer(peerIndex);
    var idx = playerOrder.indexOf(peerIndex);
    if (idx !== -1) playerOrder.splice(idx, 1);
    flow.setActiveOrder(playerOrder);
    garbageIndicatorEffects.delete(peerIndex);
    garbageDefenceEffects.delete(peerIndex);
    // Return to lobby when no game participants remain (late joiners don't count)
    var hasParticipants = false;
    for (var i = 0; i < playerOrder.length; i++) {
      if (players.has(playerOrder[i])) { hasParticipants = true; break; }
    }
    if (!hasParticipants) {
      lastResults = null;
      setRoomState(ROOM_STATE.LOBBY);
      returnToLobbyUI();
    }
  }

  // The roster changed in every branch above: someone is gone, the host may
  // have moved to a present player, and a mid-game departure flips that
  // player's `alive` for the remaining boards. Publishing unconditionally also
  // covers the last-player-leaves case, where the snapshot must stop naming a
  // departed player (and a stale host) to the next peer that joins.
  publishRoomState();
}

function removeLobbyPlayer(peerIndex) {
  flow.removePlayer(peerIndex);
  playerOrder = playerOrder.filter(function(id) { return id !== peerIndex; });
  garbageIndicatorEffects.delete(peerIndex);
  garbageDefenceEffects.delete(peerIndex);
  updatePlayerList();
  updateStartButton();
}

// =====================================================================
// QR Rejoin Claim Handling
// =====================================================================

function normalizePeerIndex(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  var n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function rekeyMapPreservingOrder(map, oldId, newId, mutateValue) {
  if (!map || !map.has(oldId)) return;
  var next = new Map();
  for (const entry of map) {
    var key = entry[0];
    var value = entry[1];
    if (key === oldId) {
      if (mutateValue) mutateValue(value);
      next.set(newId, value);
    } else {
      next.set(key, value);
    }
  }
  map.clear();
  for (const nextEntry of next) map.set(nextEntry[0], nextEntry[1]);
}

function rekeyDisplayGamePlayer(oldId, newId) {
  if (!displayGame) return;

  rekeyMapPreservingOrder(displayGame.boards, oldId, newId, function(board) {
    board.playerId = newId;
  });

  if (Array.isArray(displayGame.playerIds)) {
    for (var i = 0; i < displayGame.playerIds.length; i++) {
      if (displayGame.playerIds[i] === oldId) displayGame.playerIds[i] = newId;
    }
  }

  // Move the hard-drop cooldown too, matching the engine's canonical
  // Game.rekeyPlayer (server/Game.js) that the native ports call — otherwise a
  // queued hard-drop right after a same-game reconnect behaves differently on
  // web vs TV.
  var cd = displayGame._hardDropCooldownMs;
  if (cd && cd.has(oldId)) { cd.set(newId, cd.get(oldId)); cd.delete(oldId); }

  var gm = displayGame.garbageManager;
  if (!gm) return;

  gm.rekeyPlayer(oldId, newId);
}

function transferMapEntry(map, oldId, newId) {
  if (!map || !map.has(oldId)) return;
  var value = map.get(oldId);
  map.delete(oldId);
  map.set(newId, value);
}

function claimReconnectPeer(fromId, msg) {
  var token = msg && msg.rejoinToken;
  var oldId = normalizePeerIndex(token);
  if (oldId == null && msg && msg.rejoinId != null) oldId = normalizePeerIndex(msg.rejoinId);
  if (oldId == null || oldId === fromId) return false;
  if (!players.has(oldId) || !disconnectedQRs.has(oldId)) return false;
  if (playerOrder.indexOf(oldId) < 0) return false;
  // An active participant can't claim another board: rekeying onto an id that
  // already owns a board would silently drop one of the two in the Map rebuild.
  // A genuine cross-device rejoin always arrives under a FRESH peer index.
  if (playerOrder.indexOf(fromId) >= 0) return false;

  cleanupPlayerInput(oldId);
  cleanupPlayerInput(fromId);

  // flow.rekey moves the kept record from oldId to fromId (dropping the
  // placeholder slot fromId got when it joined), and reclaims the sticky host
  // slot, participant order, and last-seen stamp for the returning peer. The
  // game-side arrays below (playerOrder, alive state, garbage effects, game
  // boards) are rekeyed alongside it.
  flow.rekey(oldId, fromId);
  flow.onSeen(fromId, Date.now());

  for (var i = 0; i < playerOrder.length; i++) {
    if (playerOrder[i] === oldId) playerOrder[i] = fromId;
  }

  if (lastAliveState[oldId] !== undefined) {
    lastAliveState[fromId] = lastAliveState[oldId];
    delete lastAliveState[oldId];
  }
  // Remap the cached ranking too: a claim on the RESULTS screen replays
  // lastResults in the snapshot, and the returning controller matches its own
  // row by playerId.
  if (lastResults && Array.isArray(lastResults.results)) {
    for (var li = 0; li < lastResults.results.length; li++) {
      if (lastResults.results[li].playerId === oldId) lastResults.results[li].playerId = fromId;
    }
  }
  transferMapEntry(garbageIndicatorEffects, oldId, fromId);
  transferMapEntry(garbageDefenceEffects, oldId, fromId);
  disconnectedQRs.delete(oldId);
  disconnectedQRs.delete(fromId);
  rekeyDisplayGamePlayer(oldId, fromId);
  calculateLayout();
  return true;
}

// =====================================================================
// Retained Room Snapshot
// =====================================================================

// Rapid, self-correcting roster churn: the +/- level stepper and the colour
// rose. Both are finger-speed controls where only the final value matters, so
// they publish through here instead of directly. Leading + trailing: the first
// change after a quiet period goes out immediately (the picker overlay closes
// on the display's echo, so it must not feel laggy), and everything inside the
// window collapses into one trailing publish that reads live state at fire
// time — the latest value always wins. Everything else publishes immediately.
var ROOM_STATE_THROTTLE_MS = 500;
var _publishTimer = null;
var _lastPublishAt = 0;

function publishRoomStateSoon() {
  if (_publishTimer) return;
  var elapsed = Date.now() - _lastPublishAt;
  if (elapsed >= ROOM_STATE_THROTTLE_MS) {
    publishRoomState();
    return;
  }
  _publishTimer = setTimeout(function() {
    _publishTimer = null;
    publishRoomState();
  }, ROOM_STATE_THROTTLE_MS - elapsed);
}

// Publish now, superseding any pending throttled publish. This is the ONLY
// thing the display tells controllers about the room: the relay pushes the
// snapshot live to everyone connected AND replays it to a (re)joining peer
// right after `joined`, so the live-update path and the resync-after-a-blip
// path are the same code and cannot disagree with each other.
function publishRoomState() {
  if (_publishTimer) { clearTimeout(_publishTimer); _publishTimer = null; }
  _lastPublishAt = Date.now();
  applyHostTint();
  if (party && typeof party.setState === 'function') {
    party.setState(buildRoomSnapshot());
  }
}

// Everything a controller renders, in one object — identity, roster, host,
// room state, pause, liveness and the final ranking. Controllers derive their
// whole UI from this, screen routing included (see the controller's onState),
// so there is no second message left that could drift out of sync with it.
// Tiny: well under 2 KiB even for a full 9-player room sitting on results,
// against the relay's 16 KiB retained-state cap.
function buildRoomSnapshot() {
  var roster = {};
  for (const entry of players) {
    var p = entry[1];
    roster[entry[0]] = {
      name: p.playerName,
      color: p.playerIndex,
      startLevel: p.startLevel || 1,
      alive: lastAliveState[entry[0]] !== false,
      // False until this player's HELLO lands — see onPeerJoined. Their own
      // controller waits for it before rendering itself; everyone else reads
      // the row regardless, so the palette slot is claimed immediately.
      helloSeen: p.helloSeen !== false
    };
  }
  var snap = {
    roomState: roomState,
    hostPeerIndex: getHostPeerIndex(),
    // Only a host-pressed pause reaches controllers — an auto- or connection
    // pause is display-internal and un-dismissable from there. See
    // userVisiblePaused().
    paused: userVisiblePaused(),
    displayMuted: !!muted,
    // Who is actually in the running game. A player in the roster but absent
    // here during playing/countdown joined late and waits out the round.
    participants: playerOrder.slice(),
    players: roster
  };
  if (roomState === ROOM_STATE.RESULTS && lastResults) snap.results = lastResults.results;
  return snap;
}

// =====================================================================
// QR Code Helpers
// =====================================================================

function getBaseUrl() {
  return baseUrlOverride || window.location.origin;
}

// Controller-URL template registered with the relay on room create. The relay
// fills {room}/{instance} and hands the result to anyone holding only the
// room code (native shells via GET /room/:code, controllers in `joined`), so
// a code-only join can still resolve which page to load. Mirrors the QR join
// URL shape: instance in the fragment, kept out of request logs. The relay
// accepts only absolute https templates and rejects the whole create on an
// invalid one, so plain-http origins (local dev, e2e) register none.
function controllerUrlTemplate() {
  var base = getBaseUrl().replace(/\/+$/, '');
  if (base.indexOf('https://') !== 0) return undefined;
  return base + '/{room}#{instance}';
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

// Build the join-QR module matrix in-browser via the vendored qrcode-generator
// (EC level L, 1-module quiet zone — same shape the server used to return over
// /api/qr). Returns { size, modules } where modules[row*size+col] & 1 is a dark
// module, or null on failure so callers/renderQR degrade to a blank QR. The
// AirConsole entry overrides this to null (players join via the AC app, not a scan).
function buildQRMatrix(text) {
  try {
    var qr = qrcode(0, 'L'); // typeNumber 0 = smallest version that fits
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    var quiet = 1;
    var size = count + quiet * 2;
    var modules = new Array(size * size).fill(0);
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (qr.isDark(row, col)) modules[(row + quiet) * size + (col + quiet)] = 1;
      }
    }
    return { size: size, modules: modules };
  } catch (e) {
    return null;
  }
}

function showDisconnectQR(peerIndex) {
  disconnectedQRs.set(peerIndex, null);
  // INVARIANT: disconnectedQRs (presence flag + QR canvas, for rendering) and
  // flow's presence set must move together. Every site that adds/clears a
  // disconnect must touch BOTH — markDisconnected/markReconnected/clearDisconnected
  // here, and rekey() clears flow's flag on a cross-device claim. If they drift,
  // host election (which reads flow) skips a present player.
  flow.markDisconnected(peerIndex);
  if (!joinUrl) return;
  // Splice the claim in before the fragment so the instance hash stays intact.
  var hashIdx = joinUrl.indexOf('#');
  var base = hashIdx >= 0 ? joinUrl.slice(0, hashIdx) : joinUrl;
  var hash = hashIdx >= 0 ? joinUrl.slice(hashIdx) : '';
  var sep = base.indexOf('?') >= 0 ? '&' : '?';
  var rejoinUrl = base + sep + 'claim=' + encodeURIComponent(peerIndex) + hash;
  var qrMatrix = buildQRMatrix(rejoinUrl);
  if (!qrMatrix) {
    disconnectedQRs.set(peerIndex, null);
    return;
  }
  var offscreen = document.createElement('canvas');
  renderQR(offscreen, qrMatrix, 512);
  disconnectedQRs.set(peerIndex, offscreen);
}

// renderQR() lives in DisplayUI.js (rendering helper)
