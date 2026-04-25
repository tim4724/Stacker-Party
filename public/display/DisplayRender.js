'use strict';

// =====================================================================
// Display Render — RAF render loop management
// Depends on: DisplayState.js, DisplayUI.js, Animations.js
// =====================================================================

// Cap frame delta to ~3 frames at 60Hz — prevents huge catch-up jumps after tab unfreeze.
var MAX_FRAME_DELTA_MS = 50;
// ~4fps — used when paused/results and no active animations, to save battery.
var IDLE_FRAME_INTERVAL_MS = 250;

var lastThrottled = null;
var lastMusicLevel = 0;
var _NO_SHAKE = Object.freeze({ x: 0, y: 0 });

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
        setRoomState(ROOM_STATE.RESULTS);
        lastResults = results;
        party.broadcast({ type: MSG.GAME_END, elapsed: results.elapsed, results: results.results });
        onGameEnd(results);
      }
      return;
    }

    // Recalculate layout if player count changed
    if (gameState.players && boardRenderers.length !== gameState.players.length) {
      calculateLayout();
    }
    // Update music speed (only when max level changes)
    if (music && music.playing && gameState.players && gameState.players.length > 0) {
      var maxLevel = 1;
      for (var ml = 0; ml < gameState.players.length; ml++) {
        var pl = gameState.players[ml].level || 1;
        if (pl > maxLevel) maxLevel = pl;
      }
      if (maxLevel !== lastMusicLevel) {
        lastMusicLevel = maxLevel;
        music.setSpeed(maxLevel);
      }
    }

    prevFrameTime = timestamp;
  } else {
    prevFrameTime = 0;
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

  try {
    renderFrame(timestamp);
  } catch (err) {
    console.error('[render] Error in render loop:', err);
  }
}

function renderFrame(timestamp) {
  var w = cachedW;
  var h = cachedH;
  ctx.fillStyle = THEME.color.bg.primary;
  ctx.fillRect(0, 0, w, h);

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
      boardRenderers[i].render(empty);
      uiRenderers[i].render(empty);
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

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.save();
        ctx.translate(shake.x, shake.y);
      }

      var pInfo = players.get(playerData.id);
      var activeGarbageIndicatorEffects = getOrClearEffects(garbageIndicatorEffects, playerData.id, timestamp);
      var activeGarbageDefenceEffects = getOrClearEffects(garbageDefenceEffects, playerData.id, timestamp);
      // playerData contains live references (blocks, cells, grid rows) —
      // consume within this frame. Mutating here avoids Object.assign overhead.
      playerData.garbageIndicatorEffects = activeGarbageIndicatorEffects;
      playerData.garbageDefenceEffects = activeGarbageDefenceEffects;
      playerData.playerName = pInfo?.playerName || PLAYER_NAMES[j];
      playerData.playerColor = PLAYER_COLORS[pInfo?.playerIndex ?? j];

      boardRenderers[j].render(playerData, timestamp);
      uiRenderers[j].render(playerData, timestamp);

      // Test-only: draw extra ghost pieces if set
      if (window.__TEST__ && window.__TEST__._extraGhosts && window.__TEST__._extraGhosts[j]) {
        var br = boardRenderers[j];
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

      // Draw QR overlay for disconnected players
      if (disconnectedQRs.has(playerData.id)) {
        uiRenderers[j].drawDisconnectedOverlay(
          disconnectedQRs.get(playerData.id),
          playerData.playerColor
        );
      }

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.restore();
      }
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
