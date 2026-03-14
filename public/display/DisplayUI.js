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
  var totalCellsTall = GameConstants.VISIBLE_HEIGHT + 3.6;

  function cellSizeFor(cols, rows) {
    var aw = (w - padding * (cols + 1)) / cols;
    var ah = (h - padding * (rows + 1)) / rows;
    return Math.floor(Math.min(aw / totalCellsWide, ah / totalCellsTall));
  }

  var gridCols, gridRows;
  if (n === 1) { gridCols = 1; gridRows = 1; }
  else if (n === 2) { gridCols = 2; gridRows = 1; }
  else if (n === 3) { gridCols = 3; gridRows = 1; }
  else if (n <= 4) {
    if (cellSizeFor(4, 1) >= cellSizeFor(2, 2)) {
      gridCols = 4; gridRows = 1;
    } else {
      gridCols = 2; gridRows = 2;
    }
  } else if (n <= 6) {
    if (cellSizeFor(n, 1) >= cellSizeFor(3, 2)) {
      gridCols = n; gridRows = 1;
    } else {
      gridCols = 3; gridRows = 2;
    }
  } else {
    // 7-8 players: 4x2 grid
    if (cellSizeFor(n, 1) >= cellSizeFor(4, 2)) {
      gridCols = n; gridRows = 1;
    } else {
      gridCols = 4; gridRows = 2;
    }
  }

  var cellSize = cellSizeFor(gridCols, gridRows);
  var boardWidthPx = 10 * cellSize;
  var boardHeightPx = 20 * cellSize;

  boardRenderers = [];
  uiRenderers = [];
  animations = new Animations(ctx);

  var maxSlots = gridCols * gridRows;
  for (var i = 0; i < n && i < maxSlots; i++) {
    var col = i % gridCols;
    var row = Math.floor(i / gridCols);
    var cellAreaW = w / gridCols;
    var cellAreaH = h / gridRows;
    var boardX = cellAreaW * col + (cellAreaW - boardWidthPx) / 2;
    var boardY = cellAreaH * row + (cellAreaH - boardHeightPx) / 2 + 10;
    var playerIndex = players.get(playerOrder[i])?.playerIndex ?? i;
    boardRenderers.push(new BoardRenderer(ctx, boardX, boardY, cellSize, playerIndex));
    uiRenderers.push(new UIRenderer(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex));
  }
}

// --- Lobby UI ---
var PLACEHOLDER_SLOTS = 4;  // Always show 4 placeholders in lobby

function updatePlayerList() {
  // Determine how many cards we need: at least PLACEHOLDER_SLOTS, or more if players exceed that
  var totalSlots = Math.max(PLACEHOLDER_SLOTS, GameConstants.MAX_PLAYERS);

  // Ensure we have enough card elements
  while (playerListEl.children.length < totalSlots) {
    var card = document.createElement('div');
    card.className = 'player-card empty';
    var name = document.createElement('span');
    var idx = playerListEl.children.length;
    name.textContent = 'P' + (idx + 1);
    card.appendChild(name);
    playerListEl.appendChild(card);
  }

  // Find the highest occupied slot to know which cards to show
  var highestOccupied = -1;
  for (const entry of players) {
    if (entry[1].playerIndex > highestOccupied) highestOccupied = entry[1].playerIndex;
  }
  var visibleSlots = Math.max(PLACEHOLDER_SLOTS, highestOccupied + 1);

  for (var j = 0; j < totalSlots; j++) {
    var card = playerListEl.children[j];
    var nameEl = card.querySelector('span');

    // Hide slots beyond visible range
    card.style.display = j < visibleSlots ? '' : 'none';

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
      if (wasEmpty) {
        card.classList.remove('join-pop');
        void card.offsetWidth;
        card.classList.add('join-pop');
      }
    } else {
      card.style.removeProperty('--player-color');
      nameEl.textContent = 'P' + (j + 1);
      card.classList.add('empty');
      card.classList.remove('join-pop');
      delete card.dataset.playerId;
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
  for (var k = 0; k < timeStr.length; k++) {
    var charX = cursorX + advances[k] / 2;
    ctx.fillText(timeStr[k], charX, y);
    cursorX += advances[k];
  }
  ctx.letterSpacing = '0px';
}
