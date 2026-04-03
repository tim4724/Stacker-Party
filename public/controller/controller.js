'use strict';

// =====================================================================
// Controller Entry Point — message dispatch, event listeners, init
// Depends on: ControllerState.js, ControllerConnection.js, ControllerGame.js
// Loaded last; wires up event listeners and initializes the controller
// =====================================================================

// =====================================================================
// Message Dispatch
// =====================================================================

function handleMessage(data) {
  try {
    // Ignore game broadcasts after rejection (e.g., joined during countdown)
    // Only allow WELCOME (re-admission) and ERROR (new rejection info) through.
    if (gameCancelled && data.type !== MSG.WELCOME && data.type !== MSG.ERROR) return;
    // Late joiner waiting for next game — ignore game broadcasts but allow
    // WELCOME (re-admission), GAME_END (show results), RETURN_TO_LOBBY, LOBBY_UPDATE, ERROR
    if (waitingForNextGame && data.type !== MSG.WELCOME && data.type !== MSG.GAME_END
        && data.type !== MSG.RETURN_TO_LOBBY && data.type !== MSG.LOBBY_UPDATE
        && data.type !== MSG.ERROR && data.type !== MSG.PONG) return;

    switch (data.type) {
      case MSG.WELCOME:
        onWelcome(data);
        break;
      case MSG.LOBBY_UPDATE:
        onLobbyUpdate(data);
        break;
      case MSG.GAME_START:
        onGameStart();
        break;
      case MSG.COUNTDOWN:
        removeKoOverlay();
        if (currentScreen !== 'game') {
          gameScreen.classList.remove('dead');
          gameScreen.classList.remove('paused');
          gameScreen.classList.add('countdown');
          gameScreen.style.setProperty('--player-color', playerColor);
          pauseOverlay.classList.add('hidden');
          pauseBtn.disabled = false;
          pauseBtn.classList.remove('hidden');
          showScreen('game');
        }
        if (data.value === 'GO') {
          gameScreen.classList.remove('countdown');
          initTouchInput();
        }
        break;
      case MSG.PLAYER_STATE:
        onPlayerState(data);
        break;
      case MSG.GAME_OVER:
        break;
      case MSG.GAME_END:
        waitingForNextGame = false;
        onGameEnd(data);
        break;
      case MSG.GAME_PAUSED:
        onGamePaused();
        break;
      case MSG.GAME_RESUMED:
        onGameResumed();
        break;
      case MSG.RETURN_TO_LOBBY:
        waitingForNextGame = false;
        playerCount = data.playerCount || playerCount;
        gameScreen.classList.remove('dead');
        gameScreen.classList.remove('paused');
        showLobbyUI();
        break;
      case MSG.PONG:
        lastPongTime = Date.now();
        if (data.t) {
          var rtt = Date.now() - data.t;
          updatePingDisplay(Math.round(rtt / 2));
        }
        if (party) party.resetReconnectCount();
        clearTimeout(disconnectedTimer);
        reconnectOverlay.classList.add('hidden');
        break;
      case MSG.ERROR:
        onError(data);
        break;
    }
  } catch (err) {
    console.error('[controller] Error handling message:', data && data.type, err);
  }
}

// =====================================================================
// Room Code & Client ID
// =====================================================================

roomCode = location.pathname.split('/').filter(Boolean)[0] || null;
if (!roomCode) {
  showRoomGone();
} else {

// Check for stored clientId BEFORE generating a new one (used for auto-reconnect)
var hadStoredId = sessionStorage.getItem('clientId_' + roomCode);

if (rejoinId) {
  clientId = rejoinId;
} else {
  clientId = hadStoredId || generateClientId();
}

// =====================================================================
// Name Input
// =====================================================================

var savedName = localStorage.getItem('stacker_player_name') || '';

function submitName() {
  var name = nameInput.value.trim();

  playerName = name || null;
  if (name) localStorage.setItem('stacker_player_name', name);
  sessionStorage.setItem('clientId_' + roomCode, clientId);
  nameJoinBtn.disabled = true;
  nameJoinBtn.textContent = 'CONNECTING...';
  nameInput.disabled = true;
  nameStatusText.textContent = '';
  nameStatusDetail.textContent = '';
  connect();
}

nameJoinBtn.addEventListener('click', function () { vibrate(10); submitName(); });
nameInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') submitName();
});
nameInput.addEventListener('focus', function () {
  setTimeout(syncViewportLayout, 50);
});
nameInput.addEventListener('blur', function () {
  setTimeout(syncViewportLayout, 50);
});

// Prime audio on first interaction
document.addEventListener('pointerdown', function onFirstPointer() {
  vibrate(1);
  ControllerAudio.prime();
  document.removeEventListener('pointerdown', onFirstPointer, true);
}, { capture: true, passive: true });

// =====================================================================
// Mute
// =====================================================================

ControllerAudio.setMuted(localStorage.getItem('stacker_muted') === '1');
if (ControllerAudio.isMuted()) {
  muteBtn.classList.add('muted');
  muteBtn.querySelector('.sound-waves').style.display = 'none';
}

muteBtn.addEventListener('click', function () {
  vibrate(10);
  ControllerAudio.setMuted(!ControllerAudio.isMuted());
  localStorage.setItem('stacker_muted', ControllerAudio.isMuted() ? '1' : '0');
  muteBtn.classList.toggle('muted', ControllerAudio.isMuted());
  muteBtn.querySelector('.sound-waves').style.display = ControllerAudio.isMuted() ? 'none' : '';
});

// =====================================================================
// Button Event Listeners
// =====================================================================

pauseBtn.addEventListener('click', function () {
  vibrate(10);
  sendToDisplay(MSG.PAUSE_GAME);
});

pauseContinueBtn.addEventListener('click', function () {
  vibrate(10);
  sendToDisplay(MSG.RESUME_GAME);
});

pauseNewGameBtn.addEventListener('click', function () {
  vibrate(10);
  sendToDisplay(MSG.RETURN_TO_LOBBY);
});

reconnectRejoinBtn.addEventListener('click', function () {
  vibrate(10);
  reconnectHeading.textContent = 'RECONNECTING';
  reconnectStatus.textContent = 'Connecting...';
  reconnectRejoinBtn.classList.add('hidden');
  connect();
});

lobbyBackBtn.addEventListener('click', function () {
  vibrate(10);
  performDisconnect();
});

startBtn.addEventListener('click', function () {
  if (startBtn.disabled) return;
  vibrate(10);
  sendToDisplay(MSG.START_GAME);
});

// --- Mode selector ---
var modeOptions = document.querySelectorAll('#mode-selector .mode-option');
for (var mj = 0; mj < modeOptions.length; mj++) {
  modeOptions[mj].addEventListener('click', function () {
    var mode = this.getAttribute('data-mode');
    vibrate(10);
    updateControllerModeUI(mode);
    sendToDisplay(MSG.SET_MODE, { mode: mode });
  });
}

levelMinusBtn.addEventListener('click', function () {
  if (startLevel <= 1) return;
  vibrate(10);
  startLevel = Math.max(1, startLevel - 1);
  updateLevelDisplay();
  sendToDisplay(MSG.SET_LEVEL, { level: startLevel });
});

levelPlusBtn.addEventListener('click', function () {
  if (startLevel >= 15) return;
  vibrate(10);
  startLevel = Math.min(15, startLevel + 1);
  updateLevelDisplay();
  sendToDisplay(MSG.SET_LEVEL, { level: startLevel });
});

playAgainBtn.addEventListener('click', function () {
  if (!gameoverButtonsReady) return;
  vibrate(10);
  sendToDisplay(MSG.PLAY_AGAIN);
});

newGameBtn.addEventListener('click', function () {
  if (!gameoverButtonsReady) return;
  vibrate(10);
  sendToDisplay(MSG.RETURN_TO_LOBBY);
});

// =====================================================================
// Global Event Listeners
// =====================================================================

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  if (gameCancelled) return;
  if (currentScreen === 'name' && !playerColor) return;

  // Restart pings to check if connection is still alive.
  // If the WebSocket died while backgrounded, party.onClose will
  // trigger reconnection automatically.
  if (party && party.connected) {
    startPing();
  } else {
    connect();
  }
});

window.addEventListener('popstate', function () {
  if (currentScreen === 'lobby' || currentScreen === 'game' || currentScreen === 'gameover') {
    performDisconnect();
  }
});

// =====================================================================
// Initialize
// =====================================================================

if (hadStoredId || rejoinId) {
  playerName = savedName || null;
  nameInput.value = savedName;
  nameJoinBtn.disabled = true;
  nameJoinBtn.textContent = 'CONNECTING...';
  nameInput.disabled = true;
  nameStatusText.textContent = '';
  nameStatusDetail.textContent = '';
  showScreen('name');
  connect();
} else {
  nameInput.value = savedName;
  nameStatusText.textContent = '';
  nameStatusDetail.textContent = '';
  showScreen('name');
  nameInput.focus();
}

syncViewportLayout();

// Show join URL hint on lobby screen
var joinUrlHint = location.origin + '/' + roomCode;
var lobbyJoinUrl = document.getElementById('lobby-join-url');
if (lobbyJoinUrl) lobbyJoinUrl.textContent = joinUrlHint;

} // end if (roomCode)
