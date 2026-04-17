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
  setRoomState(ROOM_STATE.LOBBY);
  resetRoomData();
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
// Note: on mobile the display.css media query (#end-screen { display: flex })
// overrides the .hidden class via higher specificity, so dismissing the hint
// requires removing the element rather than just adding `.hidden`.
var endContinueBtn = document.getElementById('end-continue-btn');
if (endContinueBtn) {
  endContinueBtn.addEventListener('click', function() {
    var endScreen = document.getElementById('end-screen');
    if (endScreen) endScreen.remove();
  });
}

// Share hexstackerparty.com via the Web Share API when the link is tapped on mobile.
// Delegated on document so i18n re-translations don't discard the listener.
if (navigator.share) {
  document.addEventListener('click', function(e) {
    var link = e.target.closest && e.target.closest('#end-step-1-link');
    if (!link) return;
    e.preventDefault();
    navigator.share({
      title: 'HexStacker Party',
      text: 'Play HexStacker Party with your friends',
      url: 'https://hexstackerparty.com'
    }).catch(function(err) {
      // AbortError = user cancelled the sheet — do nothing.
      // Any other error = share was blocked — fall back to normal navigation.
      if (err && err.name !== 'AbortError') window.open(link.href, '_blank');
    });
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
  pauseGame(true);
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
  var welcomeVersion = document.getElementById('welcome-version-label');
  if (welcomeVersion) welcomeVersion.textContent = label;
  var lobbyVersion = document.getElementById('lobby-version-label');
  if (lobbyVersion) lobbyVersion.textContent = label;
}).catch(function() {});

var bgCanvas = document.getElementById('bg-canvas');
if (bgCanvas && (urlParams.get('test') !== '1' || urlParams.get('bg') === '1')) {
  welcomeBg = new WelcomeBackground(bgCanvas);
  welcomeBg.resize(window.innerWidth, window.innerHeight);
  welcomeBg.start();

  // End-screen falling pieces — only animate on mobile devices where the
  // end-screen is actually visible (see display.css media query). Desktop
  // users never see the end-screen, so there's no reason to burn RAF on it.
  var endScreenBgCanvas = document.getElementById('end-screen-bg');
  if (endScreenBgCanvas) {
    var endScreenBg = new WelcomeBackground(endScreenBgCanvas, 6);
    var endScreenMql = window.matchMedia(
      '(max-width: 950px) and (pointer: coarse) and (hover: none),' +
      '(max-height: 500px) and (pointer: coarse) and (hover: none)'
    );
    var syncEndScreenBg = function() {
      if (!endScreenBgCanvas.isConnected) return;
      if (endScreenMql.matches) {
        var rect = endScreenBgCanvas.getBoundingClientRect();
        endScreenBg.resize(rect.width, rect.height);
        endScreenBg.start();
      } else {
        endScreenBg.stop();
      }
    };
    syncEndScreenBg();
    endScreenMql.addEventListener('change', syncEndScreenBg);
    window.addEventListener('resize', syncEndScreenBg);
  }
}

// --- Debug or normal init ---
var _scenarioParam = urlParams.get('scenario');
if (window.__TEST__ && (debugCount > 0 || _scenarioParam)) {
  var _hostParam = urlParams.get('host');
  initScenario({
    scenario: _scenarioParam || 'playing',
    players: debugCount || parseInt(urlParams.get('players'), 10) || 1,
    level: parseInt(urlParams.get('level'), 10) || 1,
    host: _hostParam === null ? null : parseInt(_hostParam, 10)
  });
} else if (urlParams.get('test') === '1') {
  // Test mode: skip relay connection — tests inject state directly
  fetchBaseUrl();
} else {
  fetchBaseUrl();
  connectAndCreateRoom();
}
