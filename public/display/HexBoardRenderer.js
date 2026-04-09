'use strict';

// HexBoardRenderer: renders a flat-top hex grid board on canvas.
// Same interface as BoardRenderer but with flat-top hex orientation.
// Columns are vertically aligned (no zigzag on horizontal movement).

var HEX_VIS_ROWS = HexConstants.HEX_VISIBLE_ROWS;
var HEX_COLS_N = HexConstants.HEX_COLS;
var _hexScratch = { x: 0, y: 0 };
var _hexLocalScratch = { x: 0, y: 0 };
var _GHOST_KEY_STRIDE = 32; // must exceed max(HEX_VIS_ROWS, HEX_COLS) for collision-free keys


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
    // Pre-compute cell size with apothem-based gap (stable post-construction)
    this._sCell = this.hexSize - cellSize * THEME.size.blockGap * 2 / _SQRT3;
    this._stampHeight = _SQRT3 * this._sCell;
    this._gridLineWidth = Math.max(1.5, this._stampHeight * THEME.stroke.grid);
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

    // Pre-compute hex outline vertices: inner (for bg clip) and outer (for border stroke)
    var borderHalf = cellSize * THEME.stroke.border / 2;
    this._bgOutlineVerts = HexConstants.computeHexOutlineVerts(
      this.x, this.y, this.hexSize, this.hexH, this.colW, HEX_COLS_N, HEX_VIS_ROWS
    );
    this._outlineVerts = HexConstants.computeHexOutlineVerts(
      this.x, this.y, this.hexSize, this.hexH, this.colW, HEX_COLS_N, HEX_VIS_ROWS, borderHalf
    );

    // Cached rgba strings (stable between layout recalculations)
    var rgb = this._accentRgb;
    this._tintFill = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.tint + ')' : null;
    var gridAlpha = THEME.opacity.grid + (rgb ? (1 - (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) / 255) * 0.08 : 0);
    this._gridStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + gridAlpha.toFixed(2) + ')' : 'rgba(255,255,255,' + THEME.opacity.grid + ')';
    this._wallStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.strong + ')' : 'rgba(255,255,255,' + THEME.opacity.soft + ')';

    // Board background + grid cache (built lazily on first render)
    this._boardBgCache = null;
  }

  _buildBoardBgCache() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.ceil(this.boardWidth);
    var h = Math.ceil(this.boardHeight);
    var pw = Math.ceil(w * dpr);
    var ph = Math.ceil(h * dpr);
    var oc;
    if (typeof OffscreenCanvas !== 'undefined') oc = new OffscreenCanvas(pw, ph);
    else { oc = document.createElement('canvas'); oc.width = pw; oc.height = ph; }
    oc.cssW = w;
    oc.cssH = h;
    var gc = oc.getContext('2d');
    gc.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Clip to hex outline and fill board background + tint
    var bgv = this._bgOutlineVerts;
    var ox = this.x, oy = this.y;
    gc.save();
    gc.beginPath();
    gc.moveTo(bgv[0][0] - ox, bgv[0][1] - oy);
    for (var i = 1; i < bgv.length; i++) gc.lineTo(bgv[i][0] - ox, bgv[i][1] - oy);
    gc.closePath();
    gc.clip();
    gc.fillStyle = THEME.color.bg.board;
    gc.fill();
    if (this._tintFill) {
      gc.fillStyle = this._tintFill;
      gc.fill();
    }
    gc.restore();

    // 2. Grid lines at full hexSize (cells touch at boundaries, like square mode)
    var hs = this.hexSize;
    gc.beginPath();
    for (var row = 0; row < HEX_VIS_ROWS; row++) {
      for (var col = 0; col < HEX_COLS_N; col++) {
        var pos = this._hexCenterLocal(col, row);
        gc.moveTo(pos.x + hs * HEX_UNIT_VERTICES[0], pos.y + hs * HEX_UNIT_VERTICES[1]);
        for (var vi = 2; vi < 12; vi += 2) {
          gc.lineTo(pos.x + hs * HEX_UNIT_VERTICES[vi], pos.y + hs * HEX_UNIT_VERTICES[vi + 1]);
        }
        gc.closePath();
      }
    }
    gc.strokeStyle = this._gridStroke;
    gc.lineWidth = this._gridLineWidth;
    gc.stroke();

    return oc;
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

  _drawHex(cx, cy, size, fill, stroke, alpha) {
    var ctx = this.ctx;
    hexPath(ctx, cx, cy, size);
    if (fill) {
      if (alpha != null) ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fill();
      if (alpha != null) ctx.globalAlpha = 1;
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = this._gridLineWidth;
      ctx.stroke();
    }
  }

  // Draw a ghost block at grid (col, row) — used by test harness for extra ghosts
  drawGhostBlock(col, row, gc) {
    if (row < 0 || row >= HEX_VIS_ROWS || col < 0 || col >= HEX_COLS_N) return;
    var pos = this._hexCenter(col, row);
    this._drawHex(pos.x, pos.y, this._sCell, gc.fill, gc.outline);
  }

  _drawFilledHex(cx, cy, size, color) {
    var stamp = getHexStamp(this._styleTier, color, this._stampHeight);
    this.ctx.drawImage(stamp, cx - stamp.cssW / 2, cy - stamp.cssH / 2, stamp.cssW, stamp.cssH);
  }

  render(playerState, timestamp) {
    var ctx = this.ctx;
    var hs = this.hexSize;
    var newTier = getStyleTier(playerState.level || 1);
    this._styleTier = newTier;
    var isNeon = newTier === STYLE_TIERS.NEON_FLAT;
    var colors = isNeon ? NEON_PIECE_COLORS : PIECE_COLORS;
    var ghostColors = isNeon ? NEON_GHOST_COLORS : GHOST_COLORS;

    var sCell = this._sCell;

    // 1. Board background + grid lines (cached, single blit)
    if (!this._boardBgCache) this._boardBgCache = this._buildBoardBgCache();
    var bgc = this._boardBgCache;
    ctx.drawImage(bgc, 0, 0, bgc.width, bgc.height,
      this.x, this.y, Math.ceil(this.boardWidth), Math.ceil(this.boardHeight));

    // 2. Filled blocks — cached to offscreen canvas, redrawn only when gridVersion changes
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
            this._drawHex(gp.x, gp.y, sCell, gc.fill, gc.outline);
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
            ghostSet[ghostBlocks[gi2][0] * _GHOST_KEY_STRIDE + ghostBlocks[gi2][1]] = true;
          }
          var gridRows = playerState.grid.length;
          var grid = playerState.grid;
          var result = HexConstants.findClearableZigzags(
            HEX_COLS_N, gridRows,
            function(col, row) { return grid[row][col] > 0 || ghostSet[col * _GHOST_KEY_STRIDE + row]; },
            function(col, row) { return grid[row][col] === 0 && ghostSet[col * _GHOST_KEY_STRIDE + row]; }
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
      this._cachedPreviewCells.length = 0;
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

    // Only render filled block stamps (background + grid drawn on main canvas)
    var gridRows = grid.length;
    for (var r = 0; r < gridRows; r++) {
      var row = grid[r];
      for (var c = 0; c < row.length; c++) {
        if (row[c] > 0) {
          var pos = this._hexCenterLocal(c, r);
          var stamp = getHexStamp(this._styleTier, colors[row[c]], this._stampHeight);
          gc.drawImage(stamp, pos.x - stamp.cssW / 2, pos.y - stamp.cssH / 2, stamp.cssW, stamp.cssH);
        }
      }
    }
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
