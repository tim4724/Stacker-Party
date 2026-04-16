'use strict';

// =====================================================================
// Controller Game — game screens, touch input, feedback, results
// Depends on: ControllerState.js (globals), ControllerConnection.js (sendToDisplay)
// Called by: controller.js (message handlers)
// =====================================================================

// =====================================================================
// Lobby / Welcome
// =====================================================================

function updateControllerModeUI(mode) {
  var opts = document.querySelectorAll('#mode-selector .mode-option');
  for (var i = 0; i < opts.length; i++) {
    opts[i].classList.toggle('selected', opts[i].getAttribute('data-mode') === mode);
  }
  if (welcomeBg) welcomeBg.setMode(mode);
  var link = document.querySelector('link[rel="icon"]');
  if (link) link.href = mode === 'hex' ? '/favicon-hex.svg' : '/favicon-classic.svg';
}

function updateLevelDisplay() {
  if (levelDisplay) levelDisplay.textContent = startLevel;
  if (levelMinusBtn) levelMinusBtn.disabled = startLevel <= 1;
  if (levelPlusBtn) levelPlusBtn.disabled = startLevel >= 15;
}

function showLobbyUI() {
  clearTimeout(gameoverButtonsTimer);
  gameoverButtonsReady = false;
  playerIdentity.style.setProperty('--player-color', playerColor);
  playerIdentityName.textContent = playerName || t('player');
  updateLevelDisplay();

  startBtn.classList.remove('hidden');
  startBtn.disabled = false;
  setWaitingActionMessage('');
  updateStartButton();
  statusText.textContent = '';
  statusDetail.textContent = '';

  showScreen('lobby');
}

function updateStartButton() {
  startBtn.textContent = t('start_n_players', { count: playerCount });
}

function setWaitingActionMessage(message) {
  waitingActionText.textContent = message || '';
  waitingActionText.classList.toggle('hidden', !message);
}

// =====================================================================
// Message Handlers
// =====================================================================

function onWelcome(data) {
  playerColor = data.playerColor || PLAYER_COLORS[0];
  playerCount = data.playerCount || 1;
  gameCancelled = false;
  waitingForNextGame = false;

  if (party) party.resetReconnectCount();
  startPing();
  clearTimeout(disconnectedTimer);
  reconnectOverlay.classList.add('hidden');

  playerName = data.playerName || playerName || t('player');
  playerNameEl.textContent = playerName;
  touchArea.setAttribute('data-player-name', playerName);
  if (data.startLevel != null) startLevel = data.startLevel;

  if (data.gameMode) updateControllerModeUI(data.gameMode);
  if (data.locale) { setLocale(data.locale); translatePage(); }

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
  if (data.gameMode) updateControllerModeUI(data.gameMode);
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

function onGamePaused() {
  gameScreen.classList.add('paused');
  pauseOverlay.classList.remove('hidden');
  pauseBtn.disabled = true;
  pauseStatus.textContent = '';
  pauseButtons.classList.remove('hidden');
}

function onGameResumed() {
  gameScreen.classList.remove('paused');
  pauseOverlay.classList.add('hidden');
  pauseBtn.disabled = false;
}

// =====================================================================
// Results
// =====================================================================

var gameoverButtonsReady = false;
var gameoverButtonsTimer = null;

function renderGameResults(results) {
  resultsList.innerHTML = '';
  gameoverButtons.classList.remove('hidden');
  gameoverButtons.style.opacity = '0';
  gameoverButtons.style.pointerEvents = 'none';
  gameoverStatus.textContent = '';
  gameoverButtonsReady = false;
  clearTimeout(gameoverButtonsTimer);
  gameoverButtonsTimer = setTimeout(function() {
    gameoverButtonsTimer = null;
    gameoverButtons.style.opacity = '';
    gameoverButtons.style.pointerEvents = '';
    gameoverButtonsReady = true;
  }, 2000);

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
      rankEl.textContent = tOrdinal(r.rank);
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
