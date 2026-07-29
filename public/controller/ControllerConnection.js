'use strict';

// =====================================================================
// Controller Connection — PartyConnection lifecycle, ping/pong
// Depends on: ControllerState.js (globals)
// Called by: controller.js (init, event handlers)
// =====================================================================

// Auto-reopen the fastlane after a watchdog teardown or any other
// channel-closed event while the WS is still alive. Without this, a
// transient WiFi blip that kills the fastlane silently leaves inputs on
// the WS for the rest of the session. Backs off exponentially up to 30 s;
// onPeerReady resets the delay so a clean reconnect doesn't carry stale
// backoff into the next failure.
var _fastlaneRetryTimer = null;
var _fastlaneRetryDelay = 0;

function scheduleFastlaneReopen() {
  if (gameCancelled) return;
  if (_fastlaneRetryTimer) return;
  _fastlaneRetryDelay = _fastlaneRetryDelay ? Math.min(_fastlaneRetryDelay * 2, 30000) : 2000;
  _fastlaneRetryTimer = setTimeout(function () {
    _fastlaneRetryTimer = null;
    if (gameCancelled || peerIndex == null || !party || !fastlane) return;
    fastlane.open(0).catch(function () {
      // open() can reject when no DataChannel established within the ICE
      // window; onPeerClosed will fire again and re-arm the next retry.
    });
  }, _fastlaneRetryDelay);
}

function cancelFastlaneReopen() {
  if (_fastlaneRetryTimer) {
    clearTimeout(_fastlaneRetryTimer);
    _fastlaneRetryTimer = null;
  }
  _fastlaneRetryDelay = 0;
}

// Send the user to the display root on any unrecoverable end state.
// `?bail=<key>` carries optional context for the display's mobile
// overlay toast. `keepClientId=true` is used by the tab-replacement
// path: the newer tab is still using that localStorage entry as its
// auto-reconnect anchor, so we mustn't clear it.
function bailToWelcome(toastKey, keepClientId) {
  if (gameCancelled) return;
  gameCancelled = true;
  stopPing();
  cancelFastlaneReopen();
  if (fastlane) { fastlane.closeAll(); fastlane = null; }
  if (party) { party.close(); party = null; }
  if (!keepClientId) {
    try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* iframe sandbox */ }
  }
  location.replace(toastKey ? '/?bail=' + encodeURIComponent(toastKey) : '/');
}

function connect() {
  // Gallery iframes load with ?scenario=; never open a real relay socket
  // for those, even if localStorage somehow holds a stored clientId for
  // room "GALLERY". Visual tests use ?test=1 alone and still need connect().
  if (new URLSearchParams(location.search).get('scenario')) return;

  if (party) party.close();
  // closeAll fires onPeerClosed for any open peer → would schedule a retry.
  // Drop the fastlane first, then cancel any retry that just got scheduled.
  if (fastlane) { fastlane.closeAll(); fastlane = null; }
  cancelFastlaneReopen();

  // Path-routed WS so the relay can pin us to the instance the room lives on.
  var relayUrl = RELAY_URL + '/' + encodeURIComponent(roomCode)
    + (instanceId ? '?instance=' + encodeURIComponent(instanceId) : '');
  party = new PartyConnection(relayUrl, { clientId: clientId });

  // Open a P2P DataChannel fastlane to the display (always slot 0) for
  // latency-sensitive input messages. The signaling envelopes ride on the
  // existing PartyConnection via party.sendTo. Skipped in AirConsole mode
  // (window.airconsole is set there and PartyConnection is replaced by
  // AirConsoleAdapter, which doesn't have a WS to piggyback on).
  // Also skipped when ?fastlane=0 is set — a debug toggle for A/B comparing
  // fastlane vs. pure-WS input latency from the same device.
  var fastlaneEnabled = new URLSearchParams(location.search).get('fastlane') !== '0';
  if (fastlaneEnabled && typeof PartyFastlane !== 'undefined' && !window.airconsole) {
    fastlane = new PartyFastlane({
      // First-party STUN — self-hosted on the same infra as hexstacker.com,
      // declared in protocol.js so both sides agree. Lets WebRTC gather
      // server-reflexive candidates for cross-network play; for same-LAN play
      // host candidates still win.
      iceServers: [{ urls: STUN_URL }],
      sendSignal: function (toIdx, data) { if (party) party.sendTo(toIdx, data); },
      // No onInput: the display only sends acks back over fastlane, never
      // data packets, so onInput would never fire on the controller side.
      // Sender role: emit idle heartbeats so the RTT chip stays live when
      // there are no inputs flowing (lobby, between pieces). The display
      // doesn't reciprocate — it only emits acks in response to data.
      emitIdleHeartbeat: true,
      // onRtt fires on every inbound ack, carrying smoothed one-way latency
      // (srtt/2). Reuses updateLatencyDisplay, which also handles the bolt
      // icon visibility based on fastlane.isOpen.
      onRtt: function (peerIdx, rttHalf) {
        if (peerIdx === 0) updateLatencyDisplay(Math.round(rttHalf));
      },
      // Clean reconnect → reset backoff so the next failure starts fresh.
      onPeerReady: function (peerIdx) {
        if (peerIdx === 0) cancelFastlaneReopen();
      },
      // Watchdog teardown / connection failure → schedule a reopen with
      // exponential backoff. WS path takes over for inputs in the meantime.
      onPeerClosed: function (peerIdx) {
        if (peerIdx === 0) scheduleFastlaneReopen();
      },
    });
  }

  party.onOpen = function () {
    party.join(roomCode);
  };

  party.onProtocol = function (type, msg) {
    if (type === 'joined') {
      peerIndex = msg.index;
      startPing();
      if (currentScreen !== 'game') vibrate(15);
      party.sendTo(0, {
        type: MSG.HELLO,
        name: playerName,
        autoName: !!playerNameIsAuto,
        // Persisted preferred color rides along so the display can honor it
        // at registration time; the first snapshot then already carries it
        // and reclaimPreferredColor's follow-up SET_COLOR round trip no-ops.
        // Omitted after an in-session swatch pick (the live pick outranks
        // the persisted one, mirroring reclaimPreferredColor's
        // userPickedColor gate) and while the AC storage shim is unhydrated
        // (readStoredColorIndex returns null; the onLoad reclaim in
        // controller-airconsole.js covers that case).
        colorIndex: userPickedColor ? null : readStoredColorIndex(),
        rejoinId: legacyRejoinId,
        rejoinToken: rejoinToken
      });
      // Reopen fastlane on every (re)join — existing peer connections don't
      // survive a relay-side replacement, and the display may have rejoined
      // while we were offline so its peer state is fresh.
      if (fastlane) {
        fastlane.setSelfIndex(peerIndex);
        fastlane.closeAll();
        // closeAll fires onPeerClosed → arms a retry at whatever delay we'd
        // accumulated. Fresh join means we want to restart from 2 s baseline,
        // not inherit 30 s from a prior bad session.
        cancelFastlaneReopen();
        // Offer flows asynchronously; sendToDisplay falls back to WS until
        // the channel is open.
        fastlane.open(0).catch(function (err) {
          console.warn('[fastlane] open failed', err);
        });
      }
    } else if (type === 'peer_left') {
      if (msg.index === 0) {
        if (fastlane) {
          fastlane.close(0);
          // Display gone from the relay — pending retries would just throw
          // offers into the void until the display reconnects. Cancel them
          // here; the peer_joined(0) branch below re-arms a fresh attempt
          // when the display comes back.
          cancelFastlaneReopen();
        }
        onDisplayGone();
      }
    } else if (type === 'peer_joined') {
      if (msg.index === 0 && displayGoneTimer) {
        // Display is back on the relay. Don't clear the bail outright: its
        // republished snapshot is what proves this session survived (and hides
        // the overlay + restarts pings). Re-arm so a display that returns but
        // never names us (restarted with an empty roster) still bails.
        clearTimeout(displayGoneTimer);
        displayGoneTimer = setTimeout(function () {
          displayGoneTimer = null;
          bailToWelcome('game_ended');
        }, DISPLAY_GONE_BAIL_MS);
      }
      if (msg.index === 0 && fastlane) {
        // Display is back — re-establish the fastlane immediately rather
        // than waiting for the next watchdog or retry tick. Cancel any
        // pending retry first so it doesn't race with this fresh attempt
        // (would otherwise re-enter open() ~2 s into ICE).
        cancelFastlaneReopen();
        fastlane.open(0).catch(function (err) {
          console.warn('[fastlane] open failed', err);
        });
      }
    } else if (type === 'error') {
      if (msg.message === 'Room not found') bailToWelcome('room_not_found');
      else if (msg.message === 'Room is full') bailToWelcome('game_full');
      else if (msg.message === 'Target peer not found' && currentScreen !== 'name') {
        // We only ever unicast to slot 0, so this means the display's relay
        // slot is empty; typically a PING that raced the peer_left(0)
        // broadcast. In-session (we have a snapshot) that's the display-gone flow,
        // not a terminal bail: the display may be seconds from rejoining
        // (relay blip, tvOS Home and back). Pre-session ('name', i.e. the
        // HELLO bounced off a hostless room) falls through and bails.
        onDisplayGone();
      }
      else bailToWelcome();
    }
  };

  party.onMessage = function (from, data) {
    // Intercept RTC signaling envelopes before app dispatch.
    if (fastlane && fastlane.handleSignal(from, data)) return;
    if (from === 0) {
      handleMessage(data);
    }
  };

  // The retained room snapshot: the controller's single source of truth.
  // Replayed right after `joined` on (re)join and pushed live on every display
  // update. Same callback name on the AirConsole adapter, so this one line
  // covers both transports.
  party.onState = onState;

  party.onClose = function (attempt, maxAttempts, meta) {
    stopPing();
    if (gameCancelled) return;
    if (meta && meta.replaced) {
      // keepClientId=true: the newer tab is using clientId_<room> as its
      // auto-reconnect anchor — clearing it would orphan that session.
      bailToWelcome(undefined, true);
      return;
    }
    if (meta && meta.roomClosed) {
      // The relay tore the room down (host closed it, or its hostless grace
      // expired): the party is over for good, so skip the reconnect flow.
      bailToWelcome('game_ended');
      return;
    }
    if (currentScreen !== 'game') return;
    clearTimeout(disconnectedTimer);

    reconnectOverlay.classList.remove('hidden');
    if (attempt === 1) reconnectHeading.textContent = t('reconnecting');
    reconnectStatus.textContent = t('attempt_n_of_m', { attempt: Math.min(attempt, maxAttempts), max: maxAttempts });
    reconnectRejoinBtn.classList.add('hidden');
    if (attempt > maxAttempts) {
      disconnectedTimer = setTimeout(function () {
        reconnectHeading.textContent = t('disconnected');
        reconnectStatus.textContent = '';
        reconnectRejoinBtn.classList.remove('hidden');
      }, 500);
    }
  };

  party.connect();
}

// =====================================================================
// Ping / Pong
// =====================================================================

function startPing() {
  stopPing();
  // AirConsole owns connection liveness via the SDK (onConnect/onDisconnect is
  // the authoritative disconnect signal), so the relay PING is redundant in AC
  // mode — and dropping it keeps the controller under AirConsole's ~10 msg/sec
  // cap (see sendToDisplay). No PING also means no PONG RTT and no fastlane, so
  // there is no latency to show; the chip is hidden via CSS (body.airconsole
  // #latency-display).
  if (window.airconsole) return;
  lastPongTime = Date.now();
  pingTimer = setInterval(function () {
    // Relay-liveness ping. Stays on WS — input-path RTT comes from fastlane
    // acks via onRtt. The display tracks each controller's lastPingTime for
    // its own liveness check (LIVENESS_TIMEOUT_MS), so this must keep firing
    // at 1 Hz unconditionally.
    sendToDisplay(MSG.PING, { t: Date.now() });
    // Surface "Bad Connection" when PONG is overdue. Skip when fastlane is
    // open — its own watchdog handles input-path health, and we don't want
    // WS-relay weather to nuke a chip currently showing real P2P RTT from
    // onRtt. Actual reconnect is handled by party.onClose.
    if (Date.now() - lastPongTime > PONG_TIMEOUT_MS &&
        !(fastlane && fastlane.isOpen(0))) {
      updateLatencyDisplay(-1);
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// The display's relay slot emptied out (peer_left(0), or a unicast to it
// bounced) without the room being torn down: crash, network loss, or a TV
// app backgrounded by the Home button. That's recoverable (the display rejoins
// the same slot and republishes the room snapshot), so wait on the reconnect
// overlay instead of bailing, but not forever. A snapshot that still names us
// clears the timer, hides the overlay, and restarts pings — see
// noteDisplayAlive. A deliberate display exit is NOT this path: the relay
// closes our socket with 4001 (onClose meta.roomClosed).
function onDisplayGone() {
  // Stop pinging the empty slot: each PING would bounce as a relay error and
  // re-enter here. The display re-stamps everyone's liveness on rejoin, so
  // going quiet is safe.
  stopPing();
  // 'name' has no session to guard (no snapshot yet); its JOIN error path owns it.
  if (currentScreen !== 'name') {
    reconnectOverlay.classList.remove('hidden');
    reconnectHeading.textContent = t('reconnecting');
    reconnectStatus.textContent = t('display_reconnecting');
    reconnectRejoinBtn.classList.add('hidden');
  }
  if (!displayGoneTimer) {
    displayGoneTimer = setTimeout(function () {
      displayGoneTimer = null;   // page survives the bail in AC mode
      bailToWelcome('game_ended');
    }, DISPLAY_GONE_BAIL_MS);
  }
}

function updateLatencyDisplay(ms) {
  if (!latencyDisplay) return;
  latencyDisplay.classList.remove('ping-good', 'ping-ok', 'ping-bad');
  // Toggle the fastlane bolt indicator. The icon element is added at startup
  // by ensureLatencyMarkup(); leaving it always-present in the DOM avoids
  // re-creating it on every ping tick.
  latencyDisplay.classList.toggle('latency-display--fastlane', !!(fastlane && fastlane.isOpen(0)));
  var textEl = latencyDisplay.querySelector('.latency-display__text') || latencyDisplay;
  if (ms < 0) {
    textEl.textContent = t('bad_connection');
    latencyDisplay.classList.add('ping-bad');
  } else {
    textEl.textContent = ms + ' ms';
    latencyDisplay.classList.add(ms < 50 ? 'ping-good' : ms < 100 ? 'ping-ok' : 'ping-bad');
  }
}

// =====================================================================
// Send Helper
// =====================================================================

// Latency-sensitive message types — enqueued to the fastlane's rolling-
// window send loop when the DataChannel is open, otherwise sent reliably
// over the WebSocket. PING/PONG stays on WS now (relay-liveness check);
// input-path RTT comes from fastlane acks via onRtt. Keyed by MSG
// constants so a rename in protocol.js is caught automatically.
var FASTLANE_TYPES = { [MSG.INPUT]: true, [MSG.SOFT_DROP]: true, [MSG.SOFT_DROP_END]: true };

// AirConsole caps a device's outbound messages at ~10/sec; sustained overage
// trips a platform-side rate-limit error. TouchInput's held-drop keepalive is
// already 10 Hz (SOFT_DROP_INTERVAL_MS=100) and setInterval never fires early,
// so the steady state no longer needs coalescing. This stays as the hard bound
// on the case the interval doesn't govern: a finger resting on the dead-zone
// boundary re-enters soft drop on successive pointermove events (see
// TouchInput._onPointerMove), and each re-entry emits an immediate SOFT_DROP at
// pointer rate rather than interval rate. The 1 Hz relay PING is dropped in AC
// mode (see startPing), so soft-drop is the only sustained sender and 10 Hz sits
// at the cap, leaving the odd move tap as the only extra traffic.
// SOFT_DROP carries no state the display accumulates — it's "keep dropping at
// speed X" and auto-ends after SOFT_DROP_TIMEOUT_MS (300 ms) — so dropping
// intermediate ticks just updates the speed slightly less often, which is
// imperceptible and well within the auto-end window. The latest speed always
// lands on the next tick.
var AC_SOFT_DROP_MIN_INTERVAL_MS = 100;
var lastAcSoftDropTime = 0;

// Note: mutates payload by adding .type — callers must pass a fresh object.
function sendToDisplay(type, payload) {
  if (!party) return;
  var msg = payload || {};
  msg.type = type;
  if (fastlane && FASTLANE_TYPES[type] && fastlane.enqueue(0, msg) === 'p2p') return;
  if (window.airconsole && type === MSG.SOFT_DROP) {
    var now = Date.now();
    if (now - lastAcSoftDropTime < AC_SOFT_DROP_MIN_INTERVAL_MS) return;
    lastAcSoftDropTime = now;
  }
  party.sendTo(0, msg);
}

// =====================================================================
// Disconnect / Error States
// =====================================================================

function performDisconnect() {
  stopPing();
  if (fastlane) { fastlane.closeAll(); fastlane = null; }
  cancelFastlaneReopen();
  if (party) {
    try { party.sendTo(0, { type: MSG.LEAVE }); } catch (_) {}
    party.close();
    party = null;
  }
  var params = new URLSearchParams(location.search);
  params.delete('rejoin');
  params.delete('claim');
  var qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  legacyRejoinId = null;
  rejoinToken = null;
  try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* iframe sandbox */ }
  playerColor = null;
  playerColorIndex = null;
  peerIndex = null;
  takenColorIndices = [];
  // Reset session-scoped pick flags. Without this, a user who picked a
  // color, bailed back to name, and rejoined would skip reclaimPreferredColor
  // (gated on !userPickedColor) and end up stuck on the display-assigned
  // default instead of their persisted favorite.
  userPickedColor = false;
  pendingColorPick = null;
  reclaimedPreferredColor = false;
  // If the picker is open when the user bails (e.g. tap "back" before the
  // 350ms backdrop-enable timer fires), the overlay would never get
  // .hidden re-applied — and on the next lobby visit openColorPicker's
  // "already open" guard would short-circuit, leaving the overlay
  // permanently visible with no way to dismiss it.
  if (typeof closeColorPicker === 'function') closeColorPicker();
  gameCancelled = false;
  // Prefill from the persisted user-typed name (localStorage is the single
  // source of truth) — not `playerName`, which may have been replaced by
  // the display's generated fallback (e.g. "HX-27").
  var storedName = '';
  try { storedName = localStorage.getItem('stacker_player_name') || ''; } catch (e) { /* iframe sandbox */ }
  playerNameIsAuto = !storedName;
  nameInput.value = storedName;
  nameJoinBtn.disabled = false;
  nameJoinBtn.textContent = t('join');
  nameInput.disabled = false;
  reconnectOverlay.classList.add('hidden');
  showScreen('name');
  nameInput.focus();
}
