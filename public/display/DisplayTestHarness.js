'use strict';

// =====================================================================
// Display Test Harness — window.__TEST__ API and scenario builders
// Depends on: DisplayState.js (globals: urlParams, debugCount), DisplayUI.js, DisplayGame.js
// Loaded before display.js; only active when ?test=1 or ?debug=N
// =====================================================================

if (urlParams.get('test') === '1' || debugCount > 0) {
  window.__TEST__ = {
    addPlayers: function(playerList) {
      for (var i = 0; i < playerList.length; i++) {
        var p = playerList[i];
        var index = nextAvailableSlot();
        var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
        players.set(p.id, {
          playerName: sanitizePlayerName(p.name, index),
          playerColor: color,
          playerIndex: index,
          startLevel: p.level || 1
        });
        playerOrder.push(p.id);
      }
      updatePlayerList();
      updateStartButton();
    },

    injectGameState: function(state) {
      setRoomState(ROOM_STATE.COUNTDOWN);
      setRoomState(ROOM_STATE.PLAYING);
      gameState = state;
      countdownOverlay.classList.add('hidden');
      showScreen(SCREEN.GAME);
      calculateLayout();
    },

    injectResults: function(results) {
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
    },

    setExtraGhosts: function(extraGhostsPerPlayer) {
      // Store for renderFrame to draw after each board render.
      // extraGhostsPerPlayer: array of arrays, one per player index.
      // Each inner array: [{ typeId, x, ghostY, blocks }]
      window.__TEST__._extraGhosts = extraGhostsPerPlayer;
    }
  };
}

// =====================================================================
// Debug State Builder
// =====================================================================

function _buildHexDebugState(debugPlayers, level) {
  var HC = GameConstants.COLS;
  var HV = GameConstants.VISIBLE_ROWS;
  var GC = GameConstants.GARBAGE_CELL;
  var types = GameConstants.PIECE_TYPES;
  var emptyRow = function() { var r = []; for (var i = 0; i < HC; i++) r.push(0); return r; };
  var fullRow = function(gap) { var r = []; for (var i = 0; i < HC; i++) r.push(i === gap ? 0 : GC); return r; };
  var state = { players: [], elapsed: 75000 };
  for (var dj = 0; dj < debugPlayers.length; dj++) {
    var grid = []; for (var r = 0; r < HV; r++) grid.push(emptyRow());
    for (var br = HV - 3; br < HV; br++) {
      for (var bc = 0; bc < HC; bc++) {
        if ((bc + br + dj) % 4 !== 0) grid[br][bc] = ((bc + br) % types.length) + 1;
      }
    }
    grid[HV - 1] = fullRow((dj * 2 + 3) % HC);
    var pt = types[dj % types.length];
    var piece = new PieceModule.Piece(pt);
    piece.anchorCol = 5; piece.anchorRow = 2;
    var blocks = piece.getAbsoluteBlocks();
    var ghostPiece = piece.clone(); ghostPiece.anchorRow = HV - 5;
    state.players.push({
      id: debugPlayers[dj].id, playerName: debugPlayers[dj].name,
      grid: grid, lines: [24,16,10,5,20,12,8,3][dj % 8], level: level || [3,2,2,1,3,2,1,1][dj % 8],
      alive: true,
      currentPiece: { type: pt, typeId: piece.typeId, anchorCol: 5, anchorRow: 2, cells: piece.cells, blocks: blocks },
      ghost: { anchorCol: ghostPiece.anchorCol, anchorRow: ghostPiece.anchorRow, blocks: ghostPiece.getAbsoluteBlocks() },
      nextPieces: [types[(dj+1)%types.length], types[(dj+2)%types.length], types[(dj+3)%types.length]],
      holdPiece: types[(dj+4)%types.length],
      pendingGarbage: dj % 3 === 0 ? 3 : 0
    });
  }
  return state;
}

function _buildDebugPlayers(count, level) {
  var names = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];
  var list = [];
  for (var i = 0; i < Math.min(count, 8); i++) {
    list.push({ id: 'debug' + i, name: names[i] || ('P' + (i + 1)), level: level });
  }
  return list;
}

// Run an animation trigger after the iframe has painted its first frame.
// BoardRenderers are created inside calculateLayout (via showScreen(GAME)),
// so we need a tick before addHexCellClear/onGarbageSent can find them.
function _delayTrigger(fn, ms) {
  setTimeout(fn, ms || 500);
}

function _fireLineClear(playerIdx, lines) {
  if (!animations || !boardRenderers[playerIdx]) return;
  var HC = GameConstants.COLS;
  var HV = GameConstants.VISIBLE_ROWS;
  // addHexCellClear expects [col, row] tuples, not {col,row} objects.
  var cells = [];
  var rowCount = Math.max(1, Math.min(lines || 1, 4));
  for (var r = 0; r < rowCount; r++) {
    for (var c = 0; c < HC; c++) cells.push([c, HV - 1 - r]);
  }
  animations.addHexCellClear(boardRenderers[playerIdx], cells, rowCount);
}

function _fakeLobbyQR() {
  // Populate the two-part host/code spans so the gallery lobby matches the
  // real applyRoomCreated() rendering (small host + big room code).
  if (joinUrlEl) {
    var hostEl = joinUrlEl.querySelector('.join-url__host');
    var codeEl = joinUrlEl.querySelector('.join-url__code');
    if (hostEl && codeEl) {
      hostEl.textContent = 'hexstacker.com/';
      codeEl.textContent = 'TEST';
    } else {
      joinUrlEl.textContent = 'hexstacker.com/TEST';
    }
  }
  // Render a real QR for a fake URL so the lobby layout looks realistic.
  fetch('/api/qr?text=' + encodeURIComponent('https://hexstacker.com/TEST12'))
    .then(function(r) { return r.json(); })
    .then(function(matrix) { if (qrCode) renderQR(qrCode, matrix); })
    .catch(function() { /* gallery works without QR — ignore */ });
}

// =====================================================================
// Scenario Init — called from display.js when ?debug=N or ?scenario=...
// =====================================================================

function initScenario(opts) {
  opts = opts || {};
  var scenario = opts.scenario || 'playing';
  var playerCount = Math.max(1, Math.min(opts.players || 1, 8));
  var level = opts.level || 1;

  // Host override for gallery previews. getHostClientId() consults
  // party.getMasterClientId() first, so stubbing it lets us render the
  // same scenario with different players designated as host (Start button
  // tint follows the host's player color).
  if (opts.host !== null && opts.host !== undefined && !isNaN(opts.host)) {
    var hostIdx = Math.max(0, Math.min(opts.host, 7));
    party = { getMasterClientId: function() { return 'debug' + hostIdx; } };
  }

  // Welcome: no players, stay on welcome screen.
  if (scenario === 'welcome') {
    showScreen(SCREEN.WELCOME);
    return;
  }

  // Lobby: populate players and show lobby screen.
  if (scenario === 'lobby') {
    window.__TEST__.addPlayers(_buildDebugPlayers(playerCount, level));
    _fakeLobbyQR();
    showScreen(SCREEN.LOBBY);
    return;
  }

  // AirConsole lobby variant — adds `body.airconsole` so the CSS overrides
  // in display.css hide QR/join URL and collapse the player list into the
  // compact AirConsole layout.
  if (scenario === 'airconsole-lobby') {
    document.body.classList.add('airconsole');
    window.__TEST__.addPlayers(_buildDebugPlayers(playerCount, level));
    showScreen(SCREEN.LOBBY);
    return;
  }

  // All other scenarios need players + some game state.
  var debugPlayers = _buildDebugPlayers(playerCount, level);
  window.__TEST__.addPlayers(debugPlayers);

  if (scenario === 'countdown') {
    setRoomState(ROOM_STATE.COUNTDOWN);
    showScreen(SCREEN.GAME);
    calculateLayout();
    startRenderLoop();
    // Play 3 → 2 → 1 → GO once on a 1s tick (audio is a no-op without music
    // init, which only happens on user interaction). The gallery's ▶ replay
    // button re-runs this on demand; initial load freezes at "3" so the
    // preview has something visible without auto-playing.
    var sequence = ['3', '2', '1', 'GO'];
    var pendingTimers = [];
    function clearPending() {
      for (var pi = 0; pi < pendingTimers.length; pi++) clearTimeout(pendingTimers[pi]);
      pendingTimers = [];
    }
    function resetToInitial() {
      countdownOverlay.classList.remove('hidden');
      countdownNumber.textContent = '3';
    }
    function startCountdown() {
      clearPending();
      // Tear down any live countdown timers from a previous run so a rapid
      // replay can't race its predecessor (GO-hide, music-start, or the
      // tick interval firing against the new sequence). Mirror the full
      // DisplayGame.stopCountdown teardown.
      if (countdown.timer) { clearInterval(countdown.timer); countdown.timer = null; }
      if (countdown.goTimeout) { clearTimeout(countdown.goTimeout); countdown.goTimeout = null; }
      if (countdown.overlayTimer) { clearTimeout(countdown.overlayTimer); countdown.overlayTimer = null; }
      countdownOverlay.classList.add('hidden');
      countdownNumber.textContent = '';
      // Boot the audio context so playCountdownBeep actually beeps. Only
      // invoked from the gallery's ▶ button, so we have a user gesture
      // even though the harness itself runs on load.
      initMusic();
      var idx = 0;
      (function tick() {
        onCountdownDisplay(sequence[idx]);
        idx++;
        if (idx < sequence.length) {
          pendingTimers.push(setTimeout(tick, 1000));
        } else {
          // Post-GO: onCountdownDisplay('GO') hides the overlay and starts
          // game music. Silence the music once the overlay is gone, then
          // reset the card to its initial paused "3" state at 2s.
          pendingTimers.push(setTimeout(function() {
            if (music && music.playing) music.stop();
          }, 500));
          pendingTimers.push(setTimeout(resetToInitial, 2000));
        }
      })();
    }
    resetToInitial();
    window.__TEST__.replay = startCountdown;
    return;
  }

  var state = _buildHexDebugState(debugPlayers, level);
  window.__TEST__.injectGameState(state);
  startRenderLoop();

  if (scenario === 'pause') {
    window.__TEST__.injectPause();
    return;
  }
  if (scenario === 'ko') {
    // KO every player — grand-finale visual.
    for (var kI = 0; kI < debugPlayers.length; kI++) {
      window.__TEST__.injectKO(debugPlayers[kI].id);
      state.players[kI].alive = false;
    }
    return;
  }
  if (scenario === 'line-clear') {
    var HC_lc = GameConstants.COLS;
    var HV_lc = GameConstants.VISIBLE_ROWS;
    var types_lc = GameConstants.PIECE_TYPES;
    // Wipe slot 0 clean so only the rows about to be cleared are filled —
    // otherwise the debug state's checkerboard on row HV-3 stays visible
    // after the clear and it looks like the clear didn't work.
    for (var rClean = 0; rClean < HV_lc; rClean++) {
      for (var cClean = 0; cClean < HC_lc; cClean++) {
        state.players[0].grid[rClean][cClean] = 0;
      }
    }
    for (var lr = HV_lc - 2; lr < HV_lc; lr++) {
      for (var lc = 0; lc < HC_lc; lc++) {
        state.players[0].grid[lr][lc] = ((lc + lr) % types_lc.length) + 1;
      }
    }
    state.players[0].gridVersion = 0;
    _delayTrigger(function() {
      _fireLineClear(0, 2);
      // Zero cells + bump gridVersion after the engine's own clear delay,
      // so BoardRenderer cache invalidates and rows visibly vanish just like
      // in a real game. Tied to engine timing via GameConstants so it tracks
      // any future tweak.
      setTimeout(function() {
        for (var r2 = HV_lc - 2; r2 < HV_lc; r2++) {
          for (var c2 = 0; c2 < HC_lc; c2++) state.players[0].grid[r2][c2] = 0;
        }
        state.players[0].gridVersion++;
      }, GameConstants.LINE_CLEAR_DELAY_MS);
    });
    return;
  }
  if (scenario === 'garbage-add') {
    // Reset baseline pending so the incoming animation starts clean — the
    // debug state seeds slot 0 with 3 pending, which would mask the effect.
    for (var gi = 0; gi < state.players.length; gi++) state.players[gi].pendingGarbage = 0;
    _delayTrigger(function() {
      onGarbageSent({
        toId: debugPlayers[0].id,
        senderId: debugPlayers[Math.min(1, debugPlayers.length - 1)].id,
        lines: 3
      });
      // Leave the meter filled in — the indicator animation is temporary but
      // the pending count should persist so the "incoming garbage" state is
      // visible after the effect fades.
      state.players[0].pendingGarbage = 3;
    });
    return;
  }
  if (scenario === 'garbage-defend') {
    // Seed pendingGarbage so onGarbageCancelled has something to cancel.
    state.players[0].pendingGarbage = 3;
    _delayTrigger(function() {
      onGarbageCancelled({ playerId: debugPlayers[0].id, lines: 2 });
      // Drop pending to reflect the cancellation in the next frame.
      state.players[0].pendingGarbage = 1;
    });
    return;
  }
  if (scenario === 'effects-combo') {
    // Gallery combo: boards 0–3 each demonstrate one effect at once so a
    // single preview tile covers line-clear / garbage-in / defend / KO.
    // Gated to players>=4 by the gallery, but guard anyway.
    if (state.players.length < 4) return;

    var HC_c = GameConstants.COLS;
    var HV_c = GameConstants.VISIBLE_ROWS;
    var types_c = GameConstants.PIECE_TYPES;

    // "Before" state — boards are in the pre-animation configuration the
    // replay will transition out of: board 0 has a filled stack to clear,
    // board 1 has zero pending (incoming garbage will raise it), board 2
    // has 3 pending (defend will cancel most of it), board 3 is alive
    // (KO will take it down). gridVersion starts at 0 so the runEffects
    // tick's `++` produces a clean 0→1 change for BoardRenderer to pick up.
    function seedBoards() {
      for (var rClean = 0; rClean < HV_c; rClean++) {
        for (var cClean = 0; cClean < HC_c; cClean++) {
          state.players[0].grid[rClean][cClean] = 0;
        }
      }
      for (var lr = HV_c - 2; lr < HV_c; lr++) {
        for (var lc = 0; lc < HC_c; lc++) {
          state.players[0].grid[lr][lc] = ((lc + lr) % types_c.length) + 1;
        }
      }
      state.players[0].gridVersion = 0;
      state.players[1].pendingGarbage = 0;
      state.players[2].pendingGarbage = 3;
      state.players[3].alive = true;
    }

    function runEffects() {
      seedBoards();
      _delayTrigger(function() {
        _fireLineClear(0, 2);
        setTimeout(function() {
          for (var r2 = HV_c - 2; r2 < HV_c; r2++) {
            for (var c2 = 0; c2 < HC_c; c2++) state.players[0].grid[r2][c2] = 0;
          }
          state.players[0].gridVersion++;
        }, GameConstants.LINE_CLEAR_DELAY_MS);

        onGarbageSent({
          toId: debugPlayers[1].id,
          senderId: debugPlayers[2].id,
          lines: 3
        });
        state.players[1].pendingGarbage = 3;

        onGarbageCancelled({ playerId: debugPlayers[2].id, lines: 2 });
        state.players[2].pendingGarbage = 1;

        window.__TEST__.injectKO(debugPlayers[3].id);
        state.players[3].alive = false;
      });
    }
    seedBoards();
    window.__TEST__.replay = runEffects;
    return;
  }
  if (scenario === 'reconnecting') {
    reconnectOverlay.classList.remove('hidden');
    reconnectHeading.textContent = t('reconnecting');
    reconnectStatus.textContent = t('attempt_n_of_m', { attempt: 2, max: 5 });
    reconnectBtn.classList.add('hidden');
    return;
  }
  if (scenario === 'disconnected') {
    reconnectOverlay.classList.remove('hidden');
    reconnectHeading.textContent = t('disconnected');
    reconnectStatus.textContent = '';
    reconnectBtn.classList.remove('hidden');
    return;
  }
  if (scenario === 'results') {
    var results = { elapsed: 123456, results: [] };
    for (var i = 0; i < debugPlayers.length; i++) {
      var pInfo = players.get(debugPlayers[i].id);
      results.results.push({
        playerId: debugPlayers[i].id,
        playerName: debugPlayers[i].name,
        playerColor: pInfo && pInfo.playerColor,
        rank: i + 1,
        lines: 30 - i * 3,
        level: level + (playerCount - 1 - i)
      });
    }
    window.__TEST__.injectResults(results);
    return;
  }
  // 'playing' is the default — already handled by injectGameState above.
}

// Backwards-compat shim for any old callers.
function initDebugMode(count) {
  initScenario({ scenario: 'playing', players: count });
}
