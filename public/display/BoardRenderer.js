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
    this._bgGradient = null;
    this._blockGradients = new Map(); // cached per color_y string
    this._styleTier = STYLE_TIERS.NORMAL;
  }

  render(playerState) {
    const ctx = this.ctx;

    // Determine style tier from level
    const newTier = getStyleTier(playerState.level || 1);
    if (newTier !== this._styleTier) {
      this._styleTier = newTier;
      this._blockGradients.clear();
    }

    const isNeon = this._styleTier === STYLE_TIERS.NEON_FLAT;
    const colors = isNeon ? NEON_PIECE_COLORS : PIECE_COLORS;
    const ghostColors = isNeon ? NEON_GHOST_COLORS : GHOST_COLORS;

    // 1. Board background — player-color tinted (matches controller touch pad)
    const rgb = this._accentRgb;
    ctx.fillStyle = THEME.color.bg.board;
    ctx.fillRect(this.x, this.y, this.boardWidth, this.boardHeight);
    if (rgb) {
      ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${THEME.opacity.tint})`;
      ctx.fillRect(this.x, this.y, this.boardWidth, this.boardHeight);
    }

    // 2. Grid lines (batched into single stroke)
    ctx.strokeStyle = rgb
      ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${THEME.opacity.muted})`
      : `rgba(255, 255, 255, ${THEME.opacity.subtle})`;
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

    // 3. Placed blocks from grid
    if (playerState.grid) {
      for (let r = 0; r < playerState.grid.length; r++) {
        for (let c = 0; c < playerState.grid[r].length; c++) {
          const cellVal = playerState.grid[r][c];
          if (cellVal > 0) {
            this.drawBlock(c, r, colors[cellVal], cellVal === 8);
          }
        }
      }
    }

    // 4. Ghost piece
    if (playerState.currentPiece && playerState.ghostY != null && playerState.alive !== false) {
      const piece = playerState.currentPiece;
      const ghostDisplayY = playerState.ghostY;
      const ghostColor = ghostColors[piece.typeId] || { outline: 'rgba(255,255,255,0.12)', fill: 'rgba(255,255,255,0.06)' };
      if (piece.blocks) {
        for (const [bx, by] of piece.blocks) {
          const drawRow = ghostDisplayY + by;
          const drawCol = piece.x + bx;
          if (drawRow >= 0 && drawRow < VISIBLE_ROWS && drawCol >= 0 && drawCol < COLS) {
            this.drawGhostBlock(drawCol, drawRow, ghostColor, piece.typeId);
          }
        }
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
      const t = performance.now() / 150;
      for (const row of playerState.clearingRows) {
        if (row >= 0 && row < VISIBLE_ROWS) {
          const alpha = 0.3 + 0.2 * Math.sin(t * Math.PI);
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.fillRect(this.x, this.y + row * this.cellSize, this.boardWidth, this.cellSize);
          const rgb = this._accentRgb;
          if (rgb) {
            ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha * 0.3})`;
            ctx.fillRect(this.x, this.y + row * this.cellSize, this.boardWidth, this.cellSize);
          }
        }
      }
    }

    // 7. Board border
    this._drawBoardBorder();
  }

  _drawBoardBorder() {
    const ctx = this.ctx;
    const rgb = this._accentRgb;
    ctx.strokeStyle = rgb
      ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${THEME.opacity.strong})`
      : `rgba(255, 255, 255, ${THEME.opacity.soft})`;
    const bw = this.cellSize * THEME.stroke.border;
    ctx.lineWidth = bw;
    const half = bw / 2;
    ctx.strokeRect(this.x - half, this.y - half, this.boardWidth + bw, this.boardHeight + bw);
  }

  drawBlock(col, row, color, isGarbage) {
    const ctx = this.ctx;
    const x = this.x + col * this.cellSize;
    const y = this.y + row * this.cellSize;
    const size = this.cellSize;
    const inset = size * THEME.size.blockGap;
    const r = THEME.radius.block(size);
    const s = size - inset * 2;
    const tier = this._styleTier;

    if (isGarbage) {
      ctx.fillStyle = THEME.color.garbage;
      if (tier === STYLE_TIERS.SQUARE) {
        ctx.fillRect(x + inset, y + inset, s, s);
      } else {
        roundRect(ctx, x + inset, y + inset, s, s, r);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.faint})`;
      ctx.fillRect(x + inset * 2, y + inset * 2, s - inset * 2, inset);
      return;
    }

    if (tier === STYLE_TIERS.SQUARE) {
      this._drawBlockSquare(x, y, size, inset, s, color);
    } else if (tier === STYLE_TIERS.NEON_FLAT) {
      this._drawBlockNeonFlat(x, y, size, inset, s, r, color);
    } else {
      this._drawBlockNormal(x, y, size, inset, s, r, color);
    }
  }

  _drawBlockNormal(x, y, size, inset, s, r, color) {
    const ctx = this.ctx;
    // Gradient cached per color (7 entries), drawn with save/translate/restore
    let grad = this._blockGradients.get(color);
    if (!grad) {
      grad = ctx.createLinearGradient(0, 0, 0, size);
      grad.addColorStop(0, lightenColor(color, 15));
      grad.addColorStop(1, darkenColor(color, 10));
      this._blockGradients.set(color, grad);
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = grad;
    roundRect(ctx, inset, inset, s, s, r);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.highlight})`;
    ctx.fillRect(inset + r, inset, s - r * 2, size * 0.08);
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.muted})`;
    ctx.fillRect(inset, inset + r, size * 0.07, s - r * 2);
    ctx.fillStyle = `rgba(0, 0, 0, ${THEME.opacity.shadow})`;
    ctx.fillRect(inset + r, size - inset - size * 0.08, s - r * 2, size * 0.08);
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.subtle})`;
    const shineSize = size * 0.25;
    ctx.fillRect(size * 0.25, size * 0.2, shineSize, shineSize * 0.5);
    ctx.restore();
  }

  _drawBlockSquare(x, y, size, inset, s, color) {
    const ctx = this.ctx;
    ctx.strokeStyle = lightenColor(color, 20);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + inset + 0.75, y + inset + 0.75, s - 1.5, s - 1.5);
    ctx.fillStyle = color;
    ctx.fillRect(x + inset + 1.5, y + inset + 1.5, s - 3, s - 3);
  }

  _drawBlockNeonFlat(x, y, size, inset, s, r, color) {
    const ctx = this.ctx;
    const cRgb = hexToRgb(color);
    // Dark tinted fill (~20% of piece color)
    ctx.fillStyle = `rgba(${cRgb.r * 0.2 | 0}, ${cRgb.g * 0.2 | 0}, ${cRgb.b * 0.2 | 0}, 0.92)`;
    roundRect(ctx, x + inset, y + inset, s, s, r);
    ctx.fill();
    // Bright border
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    roundRect(ctx, x + inset + 1, y + inset + 1, s - 2, s - 2, r);
    ctx.stroke();
    // Top edge highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x + inset + r + 2, y + inset + 2);
    ctx.lineTo(x + size - inset - r - 2, y + inset + 2);
    ctx.stroke();
  }

  drawGhostBlock(col, row, color, typeId) {
    const ctx = this.ctx;
    const x = this.x + col * this.cellSize;
    const y = this.y + row * this.cellSize;
    const size = this.cellSize;
    const inset = size * THEME.size.blockGap;
    const s = size - inset * 2;
    const r = THEME.radius.block(size);
    const tier = this._styleTier;

    if (tier === STYLE_TIERS.SQUARE) {
      ctx.strokeStyle = color.outline;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + inset + 0.5, y + inset + 0.5, s - 1, s - 1);
      ctx.fillStyle = color.fill;
      ctx.fillRect(x + inset + 1, y + inset + 1, s - 2, s - 2);
    } else {
      // Normal / Neon — solid rounded outline + translucent fill
      ctx.strokeStyle = color.outline;
      ctx.lineWidth = 1;
      roundRect(ctx, x + inset + 0.5, y + inset + 0.5, s - 1, s - 1, r);
      ctx.stroke();
      ctx.fillStyle = color.fill;
      roundRect(ctx, x + inset, y + inset, s, s, r);
      ctx.fill();
    }
  }
}

window.BoardRenderer = BoardRenderer;
