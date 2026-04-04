'use strict';

// HexUIRenderer: side panels for hex (flat-top) mode.
// Same interface as UIRenderer.

var HEX_MINI_PIECES = HexPieceModule.HEX_PIECES;
var HEX_TYPE_TO_ID = HexConstants.HEX_PIECE_TYPE_TO_ID;

// Compute bounding boxes for flat-top hex mini pieces using odd-q offset conversion.
var HEX_MINI_BOUNDS = {};
(function() {
  for (var type in HEX_MINI_PIECES) {
    var cells = HEX_MINI_PIECES[type];
    var offsets = cells.map(function(c) {
      return HexPieceModule.axialToOffset(c[0], c[1]);
    });
    var minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (var i = 0; i < offsets.length; i++) {
      minC = Math.min(minC, offsets[i].col);
      maxC = Math.max(maxC, offsets[i].col);
      minR = Math.min(minR, offsets[i].row);
      maxR = Math.max(maxR, offsets[i].row);
    }
    // Normalize: shift so minC starts at 0 (preserve column parity)
    var shiftC = minC - (minC & 1);  // round down to even
    var shiftR = minR;
    var shifted = offsets.map(function(o) { return { col: o.col - shiftC, row: o.row - shiftR }; });
    // Recompute bounds after shift
    var sMinC = Infinity, sMaxC = -Infinity, sMinR = Infinity, sMaxR = -Infinity;
    for (var j = 0; j < shifted.length; j++) {
      sMinC = Math.min(sMinC, shifted[j].col);
      sMaxC = Math.max(sMaxC, shifted[j].col);
      sMinR = Math.min(sMinR, shifted[j].row);
      sMaxR = Math.max(sMaxR, shifted[j].row);
    }
    HEX_MINI_BOUNDS[type] = { minC: sMinC, maxC: sMaxC, minR: sMinR, maxR: sMaxR, offsets: shifted };
  }
})();

class HexUIRenderer {
  constructor(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex) {
    this.ctx = ctx;
    this.boardX = boardX;
    this.boardY = boardY;
    this.cellSize = cellSize;
    this.boardWidth = boardWidthPx;
    this.boardHeight = boardHeightPx;
    this.playerIndex = playerIndex;
    this.accentColor = PLAYER_COLORS[playerIndex] || PLAYER_COLORS[0];
    this._accentRgb = hexToRgb(this.accentColor);
    this.panelWidth = cellSize * THEME.size.panelWidth;
    this.miniSize = cellSize * THEME.font.cellScale.mini;
    this.panelGap = cellSize * THEME.size.panelGap;
    this._styleTier = STYLE_TIERS.NORMAL;

    // Hex geometry (shared with HexBoardRenderer and DisplayUI)
    var geo = HexConstants.computeHexGeometry(HexConstants.HEX_COLS, HexConstants.HEX_VISIBLE_ROWS, cellSize);
    this._hexSize = geo.hexSize;
    this._hexH = geo.hexH;
    this._colW = geo.colW;
  }

  render(playerState, timestamp) {
    this._styleTier = getStyleTier(playerState.level || 1);
    this.drawPlayerName(playerState);
    this.drawHoldPanel(playerState);
    this.drawNextPanel(playerState);
    if (playerState.pendingGarbage > 0) this.drawGarbageMeter(playerState.pendingGarbage);
    if (playerState.garbageIndicatorEffects) this.drawGarbageIndicatorEffects(playerState.garbageIndicatorEffects, timestamp);
    if (playerState.garbageDefenceEffects) this.drawGarbageDefenceEffects(playerState.garbageDefenceEffects, timestamp);
    if (playerState.alive === false) this.drawKOOverlay();
  }

  drawPlayerName(playerState) {
    var ctx = this.ctx;
    var name = playerState.playerName || PLAYER_NAMES[this.playerIndex] || ('Player ' + (this.playerIndex + 1));
    var nameY = this.boardY - this.cellSize * 0.13;
    var fontSize = Math.max(THEME.font.minPx.name, this.cellSize * THEME.font.cellScale.name);
    ctx.fillStyle = playerState.playerColor || THEME.color.text.white;
    ctx.font = '700 ' + fontSize + 'px ' + getDisplayFont();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(name, this.boardX + this.cellSize * 0.07, nameY - this.cellSize * 0.07);

    var lvlSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label);
    ctx.font = '700 ' + lvlSize + 'px ' + getDisplayFont();
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    var lines = playerState.lines || 0;
    var level = playerState.level || 1;
    ctx.fillText(t('hex_lines_level', { lines: lines, level: level }), this.boardX + this.boardWidth - this.cellSize * 0.07, nameY - this.cellSize * 0.07);
  }

  _drawPanel(x, y, w, h) {
    var ctx = this.ctx;
    var r = THEME.radius.panel(this.cellSize);
    var rgb = this._accentRgb;
    ctx.fillStyle = THEME.color.bg.board;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    if (rgb) {
      ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.tint + ')';
      roundRect(ctx, x, y, w, h, r);
      ctx.fill();
    }
    ctx.strokeStyle = rgb
      ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.soft + ')'
      : 'rgba(255,255,255,' + THEME.opacity.subtle + ')';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();
  }

  drawHoldPanel(playerState) {
    var ctx = this.ctx;
    var panelY = this.boardY;
    var labelSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label);
    var boxSize = this.miniSize * THEME.size.panelWidth;
    var panelX = this.boardX - this.panelGap - boxSize;

    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.font = '700 ' + labelSize + 'px ' + getDisplayFont();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText(t('hold'), panelX + boxSize / 2, panelY, boxSize);
    ctx.letterSpacing = '0px';

    var boxY = panelY + labelSize + this.cellSize * 0.2;
    this._drawPanel(panelX, boxY, boxSize, boxSize);

    if (playerState.holdPiece) {
      this.drawHexMiniPiece(panelX + boxSize / 2, boxY + boxSize / 2, playerState.holdPiece, this.miniSize);
    }
  }

  drawNextPanel(playerState) {
    var ctx = this.ctx;
    var panelX = this.boardX + this.boardWidth + this.panelGap;
    var panelY = this.boardY;
    var labelSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label);
    var boxWidth = this.miniSize * THEME.size.panelWidth;
    var pieceSpacing = this.miniSize * 3;
    var startY = panelY + labelSize + this.cellSize * 0.2;

    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.font = '700 ' + labelSize + 'px ' + getDisplayFont();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText(t('next'), panelX + boxWidth / 2, panelY, boxWidth);
    ctx.letterSpacing = '0px';

    var nextCount = playerState.nextPieces ? Math.min(playerState.nextPieces.length, 3) : 0;
    var boxHeight = pieceSpacing * Math.max(nextCount, 3);
    this._drawPanel(panelX, startY, boxWidth, boxHeight);

    if (playerState.nextPieces) {
      for (var i = 0; i < Math.min(playerState.nextPieces.length, 3); i++) {
        var py = startY + i * pieceSpacing + pieceSpacing / 2;
        var alpha = i === 0 ? 1.0 : 0.7 - i * 0.06;
        ctx.globalAlpha = alpha;
        this.drawHexMiniPiece(panelX + boxWidth / 2, py, playerState.nextPieces[i], this.miniSize);
        ctx.globalAlpha = 1.0;
      }
    }
  }

  drawGarbageMeter(pendingGarbage) {
    var hs = this._hexSize;
    var sCell = hs * (1 - THEME.size.blockGap * 2);
    var maxLines = HexConstants.HEX_VISIBLE_ROWS;
    var lines = Math.min(pendingGarbage, maxLines);

    for (var row = 0; row < lines; row++) {
      for (var cell = 0; cell < 2; cell++) {
        var pos = this._getMeterPos(row, cell);
        this._drawMeterHex(pos.x, pos.y, sCell, '#808080', null);
      }
    }
  }

  // Helper: draw a hex at a meter cell position
  _drawMeterHex(cx, cy, sCell, fill, alpha) {
    var ctx = this.ctx;
    if (alpha != null) ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (var v = 0; v < 6; v++) {
      var a = Math.PI / 3 * v;
      var hx = cx + sCell * Math.cos(a);
      var hy = cy + sCell * Math.sin(a);
      v === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (alpha != null) ctx.globalAlpha = 1.0;
  }

  // Get meter hex center for a given garbage row index and cell index (0 or 1)
  _getMeterPos(garbageRow, cell) {
    var hs = this._hexSize;
    var hexH = this._hexH;
    var colW = this._colW;
    var evenX = this.boardX - colW - hs * 0.4;
    var oddX = evenX + colW;
    var row = HexConstants.HEX_VISIBLE_ROWS - 1 - garbageRow;
    return {
      x: cell ? oddX : evenX,
      y: this.boardY + hexH * (row + 0.5 * cell) + hexH / 2
    };
  }

  _drawGarbageEffects(effects, timestamp, getColor) {
    if (!Array.isArray(effects) || effects.length === 0) return;
    var hs = this._hexSize;
    var sCell = hs * (1 - THEME.size.blockGap * 2);
    var now = timestamp || performance.now();

    for (var ei = 0; ei < effects.length; ei++) {
      var effect = effects[ei];
      var elapsed = now - effect.startTime;
      if (elapsed < 0 || elapsed >= effect.duration) continue;
      var alpha = (1 - elapsed / effect.duration) * (effect.maxAlpha || 0.9);
      var color = getColor(effect);

      for (var row = effect.rowStart; row < effect.rowStart + effect.lines; row++) {
        if (row < 0 || row >= HexConstants.HEX_VISIBLE_ROWS) continue;
        for (var cell = 0; cell < 2; cell++) {
          var pos = this._getMeterPos(row, cell);
          this._drawMeterHex(pos.x, pos.y, sCell, color, alpha);
        }
      }
    }
  }

  drawGarbageIndicatorEffects(effects, timestamp) {
    this._drawGarbageEffects(effects, timestamp, function(e) { return e.color; });
  }

  drawGarbageDefenceEffects(effects, timestamp) {
    this._drawGarbageEffects(effects, timestamp, function() { return THEME.color.text.white; });
  }

  // Trace the hex board outline as a closed path (matching the zigzag walls)
  _boardOutlinePath() {
    HexConstants.traceHexOutline(
      this.ctx, this.boardX, this.boardY,
      this._hexSize, this._hexH, this._colW,
      HexConstants.HEX_COLS, HexConstants.HEX_VISIBLE_ROWS
    );
  }

  drawDisconnectedOverlay(qrImg, playerColor) {
    var ctx = this.ctx;
    var bx = this.boardX, by = this.boardY, bw = this.boardWidth, bh = this.boardHeight;
    ctx.fillStyle = 'rgba(0, 0, 0, ' + THEME.opacity.overlay + ')';
    this._boardOutlinePath();
    ctx.fill();
    var labelSize = Math.max(10, this.cellSize * THEME.font.cellScale.name);
    var labelGap = labelSize * 1.2;
    var qrSize = Math.min(bw, bh) * 0.5;
    var qrRadius = qrSize * 0.08;
    var pad = qrSize * 0.06;
    var outerSize = qrSize + pad * 2;
    var totalH = outerSize + labelGap + labelSize;
    var groupY = by + (bh - totalH) / 2;
    var outerX = bx + (bw - outerSize) / 2;
    ctx.fillStyle = THEME.color.text.white;
    ctx.beginPath(); ctx.roundRect(outerX, groupY, outerSize, outerSize, qrRadius); ctx.fill();
    ctx.strokeStyle = 'rgba(0, 200, 255, 0.15)'; ctx.lineWidth = 1; ctx.stroke();
    if (qrImg) {
      ctx.save();
      ctx.beginPath(); ctx.roundRect(outerX + pad, groupY + pad, qrSize, qrSize, Math.max(1, qrRadius - pad)); ctx.clip();
      ctx.drawImage(qrImg, outerX + pad, groupY + pad, qrSize, qrSize);
      ctx.restore();
    }
    ctx.fillStyle = playerColor || 'rgba(0, 200, 255, 0.7)';
    ctx.font = '600 ' + labelSize + 'px ' + getDisplayFont();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.letterSpacing = '0.1em';
    ctx.fillText(t('scan_to_rejoin'), bx + bw / 2, groupY + outerSize + labelGap, bw);
    ctx.letterSpacing = '0px';
  }

  drawKOOverlay() {
    var ctx = this.ctx;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    this._boardOutlinePath();
    ctx.fill();
    var fontSize = Math.max(20, this.cellSize * 2);
    ctx.fillStyle = '#ff4444';
    ctx.font = '900 ' + fontSize + 'px ' + getDisplayFont();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('ko'), this.boardX + this.boardWidth / 2, this.boardY + this.boardHeight / 2);
  }

  // Draw a flat-top hex mini piece in hold/next panels
  drawHexMiniPiece(centerX, centerY, pieceType, size) {
    var bounds = HEX_MINI_BOUNDS[pieceType];
    if (!bounds) return;
    var typeId = HEX_TYPE_TO_ID[pieceType];
    var isNeon = this._styleTier === STYLE_TIERS.NEON_FLAT;
    var color = (isNeon ? NEON_PIECE_COLORS[typeId] : PIECE_COLORS[typeId]) || '#ffffff';

    var hexS = size * 0.45;
    var drawS = hexS * (1 - THEME.size.blockGap * 2);  // proportional gap matching square mode
    var hexH = Math.sqrt(3) * hexS;   // height of flat-top hex (layout spacing)
    var colW = 1.5 * hexS;            // column spacing
    var cols = bounds.maxC - bounds.minC + 1;
    var rows = bounds.maxR - bounds.minR + 1;
    var totalW = colW * (cols - 1) + 2 * hexS;
    // Total height: row spacing * (rows-1) + hex height + half hex for odd col stagger
    var totalH = hexH * rows + hexH * 0.5;
    var ox = centerX - totalW / 2;
    var oy = centerY - totalH / 2;

    var ctx = this.ctx;
    for (var i = 0; i < bounds.offsets.length; i++) {
      var o = bounds.offsets[i];
      var px = ox + colW * (o.col - bounds.minC) + hexS;
      var py = oy + hexH * (o.row - bounds.minR + 0.5 * (o.col & 1)) + hexH / 2;

      // Mini hex with gradient (matches square mode mini blocks)
      ctx.save();
      ctx.beginPath();
      for (var v = 0; v < 6; v++) {
        var a = Math.PI / 3 * v;
        var hx = px + drawS * Math.cos(a);
        var hy = py + drawS * Math.sin(a);
        v === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy);
      }
      ctx.closePath();
      ctx.clip();
      var mg = ctx.createLinearGradient(px, py - drawS, px, py + drawS);
      mg.addColorStop(0, color);
      mg.addColorStop(1, darkenColor(color, 15));
      ctx.fillStyle = mg;
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,' + THEME.opacity.highlight + ')';
      ctx.fillRect(px - drawS * 0.5, py - drawS * 0.88, drawS, drawS * 0.1);
      ctx.restore();
    }
  }
}
