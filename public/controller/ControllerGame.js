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
  // snapshot mid-delay can't flip the buttons to clickable early — the
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

// Refresh every surface that shows the local player's own name. Called after a
// mid-session rename (AC profile change) so the new name is visible immediately
// without waiting for a display round-trip, on whichever screen is current.
function applyLocalPlayerName() {
  var shown = playerName || t('player');
  playerNameEl.textContent = shown;
  playerIdentityName.textContent = shown;
  touchArea.setAttribute('data-player-name', shown);
  fitIdentityName();
}

// Shrink-to-fit for the identity-card name, the controller twin of the
// display's fitPlayerNames(): CSS has no native auto font size, so measure
// at the stylesheet size and scale down only on overflow; below the floor
// the .identity-name ellipsis takes over. No-op while the card is hidden
// (clientWidth 0); showLobbyUI() re-runs it once the lobby is visible.
// Kept in sync with the display's NAME_FIT_MIN_SCALE (DisplayUI.js) —
// separate bundles, so the value is mirrored rather than shared.
var NAME_FIT_MIN_SCALE = 0.5;
function fitIdentityName() {
  var el = playerIdentityName;
  el.style.fontSize = '';
  if (!el.textContent || !el.clientWidth) return;
  if (el.scrollWidth <= el.clientWidth) return;
  var base = parseFloat(getComputedStyle(el).fontSize);
  var scale = Math.max(NAME_FIT_MIN_SCALE, (el.clientWidth / el.scrollWidth) * 0.98);
  el.style.fontSize = (base * scale).toFixed(2) + 'px';
}

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(function() { fitIdentityName(); });
}

// Shell-driven live rename, shared by the AirConsole profile-change path and
// the CouchPad setName bridge. SET_NAME is a lightweight rename the display
// accepts in any state (including mid-game). The display relabels the roster
// and republishes, so the other controllers' "Waiting for <host>" banner
// updates without this controller re-announcing itself.
function applyShellRename(name) {
  if (!name || name === playerName) return;
  playerName = name;
  playerNameIsAuto = false;
  applyLocalPlayerName();
  sendToDisplay(MSG.SET_NAME, { name: playerName });
}

function showLobbyUI() {
  playerIdentity.style.setProperty('--player-color', playerColor);
  playerIdentityName.textContent = playerName || t('player');
  updateLevelDisplay();

  updateStartButton();

  showScreen('lobby');
  // After showScreen: the card is measurable only once the lobby is visible.
  fitIdentityName();
  // Paint after showScreen so that updateHostVisibility (below) sees
  // currentScreen === 'lobby' and wires up host-gated UI. The picker
  // itself uses a fixed-size canvas buffer so it doesn't depend on
  // visibility for measurement.
  renderColorPicker();
  // Must run after showScreen so currentScreen === 'lobby' when we gate UI.
  updateHostVisibility();
}

// Fixed canvas buffer for every rose cell. Pinning these means a repaint
// (e.g. level-change re-tiering) never reassigns canvas.width — which would
// clear the buffer and re-anchor DPR, causing a one-frame flicker as the hex
// jumped by a sub-pixel. CSS width:100%/height:100% scales the buffer to
// the live button rect. Buffer is the hex stamp's natural CSS-pixel size
// (height + stamp padding, width = height / sin(60°)) multiplied by
// devicePixelRatio so the rose hexes render at native device resolution
// instead of being upscaled by the browser from a 102×88 backing store.
// DPR is captured once at module load so the buffer size stays pinned across
// repaints. paintHexCanvas applies the matching ctx.scale so drawing coords
// stay in CSS pixels.
//
// What matters here is the aspect ratio (88/102), not absolute pixels —
// the canvas element fills its parent via `width:100%; height:100%`, so
// the browser stretches the backing store to whatever live rect the
// `.rose-cell` clamp() resolves to. If that aspect ratio (which encodes
// flat-top hex geometry: height / sin(60°) plus stamp padding) ever
// changes in CSS, update these two constants to match.
var COLOR_PICKER_CANVAS_DPR = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
var COLOR_PICKER_CSS_H = 88;
var COLOR_PICKER_CSS_W = 102;  // ≈ height / sin(60°) + stamp padding
var COLOR_PICKER_CANVAS_H = Math.round(COLOR_PICKER_CSS_H * COLOR_PICKER_CANVAS_DPR);
var COLOR_PICKER_CANVAS_W = Math.round(COLOR_PICKER_CSS_W * COLOR_PICKER_CANVAS_DPR);

// DOM ordering of rose cells — fixed at buildColorPicker time. Each slot
// gets a class .rose-cell--<slotId> in the same order so CSS positions
// them via class selectors (see controller.css).
var ROSE_SLOT_ORDER = ['top', 'ur', 'lr', 'bottom', 'll', 'ul', 'center'];

// Spectrum-ordered alternative slots: when alternatives are sorted by
// PLAYER_COLORS index ascending (red → magenta), assign them to slots in
// left-to-right column reading order. Result: leftmost column = first two
// alternatives, middle column = next three, rightmost column = last two.
// The player's CURRENT color is the implicit "missing" notch in the
// gradient (it's never in the rose), reinforcing the "you came from here"
// reading without needing extra UI.
//
// Length is coupled to PLAYER_COLORS.length - 1 (= 7 for the 8-color
// palette). If the palette ever grows or shrinks, regrow this array to
// match — or renderColorPicker will silently leave trailing cells with
// dataset.idx="undefined" (un-tappable, click handler bails on isNaN).
var ROSE_SPECTRUM_ASSIGNMENT = ['ul', 'll', 'top', 'center', 'bottom', 'ur', 'lr'];

// Repaint the 7 rose cells. Called every time the lobby state changes
// (level, takenColorIndices, playerColorIndex). Closes the overlay if a
// pending pick was just confirmed by the display.
function renderColorPicker() {
  if (!colorPickerEl) return;
  var tier = (typeof getStyleTier === 'function') ? getStyleTier(startLevel || 1) : STYLE_TIERS.NORMAL;

  // 1. If a pick is pending and the display has now echoed it back as
  //    the current color, close the overlay. Done BEFORE the rose render
  //    so the early-return below catches the now-hidden state and the
  //    rose contents stay frozen during the close fade-out.
  if (pendingColorPick != null && pendingColorPick === playerColorIndex) {
    pendingColorPick = null;
    if (typeof closeColorPicker === 'function') closeColorPicker();
  }

  // 1b. Still pending, but the roster now shows the slot claimed. Since the
  //     check above already cleared the case where it became ours, this is a
  //     collision the display rejected: setColor drops those silently, so the
  //     winner's snapshot is the only news of it and nothing else would ever
  //     retire the flag. Left set, it outlives the overlay and would close a
  //     later deliberate open if that slot ever came back to us.
  if (pendingColorPick != null && (takenColorIndices || []).indexOf(pendingColorPick) >= 0) {
    pendingColorPick = null;
  }

  // 2. Skip rose repaint while the overlay is hidden (closed or fading
  //    out). Repainting during the close fade would shuffle the
  //    alternatives mid-animation as the player's new color drops out of
  //    the rose — confusing right after a pick. The rose is repainted
  //    fresh on each open via openColorPicker.
  if (colorPickerOverlay && colorPickerOverlay.classList.contains('hidden')) {
    return;
  }

  // 3. Pick the 7 alternatives in spectrum order (current color excluded)
  //    and assign them to slots in left-to-right column reading order.
  var alternatives = [];
  for (var i = 0; i < PLAYER_COLORS.length; i++) {
    if (i !== playerColorIndex) alternatives.push(i);
  }
  var taken = new Set(takenColorIndices || []);
  var slotByName = {};
  var cells = colorPickerEl.children;
  for (var c = 0; c < cells.length; c++) {
    slotByName[cells[c].dataset.slot] = cells[c];
  }
  for (var s = 0; s < ROSE_SPECTRUM_ASSIGNMENT.length; s++) {
    var slot = slotByName[ROSE_SPECTRUM_ASSIGNMENT[s]];
    if (!slot) continue;
    var idx = alternatives[s];
    var isTaken = taken.has(idx);
    slot.dataset.idx = String(idx);
    slot.classList.toggle('taken', isTaken);
    // Clear the held "picked" scale-down on every visible repaint. The
    // confirmed-pick path early-returns above (overlay hidden), preserving
    // the scale through the fade-out; this clear handles fresh-open and
    // rejected-pick repaints so the cell springs back to full size.
    slot.classList.remove('picked');
    slot.setAttribute('aria-label', t('color_choose', { n: idx + 1 }));
    if (isTaken) {
      slot.setAttribute('aria-disabled', 'true');
      slot.setAttribute('tabindex', '-1');
    } else {
      slot.removeAttribute('aria-disabled');
      slot.removeAttribute('tabindex');
    }
    paintHexCanvas(slot.firstChild, tier, PLAYER_COLORS[idx], isTaken);
  }
}

// Draw a single flat-top hex stamp into a fixed-size canvas. Used for
// both the avatar (current color, never taken) and the rose cells.
// Taken cells dim the hex (via canvas globalAlpha so the X stays at full
// chroma) and overlay a diagonal X in the player's own color.
// Drawing operates in CSS-pixel coordinates: setTransform(dpr,...) maps
// 1 logical px → dpr device px so the canvas backing store (sized at
// CSS_W*DPR × CSS_H*DPR by buildColorPicker) renders at native resolution.
function paintHexCanvas(canvas, tier, color, isTaken) {
  if (!canvas || typeof getHexStamp !== 'function') return;
  var dpr = COLOR_PICKER_CANVAS_DPR;
  var w = canvas.width / dpr;   // logical CSS-pixel width
  var h = canvas.height / dpr;  // logical CSS-pixel height
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  var stampSize = h - 8;
  var stamp = getHexStamp(tier, color, stampSize);
  // stamp.cssW/cssH are the stamp's logical size; the underlying buffer is
  // already DPR-scaled internally (see CanvasUtils.getHexStamp). Drawing
  // at logical size into our DPR-scaled context renders 1:1 device pixels.
  var sw = stamp.cssW != null ? stamp.cssW : stamp.width / dpr;
  var sh = stamp.cssH != null ? stamp.cssH : stamp.height / dpr;
  if (isTaken) {
    ctx.globalAlpha = 0.4;
    ctx.drawImage(stamp, (w - sw) / 2, (h - sh) / 2, sw, sh);
    ctx.globalAlpha = 1;
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
}

// Read the persisted color index. Returns null when nothing is stored or
// (in AirConsole mode) before the storage shim's cache has hydrated — both
// callers below treat null as "no preference".
function readStoredColorIndex() {
  var raw = null;
  try { raw = localStorage.getItem('stacker_color_index'); } catch (e) { /* iframe sandbox */ }
  if (raw == null) return null;
  var idx = parseInt(raw, 10);
  if (isNaN(idx) || idx < 0 || idx >= PLAYER_COLORS.length) return null;
  return idx;
}

// Keep the CouchPad accent hint (CONTRACT §4) in step with the player's
// color: the launcher tints its own chrome accents (name-chip icon, join
// spinner, rename controls) from this <head> meta. It's read only at page-
// load, so live updates matter for a WebView reload mid-session, where
// captureSessionColorIndex re-seeds the color from persistence before the
// page finishes loading. A harmless no-op in plain browsers / AirConsole,
// where nothing reads the meta.
function setAccentColorMeta(color) {
  if (!color) return;
  var meta = document.querySelector('meta[name="cp-accent-color"]');
  if (meta) meta.setAttribute('content', color);
}

// Tint the JOIN button before the first snapshot arrives. In AirConsole mode the
// storage shim hydrates asynchronously, so the bootstrap re-invokes this
// from its onLoad callback (see controller-airconsole.js). Skip when
// playerColorIndex is already set: the snapshot established the authoritative
// color, and overriding it with the previous-session preference would
// leave body --player-color stuck on a color the player no longer owns
// (reclaimPreferredColor bails when the preferred color is taken).
function captureSessionColorIndex() {
  if (playerColorIndex != null) return;
  var idx = readStoredColorIndex();
  if (idx == null) return;
  document.body.style.setProperty('--player-color', PLAYER_COLORS[idx]);
  setAccentColorMeta(PLAYER_COLORS[idx]);
}
captureSessionColorIndex();

// Save the player's current color so a future reload can reclaim it.
// Called from applyOwnIdentity when userPickedColor is true (i.e. the user
// actually tapped a swatch — display-assigned defaults are ignored).
function persistColorIndex(idx) {
  try { localStorage.setItem('stacker_color_index', String(idx)); }
  catch (e) { /* iframe sandbox */ }
}

// If the persisted color differs from what the display just assigned, ask
// for it back. Same-index is a no-op on the display side; collisions are
// silently rejected. Skip when the preferred color is already taken
// (takenColorIndices comes from the same snapshot, applied just before this).
// Safe to re-call from controller-airconsole's onLoad: a no-op when the shim
// hydrated before the first snapshot, and the actual reclaim path when not.
function reclaimPreferredColor() {
  var preferred = readStoredColorIndex();
  if (preferred == null) return;
  if (preferred === playerColorIndex) return;
  if (typeof sendToDisplay !== 'function' || playerColorIndex == null) return;
  if (takenColorIndices && takenColorIndices.indexOf(preferred) >= 0) return;
  // Don't override an in-flight user pick: if the user has tapped a
  // swatch since this session started, that's their preference now —
  // the persisted value is moot. Narrow race where reclaim from onLoad
  // could otherwise undo a tap that landed before hydration.
  if (userPickedColor) return;
  sendToDisplay(MSG.SET_COLOR, { colorIndex: preferred });
}

// One-time setup — sizes the avatar canvas and creates 7 rose cells. The
// cells are placed in DOM in ROSE_SLOT_ORDER (top, ur, lr, bottom, ll, ul,
// center); CSS positions them via .rose-cell--<slot> classes. Per-cell
// PLAYER_COLORS index + ARIA labels are populated on each render based on
// who the player currently is (alternatives = all 8 minus current). Click
// delegation happens at the rose container.
function buildColorPicker() {
  if (!colorPickerEl || colorPickerEl.children.length) return;
  for (var s = 0; s < ROSE_SLOT_ORDER.length; s++) {
    var slot = ROSE_SLOT_ORDER[s];
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rose-cell rose-cell--' + slot;
    btn.dataset.slot = slot;
    var canvas = document.createElement('canvas');
    canvas.width = COLOR_PICKER_CANVAS_W;
    canvas.height = COLOR_PICKER_CANVAS_H;
    btn.appendChild(canvas);
    // Hex-clipped hit overlay — see .rose-cell in controller.css for the
    // rationale (rectangular buttons would steal slanted-edge clicks from
    // tessellated neighbours).
    var hit = document.createElement('span');
    hit.className = 'rose-cell__hit';
    btn.appendChild(hit);
    colorPickerEl.appendChild(btn);
  }
}

// =====================================================================
// Color picker overlay — open / close
// =====================================================================

// Track the element that had focus when the overlay opened so we can
// restore it on close. Without this, dismissing the overlay leaves focus
// on document.body which breaks keyboard nav.
var _pickerPreviousFocus = null;

function openColorPicker() {
  if (!colorPickerOverlay) return;
  if (!colorPickerOverlay.classList.contains('hidden')) return;
  _pickerPreviousFocus = document.activeElement;
  // Drop .hidden BEFORE renderColorPicker so the rose-repaint guard inside
  // renderColorPicker (skip while .hidden) sees the open state and paints
  // the cells with the current alternatives. Synchronous canvas paints
  // complete before the fade-in transition's first frame.
  colorPickerOverlay.classList.remove('hidden');
  renderColorPicker();
  if (identityTrigger) identityTrigger.setAttribute('aria-expanded', 'true');
  // Move focus to the centre cell so keyboard users land somewhere
  // meaningful. Tap-to-open users will never see the focus ring (they're
  // touching), so the visual cost is nil.
  var center = colorPickerEl && colorPickerEl.querySelector('.rose-cell--center');
  if (center) {
    try { center.focus({ preventScroll: true }); }
    catch (e) { center.focus(); }
  }
}

function closeColorPicker() {
  if (!colorPickerOverlay) return;
  if (colorPickerOverlay.classList.contains('hidden')) return;
  colorPickerOverlay.classList.add('hidden');
  if (identityTrigger) identityTrigger.setAttribute('aria-expanded', 'false');
  // Drop any pending pick — if the user closes manually before the
  // display has confirmed, treat the request as abandoned. The display
  // will silently no-op the SET_COLOR if it's already too late.
  pendingColorPick = null;
  if (_pickerPreviousFocus && typeof _pickerPreviousFocus.focus === 'function') {
    try { _pickerPreviousFocus.focus({ preventScroll: true }); }
    catch (e) { _pickerPreviousFocus.focus(); }
  }
  _pickerPreviousFocus = null;
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
// Room Snapshot — the single source of truth
// =====================================================================
//
// The display publishes ONE retained snapshot (party.setState) describing the
// whole room. The relay pushes it live to every connected controller and
// replays it to a (re)joining peer right after `joined`, so "live update" and
// "resync after a blip" are literally the same code path and cannot drift
// apart. Everything this controller shows is derived from it — identity,
// roster, host, pause, liveness, results, and which screen is up.
//
// Shape (see DisplayConnection.js#buildRoomSnapshot):
//   { roomState, hostPeerIndex, paused, displayMuted, participants: [peerIndex],
//     players: { <peerIndex>: { name, color, startLevel, alive, helloSeen } },
//     results?: [...] }
//
// Applying it is idempotent: every step diffs against what is already
// rendered, so a snapshot that only moved another player's colour must not
// reset our screen, re-run the pause animation, or rebuild the touch handler
// under the player's finger.

// Reclaiming the persisted colour is a once-per-session handshake, not state.
// Reset on performDisconnect, which starts a genuinely new session.
var reclaimedPreferredColor = false;

function onState(snap) {
  if (!snap || typeof snap !== 'object' || !snap.players) return;
  var roster = snap.players;
  var mine = (peerIndex != null) ? roster[peerIndex] : null;
  // The display doesn't know us: it restarted with an empty roster, or our row
  // is still the placeholder peer_joined created before our HELLO landed (name
  // and colour guessed — rendering it would flash a wrong identity and correct
  // itself a round trip later). Nothing here is ours yet, and crucially this is
  // NOT proof our session survived — leave the display-gone bail timer armed
  // and stay on whatever screen we're on.
  if (!mine || mine.helloSeen === false) return;

  noteDisplayAlive();
  applyRoster(snap, roster);
  applyOwnIdentity(mine);
  if (typeof snap.displayMuted === 'boolean' && typeof onDisplayMuted === 'function') {
    onDisplayMuted({ muted: snap.displayMuted });
  }
  routeToRoomState(snap, mine);
  // After routing: every host-gated surface (Start button, results banner,
  // pause-overlay Return-to-lobby, settings mute row) is screen-dependent.
  updateHostVisibility();
  if (typeof updateSettingsHostUI === 'function') updateSettingsHostUI();

  if (!reclaimedPreferredColor) {
    reclaimedPreferredColor = true;
    // The display rejects a same-index or colliding request silently, and the
    // next snapshot carries the truth either way.
    reclaimPreferredColor();
  }
}

// A snapshot that names us proves the display is alive AND still holds this
// session — exactly what WELCOME used to prove, so it clears the same timers
// and overlays. Nothing else does: an empty-roster snapshot is filtered out
// above precisely so a restarted display can't cancel our bail.
function noteDisplayAlive() {
  gameCancelled = false;
  if (party) party.resetReconnectCount();
  clearTimeout(disconnectedTimer);
  clearTimeout(displayGoneTimer);
  displayGoneTimer = null;
  reconnectOverlay.classList.add('hidden');
  // onDisplayGone stops pings while the display's relay slot is empty; it's
  // back, so resume. Guarded so an ordinary snapshot doesn't keep resetting
  // the pong deadline and mask a genuinely bad link.
  if (!pingTimer) startPing();
}

// Everything derived from the roster as a whole rather than from our own row.
function applyRoster(snap, roster) {
  var ids = Object.keys(roster);
  var colors = [];
  for (var i = 0; i < ids.length; i++) {
    var c = roster[ids[i]].color;
    if (typeof c === 'number') colors.push(c);
  }
  colors.sort(function(a, b) { return a - b; });
  playerCount = ids.length;
  takenColorIndices = colors;

  var hostIdx = snap.hostPeerIndex;
  var hostEntry = (hostIdx != null) ? roster[hostIdx] : null;
  isHost = hostIdx != null && peerIndex === hostIdx;
  hostName = hostEntry ? hostEntry.name : null;
  hostColor = (hostEntry && hostEntry.color != null) ? PLAYER_COLORS[hostEntry.color] : null;
  updateStartButton();
}

// Our own row: name, colour, start level.
function applyOwnIdentity(mine) {
  if (mine.name && mine.name !== playerName) {
    playerName = mine.name;
    if (playerNameIsAuto) rememberAutoPlayerName(playerName);
    applyLocalPlayerName();
  }
  if (typeof mine.color === 'number' && mine.color !== playerColorIndex) {
    playerColorIndex = mine.color;
    playerColor = PLAYER_COLORS[mine.color] || PLAYER_COLORS[0];
    document.body.style.setProperty('--player-color', playerColor);
    playerIdentity.style.setProperty('--player-color', playerColor);
    gameScreen.style.setProperty('--player-color', playerColor);
    setAccentColorMeta(playerColor);
    // Persist only user-initiated changes (see userPickedColor in
    // ControllerState.js). Display-driven assignments — initial slot,
    // reconnect default, reclaim's own confirmation — must not write here: in
    // AC mode an early snapshot landing before the persistent-data fetch
    // resolves would clobber the previous-session preference in cache.
    if (userPickedColor) persistColorIndex(mine.color);
  }
  // Absent means 1: the snapshot omits the three per-player fields at their
  // defaults (see RoomCore.snapshot). Coalescing rather than skipping matters —
  // a stepper wound up to 9 and then reset by a new room must fall back to 1,
  // not keep the value the last snapshot happened to carry. Coalescing is also
  // what lets a step back DOWN to 1 ack, since that field is omitted entirely.
  var level = mine.startLevel != null ? mine.startLevel : 1;
  // The stepper renders optimistically and the display throttles level
  // publishes (RoomCore's 'soon' hint), so every snapshot between a tap and its
  // echo still describes the pre-tap level. Adopting one reverts the number
  // under the user's finger, and since the next tap counts from startLevel, it
  // silently loses increments too. An unacked tap therefore defers adoption
  // without ever overriding the display: with nothing pending the snapshot is
  // still the only truth. Waiting for the ack is safe because SET_LEVEL rides
  // the reliable, ordered relay socket, not the lossy fastlane (FASTLANE_TYPES).
  if (level === pendingLevel) pendingLevel = null;
  if (pendingLevel === null) startLevel = level;
}

// The one place a screen is chosen.
function routeToRoomState(snap, mine) {
  var inGame = snap.roomState === 'playing' || snap.roomState === 'countdown';
  var participant = inGame && Array.isArray(snap.participants)
    && snap.participants.indexOf(peerIndex) >= 0;
  // In the roster but not in the running game: we joined late and sit in the
  // lobby behind the "game in progress" banner until the next round.
  waitingForNextGame = inGame && !participant;

  if (participant) return enterGameScreen(snap, mine);
  // A fresh controller can land on RESULTS before the display has a ranking to
  // show (it cleared one on the way to a new game) — the lobby is the honest
  // fallback there.
  if (snap.roomState === 'results' && snap.results) return enterResultsScreen(snap.results);
  return enterLobbyScreen();
}

function enterGameScreen(snap, mine) {
  var entering = currentScreen !== 'game';
  var wasCounting = gameScreen.classList.contains('countdown');
  var counting = snap.roomState === 'countdown';
  var alive = mine.alive !== false;

  if (entering) {
    lastLines = 0;
    // Stale pause-self state from a previous round would wrongly suppress
    // "Paused by X" in this one.
    selfPausing = false;
    clearTimeout(selfPausingTimer);
    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    removeKoOverlay();
    pauseOverlay.classList.add('hidden');
    reconnectOverlay.classList.add('hidden');
    gameScreen.style.setProperty('--player-color', playerColor);
    touchArea.setAttribute('data-player-name', playerName || t('player'));
    pauseBtn.disabled = false;
    pauseBtn.classList.remove('hidden');
    showScreen('game');
  }

  gameScreen.classList.toggle('countdown', counting);

  if (alive) {
    gameScreen.classList.remove('dead');
    removeKoOverlay();
  } else if (!gameScreen.classList.contains('dead')) {
    gameScreen.classList.add('dead');
    showKoOverlay();
  }

  // Diffed against the DOM so an unrelated snapshot never replays the overlay
  // animation, and so a reconnect straight into a paused game still gets it.
  if (!!snap.paused !== gameScreen.classList.contains('paused')) {
    if (snap.paused) onGamePaused();
    else onGameResumed();
  }

  // Arm input when the game actually goes live — on the countdown -> playing
  // transition, or on entry if we're already playing (mid-game reconnect).
  // Never mid-game: initTouchInput destroys and rebuilds the handler.
  if (!counting && (!touchInput || wasCounting)) {
    if (wasCounting) ControllerAudio.tick();
    initTouchInput();
  }
}

function enterResultsScreen(results) {
  lastGameResults = results;
  // Re-rendering on every snapshot would restart the row animations; a host
  // change only needs the banner, which updateHostVisibility refreshes.
  if (currentScreen === 'gameover') return;
  // Leaving settings open on top of the results would block them.
  closeSettingsOverlay();
  renderGameResults(results);
  showScreen('gameover');
}

function enterLobbyScreen() {
  if (currentScreen !== 'lobby') {
    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    // Also clear 'countdown': a round abandoned mid-countdown would otherwise
    // leave it set, and enterGameScreen reads it as "we were counting down"
    // when deciding whether the game just went live.
    gameScreen.classList.remove('countdown');
    pauseOverlay.classList.add('hidden');
    showLobbyUI();
  } else {
    updateLevelDisplay();
    renderColorPicker();
  }
  if (waitingForNextGame) {
    startBtn.classList.add('hidden');
    startBtn.disabled = true;
    setWaitingActionMessage(t('game_in_progress'));
  }
}

// =====================================================================
// Message Handlers — per-player game telemetry only
// =====================================================================

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
  // No liveness here on purpose: enterGameScreen raises the KO overlay off the
  // room snapshot, which is the only thing that carries `alive`.
}

// =====================================================================
// Pause
// =====================================================================

var selfPausing = false;
var selfPausingTimer = null;

function onGamePaused() {
  gameScreen.classList.add('paused');
  pauseOverlay.classList.toggle('pause-overlay--self', selfPausing);
  selfPausing = false;
  clearTimeout(selfPausingTimer);
  pauseOverlay.classList.remove('hidden');
  pauseBtn.disabled = true;
}

function onGameResumed() {
  gameScreen.classList.remove('paused');
  pauseOverlay.classList.add('hidden');
  pauseOverlay.classList.remove('pause-overlay--self');
  pauseOverlay.classList.remove('pause-overlay--ready');
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

  // Non-participants (late joiners who sat out this round) arrive in `results`
  // flagged newPlayer by the display: no rank/lines/level, a "new player"
  // status instead. They sort last (no rank).
  var sorted = results.slice().sort(function(a, b) { return (a.rank || 999) - (b.rank || 999); });
  // A late joiner counts toward the row total, so a 1-player game with one
  // waiting joiner is intentionally not "solo": the rank column appears (the
  // player gets "1", the joiner "–").
  var solo = sorted.length === 1;
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    var isNew = !!r.newPlayer;
    var pColor = PLAYER_COLORS[r.colorIndex] || PLAYER_COLORS[i % PLAYER_COLORS.length];

    var row = document.createElement('div');
    row.className = 'result-row';
    if (!solo && !isNew) row.className += ' rank-' + r.rank;
    if (isNew) row.className += ' result-row--joining';
    row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');
    if (r.playerId === peerIndex || r.playerId === clientId) row.classList.add('is-me');

    if (!solo) {
      var rankEl = document.createElement('span');
      rankEl.className = 'result-rank';
      rankEl.textContent = isNew ? '–' : String(r.rank);
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
    if (isNew) {
      var statusSpan = document.createElement('span');
      statusSpan.textContent = t('new_player');
      stats.appendChild(statusSpan);
    } else {
      var linesSpan = document.createElement('span');
      linesSpan.textContent = t('n_lines', { count: r.lines || 0 });
      var levelSpan = document.createElement('span');
      levelSpan.textContent = t('level_n', { level: r.level || 1 });
      stats.appendChild(linesSpan);
      stats.appendChild(levelSpan);
    }

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
window.addEventListener('resize', function() {
  _feedbackRect = null;
  fitIdentityName();
});

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
      if (softDropActive) {
        softDropActive = false;
        // Tell the display to stop immediately on touch-up rather than wait
        // for its soft-drop auto-end timeout.
        sendToDisplay(MSG.SOFT_DROP_END);
      }
    } else {
      // n rides along only when the ratchet actually produced more than one step
      // (see TouchInput._onPointerMove), so the common single-step message keeps
      // its exact old shape and a display that predates n still reads it.
      var input = { action: action };
      if (data && data.n > 1) input.n = data.n;
      sendToDisplay(MSG.INPUT, input);
    }
  }, null);
}
