'use strict';

// =====================================================================
// Controller Game — game screens, touch input, feedback, results
// Depends on: ControllerState.js (globals), ControllerConnection.js (sendToDisplay)
// Called by: controller.js (message handlers)
// =====================================================================

// =====================================================================
// Lobby / Welcome
// =====================================================================

function updateLevelDisplay() {
  if (levelDisplay) levelDisplay.textContent = startLevel;
  if (levelMinusBtn) levelMinusBtn.disabled = startLevel <= 1;
  if (levelPlusBtn) levelPlusBtn.disabled = startLevel >= 15;
}

// Apply host info from a WELCOME or LOBBY_UPDATE payload, then refresh any
// visible host-gated UI. Safe to call on any screen.
function applyHostInfo(data) {
  if (data.isHost !== undefined) isHost = !!data.isHost;
  if (data.hostName !== undefined) hostName = data.hostName;
  if (data.hostColorIndex !== undefined) {
    hostColor = data.hostColorIndex != null ? PLAYER_COLORS[data.hostColorIndex] : null;
  }
  updateHostVisibility();
  if (typeof updateSettingsHostUI === 'function') updateSettingsHostUI();
}

function updateHostVisibility() {
  // Lobby: host sees Start button, non-host sees waiting banner.
  // Skip when waitingForNextGame — late joiners in an active game sit on
  // the lobby screen with the "game_in_progress" banner already in place;
  // letting the host-gate overwrite it would hide that status.
  if (currentScreen === 'lobby' && !waitingForNextGame) {
    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = false;
      setWaitingActionMessage('');
    } else {
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      renderHostBanner(waitingActionText, 'waiting_for_host_to_start', hostName || t('player'), hostColor);
      waitingActionText.classList.remove('hidden');
    }
  }
  // Results: host sees Play Again / New Game, non-host sees waiting banner.
  // The 1.5s anti-misclick delay is handled by the #gameover-buttons CSS
  // animation (pointer-events: none during the delay), so a concurrent
  // LOBBY_UPDATE mid-delay can't flip the buttons to clickable early — the
  // animation restarts whenever the element transitions from hidden to shown.
  if (currentScreen === 'gameover') {
    if (isHost) {
      gameoverStatus.textContent = '';
      gameoverStatus.style.color = '';
      gameoverButtons.classList.remove('hidden');
    } else {
      gameoverButtons.classList.add('hidden');
      renderHostBanner(gameoverStatus, 'waiting_for_host_to_continue', hostName || t('player'), hostColor);
    }
  }
  // Pause overlay: non-host can still resume, but can't return to lobby.
  if (pauseNewGameBtn) {
    pauseNewGameBtn.classList.toggle('hidden', !isHost);
  }
}

function showLobbyUI() {
  playerIdentity.style.setProperty('--player-color', playerColor);
  playerIdentityName.textContent = playerName || t('player');
  updateLevelDisplay();

  updateStartButton();
  statusText.textContent = '';
  statusDetail.textContent = '';

  showScreen('lobby');
  // Paint after showScreen so that updateHostVisibility (below) sees
  // currentScreen === 'lobby' and wires up host-gated UI. The picker
  // itself uses a fixed-size canvas buffer so it doesn't depend on
  // visibility for measurement.
  renderColorPicker();
  // Must run after showScreen so currentScreen === 'lobby' when we gate UI.
  updateHostVisibility();
}

// Fixed canvas buffer for every picker swatch. Pinning these means a
// repaint (e.g. on level change re-tiering) never reassigns canvas.width —
// which would clear the buffer and re-anchor DPR, causing a one-frame
// flicker as the hex jumped by a sub-pixel. CSS width:100%/height:100%
// scales the buffer to the live button rect. Buffer is the hex stamp's
// natural output size (height + stamp padding, width = height / sin(60°));
// not DPR-scaled — acceptable for a small picker swatch, follow-up work
// if higher fidelity is needed on 3× displays.
var COLOR_PICKER_CANVAS_H = 88;
var COLOR_PICKER_CANVAS_W = 102;  // ≈ height / sin(60°) + stamp padding

// Repaint the 8-swatch color picker. Each swatch is a <button> containing a
// <canvas>; we redraw the canvas on every call so the style tier follows
// the current startLevel (NORMAL / PILLOW / NEON_FLAT) and swatches preview
// exactly what the player's blocks will look like in-game.
function renderColorPicker() {
  if (!colorPickerEl) return;
  var taken = new Set(takenColorIndices || []);
  var tier = (typeof getStyleTier === 'function') ? getStyleTier(startLevel || 1) : STYLE_TIERS.NORMAL;
  var btns = colorPickerEl.children;
  for (var i = 0; i < btns.length; i++) {
    var btn = btns[i];
    var idx = parseInt(btn.dataset.idx, 10);
    var isMine = idx === playerColorIndex;
    var isTaken = !isMine && taken.has(idx);
    btn.classList.toggle('selected', isMine);
    btn.classList.toggle('taken', isTaken);
    btn.setAttribute('aria-checked', isMine ? 'true' : 'false');
    if (isTaken) {
      btn.setAttribute('aria-disabled', 'true');
      // Pull taken swatches out of tab order so keyboard users don't
      // land on a focusable-but-inert button. Mouse taps are blocked by
      // .color-swatch.taken .color-swatch__hit { pointer-events: none }
      // in controller.css, with the JS guard in controller.js as backup.
      btn.setAttribute('tabindex', '-1');
    } else {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('tabindex');
    }
    paintColorSwatch(btn, tier, PLAYER_COLORS[idx], isTaken);
  }
}

// Draw a single flat-top hex into the swatch's fixed-size canvas buffer.
// The source stamp is cached per (tier, color, size) by getHexStamp; we
// just blit it centered. Buffer dims are pinned at buildColorPicker time so
// repeated repaints (level changes, taken toggles) do not resize the canvas
// — resizing clears it and re-anchors DPR, which manifested as a one-frame
// jump on tier swap. Early-returns when CanvasUtils isn't loaded yet.
//
// Taken swatches keep the player's real color (dimmed via CSS opacity)
// and gain a white "X" overlay so the unavailable state is unambiguous
// without losing the color identity.
function paintColorSwatch(btn, tier, color, isTaken) {
  var canvas = btn.firstChild;
  if (!canvas || typeof getHexStamp !== 'function') return;
  var w = canvas.width, h = canvas.height;
  var ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // Stamp size is the hex's drawn height; pass a value slightly under the
  // buffer height so the stamp's internal padding fits without overflow.
  var stampSize = h - 8;
  var stamp = getHexStamp(tier, color, stampSize);
  var dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  var sw = stamp.cssW != null ? stamp.cssW : stamp.width / dpr;
  var sh = stamp.cssH != null ? stamp.cssH : stamp.height / dpr;
  if (isTaken) {
    // Dim the hex with canvas globalAlpha so the X (drawn next at full
    // alpha) keeps its full chroma. CSS filter on the canvas would dim
    // both equally, washing the X out.
    ctx.globalAlpha = 0.4;
    ctx.drawImage(stamp, (w - sw) / 2, (h - sh) / 2, sw, sh);
    ctx.globalAlpha = 1;

    // Diagonal "X" centered on the hex in the player's own color so it
    // pops as the un-dimmed signature against the faded background.
    var cx = w / 2, cy = h / 2;
    var arm = h * 0.22;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, h * 0.08);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy - arm);
    ctx.lineTo(cx + arm, cy + arm);
    ctx.moveTo(cx + arm, cy - arm);
    ctx.lineTo(cx - arm, cy + arm);
    ctx.stroke();
  } else {
    ctx.drawImage(stamp, (w - sw) / 2, (h - sh) / 2, sw, sh);
  }
  btn.style.setProperty('--swatch-color', color);
}

// Snapshot of the persisted color from the previous session. Captured at
// script load in standalone mode; in AirConsole mode the storage shim
// hydrates asynchronously after onReady, so the bootstrap re-runs the
// capture from its onLoad callback (before HELLO leaves the wire and
// before WELCOME's persistColorIndex() can overwrite the stored value).
var _previousSessionColorIndex = null;
function captureSessionColorIndex() {
  var raw = null;
  try { raw = localStorage.getItem('stacker_color_index'); } catch (e) { /* iframe sandbox */ }
  console.log('[color-debug] captureSessionColorIndex raw=', raw, 'prev was=', _previousSessionColorIndex);
  if (raw == null) return;
  var idx = parseInt(raw, 10);
  if (!isNaN(idx) && idx >= 0 && idx < PLAYER_COLORS.length) {
    _previousSessionColorIndex = idx;
    console.log('[color-debug] _previousSessionColorIndex set to', idx);
  }
}
captureSessionColorIndex();

// Save the player's current color so a future reload can reclaim it.
// Called whenever the display confirms our colorIndex.
function persistColorIndex(idx) {
  console.log('[color-debug] persistColorIndex(', idx, ')');
  try { localStorage.setItem('stacker_color_index', String(idx)); }
  catch (e) { /* iframe sandbox */ }
}

// If the previous session's color differs from what the display just
// assigned, ask for it back. Same-index is a no-op on the display side;
// collisions are silently rejected. Skip the round-trip when our preferred
// color is already taken (takenColorIndices is set from the same WELCOME
// just before this fires).
function reclaimPreferredColor() {
  console.log('[color-debug] reclaimPreferredColor prev=', _previousSessionColorIndex,
              'current=', playerColorIndex, 'taken=', takenColorIndices);
  if (_previousSessionColorIndex == null) return console.log('[color-debug] reclaim: no prev');
  if (_previousSessionColorIndex === playerColorIndex) return console.log('[color-debug] reclaim: prev === current');
  if (typeof sendToDisplay !== 'function' || playerColorIndex == null) return console.log('[color-debug] reclaim: no sendToDisplay');
  if (takenColorIndices && takenColorIndices.indexOf(_previousSessionColorIndex) >= 0) return console.log('[color-debug] reclaim: prev is taken');
  console.log('[color-debug] reclaim: sending SET_COLOR(', _previousSessionColorIndex, ')');
  sendToDisplay(MSG.SET_COLOR, { colorIndex: _previousSessionColorIndex });
}

// One-time palette paint — creates 8 button+canvas pairs and wires aria.
// Called from controller.js init. Click delegation happens at the container.
function buildColorPicker() {
  if (!colorPickerEl || colorPickerEl.children.length) return;
  for (var i = 0; i < PLAYER_COLORS.length; i++) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch';
    btn.dataset.idx = String(i);
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.setAttribute('aria-label', t('color_choose', { n: i + 1 }));
    var canvas = document.createElement('canvas');
    canvas.width = COLOR_PICKER_CANVAS_W;
    canvas.height = COLOR_PICKER_CANVAS_H;
    btn.appendChild(canvas);
    // Hex-clipped hit overlay — see .color-swatch in controller.css for
    // the rationale (rectangular buttons would steal slanted-edge clicks
    // from honeycomb neighbours).
    var hit = document.createElement('span');
    hit.className = 'color-swatch__hit';
    btn.appendChild(hit);
    colorPickerEl.appendChild(btn);
  }
}

function updateStartButton() {
  startBtn.textContent = t('start_n_players', { count: playerCount });
}

function setWaitingActionMessage(message) {
  waitingActionText.textContent = message || '';
  waitingActionText.classList.toggle('hidden', !message);
  waitingActionText.style.color = '';
}

// Render a "Waiting for {name}..." banner with only the player name colored.
// Uses DOM nodes rather than innerHTML so the untrusted name can't inject HTML.
// Everything is wrapped in a single inline span so the parent's `display: flex`
// sees only one flex item — otherwise each text node + name span becomes its
// own item and the text can't wrap naturally between words.
// Assumes each locale string has exactly one {name} placeholder. A template
// with multiple {name} occurrences would split into 3+ parts and only
// parts[0]/parts[1] would render. tests/i18n.test.js ("waiting_for_host
// banner keys contain exactly one {name}") enforces this invariant.
function renderHostBanner(element, key, name, color) {
  element.textContent = '';
  element.style.color = '';
  var wrap = document.createElement('span');
  var tmpl = t(key, { name: '\x00' });
  var parts = tmpl.split('\x00');
  var nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  if (color) nameSpan.style.color = color;
  if (parts.length < 2) {
    // Graceful degrade for a malformed locale: render the template text
    // followed by a space and the name, rather than colliding them.
    console.warn('[renderHostBanner] missing {name} placeholder in locale key:', key);
    wrap.appendChild(document.createTextNode(parts[0] + ' '));
    wrap.appendChild(nameSpan);
  } else {
    wrap.appendChild(document.createTextNode(parts[0]));
    wrap.appendChild(nameSpan);
    wrap.appendChild(document.createTextNode(parts[1]));
  }
  element.appendChild(wrap);
}

// =====================================================================
// Message Handlers
// =====================================================================

function onWelcome(data) {
  if (data.colorIndex != null) {
    playerColorIndex = data.colorIndex;
    playerColor = PLAYER_COLORS[data.colorIndex] || PLAYER_COLORS[0];
    // Don't persist the display-assigned color here — it's not a user
    // choice. Persisting it would clobber the previous-session preference
    // before reclaimPreferredColor gets a chance to read it. The user's
    // explicit picks are persisted in onLobbyUpdate (display echoes the
    // accepted SET_COLOR back), which is the only signal that a colorIndex
    // is actually the user's selection.
  } else {
    // Defensive: the display always sends colorIndex, but if it's missing
    // keep whatever we already have. Only seed a default when nothing is
    // set — and seed both pieces so the picker still finds a selected
    // swatch on the next render.
    if (playerColorIndex == null) playerColorIndex = 0;
    if (!playerColor) playerColor = PLAYER_COLORS[0];
  }
  if (Array.isArray(data.takenColorIndices)) takenColorIndices = data.takenColorIndices;
  // Mirror the three setProperty targets in onLobbyUpdate. WELCOME's
  // colorIndex is the same value the controller already had (the display
  // doesn't reassign on reconnect), so this is symmetry/defensiveness
  // rather than a fix for an observed flash.
  document.body.style.setProperty('--player-color', playerColor);
  playerIdentity.style.setProperty('--player-color', playerColor);
  gameScreen.style.setProperty('--player-color', playerColor);
  playerCount = data.playerCount || 1;
  gameCancelled = false;
  waitingForNextGame = false;
  // Try to reclaim the user's preferred color (saved on prior swatch
  // taps). The display rejects same-idx as a no-op and silently rejects
  // collisions, so this is safe to fire on every WELCOME — the next
  // LOBBY_UPDATE settles the truth either way.
  reclaimPreferredColor();
  // Sync the display's mute state so a reconnecting / newly-promoted host
  // sees the correct Game Music toggle without waiting for the next
  // DISPLAY_MUTED broadcast.
  if (typeof data.displayMuted === 'boolean' && typeof onDisplayMuted === 'function') {
    onDisplayMuted({ muted: data.displayMuted });
  }
  // Set host state first so renderGameResults / showLobbyUI below see it.
  // updateHostVisibility is a no-op on the current screen ('name' or mid-
  // transition) thanks to its screen guards.
  applyHostInfo(data);

  if (party) party.resetReconnectCount();
  startPing();
  clearTimeout(disconnectedTimer);
  reconnectOverlay.classList.add('hidden');

  playerName = data.playerName || playerName || t('player');
  playerNameEl.textContent = playerName;
  touchArea.setAttribute('data-player-name', playerName);
  if (data.startLevel != null) startLevel = data.startLevel;

  if (data.roomState === 'playing' || data.roomState === 'countdown') {
    // Late joiner (not in active game) — display omits alive field
    if (data.alive === undefined) {
      waitingForNextGame = true;
      showLobbyUI();
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      setWaitingActionMessage(t('game_in_progress'));
      return;
    }

    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    gameScreen.classList.remove('countdown');
    gameScreen.style.setProperty('--player-color', playerColor);
    removeKoOverlay();
    pauseBtn.classList.remove('hidden');
    if (data.paused) {
      onGamePaused();
    } else {
      pauseOverlay.classList.add('hidden');
    }

    if (data.alive === false) {
      gameScreen.classList.add('dead');
      showKoOverlay();
    }

    showScreen('game');
    initTouchInput();
    return;
  }

  if (data.roomState === 'results') {
    var reconnectResults = data.results || lastGameResults;
    if (reconnectResults) {
      lastGameResults = reconnectResults;
      renderGameResults(reconnectResults);
      showScreen('gameover');
      return;
    }
    // No results available (e.g. fresh controller joining mid-results) — fall through to lobby
  }

  showLobbyUI();
}

function onLobbyUpdate(data) {
  playerCount = data.playerCount;
  if (data.startLevel != null) startLevel = data.startLevel;
  if (data.colorIndex != null && data.colorIndex !== playerColorIndex) {
    playerColorIndex = data.colorIndex;
    playerColor = PLAYER_COLORS[data.colorIndex] || playerColor;
    document.body.style.setProperty('--player-color', playerColor);
    playerIdentity.style.setProperty('--player-color', playerColor);
    gameScreen.style.setProperty('--player-color', playerColor);
    // Persist only user-initiated changes (see userPickedColor decl in
    // ControllerState.js). Display-driven assignments — initial slot,
    // reconnect-default, reclaim's own SET_COLOR confirmation — must
    // not write here: in AC mode an early LOBBY_UPDATE landing before
    // the persistent-data fetch resolves would clobber the previous-
    // session preference in cache.
    if (userPickedColor) persistColorIndex(data.colorIndex);
  }
  if (Array.isArray(data.takenColorIndices)) takenColorIndices = data.takenColorIndices;
  applyHostInfo(data);
  updateStartButton();
  if (currentScreen === 'lobby') {
    updateLevelDisplay();
    renderColorPicker();
  }
}

function onGameStart() {
  ControllerAudio.tick();
  lastLines = 0;
  gameScreen.classList.remove('dead');
  gameScreen.classList.remove('paused');
  gameScreen.classList.remove('countdown');
  gameScreen.style.setProperty('--player-color', playerColor);
  removeKoOverlay();
  reconnectOverlay.classList.add('hidden');
  pauseOverlay.classList.add('hidden');
  pauseBtn.disabled = false;
  pauseBtn.classList.remove('hidden');
  touchArea.setAttribute('data-player-name', playerName);
  showScreen('game');
  initTouchInput();
}

function onPlayerState(data) {
  if (!touchInput) {
    gameScreen.classList.remove('countdown');
    pauseBtn.disabled = false;
    pauseBtn.classList.remove('hidden');
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
  // Settings popup can stay open across GAME_END; close it so the stale
  // pausedBySettings flag doesn't suppress a legitimate pause overlay in
  // the next game, and so the DONE button doesn't RESUME_GAME into a
  // display that has already transitioned to results.
  closeSettingsOverlay();
  renderGameResults(data.results);
  showScreen('gameover');
}

// =====================================================================
// Pause
// =====================================================================

var selfPausing = false;
var selfPausingTimer = null;
// Set by controller.js when settings is opened during gameplay. The PAUSE_GAME
// is really a side-effect of entering settings — the settings panel is on top
// and we don't want the pause overlay flashing behind it.
var pausedBySettings = false;

function onGamePaused() {
  gameScreen.classList.add('paused');
  pauseOverlay.classList.toggle('pause-overlay--self', selfPausing);
  selfPausing = false;
  clearTimeout(selfPausingTimer);
  if (!pausedBySettings) pauseOverlay.classList.remove('hidden');
  pauseBtn.disabled = true;
  pauseStatus.textContent = '';
  pauseButtons.classList.remove('hidden');
}

function onGameResumed() {
  gameScreen.classList.remove('paused');
  pauseOverlay.classList.add('hidden');
  pauseOverlay.classList.remove('pause-overlay--self');
  pauseBtn.disabled = false;
}

// =====================================================================
// Results
// =====================================================================

// The 1.5s anti-misclick delay and fade-in are purely CSS — see the
// `resultsButtonsEnter` animation on #gameover-buttons. pointer-events stays
// `none` until the animation fires, so stray taps before buttons are visible
// can't reach the click handlers.
function renderGameResults(results) {
  resultsList.innerHTML = '';
  gameoverStatus.textContent = '';
  gameoverStatus.style.color = '';
  if (isHost) {
    gameoverButtons.classList.remove('hidden');
  } else {
    gameoverButtons.classList.add('hidden');
    renderHostBanner(gameoverStatus, 'waiting_for_host_to_continue', hostName || t('player'), hostColor);
  }

  var winnerColor = 'rgba(255, 215, 0, 0.06)';
  if (results && results.length) {
    var winner = results.find(function(r) { return r.rank === 1; });
    if (winner) {
      var wc = PLAYER_COLORS[winner.colorIndex] || PLAYER_COLORS[0];
      winnerColor = rgbaFromHex(wc, 0.08);
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
    var pColor = PLAYER_COLORS[r.colorIndex] || PLAYER_COLORS[i % PLAYER_COLORS.length];

    var row = document.createElement('div');
    row.className = solo ? 'result-row' : 'result-row rank-' + r.rank;
    row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');
    if (r.playerId === clientId) row.classList.add('is-me');

    if (!solo) {
      var rankEl = document.createElement('span');
      rankEl.className = 'result-rank';
      rankEl.textContent = String(r.rank);
      rankEl.style.color = pColor;
      row.appendChild(rankEl);
    }

    var info = document.createElement('div');
    info.className = 'result-info';

    var nameEl = document.createElement('span');
    nameEl.className = 'result-name';
    nameEl.textContent = r.playerName || t('player');
    nameEl.style.color = pColor;

    var stats = document.createElement('div');
    stats.className = 'result-stats';
    var linesSpan = document.createElement('span');
    linesSpan.textContent = t('n_lines', { count: r.lines || 0 });
    var levelSpan = document.createElement('span');
    levelSpan.textContent = t('level_n', { level: r.level || 1 });
    stats.appendChild(linesSpan);
    stats.appendChild(levelSpan);

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
  ko.textContent = t('ko');
  touchArea.appendChild(ko);
}

function removeKoOverlay() {
  var el = document.getElementById('ko-overlay');
  if (el) el.remove();
}

// =====================================================================
// Gesture Feedback — glow that follows finger
// =====================================================================

var GLOW_SIZE = 80;
var GLOW_OPACITY = 1;
var _feedbackRect = null;
window.addEventListener('resize', function() { _feedbackRect = null; });

function showGlow(x, y) {
  if (!glowEl) {
    glowEl = document.createElement('div');
    glowEl.className = 'feedback-glow';
    feedbackLayer.appendChild(glowEl);
  }
  if (!_feedbackRect) _feedbackRect = feedbackLayer.getBoundingClientRect();
  var lx = x - _feedbackRect.left;
  var ly = y - _feedbackRect.top;
  glowEl.style.transform = 'translate(' + (lx - GLOW_SIZE / 2) + 'px,' + (ly - GLOW_SIZE / 2) + 'px)';
  glowEl.style.opacity = GLOW_OPACITY;
}

function hideGlow() {
  if (glowEl) { glowEl.remove(); glowEl = null; }
}

function flashGlow() {
  if (glowEl) {
    var el = glowEl;
    glowEl = null;
    el.animate([{ opacity: GLOW_OPACITY }, { opacity: 0 }], { duration: 150, easing: 'ease-out' });
    setTimeout(function () { if (el.parentNode) el.remove(); }, 170);
  }
}

function onDragProgress(direction, progress) {
  // Glow position is updated via pointermove coordTracker — nothing extra needed here
}

// =====================================================================
// Touch Input
// =====================================================================

function initTouchInput() {
  if (touchInput) {
    touchInput.destroy();
  }

  if (coordTracker) {
    touchArea.removeEventListener('pointerdown', coordTracker);
    touchArea.removeEventListener('pointermove', coordTracker);
    touchArea.removeEventListener('pointerup', coordTracker);
  }

  coordTracker = function (e) {
    lastTouchX = e.clientX;
    lastTouchY = e.clientY;
    if (e.type === 'pointerdown') {
      _feedbackRect = feedbackLayer.getBoundingClientRect();
      showGlow(e.clientX, e.clientY);
    } else if (e.type === 'pointermove') {
      showGlow(e.clientX, e.clientY);
    } else if (e.type === 'pointerup') {
      hideGlow();
    }
  };
  touchArea.addEventListener('pointerdown', coordTracker, { passive: true });
  touchArea.addEventListener('pointermove', coordTracker, { passive: true });
  touchArea.addEventListener('pointerup', coordTracker, { passive: true });

  touchInput = new TouchInput(touchArea, function (action, data) {
    // Gesture feedback
    if (action === 'rotate_cw') {
      ControllerAudio.tick();
      // Tap: flash the existing glow and fade out
      flashGlow();
    } else if (action === 'left' || action === 'right') {
      ControllerAudio.tick();
    } else if (action === 'hard_drop') {
      ControllerAudio.drop();
    } else if (action === 'hold') {
      ControllerAudio.hold();
    }

    if (action === 'soft_drop') {
      if (!softDropActive) {
        softDropActive = true;
        ControllerAudio.tick();
      }
      sendToDisplay(MSG.SOFT_DROP, { speed: data && data.speed });
    } else if (action === 'soft_drop_end') {
      softDropActive = false;
    } else {
      sendToDisplay(MSG.INPUT, { action: action });
    }
  }, onDragProgress);
}
