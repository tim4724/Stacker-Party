'use strict';

// =====================================================================
// Controller Connection — PartyConnection lifecycle, ping/pong
// Depends on: ControllerState.js (globals)
// Called by: controller.js (init, event handlers)
// =====================================================================

function connect() {
  if (party) party.close();

  party = new PartyConnection(RELAY_URL, { clientId: clientId });

  party.onOpen = function () {
    party.join(roomCode);
  };

  party.onProtocol = function (type, msg) {
    if (type === 'joined') {
      startPing();
      if (currentScreen !== 'game') vibrate(10);
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
        showEndScreen('room_not_found');
      } else if (msg.message === 'Room is full') {
        showEndScreen('game_full');
      } else {
        showEndScreen();
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
      showEndScreen();
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

function showEndScreen(toastKey) {
  try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* iframe sandbox */ }
  gameCancelled = true;
  stopPing();
  if (party) { party.close(); party = null; }

  if (toastKey) {
    endToast.textContent = t(toastKey);
    endToast.classList.remove('hidden');
    setTimeout(function () { endToast.classList.add('hidden'); }, 2000);
  } else {
    endToast.classList.add('hidden');
  }
  showScreen('end');
}
