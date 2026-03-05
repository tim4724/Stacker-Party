'use strict';

const MINI_PIECES = {
  I: [[0,1],[1,1],[2,1],[3,1]],
  O: [[0,0],[1,0],[0,1],[1,1]],
  T: [[0,1],[1,1],[2,1],[1,0]],
  S: [[1,0],[2,0],[0,1],[1,1]],
  Z: [[0,0],[1,0],[1,1],[2,1]],
  J: [[0,0],[0,1],[1,1],[2,1]],
  L: [[2,0],[0,1],[1,1],[2,1]]
};

// Bounding boxes for centering mini pieces
const MINI_BOUNDS = {};
for (const [type, blocks] of Object.entries(MINI_PIECES)) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [bx, by] of blocks) {
    minX = Math.min(minX, bx);
    maxX = Math.max(maxX, bx);
    minY = Math.min(minY, by);
    maxY = Math.max(maxY, by);
  }
  MINI_BOUNDS[type] = { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Map piece type string to typeId for color lookup
const PIECE_TYPE_TO_ID = { I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 };

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
    this.panelWidth = cellSize * THEME.size.panelWidth;
    this.miniSize = cellSize * THEME.font.cellScale.mini;
    this.panelGap = Math.max(THEME.size.panelGapMin, cellSize * THEME.size.panelGap);
    this._fontLoaded = document.fonts?.check?.('12px Orbitron') ?? false;
    this._labelFont = this._fontLoaded ? 'Orbitron' : '"Courier New", monospace';
  }

  render(playerState) {
    // Re-check font availability (it may load after first render)
    if (!this._fontLoaded) {
      this._fontLoaded = document.fonts?.check?.('12px Orbitron') ?? false;
      if (this._fontLoaded) this._labelFont = 'Orbitron';
    }

    // 1. Player name + accent stripe above board
    this.drawPlayerName(playerState);

    // 2. Hold piece panel (left of board)
    this.drawHoldPanel(playerState);

    // 3. Next pieces panel (right of board)
    this.drawNextPanel(playerState);

    // 4. Score display below board
    this.drawScorePanel(playerState);

    // 5. Garbage meter (right edge of board)
    if (playerState.pendingGarbage > 0) {
      this.drawGarbageMeter(playerState.pendingGarbage);
    }

    // 5b. Transient attacker-colored tint on newly appeared garbage meter blocks
    if (playerState.garbageIndicatorEffects && playerState.garbageIndicatorEffects.length > 0) {
      this.drawGarbageIndicatorEffects(playerState.garbageIndicatorEffects);
    }

    // 6. KO overlay
    if (playerState.alive === false) {
      this.drawKOOverlay();
    }
  }

  drawPlayerName(playerState) {
    const ctx = this.ctx;
    const name = playerState.playerName || PLAYER_NAMES[this.playerIndex] || ('Player ' + (this.playerIndex + 1));
    const nameY = this.boardY - 8;
    const fontSize = Math.max(12, this.cellSize * THEME.font.cellScale.name);

    // Name text
    ctx.fillStyle = playerState.playerColor || THEME.color.text.white;
    ctx.font = `700 ${fontSize}px ${this._labelFont}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(name, this.boardX + 2, nameY - 2);

    // Level badge on right side
    if (playerState.level) {
      const lvlSize = Math.max(9, this.cellSize * THEME.font.cellScale.label);
      ctx.font = `700 ${lvlSize}px ${this._labelFont}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.fillText(`Level ${playerState.level}`, this.boardX + this.boardWidth - 2, nameY - 2);
    }
  }

  drawHoldPanel(playerState) {
    const ctx = this.ctx;
    const panelY = this.boardY;
    const labelSize = Math.max(9, this.cellSize * THEME.font.cellScale.label);
    const boxSize = this.miniSize * THEME.size.panelWidth;
    // Right-align the box to sit next to the board (mirroring next panel)
    const panelX = this.boardX - this.panelGap - boxSize;

    // Label
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.label})`;
    ctx.font = `700 ${labelSize}px ${this._labelFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText('HOLD', panelX + boxSize / 2, panelY);
    ctx.letterSpacing = '0px';

    // Panel background with rounded rect
    const boxY = panelY + labelSize + 6;
    this._drawPanel(panelX, boxY, boxSize, boxSize);

    // Hold piece
    if (playerState.holdPiece) {
      this.drawMiniPiece(
        panelX + boxSize / 2,
        boxY + boxSize / 2,
        playerState.holdPiece,
        this.miniSize
      );
    }
  }

  drawNextPanel(playerState) {
    const ctx = this.ctx;
    const panelX = this.boardX + this.boardWidth + this.panelGap;
    const panelY = this.boardY;
    const labelSize = Math.max(9, this.cellSize * THEME.font.cellScale.label);
    const boxWidth = this.miniSize * THEME.size.panelWidth;
    const pieceSpacing = this.miniSize * 3;
    const startY = panelY + labelSize + 6;

    // Label
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.label})`;
    ctx.font = `700 ${labelSize}px ${this._labelFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText('NEXT', panelX + boxWidth / 2, panelY);
    ctx.letterSpacing = '0px';

    // Panel background
    const nextCount = playerState.nextPieces ? Math.min(playerState.nextPieces.length, 5) : 0;
    const boxHeight = pieceSpacing * Math.max(nextCount, 1);
    this._drawPanel(panelX, startY, boxWidth, boxHeight);

    // Next pieces
    if (playerState.nextPieces) {
      for (let i = 0; i < Math.min(playerState.nextPieces.length, 5); i++) {
        const py = startY + i * pieceSpacing + pieceSpacing / 2;
        const alpha = i === 0 ? 1.0 : 0.7 - i * 0.06;
        ctx.globalAlpha = alpha;
        this.drawMiniPiece(
          panelX + boxWidth / 2,
          py,
          playerState.nextPieces[i],
          this.miniSize
        );
        ctx.globalAlpha = 1.0;
      }
    }
  }

  drawScorePanel(playerState) {
    const ctx = this.ctx;
    const panelY = this.boardY + this.boardHeight + 10;
    const scoreSize = Math.max(14, this.cellSize * THEME.font.cellScale.score);

    // Score — large prominent number
    ctx.font = `700 ${scoreSize}px ${this._labelFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Score text with subtle glow
    const scoreStr = String(playerState.score || 0).padStart(8, '0');
    const rgb = hexToRgb(this.accentColor);
    if (rgb) {
      ctx.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`;
      ctx.shadowBlur = 8;
    }
    ctx.fillStyle = THEME.color.text.white;
    ctx.fillText(
      scoreStr,
      this.boardX + this.boardWidth / 2,
      panelY
    );
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Lines count
    const smallSize = Math.max(9, this.cellSize * THEME.font.cellScale.label);
    ctx.font = `500 ${smallSize}px ${this._labelFont}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    const statsY = panelY + scoreSize + Math.max(10, this.cellSize * 0.4);
    ctx.fillText(
      `${playerState.lines || 0} LINES`,
      this.boardX + this.boardWidth / 2,
      statsY
    );
  }

  getGarbageMeterLayout() {
    return {
      x: this.boardX - this.cellSize - 2,
      y: this.boardY,
      cellSize: this.cellSize,
      rows: 20
    };
  }

  drawGarbageMeter(pendingGarbage) {
    const ctx = this.ctx;
    const meter = this.getGarbageMeterLayout();
    const rows = Math.min(pendingGarbage, meter.rows);
    const inset = THEME.size.boardInset;
    const r = THEME.radius.block(meter.cellSize);

    // Draw stacked gray blocks from bottom up (may overlap hold panel)
    for (let i = 0; i < rows; i++) {
      const y = meter.y + this.boardHeight - (i + 1) * meter.cellSize;
      ctx.fillStyle = THEME.color.garbage;
      roundRect(ctx, meter.x + inset, y + inset, meter.cellSize - inset * 2, meter.cellSize - inset * 2, r);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.faint})`;
      ctx.fillRect(meter.x + inset + 1, y + inset + 1, meter.cellSize - inset * 2 - 2, 1);
    }
  }

  drawGarbageIndicatorEffects(effects) {
    if (!Array.isArray(effects) || effects.length === 0) return;

    const ctx = this.ctx;
    const meter = this.getGarbageMeterLayout();
    const now = performance.now();
    const inset = THEME.size.boardInset;
    const r = THEME.radius.block(meter.cellSize);

    for (const effect of effects) {
      const alpha = this._getGarbageIndicatorAlpha(effect, now);
      if (alpha <= 0) continue;

      for (let row = effect.rowStart; row < effect.rowStart + effect.lines; row++) {
        if (row < 0 || row >= meter.rows) continue;
        const y = meter.y + row * meter.cellSize;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = effect.color;
        roundRect(ctx, meter.x + inset, y + inset, meter.cellSize - inset * 2, meter.cellSize - inset * 2, r);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fillRect(meter.x + inset + 1, y + inset + 1, meter.cellSize - inset * 2 - 2, 1);
        ctx.restore();
      }
    }
  }

  drawKOOverlay() {
    const ctx = this.ctx;

    // Darken the board with vignette
    const grad = ctx.createRadialGradient(
      this.boardX + this.boardWidth / 2,
      this.boardY + this.boardHeight / 2,
      0,
      this.boardX + this.boardWidth / 2,
      this.boardY + this.boardHeight / 2,
      this.boardWidth * 0.7
    );
    grad.addColorStop(0, `rgba(0, 0, 0, ${THEME.opacity.label})`);
    grad.addColorStop(1, `rgba(0, 0, 0, ${THEME.opacity.overlay})`);
    ctx.fillStyle = grad;
    ctx.fillRect(this.boardX, this.boardY, this.boardWidth, this.boardHeight);

    // KO text — subtle white, matching controller style
    const koSize = Math.max(28, this.cellSize * 2.2);
    ctx.font = `900 ${koSize}px ${this._labelFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.letterSpacing = '0.1em';
    ctx.fillText(
      'KO',
      this.boardX + this.boardWidth / 2,
      this.boardY + this.boardHeight / 2
    );
    ctx.letterSpacing = '0px';

    // Scanlines over the darkened board
    ctx.fillStyle = `rgba(0, 0, 0, ${THEME.opacity.subtle})`;
    for (let y = this.boardY; y < this.boardY + this.boardHeight; y += 3) {
      ctx.fillRect(this.boardX, y, this.boardWidth, 1);
    }
  }

  drawMiniPiece(centerX, centerY, pieceType, size) {
    const ctx = this.ctx;
    const blocks = MINI_PIECES[pieceType];
    if (!blocks) return;

    const bounds = MINI_BOUNDS[pieceType];
    const typeId = PIECE_TYPE_TO_ID[pieceType];
    const color = PIECE_COLORS[typeId] || '#ffffff';

    // Center the piece within the given area
    const offsetX = centerX - (bounds.w * size) / 2;
    const offsetY = centerY - (bounds.h * size) / 2;

    for (const [bx, by] of blocks) {
      const dx = offsetX + (bx - bounds.minX) * size;
      const dy = offsetY + (by - bounds.minY) * size;
      const inset = 0.5;
      const r = THEME.radius.mini(size);

      // Mini block with gradient
      const grad = ctx.createLinearGradient(dx, dy, dx, dy + size);
      grad.addColorStop(0, color);
      grad.addColorStop(1, darkenColor(color, 15));
      ctx.fillStyle = grad;
      roundRect(ctx, dx + inset, dy + inset, size - inset * 2, size - inset * 2, r);
      ctx.fill();

      // Top highlight
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(dx + inset + r, dy + inset, size - inset * 2 - r * 2, 1);
    }
  }

  _drawPanel(x, y, w, h) {
    const ctx = this.ctx;
    const r = THEME.radius.panel(this.cellSize);
    const rgb = hexToRgb(this.accentColor);

    // Dark background matching board
    ctx.fillStyle = THEME.color.bg.board;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();

    // Player color tint (matches board)
    if (rgb) {
      ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${THEME.opacity.tint})`;
      roundRect(ctx, x, y, w, h, r);
      ctx.fill();
    }

    // Subtle player-color border (matches board)
    ctx.strokeStyle = rgb
      ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${THEME.opacity.soft})`
      : `rgba(255, 255, 255, ${THEME.opacity.tint})`;
    ctx.lineWidth = THEME.stroke.border;
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();
  }

  _getGarbageIndicatorAlpha(effect, now) {
    const elapsed = now - effect.startTime;
    if (elapsed < 0 || elapsed >= effect.duration) return 0;
    return effect.maxAlpha || 0.9;
  }
}

window.UIRenderer = UIRenderer;
