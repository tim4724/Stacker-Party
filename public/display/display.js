'use strict';

// =====================================================================
// Display Entry Point — message dispatch, render loop, results, UI, init
// Depends on: DisplayState.js, DisplayConnection.js, DisplayGame.js
// Loaded last; wires up event listeners and starts the render loop
// =====================================================================

// =====================================================================
// Controller Message Handlers
// =====================================================================

function handleControllerMessage(fromId, msg) {
  if (!msg || !msg.type) return;

  // Any message from a controller proves it's alive — clear disconnect overlay
  disconnectedQRs.delete(fromId);
  var senderPlayer = players.get(fromId);
  if (senderPlayer) senderPlayer.lastPingTime = Date.now();

  switch (msg.type) {
    case MSG.HELLO:
      onHello(fromId, msg);
      break;
    case MSG.INPUT:
      onInput(fromId, msg);
      break;
    case MSG.SOFT_DROP:
      onSoftDrop(fromId, msg.speed);
      break;
    case MSG.START_GAME:
      if (fromId === hostId) startGame();
      break;
    case MSG.PLAY_AGAIN:
      if (fromId === hostId) playAgain();
      break;
    case MSG.RETURN_TO_LOBBY:
      if (fromId === hostId) returnToLobby();
      break;
    case MSG.PAUSE_GAME:
      if (fromId === hostId) pauseGame();
      break;
    case MSG.RESUME_GAME:
      if (fromId === hostId) resumeGame();
      break;
    case MSG.LEAVE:
      removePlayer(fromId, true);
      break;
    case MSG.PING:
      party.sendTo(fromId, { type: MSG.PONG, t: msg.t });
      break;
  }
}

function onHello(fromId, msg) {
  var name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 16) : '';
  var playerName = name || 'Player';

  // Player already registered (from peer_joined or reconnect)
  if (players.has(fromId)) {
    var existing = players.get(fromId);

    // Clear grace timer if any
    if (graceTimers.has(fromId)) {
      clearTimeout(graceTimers.get(fromId));
      graceTimers.delete(fromId);
    }

    // Update name (replaces placeholder like "P1")
    existing.playerName = playerName;
    updatePlayerList();

    // Send welcome with current state
    party.sendTo(fromId, {
      type: MSG.WELCOME,
      playerColor: existing.playerColor,
      isHost: fromId === hostId,
      playerCount: players.size,
      roomState: roomState,
      alive: lastAliveState[fromId] != null ? lastAliveState[fromId] : true,
      paused: paused
    });

    broadcastLobbyUpdate();
    return;
  }

  // New player joining (peer_joined was missed or not used)
  if (roomState !== ROOM_STATE.LOBBY) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Game already in progress' });
    return;
  }

  if (players.size >= GameConstants.MAX_PLAYERS) {
    party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
    return;
  }

  var index = playerIndexCounter++;
  var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
  var isHost = hostId === null;
  if (isHost) hostId = fromId;

  players.set(fromId, {
    playerName: playerName,
    playerColor: color,
    playerIndex: index,
    lastPingTime: Date.now()
  });
  playerOrder.push(fromId);

  // Send welcome to new player
  party.sendTo(fromId, {
    type: MSG.WELCOME,
    playerColor: color,
    isHost: isHost,
    playerCount: players.size,
    roomState: roomState
  });

  // Update all controllers with new player count
  broadcastLobbyUpdate();

  // Update display UI
  updatePlayerList();
  updateStartButton();
}

function onInput(fromId, msg) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;
  displayGame.processInput(fromId, msg.action);
}

function onSoftDrop(fromId, speed) {
  if (roomState !== ROOM_STATE.PLAYING || paused) return;
  if (!displayGame) return;

  // Start or continue soft drop with speed
  displayGame.handleSoftDropStart(fromId, speed);

  // Reset auto-end timeout
  if (softDropTimers.has(fromId)) {
    clearTimeout(softDropTimers.get(fromId));
  }
  softDropTimers.set(fromId, setTimeout(function() {
    softDropTimers.delete(fromId);
    if (displayGame) displayGame.handleSoftDropEnd(fromId);
  }, 300));
}

function removePlayer(clientId, immediate) {
  if (!players.has(clientId)) return;

  if (roomState === ROOM_STATE.LOBBY) {
    if (immediate) {
      removeLobbyPlayer(clientId);
    } else {
      onPeerLeft(clientId);
    }
  } else {
    onPeerLeft(clientId);
  }
}

// =====================================================================
// Results UI
// =====================================================================

function renderResults(results) {
  resultsList.innerHTML = '';
  if (!results) return;

  var sorted = results.slice().sort(function(a, b) { return a.rank - b.rank; });

  var winner = sorted[0];
  if (winner) {
    var wInfo = players.get(winner.playerId);
    var winnerColor = wInfo?.playerColor || PLAYER_COLORS[wInfo?.playerIndex] || '#ffd700';
    var parsed = [
      parseInt(winnerColor.slice(1, 3), 16),
      parseInt(winnerColor.slice(3, 5), 16),
      parseInt(winnerColor.slice(5, 7), 16)
    ];
    var r = isNaN(parsed[0]) ? 255 : parsed[0];
    var g = isNaN(parsed[1]) ? 215 : parsed[1];
    var b = isNaN(parsed[2]) ? 0 : parsed[2];
    resultsScreen.style.setProperty('--winner-glow', 'rgba(' + r + ', ' + g + ', ' + b + ', 0.08)');
  }

  var solo = sorted.length === 1;

  for (var i = 0; i < sorted.length; i++) {
    var res = sorted[i];
    var row = document.createElement('div');
    row.className = solo ? 'result-row' : 'result-row rank-' + res.rank;
    row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');

    if (!solo) {
      var rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = res.rank <= 3 ? ['', '1st', '2nd', '3rd'][res.rank] : res.rank + 'th';
      row.appendChild(rank);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    var pInfo = players.get(res.playerId);
    nameEl.textContent = res.playerName || pInfo?.playerName || 'Player';
    if (pInfo) {
      nameEl.style.color = pInfo.playerColor || PLAYER_COLORS[pInfo.playerIndex];
    }

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    stats.innerHTML = '<span>' + (res.score || 0).toLocaleString() + ' points</span><span>' + (res.lines || 0) + ' lines</span><span>Lv ' + (res.level || 1) + '</span>';

    info.appendChild(nameEl);
    info.appendChild(stats);
    row.appendChild(info);
    resultsList.appendChild(row);
  }
}

// =====================================================================
// Welcome / UI Buttons
// =====================================================================

function resetToWelcome() {
  if (party) {
    party.close();
    party = null;
  }
  stopLivenessCheck();
  lastRoomCode = null;
  roomCode = null;
  joinUrl = null;
  hostId = null;
  paused = false;
  setRoomState(ROOM_STATE.LOBBY);
  players.clear();
  playerOrder = [];
  playerIndexCounter = 0;
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  lastAliveState = {};
  lastResults = null;
  preCreatedRoom = null;
  showScreen('welcome');
  connectAndCreateRoom();
}

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
      requestAnimationFrame(function() { renderTetrisQR(qrCode, pre.qrMatrix); });
    }
  } else {
    connectAndCreateRoom();
  }

  history.pushState({ screen: 'lobby' }, '');
});

window.addEventListener('popstate', function(e) {
  if (suppressPopstate) {
    suppressPopstate = false;
    return;
  }
  var target = e.state && e.state.screen;
  if (currentScreen === 'welcome' && target === 'lobby') {
    connectAndCreateRoom();
    showScreen('lobby');
  } else if (currentScreen === 'lobby') {
    if (target === 'game') {
      suppressPopstate = true;
      history.back();
    } else {
      resetToWelcome();
    }
  } else if (currentScreen === 'game' || currentScreen === 'results') {
    popstateNavigating = true;
    if (music) music.stop();
    showScreen('lobby');
    returnToLobby();
  }
});

startBtn.addEventListener('click', function() {
  if (startBtn.disabled) return;
  initMusic();
  startGame();
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
  localStorage.setItem('tetris_muted', muted ? '1' : '0');
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

// =====================================================================
// Render Loop
// =====================================================================

var lastThrottled = null;
function renderLoop(timestamp) {
  requestAnimationFrame(renderLoop);

  if ((currentScreen !== 'game' && currentScreen !== 'results') || !ctx) return;

  if (lastFrameTime === null) lastFrameTime = timestamp;
  var deltaMs = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  // Throttle to ~4fps when paused/results with no active animations
  var hasAnimations = animations && animations.active.length > 0;
  var hasGarbageEffects = garbageIndicatorEffects.size > 0;
  if ((paused || currentScreen === 'results') && !hasAnimations && !hasGarbageEffects) {
    // First idle frame is intentionally skipped (delta=0 < 250ms);
    // the results DOM overlay is already visible via showScreen().
    if (!lastThrottled) lastThrottled = timestamp;
    if (timestamp - lastThrottled < 250) return;
    lastThrottled = timestamp;
  } else {
    lastThrottled = null;
  }

  var w = window.innerWidth;
  var h = window.innerHeight;
  ctx.fillStyle = THEME.color.bg.primary;
  ctx.fillRect(0, 0, w, h);

  if (!renderLoop._vignette || renderLoop._vw !== w || renderLoop._vh !== h) {
    renderLoop._vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
    renderLoop._vignette.addColorStop(0, 'rgba(15, 15, 40, 0.3)');
    renderLoop._vignette.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
    renderLoop._vw = w;
    renderLoop._vh = h;
  }
  ctx.fillStyle = renderLoop._vignette;
  ctx.fillRect(0, 0, w, h);

  if (!gameState) {
    for (var i = 0; i < playerOrder.length; i++) {
      if (!boardRenderers[i] || !uiRenderers[i]) continue;
      var pInfo = players.get(playerOrder[i]);
      var empty = {
        id: playerOrder[i],
        alive: true,
        score: 0, lines: 0, level: 1,
        garbageIndicatorEffects: [],
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: pInfo?.playerColor || PLAYER_COLORS[i]
      };
      boardRenderers[i].render(empty);
      uiRenderers[i].render(empty);
    }
    return;
  }

  if (gameState.players) {
    for (var i = 0; i < gameState.players.length; i++) {
      var playerData = gameState.players[i];
      if (!boardRenderers[i] || !uiRenderers[i]) continue;

      var shake = animations
        ? animations.getShakeOffsetForBoard(boardRenderers[i].x, boardRenderers[i].y)
        : { x: 0, y: 0 };

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.save();
        ctx.translate(shake.x, shake.y);
      }

      var pInfo = players.get(playerData.id);
      var now = performance.now();
      var activeGarbageIndicatorEffects = (garbageIndicatorEffects.get(playerData.id) || [])
        .filter(function(effect) { return now - effect.startTime < effect.duration; });
      if (activeGarbageIndicatorEffects.length > 0) {
        garbageIndicatorEffects.set(playerData.id, activeGarbageIndicatorEffects);
      } else {
        garbageIndicatorEffects.delete(playerData.id);
      }
      var enriched = Object.assign({}, playerData, {
        garbageIndicatorEffects: activeGarbageIndicatorEffects,
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: pInfo?.playerColor || PLAYER_COLORS[i]
      });

      boardRenderers[i].render(enriched);
      uiRenderers[i].render(enriched);

      // Draw QR overlay for disconnected players
      if (disconnectedQRs.has(playerData.id)) {
        var br = boardRenderers[i];
        var bx = br.x;
        var by = br.y;
        var bw = 10 * br.cellSize;
        var bh = 20 * br.cellSize;

        ctx.fillStyle = 'rgba(0, 0, 0, ' + THEME.opacity.overlay + ')';
        ctx.fillRect(bx, by, bw, bh);

        var qrImg = disconnectedQRs.get(playerData.id);
        var labelSize = Math.max(10, br.cellSize * THEME.font.cellScale.name);
        var labelGap = labelSize * 1.2;
        var qrSize = Math.min(bw, bh) * 0.5;
        var qrRadius = qrSize * 0.08;
        var pad = qrSize * 0.06;
        var outerSize = qrSize + pad * 2;
        var totalH = outerSize + labelGap + labelSize;
        var groupY = by + (bh - totalH) / 2;
        var outerX = bx + (bw - outerSize) / 2;
        var outerY = groupY;

        ctx.fillStyle = THEME.color.text.white;
        ctx.beginPath();
        ctx.roundRect(outerX, outerY, outerSize, outerSize, qrRadius);
        ctx.fill();

        ctx.strokeStyle = 'rgba(0, 200, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (qrImg) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(outerX + pad, outerY + pad, qrSize, qrSize, Math.max(1, qrRadius - pad));
          ctx.clip();
          ctx.drawImage(qrImg, outerX + pad, outerY + pad, qrSize, qrSize);
          ctx.restore();
        }

        ctx.fillStyle = enriched.playerColor || 'rgba(0, 200, 255, 0.7)';
        ctx.font = '600 ' + labelSize + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = '0.1em';
        ctx.fillText('SCAN TO REJOIN', bx + bw / 2, outerY + outerSize + labelGap);
        ctx.letterSpacing = '0px';
      }

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.restore();
      }
    }
  }

  if (animations) {
    animations.update(deltaMs);
    animations.render();
  }

  if (gameState.elapsed != null) {
    drawTimer(gameState.elapsed);
  }
}

function drawTimer(elapsedMs) {
  var totalSeconds = Math.floor(elapsedMs / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  var timeStr = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');

  var font = getDisplayFont();

  var btnH = Math.min(52, Math.max(36, window.innerHeight * 0.04));
  var labelSize = Math.round(btnH * 0.6);
  var digitAdvance = labelSize * 0.92;
  var colonAdvance = labelSize * 0.52;
  var advances = [];
  var timerWidth = 0;
  for (var i = 0; i < timeStr.length; i++) {
    var advance = timeStr[i] === ':' ? colonAdvance : digitAdvance;
    advances.push(advance);
    timerWidth += advance;
  }
  var startX = window.innerWidth / 2 - timerWidth / 2;
  var btnTop = Math.min(20, Math.max(10, window.innerHeight * 0.015));
  var y = btnTop + (btnH - labelSize) / 2;

  ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
  ctx.font = '700 ' + labelSize + 'px ' + font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.letterSpacing = '0.15em';
  var cursorX = startX;
  for (var i = 0; i < timeStr.length; i++) {
    var charX = cursorX + advances[i] / 2;
    ctx.fillText(timeStr[i], charX, y);
    cursorX += advances[i];
  }
  ctx.letterSpacing = '0px';
}

// =====================================================================
// Cursor Auto-Hide
// =====================================================================

var cursorTimer = null;
function showCursor() {
  document.body.classList.remove('cursor-hidden');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(function() {
    document.body.classList.add('cursor-hidden');
  }, 3000);
}
document.addEventListener('mousemove', showCursor);
showCursor();

// --- Window Resize ---
window.addEventListener('resize', function() {
  resizeCanvas();
  if (welcomeBg) welcomeBg.resize(window.innerWidth, window.innerHeight);
});

// =====================================================================
// Test Mode API (window.__TEST__)
// =====================================================================

if (new URLSearchParams(window.location.search).get('test') === '1') {
  window.__TEST__ = {
    addPlayers: function(playerList) {
      for (var i = 0; i < playerList.length; i++) {
        var p = playerList[i];
        var index = playerIndexCounter++;
        var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
        players.set(p.id, {
          playerName: p.name,
          playerColor: color,
          playerIndex: index
        });
        playerOrder.push(p.id);
        if (!hostId) hostId = p.id;
      }
      updatePlayerList();
      updateStartButton();
    },

    injectGameState: function(state) {
      // Step through valid transitions (LOBBY→COUNTDOWN→PLAYING)
      setRoomState(ROOM_STATE.COUNTDOWN);
      setRoomState(ROOM_STATE.PLAYING);
      gameState = state;
      countdownOverlay.classList.add('hidden');
      showScreen('game');
      calculateLayout();
    },

    injectResults: function(results) {
      // Step through valid transitions to reach RESULTS
      if (roomState === ROOM_STATE.LOBBY) {
        setRoomState(ROOM_STATE.COUNTDOWN);
        setRoomState(ROOM_STATE.PLAYING);
      }
      setRoomState(ROOM_STATE.RESULTS);
      lastResults = results;
      onGameEnd(results);
    },

    injectPause: function() {
      onGamePaused();
    },

    injectKO: function(playerId) {
      onPlayerKO({ playerId: playerId });
    },

    injectGarbageSent: function(data) {
      onGarbageSent(data);
    },

    injectCountdownGo: function() {
      onCountdownDisplay('GO');
    }
  };
}

// =====================================================================
// Initialize
// =====================================================================

fetch('/api/version').then(function(r) { return r.json(); }).then(function(data) {
  document.getElementById('version-label').textContent = 'v' + data.version;
}).catch(function() {});

var bgCanvas = document.getElementById('bg-canvas');
if (bgCanvas) {
  welcomeBg = new WelcomeBackground(bgCanvas);
  welcomeBg.resize(window.innerWidth, window.innerHeight);
  welcomeBg.start();
}

fetchBaseUrl();
connectAndCreateRoom();
requestAnimationFrame(renderLoop);
