'use strict';

// =====================================================================
// Display Entry Point — init, event listeners
// Depends on: DisplayState.js (urlParams, debugCount), DisplayUI.js,
//             DisplayConnection.js, DisplayGame.js, DisplayInput.js,
//             DisplayRender.js, DisplayTestHarness.js, DisplayLiveness.js
// Loaded last; wires up event listeners and initializes
// =====================================================================

// =====================================================================
// Welcome / UI Buttons
// =====================================================================

function resetToWelcome() {
  releaseWakeLock();
  if (party) {
    party.close();
    party = null;
  }
  stopLivenessCheck();
  lastRoomCode = null;
  roomCode = null;
  joinUrl = null;
  paused = false;
  setRoomState(ROOM_STATE.LOBBY);
  players.clear();
  playerOrder = [];
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  lastAliveState = {};
  lastResults = null;
  preCreatedRoom = null;
  showScreen(SCREEN.WELCOME);
  connectAndCreateRoom();
}

// =====================================================================
// Cursor Auto-Hide
// =====================================================================

var cursorTimer = null;
function showCursor() {
  document.body.classList.remove('cursor-hidden');
  gameToolbar.classList.remove('toolbar-autohide');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(function() {
    document.body.classList.add('cursor-hidden');
    if (currentScreen === SCREEN.GAME) {
      gameToolbar.classList.add('toolbar-autohide');
    }
  }, 3000);
}
document.addEventListener('mousemove', showCursor);
showCursor();

// =====================================================================
// Initialize
// =====================================================================

// --- Window Resize ---
window.addEventListener('resize', function() {
  resizeCanvas();
  if (welcomeBg) welcomeBg.resize(window.innerWidth, window.innerHeight);
  if (currentScreen === SCREEN.LOBBY) updatePlayerList();
});

// --- Re-acquire Wake Lock on tab focus (browser releases it on visibility change) ---
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && !wakeLock &&
      (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)) {
    acquireWakeLock();
  }
});

// --- End Screen (mobile hint) ---
var endContinueBtn = document.getElementById('end-continue-btn');
if (endContinueBtn) {
  endContinueBtn.addEventListener('click', function() {
    var endScreen = document.getElementById('end-screen');
    if (endScreen) endScreen.remove();
  });
}

// Share couch-games.com via the Web Share API when the link is tapped on mobile.
// Delegated on document so i18n re-translations don't discard the listener.
if (navigator.share) {
  document.addEventListener('click', function(e) {
    var link = e.target.closest && e.target.closest('#end-step-1-link');
    if (!link) return;
    e.preventDefault();
    navigator.share({
      title: 'Stacker Party',
      text: 'Play Stacker Party with your friends',
      url: 'https://couch-games.com'
    }).catch(function() { /* user cancelled or share failed */ });
  });
}

// --- Button Event Listeners ---
newGameBtn.addEventListener('click', function() {
  initMusic();
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  }

  if (preCreatedRoom) {
    var pre = preCreatedRoom;
    preCreatedRoom = null;
    applyRoomCreated(pre.roomCode, pre.joinUrl);
    if (pre.qrMatrix) {
      requestAnimationFrame(function() { renderQR(qrCode, pre.qrMatrix); });
    }
  } else {
    // Relay hasn't responded yet — show lobby so onRoomCreated
    // applies the room immediately instead of pre-caching it.
    showScreen(SCREEN.LOBBY);
    connectAndCreateRoom();
  }

  history.pushState({ screen: SCREEN.LOBBY }, '');
});

window.addEventListener('popstate', function(e) {
  if (suppressPopstate) {
    suppressPopstate = false;
    return;
  }
  var target = e.state && e.state.screen;
  if (currentScreen === SCREEN.WELCOME && target === SCREEN.LOBBY) {
    suppressPopstate = true;
    history.back();
  } else if (currentScreen === SCREEN.LOBBY) {
    if (target === SCREEN.GAME) {
      suppressPopstate = true;
      history.back();
    } else {
      resetToWelcome();
    }
  } else if (currentScreen === SCREEN.GAME || currentScreen === SCREEN.RESULTS) {
    popstateNavigating = true;
    if (music) music.stop();
    showScreen(SCREEN.LOBBY);
    returnToLobby();
  }
});

startBtn.addEventListener('click', function() {
  if (startBtn.disabled) return;
  initMusic();
  startGame();
});

// Goodbye to controllers on intentional close/navigate-away so they
// immediately see the end screen instead of a "reconnecting" overlay.
// Best-effort: pagehide also fires on bfcache freeze (iOS Safari) where
// the WebSocket send may not complete before the page is frozen.
// Controllers fall back to the existing reconnect overlay in that case.
window.addEventListener('pagehide', function() {
  if (party) {
    try { party.broadcast({ type: MSG.DISPLAY_CLOSED }); } catch (_) {}
    party.close();
  }
});

// --- Game mode selector ---
var modeCards = document.querySelectorAll('#mode-selector .mode-option');

function updateModeUI(mode) {
  for (var i = 0; i < modeCards.length; i++) {
    modeCards[i].classList.toggle('selected', modeCards[i].getAttribute('data-mode') === mode);
  }
}

// Restore from localStorage
var savedMode = null;
try { savedMode = localStorage.getItem('stacker_game_mode'); } catch (e) { /* iframe sandbox */ }
if (savedMode === 'hex' || savedMode === 'classic') {
  gameMode = savedMode;
  updateModeUI(gameMode);
  if (welcomeBg) welcomeBg.setMode(gameMode);
  if (savedMode === 'hex') {
    var link = document.querySelector('link[rel="icon"]');
    if (link) link.href = '/favicon-hex.svg';
  }
}

function setFavicon(mode) {
  var link = document.querySelector('link[rel="icon"]');
  if (link) link.href = mode === 'hex' ? '/favicon-hex.svg' : '/favicon-classic.svg';
}

function setGameMode(mode) {
  if (mode !== 'classic' && mode !== 'hex') return;
  gameMode = mode;
  updateModeUI(mode);
  setFavicon(mode);
  if (welcomeBg) welcomeBg.setMode(mode);
  try { localStorage.setItem('stacker_game_mode', mode); } catch (e) { /* iframe sandbox */ }
  if (party && roomState === ROOM_STATE.LOBBY) broadcastLobbyUpdate();
}

for (var mi = 0; mi < modeCards.length; mi++) {
  modeCards[mi].addEventListener('click', function() {
    setGameMode(this.getAttribute('data-mode'));
  });
}

playAgainBtn.addEventListener('click', function() {
  initMusic();
  playAgain();
});

newGameResultsBtn.addEventListener('click', function() {
  returnToLobby();
});

// --- Mute ---
if (muted) muteBtn.querySelector('.sound-waves').style.display = 'none';
muteBtn.addEventListener('click', function() {
  muted = !muted;
  try { localStorage.setItem('stacker_muted', muted ? '1' : '0'); } catch (e) { /* iframe sandbox */ }
  muteBtn.querySelector('.sound-waves').style.display = muted ? 'none' : '';
  if (music) {
    music.muted = muted;
    if (music.masterGain) {
      music.masterGain.gain.cancelScheduledValues(music.ctx.currentTime);
      music.masterGain.gain.setValueAtTime(music.masterGain.gain.value, music.ctx.currentTime);
      music.masterGain.gain.linearRampToValueAtTime(muted ? 0 : Music.MASTER_VOLUME, music.ctx.currentTime + 0.05);
    }
  }
});

// --- Fullscreen ---
fullscreenBtn.addEventListener('click', function() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  } else {
    document.exitFullscreen().catch(function() {});
  }
});

// --- Pause (display-side buttons) ---
pauseBtn.addEventListener('click', function() {
  pauseGame();
});

pauseContinueBtn.addEventListener('click', function() {
  resumeGame();
});

pauseNewGameBtn.addEventListener('click', function() {
  returnToLobby();
});

reconnectBtn.addEventListener('click', function() {
  clearTimeout(disconnectedTimer);
  party.resetReconnectCount();
  reconnectBtn.classList.add('hidden');
  reconnectHeading.textContent = t('reconnecting');
  reconnectStatus.textContent = t('connecting');
  party.reconnectNow();
});

// --- Version + Background ---
fetch('/api/version').then(function(r) { return r.json(); }).then(function(data) {
  var label = data.version;
  if (!data.isProduction && data.commit) {
    label += ' (#' + data.commit + ')';
  }
  document.getElementById('version-label').textContent = label;
}).catch(function() {});

var bgCanvas = document.getElementById('bg-canvas');
if (bgCanvas && urlParams.get('test') !== '1') {
  welcomeBg = new WelcomeBackground(bgCanvas);
  if (gameMode !== 'classic') welcomeBg.setMode(gameMode);
  welcomeBg.resize(window.innerWidth, window.innerHeight);
  welcomeBg.start();
}

// --- Debug or normal init ---
if (debugCount > 0 && window.__TEST__) {
  initDebugMode(debugCount);
} else if (urlParams.get('test') === '1') {
  // Test mode: skip relay connection — tests inject state directly
  fetchBaseUrl();
} else {
  fetchBaseUrl();
  connectAndCreateRoom();
}
