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

  party.onClose = function(attempt, maxAttempts, meta) {
    preCreatedRoom = null;
    clearTimeout(createTimeout);
    // We are out of the room until the relay answers the next create/join. Set
    // before the welcome-screen early-return: the sweep must be gated in every screen.
    joinedRoom = false;

    // The two TERMINAL closes, where PartyConnection has already stopped
    // reconnecting on its own. Neither can be waited out, so both are taken
    // before the reconnect overlay below — which is handed attempt 0 of 0, and so
    // would paint a counter that counts nothing while never reaching the
    // escalation that reveals its RECONNECT button: a dead end. tvOS and Android
    // split these two the same way (RelayClient#handleDrop on both).
    if (meta && meta.roomClosed) {
      // 4001: the ROOM is gone, not just this socket, so the pinned code is dead
      // and a rejoin would only bounce off "Room not found". resetToWelcome
      // unpins it (lastRoomCode/lastInstance) and creates a fresh one, which is
      // both what the native clients do and what the equivalent terminal relay
      // errors already do here (see onProtocol below).
      resetToWelcome();
      return;
    }
    if (meta && meta.replaced) {
      // 4000: another client claimed our slot. Terminal on purpose and with no
      // button — rejoining under the same clientId would just evict them right
      // back and start a takeover war. Nothing to report on the welcome screen,
      // where there is no session and New Game re-creates from scratch.
      if (currentScreen === SCREEN.WELCOME) return;
      clearTimeout(disconnectedTimer);
      cancelFadeHide(reconnectOverlay);
      reconnectOverlay.classList.remove('hidden');
      reconnectHeading.textContent = t('disconnected');
      reconnectStatus.textContent = '';
      reconnectBtn.classList.add('hidden');
      return;
    }
    // Welcome-screen pre-creates keep retrying silently until the user lands
    // on the lobby. From there a failed *create* (no room yet) and a lost room
    // both drive the same overlay: RECONNECTING with the attempt counter while
    // backoff runs, then DISCONNECTED + RECONNECT once attempts are exhausted.
    if (currentScreen === SCREEN.WELCOME) return;
    clearTimeout(disconnectedTimer);

    if (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN) {
      // Our link dying, not a host decision, so it must not reach controllers as
      // an actionable pause — connectionPause records that reason.
      connectionPause();
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
        publishAs('now');
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

  // Held for as long as the room exists, lobby included: a screensaver over the
  // lobby hides the QR and the room code, and on a display that gets no input of
  // its own that is a state the phones cannot recover from. Released only when
  // the room is torn down (resetToWelcome). Mirrors tvOS isIdleTimerDisabled and
  // Android FLAG_KEEP_SCREEN_ON, which hold for the same span.
  acquireWakeLock();
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
      roomCore.onSeen(pEntry[0], now);
    } else {
      disconnectedIds.push(pEntry[0]);
    }
  }
  // The whole reconciliation is ONE change: however many peers went missing, plus
  // the resume, collapse into a single publish at the end. Per-mutation publishes
  // would ship half-reconciled rosters, and — because the resume comes last — a
  // paused=true snapshot chased by a paused=false one, which is exactly how a
  // controller ends up stranded on a pause overlay whose Continue cannot work.
  // Floor 'now': this publish has to reach controllers even when nothing moved at
  // all, because it is also what clears their reconnect overlay and their
  // display-gone bail timer, and tells them the game is running again.
  publishBatch('now', function () {
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
    // Lifts ONLY a link-drop freeze: a blip that landed on top of a host's
    // manual pause leaves that pause standing, which is what tvOS and Android
    // do too now that the state machine is shared.
    connectionResume();
  });

  if (roomState === ROOM_STATE.LOBBY) {
    showScreen(SCREEN.LOBBY);
    updateStartButton();
    renderQR(qrCode, buildQRMatrix(joinUrl));
  }
}

function onPeerJoined(peerIndex) {
  // The room core allocates the colour slot, invents the placeholder auto-name, and
  // decides whether this joiner is a lobby member or a late joiner waiting out
  // the round. It refuses silently on a duplicate or a full room.
  var res = roomCore.peerJoined(peerIndex, Date.now());
  if (!res.added) return;

  if (res.joinedLobby) {
    updatePlayerList();
    updateStartButton();
  }
  publishAs(res.publish);
}

function onPeerLeft(peerIndex) {
  if (fastlane) fastlane.close(peerIndex);
  if (!players.has(peerIndex)) return;

  cleanupPlayerInput(peerIndex);

  // The room core owns the branch: mid-game an active participant keeps their row
  // (so the slot stays pinned for a reconnect via claimReconnect), while a late
  // joiner and anyone leaving in lobby/results is dropped outright, with the
  // sticky-host handoff and the empty-results return to lobby handled inside.
  var res = roomCore.peerLeft(peerIndex);
  if (!res.known) return;

  if (res.action === 'disconnected') {
    showDisconnectQR(peerIndex);
    checkAllPlayersDisconnected();
  } else {
    garbageIndicatorEffects.delete(peerIndex);
    garbageDefenceEffects.delete(peerIndex);
    if (roomState === ROOM_STATE.LOBBY) {
      updatePlayerList();
      updateStartButton();
    }
  }
  if (res.returnedToLobby) returnToLobbyUI();

  // The roster changed in every branch above: someone is gone, the host may
  // have moved to a present player, and a mid-game departure flips that
  // player's `alive` for the remaining boards. Publishing unconditionally also
  // covers the last-player-leaves case, where the snapshot must stop naming a
  // departed player (and a stale host) to the next peer that joins.
  publishAs(res.publish);
}

// =====================================================================
// QR Rejoin Claim Handling
// =====================================================================

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

// Finish a cross-device rejoin the room core has already accepted: everything keyed
// by peer index that lives OUTSIDE the room (input state, the QR canvases, the
// garbage effect maps, the engine's boards) moves from the old index to the new
// one. The room half (roster record, sticky host slot, participant order,
// alive flags, cached ranking) moved inside roomCore.claimReconnect.
function applyReconnectClaim(oldId, fromId) {
  cleanupPlayerInput(oldId);
  cleanupPlayerInput(fromId);
  transferMapEntry(garbageIndicatorEffects, oldId, fromId);
  transferMapEntry(garbageDefenceEffects, oldId, fromId);
  disconnectedQRs.delete(oldId);
  disconnectedQRs.delete(fromId);
  rekeyDisplayGamePlayer(oldId, fromId);
  calculateLayout();
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
// time, so the latest value always wins. Everything else publishes immediately.
//
// Which calls take which path is the room core's decision, not this file's: every
// mutator returns a `publish` hint of 'now', 'soon' or 'none', and tvOS and
// Android read the same hints. Only the timer is per-shell, because a timer
// needs a real clock and the room core has none.
var ROOM_STATE_THROTTLE_MS = window.GameEngine.RoomCore.SNAPSHOT_THROTTLE_MS;
var _publishTimer = null;
var _lastPublishAt = 0;

// Apply a mutator's publish hint. Keeps the three-way decision in one place so
// call sites read as "do the thing, then honour the hint".
// The hint vocabulary and their strength ordering both come from the room core,
// which is what decides which mutation earns which hint; tvOS and Android read
// the same two things off it (statically here, via roomGet on the bridges).
var PUBLISH = window.GameEngine.RoomCore.PUBLISH;
var HINT_RANK = window.GameEngine.RoomCore.PUBLISH_RANK;
// Non-null only while publishBatch's block is running: the hint the batch has
// accumulated so far. Doubles as the "are we batching" flag.
var _batchHint = null;

function publishAs(hint) {
  if (_batchHint !== null) {
    // Inside a batch: fold instead of publishing. Strongest wins.
    if (hintRank(hint) > hintRank(_batchHint)) _batchHint = hint;
    return;
  }
  if (hint === PUBLISH.NOW) publishRoomState();
  else if (hint === PUBLISH.SOON) publishRoomStateSoon();
}

// Unknown/absent hints rank as 'none', so a mutator that returns nothing can
// never strengthen a batch.
function hintRank(hint) {
  return HINT_RANK[hint] || 0;
}

// Run a group of room changes as ONE change: everything inside publishes once,
// when the block returns. Without it a rejoin dropping four peers, or an engine
// frame that KOs three players at once, publishes the whole room once per
// mutation — and every one but the last describes a half-finished state no
// controller should ever render.
//
// This sits here rather than in RoomCore on purpose. The block is a closure, and
// the native bridges are JSON-only (quickjs-kt has no call-with-arguments API),
// so a room-core version would need begin/end as two separate bridge calls —
// on Android two extra interpolated QuickJS evaluations per batch, i.e. ~120 a
// second just to open and close mostly-empty batches around each frame. The
// hints stay the room core's decision; only the folding is local, and publishAs
// is already the single point every publish goes through.
//
// `floor` is the weakest hint the group may end on. Omit it and a group that
// changed nothing stays silent, which is what makes wrapping the 60 Hz frame
// drain free; pass 'now' when the publish has to happen regardless. The publish
// runs from a finally, so a throw mid-block still ships what did change and can
// never leave the fold armed. tvOS and Android carry the same wrapper verbatim.
function publishBatch(floor, fn) {
  if (typeof floor === 'function') { fn = floor; floor = PUBLISH.NONE; }
  _batchHint = floor;
  try {
    fn();
  } finally {
    var hint = _batchHint;
    _batchHint = null;
    publishAs(hint);
  }
}

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
    // The snapshot itself is built by RoomCore, byte-identically on tvOS and
    // Android TV, which is the whole point of the module.
    party.setState(roomCore.snapshot());
  }
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
  roomCore.markDisconnected(peerIndex);
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
