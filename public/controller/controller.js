'use strict';

// =====================================================================
// Controller Entry Point — message dispatch, event listeners, init
// Depends on: ControllerState.js, ControllerConnection.js, ControllerGame.js
// Loaded last; wires up event listeners and initializes the controller
// =====================================================================

// =====================================================================
// Message Dispatch
// =====================================================================

// Room state — identity, roster, host, pause, results and screen routing —
// arrives as a retained snapshot through party.onState, which bypasses this
// dispatcher entirely (see ControllerGame.js#onState). What's left here is
// transient per-player traffic that isn't room state and would be wrong to
// retain: this player's own board telemetry, the relay-liveness pong, and
// errors. That's why there is no late-joiner allowlist any more — a late
// joiner is never sent any of it.
function handleMessage(data) {
  try {
    // Ignore everything after a terminal rejection. A snapshot can still
    // re-admit us (AC mode survives the bail), and it clears the flag.
    if (gameCancelled) return;

    switch (data.type) {
      case MSG.PLAYER_STATE:
        onPlayerState(data);
        break;
      case MSG.PONG:
        lastPongTime = Date.now();
        // Only drive the chip from WS when fastlane isn't already feeding it
        // higher-fidelity P2P samples via onRtt. Without this gate the
        // 1 Hz WS RTT (~12 ms via relay) clobbers the fastlane chip every
        // second, visibly bouncing the number — and lights the bolt icon
        // over a non-fastlane reading.
        if (data.t && !(fastlane && fastlane.isOpen(0))) {
          var rtt = Date.now() - data.t;
          updateLatencyDisplay(Math.round(rtt / 2));
        }
        if (party) party.resetReconnectCount();
        clearTimeout(disconnectedTimer);
        reconnectOverlay.classList.add('hidden');
        break;
      case MSG.ERROR:
        // Display-originated errors (see DisplayInput.js sendTo({type: ERROR}))
        // may carry a specific reason — surface it as a toast on the bail.
        if (data.message === 'Room not found') bailToWelcome('room_not_found');
        else if (data.message === 'Room is full') bailToWelcome('game_full');
        else bailToWelcome();
        break;
    }
  } catch (err) {
    console.error('[controller] Error handling message:', data && data.type, err);
  }
}

// =====================================================================
// Room Code & Client ID
// =====================================================================

roomCode = location.pathname.split('/').filter(Boolean)[0] || null;
if (!roomCode) {
  bailToWelcome();
} else {

// Check for stored clientId BEFORE generating a new one (used for auto-reconnect)
var hadStoredId = null;
try { hadStoredId = localStorage.getItem('clientId_' + roomCode); } catch (e) { /* iframe sandbox */ }

clientId = hadStoredId || generateClientId();

// Probe the relay for an existence check so an invalid room code surfaces
// immediately instead of only after the user types a name and hits JOIN.
// AirConsole parses /controller.html into roomCode and owns its own identity
// (skipNameScreen); gallery iframes carry ?scenario= and never hit a relay.
var isScenario = !!new URLSearchParams(location.search).get('scenario');
if (!skipNameScreen && !isScenario) {
  var isNewClient = !hadStoredId && !rejoinToken && !legacyRejoinId;
  var relayHttpUrl = RELAY_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  fetch(relayHttpUrl + '/room/' + encodeURIComponent(roomCode) + (instanceId ? '?instance=' + encodeURIComponent(instanceId) : ''))
    .then(function (res) {
      // Bail if the user has already moved past the name screen — a slow
      // probe arriving after a successful join would otherwise evict them.
      if (currentScreen !== 'name') return;
      if (res.status === 404) return bailToWelcome('room_not_found');
      // Only treat full as fatal for fresh joiners — reconnects with a
      // stored clientId swap into their existing slot on the relay.
      if (!isNewClient) return;
      return res.json().then(function (info) {
        if (currentScreen !== 'name') return;
        if (info && info.clients >= info.maxClients) bailToWelcome('game_full');
      });
    })
    .catch(function () { /* network error — connect() will surface it */ });
}

// =====================================================================
// Name Input
// =====================================================================

var savedName = getStoredTypedPlayerName();

function submitName() {
  var name = nameInput.value.trim();
  var storedAutoName = getStoredAutoPlayerName();

  playerName = name || storedAutoName || null;
  playerNameIsAuto = !name;
  // Persist only what the user actually typed. Clear any stale entry on
  // empty submit so the display's generated fallback (e.g. "HX-27") never
  // ends up prefilled the next time the input is shown.
  try {
    if (name) localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
    else localStorage.removeItem(PLAYER_NAME_STORAGE_KEY);
  } catch (e) { /* iframe sandbox */ }
  try {
    // Clean up clientIds from previous rooms — a player is only in one room at a time
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var key = localStorage.key(i);
      if (key && key.indexOf('clientId_') === 0 && key !== 'clientId_' + roomCode) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem('clientId_' + roomCode, clientId);
  } catch (e) { /* iframe sandbox */ }
  nameJoinBtn.disabled = true;
  nameJoinBtn.textContent = t('connecting');
  nameInput.disabled = true;
  connect();
}

bindTap(nameJoinBtn, function () { vibrate(15); submitName(); });
nameInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') submitName();
});
nameInput.addEventListener('focus', function () {
  setTimeout(syncViewportLayout, 50);
});
nameInput.addEventListener('blur', function () {
  setTimeout(syncViewportLayout, 50);
});

// Prime audio on first interaction
document.addEventListener('pointerdown', function onFirstPointer() {
  vibrate(2);
  ControllerAudio.prime();
  document.removeEventListener('pointerdown', onFirstPointer, true);
}, { capture: true, passive: true });

// =====================================================================
// Settings
// =====================================================================
// Loads persisted settings (mute/haptics/sensitivity), wires the popup,
// and sends SET_DISPLAY_MUTE when the host toggles remote mute.
// The display-mute row shows only when this controller is the host;
// updateSettingsHostUI() is called from onState when the host changes.

ControllerSettings.init();
// Mirrors the display's mute state, which rides the room snapshot: it is
// applied on join/rejoin and again whenever the display's mute changes
// (settings toggle OR display-side mute button). The Game Music
// toggle in settings reads this; host-initiated toggling sends
// SET_DISPLAY_MUTE and optimistically updates this value before the
// display's echoed snapshot lands.
var displayMuteIntent = false;

window.onDisplayMuted = function (data) {
  displayMuteIntent = !!(data && data.muted);
  // If settings is open, re-render the toggle so the user sees the
  // change made from the display-side mute button.
  if (settingsOverlay && !settingsOverlay.classList.contains('hidden')) {
    syncMuteDisplayToggle();
  }
};

function syncMuteControllerToggle() {
  // Switch ON = sound playing (not muted), so display the inverse of the mute flag.
  var muted = ControllerSettings.isMuted();
  toggleMuteController.setAttribute('aria-checked', muted ? 'false' : 'true');
}

function syncHapticButtons() {
  var tier = ControllerSettings.getHapticStrength();
  var btns = rowHaptics.querySelectorAll('[data-haptic]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].setAttribute('aria-checked', btns[i].dataset.haptic === tier ? 'true' : 'false');
  }
}

// Slider value IS the scaled multiplier (px / default). step=0.05 so the
// native range input snaps to 1/20 increments — exactly the detents the
// user sees. Bounds are chosen so min*max ≈ 1 (geometric symmetry → 1.00
// sits at the log-center), both rounded to 0.05. Px is derived as
// `ratio * default` on every read/write.
var _sensMinRatio = 0.55;
var _sensMaxRatio = 1.75;

function ratioToPx(ratio) {
  return Math.round(ratio * ControllerSettings.SENSITIVITY_DEFAULT);
}

function pxToRatio(px) {
  return px / ControllerSettings.SENSITIVITY_DEFAULT;
}

// Snap a float to the nearest 0.05 (20× → round → 20× back), guarding
// against fp drift that would otherwise yield 1.0000000001 display bugs.
function snapToStep(ratio) {
  return Math.round(ratio * 20) / 20;
}

function syncSensitivityControls() {
  // Upper bound: default + W * 0.1 (in px) → convert to ratio → snap to
  // 0.05. Lower bound: 1 / upper (in ratio) → snap. This keeps 1.00
  // close to the visual center of the slider on every touchpad width.
  // Touch-pad may be display:none on lobby — fall back to viewport width
  // minus the 40 px horizontal padding.
  var touchPad = document.getElementById('touch-pad');
  var rect = touchPad ? touchPad.getBoundingClientRect() : null;
  var w = rect && rect.width > 0 ? rect.width : Math.max(0, window.innerWidth - 40);
  var defaultPx = ControllerSettings.SENSITIVITY_DEFAULT;
  var maxPx = defaultPx + w * 0.1;
  _sensMaxRatio = Math.max(1.05, snapToStep(maxPx / defaultPx));
  _sensMinRatio = Math.min(0.95, snapToStep(1 / _sensMaxRatio));

  sensitivitySlider.min = String(_sensMinRatio);
  sensitivitySlider.max = String(_sensMaxRatio);
  // Linear slider + log-symmetric bounds → 1.00 isn't at visual 50%.
  // Place the center tick at the actual position 1.00 occupies.
  var centerPct = (1.0 - _sensMinRatio) / (_sensMaxRatio - _sensMinRatio);
  sensitivitySlider.style.setProperty('--center-pct', (centerPct * 100).toFixed(2) + '%');

  var currentPx = ControllerSettings.getSensitivity();
  var currentRatio = snapToStep(pxToRatio(currentPx));
  if (currentRatio < _sensMinRatio) currentRatio = _sensMinRatio;
  if (currentRatio > _sensMaxRatio) currentRatio = _sensMaxRatio;

  var clampedPx = ratioToPx(currentRatio);
  if (clampedPx !== currentPx) ControllerSettings.setSensitivity(clampedPx);

  sensitivitySlider.value = String(currentRatio);
  sensitivityValueEl.textContent = currentRatio.toFixed(2);
  syncSensitivityFill();
  drawSensitivityPreview();
}

// The track's player-tinted progress layer is painted in CSS from
// --value-pct (same pattern as the --center-pct tick above).
function syncSensitivityFill() {
  var ratio = parseFloat(sensitivitySlider.value);
  var pct = (ratio - _sensMinRatio) / (_sensMaxRatio - _sensMinRatio);
  sensitivitySlider.style.setProperty('--value-pct', (pct * 100).toFixed(2) + '%');
}

function syncMuteDisplayToggle() {
  // Switch ON = music playing, so display the inverse of the mute intent.
  toggleMuteDisplay.setAttribute('aria-checked', displayMuteIntent ? 'false' : 'true');
}

// Called from onState (ControllerGame.js) whenever host changes. Reveals
// or hides the host-only display-mute row. Explicit window assignment so
// ControllerGame.js can reach it — this file executes inside the roomCode
// else-block and its function declarations are block-scoped under 'use strict'.
window.updateSettingsHostUI = function () {
  if (!rowMuteDisplay) return;
  rowMuteDisplay.hidden = !isHost;
};

bindTap(toggleMuteController, function () {
  vibrate(15);
  ControllerSettings.setMuted(!ControllerSettings.isMuted());
  syncMuteControllerToggle();
  // Preview the move sound when the user turns touch sounds ON so they
  // can confirm audio is actually working. Tick() is the left/right SFX
  // and is internally suppressed when muted, so we don't need a guard.
  if (!ControllerSettings.isMuted()) {
    ControllerAudio.prime();
    ControllerAudio.tick();
  }
});

bindTap(toggleMuteDisplay, function () {
  vibrate(15);
  if (!isHost) return;
  displayMuteIntent = !displayMuteIntent;
  syncMuteDisplayToggle();
  sendToDisplay(MSG.SET_DISPLAY_MUTE, { muted: displayMuteIntent });
});

bindTap(rowHaptics, function (e) {
  var btn = e.target.closest('[data-haptic]');
  if (!btn) return;
  ControllerSettings.setHapticStrength(btn.dataset.haptic);
  syncHapticButtons();
  vibrate(18);
});

// Native step=0.05 snapping means every 'input' event fires on a real
// detent — one pulse per visible number change.
sensitivitySlider.addEventListener('input', function () {
  var ratio = snapToStep(parseFloat(sensitivitySlider.value));
  ControllerSettings.setSensitivity(ratioToPx(ratio));
  sensitivityValueEl.textContent = ratio.toFixed(2);
  syncSensitivityFill();
  drawSensitivityPreview();
  vibrate(8);
});

// Re-sync the settings overlay whenever Settings state changes — covers
// AirConsole hydration arriving while the overlay is already open: the
// initial sync ran with defaults, Settings.reload() updates state, this
// listener pushes the new state back into the DOM. Closed-overlay calls
// no-op (the open path runs syncs from scratch when the user reopens).
ControllerSettings.onChange(function () {
  if (!settingsOverlay || settingsOverlay.classList.contains('hidden')) return;
  syncMuteControllerToggle();
  syncHapticButtons();
  syncSensitivityControls();
});

function resizePreviewCanvas() {
  // Make the canvas drawing buffer match its displayed size (at device
  // pixel ratio) so the dot markers, tick marks, and chevrons render crisp
  // instead of stretched from the 280×120 default buffer.
  if (!sensitivityPreview) return;
  var rect = sensitivityPreview.getBoundingClientRect();
  if (rect.width <= 0) return;
  var dpr = window.devicePixelRatio || 1;
  sensitivityPreview.width = Math.round(rect.width * dpr);
  sensitivityPreview.height = Math.round(rect.height * dpr);
  var ctx = sensitivityPreview.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Cached accent color for drawSensitivityPreview — resolving --player-color
// via getComputedStyle on every frame forces a style recalc. Refresh on
// openSettings (player color doesn't change within a session).
var _cachedPreviewAccent = '';

function openSettings() {
  vibrate(15);
  _cachedPreviewAccent = getComputedStyle(document.body).getPropertyValue('--player-color').trim()
    || getComputedStyle(document.documentElement).getPropertyValue('--accent-secondary').trim()
    || '#FF8C42';
  syncMuteControllerToggle();
  syncMuteDisplayToggle();
  syncHapticButtons();
  // Overlay must be visible before we measure the preview canvas — a
  // display:none ancestor returns zero width from getBoundingClientRect.
  settingsOverlay.classList.remove('hidden');
  resizePreviewCanvas();
  syncSensitivityControls();
  updateSettingsHostUI();
  // Push a history entry so the browser back button closes the overlay
  // instead of popping the underlying screen (which would disconnect).
  // Guarded against re-push if somehow opened twice without closing.
  // In AirConsole mode pushState is neutralized (see controller-airconsole.js),
  // so this is a no-op there — AC users lack a back gesture on this iframe.
  if (!history.state || history.state.modal !== 'settings') {
    history.pushState({ modal: 'settings' }, '');
  }
}

if (pauseSettingsBtn) bindTap(pauseSettingsBtn, openSettings);
if (lobbySettingsBtn) bindTap(lobbySettingsBtn, openSettings);
// Exposed for ControllerTestHarness — function declarations inside this
// `else` block are block-scoped under strict mode and not otherwise reachable.
window.openSettings = openSettings;

function hideSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.classList.add('hidden');
}

window.closeSettingsOverlay = hideSettings;

bindTap(settingsCloseBtn, function () {
  vibrate(15);
  // Route Done through history.back() so the browser back button and
  // Done share a single close path (the popstate handler). Fallback for
  // AC mode / legacy openings where no state was pushed.
  if (history.state && history.state.modal === 'settings') {
    history.back();
  } else {
    hideSettings();
  }
});

// Read the build version from the <meta name="app-version"> tag baked into
// the HTML by server/index.js (web flow) or build-airconsole.sh (AC zip).
// Skipped in AirConsole mode — the bootstrap calls injectVersionLabel.
if (!document.body.classList.contains('airconsole')) {
  var versionMeta = document.querySelector('meta[name="app-version"]');
  var label = versionMeta ? versionMeta.getAttribute('content') : '';
  if (settingsVersionEl) settingsVersionEl.textContent = label;
}

// --- Sensitivity preview (static two-dot visual + live drag tester) ---
var _previewDrag = null;

// Draws a chevron (>> shape) at (cx, cy) pointing in `dir` (-1 left, +1 right).
// Used both as the inter-dot direction hint (static) and as the step arrow
// that flashes when the user crosses a threshold while dragging.
function _drawChevron(ctx, cx, cy, dir, size, color, weight) {
  ctx.strokeStyle = color;
  ctx.lineWidth = weight || 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  var s = size;
  ctx.beginPath();
  ctx.moveTo(cx - s * dir, cy - s);
  ctx.lineTo(cx + s * dir, cy);
  ctx.lineTo(cx - s * dir, cy + s);
  ctx.stroke();
}

function drawSensitivityPreview() {
  if (!sensitivityPreview || !sensitivityPreview.getContext) return;
  var ctx = sensitivityPreview.getContext('2d');
  // resizePreviewCanvas scales the transform by DPR so logical coords use
  // CSS pixels. Read dimensions from the bounding rect, not the buffer.
  var rect = sensitivityPreview.getBoundingClientRect();
  var w = rect.width || sensitivityPreview.width;
  var h = rect.height || sensitivityPreview.height;
  var threshold = ControllerSettings.getSensitivity();
  var cy = h / 2;
  // Accent color is cached on openSettings() — getComputedStyle forces a
  // style recalc and drawSensitivityPreview fires on every slider input
  // AND every pointermove during preview drag (~60 Hz). Resolving once
  // per session instead of per frame.
  var accent = _cachedPreviewAccent || '#FF8C42';

  // Clear — CSS background (dot grid + gradient) shows through.
  ctx.clearRect(0, 0, w, h);

  if (_previewDrag) {
    // --- Live drag mode ---
    var anchor = _previewDrag.anchorX;
    var finger = Math.max(10, Math.min(w - 10, _previewDrag.x));
    var delta = _previewDrag.x - anchor;
    var steps = Math.trunc(delta / threshold);
    var dir = steps === 0 ? (delta >= 0 ? 1 : -1) : (steps > 0 ? 1 : -1);

    // Trail line from anchor to finger.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(anchor, cy);
    ctx.lineTo(finger, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Tick marks for each threshold boundary between anchor and finger.
    var maxSteps = Math.floor((w - 20) / threshold);
    for (var i = 1; i <= maxSteps; i++) {
      var tx = anchor + i * threshold * dir;
      if (tx < 6 || tx > w - 6) continue;
      var hit = i <= Math.abs(steps);
      ctx.strokeStyle = hit ? accent : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = hit ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, cy - 10);
      ctx.lineTo(tx, cy + 10);
      ctx.stroke();
    }

    // Anchor dot (where finger started).
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(anchor, cy, 6, 0, Math.PI * 2);
    ctx.fill();

    // Finger dot (live position).
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(finger, cy, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Step counter: chevron + number, top-centered, only when stepped.
    if (steps !== 0) {
      var absSteps = Math.abs(steps);
      ctx.font = '900 22px Orbitron, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      var numW = ctx.measureText(String(absSteps)).width;
      var bgW = numW + 52;
      var bgX = (w - bgW) / 2;
      var bgY = 8;
      // Pill background
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      var r = 14;
      ctx.moveTo(bgX + r, bgY);
      ctx.arcTo(bgX + bgW, bgY, bgX + bgW, bgY + 28, r);
      ctx.arcTo(bgX + bgW, bgY + 28, bgX, bgY + 28, r);
      ctx.arcTo(bgX, bgY + 28, bgX, bgY, r);
      ctx.arcTo(bgX, bgY, bgX + bgW, bgY, r);
      ctx.closePath();
      ctx.fill();
      // Chevron + count inside pill
      _drawChevron(ctx, bgX + 16, bgY + 14, dir, 6, accent, 2.5);
      ctx.fillStyle = '#fff';
      ctx.fillText(String(absSteps), bgX + bgW / 2 + 8, bgY + 14);
    }
  } else {
    // --- Static mode: two dots one ratchet apart, joined by a thin line ---
    var cx = w / 2;
    var half = Math.min(w / 2 - 20, threshold / 2);

    // Connecting line (drawn first so the dots sit on top of the ends).
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - half, cy);
    ctx.lineTo(cx + half, cy);
    ctx.stroke();

    // Left dot
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(cx - half, cy, 8, 0, Math.PI * 2);
    ctx.fill();
    // Right dot
    ctx.beginPath();
    ctx.arc(cx + half, cy, 8, 0, Math.PI * 2);
    ctx.fill();

    // Clipping hint: if threshold > preview, show an edge fade on both sides.
    if (threshold > w - 40) {
      var grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0.25)');
      grad.addColorStop(0.15, 'rgba(0,0,0,0)');
      grad.addColorStop(0.85, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
  }
}

// Re-measure on orientation/resize so rotating the device retunes the
// slider bounds (and clamps the stored value if the new orientation's
// range no longer contains it). Debounced — resize fires repeatedly
// during a landscape/portrait flip. Guards on the popup being open only
// for the canvas DPI rebake; the bound/clamp logic runs either way.
var _sensResizeTimer = null;
function _onViewportChange() {
  clearTimeout(_sensResizeTimer);
  _sensResizeTimer = setTimeout(function () {
    if (!settingsOverlay.classList.contains('hidden')) {
      resizePreviewCanvas();
    }
    syncSensitivityControls();
  }, 200);
}
window.addEventListener('resize', _onViewportChange);
window.addEventListener('orientationchange', _onViewportChange);

if (sensitivityPreview) {
  sensitivityPreview.addEventListener('pointerdown', function (e) {
    sensitivityPreview.setPointerCapture(e.pointerId);
    // Coords are in CSS pixels — the canvas transform already applies DPR,
    // so we don't multiply by buffer/rect ratio here.
    var rect = sensitivityPreview.getBoundingClientRect();
    var x = e.clientX - rect.left;
    _previewDrag = { anchorX: x, x: x, pointerId: e.pointerId };
    drawSensitivityPreview();
  });
  sensitivityPreview.addEventListener('pointermove', function (e) {
    if (!_previewDrag || e.pointerId !== _previewDrag.pointerId) return;
    var rect = sensitivityPreview.getBoundingClientRect();
    _previewDrag.x = e.clientX - rect.left;
    var threshold = ControllerSettings.getSensitivity();
    var prevSteps = _previewDrag.lastSteps || 0;
    var steps = Math.trunc((_previewDrag.x - _previewDrag.anchorX) / threshold);
    if (steps !== prevSteps) {
      // Match the real ratchet-step haptic from TouchInput.js so the
      // preview feels identical to an actual left/right move in-game.
      vibrate(15);
      // Click sound reinforces the ratchet feel, matching the real pad.
      if (!ControllerSettings.isMuted()) ControllerAudio.tick();
      _previewDrag.lastSteps = steps;
    }
    drawSensitivityPreview();
  });
  var endPreviewDrag = function (e) {
    if (!_previewDrag || e.pointerId !== _previewDrag.pointerId) return;
    _previewDrag = null;
    drawSensitivityPreview();
  };
  sensitivityPreview.addEventListener('pointerup', endPreviewDrag);
  sensitivityPreview.addEventListener('pointercancel', endPreviewDrag);
}

// =====================================================================
// Button Event Listeners
// =====================================================================

bindTap(pauseBtn, function () {
  vibrate(15);
  // Mark the upcoming GAME_PAUSED as self-initiated so onGamePaused can skip
  // the pause-overlay's anti-misclick gate. Timeout guards against a dropped
  // PAUSE_GAME leaving the flag sticky for a later unrelated pause.
  selfPausing = true;
  clearTimeout(selfPausingTimer);
  selfPausingTimer = setTimeout(function () { selfPausing = false; }, 2000);
  sendToDisplay(MSG.PAUSE_GAME);
});

bindTap(pauseContinueBtn, function () {
  vibrate(15);
  sendToDisplay(MSG.RESUME_GAME);
});

bindTap(pauseNewGameBtn, function () {
  vibrate(15);
  sendToDisplay(MSG.RETURN_TO_LOBBY);
});

bindTap(reconnectRejoinBtn, function () {
  vibrate(15);
  reconnectHeading.textContent = t('reconnecting');
  reconnectStatus.textContent = t('connecting');
  reconnectRejoinBtn.classList.add('hidden');
  connect();
});

bindTap(lobbyBackBtn, function () {
  vibrate(15);
  performDisconnect();
});

bindTap(startBtn, function () {
  if (startBtn.disabled) return;
  vibrate(15);
  sendToDisplay(MSG.START_GAME);
});

bindTap(levelMinusBtn, function () {
  if (startLevel <= 1) return;
  vibrate(15);
  startLevel = Math.max(1, startLevel - 1);
  updateLevelDisplay();
  renderColorPicker();
  sendToDisplay(MSG.SET_LEVEL, { level: startLevel });
});

bindTap(levelPlusBtn, function () {
  if (startLevel >= 15) return;
  vibrate(15);
  startLevel = Math.min(15, startLevel + 1);
  updateLevelDisplay();
  renderColorPicker();
  sendToDisplay(MSG.SET_LEVEL, { level: startLevel });
});

// Color picker — the rose lives in #color-picker-overlay (a .game-overlay
// dialog). Two pieces of wiring:
//   1. The identity-trigger row in the lobby card opens the overlay.
//   2. Tapping the backdrop or pressing Escape closes it.
//   3. Tapping a non-taken rose cell sends SET_COLOR; the overlay stays
//      open until the display echoes the accepted color back via
//      the room snapshot → renderColorPicker, which calls closeColorPicker
//      once playerColorIndex matches the pendingColorPick. Rejected picks
//      simply leave the overlay open so the user can pick again.
if (colorPickerEl) {
  buildColorPicker();
  bindTap(colorPickerEl, function (e) {
    var btn = e.target.closest('.rose-cell');
    if (!btn || btn.classList.contains('taken')) return;
    var idx = parseInt(btn.dataset.idx, 10);
    if (isNaN(idx)) return;
    vibrate(15);
    // Same userPickedColor + persistence flow as before: applyOwnIdentity
    // persists any confirmed color change, but only when this flag is
    // true so display-driven assignments (initial slot, reconnect default)
    // don't clobber a previous-session preference before reclaim can act.
    userPickedColor = true;
    pendingColorPick = idx;
    // Mark the chosen cell as "picked" so its CSS scale-down stays held
    // through the overlay fade-out (instead of springing back to full size
    // on touch-release). Confirmation closes the overlay before the rose is
    // repainted, so the held scale persists naturally; renderColorPicker
    // clears the class on the next visible repaint (open or rejection).
    var prevPicked = colorPickerEl.querySelector('.rose-cell.picked');
    if (prevPicked && prevPicked !== btn) prevPicked.classList.remove('picked');
    btn.classList.add('picked');
    sendToDisplay(MSG.SET_COLOR, { colorIndex: idx });
  });
}

if (identityTrigger) {
  bindTap(identityTrigger, function () {
    if (currentScreen !== 'lobby') return;
    vibrate(10);
    openColorPicker();
  });
}

if (colorPickerOverlay) {
  bindTap(colorPickerOverlay, function (e) {
    // Tap outside the rose container (i.e. on the backdrop) closes.
    if (e.target === colorPickerOverlay) closeColorPicker();
  });
  var closeBtn = document.getElementById('color-picker-close');
  if (closeBtn) {
    bindTap(closeBtn, function (e) {
      e.stopPropagation();
      vibrate(10);
      closeColorPicker();
    });
  }
}

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (colorPickerOverlay && !colorPickerOverlay.classList.contains('hidden')) {
    closeColorPicker();
  }
});

bindTap(playAgainBtn, function () {
  vibrate(15);
  sendToDisplay(MSG.PLAY_AGAIN);
});

bindTap(newGameBtn, function () {
  vibrate(15);
  sendToDisplay(MSG.RETURN_TO_LOBBY);
});

// =====================================================================
// Global Event Listeners
// =====================================================================

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  if (gameCancelled) return;
  if (currentScreen === 'name' && !playerColor) return;

  // If returning to an already-paused or results screen, drop the
  // anti-misclick gate — see the .pause-overlay--ready and
  // .gameover-screen--ready CSS rules.
  if (pauseOverlay && !pauseOverlay.classList.contains('hidden')) {
    pauseOverlay.classList.add('pause-overlay--ready');
  }
  if (currentScreen === 'gameover' && gameoverScreen) {
    gameoverScreen.classList.add('gameover-screen--ready');
  }

  // Restart pings to check if connection is still alive.
  // If the WebSocket died while backgrounded, party.onClose will
  // trigger reconnection automatically.
  if (party && party.connected) {
    startPing();
  } else {
    connect();
  }
});

window.addEventListener('popstate', function (e) {
  // Forward into a stale modal entry after the user already closed
  // settings — no-op so we don't disconnect.
  if (e.state && e.state.modal === 'settings') return;
  // Modal-first: close settings instead of falling through to a
  // screen-level back (which would disconnect).
  if (settingsOverlay && !settingsOverlay.classList.contains('hidden')) {
    hideSettings();
    return;
  }
  if (currentScreen === 'lobby' || currentScreen === 'game' || currentScreen === 'gameover') {
    performDisconnect();
  }
});

// Best-effort: pagehide also fires on iOS bfcache freeze, where the WS close
// may not complete before the page is frozen. If the page is restored from
// bfcache the WebSocket is dead; the existing visibilitychange + reconnect
// flow will surface the reconnect overlay.
window.addEventListener('pagehide', function () {
  if (party) party.close();
});

// =====================================================================
// Initialize
// =====================================================================

if (hadStoredId || rejoinToken || legacyRejoinId || skipNameScreen) {
  var savedAutoName = getStoredAutoPlayerName();
  playerName = savedName || savedAutoName || null;
  playerNameIsAuto = !savedName;
  nameInput.value = savedName;
  nameJoinBtn.disabled = true;
  nameJoinBtn.textContent = t('connecting');
  nameInput.disabled = true;
  showScreen('name');
  connect();
} else {
  nameInput.value = savedName;
  showScreen('name');
  nameInput.focus();
}

syncViewportLayout();

// Show join URL hint on lobby screen
var joinUrlHint = location.origin + '/' + roomCode;
var lobbyJoinUrl = document.getElementById('lobby-join-url');
if (lobbyJoinUrl) lobbyJoinUrl.textContent = joinUrlHint;

} // end if (roomCode)
