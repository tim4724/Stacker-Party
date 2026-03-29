'use strict';

class Animations {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = [];
  }

  addLineClear(boardX, boardY, cellSize, rows, isQuad) {
    if (!Array.isArray(rows) || rows.length === 0) return;

    const duration = THEME.timing.lineClear;
    const boardWidth = GameConstants.BOARD_WIDTH * cellSize;

    // Main line clear effect
    this.active.push({
      type: 'lineClear',
      startTime: performance.now(),
      duration,
      boardX,
      boardY,
      cellSize,
      rows,
      isQuad,
      boardWidth,
      render(ctx, progress) {
        const quadRgb = this.isQuad ? hexToRgb(THEME.color.quad) : null;
        for (const row of this.rows) {
          if (row < 0) continue;
          const ry = this.boardY + row * this.cellSize;
          const rh = this.cellSize;

          if (progress < 0.25) {
            // Phase 1: Bright flash sweep from center
            const flashProgress = progress / 0.25;
            const flashAlpha = 0.9 * (1 - flashProgress * 0.5);
            const sweepWidth = flashProgress * this.boardWidth;
            const sweepX = this.boardX + (this.boardWidth - sweepWidth) / 2;

            ctx.fillStyle = quadRgb
              ? `rgba(${quadRgb.r}, ${quadRgb.g}, ${quadRgb.b}, ${flashAlpha})`
              : `rgba(255, 255, 255, ${flashAlpha})`;
            ctx.fillRect(sweepX, ry, sweepWidth, rh);
          } else {
            // Phase 2: Dissolve with sparkle particles
            const fadeProgress = (progress - 0.25) / 0.75;
            const alpha = 0.5 * (1 - fadeProgress);

            // Scanline dissolve
            const stripeCount = 6;
            const stripeH = rh / stripeCount;
            for (let s = 0; s < stripeCount; s++) {
              const stripeAlpha = alpha * Math.max(0, 1 - (fadeProgress + s * 0.08));
              if (stripeAlpha <= 0) continue;
              const color = quadRgb
                ? `rgba(${quadRgb.r}, ${quadRgb.g}, ${quadRgb.b}, ${stripeAlpha})`
                : `rgba(255, 255, 255, ${stripeAlpha})`;
              ctx.fillStyle = color;
              // Stagger horizontal dissolve per stripe
              const shrink = fadeProgress * (s % 2 === 0 ? 1 : -1) * this.boardWidth * 0.3;
              const sx = this.boardX + (shrink > 0 ? shrink : 0);
              const sw = this.boardWidth - Math.abs(shrink);
              if (sw > 0) {
                ctx.fillRect(sx, ry + s * stripeH, sw, stripeH * 0.6);
              }
            }
          }
        }
      }
    });

    // Sparkle particles for each cleared row
    for (const row of rows) {
      if (row < 0) continue;
      const particleCount = isQuad ? 16 : 8;
      for (let i = 0; i < particleCount; i++) {
        this._addSparkle(
          boardX + Math.random() * boardWidth,
          boardY + row * cellSize + Math.random() * cellSize,
          isQuad ? THEME.color.quad : THEME.color.text.white,
          400 + Math.random() * 400,
          cellSize
        );
      }
    }

    // Text popup for clears that send garbage
    const firstRow = rows.find(r => r >= 0);
    if (firstRow != null) {
      const cx = boardX + 5 * cellSize;
      const cy = boardY + firstRow * cellSize;
      if (isQuad) {
        this.addTextPopup(cx, cy, 'QUAD!', THEME.color.quad, true, cellSize);
      } else if (rows.length === 3) {
        this.addTextPopup(cx, cy, 'TRIPLE!', THEME.color.triple, true, cellSize);
      } else if (rows.length === 2) {
        this.addTextPopup(cx, cy, 'DOUBLE', THEME.color.text.white, false, cellSize);
      }
    }
  }

  _addSparkle(x, y, color, duration, cellSize, sizeBase, sizeRange) {
    const vx = (Math.random() - 0.5) * 120;
    const vy = -Math.random() * 80 - 20;
    const cs = cellSize ?? 30;
    const base = sizeBase ?? 0.05;
    const range = sizeRange ?? 0.07;

    this.active.push({
      type: 'sparkle',
      startTime: performance.now(),
      duration,
      x, y, vx, vy, color,
      size: cs * (base + Math.random() * range),
      render(ctx, progress) {
        const t = progress * this.duration / 1000;
        const px = this.x + this.vx * t;
        const py = this.y + this.vy * t + 80 * t * t; // gravity
        const alpha = 1 - progress;
        const sz = this.size * (1 - progress * 0.5);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = this.color;
        ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        ctx.restore();
      }
    });
  }

  addLockFlash(boardX, boardY, cellSize, blocks, pieceColor) {
    if (!blocks || blocks.length === 0) return;

    // Build a set of occupied cells to skip internal edges
    const occupied = new Set();
    for (const [col, row] of blocks) {
      occupied.add(col + ',' + row);
    }

    // Colored sparkles only at exposed bottom edges
    for (const [col, row] of blocks) {
      if (row < 0 || row >= GameConstants.VISIBLE_HEIGHT) continue;
      // Skip if another block from this piece is directly below
      if (occupied.has(col + ',' + (row + 1))) continue;
      for (let j = 0; j < 5; j++) {
        this._addSparkle(
          boardX + (col + Math.random()) * cellSize,
          boardY + (row + 1) * cellSize,
          pieceColor,
          150 + Math.random() * 250,
          cellSize,
          0.08, 0.1
        );
      }
    }
  }

  addGarbageShake(boardX, boardY) {
    const duration = THEME.timing.garbageShake;
    this.active.push({
      type: 'shake',
      startTime: performance.now(),
      duration,
      boardX,
      boardY,
      offsetX: 0,
      offsetY: 0,
      update(progress) {
        const intensity = (1 - progress) * 2.4;
        const freq = 1 - progress * 0.5;
        this.offsetX = Math.sin(progress * 18) * intensity * freq;
        this.offsetY = Math.cos(progress * 20) * intensity * 0.18 * freq;
      },
      render() {
        // Shake is applied via canvas transform in the main render loop
      }
    });
  }

  addTextPopup(x, y, text, color, hasGlow, cellSize) {
    const duration = THEME.timing.textPopup;
    const font = getDisplayFont();
    const cs = cellSize ?? 30;

    this.active.push({
      type: 'textPopup',
      startTime: performance.now(),
      duration,
      x,
      y,
      text,
      color,
      hasGlow: hasGlow || false,
      font,
      cs,
      render(ctx, progress) {
        // Ease out for smooth motion
        const ease = 1 - Math.pow(1 - progress, 3);
        const alpha = progress < 0.8 ? 1 : 1 - (progress - 0.8) / 0.2;
        const drift = ease * this.cs * 1.7;
        const scale = progress < 0.15 ? 0.5 + (progress / 0.15) * 0.7 : 1.2 - ease * 0.2;

        ctx.save();
        ctx.translate(this.x, this.y - drift);
        ctx.scale(scale, scale);
        ctx.globalAlpha = alpha;

        if (this.hasGlow) {
          ctx.shadowColor = this.color;
          ctx.shadowBlur = this.cs * 0.53;
        }

        ctx.fillStyle = this.color;
        ctx.font = `900 ${this.cs * 0.73}px ${this.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.text, 0, 0);

        // White inner highlight
        if (this.hasGlow) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
          ctx.fillText(this.text, 0, -this.cs * 0.03);
        }

        ctx.restore();
      }
    });
  }

  addKO(boardX, boardY, boardWidth, boardHeight, cellSize) {
    const duration = THEME.timing.ko;

    // Red flash
    this.active.push({
      type: 'ko',
      startTime: performance.now(),
      duration,
      boardX,
      boardY,
      boardWidth,
      boardHeight,
      render(ctx, progress) {
        if (progress < 0.15) {
          // Initial white flash
          const flashAlpha = (1 - progress / 0.15) * 0.7;
          ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
          ctx.fillRect(this.boardX, this.boardY, this.boardWidth, this.boardHeight);
        } else if (progress < 0.4) {
          // Red vignette
          const redAlpha = ((0.4 - progress) / 0.25) * 0.4;
          ctx.fillStyle = `rgba(255, 0, 0, ${redAlpha})`;
          ctx.fillRect(this.boardX, this.boardY, this.boardWidth, this.boardHeight);
        }
      }
    });

    // Screen-edge red flash particles
    for (let i = 0; i < 12; i++) {
      this._addSparkle(
        boardX + Math.random() * boardWidth,
        boardY + Math.random() * boardHeight,
        THEME.color.ko.text,
        600 + Math.random() * 400,
        cellSize
      );
    }
  }

  /**
   * Update animation state. Pass the RAF timestamp for consistent timing.
   * @param {number} timestamp - DOMHighResTimeStamp from requestAnimationFrame
   */
  update(timestamp) {
    this.active = this.active.filter(anim => {
      const elapsed = timestamp - anim.startTime;
      const progress = Math.min(elapsed / anim.duration, 1);
      if (anim.update) {
        anim.update(progress);
      }
      return progress < 1;
    });
  }

  /**
   * Render all active animations. Pass the RAF timestamp for consistent timing.
   * @param {number} timestamp - DOMHighResTimeStamp from requestAnimationFrame
   */
  render(timestamp) {
    const ctx = this.ctx;

    for (const anim of this.active) {
      const elapsed = timestamp - anim.startTime;
      const progress = Math.min(elapsed / anim.duration, 1);
      if (anim.render) {
        anim.render(ctx, progress);
      }
    }
  }

  getShakeOffsetForBoard(boardX, boardY) {
    for (const anim of this.active) {
      if (anim.type === 'shake' && anim.boardX === boardX && anim.boardY === boardY) {
        return { x: anim.offsetX || 0, y: anim.offsetY || 0 };
      }
    }
    return { x: 0, y: 0 };
  }
}

window.Animations = Animations;
