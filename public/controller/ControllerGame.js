'use strict';

// =====================================================================
// Controller Game — game screens, touch input, feedback, results
// Depends on: ControllerState.js (globals), ControllerConnection.js (sendToDisplay)
// Called by: controller.js (message handlers)
// =====================================================================

// =====================================================================
// Lobby / Welcome
// =====================================================================

function showLobbyUI() {
  playerIdentity.style.setProperty('--player-color', playerColor);
  playerIdentityName.textContent = playerName || 'Player';

  if (isHost) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = false;
    setWaitingActionMessage('');
    updateStartButton();
    statusText.textContent = '';
    statusDetail.textContent = '';
  } else {
    startBtn.classList.add('hidden');
    setWaitingActionMessage('Waiting for host to start...');
    statusText.textContent = '';
    statusDetail.textContent = '';
  }

  showScreen('lobby');
}

function updateStartButton() {
  startBtn.textContent = 'START (' + playerCount + (playerCount === 1 ? ' player)' : ' players)');
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
  isHost = !!data.isHost;
  playerCount = data.playerCount || 1;
  gameCancelled = false;

  if (party) party.resetReconnectCount();
  clearTimeout(disconnectedTimer);
  reconnectOverlay.classList.add('hidden');

  playerName = data.playerName || playerName || 'Player';
  playerNameEl.textContent = playerName;

  if (data.roomState === 'playing' || data.roomState === 'countdown') {
    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    gameScreen.style.setProperty('--player-color', playerColor);
    removeKoOverlay();
    if (compassHints) {
      clearTimeout(hintsFadeTimer);
      hintsFadeTimer = null;
      hintsSawLeft = false;
      hintsSawRight = false;
      compassHints.classList.remove('faded');
    }

    if (data.paused) {
      onGamePaused();
    } else {
      pauseOverlay.classList.add('hidden');
      pauseBtn.classList.toggle('hidden', !isHost);
    }

    if (data.alive === false) {
      gameScreen.classList.add('dead');
      showKoOverlay();
    }

    showScreen('game');
    initTouchInput();
    return;
  }

  if (data.roomState === 'results' && lastGameResults) {
    renderGameResults(lastGameResults);
    showScreen('gameover');
    return;
  }

  showLobbyUI();
}

function onLobbyUpdate(data) {
  playerCount = data.playerCount;
  if (typeof data.isHost === 'boolean') {
    isHost = data.isHost;
  }
  if (isHost) updateStartButton();
}

function onGameStart() {
  ControllerAudio.tick();
  lastLines = 0;
  if (compassHints) {
    clearTimeout(hintsFadeTimer);
    hintsFadeTimer = null;
    hintsSawLeft = false;
    hintsSawRight = false;
    compassHints.classList.remove('faded');
  }
  gameScreen.classList.remove('dead');
  gameScreen.classList.remove('paused');
  gameScreen.classList.remove('countdown');
  gameScreen.style.setProperty('--player-color', playerColor);
  removeKoOverlay();
  reconnectOverlay.classList.add('hidden');
  pauseOverlay.classList.add('hidden');
  pauseBtn.disabled = false;
  pauseBtn.classList.toggle('hidden', !isHost);
  showScreen('game');
  initTouchInput();
}

function onPlayerState(data) {
  if (!touchInput) {
    gameScreen.classList.remove('countdown');
    pauseBtn.disabled = false;
    pauseBtn.classList.toggle('hidden', !isHost);
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
  if (data.code === 'HOST_DISCONNECTED') {
    showErrorState('', 'Host disconnected');
    return;
  }
  if (data.message === 'Room not found' || data.message === 'Room is full') {
    showRoomGone();
    return;
  }
  showErrorState('', data.message || 'Unknown error');
}

// =====================================================================
// Pause
// =====================================================================

function onGamePaused() {
  gameScreen.classList.add('paused');
  pauseOverlay.classList.remove('hidden');
  pauseBtn.classList.add('hidden');
  pauseStatus.textContent = '';
  pauseButtons.classList.toggle('hidden', !isHost);
}

function onGameResumed() {
  gameScreen.classList.remove('paused');
  pauseOverlay.classList.add('hidden');
  if (isHost) {
    pauseBtn.classList.remove('hidden');
  }
}

// =====================================================================
// Results
// =====================================================================

function renderGameResults(results) {
  resultsList.innerHTML = '';
  gameoverButtons.classList.toggle('hidden', !isHost);
  gameoverStatus.textContent = isHost ? '' : 'Waiting for host...';

  var winnerColor = 'rgba(255, 215, 0, 0.06)';
  if (results && results.length) {
    var winner = results.find(function(r) { return r.rank === 1; });
    if (winner) {
      var wc = winner.playerColor || PLAYER_COLORS[0];
      winnerColor = 'color-mix(in srgb, ' + wc + ' 8%, transparent)';
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
      rankEl.textContent = r.rank <= 3 ? ['', '1st', '2nd', '3rd'][r.rank] : r.rank + 'th';
      row.appendChild(rankEl);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    nameEl.textContent = r.playerName || 'Player';
    nameEl.style.color = pColor;

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    stats.innerHTML = '<span>' + (r.score || 0).toLocaleString() + ' points</span><span>' + (r.lines || 0) + ' lines</span><span>Lv ' + (r.level || 1) + '</span>';

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
  ko.textContent = 'KO';
  touchArea.appendChild(ko);
}

function removeKoOverlay() {
  var el = document.getElementById('ko-overlay');
  if (el) el.remove();
}

// =====================================================================
// Gesture Feedback
// =====================================================================

function createFeedback(type, x, y) {
  var el = document.createElement('div');
  el.className = 'feedback-' + type;
  if (x !== undefined && y !== undefined) {
    var rect = feedbackLayer.getBoundingClientRect();
    el.style.left = (x - rect.left) + 'px';
    el.style.top = (y - rect.top) + 'px';
  }
  feedbackLayer.appendChild(el);
  el.addEventListener('animationend', function () { el.remove(); });
}

function createWash(direction) {
  var el = document.createElement('div');
  el.className = 'feedback-wash feedback-wash-' + direction;
  feedbackLayer.appendChild(el);
  el.addEventListener('animationend', function () { el.remove(); });
}

function removeBuildupEl() {
  if (buildupEl) {
    buildupEl.remove();
    buildupEl = null;
    buildupDir = null;
  }
}

function flashBuildup() {
  if (buildupEl) {
    buildupEl.classList.add('flash');
    var el = buildupEl;
    buildupEl = null;
    buildupDir = null;
    el.addEventListener('animationend', function () { el.remove(); });
  }
}

function onDragProgress(direction, progress) {
  if (!direction || progress <= 0) {
    removeBuildupEl();
    return;
  }
  if (buildupDir !== direction) {
    removeBuildupEl();
    var washDir = direction;
    if (direction === 'left') washDir = 'right';
    else if (direction === 'right') washDir = 'left';
    else if (direction === 'down') washDir = 'up';
    else if (direction === 'up') washDir = 'down';
    buildupEl = document.createElement('div');
    buildupEl.className = 'feedback-buildup feedback-wash-' + washDir;
    feedbackLayer.appendChild(buildupEl);
    buildupDir = direction;
  }
  buildupEl.style.opacity = progress * 0.15;
}

// =====================================================================
// Touch Input
// =====================================================================

function initTouchInput() {
  if (touchInput) {
    touchInput.destroy();
  }

  if (coordTracker) touchArea.removeEventListener('pointerdown', coordTracker);
  coordTracker = function (e) {
    lastTouchX = e.clientX;
    lastTouchY = e.clientY;
  };
  touchArea.addEventListener('pointerdown', coordTracker, { passive: true });

  touchInput = new TouchInput(touchArea, function (action, data) {
    // Fade compass hints after player has used both left and right
    if (compassHints && !compassHints.classList.contains('faded')) {
      if (action === 'left') hintsSawLeft = true;
      if (action === 'right') hintsSawRight = true;
      if (hintsSawLeft && hintsSawRight && !hintsFadeTimer) {
        hintsFadeTimer = setTimeout(function () {
          compassHints.classList.add('faded');
        }, 5000);
      }
    }

    // Gesture feedback
    if (action === 'rotate_cw') {
      ControllerAudio.tick();
      createFeedback('ripple', lastTouchX, lastTouchY);
    } else if (action === 'left' || action === 'right') {
      ControllerAudio.tick();
      if (buildupEl) {
        flashBuildup();
      } else {
        createWash(action === 'left' ? 'right' : 'left');
      }
    } else if (action === 'hard_drop') {
      ControllerAudio.drop();
      removeBuildupEl();
      createWash('up');
    } else if (action === 'hold') {
      ControllerAudio.hold();
      removeBuildupEl();
      createWash('down');
    }

    if (action === 'soft_drop') {
      if (!softDropActive) {
        softDropActive = true;
        ControllerAudio.tick();
        removeBuildupEl();
        softDropWash = document.createElement('div');
        softDropWash.className = 'feedback-wash feedback-wash-up feedback-wash-hold';
        feedbackLayer.appendChild(softDropWash);
      }
      sendToDisplay(MSG.SOFT_DROP, { speed: data && data.speed });
    } else if (action === 'soft_drop_end') {
      softDropActive = false;
      if (softDropWash) {
        var el = softDropWash;
        softDropWash = null;
        el.classList.add('fade-out');
        el.addEventListener('animationend', function () { el.remove(); });
      }
    } else {
      sendToDisplay(MSG.INPUT, { action: action });
    }
  }, onDragProgress);
}
