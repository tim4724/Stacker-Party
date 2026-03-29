'use strict';

// Falling ghost-piece background animation for the welcome screen.
// Renders translucent piece silhouettes on a canvas behind the DOM overlay.

class WelcomeBackground {
  // Piece shapes (each is a list of [row, col] filled cells)
  static SHAPES = {
    I: [[0,0],[0,1],[0,2],[0,3]],
    O: [[0,0],[0,1],[1,0],[1,1]],
    T: [[0,0],[0,1],[0,2],[1,1]],
    S: [[0,1],[0,2],[1,0],[1,1]],
    Z: [[0,0],[0,1],[1,1],[1,2]],
    J: [[0,0],[1,0],[1,1],[1,2]],
    L: [[0,2],[1,0],[1,1],[1,2]],
  };

  static PIECE_KEYS = Object.keys(WelcomeBackground.SHAPES);

  // Maps shape key to PIECE_COLORS index (matches PIECE_TYPE_TO_ID)
  static SHAPE_COLOR_INDEX = { I: 1, O: 4, T: 6, S: 5, Z: 7, J: 2, L: 3 };

  constructor(canvas, poolSize = 15) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.poolSize = poolSize;
    this.pool = [];
    this.w = 0;
    this.h = 0;
    this.rafId = null;
    this.lastTime = null;
    this._initPool();
  }

  // --- Public API ---

  resize(w, h) {
    const dpr = window.devicePixelRatio || 1;
    this.w = w;
    this.h = h;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Scale pool positions proportionally to new dimensions
    const oldW = this._prevW || w;
    const oldH = this._prevH || h;
    for (const p of this.pool) {
      p.x = (p.x / oldW) * w;
      p.y = (p.y / oldH) * h;
    }
    this._prevW = w;
    this._prevH = h;
  }

  start() {
    if (this.rafId) return;
    this.lastTime = null;
    this.rafId = requestAnimationFrame(this._loop);
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastTime = null;
  }

  // --- Internals ---

  _initPool() {
    // Distribute pieces across a grid with jitter for blue-noise-like spacing.
    // Grid: columns across width, rows across 1.5x height (pieces start above screen).
    const cols = Math.ceil(Math.sqrt(this.poolSize * 1.5));
    const rows = Math.ceil(this.poolSize / cols);
    const w = this.w || window.innerWidth;
    const h = this.h || window.innerHeight;
    const cellW = w / cols;
    const cellH = (h * 1.5) / rows;
    let idx = 0;
    for (let r = 0; r < rows && idx < this.poolSize; r++) {
      for (let c = 0; c < cols && idx < this.poolSize; c++) {
        const shape = this._makeShape();
        // Place within grid cell with jitter (±40% of cell size)
        shape.x = cellW * (c + 0.1 + Math.random() * 0.8);
        shape.y = -(cellH * (r + 0.1 + Math.random() * 0.8));
        this.pool.push(shape);
        idx++;
      }
    }
    // Track column index for recycling
    this._nextCol = 0;
    this._cols = cols;
  }

  _makeShape() {
    const key = WelcomeBackground.PIECE_KEYS[Math.floor(Math.random() * WelcomeBackground.PIECE_KEYS.length)];
    const blocks = WelcomeBackground.SHAPES[key];
    const rotation = Math.floor(Math.random() * 4);
    const rotated = this._rotate(blocks, rotation);
    const blockSize = 16 + Math.random() * 32; // 16-48px
    // Larger shapes fall slower for parallax depth feel
    const speed = 15 + (48 - blockSize) / 32 * 25; // 15-40 px/s
    const drift = 0;
    // Base opacity close to original; boost low-luminance colors so they stay visible
    const boost = key === 'J' ? 0.06 : (key === 'T' || key === 'L') ? 0.03 : 0;
    const opacity = 0.05 + Math.random() * 0.04 + boost; // base 0.05-0.09

    // Use correct color for this piece type
    const colorIdx = WelcomeBackground.SHAPE_COLOR_INDEX[key];
    const color = typeof PIECE_COLORS !== 'undefined' ? PIECE_COLORS[colorIdx] : '#4444ff';

    return {
      blocks: rotated,
      blockSize,
      speed,
      drift,
      opacity,
      color,
      x: 0,
      y: 0,
    };
  }

  _recycleShape() {
    // Assign to next column slot with jitter for even horizontal distribution
    const w = this.w || window.innerWidth;
    const cellW = w / this._cols;
    const col = this._nextCol;
    this._nextCol = (this._nextCol + 1) % this._cols;

    const shape = this._makeShape();
    shape.x = cellW * (col + 0.1 + Math.random() * 0.8);
    shape.y = -shape.blockSize * 4 - Math.random() * 100;
    return shape;
  }

  _rotate(blocks, times) {
    let b = blocks;
    for (let t = 0; t < times; t++) {
      b = b.map(([r, c]) => [c, -r]);
    }
    // Normalize so min row/col = 0
    const minR = Math.min(...b.map(([r]) => r));
    const minC = Math.min(...b.map(([, c]) => c));
    return b.map(([r, c]) => [r - minR, c - minC]);
  }

  _loop = (timestamp) => {
    if (!this.canvas.isConnected) { this.stop(); return; }
    this.rafId = requestAnimationFrame(this._loop);

    if (this.lastTime === null) { this.lastTime = timestamp; return; }
    const dt = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    const maxY = this.h + 200;

    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      p.y += p.speed * dt;
      p.x += p.drift * dt;

      // Recycle off-screen shapes
      if (p.y > maxY) {
        this.pool[i] = this._recycleShape();
        continue;
      }

      // Draw blocks as rounded rects
      ctx.fillStyle = this._rgba(p.color, p.opacity);
      const r = Math.min(3, p.blockSize * 0.12);
      for (const [row, col] of p.blocks) {
        const bx = p.x + col * p.blockSize;
        const by = p.y + row * p.blockSize;
        ctx.beginPath();
        ctx.roundRect(bx, by, p.blockSize - 1, p.blockSize - 1, r);
        ctx.fill();
      }
    }
  };

  _rgba(hex, alpha) {
    let rgb = this._rgbCache && this._rgbCache[hex];
    if (!rgb) {
      if (!this._rgbCache) this._rgbCache = {};
      rgb = parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' + parseInt(hex.slice(5, 7), 16);
      this._rgbCache[hex] = rgb;
    }
    return `rgba(${rgb},${alpha})`;
  }
}
