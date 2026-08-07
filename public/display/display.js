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
  lastInstance = null;
  roomCode = null;
  joinUrl = null;
  setRoomState(ROOM_STATE.LOBBY);
  resetRoomData();
  // Reset relay state so a fresh session starts clean: the sticky CTA
  // should not carry over, and the chip should not flash the previous
  // session's region/RTT before the new 'created' lands.
  consecutiveBadRtt = 0;
  lastRelayRtt = -1;
  relayRegion = null;
  if (relayReportBtn) relayReportBtn.classList.add('hidden');
  clearTimeout(createTimeout);
  clearTimeout(disconnectedTimer);
  reconnectOverlay.classList.add('hidden');
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
    cursorTimer = null;
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

window.addEventListener('resize', function() {
  resizeCanvas();
  if (welcomeBg) welcomeBg.resize(window.innerWidth, window.innerHeight);
  if (currentScreen === SCREEN.LOBBY) updatePlayerList();
});

// --- Re-acquire Wake Lock on tab focus (browser releases it on visibility change) ---
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  // The browser drops the lock whenever the tab hides, so re-take it for any
  // open room (not just a running match; the lobby needs it just as much).
  if (!wakeLock && roomCode) acquireWakeLock();
  // If returning to an already-shown results screen, skip replaying the
  // button fade — see the .results-screen--ready CSS rule.
  if (currentScreen === SCREEN.RESULTS && resultsScreen) {
    resultsScreen.classList.add('results-screen--ready');
  }
});

// --- Device Choice overlay ---
// Visibility on the display page is driven by html.device-choice-dismissed
// + the size-based media query in display.css. The element keeps its
// .hidden class permanently — dismiss/restore only toggle the root class.
var deviceChoice = document.getElementById('device-choice');
var deviceChoiceToast = document.getElementById('device-choice-toast');
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

// Show a bail toast inside the device-choice overlay. Auto-hides after
// 5s so the overlay doesn't keep advertising a stale reason after the
// user has had a chance to read it. Re-callable: each call resets the
// timer (used by the gallery replay button).
var _bailToastTimer = null;
function showBailToast(key) {
  if (!deviceChoiceToast) return;
  deviceChoiceToast.textContent = t(key);
  deviceChoiceToast.classList.remove('hidden');
  clearTimeout(_bailToastTimer);
  _bailToastTimer = setTimeout(function() {
    deviceChoiceToast.classList.add('hidden');
  }, 5000);
}

// Controller-side errors navigate here with `?bail=<i18n_key>` so the
// device-choice overlay (mobile-visible via CSS media query) surfaces
// context like "Room Not Found" or "Game ended". Desktop viewports hide
// the overlay, so populating the toast is a no-op there — the user just
// lands on the welcome screen silently, which is the intended behavior.
// The param is stripped via replaceState so a reload doesn't re-toast.
// Allow-list known keys so a crafted /?bail=<arbitrary text> URL can't
// inject a phishy message into the toast.
var BAIL_KEYS = ['room_not_found', 'game_full', 'game_ended'];
(function applyBailToast() {
  var params = new URLSearchParams(location.search);
  var bailKey = params.get('bail');
  if (!bailKey || BAIL_KEYS.indexOf(bailKey) === -1) return;
  showBailToast(bailKey);
  params.delete('bail');
  var qs = params.toString();
  try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')); } catch (_) { /* sandboxed */ }
  // Move focus into the overlay so keyboard / screen-reader users land on
  // the primary action when the bail lands them on the mobile overlay.
  // Only fires when the overlay is actually visible (getBoundingClientRect
  // width > 0), which is desktop-safe — the media query hides it there.
  restoreDeviceChoice();
})();

var trailerModal = document.getElementById('trailer-modal');
var trailerVideo = document.getElementById('trailer-video');
var trailerCloseBtn = document.getElementById('trailer-close-btn');
var watchTrailerBtn = document.getElementById('watch-trailer-btn');

function openTrailer() {
  if (!trailerModal.classList.contains('hidden')) return;
  trailerModal.classList.remove('hidden');
  trailerModal.removeAttribute('inert');
  // play() may reject if the browser blocks autoplay without user gesture;
  // the click itself counts as a gesture so this normally succeeds.
  var p = trailerVideo.play();
  if (p && typeof p.catch === 'function') p.catch(function() {});
  document.addEventListener('keydown', onTrailerKeydown);
  trailerCloseBtn.focus();
}

function closeTrailer() {
  trailerModal.classList.add('hidden');
  trailerModal.setAttribute('inert', '');
  trailerVideo.pause();
  trailerVideo.currentTime = 0;
  document.removeEventListener('keydown', onTrailerKeydown);
  // WCAG 2.4.3 — return focus to the trigger when the dialog closes.
  watchTrailerBtn.focus();
}

function onTrailerKeydown(e) {
  if (e.key === 'Escape') closeTrailer();
}

if (watchTrailerBtn) {
  watchTrailerBtn.addEventListener('click', openTrailer);
  trailerCloseBtn.addEventListener('click', closeTrailer);
  trailerModal.addEventListener('click', function(e) {
    if (e.target === trailerModal) closeTrailer();
  });
}

// --- Button Event Listeners ---
newGameBtn.addEventListener('click', function() {
  // Trailer modal is fixed-position and not focus-trapped, so a keyboard
  // user can Shift+Tab past it and activate START underneath. Close it so
  // it doesn't float over the lobby.
  closeTrailer();
  initMusic();
  if (!document.fullscreenElement) {
    enterFullscreen();
  }

  if (preCreatedRoom) {
    var pre = preCreatedRoom;
    preCreatedRoom = null;
    // applyRoomCreated shows the lobby and paints the QR synchronously.
    applyRoomCreated(pre.roomCode, pre.joinUrl);
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

// Goodbye on intentional close/navigate-away: tear the room down on the
// relay. Every controller gets a 4001 "room closed" (its terminal
// party-over signal) and GET /room/:code turns 404 right away, so stale
// rejoin links die with the room. Best-effort: pagehide also fires on
// bfcache freeze (iOS Safari) where the send may not complete before the
// page is frozen; controllers then fall back to their display-gone flow
// (reconnect overlay, then their own bail). In test/gallery mode `party`
// may be a minimal stub (or the AirConsole adapter, where the SDK owns
// session end), so each call is guarded.
window.addEventListener('pagehide', function() {
  if (!party) return;
  if (typeof party.closeRoom === 'function') {
    try { party.closeRoom(); } catch (_) {}
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
  var res = roomCore.setMuted(next);
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
  // Publish so the host controller's Game Music toggle reflects changes made
  // via the display's own mute button, and so a newly-promoted host opening
  // the settings popup sees the correct state without a page reload.
  publishAs(res.publish);
}

muteBtn.addEventListener('click', function() {
  setDisplayMuted(!muted);
});

// --- Fullscreen ---
// iPhone Safari ships no element Fullscreen API, so the method is missing
// rather than failing: it throws on call instead of returning a rejecting
// promise, and .catch() never gets the chance to swallow it.
function enterFullscreen() {
  if (!document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen().catch(function() {});
}
function leaveFullscreen() {
  if (!document.exitFullscreen) return;
  document.exitFullscreen().catch(function() {});
}
fullscreenBtn.addEventListener('click', function() {
  if (!document.fullscreenElement) {
    enterFullscreen();
  } else {
    leaveFullscreen();
  }
});
document.addEventListener('fullscreenchange', function() {
  fullscreenBtn.setAttribute('aria-checked', document.fullscreenElement ? 'true' : 'false');
});

// --- Pause (display-side buttons) ---
// While auto-paused these move the OVERLAY only, never the pause: there is nothing
// left to pause, and resuming is the returning player's business, not the
// operator's. Raising it is what puts New Game / Return-to-lobby within reach of a
// mouse; the TVs bind that action to a remote button instead. Outside an
// auto-pause both fall through to the shared state machine, which refuses anything
// that isn't the host's to do.
pauseBtn.addEventListener('click', function() {
  if (pauseReason === PAUSE.AUTO) { showPauseOverlay(); return; }
  pauseGame();
});

pauseContinueBtn.addEventListener('click', function() {
  if (pauseReason === PAUSE.AUTO) { hidePauseOverlay(); return; }
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
// Read the build version from the <meta name="app-version"> tag baked into
// the HTML by server/index.js (web flow) or build-airconsole.sh (AC zip).
// Skipped in AirConsole — display-airconsole.js handles its own label via
// injectVersionLabel.
if (!document.body.classList.contains('airconsole')) {
  var versionMeta = document.querySelector('meta[name="app-version"]');
  var label = versionMeta ? versionMeta.getAttribute('content') : '';
  var welcomeVersion = document.getElementById('welcome-version-label');
  if (welcomeVersion) welcomeVersion.textContent = label;
  var lobbyVersion = document.getElementById('lobby-version-label');
  if (lobbyVersion) lobbyVersion.textContent = label;
}

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
  // Suppress the tint in adclip captures: the radial glow reads as a
  // distracting coloured halo behind the lobby chrome and JPEG/H.264
  // re-introduces banding the encoder can't be talked out of. A flat
  // backdrop with the falling pieces is cleaner for the trailer.
  var adclipMode = urlParams.get('adclip') === '1';
  welcomeBg = new WelcomeBackground(bgCanvas, 15, {
    cx: 0.5, cy: 0.3,
    tint: rgbVar('--accent-primary-rgb'),
    bg:   rgbVar('--bg-primary-rgb'),
    alpha: adclipMode ? 0 : 0.06,
    stopEnd: 0.55,
  });
  welcomeBg.resize(window.innerWidth, window.innerHeight);
  welcomeBg.start();
}

// --- Debug or normal init ---
var _scenarioParam = urlParams.get('scenario');
if (window.__TEST__ && (debugCount > 0 || _scenarioParam)) {
  var _hostParam = urlParams.get('host');
  // Honour players=0 explicitly (adclip lobby starts empty and pops players
  // in via the clip script). The OR-fallback would coerce 0 to 1.
  var _playersRaw = urlParams.get('players');
  var _playersParsed = _playersRaw === null ? NaN : parseInt(_playersRaw, 10);
  initScenario({
    scenario: _scenarioParam || 'playing',
    players: debugCount || (isNaN(_playersParsed) ? 1 : _playersParsed),
    level: parseInt(urlParams.get('level'), 10) || 1,
    host: _hostParam === null ? null : parseInt(_hostParam, 10),
    // Named GalleryFixtures board variant (lv1/lv8/lv12/2p/3p/4p) for the
    // cross-platform gallery rows; overrides players/level when present.
    variant: urlParams.get('variant') || null,
    // names=long swaps the roster to the 16-char LONG_NAMES fixture
    // (the lobby-long-names gallery row).
    names: urlParams.get('names') || null
  });
} else if (urlParams.get('test') === '1' || urlParams.get('adclip') === '1') {
  // Test / adclip mode: skip relay connection — driven externally
  fetchBaseUrl();
} else {
  fetchBaseUrl();
  connectAndCreateRoom();
}
