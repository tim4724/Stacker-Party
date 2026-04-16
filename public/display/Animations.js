'use strict';

var _NO_SHAKE = Object.freeze({ x: 0, y: 0 });
var _shakeResult = { x: 0, y: 0 };

class Animations {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = [];
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
        var t = progress * this.duration / 1000;
        var px = this.x + this.vx * t;
        var py = this.y + this.vy * t + 80 * t * t; // gravity
        var sz = this.size * (1 - progress * 0.5);
        ctx.globalAlpha = 1 - progress;
        ctx.fillStyle = this.color;
        ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        ctx.globalAlpha = 1;
      }
    });
  }

  addHexCellClear(br, cells, linesCleared) {
    if (!Array.isArray(cells) || cells.length === 0) return;
    var duration = THEME.timing.lineClear;
    var isQuad = linesCleared >= 4;
    var isTriple = linesCleared === 3;

    // Capture renderer values by value so the closure doesn't hold a stale br reference
    // (calculateLayout clears animations.active before rebuilding renderers).
    var boardX = br.x, boardY = br.y, hexSize = br.hexSize;
    var hexH = br.hexH, colW = br.colW;

    // Pre-compute cell positions (avoids per-frame recalculation)
    var cellPositions = [];
    for (var pi = 0; pi < cells.length; pi++) {
      var col = cells[pi][0], row = cells[pi][1];
      if (row >= 0) {
        cellPositions.push({
          x: boardX + colW * col + hexSize,
          y: boardY + hexH * (row + 0.5 * (col & 1)) + hexH / 2
        });
      }
    }
    var quadColor = isQuad ? THEME.color.quad : '#ffffff';

    function hexCenter(col, row) {
      return {
        x: boardX + colW * col + hexSize,
        y: boardY + hexH * (row + 0.5 * (col & 1)) + hexH / 2
      };
    }

    this.active.push({
      type: 'hexCellClear',
      startTime: performance.now(),
      duration: duration,
      render: function(ctx, progress) {
        ctx.fillStyle = quadColor;
        if (progress < 0.25) {
          ctx.globalAlpha = 0.9 * (1 - (progress / 0.25) * 0.5);
          for (var ci = 0; ci < cellPositions.length; ci++) {
            hexPath(ctx, cellPositions[ci].x, cellPositions[ci].y, hexSize);
            ctx.fill();
          }
        } else {
          var fadeAlpha = 0.5 * (1 - (progress - 0.25) / 0.75);
          if (fadeAlpha <= 0) { ctx.globalAlpha = 1; return; }
          ctx.globalAlpha = fadeAlpha;
          var shrink = hexSize * (1 - (progress - 0.25));
          for (var ci = 0; ci < cellPositions.length; ci++) {
            hexPath(ctx, cellPositions[ci].x, cellPositions[ci].y, shrink);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
    });

    // Text popup for multi-line clears
    var firstCell = cells.find(function(c) { return c[1] >= 0; });
    if (firstCell) {
      var pos = hexCenter(Math.floor(GameConstants.COLS / 2), firstCell[1]);
      if (isQuad) {
        this.addTextPopup(pos.x, pos.y, t('quad'), THEME.color.quad, true, br.cellSize);
      } else if (isTriple) {
        this.addTextPopup(pos.x, pos.y, t('triple'), THEME.color.triple, true, br.cellSize);
      } else if (linesCleared === 2) {
        this.addTextPopup(pos.x, pos.y, t('double'), THEME.color.text.white, false, br.cellSize);
      }
    }

    // Sparkle particles
    for (var si = 0; si < cells.length; si++) {
      var sc = cells[si][0], sr = cells[si][1];
      if (sr < 0) continue;
      var sparkPos = hexCenter(sc, sr);
      var particleCount = isQuad ? 4 : 2;
      for (var j = 0; j < particleCount; j++) {
        this._addSparkle(
          sparkPos.x + (Math.random() - 0.5) * hexSize * 2,
          sparkPos.y,
          isQuad ? THEME.color.quad : '#ffffff',
          200 + Math.random() * 400,
          hexSize
        );
      }
    }
  }

  addHexLockFlash(br, blocks, pieceColor) {
    if (!blocks || blocks.length === 0) return;
    var occupied = new Set();
    for (var i = 0; i < blocks.length; i++) occupied.add(blocks[i][0] + ',' + blocks[i][1]);
    for (var k = 0; k < blocks.length; k++) {
      var col = blocks[k][0], row = blocks[k][1];
      if (row < 0 || row >= GameConstants.VISIBLE_ROWS) continue;
      if (occupied.has(col + ',' + (row + 1))) continue;
      var pos = br._hexCenter(col, row);
      for (var j = 0; j < 5; j++) {
        this._addSparkle(
          pos.x + (Math.random() - 0.5) * br.hexW,
          pos.y + br.hexSize,
          pieceColor,
          150 + Math.random() * 250,
          br.cellSize,
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
    var duration = THEME.timing.textPopup;
    var cs = cellSize ?? 30;
    var fontStr = '900 ' + (cs * 0.73) + 'px ' + getDisplayFont();
    var shadowSize = cs * 0.53;
    var highlightY = -cs * 0.03;

    this.active.push({
      type: 'textPopup',
      startTime: performance.now(),
      duration,
      x,
      y,
      text,
      color,
      hasGlow: hasGlow || false,
      fontStr,
      cs,
      shadowSize,
      highlightY,
      render(ctx, progress) {
        // Ease out for smooth motion
        var ease = 1 - Math.pow(1 - progress, 3);
        var alpha = progress < 0.8 ? 1 : 1 - (progress - 0.8) / 0.2;

        ctx.save();
        ctx.translate(this.x, this.y - ease * this.cs * 1.7);
        ctx.scale(progress < 0.15 ? 0.5 + (progress / 0.15) * 0.7 : 1.2 - ease * 0.2, progress < 0.15 ? 0.5 + (progress / 0.15) * 0.7 : 1.2 - ease * 0.2);
        ctx.globalAlpha = alpha;

        if (this.hasGlow) {
          ctx.shadowColor = this.color;
          ctx.shadowBlur = this.shadowSize;
        }

        ctx.fillStyle = this.color;
        ctx.font = this.fontStr;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.text, 0, 0);

        // White inner highlight
        if (this.hasGlow) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
          ctx.fillText(this.text, 0, this.highlightY);
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
          ctx.globalAlpha = (1 - progress / 0.15) * 0.7;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(this.boardX, this.boardY, this.boardWidth, this.boardHeight);
          ctx.globalAlpha = 1;
        } else if (progress < 0.4) {
          // Red vignette
          ctx.globalAlpha = ((0.4 - progress) / 0.25) * 0.4;
          ctx.fillStyle = '#ff0000';
          ctx.fillRect(this.boardX, this.boardY, this.boardWidth, this.boardHeight);
          ctx.globalAlpha = 1;
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
    var arr = this.active;
    var write = 0;
    for (var i = 0; i < arr.length; i++) {
      var anim = arr[i];
      // Prune animations that completed on the previous frame (already rendered at progress=1)
      if (anim._progress >= 1) continue;
      var elapsed = timestamp - anim.startTime;
      var progress = Math.min(elapsed / anim.duration, 1);
      anim._progress = progress;
      if (anim.update) anim.update(progress);
      arr[write++] = anim; // keep even if progress===1 so render() draws the final frame
    }
    arr.length = write;
  }

  /**
   * Render all active animations. Pass the RAF timestamp for consistent timing.
   * @param {number} timestamp - DOMHighResTimeStamp from requestAnimationFrame
   */
  render(timestamp) {
    const ctx = this.ctx;

    for (const anim of this.active) {
      if (anim.render) {
        anim.render(ctx, anim._progress ?? 0);
      }
    }
  }

  getShakeOffsetForBoard(boardX, boardY) {
    for (var i = 0; i < this.active.length; i++) {
      var anim = this.active[i];
      if (anim.type === 'shake' && anim.boardX === boardX && anim.boardY === boardY) {
        _shakeResult.x = anim.offsetX || 0;
        _shakeResult.y = anim.offsetY || 0;
        return _shakeResult;
      }
    }
    return _NO_SHAKE;
  }
}

window.Animations = Animations;
