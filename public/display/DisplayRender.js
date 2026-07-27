'use strict';

// =====================================================================
// Display Render — RAF render loop management
// Depends on: DisplayState.js, DisplayUI.js, Animations.js
// =====================================================================

// Cap frame delta to ~3 frames at 60Hz — prevents huge catch-up jumps after tab unfreeze.
// Sourced from the shared constants module (PartyCore's native frame() cap reads the same), so they can't drift.
var MAX_FRAME_DELTA_MS = GameConstants.MAX_FRAME_DELTA_MS;
// ~4fps — used when paused/results and no active animations, to save battery.
var IDLE_FRAME_INTERVAL_MS = 250;

var lastThrottled = null;
var _NO_SHAKE = Object.freeze({ x: 0, y: 0 });

// Scene signature of the last painted frame. Pieces move in discrete grid
// cells (no sub-row interpolation), so most RAF frames during play are
// pixel-identical to the previous one: when the signature matches and no
// time-driven effect is animating, the repaint is skipped entirely.
// null = unknown/stale (always repaint next frame).
var lastRenderSig = null;

// Called whenever the canvas content is externally invalidated (layout
// recalculation, canvas resize; assigning canvas.width clears the canvas).
function invalidateRenderSig() {
  lastRenderSig = null;
}

// Everything renderFrame draws must be reflected here; a missed input means
// a skipped repaint after that input changes. Time-driven visuals (near-clear
// pulse, clearing glow, sparkles, garbage effects) are excluded on purpose:
// renderLoop treats those as "must animate" and bypasses the signature check.
// Per-player render inputs as a signature fragment, shared between the
// whole-frame signature (computeRenderSig) and the per-board tile cache
// (paintBoardTile) so the two can't drift apart.
function playerRenderSig(p, pInfo) {
  // 0 = connected, 1 = disconnected (QR still generating), 2 = QR ready;
  // the async QR arrival must trigger a repaint.
  var qr = disconnectedQRs.has(p.id) ? (disconnectedQRs.get(p.id) ? 2 : 1) : 0;
  var sig = p.id + ':' + (p.alive ? 1 : 0) + ':' + p.lines + ':' + p.level
    + ':' + p.pendingGarbage + ':' + p.gridVersion + ':' + (p.holdPiece || '')
    + ':' + qr + ':' + (pInfo ? pInfo.playerName + ':' + pInfo.playerIndex : '');
  var cp = p.currentPiece;
  // cells[0] uniquely identifies rotation for every hex piece type (same
  // invariant the clear-preview cache in BoardRenderer relies on).
  if (cp) sig += ':' + cp.typeId + ':' + cp.anchorCol + ':' + cp.anchorRow
    + ':' + cp.cells[0].q + ':' + cp.cells[0].r;
  return sig;
}

// Pre-game variant (lobby scaffold boards): identity plus start level.
function emptyPlayerSig(id, pInfo) {
  return id + ':'
    + (pInfo ? pInfo.playerName + ':' + pInfo.playerIndex + ':' + (pInfo.startLevel || 1) : '');
}

function computeRenderSig() {
  // Font families flip when the webfonts finish loading (UIRenderer rebuilds
  // its cached font strings on the next paint), so they must repaint too.
  var sig = currentScreen + '|' + boardRenderers.length + '|'
    + getDisplayFont() + '|' + getBrandFont();
  if (!gameState) {
    sig += '|empty';
    for (var i = 0; i < playerOrder.length; i++) {
      sig += '|' + emptyPlayerSig(playerOrder[i], players.get(playerOrder[i]));
    }
    return sig;
  }
  sig += '|' + (gameState.elapsed != null ? Math.floor(gameState.elapsed / 1000) : -1);
  var ps = gameState.players;
  if (ps) {
    for (var j = 0; j < ps.length; j++) {
      sig += '|' + playerRenderSig(ps[j], players.get(ps[j].id));
    }
  }
  return sig;
}

// Returns all effects if any is still active; otherwise clears the map entry and returns [].
var _EMPTY_EFFECTS = Object.freeze([]);
function getOrClearEffects(effectsMap, playerId, timestamp) {
  var effects = effectsMap.get(playerId);
  if (!effects) return _EMPTY_EFFECTS;
  for (var i = 0; i < effects.length; i++) {
    if (timestamp - effects[i].startTime < effects[i].duration) return effects;
  }
  effectsMap.delete(playerId);
  return _EMPTY_EFFECTS;
}

function startRenderLoop() {
  if (rafId != null) return;
  rafId = requestAnimationFrame(renderLoop);
}

function stopRenderLoop() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function renderLoop(timestamp) {
  if (rafId == null) return;
  rafId = requestAnimationFrame(renderLoop);

  if ((currentScreen !== SCREEN.GAME && currentScreen !== SCREEN.RESULTS) || !ctx) return;

  // Drive game physics from RAF
  if (displayGame && roomState === ROOM_STATE.PLAYING && !paused) {
    var deltaMs = prevFrameTime ? Math.min(timestamp - prevFrameTime, MAX_FRAME_DELTA_MS) : 0;
    try {
      if (deltaMs > 0) {
        displayGame.update(deltaMs);
      }
      if (!displayGame) return; // game ended during update
      gameState = displayGame.getSnapshot();
    } catch (err) {
      console.error('Game engine error:', err);
      if (!displayGame) return;  // already cleaned up (e.g. game ended mid-update)
      displayGame.ended = true;
      var results = displayGame.getResults();
      displayGame = null;
      prevFrameTime = 0;
      if (results) {
        // Stash the ranking BEFORE the transition: setRoomState publishes, and
        // the RESULTS snapshot is what carries the results to controllers.
        // Enriched like the normal end-of-game path, or the salvaged ranking
        // would reach the controllers with no names or colours on it.
        if (results.results) roomCore.enrichResults(results.results);
        lastResults = results.results;
        setRoomState(ROOM_STATE.RESULTS);
        onGameEnd(results);
      }
      return;
    }

    // Recalculate layout if player count changed
    if (gameState.players && boardRenderers.length !== gameState.players.length) {
      calculateLayout();
    }

    prevFrameTime = timestamp;
  } else {
    prevFrameTime = 0;
    // Prime one static snapshot if the game paused before the loop ever
    // captured one (e.g. sole controller dropped during countdown, so PLAYING
    // begins already auto-paused). Without it gameState stays null and the
    // disconnect overlay never renders over the empty pre-game boards.
    if (displayGame && roomState === ROOM_STATE.PLAYING && gameState === null) {
      try {
        gameState = displayGame.getSnapshot();
      } catch (err) {
        console.error('Game engine error:', err);
        displayGame = null;
      }
    }
  }

  // Throttle to ~4fps when paused/results with no active animations
  var hasAnimations = animations && animations.active.length > 0;
  var hasGarbageEffects = garbageIndicatorEffects.size > 0 || garbageDefenceEffects.size > 0;
  if ((paused || currentScreen === SCREEN.RESULTS) && !hasAnimations && !hasGarbageEffects) {
    if (!lastThrottled) lastThrottled = timestamp;
    if (timestamp - lastThrottled < IDLE_FRAME_INTERVAL_MS) return;
    lastThrottled = timestamp;
  } else {
    lastThrottled = null;
  }

  // Skip the repaint when the scene is provably identical to the last painted
  // frame. Time-driven effects (sparkles, garbage flashes, clearing glow,
  // near-clear pulse) animate against the clock, so any of them being active
  // forces a paint; the near-clear check reads the renderers' cached cells
  // from the previous paint, which stay valid while gridVersion is unchanged.
  // window.__TEST__ (e2e/gallery) disables skipping because harness helpers
  // like _extraGhosts inject render inputs the signature doesn't track.
  // Adclip captures keep the skip (see the adclip flag in DisplayTestHarness).
  var mustAnimate = hasAnimations || hasGarbageEffects ||
    !!(window.__TEST__ && !window.__TEST__.adclip);
  if (!mustAnimate && gameState && gameState.players) {
    for (var mi = 0; mi < gameState.players.length; mi++) {
      var mp = gameState.players[mi];
      if (mp.clearingCells && mp.clearingCells.length > 0) { mustAnimate = true; break; }
      if (boardRenderers[mi] && boardRenderers[mi]._cachedNcCells.length > 0) { mustAnimate = true; break; }
    }
  }
  if (mustAnimate) {
    lastRenderSig = null;
  } else {
    var sig = computeRenderSig();
    if (sig === lastRenderSig) return;
    lastRenderSig = sig;
  }

  try {
    renderFrame(timestamp);
  } catch (err) {
    console.error('[render] Error in render loop:', err);
  }
}

// Per-board tile cache: each board renders into its own offscreen canvas,
// sized to br.tileRect (assigned by calculateLayout) at the current DPR. The
// tile origin snaps to whole device pixels, so a 1:1 blit reproduces the
// exact pixels a direct draw would have painted. calculateLayout rebuilds the
// renderers (dropping tiles with them); a DPR change mid-session is caught by
// the dpr key below.
function getBoardTile(br) {
  var dpr = window.devicePixelRatio || 1;
  var rect = br.tileRect;
  var px0 = Math.floor(rect.x * dpr);
  var py0 = Math.floor(rect.y * dpr);
  var pw = Math.ceil((rect.x + rect.w) * dpr) - px0;
  var ph = Math.ceil((rect.y + rect.h) * dpr) - py0;
  var tile = br._tile;
  if (!tile || tile.dpr !== dpr || tile.px0 !== px0 || tile.py0 !== py0 ||
      tile.pw !== pw || tile.ph !== ph) {
    var oc;
    if (typeof OffscreenCanvas !== 'undefined') oc = new OffscreenCanvas(pw, ph);
    else { oc = document.createElement('canvas'); oc.width = pw; oc.height = ph; }
    tile = br._tile = {
      canvas: oc,
      // alpha:false — every render pre-fills the tile with opaque bg.primary,
      // matching the (also alpha:false) main canvas.
      ctx: oc.getContext('2d', { alpha: false }),
      dpr: dpr, px0: px0, py0: py0, pw: pw, ph: ph,
      sig: null  // null = stale, re-render on the next painted frame
    };
  }
  return tile;
}

// Render-or-blit one board. On a painted frame the board re-renders into its
// tile only when its signature changed or `animating` says board-local pixels
// are time-driven (clearing glow, near-clear pulse, garbage meter flashes,
// shake); otherwise the cached tile is blitted back. Animated renders bake a
// clock-dependent alpha into the tile, so their signature is not stored: the
// first painted frame after the effect ends re-renders a clean tile.
function paintBoardTile(j, playerData, timestamp, shake, sig, animating) {
  var br = boardRenderers[j];
  var ui = uiRenderers[j];
  var tile = getBoardTile(br);
  if (animating || tile.sig !== sig) {
    var tctx = tile.ctx;
    // Opaque pre-fill in device space (a fractional-edge fill under the DPR
    // transform would leave partial coverage against alpha:false).
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.fillStyle = THEME.color.bg.primary;
    tctx.fillRect(0, 0, tile.pw, tile.ph);
    // Same device-pixel coordinates as a direct draw on the main canvas: the
    // DPR transform shifted by the tile's snapped origin.
    tctx.setTransform(tile.dpr, 0, 0, tile.dpr, -tile.px0, -tile.py0);
    if (shake.x !== 0 || shake.y !== 0) tctx.translate(shake.x, shake.y);
    // The renderers draw through this.ctx; point them at the tile for this pass.
    br.ctx = tctx;
    ui.ctx = tctx;
    br.render(playerData, timestamp);
    ui.render(playerData, timestamp);

    // Test-only: draw extra ghost pieces if set
    if (window.__TEST__ && window.__TEST__._extraGhosts && window.__TEST__._extraGhosts[j]) {
      var extras = window.__TEST__._extraGhosts[j];
      for (var eg = 0; eg < extras.length; eg++) {
        var ghost = extras[eg];
        var gc = GHOST_COLORS[ghost.typeId] || { outline: 'rgba(255,255,255,0.12)', fill: 'rgba(255,255,255,0.06)' };
        if (ghost.blocks) {
          for (var bl = 0; bl < ghost.blocks.length; bl++) {
            var gbx = ghost.blocks[bl][0];
            var gby = ghost.blocks[bl][1];
            var drawCol = ghost.x + gbx;
            var drawRow = ghost.ghostY + gby;
            br.drawGhostBlock(drawCol, drawRow, gc);
          }
        }
      }
    }

    // Draw QR overlay for disconnected players (qr state is in the signature;
    // gameState-gated to match the pre-game branch, which never drew it)
    if (gameState && disconnectedQRs.has(playerData.id)) {
      ui.drawDisconnectedOverlay(
        disconnectedQRs.get(playerData.id),
        playerData.playerColor
      );
    }

    br.ctx = ctx;
    ui.ctx = ctx;
    tile.sig = animating ? null : sig;
  }
  ctx.drawImage(tile.canvas, 0, 0, tile.pw, tile.ph,
    tile.px0 / tile.dpr, tile.py0 / tile.dpr, tile.pw / tile.dpr, tile.ph / tile.dpr);
}

function renderFrame(timestamp) {
  var w = cachedW;
  var h = cachedH;
  ctx.fillStyle = THEME.color.bg.primary;
  ctx.fillRect(0, 0, w, h);

  // e2e/gallery harness helpers inject render inputs the signatures don't
  // track, so every tile re-renders on every painted frame (mirrors the
  // whole-frame skip's __TEST__ escape in renderLoop).
  var forceDirty = !!(window.__TEST__ && !window.__TEST__.adclip);
  // Font families flip when the webfonts finish loading; part of every tile
  // signature for the same reason they're in computeRenderSig.
  var fontSig = getDisplayFont() + '|' + getBrandFont();

  if (!gameState) {
    for (var i = 0; i < playerOrder.length; i++) {
      if (!boardRenderers[i] || !uiRenderers[i]) continue;
      var pInfo = players.get(playerOrder[i]);
      var empty = {
        id: playerOrder[i],
        alive: true,
        lines: 0, level: pInfo?.startLevel || 1,
        garbageIndicatorEffects: _EMPTY_EFFECTS,
        garbageDefenceEffects: _EMPTY_EFFECTS,
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: PLAYER_COLORS[pInfo?.playerIndex ?? i]
      };
      var emptySig = fontSig + '|empty|' + emptyPlayerSig(playerOrder[i], pInfo);
      paintBoardTile(i, empty, timestamp, _NO_SHAKE, emptySig, forceDirty);
    }
    return;
  }

  if (gameState.players) {
    for (var j = 0; j < gameState.players.length; j++) {
      var playerData = gameState.players[j];
      if (!boardRenderers[j] || !uiRenderers[j]) continue;

      var shake = animations
        ? animations.getShakeOffsetForBoard(boardRenderers[j].x, boardRenderers[j].y)
        : _NO_SHAKE;

      var pInfo = players.get(playerData.id);
      var activeGarbageIndicatorEffects = getOrClearEffects(garbageIndicatorEffects, playerData.id, timestamp);
      var activeGarbageDefenceEffects = getOrClearEffects(garbageDefenceEffects, playerData.id, timestamp);
      // playerData contains live references (blocks, cells, grid rows) —
      // consume within this frame. Mutating here avoids Object.assign overhead.
      playerData.garbageIndicatorEffects = activeGarbageIndicatorEffects;
      playerData.garbageDefenceEffects = activeGarbageDefenceEffects;
      playerData.playerName = pInfo?.playerName || PLAYER_NAMES[j];
      playerData.playerColor = PLAYER_COLORS[pInfo?.playerIndex ?? j];

      // Per-board signature: the shared per-player fragment plus the fonts.
      // Decides which boards re-render on a painted frame.
      var sig = fontSig + '|' + playerRenderSig(playerData, pInfo);

      // Board-local time-driven pixels force a re-render even on an unchanged
      // signature. The near-clear read reuses the renderer's cached cells from
      // its previous render (same trick as the renderLoop mustAnimate check:
      // they stay valid while gridVersion is unchanged, and a gridVersion
      // change dirties the signature anyway). Shake re-renders with the
      // offset baked in as a translate, keeping path rasterization identical
      // to the pre-tile code instead of resampling a shifted blit.
      var animating = forceDirty
        || (playerData.clearingCells && playerData.clearingCells.length > 0)
        || boardRenderers[j]._cachedNcCells.length > 0
        || activeGarbageIndicatorEffects.length > 0
        || activeGarbageDefenceEffects.length > 0
        || shake.x !== 0 || shake.y !== 0;

      paintBoardTile(j, playerData, timestamp, shake, sig, animating);
    }
  }

  if (animations) {
    animations.update(timestamp);
    animations.render(timestamp);
  }

  if (gameState.elapsed != null) {
    drawTimer(gameState.elapsed);
  }
}
