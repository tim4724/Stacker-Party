'use strict';

// BoardRenderer: renders a flat-top hex grid board on canvas.
// Columns are vertically aligned (no zigzag on horizontal movement).

var HEX_VIS_ROWS = GameConstants.VISIBLE_ROWS;
var HEX_COLS_N = GameConstants.COLS;
var _hexScratch = { x: 0, y: 0 };
var _hexLocalScratch = { x: 0, y: 0 };
var _GHOST_KEY_STRIDE = 32; // key = col * stride + row; stride must exceed max visible row index (VISIBLE_ROWS - 1 = 20)


class BoardRenderer {
  constructor(ctx, x, y, cellSize, playerIndex) {
    this.ctx = ctx;
    this.x = x;
    this.y = y;
    this.cellSize = cellSize;
    this.playerIndex = playerIndex;
    this.accentColor = PLAYER_COLORS[playerIndex] || PLAYER_COLORS[0];
    this._accentRgb = hexToRgb(this.accentColor);
    this._styleTier = STYLE_TIERS.NORMAL;

    var geo = GameConstants.computeHexGeometry(HEX_COLS_N, HEX_VIS_ROWS, cellSize);
    this.hexSize = geo.hexSize;
    this.hexH = geo.hexH;
    this.colW = geo.colW;
    this.boardWidth = geo.boardWidth;
    this.boardHeight = geo.boardHeight;
    // Pre-compute cell size with apothem-based gap (stable post-construction)
    this._sCell = this.hexSize - cellSize * THEME.size.blockGap * 2 / _SQRT3;
    this._stampHeight = _SQRT3 * this._sCell;
    this._gridLineWidth = this._stampHeight * THEME.stroke.grid;
    this._prevGhostCol = -1;
    this._prevGhostRow = -1;
    this._prevGhostType = -1;
    this._prevGhostGV = -1;
    this._prevGhostRotQ = 0;
    this._prevGhostRotR = 0;
    this._cachedPreviewCells = [];

    // Grid cache: offscreen canvas for locked blocks (redrawn only when gridVersion changes)
    this._gridCache = null;
    this._gridCacheCtx = null;
    this._cachedGridVersion = -1;
    this._cachedGridTier = null;

    // Pre-compute hex outline vertices: inner (for bg clip) and outer (for border stroke)
    var borderHalf = cellSize * THEME.stroke.border / 2;
    this._bgOutlineVerts = GameConstants.computeHexOutlineVerts(
      this.x, this.y, this.hexSize, this.hexH, this.colW, HEX_COLS_N, HEX_VIS_ROWS
    );
    this._outlineVerts = GameConstants.computeHexOutlineVerts(
      this.x, this.y, this.hexSize, this.hexH, this.colW, HEX_COLS_N, HEX_VIS_ROWS, borderHalf
    );

    // Cached rgba strings (stable between layout recalculations).
    // Board tint uses THEME.opacity.boardTint (stronger than generic
    // THEME.opacity.tint) so the player color reads boldly against the
    // card surface rather than blending into generic plum.
    var rgb = this._accentRgb;
    this._tintFill = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.boardTint + ')' : null;
    var gridAlpha = THEME.opacity.grid + (rgb ? (1 - (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) / 255) * 0.08 : 0);
    this._gridAlpha = gridAlpha;
    this._gridStrokeOpaque = rgb ? 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')' : 'rgb(255,255,255)';
    this._wallStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.strong + ')' : 'rgba(255,255,255,' + THEME.opacity.soft + ')';

    // Board background + grid cache (built lazily on first render)
    this._boardBgCache = null;
  }

  _buildBoardBgCache() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.ceil(this.boardWidth);
    var h = Math.ceil(this.boardHeight);
    // Pad the cache so the baked wall stroke's anti-alias halo doesn't get
    // clipped at the top/left/right/bottom edges of the bitmap. Half the
    // stroke width + 1px covers sub-pixel bleed.
    var pad = Math.max(2, Math.ceil(this.cellSize * THEME.stroke.border * 0.5) + 1);
    var cssW = w + pad * 2;
    var cssH = h + pad * 2;
    var pw = Math.ceil(cssW * dpr);
    var ph = Math.ceil(cssH * dpr);
    var oc;
    if (typeof OffscreenCanvas !== 'undefined') oc = new OffscreenCanvas(pw, ph);
    else { oc = document.createElement('canvas'); oc.width = pw; oc.height = ph; }
    oc.cssW = cssW;
    oc.cssH = cssH;
    oc.pad = pad;
    // alpha:false — main canvas is opaque with bg.primary everywhere, so the
    // cache can be opaque too. Pre-fill with bg.primary so the padded border
    // and the region outside the zigzag match the main canvas.
    var gc = oc.getContext('2d', { alpha: false });
    gc.setTransform(dpr, 0, 0, dpr, 0, 0);
    gc.fillStyle = THEME.color.bg.primary;
    gc.fillRect(0, 0, cssW, cssH);
    // Translate so (pad, pad) is the board origin — all existing drawing
    // below stays in board-local coordinates.
    gc.translate(pad, pad);

    // 1. Clip to hex outline and fill board background — tactile recipe:
    //    vertical gradient (cardSoft → card), player-tint wash, top bevel
    //    highlight inside the clipped zigzag shape.
    var bgv = this._bgOutlineVerts;
    var ox = this.x, oy = this.y;
    gc.save();
    gc.beginPath();
    gc.moveTo(bgv[0][0] - ox, bgv[0][1] - oy);
    for (var i = 1; i < bgv.length; i++) gc.lineTo(bgv[i][0] - ox, bgv[i][1] - oy);
    gc.closePath();
    gc.clip();

    // Deeper plum base so the player tint adds identity without brightening
    // the well (which would wash out piece contrast).
    var bgGrad = gc.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, THEME.color.bg.secondary);
    bgGrad.addColorStop(1, THEME.color.bg.board);
    gc.fillStyle = bgGrad;
    gc.fillRect(0, 0, w, h);

    if (this._tintFill) {
      gc.fillStyle = this._tintFill;
      gc.fillRect(0, 0, w, h);
    }

    gc.restore();

    // 2. Grid lines — draw opaque on a temp canvas, then composite at target alpha.
    //    Each hex cell draws all 6 edges, so shared interior edges overlap.
    //    Without this technique the overlaps double the effective alpha.
    //    tc stays at unpadded (w × h) so the 5-arg drawImage below scales the
    //    full tc into (0, 0, w, h) of gc at 1:1 — a padded tc would squash
    //    the grid into the unpadded destination rect.
    var hs = this.hexSize;
    var tcPw = Math.ceil(w * dpr);
    var tcPh = Math.ceil(h * dpr);
    var tc;
    if (typeof OffscreenCanvas !== 'undefined') tc = new OffscreenCanvas(tcPw, tcPh);
    else { tc = document.createElement('canvas'); tc.width = tcPw; tc.height = tcPh; }
    var tctx = tc.getContext('2d');
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.beginPath();
    for (var row = 0; row < HEX_VIS_ROWS; row++) {
      for (var col = 0; col < HEX_COLS_N; col++) {
        var pos = this._hexCenterLocal(col, row);
        tctx.moveTo(pos.x + hs * HEX_UNIT_VERTICES[0], pos.y + hs * HEX_UNIT_VERTICES[1]);
        for (var vi = 2; vi < 12; vi += 2) {
          tctx.lineTo(pos.x + hs * HEX_UNIT_VERTICES[vi], pos.y + hs * HEX_UNIT_VERTICES[vi + 1]);
        }
        tctx.closePath();
      }
    }
    tctx.strokeStyle = this._gridStrokeOpaque;
    tctx.lineWidth = this._gridLineWidth;
    tctx.stroke();
    gc.globalAlpha = this._gridAlpha;
    gc.drawImage(tc, 0, 0, w, h);
    gc.globalAlpha = 1;

    // 3. Outer wall stroke — baked in so render() doesn't re-stroke per frame.
    // Vertices are in main-canvas coords; translate to cache-local by the same
    // (ox, oy) offset used for the bg clip.
    gc.strokeStyle = this._wallStroke;
    gc.lineWidth = this.cellSize * THEME.stroke.border;
    var v = this._outlineVerts;
    gc.beginPath();
    gc.moveTo(v[0][0] - ox, v[0][1] - oy);
    for (var k = 1; k < v.length; k++) {
      gc.lineTo(v[k][0] - ox, v[k][1] - oy);
    }
    gc.closePath();
    gc.stroke();

    return oc;
  }

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
    var sCell = this._sCell;

    // 1. Board background + grid lines + walls (cached, single blit). The
    // cache is opaque and pre-filled with bg.primary so its padded border
    // blends seamlessly with the main canvas.
    // Rebuild if missing or if DPR/board dimensions changed (monitor move).
    var _dpr = window.devicePixelRatio || 1;
    var _bgPad = Math.max(2, Math.ceil(this.cellSize * THEME.stroke.border * 0.5) + 1);
    var _bgCssW = Math.ceil(this.boardWidth) + _bgPad * 2;
    var _bgCssH = Math.ceil(this.boardHeight) + _bgPad * 2;
    var _bgPw = Math.ceil(_bgCssW * _dpr);
    var _bgPh = Math.ceil(_bgCssH * _dpr);
    if (!this._boardBgCache ||
        this._boardBgCache.width !== _bgPw ||
        this._boardBgCache.height !== _bgPh) {
      this._boardBgCache = this._buildBoardBgCache();
    }
    var bgc = this._boardBgCache;
    ctx.drawImage(bgc, 0, 0, bgc.width, bgc.height,
      this.x - bgc.pad, this.y - bgc.pad, bgc.cssW, bgc.cssH);

    // 2. Filled blocks — cached to offscreen canvas, redrawn only when gridVersion changes
    if (playerState.grid) {
      var gv = playerState.gridVersion ?? -1;
      if (gv !== this._cachedGridVersion || newTier !== this._cachedGridTier) {
        this._renderGridToCache(playerState.grid, PIECE_COLORS, sCell);
        this._cachedGridVersion = gv;
        this._cachedGridTier = newTier;
      }
      if (this._gridCache) {
        ctx.drawImage(this._gridCache, 0, 0, this._gridCache.width, this._gridCache.height,
          this.x, this.y, Math.ceil(this.boardWidth), Math.ceil(this.boardHeight));
      }
    }

    // Ghost piece — batch all cells into a single compound path so fill+stroke
    // run once instead of per-hex.
    if (playerState.ghost && playerState.currentPiece && playerState.alive !== false) {
      var ghost = playerState.ghost;
      var gc = GHOST_COLORS[playerState.currentPiece.typeId] || { outline: 'rgba(255,255,255,0.12)', fill: 'rgba(255,255,255,0.06)' };
      if (ghost.blocks) {
        ctx.beginPath();
        var ghostDrawn = false;
        for (var gi = 0; gi < ghost.blocks.length; gi++) {
          var gb = ghost.blocks[gi];
          if (gb[1] >= 0 && gb[1] < HEX_VIS_ROWS) {
            var gp = this._hexCenter(gb[0], gb[1]);
            ctx.moveTo(gp.x + sCell * HEX_UNIT_VERTICES[0], gp.y + sCell * HEX_UNIT_VERTICES[1]);
            for (var gvi = 2; gvi < 12; gvi += 2) {
              ctx.lineTo(gp.x + sCell * HEX_UNIT_VERTICES[gvi], gp.y + sCell * HEX_UNIT_VERTICES[gvi + 1]);
            }
            ctx.closePath();
            ghostDrawn = true;
          }
        }
        if (ghostDrawn) {
          ctx.fillStyle = gc.fill;
          ctx.fill();
          ctx.strokeStyle = gc.outline;
          ctx.lineWidth = this._gridLineWidth;
          ctx.stroke();
        }
      }
    }

    // Zigzag clear preview: cached — only recompute when ghost position changes
    if (playerState.ghost && playerState.currentPiece && playerState.grid && playerState.alive !== false) {
      var ghostBlocks = playerState.ghost.blocks;
      if (ghostBlocks) {
        // Cache key from ghost anchor + piece type + rotation (avoids per-frame string building).
        // Rotation must be in the key: anchor and type can stay identical while rotation
        // changes the ghost block layout — a stale cache would show the previous rotation's
        // preview cells. cells[0] uniquely identifies rotation for every hex piece type.
        var gkCol = playerState.ghost.anchorCol;
        var gkRow = playerState.ghost.anchorRow;
        var gkType = playerState.currentPiece.typeId;
        var gkVersion = playerState.gridVersion;
        var gkCells0 = playerState.currentPiece.cells[0];
        var gkRotQ = gkCells0.q;
        var gkRotR = gkCells0.r;

        if (gkCol !== this._prevGhostCol || gkRow !== this._prevGhostRow ||
            gkType !== this._prevGhostType || gkVersion !== this._prevGhostGV ||
            gkRotQ !== this._prevGhostRotQ || gkRotR !== this._prevGhostRotR) {
          this._prevGhostCol = gkCol;
          this._prevGhostRow = gkRow;
          this._prevGhostType = gkType;
          this._prevGhostGV = gkVersion;
          this._prevGhostRotQ = gkRotQ;
          this._prevGhostRotR = gkRotR;
          var ghostSet = {};
          for (var gi2 = 0; gi2 < ghostBlocks.length; gi2++) {
            ghostSet[ghostBlocks[gi2][0] * _GHOST_KEY_STRIDE + ghostBlocks[gi2][1]] = true;
          }
          var gridRows = playerState.grid.length;
          var grid = playerState.grid;
          var result = GameConstants.findClearableZigzags(
            HEX_COLS_N, gridRows,
            function(col, row) { return grid[row][col] > 0 || ghostSet[col * _GHOST_KEY_STRIDE + row]; },
            function(col, row) { return grid[row][col] === 0 && ghostSet[col * _GHOST_KEY_STRIDE + row]; }
          );
          // findClearableZigzags returns clearCells as [[col, row], ...]
          this._cachedPreviewCells = result.clearCells;
        }

        // Draw cached preview highlights — batched compound path so all
        // preview cells share one fill + one stroke call.
        if (this._cachedPreviewCells.length > 0) {
          ctx.beginPath();
          var previewDrawn = false;
          for (var pi = 0; pi < this._cachedPreviewCells.length; pi++) {
            var pc = this._cachedPreviewCells[pi];
            if (pc[1] >= 0 && pc[1] < HEX_VIS_ROWS) {
              var hp = this._hexCenter(pc[0], pc[1]);
              ctx.moveTo(hp.x + hs * HEX_UNIT_VERTICES[0], hp.y + hs * HEX_UNIT_VERTICES[1]);
              for (var pvi = 2; pvi < 12; pvi += 2) {
                ctx.lineTo(hp.x + hs * HEX_UNIT_VERTICES[pvi], hp.y + hs * HEX_UNIT_VERTICES[pvi + 1]);
              }
              ctx.closePath();
              previewDrawn = true;
            }
          }
          if (previewDrawn) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.lineWidth = this._gridLineWidth;
            ctx.stroke();
          }
        }
      }
    } else {
      this._prevGhostCol = -1; this._prevGhostRow = -1;
      this._prevGhostType = -1; this._prevGhostGV = -1;
      this._prevGhostRotQ = 0; this._prevGhostRotR = 0;
      this._cachedPreviewCells.length = 0;
    }

    // Current piece
    if (playerState.currentPiece && playerState.alive !== false) {
      var piece = playerState.currentPiece;
      var pieceColor = PIECE_COLORS[piece.typeId] || '#ffffff';
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

    // Walls are baked into _boardBgCache (see _buildBoardBgCache step 3) —
    // no per-frame stroke needed.
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

}
