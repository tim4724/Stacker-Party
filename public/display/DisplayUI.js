'use strict';

// =====================================================================
// Display UI — layout calculation, lobby UI, QR rendering, timer
// Depends on: DisplayState.js (globals)
// Called by: DisplayConnection.js, DisplayGame.js, display.js
// =====================================================================

// --- Layout Calculation ---
function calculateLayout() {
  if (!ctx || playerOrder.length === 0) return;

  var n = playerOrder.length;
  var w = window.innerWidth;
  var h = window.innerHeight;
  var padding = THEME.size.canvasPad;
  var totalCellsWide = GameConstants.BOARD_WIDTH + 3 + 3;
  var boardRows = GameConstants.VISIBLE_HEIGHT;
  // Gaps scale with cellSize to stay proportional at all zoom levels
  function nameGap(cs) { return cs * 0.6; }
  function scoreGap(cs) { return cs * 0.7; }
  var font = getDisplayFont();

  function measureHeight(weight, size) {
    ctx.font = weight + ' ' + size + 'px ' + font;
    var m = ctx.measureText('Mg');
    return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  }

  function textHeight(cs) {
    var nameSize = Math.max(THEME.font.minPx.name, cs * THEME.font.cellScale.name);
    var scoreSize = Math.max(THEME.font.minPx.score, cs * THEME.font.cellScale.score);
    var labelSize = Math.max(THEME.font.minPx.label, cs * THEME.font.cellScale.label);
    return measureHeight(700, nameSize) + nameGap(cs)
         + measureHeight(700, scoreSize) + measureHeight(500, labelSize) + scoreGap(cs);
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
  var boardWidthPx = 10 * cellSize;
  var boardHeightPx = 20 * cellSize;

  boardRenderers = [];
  uiRenderers = [];
  animations = new Animations(ctx);

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
    var ph = document.createElement('div');
    ph.className = 'level-controls level-placeholder';
    ph.setAttribute('aria-hidden', 'true');
    ph.innerHTML = '<span class="level-heading">Level</span><span class="level-btn"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/></svg></span><span class="level-label">1</span><span class="level-btn"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/><line x1="7" y1="2" x2="7" y2="12"/></svg></span>';
    card.appendChild(ph);
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
      nameEl.textContent = info.playerName || PLAYER_NAMES[info.playerIndex] || 'Player';
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
        levelCtrl.innerHTML = '<span class="level-heading">Level</span><button class="level-btn level-minus" aria-label="Decrease level"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/></svg></button><span class="level-label"></span><button class="level-btn level-plus" aria-label="Increase level"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/><line x1="7" y1="2" x2="7" y2="12"/></svg></button>';
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
        var ph = document.createElement('div');
        ph.className = 'level-controls level-placeholder';
        ph.setAttribute('aria-hidden', 'true');
        ph.innerHTML = '<span class="level-heading">Level</span><span class="level-btn"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/></svg></span><span class="level-label">1</span><span class="level-btn"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><line x1="2" y1="7" x2="12" y2="7"/><line x1="7" y1="2" x2="7" y2="12"/></svg></span>';
        card.appendChild(ph);
      }
    }
  }
}

function updateStartButton() {
  var hasPlayers = players.size > 0;
  startBtn.disabled = !hasPlayers;
  startBtn.textContent = hasPlayers
    ? 'START (' + players.size + ' player' + (players.size > 1 ? 's' : '') + ')'
    : 'Waiting for players...';
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
function renderTetrisQR(canvas, qrMatrix) {
  if (!qrMatrix || !qrMatrix.modules) return;
  var size = qrMatrix.size;
  var modules = qrMatrix.modules;

  var dpr = window.devicePixelRatio || 1;
  var cssSize = canvas.parentElement
    ? Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight, 380)
    : 380;
  var cellPx = Math.floor((cssSize * dpr) / size);
  var totalPx = cellPx * size;

  canvas.width = totalPx;
  canvas.height = totalPx;
  canvas.style.width = (totalPx / dpr) + 'px';
  canvas.style.height = (totalPx / dpr) + 'px';

  var qrCtx = canvas.getContext('2d');
  qrCtx.clearRect(0, 0, totalPx, totalPx);

  qrCtx.fillStyle = THEME.color.text.white;
  qrCtx.fillRect(0, 0, totalPx, totalPx);

  var color = THEME.color.bg.card;
  var inset = Math.max(0.5, cellPx * 0.03);
  var radius = Math.max(1, cellPx * 0.15);

  for (var row = 0; row < size; row++) {
    for (var col = 0; col < size; col++) {
      var idx = row * size + col;
      var isDark = modules[idx] & 1;
      if (!isDark) continue;

      var x = col * cellPx;
      var y = row * cellPx;
      var s = cellPx;

      var grad = qrCtx.createLinearGradient(x, y, x, y + s);
      grad.addColorStop(0, lightenColor(color, 15));
      grad.addColorStop(1, darkenColor(color, 10));

      qrCtx.fillStyle = grad;
      roundRect(qrCtx, x + inset, y + inset, s - inset * 2, s - inset * 2, radius);
      qrCtx.fill();

      qrCtx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      qrCtx.fillRect(x + inset + radius, y + inset, s - inset * 2 - radius * 2, Math.max(1, s * 0.08));

      qrCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      qrCtx.fillRect(x + inset, y + inset + radius, Math.max(1, s * 0.07), s - inset * 2 - radius * 2);

      qrCtx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      qrCtx.fillRect(x + inset + radius, y + s - inset - Math.max(1, s * 0.08), s - inset * 2 - radius * 2, Math.max(1, s * 0.08));

      qrCtx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      var shineSize = s * 0.25;
      qrCtx.fillRect(x + s * 0.25, y + s * 0.2, shineSize, shineSize * 0.5);
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
    resultsScreen.style.setProperty('--winner-glow', 'color-mix(in srgb, ' + winnerColor + ' 8%, transparent)');
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
  var startX = window.innerWidth / 2 - timerWidth / 2;
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
