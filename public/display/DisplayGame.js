'use strict';

// =====================================================================
// Display Game — game lifecycle, event handlers, audio
// Depends on: DisplayState.js (globals), DisplayConnection.js (broadcastLobbyUpdate, showDisconnectQR)
// Called by: display.js (message handlers and UI buttons)
// =====================================================================

// Wake Lock — prevent screen sleep during active games
function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then(function(lock) {
    wakeLock = lock;
    lock.addEventListener('release', function() { wakeLock = null; });
  }).catch(function() {});
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(function() {});
    wakeLock = null;
  }
}

function startGame() {
  if (roomState !== ROOM_STATE.LOBBY) return;
  if (players.size < 1) return;
  startNewGame();
}

function playAgain() {
  if (roomState !== ROOM_STATE.RESULTS) return;
  if (players.size < 1) return;
  startNewGame();
}

function startNewGame() {
  stopDisplayGame();
  paused = false;
  autoPaused = false;
  lastResults = null;
  lastAliveState = {};
  // Add late joiners to playerOrder (preserving existing order)
  for (const id of players.keys()) {
    if (playerOrder.indexOf(id) < 0) playerOrder.push(id);
  }
  setRoomState(ROOM_STATE.COUNTDOWN);
  acquireWakeLock();

  startCountdown(function() {
    setRoomState(ROOM_STATE.PLAYING);
    party.broadcast({ type: MSG.GAME_START });
    runGameLocally();

    // Show disconnect QR for any players that disconnected during countdown
    for (const entry of players) {
      if (entry[1].lastPingTime && Date.now() - entry[1].lastPingTime > GameConstants.LIVENESS_TIMEOUT_MS) {
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

function clearCountdownTimers() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (goTimeout) { clearTimeout(goTimeout); goTimeout = null; }
  if (goOverlayTimer) { clearTimeout(goOverlayTimer); goOverlayTimer = null; }
}

function pauseGame() {
  if (paused) return;
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  paused = true;
  if (roomState === ROOM_STATE.COUNTDOWN) {
    clearCountdownTimers();
  }
  party.broadcast({ type: MSG.GAME_PAUSED });
  onGamePaused();
}

// Check if all game participants are disconnected — auto-pause if so
function allPlayersDisconnected() {
  for (var i = 0; i < playerOrder.length; i++) {
    if (!disconnectedQRs.has(playerOrder[i])) return false;
  }
  return playerOrder.length > 0;
}

function checkAllPlayersDisconnected() {
  if (roomState !== ROOM_STATE.PLAYING && roomState !== ROOM_STATE.COUNTDOWN) return;
  if (paused) return;
  if (!allPlayersDisconnected()) return;
  // Silent pause — no overlay, no broadcast (all controllers are gone)
  paused = true;
  autoPaused = true;
  if (roomState === ROOM_STATE.COUNTDOWN) clearCountdownTimers();
  if (displayGame) displayGame.pause();
  if (music) music.pause();
}

function checkAutoResume() {
  if (!autoPaused) return;
  autoPaused = false;
  resumeGame();
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
  if (roomState === ROOM_STATE.LOBBY) return;
  clearCountdownTimers();
  countdownCallback = null;
  countdownRemaining = 0;
  paused = false;
  autoPaused = false;
  releaseWakeLock();

  if (music) music.stop();
  stopDisplayGame();

  // Remove disconnected players
  var disconnectedIds = [];
  for (const entry of players) {
    if (entry[1].lastPingTime && Date.now() - entry[1].lastPingTime > GameConstants.LIVENESS_TIMEOUT_MS) {
      disconnectedIds.push(entry[0]);
    }
  }

  for (var i = 0; i < disconnectedIds.length; i++) {
    players.delete(disconnectedIds[i]);
    playerOrder = playerOrder.filter(function(id) { return id !== disconnectedIds[i]; });
  }

  // Add late joiners to playerOrder (preserving existing order)
  for (const id of players.keys()) {
    if (playerOrder.indexOf(id) < 0) playerOrder.push(id);
  }

  lastResults = null;
  lastAliveState = {};
  setRoomState(ROOM_STATE.LOBBY);

  broadcastLobbyUpdate();
  party.broadcast({ type: MSG.RETURN_TO_LOBBY, playerCount: players.size });

  returnToLobbyUI();
}

function returnToLobbyUI() {
  var wasInGame = currentScreen === SCREEN.GAME || currentScreen === SCREEN.RESULTS;
  gameState = null;
  prevFrameTime = 0;
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  showScreen(SCREEN.LOBBY);
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
    displayGame = null;
  }
  for (const entry of softDropTimers) {
    clearTimeout(entry[1]);
  }
  softDropTimers.clear();
  lastHardDropTime.clear();
  garbageDefenceEffects.clear();
  clearCountdownTimers();
}

function runGameLocally() {
  stopDisplayGame();

  var Game = window.GameEngine.Game;
  // Sort by slot index so game engine order matches board positions
  playerOrder.sort(function(a, b) {
    return (players.get(a)?.playerIndex ?? 0) - (players.get(b)?.playerIndex ?? 0);
  });
  // Snapshot playerOrder at game start — prevents mid-game layout drift
  playerOrder = playerOrder.slice();
  var gamePlayers = new Map();
  for (var i = 0; i < playerOrder.length; i++) {
    var pInfo = players.get(playerOrder[i]);
    gamePlayers.set(playerOrder[i], { startLevel: (pInfo && pInfo.startLevel) || 1 });
  }

  var seed = (Math.random() * 0xFFFFFFFF) >>> 0;

  displayGame = new Game(gamePlayers, {
    onEvent: function(event) {
      if (event.type === 'line_clear') {
        onLineClear(event);
        var snap = displayGame.getSnapshot();
        var p = snap.players.find(function(pl) { return pl.id === event.playerId; });
        if (p) {
          party.sendTo(event.playerId, {
            type: MSG.PLAYER_STATE,
            level: p.level, lines: p.lines,
            alive: p.alive, garbageIncoming: p.pendingGarbage || 0
          });
        }
      } else if (event.type === 'player_ko') {
        onPlayerKO(event);
        lastAliveState[event.playerId] = false;
        party.sendTo(event.playerId, { type: MSG.PLAYER_STATE, alive: false });
        party.sendTo(event.playerId, { type: MSG.GAME_OVER });
      } else if (event.type === 'piece_lock') {
        onPieceLock(event);
      } else if (event.type === 'garbage_cancelled') {
        onGarbageCancelled(event);
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
          if (pInfo) {
            r.playerName = pInfo.playerName;
            r.playerColor = pInfo.playerColor;
          }
        }
      }
      setRoomState(ROOM_STATE.RESULTS);
      lastResults = results;
      party.broadcast({ type: MSG.GAME_END, elapsed: results.elapsed, results: results.results });
      onGameEnd(results);
    }
  }, seed, gameMode);

  displayGame.init();
}

// =====================================================================
// Display-side Event Handlers (rendering)
// =====================================================================

function onCountdownDisplay(value) {
  gameState = null;
  if (currentScreen !== SCREEN.GAME) {
    history.pushState({ screen: 'game' }, '');
  }
  showScreen(SCREEN.GAME);
  clearTimeout(cursorTimer);
  cursorTimer = null;
  document.body.classList.add('cursor-hidden');
  gameToolbar.classList.add('toolbar-autohide');
  countdownOverlay.classList.remove('hidden');
  countdownOverlay.textContent = value;
  playCountdownBeep(value === 'GO');
  if (value === 'GO') {
    if (music && !music.playing) {
      music.start();
      if (muted) music.masterGain.gain.setValueAtTime(0, music.ctx.currentTime);
    }
    goOverlayTimer = setTimeout(function() {
      goOverlayTimer = null;
      countdownOverlay.classList.add('hidden');
      countdownOverlay.textContent = '';
    }, 400);
  }
}

function onLineClear(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  var isQuad = msg.lines === 4;
  if (br instanceof HexBoardRenderer) {
    animations.addHexCellClear(br, msg.clearCells || [], msg.lines);
  } else {
    animations.addLineClear(br.x, br.y, br.cellSize, msg.rows || [], isQuad);
  }
}

function onGarbageCancelled(msg) {
  // The pending garbage count is already reduced in the engine;
  // the next getSnapshot() in renderLoop will update the meter.

  // Compute where the cancelled rows were on the meter.
  // gameState still has the previous frame's snapshot.
  var oldPending = 0;
  if (gameState && gameState.players) {
    for (var i = 0; i < gameState.players.length; i++) {
      if (gameState.players[i].id === msg.playerId) {
        oldPending = gameState.players[i].pendingGarbage || 0;
        break;
      }
    }
  }
  var cancelledLines = Math.min(msg.lines, oldPending);
  if (cancelledLines > 0) {
    // Top-down coords (row 0 = top of board). The meter occupies
    // rows (VISIBLE_HEIGHT - oldPending) through VISIBLE_HEIGHT-1. The meter shrinks from the top,
    // so flash the rows that disappear at the top of the old meter.
    var rowStart = GameConstants.VISIBLE_HEIGHT - oldPending;
    var existing = garbageDefenceEffects.get(msg.playerId) || [];
    existing.push({
      startTime: performance.now(),
      duration: 400,
      maxAlpha: 0.9,
      lines: cancelledLines,
      rowStart: rowStart
    });
    garbageDefenceEffects.set(msg.playerId, existing);
  }

  // Clear stale indicator effects since garbage was defended.
  var effects = garbageIndicatorEffects.get(msg.playerId);
  if (effects && effects.length > 0) {
    var remaining = msg.lines;
    while (remaining > 0 && effects.length > 0) {
      var front = effects[0];
      if (front.lines <= remaining) {
        remaining -= front.lines;
        effects.shift();
      } else {
        front.lines -= remaining;
        front.rowStart += remaining;
        remaining = 0;
      }
    }
    garbageIndicatorEffects.set(msg.playerId, effects);
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
    rowStart: Math.max(0, GameConstants.VISIBLE_HEIGHT - msg.lines)
  });
  garbageIndicatorEffects.set(msg.toId, shifted);
}

function onPieceLock(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  var isNeon = br.styleTier === STYLE_TIERS.NEON_FLAT;
  var colors = isNeon ? NEON_PIECE_COLORS : PIECE_COLORS;
  var pieceColor = colors[msg.typeId] || '#ffffff';
  if (br instanceof HexBoardRenderer) {
    // Convert hex block positions to pixel coordinates for sparkles
    animations.addHexLockFlash(br, msg.blocks, pieceColor);
  } else {
    animations.addLockFlash(br.x, br.y, br.cellSize, msg.blocks, pieceColor);
  }
}

function onPlayerKO(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  animations.addKO(br.x, br.y, br.boardWidth, br.boardHeight, br.cellSize);
}

function onGameEnd(msg) {
  if (music) music.stop();
  releaseWakeLock();
  stopDisplayGame();
  prevFrameTime = 0;
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  renderResults(msg.results);
  showScreen(SCREEN.RESULTS);
}

function onGamePaused() {
  if (displayGame) displayGame.pause();
  pauseOverlay.classList.remove('hidden');
  gameToolbar.classList.add('hidden');
  if (music) music.pause();
}

function onGameResumed() {
  if (displayGame) displayGame.resume();
  pauseOverlay.classList.add('hidden');
  if (currentScreen === SCREEN.GAME) {
    gameToolbar.classList.remove('hidden');
  }
  if (countdownOverlay.textContent) {
    countdownOverlay.classList.remove('hidden');
  } else if (music) {
    music.resume();
  }
}

// Music & Audio — see DisplayAudio.js
