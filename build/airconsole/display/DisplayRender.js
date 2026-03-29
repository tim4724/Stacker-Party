'use strict';

// =====================================================================
// Display Render — RAF render loop management
// Depends on: DisplayState.js, DisplayUI.js, Animations.js
// =====================================================================

var lastThrottled = null;

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
    var deltaMs = prevFrameTime ? Math.min(timestamp - prevFrameTime, 50) : 0;
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
    // Update music speed
    if (music && music.playing && gameState.players && gameState.players.length > 0) {
      var maxLevel = 1;
      for (var ml = 0; ml < gameState.players.length; ml++) {
        var pl = gameState.players[ml].level || 1;
        if (pl > maxLevel) maxLevel = pl;
      }
      music.setSpeed(maxLevel);
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
    if (timestamp - lastThrottled < 250) return;
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
  var w = window.innerWidth;
  var h = window.innerHeight;
  ctx.fillStyle = THEME.color.bg.primary;
  ctx.fillRect(0, 0, w, h);

  if (!renderFrame._vignette || renderFrame._vw !== w || renderFrame._vh !== h) {
    renderFrame._vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
    renderFrame._vignette.addColorStop(0, 'rgba(15, 15, 40, 0.3)');
    renderFrame._vignette.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
    renderFrame._vw = w;
    renderFrame._vh = h;
  }
  ctx.fillStyle = renderFrame._vignette;
  ctx.fillRect(0, 0, w, h);

  if (!gameState) {
    for (var i = 0; i < playerOrder.length; i++) {
      if (!boardRenderers[i] || !uiRenderers[i]) continue;
      var pInfo = players.get(playerOrder[i]);
      var empty = {
        id: playerOrder[i],
        alive: true,
        lines: 0, level: pInfo?.startLevel || 1,
        garbageIndicatorEffects: [],
        playerName: pInfo?.playerName || PLAYER_NAMES[i],
        playerColor: pInfo?.playerColor || PLAYER_COLORS[i]
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
        : { x: 0, y: 0 };

      if (shake.x !== 0 || shake.y !== 0) {
        ctx.save();
        ctx.translate(shake.x, shake.y);
      }

      var pInfo = players.get(playerData.id);
      var activeGarbageIndicatorEffects = garbageIndicatorEffects.get(playerData.id) || [];
      var hasActiveIndicator = false;
      for (var gi = 0; gi < activeGarbageIndicatorEffects.length; gi++) {
        if (timestamp - activeGarbageIndicatorEffects[gi].startTime < activeGarbageIndicatorEffects[gi].duration) {
          hasActiveIndicator = true;
          break;
        }
      }
      if (!hasActiveIndicator) {
        garbageIndicatorEffects.delete(playerData.id);
        activeGarbageIndicatorEffects = [];
      }
      var activeGarbageDefenceEffects = garbageDefenceEffects.get(playerData.id) || [];
      var hasActiveDefence = false;
      for (var gd = 0; gd < activeGarbageDefenceEffects.length; gd++) {
        if (timestamp - activeGarbageDefenceEffects[gd].startTime < activeGarbageDefenceEffects[gd].duration) {
          hasActiveDefence = true;
          break;
        }
      }
      if (!hasActiveDefence) {
        garbageDefenceEffects.delete(playerData.id);
        activeGarbageDefenceEffects = [];
      }
      // playerData is a fresh snapshot per frame (getState() allocates new objects);
      // mutating it here avoids Object.assign overhead.
      playerData.garbageIndicatorEffects = activeGarbageIndicatorEffects;
      playerData.garbageDefenceEffects = activeGarbageDefenceEffects;
      playerData.playerName = pInfo?.playerName || PLAYER_NAMES[j];
      playerData.playerColor = pInfo?.playerColor || PLAYER_COLORS[j];

      boardRenderers[j].render(playerData, timestamp);
      uiRenderers[j].render(playerData, timestamp);

      // Test-only: draw extra ghost pieces if set
      if (window.__TEST__ && window.__TEST__._extraGhosts && window.__TEST__._extraGhosts[j]) {
        var br = boardRenderers[j];
        var ghostColorSet = br.styleTier === STYLE_TIERS.NEON_FLAT ? NEON_GHOST_COLORS : GHOST_COLORS;
        var extras = window.__TEST__._extraGhosts[j];
        for (var eg = 0; eg < extras.length; eg++) {
          var ghost = extras[eg];
          var gc = ghostColorSet[ghost.typeId] || { outline: 'rgba(255,255,255,0.12)', fill: 'rgba(255,255,255,0.06)' };
          for (var bl = 0; bl < ghost.blocks.length; bl++) {
            var gbx = ghost.blocks[bl][0];
            var gby = ghost.blocks[bl][1];
            var drawRow = ghost.ghostY + gby;
            var drawCol = ghost.x + gbx;
            if (drawRow >= 0 && drawRow < GameConstants.VISIBLE_HEIGHT && drawCol >= 0 && drawCol < GameConstants.BOARD_WIDTH) {
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
