'use strict';

var _SQRT3 = Math.sqrt(3);

// Falling ghost-piece background animation for the welcome screen.
// Renders translucent hex piece silhouettes on a canvas behind the DOM overlay.
//
// Piece data is derived from PieceModule at runtime so it stays in sync
// automatically when pieces change.

// Inline flat-top hex path for use when CanvasUtils.js is not loaded (controller).
function _wbHexPath(ctx, cx, cy, size) {
  if (typeof hexPath === 'function') { hexPath(ctx, cx, cy, size); return; }
  ctx.beginPath();
  for (var i = 0; i < 6; i++) {
    var a = Math.PI / 3 * i;
    var x = cx + size * Math.cos(a);
    var y = cy + size * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

class WelcomeBackground {
  // Populated once from PieceModule via _syncFromEngine()
  static SHAPES = null;
  static PIECE_KEYS = null;
  static SHAPE_COLOR_INDEX = null;
  static _synced = false;

  // Generate all unique rotations of a hex piece via repeated 60° CW rotation.
  static _generateHexRotations(baseCells) {
    var rotations = [baseCells];
    var current = baseCells;
    for (var i = 0; i < 5; i++) {
      var next = [];
      for (var j = 0; j < current.length; j++) {
        // rotateCW in axial: (q, r) → (-r, q + r)
        next.push([-current[j][1], current[j][0] + current[j][1]]);
      }
      current = next;
      var sig = JSON.stringify(current);
      var isDupe = false;
      for (var k = 0; k < rotations.length; k++) {
        if (JSON.stringify(rotations[k]) === sig) { isDupe = true; break; }
      }
      if (!isDupe) rotations.push(current);
    }
    return rotations;
  }

  // Opacity boost derived from perceived luminance of the piece color.
  // Low-luminance colors get a boost so background pieces stay visible on
  // the dark canvas. ITU-R BT.601 luma: 0.299R + 0.587G + 0.114B.
  static _opacityBoost(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return 0;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 115) return 0.12;
    if (lum < 135) return 0.06;
    return 0;
  }

  // One-time initialization: read piece data from PieceModule.
  static _syncFromEngine() {
    var src = PieceModule.PIECES;
    var shapes = {};
    for (var key in src) {
      shapes[key] = WelcomeBackground._generateHexRotations(src[key]);
    }
    WelcomeBackground.SHAPES = shapes;
    WelcomeBackground.PIECE_KEYS = Object.keys(shapes);
    WelcomeBackground.SHAPE_COLOR_INDEX = GameConstants.PIECE_TYPE_TO_ID;
  }

  constructor(canvas, poolSize = 15) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.poolSize = poolSize;
    this.pool = [];
    this.w = 0;
    this.h = 0;
    this.rafId = null;
    this.lastTime = null;

    if (!WelcomeBackground._synced) {
      WelcomeBackground._syncFromEngine();
      WelcomeBackground._synced = true;
    }

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
    const keys = WelcomeBackground.PIECE_KEYS;
    const key = keys[Math.floor(Math.random() * keys.length)];
    const rotations = WelcomeBackground.SHAPES[key];
    const cells = rotations[Math.floor(Math.random() * rotations.length)];
    const blockSize = 12 + Math.random() * 20; // 12-32px (hex radius)
    const speed = 15 + (32 - blockSize) / 20 * 25;

    const colorIdx = WelcomeBackground.SHAPE_COLOR_INDEX[key];
    const color = typeof PIECE_COLORS !== 'undefined' ? PIECE_COLORS[colorIdx] : '#4444ff';

    const boost = WelcomeBackground._opacityBoost(color);
    const opacity = 0.14 + Math.random() * 0.08 + boost;

    return {
      cells: cells,
      blockSize,
      speed,
      drift: 0,
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

  _loop = (timestamp) => {
    if (!this.canvas.isConnected) { this.stop(); return; }
    this.rafId = requestAnimationFrame(this._loop);

    if (this.lastTime === null) { this.lastTime = timestamp; return; }
    // Clamp dt so pieces don't teleport off-screen after tab unfreeze or a
    // long frame stall. 50ms matches the game loop's MAX_FRAME_DELTA_MS.
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
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

      ctx.globalAlpha = p.opacity;
      this._drawPiece(ctx, p);
      ctx.globalAlpha = 1;
    }
  };

  _drawPiece(ctx, p) {
    const size = p.blockSize;
    const sCell = size * 0.94;
    const cells = p.cells;
    const hasStamps = typeof getHexStamp === 'function';
    if (hasStamps) {
      const stamp = getHexStamp(STYLE_TIERS.NORMAL, p.color, _SQRT3 * sCell);
      for (let i = 0; i < cells.length; i++) {
        const q = cells[i][0], r = cells[i][1];
        const cx = p.x + size * 1.5 * q;
        const cy = p.y + size * _SQRT3 * (r + q / 2);
        ctx.drawImage(stamp, cx - stamp.cssW / 2, cy - stamp.cssH / 2, stamp.cssW, stamp.cssH);
      }
    } else {
      for (let i = 0; i < cells.length; i++) {
        const q = cells[i][0], r = cells[i][1];
        const cx = p.x + size * 1.5 * q;
        const cy = p.y + size * _SQRT3 * (r + q / 2);
        // Base fill
        _wbHexPath(ctx, cx, cy, sCell);
        ctx.fillStyle = p.color;
        ctx.fill();
        // Darken bottom half via clip
        _wbHexPath(ctx, cx, cy, sCell);
        ctx.save();
        ctx.clip();
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.fillRect(cx - sCell, cy, sCell * 2, sCell);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(cx - sCell * 0.5, cy - sCell * 0.88, sCell, sCell * 0.12);
        ctx.restore();
      }
    }
  }
}
