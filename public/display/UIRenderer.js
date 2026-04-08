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

var _getIndicatorColor = function(e) { return e.color; };
var _getDefenceColor = function() { return THEME.color.text.white; };

class UIRenderer extends BaseUIRenderer {
  getGarbageMeterLayout() {
    // cx = center of meter cell (matches hex meter positioning)
    var cx = this.boardX - this.cellSize * 1.07;
    return {
      x: cx - this.cellSize / 2,
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

  _drawGarbageEffects(effects, timestamp, getColor, highlightAlpha) {
    if (!Array.isArray(effects) || effects.length === 0) return;

    const ctx = this.ctx;
    const meter = this.getGarbageMeterLayout();
    const now = timestamp || performance.now();
    const inset = meter.cellSize * THEME.size.blockGap;
    const r = THEME.radius.block(meter.cellSize);
    const bw = meter.cellSize - inset * 2;
    const bh = meter.cellSize - inset * 2;
    const bx = meter.x + inset;

    try {
      for (const effect of effects) {
        const elapsed = now - effect.startTime;
        if (elapsed < 0 || elapsed >= effect.duration) continue;
        ctx.globalAlpha = (1 - elapsed / effect.duration) * (effect.maxAlpha || 0.9);

        // Batched fill: compound path for all rows in this effect
        ctx.beginPath();
        for (let row = effect.rowStart; row < effect.rowStart + effect.lines; row++) {
          if (row < 0 || row >= meter.rows) continue;
          const by = meter.y + row * meter.cellSize + inset;
          _addRoundRectSubPath(ctx, bx, by, bw, bh, r);
        }
        ctx.fillStyle = getColor(effect);
        ctx.fill();

        // Batched highlight stripe
        ctx.fillStyle = 'rgba(255, 255, 255, ' + highlightAlpha + ')';
        for (let row = effect.rowStart; row < effect.rowStart + effect.lines; row++) {
          if (row < 0 || row >= meter.rows) continue;
          const by = meter.y + row * meter.cellSize + inset;
          ctx.fillRect(bx + inset, by + inset, bw - inset * 2, inset);
        }
      }
    } finally {
      ctx.globalAlpha = 1.0;
    }
  }

  drawGarbageIndicatorEffects(effects, timestamp) {
    this._drawGarbageEffects(effects, timestamp, _getIndicatorColor, 0.2);
  }

  drawGarbageDefenceEffects(effects, timestamp) {
    this._drawGarbageEffects(effects, timestamp, _getDefenceColor, 0.3);
  }

  drawMiniPiece(centerX, centerY, pieceType, size) {
    const blocks = MINI_PIECES[pieceType];
    if (!blocks) return;

    const bounds = MINI_BOUNDS[pieceType];
    const typeId = PIECE_TYPE_TO_ID[pieceType];
    const tier = this._styleTier;
    const isNeon = tier === STYLE_TIERS.NEON_FLAT;
    const color = (isNeon ? NEON_PIECE_COLORS[typeId] : PIECE_COLORS[typeId]) || '#ffffff';
    const stamp = getBlockStamp(tier, color, size);

    const offsetX = centerX - (bounds.w * size) / 2;
    const offsetY = centerY - (bounds.h * size) / 2;

    for (const [bx, by] of blocks) {
      this.ctx.drawImage(stamp,
        offsetX + (bx - bounds.minX) * size,
        offsetY + (by - bounds.minY) * size,
        stamp.cssW, stamp.cssH);
    }
  }

}

window.UIRenderer = UIRenderer;
