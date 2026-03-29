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

const PIECE_TYPE_TO_ID = GameConstants.PIECE_TYPE_TO_ID;

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
  }

  render(playerState, timestamp) {
    // Update style tier from level
    this._styleTier = getStyleTier(playerState.level || 1);

    // 1. Player name + accent stripe above board
    this.drawPlayerName(playerState);

    // 2. Hold piece panel (left of board)
    this.drawHoldPanel(playerState);

    // 3. Next pieces panel (right of board)
    this.drawNextPanel(playerState);

    // 4. Garbage meter (left edge of board)
    if (playerState.pendingGarbage > 0) {
      this.drawGarbageMeter(playerState.pendingGarbage);
    }

    // 5b. Transient attacker-colored tint on newly appeared garbage meter blocks
    if (playerState.garbageIndicatorEffects && playerState.garbageIndicatorEffects.length > 0) {
      this.drawGarbageIndicatorEffects(playerState.garbageIndicatorEffects, timestamp);
    }

    // 5c. Defence flash — green flash on cancelled garbage meter rows
    if (playerState.garbageDefenceEffects && playerState.garbageDefenceEffects.length > 0) {
      this.drawGarbageDefenceEffects(playerState.garbageDefenceEffects, timestamp);
    }

    // 6. KO overlay
    if (playerState.alive === false) {
      this.drawKOOverlay();
    }
  }

  drawPlayerName(playerState) {
    const ctx = this.ctx;
    const name = playerState.playerName || PLAYER_NAMES[this.playerIndex] || ('Player ' + (this.playerIndex + 1));
    const nameY = this.boardY - this.cellSize * 0.13;
    const fontSize = Math.max(THEME.font.minPx.name, this.cellSize * THEME.font.cellScale.name);

    // Name text
    ctx.fillStyle = playerState.playerColor || THEME.color.text.white;
    ctx.font = `700 ${fontSize}px ${getDisplayFont()}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(name, this.boardX + this.cellSize * 0.07, nameY - this.cellSize * 0.07);

    // Lines + level badge on right side
    const lvlSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label);
    ctx.font = `700 ${lvlSize}px ${getDisplayFont()}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.label})`;
    const lines = playerState.lines || 0;
    const level = playerState.level || 1;
    ctx.fillText(`Lines ${lines}  Level ${level}`, this.boardX + this.boardWidth - this.cellSize * 0.07, nameY - this.cellSize * 0.07);
  }

  drawHoldPanel(playerState) {
    const ctx = this.ctx;
    const panelY = this.boardY;
    const labelSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label);
    const boxSize = this.miniSize * THEME.size.panelWidth;
    // Right-align the box to sit next to the board (mirroring next panel)
    const panelX = this.boardX - this.panelGap - boxSize;

    // Label
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.label})`;
    ctx.font = `700 ${labelSize}px ${getDisplayFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText('HOLD', panelX + boxSize / 2, panelY);
    ctx.letterSpacing = '0px';

    // Panel background with rounded rect
    const boxY = panelY + labelSize + this.cellSize * 0.2;
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
    const labelSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label);
    const boxWidth = this.miniSize * THEME.size.panelWidth;
    const pieceSpacing = this.miniSize * 3;
    const startY = panelY + labelSize + this.cellSize * 0.2;

    // Label
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.label})`;
    ctx.font = `700 ${labelSize}px ${getDisplayFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText('NEXT', panelX + boxWidth / 2, panelY);
    ctx.letterSpacing = '0px';

    // Panel background
    const nextCount = playerState.nextPieces ? Math.min(playerState.nextPieces.length, 3) : 0;
    const boxHeight = pieceSpacing * Math.max(nextCount, 3);
    this._drawPanel(panelX, startY, boxWidth, boxHeight);

    // Next pieces
    if (playerState.nextPieces) {
      for (let i = 0; i < Math.min(playerState.nextPieces.length, 3); i++) {
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

  getGarbageMeterLayout() {
    return {
      x: this.boardX - this.cellSize * 1.07,
      y: this.boardY,
      cellSize: this.cellSize,
      rows: GameConstants.VISIBLE_HEIGHT
    };
  }

  drawGarbageMeter(pendingGarbage) {
    const ctx = this.ctx;
    const meter = this.getGarbageMeterLayout();
    const rows = Math.min(pendingGarbage, meter.rows);
    if (rows === 0) return;
    const inset = meter.cellSize * THEME.size.blockGap;
    const r = THEME.radius.block(meter.cellSize);
    const bw = meter.cellSize - inset * 2;
    const bh = meter.cellSize - inset * 2;

    // Batched stroke: one compound path for all cells
    ctx.beginPath();
    for (let i = 0; i < rows; i++) {
      const y = meter.y + this.boardHeight - (i + 1) * meter.cellSize;
      _addRoundRectSubPath(ctx, meter.x + inset + 0.5, y + inset + 0.5, bw - 1, bh - 1, r);
    }
    ctx.strokeStyle = `rgba(255, 255, 255, ${THEME.opacity.label})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Batched fill: one compound path for all cells
    ctx.beginPath();
    for (let i = 0; i < rows; i++) {
      const y = meter.y + this.boardHeight - (i + 1) * meter.cellSize;
      _addRoundRectSubPath(ctx, meter.x + inset, y + inset, bw, bh, r);
    }
    ctx.fillStyle = `rgba(255, 255, 255, ${THEME.opacity.muted})`;
    ctx.fill();
  }

  drawGarbageIndicatorEffects(effects, timestamp) {
    if (!Array.isArray(effects) || effects.length === 0) return;

    const ctx = this.ctx;
    const meter = this.getGarbageMeterLayout();
    const now = timestamp || performance.now();
    const inset = meter.cellSize * THEME.size.blockGap;
    const r = THEME.radius.block(meter.cellSize);
    const bw = meter.cellSize - inset * 2;
    const bh = meter.cellSize - inset * 2;

    try {
      for (const effect of effects) {
        const elapsed = now - effect.startTime;
        if (elapsed < 0 || elapsed >= effect.duration) continue;
        ctx.globalAlpha = (1 - elapsed / effect.duration) * (effect.maxAlpha || 0.9);

        for (let row = effect.rowStart; row < effect.rowStart + effect.lines; row++) {
          if (row < 0 || row >= meter.rows) continue;
          const y = meter.y + row * meter.cellSize;
          const bx = meter.x + inset;
          const by = y + inset;
          ctx.fillStyle = effect.color;
          roundRect(ctx, bx, by, bw, bh, r);
          ctx.fill();
          ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.fillRect(bx + inset, by + inset, bw - inset * 2, inset);
        }
      }
    } finally {
      ctx.globalAlpha = 1.0;
    }
  }

  drawGarbageDefenceEffects(effects, timestamp) {
    if (!Array.isArray(effects) || effects.length === 0) return;

    const ctx = this.ctx;
    const meter = this.getGarbageMeterLayout();
    const now = timestamp || performance.now();
    const inset = meter.cellSize * THEME.size.blockGap;
    const r = THEME.radius.block(meter.cellSize);
    const bw = meter.cellSize - inset * 2;
    const bh = meter.cellSize - inset * 2;

    try {
      for (const effect of effects) {
        const elapsed = now - effect.startTime;
        if (elapsed < 0 || elapsed >= effect.duration) continue;
        ctx.globalAlpha = (1 - elapsed / effect.duration) * (effect.maxAlpha || 0.9);

        for (let row = effect.rowStart; row < effect.rowStart + effect.lines; row++) {
          if (row < 0 || row >= meter.rows) continue;
          const y = meter.y + row * meter.cellSize;
          const bx = meter.x + inset;
          const by = y + inset;
          ctx.fillStyle = THEME.color.text.white;
          roundRect(ctx, bx, by, bw, bh, r);
          ctx.fill();
          ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
          ctx.fillRect(bx + inset, by + inset, bw - inset * 2, inset);
        }
      }
    } finally {
      ctx.globalAlpha = 1.0;
    }
  }

  drawKOOverlay() {
    const ctx = this.ctx;

    // Darken the board
    ctx.fillStyle = `rgba(0, 0, 0, ${THEME.opacity.label})`;
    ctx.fillRect(this.boardX, this.boardY, this.boardWidth, this.boardHeight);

    // KO text — subtle, matching controller style
    const koSize = this.cellSize * 2.2;
    ctx.font = `900 ${koSize}px Orbitron, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillText(
      'KO',
      this.boardX + this.boardWidth / 2,
      this.boardY + this.boardHeight / 2
    );
  }

  drawDisconnectedOverlay(qrImg, playerColor) {
    const ctx = this.ctx;
    const bx = this.boardX, by = this.boardY, bw = this.boardWidth, bh = this.boardHeight;

    ctx.fillStyle = 'rgba(0, 0, 0, ' + THEME.opacity.overlay + ')';
    ctx.fillRect(bx, by, bw, bh);

    const labelSize = Math.max(10, this.cellSize * THEME.font.cellScale.name);
    const labelGap = labelSize * 1.2;
    const qrSize = Math.min(bw, bh) * 0.5;
    const qrRadius = qrSize * 0.08;
    const pad = qrSize * 0.06;
    const outerSize = qrSize + pad * 2;
    const totalH = outerSize + labelGap + labelSize;
    const groupY = by + (bh - totalH) / 2;
    const outerX = bx + (bw - outerSize) / 2;

    ctx.fillStyle = THEME.color.text.white;
    ctx.beginPath();
    ctx.roundRect(outerX, groupY, outerSize, outerSize, qrRadius);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0, 200, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (qrImg) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(outerX + pad, groupY + pad, qrSize, qrSize, Math.max(1, qrRadius - pad));
      ctx.clip();
      ctx.drawImage(qrImg, outerX + pad, groupY + pad, qrSize, qrSize);
      ctx.restore();
    }

    ctx.fillStyle = playerColor || 'rgba(0, 200, 255, 0.7)';
    ctx.font = '600 ' + labelSize + 'px ' + getDisplayFont();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.1em';
    ctx.fillText('SCAN TO REJOIN', bx + bw / 2, groupY + outerSize + labelGap);
    ctx.letterSpacing = '0px';
  }

  drawMiniPiece(centerX, centerY, pieceType, size) {
    const blocks = MINI_PIECES[pieceType];
    if (!blocks) return;

    const bounds = MINI_BOUNDS[pieceType];
    const typeId = PIECE_TYPE_TO_ID[pieceType];
    const tier = this._styleTier;
    const isNeon = tier === STYLE_TIERS.NEON_FLAT;
    const color = (isNeon ? NEON_PIECE_COLORS[typeId] : PIECE_COLORS[typeId]) || '#ffffff';
    const stamp = getMiniBlockStamp(tier, color, size);

    const offsetX = centerX - (bounds.w * size) / 2;
    const offsetY = centerY - (bounds.h * size) / 2;

    for (const [bx, by] of blocks) {
      this.ctx.drawImage(stamp,
        offsetX + (bx - bounds.minX) * size,
        offsetY + (by - bounds.minY) * size);
    }
  }

  _drawPanel(x, y, w, h) {
    const ctx = this.ctx;
    const r = THEME.radius.panel(this.cellSize);
    const rgb = this._accentRgb;

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
    ctx.lineWidth = this.cellSize * THEME.stroke.border;
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();
  }

}

window.UIRenderer = UIRenderer;
