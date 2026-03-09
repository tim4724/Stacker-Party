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
        score: 0, lines: 0, level: 1,
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
      var activeGarbageIndicatorEffects = (garbageIndicatorEffects.get(playerData.id) || [])
        .filter(function(effect) { return timestamp - effect.startTime < effect.duration; });
      if (activeGarbageIndicatorEffects.length > 0) {
        garbageIndicatorEffects.set(playerData.id, activeGarbageIndicatorEffects);
      } else {
        garbageIndicatorEffects.delete(playerData.id);
      }
      var activeGarbageDefenceEffects = (garbageDefenceEffects.get(playerData.id) || [])
        .filter(function(effect) { return timestamp - effect.startTime < effect.duration; });
      if (activeGarbageDefenceEffects.length > 0) {
        garbageDefenceEffects.set(playerData.id, activeGarbageDefenceEffects);
      } else {
        garbageDefenceEffects.delete(playerData.id);
      }
      var enriched = Object.assign({}, playerData, {
        garbageIndicatorEffects: activeGarbageIndicatorEffects,
        garbageDefenceEffects: activeGarbageDefenceEffects,
        playerName: pInfo?.playerName || PLAYER_NAMES[j],
        playerColor: pInfo?.playerColor || PLAYER_COLORS[j]
      });

      boardRenderers[j].render(enriched);
      uiRenderers[j].render(enriched, timestamp);

      // Draw QR overlay for disconnected players
      if (disconnectedQRs.has(playerData.id)) {
        var br = boardRenderers[j];
        var bx = br.x;
        var by = br.y;
        var bw = 10 * br.cellSize;
        var bh = 20 * br.cellSize;

        ctx.fillStyle = 'rgba(0, 0, 0, ' + THEME.opacity.overlay + ')';
        ctx.fillRect(bx, by, bw, bh);

        var qrImg = disconnectedQRs.get(playerData.id);
        var labelSize = Math.max(10, br.cellSize * THEME.font.cellScale.name);
        var labelGap = labelSize * 1.2;
        var qrSize = Math.min(bw, bh) * 0.5;
        var qrRadius = qrSize * 0.08;
        var pad = qrSize * 0.06;
        var outerSize = qrSize + pad * 2;
        var totalH = outerSize + labelGap + labelSize;
        var groupY = by + (bh - totalH) / 2;
        var outerX = bx + (bw - outerSize) / 2;

        ctx.fillStyle = THEME.color.text.white;
        ctx.beginPath();
        ctx.roundRect(outerX, groupY, outerSize, outerSize, qrRadius);
        ctx.fill();

        ctx.strokeStyle = 'rgba(0, 200, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (qrImg) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(outerX + pad, groupY + pad, qrSize, qrSize, Math.max(1, qrRadius - pad));
          ctx.clip();
          ctx.drawImage(qrImg, outerX + pad, groupY + pad, qrSize, qrSize);
          ctx.restore();
        }

        ctx.fillStyle = enriched.playerColor || 'rgba(0, 200, 255, 0.7)';
        ctx.font = '600 ' + labelSize + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = '0.1em';
        ctx.fillText('SCAN TO REJOIN', bx + bw / 2, groupY + outerSize + labelGap);
        ctx.letterSpacing = '0px';
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
