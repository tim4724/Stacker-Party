'use strict';

// =====================================================================
// Display UI — layout calculation, lobby UI, QR rendering, timer
// Depends on: DisplayState.js (globals)
// Called by: DisplayConnection.js, DisplayGame.js, display.js
// =====================================================================

// Build the static "LEVEL" pill shown beneath the player name. The value
// span starts empty; updatePlayerList writes the player's startLevel into
// it when the slot fills, and clears it when the slot empties.
function buildCardLevelLabel() {
  var lvl = document.createElement('div');
  lvl.className = 'card-level';
  // Static scaffold — translated string injected via textContent below.
  lvl.innerHTML = '<span class="card-level__pill"><span class="card-level__heading"></span><span class="card-level__value"></span></span>';
  lvl.querySelector('.card-level__heading').textContent = t('level_heading');
  return lvl;
}

// Faint hex opening shown inside empty-slot sockets. Static rounded
// flat-top hex path (precomputed); CSS shows it only on .empty cards and
// sizes it for 10-foot viewing.
function buildSocketOpening() {
  var opening = document.createElement('span');
  opening.className = 'player-card__opening';
  opening.innerHTML = '<svg viewBox="-20 -17.32 40 34.64" width="40" height="34.64" aria-hidden="true">'
    + '<path d="M16.4,-2.77 Q18,0 16.4,2.77 L10.6,12.82 Q9,15.59 5.8,15.59 L-5.8,15.59 Q-9,15.59 -10.6,12.82 '
    + 'L-16.4,2.77 Q-18,0 -16.4,-2.77 L-10.6,-12.82 Q-9,-15.59 -5.8,-15.59 L5.8,-15.59 Q9,-15.59 10.6,-12.82 Z" '
    + 'fill="rgba(255,248,236,0.03)" stroke="rgba(247,241,232,0.45)" stroke-width="2"/></svg>';
  return opening;
}

// --- Layout Calculation ---
// Grid rows of the current board layout, cached for drawTimer: two-row grids
// leave no free band above the top boards, so the clock shrinks to share the
// name-label band instead of overlapping the board frames.
var cachedGridRows = 1;

function calculateLayout() {
  if (!ctx || playerOrder.length === 0) return;
  // playerOrder is already join-ordered — the room core appends in join order and
  // pins the sort at game start (freezeParticipantOrder) — so board positions are
  // stable across colour changes and sticky-host moves without re-sorting here.
  // Re-sorting would ALSO be a write: playerOrder aliases the room core's own
  // participant array, and a render pass has no business mutating room state.
  clearStampCache();
  // Renderers are being rebuilt, so the last painted frame no longer matches
  // what render would produce and the identical-frame skip must not fire.
  invalidateRenderSig();

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
  cachedGridRows = gridRows;
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
    var br = new BoardRenderer(ctx, boardX, boardY, cellSize, playerIndex);
    // Per-board dirty-render tile (see DisplayRender.js): this board's
    // exclusive slice of the canvas, the grid cell plus half the surrounding
    // padding on each side. Tiles are adjacent without overlap, and their
    // boundaries run through empty background padding, so blitting one can't
    // clobber a neighbor's content.
    br.tileRect = {
      x: padding / 2 + col * (cellAreaW + padding),
      y: padding / 2 + row * (cellAreaH + padding),
      w: cellAreaW + padding,
      h: cellAreaH + padding
    };
    boardRenderers.push(br);
    uiRenderers.push(new UIRenderer(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex));
  }
}

// --- Lobby UI ---
function updatePlayerList() {
  // Ensure we have enough slot elements. Every card carries all three
  // pieces (name half, level half, socket opening); CSS shows the halves
  // on filled cards and the opening on .empty sockets, so filling or
  // emptying a slot is a class toggle, not a DOM rebuild.
  while (playerListEl.children.length < GameConstants.MAX_PLAYERS) {
    var slot = document.createElement('div');
    slot.className = 'player-slot';
    var card = document.createElement('div');
    card.className = 'player-card empty';
    var topRow = document.createElement('div');
    topRow.className = 'player-card__top';
    var name = document.createElement('span');
    name.className = 'identity-name';
    topRow.appendChild(name);
    card.appendChild(topRow);
    card.appendChild(buildCardLevelLabel());
    card.appendChild(buildSocketOpening());
    slot.appendChild(card);
    playerListEl.appendChild(slot);
  }

  // Cards pack tightly: N players fill the first N slots. Ordering follows
  // join time so a player's seat is stable across color changes — color
  // picks recolor the card in place rather than swapping slots with a
  // neighbor. Same rule used by calculateLayout() for the game boards.
  var sortedPlayers = Array.from(players.entries()).sort(function(a, b) {
    return (a[1].joinedAt ?? Infinity) - (b[1].joinedAt ?? Infinity);
  });
  // The lobby has exactly two shapes, chosen by the roster alone and never
  // by viewport size: a 4-socket grid, opening to all 8 once a 5th player
  // joins. Empty sockets past the roster stay visible as "seats free".
  var visibleSlots = sortedPlayers.length > 4 ? GameConstants.MAX_PLAYERS : 4;

  // Grid column count, fed to the CSS via --cols. AirConsole hides empty
  // slots and packs the visible cards into one row (up to 4, no QR means
  // there's room); the web lobby is a 2-column grid, going 4-wide in
  // landscape once the grid opens to 8 so it stays wide-and-short next to
  // the QR. Portrait stays 2-wide either way: the QR stacks above, so the
  // grid has height to spend but no width.
  var isAirConsole = document.body.classList.contains('airconsole');
  var landscape = window.innerWidth > window.innerHeight;
  var cols = isAirConsole
    ? Math.min(Math.max(players.size, 1), 4)
    : (visibleSlots > 4 && landscape ? 4 : 2);
  playerListEl.style.setProperty('--cols', cols);
  fitLobbyRow(cols, isAirConsole, landscape);

  for (var j = 0; j < GameConstants.MAX_PLAYERS; j++) {
    var slot = playerListEl.children[j];
    var card = slot.querySelector('.player-card');
    var nameEl = card.querySelector('.identity-name');
    var levelValueEl = card.querySelector('.card-level__value');

    // Hide slots beyond visible range
    slot.style.display = j < visibleSlots ? '' : 'none';

    // Nth filled slot gets the Nth player from the join-sorted list.
    var playerId = null;
    var info = null;
    if (j < sortedPlayers.length) {
      playerId = sortedPlayers[j][0];
      info = sortedPlayers[j][1];
    }
    var wasEmpty = card.classList.contains('empty');

    if (info) {
      var color = PLAYER_COLORS[info.playerIndex] || '#fff';
      var lvl = info.startLevel || 1;
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
      levelValueEl.textContent = lvl;
    } else {
      card.style.removeProperty('--player-color');
      // Sockets carry no text — the hex opening is the only content.
      // Clear rather than leave stale name/level from a departed player.
      nameEl.textContent = '';
      card.classList.add('empty');
      card.classList.remove('join-pop');
      delete card.dataset.playerId;
      delete slot.dataset.playerId;
      levelValueEl.textContent = '';
    }
  }

  fitPlayerNames();
}

// Proportional row fit, mirroring the tvOS/Android TV lobbies: when the
// widest row (QR + a 4-wide roster) would overflow #lobby-main, scale
// --card-w down so the QR (calc(--card-w + 40px)) and the cards shrink
// TOGETHER, instead of the grid's minmax() crushing only the card columns
// beside a full-size QR. The clamps mirror display.css: --card-w
// clamp(150px, 36vmin, 350px), grid gap clamp(8px, 1.5vmin, 18px),
// #lobby-main gap clamp(1rem, 3vmin, 2.5rem).
function fitLobbyRow(cols, isAirConsole, landscape) {
  var lobbyMain = document.getElementById('lobby-main');
  if (!lobbyMain || !lobbyMain.clientWidth) return;
  var vmin = Math.min(window.innerWidth, window.innerHeight);
  var cardW = Math.max(150, Math.min(0.36 * vmin, 350));
  var gap = Math.max(8, Math.min(0.015 * vmin, 18));
  // The QR shares the row only in landscape (portrait stacks it above the
  // grid) and never on AirConsole (no QR at all).
  var hasQr = !isAirConsole && landscape;
  var avail = lobbyMain.clientWidth - (cols - 1) * gap;
  if (hasQr) avail -= Math.max(16, Math.min(0.03 * vmin, 40)) + 40;
  var fitted = Math.min(cardW, avail / (cols + (hasQr ? 1 : 0)));
  if (fitted < cardW) {
    lobbyMain.style.setProperty('--card-w', fitted.toFixed(2) + 'px');
  } else {
    lobbyMain.style.removeProperty('--card-w');
  }
}

// Shrink-to-fit for card names: CSS has no native "auto" font-size, so
// measure each name at its stylesheet size and scale it down only when it
// overflows its card (narrow viewports where the grid's minmax() squeezes
// the columns below --card-w). Names at or under the card width keep the
// default size untouched. Below the floor the existing ellipsis takes over:
// past that the name is too small to read from the couch, so truncating beats
// shrinking further.
// Re-run on every roster change and window resize (both funnel through
// updatePlayerList), plus once when the webfont finishes loading since
// fallback-font metrics under-measure Baloo 2.
// Kept in sync with the controller's NAME_FIT_MIN_SCALE (ControllerGame.js) —
// separate bundles, so the value is mirrored rather than shared.
var NAME_FIT_MIN_SCALE = 0.5;
function fitPlayerNames() {
  var names = playerListEl.querySelectorAll('.identity-name');
  for (var i = 0; i < names.length; i++) {
    var el = names[i];
    el.style.fontSize = '';
    // clientWidth 0 = lobby (or slot) hidden, nothing to measure; the
    // lobby-show path calls updatePlayerList() again once visible.
    if (!el.textContent || !el.clientWidth) continue;
    if (el.scrollWidth <= el.clientWidth) continue;
    var base = parseFloat(getComputedStyle(el).fontSize);
    // 0.98 fudge: scroll/client widths are integer-rounded, and without it
    // a hairline overflow survives the rescale and re-triggers the ellipsis.
    var scale = Math.max(NAME_FIT_MIN_SCALE, (el.clientWidth / el.scrollWidth) * 0.98);
    el.style.fontSize = (base * scale).toFixed(2) + 'px';
  }
}

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(function() { fitPlayerNames(); });
}

function updateStartButton() {
  var hasPlayers = players.size > 0;
  startBtn.disabled = !hasPlayers;
  startBtn.textContent = hasPlayers
    ? t('start_n_players', { count: players.size })
    : t('waiting_for_players');
  applyHostTint();
}

// Tint primary CTAs (lobby start + pause/reconnect/results overlays) with the
// current host's identity color. Setting on <body> lets every tinted button in
// theme.css inherit without per-button wiring. Shared rule reads
// --player-color, falling back to --accent-primary when unset. Called both
// from the lobby flow (updateStartButton) and from publishRoomState so a
// mid-game host handoff (AirConsole master_changed, player leaving during
// RESULTS) refreshes the tint on the pause/results/reconnect overlays too.
function applyHostTint() {
  var hostId = getHostPeerIndex();
  var hostPlayer = hostId != null ? players.get(hostId) : null;
  var hostColor = hostPlayer ? PLAYER_COLORS[hostPlayer.playerIndex] : null;
  if (hostColor) {
    document.body.style.setProperty('--player-color', hostColor);
  } else {
    document.body.style.removeProperty('--player-color');
  }
}

// --- Relay Region Chip ---
// Maps relay-supplied region codes to a city + flag. The relay (Party-Sockets)
// uses Fly.io 3-letter codes — see Party-Sockets/regions.ts for the canonical
// list. The chip shows the city for legibility ("Frankfurt 🇩🇪"); the IATA
// code stays in the tooltip and the report email so support has the
// unambiguous identifier. Unknown codes fall back to the raw uppercase code
// without a flag, so a relay-side region addition won't break the chip until
// this map catches up.
var RELAY_REGION_META = {
  ams: { city: 'Amsterdam',    flag: '🇳🇱' },
  arn: { city: 'Stockholm',    flag: '🇸🇪' },
  bom: { city: 'Mumbai',       flag: '🇮🇳' },
  cdg: { city: 'Paris',        flag: '🇫🇷' },
  dfw: { city: 'Dallas',       flag: '🇺🇸' },
  ewr: { city: 'New Jersey',   flag: '🇺🇸' },
  fra: { city: 'Frankfurt',    flag: '🇩🇪' },
  gru: { city: 'São Paulo',    flag: '🇧🇷' },
  iad: { city: 'Ashburn',      flag: '🇺🇸' },
  jnb: { city: 'Johannesburg', flag: '🇿🇦' },
  lax: { city: 'Los Angeles',  flag: '🇺🇸' },
  lhr: { city: 'London',       flag: '🇬🇧' },
  nrt: { city: 'Tokyo',        flag: '🇯🇵' },
  ord: { city: 'Chicago',      flag: '🇺🇸' },
  sin: { city: 'Singapore',    flag: '🇸🇬' },
  sjc: { city: 'San Jose',     flag: '🇺🇸' },
  syd: { city: 'Sydney',       flag: '🇦🇺' },
  yyz: { city: 'Toronto',      flag: '🇨🇦' }
};

function updateRelayChip() {
  if (!relayChip) return;
  // AirConsole runs on its own network — our relay diagnostics don't apply.
  if (document.body.classList.contains('airconsole')) {
    relayChip.classList.add('hidden');
    return;
  }
  // Need at least a region or a measured RTT to show anything useful.
  if (!relayRegion && lastRelayRtt < 0) {
    relayChip.classList.add('hidden');
    return;
  }

  var rttText = lastRelayRtt >= 0 ? lastRelayRtt + ' ms' : 'measuring…';
  if (relayRegion) {
    var code = String(relayRegion).toLowerCase();
    var meta = RELAY_REGION_META[code];
    relayChipRegion.textContent = meta ? meta.city + ' ' + meta.flag : code.toUpperCase();
    relayChip.dataset.tooltip = code.toUpperCase() + ' · ' + rttText + ' RTT';
  } else {
    relayChipRegion.textContent = rttText;
    delete relayChip.dataset.tooltip;
  }
  relayChip.classList.remove('hidden');

  relayChipDot.classList.remove('ping-ok', 'ping-bad');
  if (lastRelayRtt < 0) {
    // No measurement yet — keep the default good (mint) tint.
  } else if (lastRelayRtt > RELAY_RTT_OK_MS) {
    relayChipDot.classList.add('ping-bad');
  } else if (lastRelayRtt > RELAY_RTT_GOOD_MS) {
    relayChipDot.classList.add('ping-ok');
  }

  // Sticky reveal: once the user has seen sustained bad latency, the report
  // button stays visible until resetToWelcome clears the session — so the
  // button doesn't blink in/out as RTT oscillates, and a user mid-click
  // doesn't lose the target. Hidden again only on a fresh welcome entry.
  if (relayReportBtn && consecutiveBadRtt >= RELAY_REPORT_THRESHOLD) {
    relayReportBtn.classList.remove('hidden');
  }
}

function buildRelayReportMailto() {
  var subject = 'HexStacker Party: bad latency report';
  var bodyLines = [
    'Hi, I\'m seeing bad latency in HexStacker Party. Details below:',
    '',
    'My location (city/country): ',
    '',
    'Server region: ' + (relayRegion || 'unknown'),
    'App version: ' + (document.getElementById('lobby-version-label')?.textContent || 'unknown'),
    'Timestamp: ' + new Date().toISOString(),
    '',
    'Notes (optional): '
  ];
  return 'mailto:info@couch-games.com'
    + '?subject=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(bodyLines.join('\n'));
}

if (relayReportBtn) {
  relayReportBtn.addEventListener('click', function() {
    window.location.href = buildRelayReportMailto();
  });
}

// --- QR Code Rendering ---
function renderQR(canvas, qrMatrix, targetCssSize) {
  if (!qrMatrix || !qrMatrix.modules) return;
  var size = qrMatrix.size;
  var modules = qrMatrix.modules;

  // Load fade (tvOS/Android parity): repainting a DIFFERENT code while the
  // canvas is already on screen (a display rejoin that landed in a fresh
  // room) fades the new pattern in instead of popping. The FIRST paint is
  // deliberately instant — the lobby is revealed with its QR already
  // painted (applyRoomCreated) and the entrance stagger carries it. The
  // signature samples the matrix diagonal: enough to detect a code change.
  var sig = String(size);
  for (var d = 0; d < size; d++) sig += (modules[d * size + d] & 1) ? '1' : '0';
  if (canvas.dataset.qrSig && canvas.dataset.qrSig !== sig) {
    canvas.classList.remove('qr-swap');
    void canvas.offsetWidth;   // restart the animation
    canvas.classList.add('qr-swap');
  }
  canvas.dataset.qrSig = sig;

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

  // Unstyled: standard black square modules, edge-to-edge, for maximum scan
  // reliability (no rounded corners / inset gap / brand tint).
  qrCtx.fillStyle = '#000000';
  for (var row = 0; row < size; row++) {
    for (var col = 0; col < size; col++) {
      var idx = row * size + col;
      if (!(modules[idx] & 1)) continue;
      qrCtx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
    }
  }
}

// --- Results Rendering ---
function renderResults(results) {
  resultsList.innerHTML = '';
  if (!results) return;

  // newPlayer entries (late joiners who sat out this round) carry no rank, so
  // they sort last and render a "New player" status in place of stats.
  var sorted = results.slice().sort(function(a, b) { return (a.rank || 999) - (b.rank || 999); });

  var winner = sorted[0];
  if (winner) {
    var wInfo = players.get(winner.playerId);
    var winnerColor = (wInfo && PLAYER_COLORS[wInfo.playerIndex]) || '#ffd700';
    resultsScreen.style.setProperty('--winner-glow', rgbaFromHex(winnerColor, 0.08));
  }

  // A late joiner counts toward the row total, so a 1-player game with one
  // waiting joiner is intentionally not "solo": the rank column appears.
  var solo = sorted.length === 1;

  for (var i = 0; i < sorted.length; i++) {
    var res = sorted[i];
    var isNew = !!res.newPlayer;
    var row = document.createElement('div');
    row.className = 'result-row';
    if (!solo && !isNew) row.className += ' rank-' + res.rank;
    if (isNew) row.className += ' result-row--joining';
    row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');

    var pInfo = players.get(res.playerId);
    var pColor = pInfo ? PLAYER_COLORS[pInfo.playerIndex] : null;

    if (!solo) {
      var rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = isNew ? '–' : String(res.rank);
      if (pColor) rank.style.color = pColor;
      row.appendChild(rank);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    nameEl.textContent = res.playerName || pInfo?.playerName || t('player');
    if (pColor) nameEl.style.color = pColor;

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    if (isNew) {
      var statusSpan = document.createElement('span');
      statusSpan.textContent = t('new_player');
      stats.appendChild(statusSpan);
    } else {
      var linesSpan = document.createElement('span');
      linesSpan.textContent = t('n_lines', { count: res.lines || 0 });
      var levelSpan = document.createElement('span');
      levelSpan.textContent = t('level_n', { level: res.level || 1 });
      stats.appendChild(linesSpan);
      stats.appendChild(levelSpan);
    }

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
  // Fixed size relative to screen height, not cell size, so the clock reads the
  // same regardless of board count and matches the tvOS/Android renderers.
  var timerSize = Math.max(24, Math.min(cachedH * 0.04, 60));
  // Two board rows (7-8 players) leave no free band above the top boards, so
  // shrink the clock to sit inside the name-label band instead of overlapping
  // the board frames.
  if (cachedGridRows > 1) timerSize *= 0.6;

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

  ctx.fillStyle = 'rgba(247, 241, 232, ' + THEME.opacity.label + ')';
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
