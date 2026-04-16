'use strict';

// =====================================================================
// Display UI — layout calculation, lobby UI, QR rendering, timer
// Depends on: DisplayState.js (globals)
// Called by: DisplayConnection.js, DisplayGame.js, display.js
// =====================================================================

// Builds the empty level-controls stub shown in unfilled lobby slots.
// Used in two places: initial card creation and slot sync for late-joiners.
function buildLevelPlaceholder() {
  var ph = document.createElement('div');
  ph.className = 'level-controls level-placeholder';
  ph.setAttribute('aria-hidden', 'true');
  ph.innerHTML = '<span class="level-heading">' + t('level_heading') + '</span><span class="level-btn"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/></svg></span><span class="level-label">1</span><span class="level-btn"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/><line x1="7" y1="2" x2="7" y2="12"/></svg></span>';
  return ph;
}

// --- Layout Calculation ---
function calculateLayout() {
  if (!ctx || playerOrder.length === 0) return;
  // Sort by slot index so board positions match player colors (P1 left, P2 right, etc.)
  playerOrder.sort(function(a, b) {
    return (players.get(a)?.playerIndex ?? 0) - (players.get(b)?.playerIndex ?? 0);
  });
  clearStampCache();

  var n = playerOrder.length;
  var w = window.innerWidth;
  var h = window.innerHeight;
  var padding = THEME.size.canvasPad;
  var boardCols = GameConstants.COLS;
  var hexRows = GameConstants.VISIBLE_ROWS;
  var boardRows = GameConstants.computeHexGeometry(boardCols, hexRows, 1).boardHeight;
  var totalCellsWide = boardCols + 3 + 3;
  // Gaps scale with cellSize to stay proportional at all zoom levels
  function nameGap(cs) { return cs * 0.6; }
  var font = getDisplayFont();

  var _measureCache = {};
  function measureHeight(weight, size) {
    var key = weight + '_' + size;
    if (_measureCache[key] != null) return _measureCache[key];
    ctx.font = weight + ' ' + size + 'px ' + font;
    var m = ctx.measureText('Mg');
    var h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    _measureCache[key] = h;
    return h;
  }

  function textHeight(cs) {
    var nameSize = Math.max(THEME.font.minPx.name, cs * THEME.font.cellScale.name);
    return measureHeight(700, nameSize) + nameGap(cs);
  }

  function cellSizeFor(cols, rows) {
    var aw = (w - padding * (cols + 1)) / cols;
    var ah = (h - padding * (rows + 1)) / rows;
    var cs = Math.floor(Math.min(aw / totalCellsWide, ah / boardRows));
    while (cs > 1 && cs * boardRows + textHeight(cs) > ah) cs--;
    return cs;
  }

  var gridCols, gridRows, cellSize;
  if (n === 1) { gridCols = 1; gridRows = 1; }
  else if (n === 2) { gridCols = 2; gridRows = 1; }
  else if (n === 3) { gridCols = 3; gridRows = 1; }
  else if (n <= 4) {
    var cs4x1 = cellSizeFor(4, 1), cs2x2 = cellSizeFor(2, 2);
    if (cs4x1 >= cs2x2) { gridCols = 4; gridRows = 1; cellSize = cs4x1; }
    else { gridCols = 2; gridRows = 2; cellSize = cs2x2; }
  } else if (n <= 6) {
    var csN = cellSizeFor(n, 1), cs3x2 = cellSizeFor(3, 2);
    if (csN >= cs3x2) { gridCols = n; gridRows = 1; cellSize = csN; }
    else { gridCols = 3; gridRows = 2; cellSize = cs3x2; }
  } else {
    var csNw = cellSizeFor(n, 1), cs4x2 = cellSizeFor(4, 2);
    if (csNw >= cs4x2) { gridCols = n; gridRows = 1; cellSize = csNw; }
    else { gridCols = 4; gridRows = 2; cellSize = cs4x2; }
  }
  if (!cellSize) cellSize = cellSizeFor(gridCols, gridRows);
  var geo = GameConstants.computeHexGeometry(boardCols, hexRows, cellSize);
  var boardWidthPx = geo.boardWidth;
  var boardHeightPx = geo.boardHeight;

  boardRenderers = [];
  uiRenderers = [];
  if (!animations) {
    animations = new Animations(ctx);
  } else {
    animations.active = [];
  }

  var maxSlots = gridCols * gridRows;
  var cellAreaW = (w - padding * (gridCols + 1)) / gridCols;
  var cellAreaH = (h - padding * (gridRows + 1)) / gridRows;
  var nameSize = Math.max(THEME.font.minPx.name, cellSize * THEME.font.cellScale.name);
  var nameArea = measureHeight(700, nameSize) + nameGap(cellSize);
  var totalContentH = boardHeightPx + textHeight(cellSize);

  for (var i = 0; i < n && i < maxSlots; i++) {
    var col = i % gridCols;
    var row = Math.floor(i / gridCols);
    var boardX = padding + col * (cellAreaW + padding) + (cellAreaW - boardWidthPx) / 2;
    var boardY = padding + row * (cellAreaH + padding) + (cellAreaH - totalContentH) / 2 + nameArea;
    var playerIndex = players.get(playerOrder[i])?.playerIndex ?? i;
    boardRenderers.push(new BoardRenderer(ctx, boardX, boardY, cellSize, playerIndex));
    uiRenderers.push(new UIRenderer(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex));
  }
}

// --- Lobby UI ---
function updatePlayerList() {
  var placeholderSlots = window.innerWidth >= 2400 ? 8 : 4;
  var totalSlots = Math.max(placeholderSlots, GameConstants.MAX_PLAYERS);

  // Ensure we have enough slot elements
  while (playerListEl.children.length < totalSlots) {
    var slot = document.createElement('div');
    slot.className = 'player-slot';
    var card = document.createElement('div');
    card.className = 'player-card empty';
    var name = document.createElement('span');
    var idx = playerListEl.children.length;
    name.textContent = 'P' + (idx + 1);
    card.appendChild(name);
    card.appendChild(buildLevelPlaceholder());
    slot.appendChild(card);
    playerListEl.appendChild(slot);
  }

  // Find the highest occupied slot to know which cards to show
  var highestOccupied = -1;
  for (const entry of players) {
    if (entry[1].playerIndex > highestOccupied) highestOccupied = entry[1].playerIndex;
  }
  var visibleSlots = Math.max(placeholderSlots, highestOccupied + 1);

  for (var j = 0; j < totalSlots; j++) {
    var slot = playerListEl.children[j];
    var card = slot.querySelector('.player-card');
    var nameEl = card.querySelector('span');

    // Hide slots beyond visible range
    slot.style.display = j < visibleSlots ? '' : 'none';

    // Find player assigned to this slot by playerIndex
    var playerId = null;
    var info = null;
    for (const entry of players) {
      if (entry[1].playerIndex === j) {
        playerId = entry[0];
        info = entry[1];
        break;
      }
    }
    var wasEmpty = card.classList.contains('empty');

    if (info) {
      var color = info.playerColor || PLAYER_COLORS[info.playerIndex] || '#fff';
      card.style.setProperty('--player-color', color);
      nameEl.textContent = info.playerName || PLAYER_NAMES[info.playerIndex] || t('player');
      card.classList.remove('empty');
      card.dataset.playerId = playerId;
      slot.dataset.playerId = playerId;
      if (wasEmpty) {
        card.classList.remove('join-pop');
        void card.offsetWidth;
        card.classList.add('join-pop');
      }
      // Remove placeholder if present
      var ph = card.querySelector('.level-placeholder');
      if (ph) ph.remove();
      // Level controls inside card
      var levelCtrl = card.querySelector('.level-controls');
      if (!levelCtrl) {
        levelCtrl = document.createElement('div');
        levelCtrl.className = 'level-controls';
        levelCtrl.innerHTML = '<span class="level-heading">' + t('level_heading') + '</span><button class="level-btn level-minus" aria-label="Decrease level"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/></svg></button><span class="level-label"></span><button class="level-btn level-plus" aria-label="Increase level"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/><line x1="7" y1="2" x2="7" y2="12"/></svg></button>';
        card.appendChild(levelCtrl);
      }
      var lvl = info.startLevel || 1;
      levelCtrl.querySelector('.level-label').textContent = lvl;
      levelCtrl.querySelector('.level-minus').disabled = lvl <= 1;
      levelCtrl.querySelector('.level-plus').disabled = lvl >= 15;
    } else {
      card.style.removeProperty('--player-color');
      nameEl.textContent = 'P' + (j + 1);
      card.classList.add('empty');
      card.classList.remove('join-pop');
      delete card.dataset.playerId;
      delete slot.dataset.playerId;
      var levelCtrl = card.querySelector('.level-controls');
      if (levelCtrl) levelCtrl.remove();
      // Add placeholder level row so empty cards match filled card height
      if (!card.querySelector('.level-placeholder')) {
        card.appendChild(buildLevelPlaceholder());
      }
    }
  }
}

function updateStartButton() {
  var hasPlayers = players.size > 0;
  startBtn.disabled = !hasPlayers;
  startBtn.textContent = hasPlayers
    ? t('start_n_players', { count: players.size })
    : t('waiting_for_players');
}

// Delegated click handler for level +/- buttons on display player cards
playerListEl.addEventListener('click', function(e) {
  var btn = e.target.closest('.level-btn');
  if (!btn) return;
  var slot = btn.closest('.player-slot');
  if (!slot || !slot.dataset.playerId) return;
  var pid = slot.dataset.playerId;
  var player = players.get(pid);
  if (!player) return;
  var lvl = player.startLevel || 1;
  if (btn.classList.contains('level-minus')) {
    lvl = Math.max(1, lvl - 1);
  } else if (btn.classList.contains('level-plus')) {
    lvl = Math.min(15, lvl + 1);
  }
  player.startLevel = lvl;
  updatePlayerList();
  broadcastLobbyUpdate();
});

// --- QR Code Rendering ---
function renderQR(canvas, qrMatrix, targetCssSize) {
  if (!qrMatrix || !qrMatrix.modules) return;
  var size = qrMatrix.size;
  var modules = qrMatrix.modules;

  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.getBoundingClientRect();
  var cssSize = targetCssSize || Math.min(rect.width, rect.height) || 180;
  var cellPx = Math.floor((cssSize * dpr) / size);
  var totalPx = cellPx * size;

  canvas.width = totalPx;
  canvas.height = totalPx;

  var qrCtx = canvas.getContext('2d');
  qrCtx.clearRect(0, 0, totalPx, totalPx);

  qrCtx.fillStyle = THEME.color.text.white;
  qrCtx.fillRect(0, 0, totalPx, totalPx);

  var inset = Math.max(0.5, cellPx * 0.03);
  var radius = Math.max(1, cellPx * 0.15);

  qrCtx.fillStyle = THEME.color.bg.card;
  for (var row = 0; row < size; row++) {
    for (var col = 0; col < size; col++) {
      var idx = row * size + col;
      if (!(modules[idx] & 1)) continue;

      var x = col * cellPx + inset;
      var y = row * cellPx + inset;
      var s = cellPx - inset * 2;

      roundRect(qrCtx, x, y, s, s, radius);
      qrCtx.fill();
    }
  }
}

// --- Results Rendering ---
function renderResults(results) {
  resultsList.innerHTML = '';
  if (!results) return;

  var sorted = results.slice().sort(function(a, b) { return a.rank - b.rank; });

  var winner = sorted[0];
  if (winner) {
    var wInfo = players.get(winner.playerId);
    var winnerColor = wInfo?.playerColor || PLAYER_COLORS[wInfo?.playerIndex] || '#ffd700';
    resultsScreen.style.setProperty('--winner-glow', rgbaFromHex(winnerColor, 0.08));
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
      rank.textContent = tOrdinal(res.rank);
      row.appendChild(rank);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    var pInfo = players.get(res.playerId);
    nameEl.textContent = res.playerName || pInfo?.playerName || t('player');
    if (pInfo) {
      nameEl.style.color = pInfo.playerColor || PLAYER_COLORS[pInfo.playerIndex];
    }

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    stats.innerHTML = '<span>' + t('n_lines', { count: res.lines || 0 }) + '</span><span>' + t('level_n', { level: res.level || 1 }) + '</span>';

    info.appendChild(nameEl);
    info.appendChild(stats);
    row.appendChild(info);
    resultsList.appendChild(row);
  }
}

// --- Timer Rendering ---
function drawTimer(elapsedMs) {
  var totalSeconds = Math.floor(elapsedMs / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  var timeStr = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');

  var font = getDisplayFont();
  var cs = (boardRenderers.length > 0 ? boardRenderers[0].cellSize : 30);
  var timerSize = Math.max(THEME.font.minPx.timer, cs * THEME.font.cellScale.timer);

  var labelSize = Math.round(timerSize);
  var digitAdvance = labelSize * 0.92;
  var colonAdvance = labelSize * 0.52;
  var advances = [];
  var timerWidth = 0;
  for (var i = 0; i < timeStr.length; i++) {
    var advance = timeStr[i] === ':' ? colonAdvance : digitAdvance;
    advances.push(advance);
    timerWidth += advance;
  }
  // With odd board counts the centre board's stats text overlaps a centred timer,
  // so anchor the timer to the left edge of the screen instead.
  var n = boardRenderers.length;
  var startX;
  if (n > 0 && n % 2 === 1) {
    startX = THEME.size.canvasPad + timerSize * 0.3;
  } else {
    startX = cachedW / 2 - timerWidth / 2;
  }
  var btnTop = timerSize * 0.6;
  var y = btnTop;

  ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
  ctx.font = '700 ' + labelSize + 'px ' + font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.letterSpacing = '0.15em';
  var cursorX = startX;
  for (var k = 0; k < timeStr.length; k++) {
    var charX = cursorX + advances[k] / 2;
    ctx.fillText(timeStr[k], charX, y);
    cursorX += advances[k];
  }
  ctx.letterSpacing = '0px';
}
