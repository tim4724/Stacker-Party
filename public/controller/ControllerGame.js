'use strict';

// =====================================================================
// Controller Game — game screens, touch input, feedback, results
// Depends on: ControllerState.js (globals), ControllerConnection.js (sendToDisplay)
// Called by: controller.js (message handlers)
// =====================================================================

// =====================================================================
// Lobby / Welcome
// =====================================================================

function updateLevelDisplay() {
  if (levelDisplay) levelDisplay.textContent = startLevel;
  if (levelMinusBtn) levelMinusBtn.disabled = startLevel <= 1;
  if (levelPlusBtn) levelPlusBtn.disabled = startLevel >= 15;
}

// Apply host info from a WELCOME or LOBBY_UPDATE payload, then refresh any
// visible host-gated UI. Safe to call on any screen.
function applyHostInfo(data) {
  if (data.isHost !== undefined) isHost = !!data.isHost;
  if (data.hostName !== undefined) hostName = data.hostName;
  if (data.hostColor !== undefined) hostColor = data.hostColor;
  updateHostVisibility();
}

function updateHostVisibility() {
  // Lobby: host sees Start button, non-host sees waiting banner.
  // Skip when waitingForNextGame — late joiners in an active game sit on
  // the lobby screen with the "game_in_progress" banner already in place;
  // letting the host-gate overwrite it would hide that status.
  if (currentScreen === 'lobby' && !waitingForNextGame) {
    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = false;
      setWaitingActionMessage('');
    } else {
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      renderHostBanner(waitingActionText, 'waiting_for_host_to_start', hostName || t('player'), hostColor);
      waitingActionText.classList.remove('hidden');
    }
  }
  // Results: host sees Play Again / New Game, non-host sees waiting banner.
  // The 1.5s anti-misclick delay is handled by the #gameover-buttons CSS
  // animation (pointer-events: none during the delay), so a concurrent
  // LOBBY_UPDATE mid-delay can't flip the buttons to clickable early — the
  // animation restarts whenever the element transitions from hidden to shown.
  if (currentScreen === 'gameover') {
    if (isHost) {
      gameoverStatus.textContent = '';
      gameoverStatus.style.color = '';
      gameoverButtons.classList.remove('hidden');
    } else {
      gameoverButtons.classList.add('hidden');
      renderHostBanner(gameoverStatus, 'waiting_for_host_to_continue', hostName || t('player'), hostColor);
    }
  }
  // Pause overlay: non-host can still resume, but can't return to lobby.
  if (pauseNewGameBtn) {
    pauseNewGameBtn.classList.toggle('hidden', !isHost);
  }
}

function showLobbyUI() {
  playerIdentity.style.setProperty('--player-color', playerColor);
  playerIdentityName.textContent = playerName || t('player');
  updateLevelDisplay();

  updateStartButton();
  statusText.textContent = '';
  statusDetail.textContent = '';

  showScreen('lobby');
  // Must run after showScreen so currentScreen === 'lobby' when we gate UI.
  updateHostVisibility();
}

function updateStartButton() {
  startBtn.textContent = t('start_n_players', { count: playerCount });
}

function setWaitingActionMessage(message) {
  waitingActionText.textContent = message || '';
  waitingActionText.classList.toggle('hidden', !message);
  waitingActionText.style.color = '';
}

// Render a "Waiting for {name}..." banner with only the player name colored.
// Uses DOM nodes rather than innerHTML so the untrusted name can't inject HTML.
// Everything is wrapped in a single inline span so the parent's `display: flex`
// sees only one flex item — otherwise each text node + name span becomes its
// own item and the text can't wrap naturally between words.
// Assumes each locale string has exactly one {name} placeholder. A template
// with multiple {name} occurrences would split into 3+ parts and only
// parts[0]/parts[1] would render. tests/i18n.test.js ("waiting_for_host
// banner keys contain exactly one {name}") enforces this invariant.
function renderHostBanner(element, key, name, color) {
  element.textContent = '';
  element.style.color = '';
  var wrap = document.createElement('span');
  var tmpl = t(key, { name: '\x00' });
  var parts = tmpl.split('\x00');
  var nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  if (color) nameSpan.style.color = color;
  if (parts.length < 2) {
    // Graceful degrade for a malformed locale: render the template text
    // followed by a space and the name, rather than colliding them.
    console.warn('[renderHostBanner] missing {name} placeholder in locale key:', key);
    wrap.appendChild(document.createTextNode(parts[0] + ' '));
    wrap.appendChild(nameSpan);
  } else {
    wrap.appendChild(document.createTextNode(parts[0]));
    wrap.appendChild(nameSpan);
    wrap.appendChild(document.createTextNode(parts[1]));
  }
  element.appendChild(wrap);
}

// =====================================================================
// Message Handlers
// =====================================================================

function onWelcome(data) {
  playerColor = data.playerColor || PLAYER_COLORS[0];
  document.body.style.setProperty('--player-color', playerColor);
  playerCount = data.playerCount || 1;
  gameCancelled = false;
  waitingForNextGame = false;
  // Set host state first so renderGameResults / showLobbyUI below see it.
  // updateHostVisibility is a no-op on the current screen ('name' or mid-
  // transition) thanks to its screen guards.
  applyHostInfo(data);

  if (party) party.resetReconnectCount();
  startPing();
  clearTimeout(disconnectedTimer);
  reconnectOverlay.classList.add('hidden');

  playerName = data.playerName || playerName || t('player');
  playerNameEl.textContent = playerName;
  touchArea.setAttribute('data-player-name', playerName);
  if (data.startLevel != null) startLevel = data.startLevel;

  if (data.roomState === 'playing' || data.roomState === 'countdown') {
    // Late joiner (not in active game) — display omits alive field
    if (data.alive === undefined) {
      waitingForNextGame = true;
      showLobbyUI();
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      setWaitingActionMessage(t('game_in_progress'));
      return;
    }

    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    gameScreen.classList.remove('countdown');
    gameScreen.style.setProperty('--player-color', playerColor);
    removeKoOverlay();
    if (data.paused) {
      onGamePaused();
    } else {
      pauseOverlay.classList.add('hidden');
      pauseBtn.classList.remove('hidden');
    }

    if (data.alive === false) {
      gameScreen.classList.add('dead');
      showKoOverlay();
    }

    showScreen('game');
    initTouchInput();
    return;
  }

  if (data.roomState === 'results') {
    var reconnectResults = data.results || lastGameResults;
    if (reconnectResults) {
      lastGameResults = reconnectResults;
      renderGameResults(reconnectResults);
      showScreen('gameover');
      return;
    }
    // No results available (e.g. fresh controller joining mid-results) — fall through to lobby
  }

  showLobbyUI();
}

function onLobbyUpdate(data) {
  playerCount = data.playerCount;
  if (data.startLevel != null) startLevel = data.startLevel;
  applyHostInfo(data);
  updateStartButton();
  if (currentScreen === 'lobby') updateLevelDisplay();
}

function onGameStart() {
  ControllerAudio.tick();
  lastLines = 0;
  gameScreen.classList.remove('dead');
  gameScreen.classList.remove('paused');
  gameScreen.classList.remove('countdown');
  gameScreen.style.setProperty('--player-color', playerColor);
  removeKoOverlay();
  reconnectOverlay.classList.add('hidden');
  pauseOverlay.classList.add('hidden');
  pauseBtn.disabled = false;
  pauseBtn.classList.remove('hidden');
  touchArea.setAttribute('data-player-name', playerName);
  showScreen('game');
  initTouchInput();
}

function onPlayerState(data) {
  if (!touchInput) {
    gameScreen.classList.remove('countdown');
    pauseBtn.disabled = false;
    pauseBtn.classList.remove('hidden');
    initTouchInput();
  }
  if (data.lines !== undefined && data.lines > lastLines) {
    ControllerAudio.lineClear(data.lines - lastLines);
  }
  if (data.lines !== undefined) lastLines = data.lines;
  if (data.alive === false && !gameScreen.classList.contains('dead')) {
    gameScreen.classList.add('dead');
    showKoOverlay();
  }
}

function onGameEnd(data) {
  lastGameResults = data.results;
  renderGameResults(data.results);
  showScreen('gameover');
}

function onError(data) {
  if (data.message === 'Room not found') {
    showEndScreen('room_not_found');
    return;
  }
  if (data.message === 'Room is full') {
    showEndScreen('game_full');
    return;
  }
  showEndScreen();
}

// =====================================================================
// Pause
// =====================================================================

var selfPausing = false;
var selfPausingTimer = null;

function onGamePaused() {
  gameScreen.classList.add('paused');
  pauseOverlay.classList.toggle('pause-overlay--self', selfPausing);
  selfPausing = false;
  clearTimeout(selfPausingTimer);
  pauseOverlay.classList.remove('hidden');
  pauseBtn.disabled = true;
  pauseStatus.textContent = '';
  pauseButtons.classList.remove('hidden');
}

function onGameResumed() {
  gameScreen.classList.remove('paused');
  pauseOverlay.classList.add('hidden');
  pauseOverlay.classList.remove('pause-overlay--self');
  pauseBtn.disabled = false;
}

// =====================================================================
// Results
// =====================================================================

// The 1.5s anti-misclick delay and fade-in are purely CSS — see the
// `resultsButtonsEnter` animation on #gameover-buttons. pointer-events stays
// `none` until the animation fires, so stray taps before buttons are visible
// can't reach the click handlers.
function renderGameResults(results) {
  resultsList.innerHTML = '';
  gameoverStatus.textContent = '';
  gameoverStatus.style.color = '';
  if (isHost) {
    gameoverButtons.classList.remove('hidden');
  } else {
    gameoverButtons.classList.add('hidden');
    renderHostBanner(gameoverStatus, 'waiting_for_host_to_continue', hostName || t('player'), hostColor);
  }

  var winnerColor = 'rgba(255, 215, 0, 0.06)';
  if (results && results.length) {
    var winner = results.find(function(r) { return r.rank === 1; });
    if (winner) {
      var wc = winner.playerColor || PLAYER_COLORS[0];
      winnerColor = rgbaFromHex(wc, 0.08);
    }
  }
  gameoverScreen.style.setProperty('--winner-glow', winnerColor);

  if (playerColor) {
    gameoverScreen.style.setProperty('--me-color', playerColor);
  }

  if (!results || !results.length) return;

  var sorted = results.slice().sort(function(a, b) { return a.rank - b.rank; });
  var solo = sorted.length === 1;
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    var pColor = r.playerColor || PLAYER_COLORS[i % PLAYER_COLORS.length];

    var row = document.createElement('div');
    row.className = solo ? 'result-row' : 'result-row rank-' + r.rank;
    row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');
    if (r.playerId === clientId) row.classList.add('is-me');

    if (!solo) {
      var rankEl = document.createElement('span');
      rankEl.className = 'result-rank';
      rankEl.textContent = String(r.rank);
      rankEl.style.color = pColor;
      row.appendChild(rankEl);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    nameEl.textContent = r.playerName || t('player');
    nameEl.style.color = pColor;

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    stats.innerHTML = '<span>' + t('n_lines', { count: r.lines || 0 }) + '</span><span>' + t('level_n', { level: r.level || 1 }) + '</span>';

    info.appendChild(nameEl);
    info.appendChild(stats);
    row.appendChild(info);
    resultsList.appendChild(row);
  }
}

// =====================================================================
// KO Overlay
// =====================================================================

function showKoOverlay() {
  removeKoOverlay();
  var ko = document.createElement('div');
  ko.id = 'ko-overlay';
  ko.textContent = t('ko');
  touchArea.appendChild(ko);
}

function removeKoOverlay() {
  var el = document.getElementById('ko-overlay');
  if (el) el.remove();
}

// =====================================================================
// Gesture Feedback — glow that follows finger
// =====================================================================

var GLOW_SIZE = 100;
var GLOW_OPACITY = 0.36;
var GLOW_GROW = 0.15;
var _feedbackRect = null;
window.addEventListener('resize', function() { _feedbackRect = null; });

function showGlow(x, y, progress) {
  if (!glowEl) {
    glowEl = document.createElement('div');
    glowEl.className = 'feedback-glow';
    feedbackLayer.appendChild(glowEl);
  }
  if (!_feedbackRect) _feedbackRect = feedbackLayer.getBoundingClientRect();
  var lx = x - _feedbackRect.left;
  var ly = y - _feedbackRect.top;
  var p = progress || 0;
  var scale = 1 + p * GLOW_GROW;
  glowEl.style.transform = 'translate(' + (lx - GLOW_SIZE / 2) + 'px,' + (ly - GLOW_SIZE / 2) + 'px) scale(' + scale + ')';
  glowEl.style.opacity = GLOW_OPACITY;
}

function hideGlow() {
  if (glowEl) { glowEl.remove(); glowEl = null; }
}

function flashGlow() {
  if (glowEl) {
    var el = glowEl;
    glowEl = null;
    el.animate([{ opacity: GLOW_OPACITY }, { opacity: 0 }], { duration: 150, easing: 'ease-out' });
    setTimeout(function () { if (el.parentNode) el.remove(); }, 170);
  }
}

function onDragProgress(direction, progress) {
  // Glow position is updated via pointermove coordTracker — nothing extra needed here
}

// =====================================================================
// Touch Input
// =====================================================================

function initTouchInput() {
  if (touchInput) {
    touchInput.destroy();
  }

  if (coordTracker) {
    touchArea.removeEventListener('pointerdown', coordTracker);
    touchArea.removeEventListener('pointermove', coordTracker);
    touchArea.removeEventListener('pointerup', coordTracker);
  }

  var anchorX = 0, anchorY = 0;

  coordTracker = function (e) {
    lastTouchX = e.clientX;
    lastTouchY = e.clientY;
    if (e.type === 'pointerdown') {
      _feedbackRect = feedbackLayer.getBoundingClientRect();
      anchorX = e.clientX;
      anchorY = e.clientY;
      showGlow(e.clientX, e.clientY, 0);
    } else if (e.type === 'pointermove') {
      var dx = e.clientX - anchorX;
      var dy = e.clientY - anchorY;
      var dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
      var axisDist = dir === 'h' ? Math.abs(dx) : Math.abs(dy);
      var progress = Math.min(axisDist / 48, 1);
      showGlow(e.clientX, e.clientY, progress);
    } else if (e.type === 'pointerup') {
      hideGlow();
    }
  };
  touchArea.addEventListener('pointerdown', coordTracker, { passive: true });
  touchArea.addEventListener('pointermove', coordTracker, { passive: true });
  touchArea.addEventListener('pointerup', coordTracker, { passive: true });

  touchInput = new TouchInput(touchArea, function (action, data) {
    // Gesture feedback
    if (action === 'rotate_cw') {
      ControllerAudio.tick();
      // Tap: flash the existing glow and fade out
      flashGlow();
    } else if (action === 'left' || action === 'right') {
      ControllerAudio.tick();
    } else if (action === 'hard_drop') {
      ControllerAudio.drop();
    } else if (action === 'hold') {
      ControllerAudio.hold();
    }

    if (action === 'soft_drop') {
      if (!softDropActive) {
        softDropActive = true;
        ControllerAudio.tick();
      }
      sendToDisplay(MSG.SOFT_DROP, { speed: data && data.speed });
    } else if (action === 'soft_drop_end') {
      softDropActive = false;
    } else {
      sendToDisplay(MSG.INPUT, { action: action });
    }
  }, onDragProgress);

  // Reset anchor on each ratchet trigger — listen for input actions to reset
  var origOnInput = touchInput.onInput;
  var wrappedOnInput = function (action, data) {
    if (action === 'left' || action === 'right' || action === 'hard_drop' || action === 'hold') {
      anchorX = lastTouchX;
      anchorY = lastTouchY;
    }
    origOnInput(action, data);
  };
  touchInput.onInput = wrappedOnInput;
}
