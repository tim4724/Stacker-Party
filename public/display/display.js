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

// --- Device Choice overlay ---
// Visibility on the display page is driven by html.device-choice-dismissed
// + the size-based media query in display.css. The element keeps its
// .hidden class permanently — dismiss/restore only toggle the root class.
var deviceChoice = document.getElementById('device-choice');
var deviceChoiceShareBtn = document.getElementById('device-choice-share');
var deviceChoiceContinueBtn = document.getElementById('device-choice-continue');

function dismissDeviceChoice() {
  document.documentElement.classList.add('device-choice-dismissed');
  history.pushState({ dcDismissed: true }, '');
}

function restoreDeviceChoice() {
  document.documentElement.classList.remove('device-choice-dismissed');
  // Firefox returns null for offsetParent on position:fixed descendants,
  // so use getBoundingClientRect to detect visibility before focusing.
  if (deviceChoiceShareBtn &&
      deviceChoiceShareBtn.getBoundingClientRect().width > 0) {
    try { deviceChoiceShareBtn.focus(); } catch (_) { /* old browsers */ }
  }
}

if (deviceChoiceContinueBtn) {
  deviceChoiceContinueBtn.addEventListener('click', dismissDeviceChoice);
}

if (deviceChoiceShareBtn) {
  deviceChoiceShareBtn.addEventListener('click', function() {
    HexStacker.share(t('share_text'));
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

  // Sync the device-choice overlay with history state.
  var wasDismissed = document.documentElement.classList.contains('device-choice-dismissed');
  var nowDismissed = !!(e.state && e.state.dcDismissed);
  if (wasDismissed && !nowDismissed) {
    restoreDeviceChoice();
  } else if (!wasDismissed && nowDismissed) {
    document.documentElement.classList.add('device-choice-dismissed');
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
// In test/gallery mode `party` may be a minimal stub without broadcast/close,
// so each call is guarded.
window.addEventListener('pagehide', function() {
  if (!party) return;
  if (typeof party.broadcast === 'function') {
    try { party.broadcast({ type: MSG.DISPLAY_CLOSED }); } catch (_) {}
  }
  if (typeof party.close === 'function') party.close();
});

playAgainBtn.addEventListener('click', function() {
  initMusic();
  playAgain();
});

newGameResultsBtn.addEventListener('click', function() {
  returnToLobby();
});

// --- Mute ---
// Initial DOM state synced at module load time so it reflects the
// stored mute setting before the toolbar is revealed.

function setDisplayMuted(next) {
  next = !!next;
  if (next === muted) return;
  muted = next;
  try { localStorage.setItem('stacker_muted', muted ? '1' : '0'); } catch (e) { /* iframe sandbox */ }
  muteBtn.querySelector('.sound-waves').style.display = muted ? 'none' : '';
  muteBtn.setAttribute('aria-checked', muted ? 'false' : 'true');
  if (music) {
    music.muted = muted;
    if (music.masterGain) {
      music.masterGain.gain.cancelScheduledValues(music.ctx.currentTime);
      music.masterGain.gain.setValueAtTime(music.masterGain.gain.value, music.ctx.currentTime);
      music.masterGain.gain.linearRampToValueAtTime(muted ? 0 : Music.MASTER_VOLUME, music.ctx.currentTime + 0.05);
    }
  }
  // Broadcast so the host controller's Game Music toggle reflects changes
  // made via the display's own mute button (and so a new host seeing the
  // settings popup sees the correct state without a page reload).
  if (party && typeof party.broadcast === 'function') {
    try { party.broadcast({ type: MSG.DISPLAY_MUTED, muted: muted }); } catch (e) { /* ignore */ }
  }
}

muteBtn.addEventListener('click', function() {
  setDisplayMuted(!muted);
});

// --- Fullscreen ---
fullscreenBtn.addEventListener('click', function() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  } else {
    document.exitFullscreen().catch(function() {});
  }
});
document.addEventListener('fullscreenchange', function() {
  fullscreenBtn.setAttribute('aria-checked', document.fullscreenElement ? 'true' : 'false');
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
  var welcomeVersion = document.getElementById('welcome-version-label');
  if (welcomeVersion) welcomeVersion.textContent = label;
  var lobbyVersion = document.getElementById('lobby-version-label');
  if (lobbyVersion) lobbyVersion.textContent = label;
}).catch(function() {});

var bgCanvas = document.getElementById('bg-canvas');
if (bgCanvas && (urlParams.get('test') !== '1' || urlParams.get('bg') === '1')) {
  // Read theme colors from CSS at runtime so the canvas edge always matches
  // the body's --bg-primary (which is what shows while the canvas is still
  // loading / mounting).
  var rootStyle = getComputedStyle(document.documentElement);
  // Accepts both `R, G, B` and the modern space-separated `R G B` CSS syntax;
  // falls back to black (visible, not silent) if the var is missing or malformed.
  var rgbVar = function(name) {
    var v = rootStyle.getPropertyValue(name).trim().split(/[\s,]+/).map(Number);
    if (v.length !== 3 || v.some(isNaN)) {
      console.warn('rgbVar: invalid value for', name, '→', rootStyle.getPropertyValue(name));
      return [0, 0, 0];
    }
    return v;
  };
  // Bake the radial tint into the canvas with Bayer dithering — CSS's
  // radial-gradient at this low alpha (~0.06 over the plum bg) bands visibly
  // on 8-bit displays because each channel step spans ~100px.
  welcomeBg = new WelcomeBackground(bgCanvas, 15, {
    cx: 0.5, cy: 0.3,
    tint: rgbVar('--accent-primary-rgb'),
    bg:   rgbVar('--bg-primary-rgb'),
    alpha: 0.06,
    stopEnd: 0.55,
  });
  welcomeBg.resize(window.innerWidth, window.innerHeight);
  welcomeBg.start();
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
