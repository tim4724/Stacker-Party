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
          reconnectHeading.textContent = 'RECONNECTING';
          reconnectStatus.textContent = 'Display reconnecting...';
          reconnectRejoinBtn.classList.add('hidden');
        }
      }
    } else if (type === 'error') {
      showRoomGone();
    }
  };

  party.onMessage = function (from, data) {
    if (from === 'display') {
      handleMessage(data);
    }
  };

  party.onClose = function (attempt, maxAttempts) {
    stopPing();
    if (gameCancelled) return;
    if (currentScreen !== 'game') return;
    clearTimeout(disconnectedTimer);

    reconnectOverlay.classList.remove('hidden');
    if (attempt === 1) reconnectHeading.textContent = 'RECONNECTING';
    reconnectStatus.textContent = 'Attempt ' + Math.min(attempt, maxAttempts) + ' of ' + maxAttempts;
    reconnectRejoinBtn.classList.add('hidden');
    if (attempt > maxAttempts) {
      disconnectedTimer = setTimeout(function () {
        reconnectHeading.textContent = 'DISCONNECTED';
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
    // Pong check (combined into ping interval)
    if (Date.now() - lastPongTime > PONG_TIMEOUT_MS) {
      stopPing();
      if (party.reconnectAttempt > party.maxReconnectAttempts) return;
      if (currentScreen === 'game') {
        reconnectOverlay.classList.remove('hidden');
        reconnectHeading.textContent = 'RECONNECTING';
        reconnectStatus.textContent = 'Display not responding';
        reconnectRejoinBtn.classList.add('hidden');
      }
      party.reconnectNow();
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function updatePingDisplay(ms) {
  if (!pingDisplay) return;
  pingDisplay.textContent = ms + ' ms';
  pingDisplay.classList.remove('ping-good', 'ping-ok', 'ping-bad');
  pingDisplay.classList.add(ms < 50 ? 'ping-good' : ms < 100 ? 'ping-ok' : 'ping-bad');
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
  playerColor = null;
  isHost = false;
  gameCancelled = false;
  nameInput.value = playerName || '';
  nameJoinBtn.disabled = false;
  nameJoinBtn.textContent = 'JOIN';
  nameInput.disabled = false;
  nameStatusText.textContent = '';
  nameStatusDetail.textContent = '';
  roomGoneMessage.classList.add('hidden');
  reconnectOverlay.classList.add('hidden');
  showScreen('name');
  nameInput.focus();
}

function showRoomGone() {
  if (roomCode) sessionStorage.removeItem('clientId_' + roomCode);
  gameCancelled = true;
  nameForm.classList.add('hidden');
  nameJoinBtn.classList.add('hidden');
  nameStatusText.textContent = '';
  nameStatusDetail.textContent = '';
  roomGoneHeading.textContent = 'Room Not Found';
  roomGoneDetail.textContent = 'Scan Game QR code to join';
  roomGoneMessage.classList.remove('hidden');
  showScreen('name');
}

function showErrorState(heading, detail) {
  sessionStorage.removeItem('clientId_' + roomCode);
  gameCancelled = true;
  stopPing();

  nameJoinBtn.disabled = false;
  nameJoinBtn.textContent = 'JOIN';
  nameInput.disabled = false;
  roomGoneMessage.classList.add('hidden');

  nameStatusText.textContent = heading;
  nameStatusDetail.textContent = detail || '';
  showScreen('name');
}
