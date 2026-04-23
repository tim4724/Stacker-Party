'use strict';

// =====================================================================
// Controller Connection — PartyConnection lifecycle, ping/pong
// Depends on: ControllerState.js (globals)
// Called by: controller.js (init, event handlers)
// =====================================================================

// Handle for the 5s toast auto-hide timer, stored at module scope so
// successive showDeviceChoice() calls can cancel a previous timer
// before arming a new one.
var deviceChoiceToastTimer = null;

function connect() {
  // Gallery iframes load with ?scenario=; never open a real relay socket
  // for those, even if localStorage somehow holds a stored clientId for
  // room "GALLERY". Visual tests use ?test=1 alone and still need connect().
  if (new URLSearchParams(location.search).get('scenario')) return;

  if (party) party.close();

  party = new PartyConnection(RELAY_URL, { clientId: clientId });

  party.onOpen = function () {
    party.join(roomCode);
  };

  party.onProtocol = function (type, msg) {
    if (type === 'joined') {
      startPing();
      if (currentScreen !== 'game') vibrate(15);
      party.sendTo('display', {
        type: MSG.HELLO,
        name: playerName
      });
    } else if (type === 'peer_left') {
      if (msg.clientId === 'display') {
        if (currentScreen === 'game') {
          reconnectOverlay.classList.remove('hidden');
          reconnectHeading.textContent = t('reconnecting');
          reconnectStatus.textContent = t('display_reconnecting');
          reconnectRejoinBtn.classList.add('hidden');
        }
      }
    } else if (type === 'error') {
      if (msg.message === 'Room not found') {
        showDeviceChoice('room_not_found');
      } else if (msg.message === 'Room is full') {
        showDeviceChoice('game_full');
      } else {
        showDeviceChoice();
      }
    }
  };

  party.onMessage = function (from, data) {
    if (from === 'display') {
      handleMessage(data);
    }
  };

  party.onClose = function (attempt, maxAttempts, meta) {
    stopPing();
    if (gameCancelled) return;
    if (meta && meta.replaced) {
      // keepClientId=true: the newer tab that evicted us now owns the
      // localStorage clientId — clearing it would orphan that session.
      showDeviceChoice(undefined, true);
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
  lastPongTime = Date.now();
  pingTimer = setInterval(function () {
    party.sendTo('display', { type: MSG.PING, t: Date.now() });
    // Show "Bad Connection" if pong is overdue, but keep pinging.
    // Actual reconnect is handled by party.onClose when WebSocket dies.
    if (Date.now() - lastPongTime > PONG_TIMEOUT_MS) {
      updatePingDisplay(-1);
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function updatePingDisplay(ms) {
  if (!pingDisplay) return;
  pingDisplay.classList.remove('ping-good', 'ping-ok', 'ping-bad');
  if (ms < 0) {
    pingDisplay.textContent = t('bad_connection');
    pingDisplay.classList.add('ping-bad');
  } else {
    pingDisplay.textContent = ms + ' ms';
    pingDisplay.classList.add(ms < 50 ? 'ping-good' : ms < 100 ? 'ping-ok' : 'ping-bad');
  }
}

// =====================================================================
// Send Helper
// =====================================================================

// Note: mutates payload by adding .type — callers must pass a fresh object.
function sendToDisplay(type, payload) {
  if (!party) return;
  if (payload) {
    payload.type = type;
    party.sendTo('display', payload);
  } else {
    party.sendTo('display', { type: type });
  }
}

// =====================================================================
// Disconnect / Error States
// =====================================================================

function performDisconnect() {
  stopPing();
  if (party) {
    try { party.sendTo('display', { type: MSG.LEAVE }); } catch (_) {}
    party.close();
    party = null;
  }
  var params = new URLSearchParams(location.search);
  params.delete('rejoin');
  var qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  rejoinId = null;
  try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* iframe sandbox */ }
  playerColor = null;
  gameCancelled = false;
  // Prefill from the persisted user-typed name (localStorage is the single
  // source of truth) — not `playerName`, which may have been replaced by
  // the display's sanitized fallback (e.g. "P2").
  var storedName = '';
  try { storedName = localStorage.getItem('stacker_player_name') || ''; } catch (e) { /* iframe sandbox */ }
  nameInput.value = storedName;
  nameJoinBtn.disabled = false;
  nameJoinBtn.textContent = t('join');
  nameInput.disabled = false;
  nameStatusText.textContent = '';
  nameStatusDetail.textContent = '';
  reconnectOverlay.classList.add('hidden');
  showScreen('name');
  nameInput.focus();
}

function showDeviceChoice(toastKey, keepClientId) {
  // Guard against double-invocation (e.g. relay close + DISPLAY_CLOSED in
  // flight): don't reset the toast timer or re-null party.
  if (gameCancelled) return;
  // Tab-replacement path (keepClientId=true) must preserve localStorage —
  // the evicting tab now owns that identity.
  if (!keepClientId) {
    try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* iframe sandbox */ }
  }
  gameCancelled = true;
  stopPing();
  // Clean up the settings popup state so a close-button after
  // reconnect doesn't RESUME_GAME a long-gone display. Guarded: this
  // function is only defined on the !roomCode branch in controller.js,
  // and showDeviceChoice() also runs on the falsy-roomCode early-return
  // before that branch's assignment runs.
  if (typeof closeSettingsOverlay === 'function') closeSettingsOverlay();
  if (party) { party.close(); party = null; }

  // Collapse the URL to "/" so a user copying the address from this screen
  // shares the app root rather than a dead room link. replaceState keeps
  // the history stack unchanged. Skipped for gallery/test iframes: their
  // URL bar isn't user-visible, and their ?test=/?scenario= params are
  // read by connect() and other harness code.
  var _search = new URLSearchParams(location.search);
  var _isTest = _search.get('test') === '1' || _search.get('scenario');
  if (!_isTest && (location.pathname !== '/' || location.search)) {
    try { history.replaceState(null, '', '/'); } catch (_) { /* sandboxed iframe */ }
  }

  // The toast element has role="status" + aria-live="polite", so changing
  // textContent is enough to announce it via screen readers — no manual
  // aria-hidden juggling needed.
  clearTimeout(deviceChoiceToastTimer);
  if (toastKey) {
    deviceChoiceToast.textContent = t(toastKey);
    deviceChoiceToast.classList.remove('hidden');
    deviceChoiceToastTimer = setTimeout(function () {
      deviceChoiceToast.classList.add('hidden');
    }, 5000);
  } else {
    // Clear the text too so a stale message from a prior invocation
    // can't be announced by AT on the way to `hidden`, and doesn't
    // linger in the DOM.
    deviceChoiceToast.textContent = '';
    deviceChoiceToast.classList.add('hidden');
  }
  showScreen('device-choice');
  // role="dialog" — move focus into the overlay so keyboard and
  // screen-reader users land on the primary action, not outside it.
  // Using a rect-width probe rather than `offsetParent` because Firefox
  // returns null for offsetParent under position:fixed ancestors.
  if (deviceChoiceShareBtn &&
      deviceChoiceShareBtn.getBoundingClientRect().width > 0) {
    try { deviceChoiceShareBtn.focus(); } catch (_) { /* old browsers */ }
  }
}
