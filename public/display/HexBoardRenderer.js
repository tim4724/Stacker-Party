'use strict';

// HexBoardRenderer: renders a flat-top hex grid board on canvas.
// Same interface as BoardRenderer but with flat-top hex orientation.
// Columns are vertically aligned (no zigzag on horizontal movement).

var HEX_VIS_ROWS = HexConstants.HEX_VISIBLE_ROWS;
var HEX_COLS_N = HexConstants.HEX_COLS;
var _hexScratch = { x: 0, y: 0 };
var _hexLocalScratch = { x: 0, y: 0 };


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
    this._prevGhostCol = -1;
    this._prevGhostRow = -1;
    this._prevGhostType = -1;
    this._prevGhostGV = -1;
    this._cachedPreviewCells = [];

    // Grid cache: offscreen canvas for locked blocks (redrawn only when gridVersion changes)
    this._gridCache = null;
    this._gridCacheCtx = null;
    this._cachedGridVersion = -1;
    this._cachedGridTier = null;

    // Pre-compute hex outline vertices (only changes on layout recalculation)
    this._outlineVerts = HexConstants.computeHexOutlineVerts(
      this.x, this.y, this.hexSize, this.hexH, this.colW, HEX_COLS_N, HEX_VIS_ROWS
    );

    // Cached rgba strings (stable between layout recalculations)
    var rgb = this._accentRgb;
    this._tintFill = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.tint + ')' : null;
    this._gridStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.grid + ')' : 'rgba(255,255,255,' + THEME.opacity.grid + ')';
    this._wallStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.strong + ')' : 'rgba(255,255,255,' + THEME.opacity.soft + ')';
  }

  get styleTier() { return this._styleTier; }
  get hexW() { return 2 * this.hexSize; }

  // Pixel center of hex at (col, row) in visible coordinates.
  // Returns a shared scratch object — callers must consume x/y before the next call.
  _hexCenter(col, row) {
    _hexScratch.x = this.x + this.colW * col + this.hexSize;
    _hexScratch.y = this.y + this.hexH * (row + 0.5 * (col & 1)) + this.hexH / 2;
    return _hexScratch;
  }

  // Pixel center relative to (0,0) for offscreen cache rendering.
  // Uses a separate scratch object from _hexCenter to avoid aliasing.
  _hexCenterLocal(col, row) {
    _hexLocalScratch.x = this.colW * col + this.hexSize;
    _hexLocalScratch.y = this.hexH * (row + 0.5 * (col & 1)) + this.hexH / 2;
    return _hexLocalScratch;
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
    this.ctx.drawImage(stamp, cx - size - 1, cy - stamp.cssH / 2, stamp.cssW, stamp.cssH);
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

    // Grid cells — cached to offscreen canvas, redrawn only when gridVersion changes
    if (playerState.grid) {
      var gv = playerState.gridVersion ?? -1;
      if (gv !== this._cachedGridVersion || newTier !== this._cachedGridTier) {
        this._renderGridToCache(playerState.grid, colors, sCell);
        this._cachedGridVersion = gv;
        this._cachedGridTier = newTier;
      }
      if (this._gridCache) {
        ctx.drawImage(this._gridCache, 0, 0, this._gridCache.width, this._gridCache.height,
          this.x, this.y, Math.ceil(this.boardWidth), Math.ceil(this.boardHeight));
      }
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
        // Cache key from ghost anchor + piece type (avoids per-frame string building)
        var gkCol = playerState.ghost.anchorCol;
        var gkRow = playerState.ghost.anchorRow;
        var gkType = playerState.currentPiece.typeId;
        var gkVersion = playerState.gridVersion;

        if (gkCol !== this._prevGhostCol || gkRow !== this._prevGhostRow ||
            gkType !== this._prevGhostType || gkVersion !== this._prevGhostGV) {
          this._prevGhostCol = gkCol;
          this._prevGhostRow = gkRow;
          this._prevGhostType = gkType;
          this._prevGhostGV = gkVersion;
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
          // findClearableZigzags returns clearCells as [[col, row], ...]
          this._cachedPreviewCells = result.clearCells;
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
      this._prevGhostCol = -1; this._prevGhostRow = -1;
      this._prevGhostType = -1; this._prevGhostGV = -1;
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

  _renderGridToCache(grid, colors, sCell) {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.ceil(this.boardWidth);
    var h = Math.ceil(this.boardHeight);
    var pw = Math.ceil(w * dpr);
    var ph = Math.ceil(h * dpr);
    if (!this._gridCache || this._gridCache.width !== pw || this._gridCache.height !== ph) {
      if (typeof OffscreenCanvas !== 'undefined') {
        this._gridCache = new OffscreenCanvas(pw, ph);
      } else {
        this._gridCache = document.createElement('canvas');
        this._gridCache.width = pw;
        this._gridCache.height = ph;
      }
      this._gridCacheCtx = this._gridCache.getContext('2d');
    }
    var gc = this._gridCacheCtx;
    gc.setTransform(dpr, 0, 0, dpr, 0, 0);
    gc.clearRect(0, 0, w, h);

    var gridRows = grid.length;
    // Pass 1: fills + stamps
    for (var r = 0; r < gridRows; r++) {
      var row = grid[r];
      for (var c = 0; c < row.length; c++) {
        var pos = this._hexCenterLocal(c, r);
        if (row[c] > 0) {
          var stamp = getHexStamp(this._styleTier, colors[row[c]], sCell);
          gc.drawImage(stamp, pos.x - sCell - 1, pos.y - stamp.cssH / 2, stamp.cssW, stamp.cssH);
        } else {
          hexPath(gc, pos.x, pos.y, sCell);
          gc.fillStyle = THEME.color.bg.board;
          gc.fill();
          if (this._tintFill) {
            gc.fillStyle = this._tintFill;
            gc.fill();
          }
        }
      }
    }
    // Pass 2: batched grid stroke for empty cells
    gc.beginPath();
    for (var r2 = 0; r2 < gridRows; r2++) {
      var row2 = grid[r2];
      for (var c2 = 0; c2 < row2.length; c2++) {
        if (row2[c2] === 0) {
          var gp = this._hexCenterLocal(c2, r2);
          gc.moveTo(gp.x + sCell * HEX_UNIT_VERTICES[0], gp.y + sCell * HEX_UNIT_VERTICES[1]);
          for (var vi = 2; vi < 12; vi += 2) {
            gc.lineTo(gp.x + sCell * HEX_UNIT_VERTICES[vi], gp.y + sCell * HEX_UNIT_VERTICES[vi + 1]);
          }
          gc.closePath();
        }
      }
    }
    gc.strokeStyle = this._gridStroke;
    gc.lineWidth = 1.5;
    gc.stroke();
  }

  _drawWalls() {
    var ctx = this.ctx;
    ctx.strokeStyle = this._wallStroke;
    ctx.lineWidth = this.cellSize * THEME.stroke.border;
    var v = this._outlineVerts;
    ctx.beginPath();
    ctx.moveTo(v[0][0], v[0][1]);
    for (var i = 1; i < v.length; i++) {
      ctx.lineTo(v[i][0], v[i][1]);
    }
    ctx.closePath();
    ctx.stroke();
  }
}
