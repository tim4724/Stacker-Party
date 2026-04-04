'use strict';

// HexUIRenderer: hex-specific rendering for garbage meter, KO overlay,
// disconnected overlay, and mini hex pieces. Inherits shared panel/label
// rendering from BaseUIRenderer.

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

class HexUIRenderer extends BaseUIRenderer {
  constructor(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex) {
    super(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex);

    // Hex geometry (shared with HexBoardRenderer and DisplayUI)
    var geo = HexConstants.computeHexGeometry(HexConstants.HEX_COLS, HexConstants.HEX_VISIBLE_ROWS, cellSize);
    this._hexSize = geo.hexSize;
    this._hexH = geo.hexH;
    this._colW = geo.colW;
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
    hexPath(ctx, cx, cy, sCell);
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
    var isNeon = this._styleTier === STYLE_TIERS.NEON_FLAT;
    var color = (isNeon ? NEON_PIECE_COLORS[typeId] : PIECE_COLORS[typeId]) || '#ffffff';

    var hexS = size * 0.45;
    var drawS = hexS * (1 - THEME.size.blockGap * 2);
    var hexH = Math.sqrt(3) * hexS;   // height of flat-top hex (layout spacing)
    var colW = 1.5 * hexS;            // column spacing
    var cols = bounds.maxC - bounds.minC + 1;
    var rows = bounds.maxR - bounds.minR + 1;
    var totalW = colW * (cols - 1) + 2 * hexS;
    // Total height: row spacing * (rows-1) + hex height + half hex for odd col stagger
    var totalH = hexH * rows + hexH * 0.5;
    var ox = centerX - totalW / 2;
    var oy = centerY - totalH / 2;

    var stamp = getMiniHexStamp(this._styleTier, color, drawS);
    var ctx = this.ctx;
    for (var i = 0; i < bounds.offsets.length; i++) {
      var o = bounds.offsets[i];
      var px = ox + colW * (o.col - bounds.minC) + hexS;
      var py = oy + hexH * (o.row - bounds.minR + 0.5 * (o.col & 1)) + hexH / 2;
      ctx.drawImage(stamp, px - drawS - 1, py - stamp.height / 2);
    }
  }
}

window.HexUIRenderer = HexUIRenderer;
