'use strict';

const VISIBLE_ROWS = GameConstants.VISIBLE_HEIGHT;
const COLS = GameConstants.BOARD_WIDTH;

class BoardRenderer {
  constructor(ctx, x, y, cellSize, playerIndex) {
    this.ctx = ctx;
    this.x = x;
    this.y = y;
    this.cellSize = cellSize;
    this.playerIndex = playerIndex;
    this.accentColor = PLAYER_COLORS[playerIndex] || PLAYER_COLORS[0];
    this._accentRgb = hexToRgb(this.accentColor);
    this.boardWidth = COLS * cellSize;
    this.boardHeight = VISIBLE_ROWS * cellSize;
    this._styleTier = STYLE_TIERS.NORMAL;

    // Cached rgba strings (stable between layout recalculations)
    const rgb = this._accentRgb;
    this._tintFill = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${THEME.opacity.tint})` : null;
    const gridAlpha = THEME.opacity.grid + (rgb ? (1 - (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) / 255) * 0.08 : 0);
    this._gridStroke = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${gridAlpha.toFixed(2)})` : `rgba(255, 255, 255, ${THEME.opacity.grid})`;
    this._borderStroke = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${THEME.opacity.strong})` : `rgba(255, 255, 255, ${THEME.opacity.soft})`;
    this._accentRgbStr = rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : null;

    // Grid cache: offscreen canvas for locked blocks (redrawn only when gridVersion changes)
    this._gridCache = null;
    this._gridCacheCtx = null;
    this._cachedGridVersion = -1;
    this._cachedGridTier = null;
  }

  get styleTier() { return this._styleTier; }

  render(playerState, timestamp) {
    const ctx = this.ctx;

    // Determine style tier from level
    const newTier = getStyleTier(playerState.level || 1);
    this._styleTier = newTier;

    const isNeon = newTier === STYLE_TIERS.NEON_FLAT;
    const colors = isNeon ? NEON_PIECE_COLORS : PIECE_COLORS;
    const ghostColors = isNeon ? NEON_GHOST_COLORS : GHOST_COLORS;

    // 1. Board background — player-color tinted (matches controller touch pad)
    ctx.fillStyle = THEME.color.bg.board;
    ctx.fillRect(this.x, this.y, this.boardWidth, this.boardHeight);
    if (this._tintFill) {
      ctx.fillStyle = this._tintFill;
      ctx.fillRect(this.x, this.y, this.boardWidth, this.boardHeight);
    }

    // 2. Grid lines (batched into single stroke)
    ctx.strokeStyle = this._gridStroke;
    ctx.lineWidth = this.cellSize * THEME.stroke.grid;
    ctx.beginPath();
    for (let r = 1; r < VISIBLE_ROWS; r++) {
      const py = this.y + r * this.cellSize;
      ctx.moveTo(this.x, py);
      ctx.lineTo(this.x + this.boardWidth, py);
    }
    for (let c = 1; c < COLS; c++) {
      const px = this.x + c * this.cellSize;
      ctx.moveTo(px, this.y);
      ctx.lineTo(px, this.y + this.boardHeight);
    }
    ctx.stroke();

    // 3. Placed blocks from grid (cached to offscreen canvas)
    if (playerState.grid) {
      const gv = playerState.gridVersion ?? -1;
      if (gv !== this._cachedGridVersion || newTier !== this._cachedGridTier) {
        this._renderGridToCache(playerState.grid, colors);
        this._cachedGridVersion = gv;
        this._cachedGridTier = newTier;
      }
      if (this._gridCache) {
        ctx.drawImage(this._gridCache, 0, 0, this._gridCache.width, this._gridCache.height,
          this.x, this.y, Math.ceil(this.boardWidth), Math.ceil(this.boardHeight));
      }
    }

    // 4. Ghost piece (batched: one compound path for all 4 blocks)
    if (playerState.currentPiece && playerState.ghostY != null && playerState.alive !== false) {
      const piece = playerState.currentPiece;
      const ghostDisplayY = playerState.ghostY;
      const gc = ghostColors[piece.typeId] || { outline: 'rgba(255,255,255,0.12)', fill: 'rgba(255,255,255,0.06)' };
      if (piece.blocks) {
        const size = this.cellSize;
        const inset = size * THEME.size.blockGap;
        const s = size - inset * 2;
        const r = THEME.radius.block(size);
        // Stroke path (inset by 0.5 for crisp 1px lines)
        ctx.beginPath();
        for (const [bx, by] of piece.blocks) {
          const drawRow = ghostDisplayY + by;
          const drawCol = piece.x + bx;
          if (drawRow >= 0 && drawRow < VISIBLE_ROWS && drawCol >= 0 && drawCol < COLS) {
            _addRoundRectSubPath(ctx, this.x + drawCol * size + inset + 0.5, this.y + drawRow * size + inset + 0.5, s - 1, s - 1, r);
          }
        }
        ctx.strokeStyle = gc.outline;
        ctx.lineWidth = 1;
        ctx.stroke();
        // Fill path
        ctx.beginPath();
        for (const [bx, by] of piece.blocks) {
          const drawRow = ghostDisplayY + by;
          const drawCol = piece.x + bx;
          if (drawRow >= 0 && drawRow < VISIBLE_ROWS && drawCol >= 0 && drawCol < COLS) {
            _addRoundRectSubPath(ctx, this.x + drawCol * size + inset, this.y + drawRow * size + inset, s, s, r);
          }
        }
        ctx.fillStyle = gc.fill;
        ctx.fill();
      }
    }

    // 5. Current piece
    if (playerState.currentPiece && playerState.alive !== false) {
      const piece = playerState.currentPiece;
      const pieceDisplayY = piece.y;
      const color = colors[piece.typeId] || '#ffffff';
      if (piece.blocks) {
        for (const [bx, by] of piece.blocks) {
          const drawRow = pieceDisplayY + by;
          const drawCol = piece.x + bx;
          if (drawRow >= 0 && drawRow < VISIBLE_ROWS && drawCol >= 0 && drawCol < COLS) {
            this.drawBlock(drawCol, drawRow, color, false);
          }
        }
      }
    }

    // 6. Clearing rows pulsing glow effect
    if (playerState.clearingRows && playerState.clearingRows.length > 0) {
      const t = (timestamp || performance.now()) / 150;
      for (const row of playerState.clearingRows) {
        if (row >= 0 && row < VISIBLE_ROWS) {
          const alpha = 0.3 + 0.2 * Math.sin(t * Math.PI);
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(this.x, this.y + row * this.cellSize, this.boardWidth, this.cellSize);
          if (this._accentRgbStr) {
            ctx.globalAlpha = alpha * 0.3;
            ctx.fillStyle = this._accentRgbStr;
            ctx.fillRect(this.x, this.y + row * this.cellSize, this.boardWidth, this.cellSize);
          }
          ctx.globalAlpha = 1;
        }
      }
    }

    // 7. Board border
    this._drawBoardBorder();
  }

  _renderGridToCache(grid, colors) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.ceil(this.boardWidth);
    const h = Math.ceil(this.boardHeight);
    const pw = Math.ceil(w * dpr);
    const ph = Math.ceil(h * dpr);
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
    const gc = this._gridCacheCtx;
    gc.setTransform(dpr, 0, 0, dpr, 0, 0);
    gc.clearRect(0, 0, w, h);
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        const cellVal = grid[r][c];
        if (cellVal > 0) {
          const stamp = cellVal === 8
            ? getGarbageStamp(this.cellSize)
            : getBlockStamp(this._styleTier, colors[cellVal], this.cellSize);
          gc.drawImage(stamp, c * this.cellSize, r * this.cellSize, stamp.cssW, stamp.cssH);
        }
      }
    }
  }

  _drawBoardBorder() {
    const ctx = this.ctx;
    ctx.strokeStyle = this._borderStroke;
    const bw = this.cellSize * THEME.stroke.border;
    ctx.lineWidth = bw;
    const half = bw / 2;
    ctx.strokeRect(this.x - half, this.y - half, this.boardWidth + bw, this.boardHeight + bw);
  }

  drawBlock(col, row, color, isGarbage) {
    const x = this.x + col * this.cellSize;
    const y = this.y + row * this.cellSize;
    const stamp = isGarbage
      ? getGarbageStamp(this.cellSize)
      : getBlockStamp(this._styleTier, color, this.cellSize);
    this.ctx.drawImage(stamp, x, y, stamp.cssW, stamp.cssH);
  }

  // Used by DisplayRender __TEST__._extraGhosts path; main render uses batched compound path above.
  drawGhostBlock(col, row, color) {
    if (row < 0 || row >= VISIBLE_ROWS || col < 0 || col >= COLS) return;
    const ctx = this.ctx;
    const x = this.x + col * this.cellSize;
    const y = this.y + row * this.cellSize;
    const size = this.cellSize;
    const inset = size * THEME.size.blockGap;
    const s = size - inset * 2;
    const r = THEME.radius.block(size);
    ctx.strokeStyle = color.outline;
    ctx.lineWidth = 1;
    roundRect(ctx, x + inset + 0.5, y + inset + 0.5, s - 1, s - 1, r);
    ctx.stroke();
    ctx.fillStyle = color.fill;
    roundRect(ctx, x + inset, y + inset, s, s, r);
    ctx.fill();
  }
}

window.BoardRenderer = BoardRenderer;
