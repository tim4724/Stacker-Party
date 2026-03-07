'use strict';

// =====================================================================
// Display Game — game lifecycle, event handlers, audio
// Depends on: DisplayState.js (globals), DisplayConnection.js (broadcastLobbyUpdate, showDisconnectQR)
// Called by: display.js (message handlers and UI buttons)
// =====================================================================

function startGame() {
  if (roomState !== ROOM_STATE.LOBBY) return;
  if (players.size < 1) return;
  startNewGame();
}

function playAgain() {
  if (roomState !== ROOM_STATE.RESULTS) return;
  startNewGame();
}

function startNewGame() {
  stopDisplayGame();
  paused = false;
  lastResults = null;
  lastAliveState = {};
  setRoomState(ROOM_STATE.COUNTDOWN);

  startCountdown(function() {
    setRoomState(ROOM_STATE.PLAYING);
    party.broadcast({ type: MSG.GAME_START });
    runGameLocally();

    // Show disconnect QR for any players that disconnected during countdown
    for (var entry of players) {
      if (entry[1].lastPingTime && Date.now() - entry[1].lastPingTime > LIVENESS_TIMEOUT_MS) {
        showDisconnectQR(entry[0]);
      }
    }
  });
}

function startCountdown(onComplete, startFrom) {
  var count = startFrom || GameConstants.COUNTDOWN_SECONDS;
  countdownCallback = onComplete;
  countdownRemaining = count;

  // Broadcast to controllers
  party.broadcast({ type: MSG.COUNTDOWN, value: count });
  // Handle locally on display
  onCountdownDisplay(count);

  countdownTimer = setInterval(function() {
    count--;
    countdownRemaining = count;
    if (count > 0) {
      party.broadcast({ type: MSG.COUNTDOWN, value: count });
      onCountdownDisplay(count);
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      countdownRemaining = 0;
      party.broadcast({ type: MSG.COUNTDOWN, value: 'GO' });
      onCountdownDisplay('GO');
      goTimeout = setTimeout(function() {
        goTimeout = null;
        onComplete();
      }, 500);
    }
  }, 1000);
}

function pauseGame() {
  if (paused) return;
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  paused = true;
  if (roomState === ROOM_STATE.COUNTDOWN) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (goTimeout) { clearTimeout(goTimeout); goTimeout = null; }
  }
  party.broadcast({ type: MSG.GAME_PAUSED });
  onGamePaused();
}

function resumeGame() {
  if (!paused) return;
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  paused = false;
  if (roomState === ROOM_STATE.COUNTDOWN && countdownCallback) {
    party.broadcast({ type: MSG.GAME_RESUMED });
    onGameResumed();
    if (countdownRemaining === 0) {
      party.broadcast({ type: MSG.COUNTDOWN, value: 'GO' });
      onCountdownDisplay('GO');
      goTimeout = setTimeout(function() {
        goTimeout = null;
        countdownCallback();
      }, 500);
    } else {
      startCountdown(countdownCallback, countdownRemaining);
    }
    return;
  }
  party.broadcast({ type: MSG.GAME_RESUMED });
  onGameResumed();
}

function returnToLobby() {
  // Clear countdown state
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (goTimeout) { clearTimeout(goTimeout); goTimeout = null; }
  graceTimers.forEach(clearTimeout);
  graceTimers.clear();
  countdownCallback = null;
  countdownRemaining = 0;
  paused = false;

  if (music) music.stop();
  stopDisplayGame();

  // Remove disconnected players
  var disconnectedIds = [];
  for (var entry of players) {
    if (entry[1].lastPingTime && Date.now() - entry[1].lastPingTime > LIVENESS_TIMEOUT_MS) {
      disconnectedIds.push(entry[0]);
    }
  }

  if (hostId !== null && disconnectedIds.indexOf(hostId) >= 0) {
    setRoomState(ROOM_STATE.LOBBY);
    party.broadcast({ type: MSG.ERROR, code: 'HOST_DISCONNECTED', message: 'Host disconnected' });
    players.clear();
    playerOrder = [];
    playerIndexCounter = 0;
    hostId = null;
    lastAliveState = {};
    updatePlayerList();
    updateStartButton();
    returnToLobbyUI();
    return;
  }

  for (var i = 0; i < disconnectedIds.length; i++) {
    players.delete(disconnectedIds[i]);
    playerOrder = playerOrder.filter(function(id) { return id !== disconnectedIds[i]; });
  }

  lastResults = null;
  lastAliveState = {};
  setRoomState(ROOM_STATE.LOBBY);

  broadcastLobbyUpdate();
  party.broadcast({ type: MSG.RETURN_TO_LOBBY, playerCount: players.size });

  returnToLobbyUI();
}

function returnToLobbyUI() {
  var wasInGame = currentScreen === 'game' || currentScreen === 'results';
  gameState = null;
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  showScreen('lobby');
  updateStartButton();
  if (wasInGame && !popstateNavigating) {
    suppressPopstate = true;
    history.back();
  }
  popstateNavigating = false;
}

// =====================================================================
// Local Game Engine
// =====================================================================

function stopDisplayGame() {
  if (displayGame) {
    displayGame.stop();
    displayGame = null;
  }
  for (var entry of softDropTimers) {
    clearTimeout(entry[1]);
  }
  softDropTimers.clear();
}

function runGameLocally() {
  stopDisplayGame();

  var Game = window.GameEngine.Game;
  var gamePlayers = new Map();
  for (var i = 0; i < playerOrder.length; i++) {
    gamePlayers.set(playerOrder[i], {});
  }

  var seed = (Math.random() * 0xFFFFFFFF) >>> 0;

  displayGame = new Game(gamePlayers, {
    onGameState: function(state) {
      onGameState(state);
      // Relay per-player state to controllers
      if (state.players) {
        for (var k = 0; k < state.players.length; k++) {
          var p = state.players[k];
          party.sendTo(p.id, {
            type: MSG.PLAYER_STATE,
            score: p.score, level: p.level, lines: p.lines,
            alive: p.alive, garbageIncoming: p.pendingGarbage || 0
          });
        }
      }
    },
    onEvent: function(event) {
      if (event.type === 'line_clear') {
        onLineClear(event);
      } else if (event.type === 'player_ko') {
        onPlayerKO(event);
        lastAliveState[event.playerId] = false;
        party.sendTo(event.playerId, { type: MSG.GAME_OVER });
      } else if (event.type === 'garbage_sent') {
        onGarbageSent(event);
      }
    },
    onGameEnd: function(results) {
      // Enrich with player names
      if (results && results.results) {
        for (var j = 0; j < results.results.length; j++) {
          var r = results.results[j];
          var pInfo = players.get(r.playerId);
          if (pInfo) r.playerName = pInfo.playerName;
        }
      }
      setRoomState(ROOM_STATE.RESULTS);
      lastResults = results;
      party.broadcast({ type: MSG.GAME_END, elapsed: results.elapsed, results: results.results });
      onGameEnd(results);
    }
  }, seed);

  displayGame.start();
}

// =====================================================================
// Display-side Event Handlers (rendering)
// =====================================================================

function onCountdownDisplay(value) {
  gameState = null;
  if (currentScreen !== 'game') {
    history.pushState({ screen: 'game' }, '');
  }
  showScreen('game');
  countdownOverlay.classList.remove('hidden');
  countdownOverlay.textContent = value;
  playCountdownBeep(value === 'GO');
  if (value === 'GO') {
    if (music && !music.playing) {
      music.start();
      if (muted) music.masterGain.gain.setValueAtTime(0, music.ctx.currentTime);
    }
    setTimeout(function() {
      countdownOverlay.classList.add('hidden');
      countdownOverlay.textContent = '';
    }, 400);
  }
}

function onGameState(msg) {
  gameState = msg;
  if (msg.players) {
    for (var i = 0; i < msg.players.length; i++) {
      var p = msg.players[i];
      if (playerOrder.indexOf(p.id) < 0) {
        playerOrder.push(p.id);
      }
    }
  }
  if (msg.players && boardRenderers.length !== msg.players.length) {
    calculateLayout();
  }
  if (music && music.playing && msg.players && msg.players.length > 0) {
    var maxLevel = Math.max.apply(null, msg.players.map(function(p) { return p.level || 1; }));
    music.setSpeed(maxLevel);
  }
}

function onLineClear(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  var isTetris = msg.lines === 4;
  animations.addLineClear(br.x, br.y, br.cellSize, msg.rows || [], isTetris, msg.isTSpin);
  if (msg.combo >= 2) {
    animations.addCombo(br.x + br.boardWidth / 2, br.y + br.boardHeight / 2 - 30, msg.combo);
  }
}

function onGarbageSent(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.toId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  var attackerColor = players.get(msg.senderId)?.playerColor || '#ffffff';
  animations.addGarbageShake(br.x, br.y);
  var shifted = (garbageIndicatorEffects.get(msg.toId) || [])
    .map(function(effect) { return { ...effect, rowStart: effect.rowStart - msg.lines }; })
    .filter(function(effect) { return effect.rowStart + effect.lines > 0; });
  shifted.push({
    startTime: performance.now(),
    duration: 1000,
    maxAlpha: 0.94,
    color: attackerColor,
    lines: msg.lines,
    rowStart: Math.max(0, 20 - msg.lines)
  });
  garbageIndicatorEffects.set(msg.toId, shifted);
}

function onPlayerKO(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  animations.addKO(br.x, br.y, br.boardWidth, br.boardHeight);
}

function onGameEnd(msg) {
  if (music) music.stop();
  stopDisplayGame();
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  showScreen('results');
  resultsScreen.style.animation = 'none';
  resultsScreen.offsetHeight;
  resultsScreen.style.animation = '';
  renderResults(msg.results);
}

function onGamePaused() {
  if (displayGame) displayGame.pause();
  pauseOverlay.classList.remove('hidden');
  gameToolbar.classList.add('hidden');
  if (music) music.stop();
}

function onGameResumed() {
  if (displayGame) displayGame.resume();
  pauseOverlay.classList.add('hidden');
  if (currentScreen === 'game') {
    gameToolbar.classList.remove('hidden');
  }
  if (countdownOverlay.textContent) {
    countdownOverlay.classList.remove('hidden');
  } else if (music) {
    music.start();
    if (muted) music.masterGain.gain.setValueAtTime(0, music.ctx.currentTime);
  }
}

// =====================================================================
// Music & Audio
// =====================================================================

function initMusic() {
  if (!music) {
    music = new Music();
  }
  music.init();
  music.muted = muted;
}

function playCountdownBeep(isGo) {
  if (muted) return;
  if (!music || !music.ctx) return;
  var actx = music.ctx;
  if (actx.state === 'suspended') actx.resume();

  var osc = actx.createOscillator();
  var gain = actx.createGain();
  osc.connect(gain);
  gain.connect(actx.destination);

  if (isGo) {
    osc.type = 'square';
    osc.frequency.setValueAtTime(600, actx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, actx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.18, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.3);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.3);
  } else {
    osc.type = 'square';
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0.15, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.12);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.12);
  }
}
