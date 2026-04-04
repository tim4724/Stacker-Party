'use strict';

// HexBoardRenderer: renders a flat-top hex grid board on canvas.
// Same interface as BoardRenderer but with flat-top hex orientation.
// Columns are vertically aligned (no zigzag on horizontal movement).

var HEX_VIS_ROWS = HexConstants.HEX_VISIBLE_ROWS;
var HEX_COLS_N = HexConstants.HEX_COLS;


class HexBoardRenderer {
  constructor(ctx, x, y, cellSize, playerIndex) {
    this.ctx = ctx;
    this.x = x;
    this.y = y;
    this.cellSize = cellSize;
    this.playerIndex = playerIndex;
    this.accentColor = PLAYER_COLORS[playerIndex] || PLAYER_COLORS[0];
    this._accentRgb = hexToRgb(this.accentColor);
    this._styleTier = STYLE_TIERS.NORMAL;

    var geo = HexConstants.computeHexGeometry(HEX_COLS_N, HEX_VIS_ROWS, cellSize);
    this.hexSize = geo.hexSize;
    this.hexH = geo.hexH;
    this.colW = geo.colW;
    this.boardWidth = geo.boardWidth;
    this.boardHeight = geo.boardHeight;
    this._prevGhostKey = null;
    this._cachedPreviewCells = [];

    // Cached rgba strings (stable between layout recalculations)
    var rgb = this._accentRgb;
    this._tintFill = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.tint + ')' : null;
    this._gridStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.grid + ')' : 'rgba(255,255,255,' + THEME.opacity.grid + ')';
    this._wallStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.strong + ')' : 'rgba(255,255,255,' + THEME.opacity.soft + ')';
  }

  get styleTier() { return this._styleTier; }
  get hexW() { return 2 * this.hexSize; }

  // Pixel center of hex at (col, row) in visible coordinates
  _hexCenter(col, row) {
    return {
      x: this.x + this.colW * col + this.hexSize,
      y: this.y + this.hexH * (row + 0.5 * (col & 1)) + this.hexH / 2
    };
  }

  _hexPath(cx, cy, size) {
    hexPath(this.ctx, cx, cy, size);
  }

  _drawHex(cx, cy, size, fill, stroke, alpha) {
    var ctx = this.ctx;
    this._hexPath(cx, cy, size);
    if (fill) {
      if (alpha != null) ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fill();
      if (alpha != null) ctx.globalAlpha = 1;
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  _drawFilledHex(cx, cy, size, color) {
    var stamp = getHexStamp(this._styleTier, color, size);
    this.ctx.drawImage(stamp, cx - size - 1, cy - stamp.height / 2);
  }

  render(playerState, timestamp) {
    var ctx = this.ctx;
    var hs = this.hexSize;
    var newTier = getStyleTier(playerState.level || 1);
    this._styleTier = newTier;
    var isNeon = newTier === STYLE_TIERS.NEON_FLAT;
    var colors = isNeon ? NEON_PIECE_COLORS : PIECE_COLORS;
    var ghostColors = isNeon ? NEON_GHOST_COLORS : GHOST_COLORS;

    var sCell = hs * (1 - THEME.size.blockGap * 2);

    // Grid cells — split into three passes to batch canvas state changes:
    // Pass 1: fill empty cells (bg + tint), draw filled cells via stamp
    // Pass 2: stroke grid lines for empty cells (single compound path)
    if (playerState.grid) {
      var gridRows = playerState.grid.length;
      // Pass 1: fills + stamps
      for (var r = 0; r < gridRows; r++) {
        var row = playerState.grid[r];
        for (var c = 0; c < row.length; c++) {
          var pos = this._hexCenter(c, r);
          if (row[c] > 0) {
            this._drawFilledHex(pos.x, pos.y, sCell, colors[row[c]]);
          } else {
            hexPath(ctx, pos.x, pos.y, sCell);
            ctx.fillStyle = THEME.color.bg.board;
            ctx.fill();
            if (this._tintFill) {
              ctx.fillStyle = this._tintFill;
              ctx.fill();
            }
          }
        }
      }
      // Pass 2: batched grid stroke for empty cells
      ctx.beginPath();
      for (var r2 = 0; r2 < gridRows; r2++) {
        var row2 = playerState.grid[r2];
        for (var c2 = 0; c2 < row2.length; c2++) {
          if (row2[c2] === 0) {
            var gp = this._hexCenter(c2, r2);
            // Inline hex sub-path (no beginPath — compound path)
            var _s = sCell;
            ctx.moveTo(gp.x + _s * HEX_UNIT_VERTICES[0], gp.y + _s * HEX_UNIT_VERTICES[1]);
            for (var vi = 2; vi < 12; vi += 2) {
              ctx.lineTo(gp.x + _s * HEX_UNIT_VERTICES[vi], gp.y + _s * HEX_UNIT_VERTICES[vi + 1]);
            }
            ctx.closePath();
          }
        }
      }
      ctx.strokeStyle = this._gridStroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Ghost piece
    if (playerState.ghost && playerState.currentPiece && playerState.alive !== false) {
      var ghost = playerState.ghost;
      var gc = ghostColors[playerState.currentPiece.typeId] || { outline: 'rgba(255,255,255,0.12)', fill: 'rgba(255,255,255,0.06)' };
      if (ghost.blocks) {
        for (var gi = 0; gi < ghost.blocks.length; gi++) {
          var gb = ghost.blocks[gi];
          if (gb[1] >= 0 && gb[1] < HEX_VIS_ROWS) {
            var gp = this._hexCenter(gb[0], gb[1]);
            this._drawHex(gp.x, gp.y, sCell, gc.fill, gc.outline, 0.4);
          }
        }
      }
    }

    // Zigzag clear preview: cached — only recompute when ghost position changes
    if (playerState.ghost && playerState.currentPiece && playerState.grid && playerState.alive !== false) {
      var ghostBlocks = playerState.ghost.blocks;
      if (ghostBlocks) {
        // Build a cache key from ghost block positions
        var ghostKey = '';
        for (var gk = 0; gk < ghostBlocks.length; gk++) {
          ghostKey += ghostBlocks[gk][0] + ',' + ghostBlocks[gk][1] + ';';
        }

        if (ghostKey !== this._prevGhostKey) {
          this._prevGhostKey = ghostKey;
          var ghostSet = {};
          for (var gi2 = 0; gi2 < ghostBlocks.length; gi2++) {
            ghostSet[ghostBlocks[gi2][0] + ',' + ghostBlocks[gi2][1]] = true;
          }
          var gridRows = playerState.grid.length;
          var grid = playerState.grid;
          var result = HexConstants.findClearableZigzags(
            HEX_COLS_N, gridRows,
            function(col, row) { return grid[row][col] > 0 || ghostSet[col + ',' + row]; },
            function(col, row) { return grid[row][col] === 0 && ghostSet[col + ',' + row]; }
          );
          // Convert string-keyed clearCells to array for rendering
          this._cachedPreviewCells = [];
          for (var key in result.clearCells) {
            var parts = key.split(',');
            this._cachedPreviewCells.push([parseInt(parts[0]), parseInt(parts[1])]);
          }
        }

        // Draw cached preview highlights
        for (var pi = 0; pi < this._cachedPreviewCells.length; pi++) {
          var pc = this._cachedPreviewCells[pi];
          if (pc[1] >= 0 && pc[1] < HEX_VIS_ROWS) {
            var hp = this._hexCenter(pc[0], pc[1]);
            this._drawHex(hp.x, hp.y, hs, 'rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0.4)');
          }
        }
      }
    } else {
      this._prevGhostKey = null;
      this._cachedPreviewCells = [];
    }

    // Current piece
    if (playerState.currentPiece && playerState.alive !== false) {
      var piece = playerState.currentPiece;
      var pieceColor = colors[piece.typeId] || '#ffffff';
      if (piece.blocks) {
        for (var pbi = 0; pbi < piece.blocks.length; pbi++) {
          var pb = piece.blocks[pbi];
          if (pb[1] >= 0 && pb[1] < HEX_VIS_ROWS) {
            var pp = this._hexCenter(pb[0], pb[1]);
            this._drawFilledHex(pp.x, pp.y, sCell, pieceColor);
          }
        }
      }
    }

    // Clearing cells glow (cell-based, not row-based)
    if (playerState.clearingCells && playerState.clearingCells.length > 0) {
      var t = (timestamp || performance.now()) / 150;
      var alpha = 0.3 + 0.2 * Math.sin(t * Math.PI);
      for (var ci = 0; ci < playerState.clearingCells.length; ci++) {
        var cc = playerState.clearingCells[ci];
        if (cc[1] >= 0 && cc[1] < HEX_VIS_ROWS) {
          var cp = this._hexCenter(cc[0], cc[1]);
          this._drawHex(cp.x, cp.y, sCell, '#ffffff', null, alpha);
        }
      }
    }

    this._drawWalls();
  }

  _drawWalls() {
    var ctx = this.ctx;
    ctx.strokeStyle = this._wallStroke;
    ctx.lineWidth = this.cellSize * THEME.stroke.border;
    HexConstants.traceHexOutline(ctx, this.x, this.y, this.hexSize, this.hexH, this.colW, HEX_COLS_N, HEX_VIS_ROWS);
    ctx.stroke();
  }
}
