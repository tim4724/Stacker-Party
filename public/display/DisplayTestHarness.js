'use strict';

// =====================================================================
// Display Test Harness — window.__TEST__ API and scenario builders
// Depends on: DisplayState.js (globals: urlParams, debugCount), DisplayUI.js, DisplayGame.js
// Loaded before display.js; only active when ?test=1, ?debug=N, or ?adclip=1
// =====================================================================

var _adclipMode = urlParams.get('adclip') === '1';

// Deterministic Math.random override when ?seed=<int> is present. The engine
// has its own seed plumbed via bootLocalGame; this catches non-engine
// randomness (animations, particles, micro-jitter) so captured frames are
// identical across runs.
if (urlParams.get('seed') !== null) {
  var _seedParam = parseInt(urlParams.get('seed'), 10);
  if (!isNaN(_seedParam)) {
    var _s = _seedParam >>> 0;
    Math.random = function() {
      _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
      var t = _s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

if (urlParams.get('test') === '1' || debugCount > 0 || _adclipMode) {
  window.__TEST__ = {
    // Adclip captures keep the render loop's identical-frame skip (prod
    // behavior — a skipped repaint leaves the correct pixels on the canvas,
    // and the screencast resampler duplicates the last frame). test/debug
    // sessions bypass the skip instead: their helpers (e.g. _extraGhosts)
    // inject render inputs the scene signature doesn't track.
    adclip: _adclipMode,
    addPlayers: function(playerList) {
      for (var i = 0; i < playerList.length; i++) {
        var p = playerList[i];
        // Explicit slot lets gallery scenarios fake a non-contiguous roster
        // (e.g. 3 players + player 7 when "View as P7" is picked with
        // Players=4). Falls back to sequential fill for the usual case.
        var index = (typeof p.slot === 'number') ? p.slot : roomCore.nextAvailableColorSlot();
        // joinedAt = array position → stable, incrementing within the seed so
        // calculateLayout()/getHostPeerIndex() get meaningful ordering. Using a
        // derived counter instead of Date.now() keeps scenarios deterministic.
        roomCore.addPlayer(p.id, {
          playerName: roomCore.resolveName(p.name, p.id, false),
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
      // Before the transition: setRoomState publishes and the RESULTS snapshot
      // is what carries the ranking to controllers.
      lastResults = results && results.results;
      setRoomState(ROOM_STATE.RESULTS);
      onGameEnd(results);
    },

    // The frozen LOOK without the room change: gallery captures want the overlay
    // over a stopped board, not a pause the snapshot would publish.
    injectPause: function() {
      freezeGame();
      showPauseOverlay();
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
    },

    // --- Ad-clip helpers ---
    // Boot a deterministic local game from a synthetic player roster, skipping
    // the relay/countdown so the composite orchestrator drives gameplay directly.
    bootLocalGame: function(opts) {
      opts = opts || {};
      var info = opts.playerInfo || [];
      var seed = (opts.seed != null) ? (opts.seed >>> 0) : 0;
      // Engine event handlers call party.broadcast / party.sendTo at multiple
      // sites — install a no-op stub so they don't throw in the no-network harness.
      window.party = window.party || { broadcast: function() {}, sendTo: function() {}, getMasterClientId: function() { return null; } };
      roomCore.reset();
      playerOrder = [];
      for (var i = 0; i < info.length; i++) {
        var p = info[i];
        var slot = (typeof p.slot === 'number') ? p.slot : i;
        // Engine displays level = floor(lines / 10) + startLevel. To honour
        // a roster's `startLines` while keeping the displayed level pinned
        // to `p.level`, the harness back-computes startLevel and seeds the
        // board's `lines` counter below (after the game is constructed).
        var displayedLevel = p.level || 1;
        var startLines = p.startLines || 0;
        var internalStartLevel = Math.max(1, displayedLevel - Math.floor(startLines / 10));
        roomCore.addPlayer(p.id, {
          playerName: roomCore.resolveName(p.name, p.id, false),
          playerIndex: slot,
          startLevel: internalStartLevel
        });
        playerOrder.push(p.id);
      }
      setRoomState(ROOM_STATE.COUNTDOWN);
      setRoomState(ROOM_STATE.PLAYING);
      countdownOverlay.classList.add('hidden');
      countdownNumber.textContent = '';
      showScreen(SCREEN.GAME);
      calculateLayout();
      runGameLocallyWithSeed(seed);
      startRenderLoop();
      // Suppress the live elapsed timer overlay in adclip mode — patch the
      // snapshot so the renderer's `gameState.elapsed != null` gate fails.
      if (_adclipMode && displayGame) {
        var origGetSnapshot = displayGame.getSnapshot.bind(displayGame);
        displayGame.getSnapshot = function() {
          var s = origGetSnapshot();
          s.elapsed = null;
          return s;
        };
      }
      // Seed each board's LINES counter from the roster's `startLines`.
      // Combined with the back-computed startLevel above, this produces a
      // displayed level matching the roster spec (level=11 with lines=105
      // shows "LEVEL 11 / LINES 105" rather than "LEVEL 11 / LINES 0").
      if (displayGame) {
        for (var li = 0; li < info.length; li++) {
          var lp = info[li];
          if (!lp.startLines) continue;
          var lboard = displayGame.boards.get(lp.id);
          if (lboard) lboard.lines = lp.startLines;
        }
      }

      // Pre-populate the bottom of each board with a non-completing pattern
      // so the placed-block style (NORMAL / PILLOW / NEON_FLAT) reads
      // immediately. Each gameplay beat showcases its tier visually instead
      // of needing 30 seconds of AI play to build a stack.
      if (opts.prefillRows && displayGame) {
        var rows = Math.max(1, Math.min(opts.prefillRows, 8));
        var HC = GameConstants.COLS;
        var TR = GameConstants.TOTAL_ROWS;
        var BR = GameConstants.BUFFER_ROWS;
        var findCZ = GameConstants.findClearableZigzags;
        var nTypes = GameConstants.PIECE_TYPES.length;
        var seedFn = function(salt) {
          var s = (seed + salt) >>> 0;
          return function() {
            s |= 0; s = (s + 0x6D2B79F5) | 0;
            var t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        };
        var bIdx = 0;
        for (var entry of displayGame.boards) {
          var pBoard = entry[1];
          var rng = seedFn(bIdx * 17 + 1);
          // Force 2 gaps per row at distinct columns. With 9/11 cells filled
          // a zigzag-down can never complete (needs all 11). For zigzag-up
          // we offset gap columns row-to-row so no alternating-pattern line
          // forms. The engine's findClearableZigzags is then re-checked and
          // any residual clear is broken by punching one more gap.
          var prevGaps = [-1, -1];
          for (var r = TR - rows; r < TR; r++) {
            var g1 = Math.floor(rng() * HC);
            var g2 = (g1 + 3 + Math.floor(rng() * (HC - 5))) % HC;
            // Avoid identical gap columns to the row above so zigzag-up
            // patterns don't accumulate.
            if (g1 === prevGaps[0] || g1 === prevGaps[1]) g1 = (g1 + 1) % HC;
            if (g2 === prevGaps[0] || g2 === prevGaps[1] || g2 === g1) g2 = (g2 + 2) % HC;
            for (var c = 0; c < HC; c++) {
              if (c === g1 || c === g2) continue;
              pBoard.grid[r][c] = Math.floor(rng() * nTypes) + 1;
            }
            prevGaps = [g1, g2];
          }
          // Belt-and-braces: scan for any remaining clearable zigzag and
          // empty one cell of it so the engine can't pop the prefill on
          // the AI's first piece lock.
          var grid = pBoard.grid;
          var safety = 0;
          while (safety++ < 6) {
            var result = findCZ(HC, TR, function(col, row) { return grid[row][col] !== 0; }, null, BR);
            if (result.linesCleared === 0) break;
            var cellsToBreak = result.clearCells.slice(0, result.linesCleared);
            for (var ci = 0; ci < cellsToBreak.length; ci++) {
              grid[cellsToBreak[ci][1]][cellsToBreak[ci][0]] = 0;
            }
          }
          pBoard.gridVersion++;
          bIdx++;
        }
      }
    },

    applyMove: function(playerIdx, action) {
      if (!displayGame) return false;
      var id = playerOrder[playerIdx];
      if (!id) return false;
      var board = displayGame.boards.get(id);
      if (!board || !board.alive) return false;
      switch (action) {
        case 'moveLeft': return board.moveLeft();
        case 'moveRight': return board.moveRight();
        case 'rotateCW': return board.rotateCW();
        case 'rotateCCW': return board.rotateCCW();
        case 'hold': return board.hold();
        case 'hardDrop': {
          var result = board.hardDrop();
          if (result && displayGame.callbacks && displayGame.callbacks.onEvent) {
            displayGame.callbacks.onEvent({
              type: 'piece_lock',
              playerId: id,
              blocks: result.lockedBlocks,
              typeId: result.lockedTypeId
            });
            if (result.linesCleared > 0) {
              displayGame.handleLineClear(id, result);
            }
          }
          return !!result;
        }
      }
      return false;
    },

    // Inject garbage rows directly onto a player's board (engine-side path,
    // not just the indicator). Picks the gap deterministically from playerIdx
    // so seeded captures stay frame-identical.
    injectGarbage: function(toPlayerIdx, lines) {
      if (!displayGame) return false;
      var id = playerOrder[toPlayerIdx];
      if (!id) return false;
      var board = displayGame.boards.get(id);
      if (!board || !board.alive) return false;
      var gap = (toPlayerIdx * 3 + 5) % GameConstants.COLS;
      board.applyGarbage(lines, gap);
      // Fire the indicator animation so the receiver visually shakes.
      var senderId = playerOrder[(toPlayerIdx + 1) % playerOrder.length] || id;
      onGarbageSent({ toId: id, senderId: senderId, lines: lines });
      return true;
    }
  };

  // Hide irrelevant adclip-mode chrome — toolbar (mute/fullscreen/pause icons),
  // version label — both pull attention away from the game.
  if (_adclipMode) {
    var _hide = function() {
      var ids = ['game-toolbar', 'lobby-version-label', 'welcome-version-label', 'lobby-footer'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) el.style.display = 'none';
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _hide);
    } else {
      _hide();
    }
  }

  // Signal readiness so the composite orchestrator can begin its timeline.
  // Posted on next tick so addPlayers / boot calls can land first.
  if (_adclipMode) {
    setTimeout(function() {
      try { window.parent.postMessage({ type: 'adclip-ready', role: 'display' }, '*'); } catch (_) {}
    }, 0);
  }
}

// =====================================================================
// Debug State Builder
// =====================================================================

// Stage a player's bottom `rows` rows as a near-clear: full except one
// even-column gap per row. An even-column gap breaks both zigzag orientations
// through that row, so the staged state contains nothing the engine would
// already have cleared — it reads as a stack waiting for the final piece.
// Returns replay hooks: fill() locks the missing cells, collapse() removes
// the rows and shifts the stack down like the engine's clear, reset()
// restores the staged state.
function _stageNearClear(player, rows) {
  var HC = GameConstants.COLS;
  var HV = GameConstants.VISIBLE_ROWS;
  var nTypes = GameConstants.PIECE_TYPES.length;
  var GAP_COLS = [2, 6, 4, 0];
  var grid = player.grid;
  var bump = function() { player.gridVersion = (player.gridVersion || 0) + 1; };
  for (var i = 0; i < rows; i++) {
    var r = HV - 1 - i;
    for (var c = 0; c < HC; c++) {
      if (grid[r][c] === 0) grid[r][c] = ((c + r) % nTypes) + 1;
    }
    grid[r][GAP_COLS[i % GAP_COLS.length]] = 0;
  }
  var template = grid.map(function(row) { return row.slice(); });
  return {
    fill: function() {
      for (var i = 0; i < rows; i++) {
        var r = HV - 1 - i;
        var gap = GAP_COLS[i % GAP_COLS.length];
        grid[r][gap] = ((gap + r) % nTypes) + 1;
      }
      bump();
    },
    collapse: function() {
      grid.splice(HV - rows, rows);
      for (var i = 0; i < rows; i++) {
        var empty = [];
        for (var c = 0; c < HC; c++) empty.push(0);
        grid.unshift(empty);
      }
      bump();
    },
    reset: function() {
      for (var r = 0; r < HV; r++) {
        for (var c = 0; c < HC; c++) grid[r][c] = template[r][c];
      }
      bump();
    }
  };
}

function _buildDebugPlayers(count, level, hostSlot, longNames) {
  // Canonical roster from the shared fixture module (names + lobby levels),
  // so the web gallery shows the same players as the tvOS / Android TV
  // columns. An explicit ?level= > 1 still pins every badge to that level.
  // longNames swaps in the 16-char LONG_NAMES fixture (?names=long).
  var _roster = GameEngine.GalleryFixtures.roster(8, longNames);
  var names = longNames ? GameEngine.GalleryFixtures.LONG_NAMES : GameEngine.GalleryFixtures.NAMES;
  var max = Math.min(count, 8);
  // Build the slot list. Usually slots fill sequentially 0..count-1; but when
  // the scenario host (viewAs) lives outside that range, we swap the last
  // sequential slot for hostSlot so the gallery preview actually contains
  // the player you're "viewing as" (e.g. Players=4 + viewAs=P7 → slots
  // [0, 1, 2, 6], not [0, 1, 2, 3] with P7 as a ghost host).
  var slots = [];
  var needsHost = typeof hostSlot === 'number' && hostSlot >= 0 && hostSlot < 8 && hostSlot >= max;
  var fill = needsHost ? max - 1 : max;
  for (var s = 0; s < fill; s++) slots.push(s);
  if (needsHost) slots.push(hostSlot);
  var list = [];
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    list.push({
      id: 'debug' + slot,
      name: names[slot] || ('P' + (slot + 1)),
      level: (level && level > 1) ? level : (_roster[slot] ? _roster[slot].level : 1),
      slot: slot
    });
  }
  return list;
}

// Build the injectable game state from the shared GalleryFixtures module (the
// same snapshots the tvOS and Android TV galleries render), remapped onto the
// harness's debug roster ids. Every game-state scenario renders these boards;
// the web-only effect scenarios stage their animations on top of them.
function _buildFixtureState(playerCount, variantName, level, longNames) {
  var GF = GameEngine.GalleryFixtures;
  var spec = variantName ? GF.gameVariant(variantName) : null;
  if (!spec) spec = { players: playerCount, level: level || 1 };
  var snap = GF.gameSnapshot(spec);
  var names = longNames ? GF.LONG_NAMES : GF.NAMES;
  for (var i = 0; i < snap.players.length; i++) {
    var slot = snap.players[i].id;
    snap.players[i].id = 'debug' + slot;
    snap.players[i].playerName = names[slot];
  }
  return snap;
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

// Replace the live falling-piece background with the frozen GalleryFixtures
// frame so the welcome/lobby gallery shots show the same ambient pieces as the
// tvOS / Android TV columns (the live animation freezes at a different moment
// on every platform and every run).
function _freezeWelcomeBg() {
  if (typeof welcomeBg === 'undefined' || !welcomeBg) return;
  welcomeBg.renderStatic(GameEngine.GalleryFixtures.ambientPieces());
}

function _fakeLobbyQR() {
  // Lobby shots (gallery and adclip alike) show the bare site with no fake
  // room code, so the QR + URL function as a clean CTA — the shared JOIN
  // fixture carries the same host/QR target the tvOS and Android TV galleries
  // render, keeping the columns comparable.
  var JOIN = GameEngine.GalleryFixtures.JOIN;
  if (joinUrlEl) {
    var hostEl = joinUrlEl.querySelector('.join-url__host');
    var codeEl = joinUrlEl.querySelector('.join-url__code');
    if (hostEl && codeEl) {
      hostEl.textContent = JOIN.host;
      codeEl.textContent = JOIN.code;
    } else {
      joinUrlEl.textContent = JOIN.host + JOIN.code;
    }
  }
  if (qrCode) renderQR(qrCode, buildQRMatrix(JOIN.qrText));
}

// =====================================================================
// Scenario Init — called from display.js when ?debug=N or ?scenario=...
// =====================================================================

function initScenario(opts) {
  opts = opts || {};
  var scenario = opts.scenario || 'playing';
  // Allow players=0 explicitly (adclip lobby starts empty). Other scenarios
  // pass count directly so 0 stays meaningful through the clamp.
  var rawCount = (opts.players != null) ? opts.players : 1;
  var playerCount = Math.max(0, Math.min(rawCount, 8));
  var level = opts.level || 1;
  // ?names=long renders the roster with the 16-char LONG_NAMES fixture.
  var longNames = opts.names === 'long';

  // A named GalleryFixtures board variant (?variant=lv8/2p/...) fixes the
  // player count regardless of the players param, so the roster always
  // matches the boards it will render.
  if (opts.variant) {
    var _vSpec = GameEngine.GalleryFixtures.gameVariant(opts.variant);
    if (_vSpec) playerCount = _vSpec.players;
  }

  // Host override for gallery previews. getHostPeerIndex() consults
  // party.getMasterPeerIndex() first, so stubbing it lets us render the
  // same scenario with different players designated as host (Start button
  // tint follows the host's player color).
  var hostSlot = null;
  if (opts.host !== null && opts.host !== undefined && !isNaN(opts.host)) {
    hostSlot = Math.max(0, Math.min(opts.host, 7));
    party = { getMasterPeerIndex: function() { return 'debug' + hostSlot; } };
  }

  // Seed dummy relay data for gallery previews so the chip renders. Skip
  // welcome (chip hidden on welcome by design), airconsole-lobby (real
  // AirConsole sessions don't use our relay, so the chip is hidden there
  // — gallery should match), and the create-error states (the room was never
  // created, so there is no relay link and the chip stays hidden).
  var noRelayChip = scenario === 'welcome' || scenario === 'airconsole-lobby' ||
    scenario === 'create-error' || scenario === 'create-error-retry';
  if (!noRelayChip) {
    relayRegion = 'fra';
    lastRelayRtt = 12;
    consecutiveBadRtt = 0;
    updateRelayChip();
  }

  // Welcome: no players, stay on welcome screen.
  if (scenario === 'welcome') {
    showScreen(SCREEN.WELCOME);
    _freezeWelcomeBg();
    return;
  }

  // Lobby: populate players and show lobby screen. `hint=1` freezes the
  // join line on its scan-hint phase (the live cycle never runs under the
  // harness, so this is the only way to review the hint deterministically).
  if (scenario === 'lobby') {
    window.__TEST__.addPlayers(_buildDebugPlayers(playerCount, level, hostSlot, longNames));
    _fakeLobbyQR();
    if (new URLSearchParams(location.search).get('hint') === '1') {
      var joinLine = document.getElementById('join-line');
      if (joinLine) joinLine.classList.add('show-hint');
    }
    showScreen(SCREEN.LOBBY);
    _freezeWelcomeBg();
    return;
  }

  // AirConsole lobby variant — adds `body.airconsole` so the CSS overrides
  // in display.css hide QR/join URL and collapse the player list into the
  // compact AirConsole layout.
  if (scenario === 'airconsole-lobby') {
    document.body.classList.add('airconsole');
    window.__TEST__.addPlayers(_buildDebugPlayers(playerCount, level, hostSlot, longNames));
    showScreen(SCREEN.LOBBY);
    _freezeWelcomeBg();
    return;
  }

  // Create-failure states — first launch couldn't create a room (no Internet,
  // relay error, silent-socket timeout). Merged into the reconnect overlay:
  // it dims the empty, room-less lobby (no QR, no players). The -retry variant
  // shows RECONNECTING with the auto-retry "Attempt N of M" counter; the plain
  // variant is the exhausted DISCONNECTED state with the RECONNECT button.
  // Mirrors DisplayConnection's onClose create-failure path.
  if (scenario === 'create-error' || scenario === 'create-error-retry') {
    showScreen(SCREEN.LOBBY);
    _freezeWelcomeBg();
    reconnectOverlay.classList.remove('hidden');
    if (scenario === 'create-error-retry') {
      reconnectHeading.textContent = t('reconnecting');
      reconnectStatus.textContent = t('attempt_n_of_m', { attempt: 1, max: 5 });
      reconnectBtn.classList.add('hidden');
    } else {
      reconnectHeading.textContent = t('disconnected');
      reconnectStatus.textContent = '';
      reconnectBtn.classList.remove('hidden');
    }
    return;
  }

  // Bail-toast variants. Display gallery iframes are wider than the
  // mobile-only media-query that normally reveals the overlay, so force
  // it visible by removing `.hidden` (the base `.device-choice` rule
  // already sets display: flex). showBailToast handles the 5s auto-hide.
  var bailScenarios = {
    'bail-room-not-found': 'room_not_found',
    'bail-game-full': 'game_full',
    'bail-game-ended': 'game_ended'
  };
  if (bailScenarios[scenario]) {
    var key = bailScenarios[scenario];
    var deviceChoiceEl = document.getElementById('device-choice');
    if (deviceChoiceEl) deviceChoiceEl.classList.remove('hidden');
    showScreen(SCREEN.WELCOME);
    showBailToast(key);
    window.__TEST__.replay = function() { showBailToast(key); };
    return;
  }

  // Transition tour — plays the real player journey end-to-end so every
  // screen/overlay transition can be reviewed exactly as it ships:
  // welcome → lobby (players trickle in) → countdown → gameplay → pause →
  // resume → results → play again → results → lobby. Each step visibly
  // presses the real CTA (.press-sim aliases the button's :active style)
  // and then fires the production trigger (startGame / pauseGame /
  // resumeGame / playAgain / returnToLobby; injectResults reuses the
  // production onGameEnd path), so all fades and entrances are the shipped
  // ones — nothing is reimplemented for the gallery.
  //   ?tscale=<float>  scales the dwell time BETWEEN steps only.
  //   ?ascale=<float>  scales the transition animations themselves (>1 =
  //     slow motion) via runtime playbackRate + a fadeHide wrapper, so the
  //     production CSS keeps its real durations.
  //   ?autoplay=1      play immediately even when embedded (gallery cards
  //     idle on the welcome screen until ▶ starts the tour).
  // The countdown's 1s tick pace is gameplay timing and is never scaled.
  if (scenario === 'transitions') {
    // Full party stub: startNewGame/returnToLobby/publishRoomState call
    // broadcast/sendTo (the host-only stub above covers just the tint).
    party = {
      broadcast: function() {},
      sendTo: function() {},
      getMasterPeerIndex: function() { return hostSlot !== null ? 'debug' + hostSlot : null; }
    };
    // The real flow pushes/pops history (onCountdownDisplay pushState,
    // returnToLobbyUI history.back). An iframe shares the joint session
    // history with the gallery page, so a full tour would leave stray
    // entries behind and hijack the browser Back button. No-op both —
    // invisible on screen, and the only place the tour deviates from the
    // production code path.
    try {
      history.pushState = function() {};
      history.back = function() {};
    } catch (_) { /* sandboxed iframe */ }

    var _tourScale = function(name) {
      var v = parseFloat(urlParams.get(name));
      if (isNaN(v) || v <= 0) return 1;
      return Math.max(0.1, Math.min(v, 10));
    };
    var tscale = _tourScale('tscale');
    var ascale = _tourScale('ascale');
    var _dwell = function(ms) { return ms * tscale; };
    // startGame() → ROOM_STATE.PLAYING: the countdown ticks plus the 500ms
    // GO hold (startCountdown's goTimeout). Production timing, never scaled.
    var COUNTDOWN_TO_PLAYING_MS = GameConstants.COUNTDOWN_SECONDS * 1000 + 500;

    if (ascale !== 1) {
      // Slow (or speed) every CSS animation/transition as it appears —
      // playbackRate leaves the shipped durations untouched in the CSS.
      var _tuned = new WeakSet();
      var _retune = function() {
        var anims = document.getAnimations();
        for (var ai = 0; ai < anims.length; ai++) {
          if (!_tuned.has(anims[ai])) {
            _tuned.add(anims[ai]);
            anims[ai].playbackRate = 1 / ascale;
          }
        }
        requestAnimationFrame(_retune);
      };
      requestAnimationFrame(_retune);
      // Keep the JS half of exit fades in sync: fadeHide's timer flips the
      // element to display:none, which would cut a slowed fadeOut short.
      var _realFadeHide = fadeHide;
      fadeHide = function(el, ms, onHidden) { _realFadeHide(el, ms * ascale, onHidden); };
    }

    // Press a real CTA like a user would: show the pressed state for the
    // hold, then fire the action on "release". The handler bodies aren't
    // click()ed because they bundle gesture/network side effects the harness
    // must skip (initMusic, requestFullscreen, connectAndCreateRoom).
    var PRESS_MS = 200 * ascale;
    function press(btn, action) {
      if (btn) btn.classList.add('press-sim');
      setTimeout(function() {
        if (btn) btn.classList.remove('press-sim');
        action();
      }, PRESS_MS);
    }

    var tourRoster = _buildDebugPlayers(Math.max(1, playerCount), level, hostSlot, longNames);
    // Real controllers ping constantly; without a stand-in the whole roster
    // expires after LIVENESS_TIMEOUT_MS and startNewGame's disconnect prune
    // would bounce the PLAY AGAIN step back to an empty lobby.
    setInterval(function() {
      for (var hi = 0; hi < tourRoster.length; hi++) {
        roomCore.onSeen(tourRoster[hi].id, Date.now());
      }
    }, 1000);
    function tourResults() {
      var r = GameEngine.GalleryFixtures.results(tourRoster.length, longNames);
      for (var ri = 0; ri < r.results.length; ri++) {
        r.results[ri].playerId = 'debug' + r.results[ri].playerId;
      }
      return r;
    }

    showScreen(SCREEN.WELCOME);

    // No autoplay in the gallery grid: embedded in an iframe the card idles
    // on the welcome screen until the ▶ button fires __TEST__.replay().
    // Standalone (open ↗ / direct URL) plays immediately, as does
    // ?autoplay=1 (which the mid-tour replay reload uses).
    var tourStarted = false;

    function startTour() {
      if (tourStarted) return;
      tourStarted = true;

      // NOT named `t` — var hoists across all of initScenario and would shadow
      // the global i18n t() used by the other scenario branches.
      var tourT = _dwell(3000);
      // Welcome → lobby: what the NEW GAME press does, minus relay, fullscreen
      // and music init (those need a user gesture / network). Players then
      // trickle in one by one so the lobby join animation is part of the tour.
      setTimeout(function() {
        press(newGameBtn, function() {
          showScreen(SCREEN.LOBBY);
          _fakeLobbyQR();
        });
      }, tourT);
      tourT += PRESS_MS;
      for (var pi = 0; pi < tourRoster.length; pi++) {
        (function(p, i) {
          setTimeout(function() {
            window.__TEST__.addPlayers([p]);
          }, tourT + _dwell(700) * (i + 1));
        })(tourRoster[pi], pi);
      }
      tourT += _dwell(700) * tourRoster.length + _dwell(2500);

      // Lobby → countdown → gameplay: the real host-pressed-START path. The
      // engine actually runs (gravity drops pieces) until results are injected.
      setTimeout(function() { press(startBtn, startGame); }, tourT);
      tourT += PRESS_MS + COUNTDOWN_TO_PLAYING_MS + _dwell(5000);
      // The toolbar autohides during gameplay; reveal it the way a user would
      // (mouse move → showCursor) before pressing its pause button.
      setTimeout(showCursor, tourT);
      tourT += _dwell(600);
      setTimeout(function() { press(pauseBtn, pauseGame); }, tourT);
      tourT += PRESS_MS + _dwell(3000);
      setTimeout(function() { press(pauseContinueBtn, resumeGame); }, tourT);
      tourT += PRESS_MS + _dwell(3000);
      setTimeout(function() { window.__TEST__.injectResults(tourResults()); }, tourT);
      tourT += _dwell(3000);
      // Results → countdown cross-fade (results fade out over the live boards).
      setTimeout(function() { press(playAgainBtn, playAgain); }, tourT);
      tourT += PRESS_MS + COUNTDOWN_TO_PLAYING_MS + _dwell(3000);
      setTimeout(function() { window.__TEST__.injectResults(tourResults()); }, tourT);
      tourT += _dwell(3000);
      setTimeout(function() { press(newGameResultsBtn, returnToLobby); }, tourT);
    }

    // First ▶ starts an idle tour. After that, replay = reload: the tour
    // mutates real room state (roster, roomState, history stubs), so a fresh
    // boot is the only reset that can't drift. autoplay=1 makes the reloaded
    // page skip the idle and play at once; location.replace keeps the joint
    // session history clean (same reason the history stubs exist above).
    window.__TEST__.replay = function() {
      if (!tourStarted) { startTour(); return; }
      var u = new URL(location.href);
      u.searchParams.set('autoplay', '1');
      location.replace(u.href);
    };
    if (window.self === window.top || urlParams.get('autoplay')) startTour();
    return;
  }

  // All other scenarios need players + some game state.
  var debugPlayers = _buildDebugPlayers(playerCount, level, hostSlot, longNames);
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

  // Every game-state scenario renders the shared GalleryFixtures snapshot
  // (identical on web / tvOS / Android TV) so all boards read as realistic
  // mid-game stacks; the effect scenarios stage their animations on top.
  var state = _buildFixtureState(playerCount, opts.variant, level, longNames);
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
    // Slot 0's bottom rows become a near-clear; the replay fills the gaps as
    // if the final piece just locked, fires the clear effect, then collapses
    // the rows so the stack shifts down just like in a real game. The
    // collapse waits out the engine's own clear delay (via GameConstants so
    // it tracks any future tweak) — that's when BoardRenderer expects the
    // rows to vanish.
    var lcStage = _stageNearClear(state.players[0], 2);
    _delayTrigger(function() {
      lcStage.fill();
      _fireLineClear(0, 2);
      setTimeout(lcStage.collapse, GameConstants.LINE_CLEAR_DELAY_MS);
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
    // Each effect needs its own board, so at lower player counts the higher-
    // indexed effects are simply skipped rather than gating the whole tile.
    var nP = state.players.length;
    if (nP < 1) return;

    // "Before" state — boards are in the pre-animation configuration the
    // replay will transition out of: board 0's bottom rows are a near-clear
    // (the replay fills the gaps and clears them), board 1 has zero pending
    // (incoming garbage will raise it), board 2 has 3 pending (defend will
    // cancel most of it), board 3 is alive (KO will take it down).
    var comboStage = _stageNearClear(state.players[0], 2);
    function seedBoards() {
      comboStage.reset();
      if (nP > 1) state.players[1].pendingGarbage = 0;
      if (nP > 2) state.players[2].pendingGarbage = 3;
      if (nP > 3) state.players[3].alive = true;
    }

    function runEffects() {
      seedBoards();
      _delayTrigger(function() {
        comboStage.fill();
        _fireLineClear(0, 2);
        setTimeout(comboStage.collapse, GameConstants.LINE_CLEAR_DELAY_MS);

        // Garbage-in needs both a receiver (board 1) and a sender (board 2).
        if (nP > 2) {
          onGarbageSent({
            toId: debugPlayers[1].id,
            senderId: debugPlayers[2].id,
            lines: 3
          });
          state.players[1].pendingGarbage = 3;

          onGarbageCancelled({ playerId: debugPlayers[2].id, lines: 2 });
          state.players[2].pendingGarbage = 1;
        }

        if (nP > 3) {
          window.__TEST__.injectKO(debugPlayers[3].id);
          state.players[3].alive = false;
        }
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
  if (scenario === 'disconnected-controller') {
    // Per-board rejoin QR: run the production disconnect path for slot 1 so
    // the overlay renders exactly as in a live game (production appends
    // ?claim=<peerIndex> to joinUrl for the rejoin link).
    joinUrl = GameEngine.GalleryFixtures.JOIN.qrText;
    showDisconnectQR('debug1');
    return;
  }
  if (scenario === 'results') {
    // Canonical ranking from the shared fixture module, remapped onto the
    // harness's debug roster ids.
    var results = GameEngine.GalleryFixtures.results(playerCount, longNames);
    for (var i = 0; i < results.results.length; i++) {
      results.results[i].playerId = 'debug' + results.results[i].playerId;
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
