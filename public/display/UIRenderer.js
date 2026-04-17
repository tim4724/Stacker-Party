'use strict';

// UIRenderer: rendering for hold/next panels, level/lines, player name,
// panel backgrounds, garbage meter, KO overlay, disconnected overlay, and
// mini hex pieces.

var HEX_MINI_PIECES = PieceModule.PIECES;
var HEX_TYPE_TO_ID = GameConstants.PIECE_TYPE_TO_ID;
var _getIndicatorColor = function(e) { return e.color; };
var _getDefenceColor = function() { return THEME.color.text.white; };

// Disconnected-overlay fallback tints (used when a player color is not
// provided). Derived once from the theme secondary-accent token so the
// canvas renderer stays in sync with CSS.
var _DISCONNECT_TEXT_FALLBACK = rgbaFromHex(THEME.color.accent.secondary, 0.7);
var _DISCONNECT_QR_BORDER = rgbaFromHex(THEME.color.accent.secondary, 0.15);

// Compute bounding boxes for flat-top hex mini pieces using odd-q offset conversion.
var HEX_MINI_BOUNDS = {};
(function() {
  for (var type in HEX_MINI_PIECES) {
    var cells = HEX_MINI_PIECES[type];
    var offsets = cells.map(function(c) {
      return PieceModule.axialToOffset(c[0], c[1]);
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
    // True vertical midpoint (hexH units, relative to oy) — accounts for the
    // half-hex stagger on a per-cell basis so q/p/L/J (odd-column cells on
    // the max-row side) don't sit ¼ hex below the slot center.
    var vMin = Infinity, vMax = -Infinity;
    for (var k = 0; k < shifted.length; k++) {
      var yu = shifted[k].row + 0.5 * (shifted[k].col & 1);
      if (yu < vMin) vMin = yu;
      if (yu > vMax) vMax = yu;
    }
    HEX_MINI_BOUNDS[type] = {
      minC: sMinC, maxC: sMaxC, minR: sMinR, maxR: sMaxR,
      offsets: shifted,
      visMidUnits: (vMin + vMax + 1) / 2,
    };
  }
})();

// L and J pieces occupy 3 offset rows in default orientation, so each
// next-slot needs extra vertical room. 3.5 * miniSize gives a comfortable
// gap without shrinking the pieces.
var NEXT_PIECE_SPACING_UNITS = 3.5;

class UIRenderer {
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

    // Cached rgba strings for panel drawing
    var rgb = this._accentRgb;
    this._panelTintFill = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.tint + ')' : null;
    this._panelStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.soft + ')' : 'rgba(255, 255, 255, ' + THEME.opacity.tint + ')';

    // Cached font strings
    this._updateCachedFonts();

    // Hex geometry (shared with BoardRenderer and DisplayUI)
    var geo = GameConstants.computeHexGeometry(GameConstants.COLS, GameConstants.VISIBLE_ROWS, cellSize);
    this._hexSize = geo.hexSize;
    this._hexH = geo.hexH;
    this._colW = geo.colW;
    // Pre-compute stable meter/cell values
    this._sCell = geo.hexSize - cellSize * THEME.size.blockGap * 2 / _SQRT3;
    this._gridLineWidth = _SQRT3 * this._sCell * THEME.stroke.grid;
    this._meterX = boardX - cellSize * 1.07;
  }

  _updateCachedFonts() {
    var font = getDisplayFont();
    var labelSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label);
    var valueSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label * 1.3);
    this._labelSize = labelSize;
    this._valueSize = valueSize;
    this._rowHeight = labelSize + valueSize + this.cellSize * 0.4;
    this._fontName = '700 ' + Math.max(THEME.font.minPx.name, this.cellSize * THEME.font.cellScale.name) + 'px ' + font;
    this._fontLabel = '700 ' + labelSize + 'px ' + font;
    this._fontValue = '700 ' + valueSize + 'px ' + font;
    this._fontKO = '900 ' + Math.max(20, this.cellSize * 2) + 'px ' + font;
    this._fontDisconnect = '600 ' + Math.max(10, this.cellSize * THEME.font.cellScale.name) + 'px ' + font;
    this._cachedFontFamily = font;
  }

  render(playerState, timestamp) {
    this._styleTier = getStyleTier(playerState.level || 1);
    if (getDisplayFont() !== this._cachedFontFamily) this._updateCachedFonts();
    var nextLayout = this._nextPanelLayout(playerState);
    this.drawPlayerName(playerState);
    this.drawHoldPanel(playerState);
    this.drawNextPanel(playerState, nextLayout);
    this.drawLevelLines(playerState, nextLayout);
    if (playerState.pendingGarbage > 0) {
      this.drawGarbageMeter(playerState.pendingGarbage);
    }
    if (playerState.garbageIndicatorEffects && playerState.garbageIndicatorEffects.length > 0) {
      this.drawGarbageIndicatorEffects(playerState.garbageIndicatorEffects, timestamp);
    }
    if (playerState.garbageDefenceEffects && playerState.garbageDefenceEffects.length > 0) {
      this.drawGarbageDefenceEffects(playerState.garbageDefenceEffects, timestamp);
    }
    if (playerState.alive === false) {
      this.drawKOOverlay();
    }
  }

  drawPlayerName(playerState) {
    var ctx = this.ctx;
    var name = playerState.playerName || PLAYER_NAMES[this.playerIndex] || ('Player ' + (this.playerIndex + 1));
    var nameY = this.boardY - this.cellSize * 0.13;
    ctx.fillStyle = playerState.playerColor || THEME.color.text.white;
    ctx.font = this._fontName;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(name, this.boardX + this.cellSize * 0.07, nameY - this.cellSize * 0.07);
  }

  drawHoldPanel(playerState) {
    var ctx = this.ctx;
    var panelY = this.boardY;
    var boxSize = this.miniSize * THEME.size.panelWidth;
    var panelX = this.boardX - this.panelGap - boxSize;

    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.font = this._fontLabel;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText(t('hold'), panelX + boxSize / 2, panelY, boxSize);
    ctx.letterSpacing = '0px';

    var boxY = panelY + this._labelSize + this.cellSize * 0.2;
    this._drawPanel(panelX, boxY, boxSize, boxSize);

    if (playerState.holdPiece) {
      this.drawMiniPiece(panelX + boxSize / 2, boxY + boxSize / 2, playerState.holdPiece, this.miniSize);
    }
  }

  _nextPanelLayout(playerState) {
    var nextCount = playerState.nextPieces ? Math.min(playerState.nextPieces.length, 3) : 0;
    if (this._cachedNextLayout && this._cachedNextCount === nextCount) return this._cachedNextLayout;
    var pieceSpacing = this.miniSize * NEXT_PIECE_SPACING_UNITS;
    var startY = this.boardY + this._labelSize + this.cellSize * 0.2;
    // 3 = minimum visible slot count
    var boxHeight = pieceSpacing * Math.max(nextCount, 3);
    this._cachedNextCount = nextCount;
    this._cachedNextLayout = { startY: startY, boxHeight: boxHeight, pieceSpacing: pieceSpacing };
    return this._cachedNextLayout;
  }

  drawNextPanel(playerState, layout) {
    var ctx = this.ctx;
    var panelX = this.boardX + this.boardWidth + this.panelGap;
    var panelY = this.boardY;
    var boxWidth = this.miniSize * THEME.size.panelWidth;

    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.font = this._fontLabel;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText(t('next'), panelX + boxWidth / 2, panelY, boxWidth);
    ctx.letterSpacing = '0px';

    this._drawPanel(panelX, layout.startY, boxWidth, layout.boxHeight);

    if (playerState.nextPieces) {
      for (var i = 0; i < Math.min(playerState.nextPieces.length, 3); i++) {
        var py = layout.startY + i * layout.pieceSpacing + layout.pieceSpacing / 2;
        var alpha = i === 0 ? 1.0 : 0.7 - i * 0.06;
        ctx.globalAlpha = alpha;
        this.drawMiniPiece(panelX + boxWidth / 2, py, playerState.nextPieces[i], this.miniSize);
        ctx.globalAlpha = 1.0;
      }
    }
  }

  drawLevelLines(playerState, layout) {
    var ctx = this.ctx;
    var panelX = this.boardX + this.boardWidth + this.panelGap;
    var belowNextY = layout.startY + layout.boxHeight + this.cellSize * 0.5;

    var lines = playerState.lines || 0;
    var level = playerState.level || 1;
    var lvlSize = this._labelSize;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // Level row
    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.letterSpacing = '0.15em';
    ctx.font = this._fontLabel;
    ctx.fillText(t('level'), panelX, belowNextY);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = THEME.color.text.white;
    ctx.font = this._fontValue;
    ctx.fillText('' + level, panelX, belowNextY + lvlSize + this.cellSize * 0.1);

    // Lines row
    var linesY = belowNextY + this._rowHeight;
    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.letterSpacing = '0.15em';
    ctx.font = this._fontLabel;
    ctx.fillText(t('lines'), panelX, linesY);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = THEME.color.text.white;
    ctx.font = this._fontValue;
    ctx.fillText('' + lines, panelX, linesY + lvlSize + this.cellSize * 0.1);
  }

  drawKOOverlay() {
    var ctx = this.ctx;
    ctx.save();
    this._clipBoardArea();
    this._fillBoardArea('rgba(30, 0, 0, 0.6)');
    ctx.fillStyle = '#cc2222';
    ctx.font = this._fontKO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('ko'), this.boardX + this.boardWidth / 2, this.boardY + this.boardHeight / 2);
    ctx.restore();
  }

  drawDisconnectedOverlay(qrImg, playerColor) {
    var ctx = this.ctx;
    var bx = this.boardX, by = this.boardY, bw = this.boardWidth, bh = this.boardHeight;

    this._fillBoardArea('rgba(0, 0, 0, ' + THEME.opacity.overlay + ')');

    ctx.fillStyle = playerColor || _DISCONNECT_TEXT_FALLBACK;
    ctx.font = this._fontDisconnect;
    ctx.textAlign = 'center';
    ctx.letterSpacing = '0.1em';

    if (!qrImg) {
      ctx.textBaseline = 'middle';
      ctx.fillText(t('disconnected'), bx + bw / 2, by + bh / 2, bw * 0.9);
      ctx.letterSpacing = '0px';
      return;
    }

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
    ctx.beginPath();
    ctx.roundRect(outerX, groupY, outerSize, outerSize, qrRadius);
    ctx.fill();

    ctx.strokeStyle = _DISCONNECT_QR_BORDER;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(outerX + pad, groupY + pad, qrSize, qrSize, Math.max(1, qrRadius - pad));
    ctx.clip();
    ctx.drawImage(qrImg, outerX + pad, groupY + pad, qrSize, qrSize);
    ctx.restore();

    ctx.fillStyle = playerColor || _DISCONNECT_TEXT_FALLBACK;
    ctx.font = this._fontDisconnect;
    ctx.textBaseline = 'top';
    ctx.fillText(t('scan_to_rejoin'), bx + bw / 2, groupY + outerSize + labelGap, bw * 0.9);
    ctx.letterSpacing = '0px';
  }

  // Flat panel recipe — mirrors the HTML card primitive:
  //   top-to-bottom gradient + inset top bevel + thin player-tinted stroke.
  _drawPanel(x, y, w, h) {
    var ctx = this.ctx;
    var r = THEME.radius.panel(this.cellSize);
    var cellSize = this.cellSize;

    // 1. Gradient fill + optional player-color wash — same path, re-fill
    //    with the tint fillStyle after the gradient. fill() doesn't consume
    //    the current path, so the second fill reuses it.
    var gradient = ctx.createLinearGradient(x, y, x, y + h);
    gradient.addColorStop(0, THEME.color.bg.cardSoft);
    gradient.addColorStop(1, THEME.color.bg.card);
    ctx.beginPath();
    _addRoundRectSubPath(ctx, x, y, w, h, r);
    ctx.fillStyle = gradient;
    ctx.fill();
    if (this._panelTintFill) {
      ctx.fillStyle = this._panelTintFill;
      ctx.fill();
    }

    // 3. Inset top bevel — thin bright horizontal line just inside the top rim.
    ctx.save();
    ctx.beginPath();
    _addRoundRectSubPath(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = Math.max(1, cellSize * 0.03);
    ctx.beginPath();
    var bevelInset = Math.max(1, cellSize * 0.015);
    ctx.moveTo(x + r * 0.5, y + bevelInset);
    ctx.lineTo(x + w - r * 0.5, y + bevelInset);
    ctx.stroke();
    ctx.restore();

    // 4. Thin player-tinted rim stroke for identity.
    ctx.save();
    ctx.strokeStyle = this._panelStroke;
    ctx.lineWidth = Math.max(1, cellSize * THEME.stroke.border * 0.6);
    ctx.beginPath();
    _addRoundRectSubPath(ctx, x, y, w, h, r);
    ctx.stroke();
    ctx.restore();
  }

  drawGarbageMeter(pendingGarbage) {
    var sCell = this._sCell;
    var lines = Math.min(pendingGarbage, GameConstants.VISIBLE_ROWS);
    if (lines === 0) return;

    var ctx = this.ctx;
    var mx = this._meterX;
    var hexH = this._hexH;
    var baseY = this.boardY;

    // Single-pass: build compound path, then stroke + fill
    ctx.beginPath();
    for (var i = 0; i < lines; i++) {
      var row = GameConstants.VISIBLE_ROWS - 1 - i;
      var cy = baseY + hexH * row + hexH / 2;
      ctx.moveTo(mx + sCell * HEX_UNIT_VERTICES[0], cy + sCell * HEX_UNIT_VERTICES[1]);
      for (var vi = 2; vi < 12; vi += 2) {
        ctx.lineTo(mx + sCell * HEX_UNIT_VERTICES[vi], cy + sCell * HEX_UNIT_VERTICES[vi + 1]);
      }
      ctx.closePath();
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.lineWidth = this._gridLineWidth;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.muted + ')';
    ctx.fill();
  }

  _drawGarbageEffects(effects, timestamp, getColor, highlightAlpha) {
    if (!Array.isArray(effects) || effects.length === 0) return;
    if (highlightAlpha == null) highlightAlpha = 0;
    var sCell = this._sCell;
    var ctx = this.ctx;
    var mx = this._meterX;
    var hexH = this._hexH;
    var baseY = this.boardY;
    var now = timestamp || performance.now();

    // Highlight stripe sized/positioned to match a top-edge bevel, anchored
    // to the hex's flat-top vertex (hCy - sCell*√3/2) rather than the cell
    // boundary so it stays inside the drawn hex if gap constants change.
    var stripeInset = sCell * 0.05;
    var stripeH = sCell * 0.06;
    var halfStripeW = sCell / 2;
    var topEdgeOffset = sCell * _SQRT3 / 2;

    try {
      for (var ei = 0; ei < effects.length; ei++) {
        var effect = effects[ei];
        var elapsed = now - effect.startTime;
        if (elapsed < 0 || elapsed >= effect.duration) continue;
        ctx.globalAlpha = (1 - elapsed / effect.duration) * (effect.maxAlpha || 0.9);
        ctx.fillStyle = getColor(effect);

        // Batch all rows of this effect into one fill call.
        // `effect.rowStart` is already in top-down grid coords (row 0 = top of
        // board) per DisplayGame.onGarbageCancelled, so use `row` directly —
        // matching drawGarbageMeter, which positions cells via the same
        // top-down row index.
        ctx.beginPath();
        for (var row = effect.rowStart; row < effect.rowStart + effect.lines; row++) {
          if (row < 0 || row >= GameConstants.VISIBLE_ROWS) continue;
          var cy = baseY + hexH * row + hexH / 2;
          ctx.moveTo(mx + sCell * HEX_UNIT_VERTICES[0], cy + sCell * HEX_UNIT_VERTICES[1]);
          for (var vi = 2; vi < 12; vi += 2) {
            ctx.lineTo(mx + sCell * HEX_UNIT_VERTICES[vi], cy + sCell * HEX_UNIT_VERTICES[vi + 1]);
          }
          ctx.closePath();
        }
        ctx.fill();

        // Batched highlight stripe along each hex's top flat edge
        ctx.fillStyle = 'rgba(255, 255, 255, ' + highlightAlpha + ')';
        for (var hRow = effect.rowStart; hRow < effect.rowStart + effect.lines; hRow++) {
          if (hRow < 0 || hRow >= GameConstants.VISIBLE_ROWS) continue;
          var hCy = baseY + hexH * hRow + hexH / 2;
          var topY = hCy - topEdgeOffset + stripeInset;
          ctx.fillRect(mx - halfStripeW, topY, sCell, stripeH);
        }
      }
    } finally {
      ctx.globalAlpha = 1.0;
    }
  }

  drawGarbageIndicatorEffects(effects, timestamp) {
    this._drawGarbageEffects(effects, timestamp, _getIndicatorColor, 0.2);
  }

  drawGarbageDefenceEffects(effects, timestamp) {
    this._drawGarbageEffects(effects, timestamp, _getDefenceColor, 0.3);
  }

  // Trace the hex board outline as a closed path (matching the zigzag walls)
  _boardOutlinePath() {
    GameConstants.traceHexOutline(
      this.ctx, this.boardX, this.boardY,
      this._hexSize, this._hexH, this._colW,
      GameConstants.COLS, GameConstants.VISIBLE_ROWS
    );
  }

  _fillBoardArea(color) {
    this.ctx.fillStyle = color;
    this._boardOutlinePath();
    this.ctx.fill();
  }

  _clipBoardArea() {
    this._boardOutlinePath();
    this.ctx.clip();
  }

  // Draw a flat-top hex mini piece in hold/next panels
  drawMiniPiece(centerX, centerY, pieceType, size) {
    var bounds = HEX_MINI_BOUNDS[pieceType];
    if (!bounds) return;
    var typeId = HEX_TYPE_TO_ID[pieceType];
    var color = PIECE_COLORS[typeId] || '#ffffff';

    var hexS = size * 0.58;
    var drawS = hexS * (1 - THEME.size.blockGap * 2);
    var hexH = _SQRT3 * hexS;   // height of flat-top hex (layout spacing)
    var colW = 1.5 * hexS;            // column spacing
    var cols = bounds.maxC - bounds.minC + 1;
    var totalW = colW * (cols - 1) + 2 * hexS;
    var ox = centerX - totalW / 2;
    // Center on the piece's true visual midpoint (cell center-of-bounds in
    // hexH units), not a bounding-box approximation — the stagger shifts
    // some pieces' visual mass off-center otherwise.
    var oy = centerY - hexH * bounds.visMidUnits;

    var stamp = getHexStamp(this._styleTier, color, _SQRT3 * drawS);
    var ctx = this.ctx;
    for (var i = 0; i < bounds.offsets.length; i++) {
      var o = bounds.offsets[i];
      var px = ox + colW * (o.col - bounds.minC) + hexS;
      var py = oy + hexH * (o.row - bounds.minR + 0.5 * (o.col & 1)) + hexH / 2;
      ctx.drawImage(stamp, px - stamp.cssW / 2, py - stamp.cssH / 2, stamp.cssW, stamp.cssH);
    }
  }
}

window.UIRenderer = UIRenderer;
