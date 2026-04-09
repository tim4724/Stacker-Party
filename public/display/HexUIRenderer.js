'use strict';

// HexUIRenderer: hex-specific rendering for garbage meter, KO overlay,
// disconnected overlay, and mini hex pieces. Inherits shared panel/label
// rendering from BaseUIRenderer.

var HEX_MINI_PIECES = HexPieceModule.HEX_PIECES;
var HEX_TYPE_TO_ID = HexConstants.HEX_PIECE_TYPE_TO_ID;
var _getIndicatorColor = function(e) { return e.color; };
var _getDefenceColor = function() { return THEME.color.text.white; };

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
    // Pre-compute stable meter/cell values
    this._sCell = geo.hexSize - cellSize * THEME.size.blockGap * 2 / _SQRT3;
    this._gridLineWidth = _SQRT3 * this._sCell * THEME.stroke.grid;
    this._meterX = boardX - cellSize * 1.07;
  }

  drawGarbageMeter(pendingGarbage) {
    var sCell = this._sCell;
    var lines = Math.min(pendingGarbage, HexConstants.HEX_VISIBLE_ROWS);
    if (lines === 0) return;

    var ctx = this.ctx;
    var mx = this._meterX;
    var hexH = this._hexH;
    var baseY = this.boardY;

    // Single-pass: build compound path, then stroke + fill
    ctx.beginPath();
    for (var i = 0; i < lines; i++) {
      var row = HexConstants.HEX_VISIBLE_ROWS - 1 - i;
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

  _drawGarbageEffects(effects, timestamp, getColor) {
    if (!Array.isArray(effects) || effects.length === 0) return;
    var sCell = this._sCell;
    var ctx = this.ctx;
    var mx = this._meterX;
    var hexH = this._hexH;
    var baseY = this.boardY;
    var now = timestamp || performance.now();

    try {
      for (var ei = 0; ei < effects.length; ei++) {
        var effect = effects[ei];
        var elapsed = now - effect.startTime;
        if (elapsed < 0 || elapsed >= effect.duration) continue;
        ctx.globalAlpha = (1 - elapsed / effect.duration) * (effect.maxAlpha || 0.9);
        ctx.fillStyle = getColor(effect);

        // Batch all rows of this effect into one fill call
        ctx.beginPath();
        for (var row = effect.rowStart; row < effect.rowStart + effect.lines; row++) {
          if (row < 0 || row >= HexConstants.HEX_VISIBLE_ROWS) continue;
          var visRow = HexConstants.HEX_VISIBLE_ROWS - 1 - row;
          var cy = baseY + hexH * visRow + hexH / 2;
          ctx.moveTo(mx + sCell * HEX_UNIT_VERTICES[0], cy + sCell * HEX_UNIT_VERTICES[1]);
          for (var vi = 2; vi < 12; vi += 2) {
            ctx.lineTo(mx + sCell * HEX_UNIT_VERTICES[vi], cy + sCell * HEX_UNIT_VERTICES[vi + 1]);
          }
          ctx.closePath();
        }
        ctx.fill();
      }
    } finally {
      ctx.globalAlpha = 1.0;
    }
  }

  drawGarbageIndicatorEffects(effects, timestamp) {
    this._drawGarbageEffects(effects, timestamp, _getIndicatorColor);
  }

  drawGarbageDefenceEffects(effects, timestamp) {
    this._drawGarbageEffects(effects, timestamp, _getDefenceColor);
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
    var hexH = _SQRT3 * hexS;   // height of flat-top hex (layout spacing)
    var colW = 1.5 * hexS;            // column spacing
    var cols = bounds.maxC - bounds.minC + 1;
    var rows = bounds.maxR - bounds.minR + 1;
    var totalW = colW * (cols - 1) + 2 * hexS;
    // Total height: row spacing * (rows-1) + hex height + half hex for odd col stagger
    var totalH = hexH * rows + hexH * 0.5;
    var ox = centerX - totalW / 2;
    var oy = centerY - totalH / 2;

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

window.HexUIRenderer = HexUIRenderer;
