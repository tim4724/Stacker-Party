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
        pauseBtn.classList.toggle('hidden', !isHost);
        showScreen('game');
      }
      break;
    case MSG.PLAYER_STATE:
      onPlayerState(data);
      break;
    case MSG.GAME_OVER:
      break;
    case MSG.GAME_END:
      onGameEnd(data);
      break;
    case MSG.GAME_PAUSED:
      onGamePaused();
      break;
    case MSG.GAME_RESUMED:
      onGameResumed();
      break;
    case MSG.RETURN_TO_LOBBY:
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
}

// =====================================================================
// Room Code & Client ID
// =====================================================================

roomCode = location.pathname.split('/').filter(Boolean)[0] || null;
if (!roomCode) {
  showRoomGone();
  return;
}

// Check for stored clientId BEFORE generating a new one (used for auto-reconnect)
var hadStoredId = sessionStorage.getItem('clientId_' + roomCode);

if (rejoinId) {
  clientId = rejoinId;
} else {
  clientId = hadStoredId || generateClientId();
  sessionStorage.setItem('clientId_' + roomCode, clientId);
}

// =====================================================================
// Name Input
// =====================================================================

var savedName = localStorage.getItem('tetris_player_name') || '';

function submitName() {
  var name = nameInput.value.trim();

  playerName = name || null;
  if (name) localStorage.setItem('tetris_player_name', name);
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

ControllerAudio.setMuted(localStorage.getItem('tetris_muted') === '1');
if (ControllerAudio.isMuted()) {
  muteBtn.classList.add('muted');
  muteBtn.querySelector('.sound-waves').style.display = 'none';
}

muteBtn.addEventListener('click', function () {
  vibrate(10);
  ControllerAudio.setMuted(!ControllerAudio.isMuted());
  localStorage.setItem('tetris_muted', ControllerAudio.isMuted() ? '1' : '0');
  muteBtn.classList.toggle('muted', ControllerAudio.isMuted());
  muteBtn.querySelector('.sound-waves').style.display = ControllerAudio.isMuted() ? 'none' : '';
});

// =====================================================================
// Button Event Listeners
// =====================================================================

pauseBtn.addEventListener('click', function () {
  if (!isHost) return;
  vibrate(10);
  sendToDisplay(MSG.PAUSE_GAME);
});

pauseContinueBtn.addEventListener('click', function () {
  if (!isHost) return;
  vibrate(10);
  sendToDisplay(MSG.RESUME_GAME);
});

pauseNewGameBtn.addEventListener('click', function () {
  if (!isHost) return;
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
  if (!isHost || startBtn.disabled) return;
  vibrate(10);
  sendToDisplay(MSG.START_GAME);
});

playAgainBtn.addEventListener('click', function () {
  if (!isHost) return;
  vibrate(10);
  sendToDisplay(MSG.PLAY_AGAIN);
});

newGameBtn.addEventListener('click', function () {
  if (!isHost) return;
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

  stopPing();
  if (party) {
    party.close();
    party = null;
  }
  connect();
});

window.addEventListener('popstate', function () {
  if (currentScreen === 'lobby') {
    performDisconnect();
  } else if (currentScreen === 'game' || currentScreen === 'gameover') {
    history.pushState({ screen: currentScreen }, '');
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

})(); // end Controller IIFE (opened in ControllerState.js)
