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

  // 8×8 Bayer matrix (values 0–63). Finer than 4×4, less visible structure.
  // Used to dither the baked gradient at the 8-bit quantization step.
  static BAYER8 = [
    [ 0, 32,  8, 40,  2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];

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

  // `gradient` (optional): { cx, cy, tint: [r,g,b], alpha, stopEnd, bg: [r,g,b] }
  //   cx, cy in [0, 1] — ellipse center as fraction of canvas size
  //   stopEnd in (0, 1] — gradient fades to bg at this fraction of the
  //   farthest-corner distance (matches CSS `radial-gradient` defaults)
  //   alpha — peak tint weight at center (0–1)
  // When set, the render loop draws a pre-baked dithered gradient each frame
  // instead of clearing to transparent. Baked once per resize.
  constructor(canvas, poolSize = 15, gradient = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', gradient ? { alpha: false } : undefined);
    this.poolSize = poolSize;
    this.gradient = gradient;
    this.gradientBitmap = null;
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
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
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
    if (this.gradient) {
      this._bakeGradient();
      // Blit synchronously so the main canvas is valid before the first RAF
      // — otherwise the alpha:false opaque-black default paints over the
      // body's bg for ~16ms after each resize (visible flash in the gallery
      // where iframes load the page fresh). Guard for the zero-size case
      // where _bakeGradient bails out without setting gradientBitmap.
      if (this.gradientBitmap) {
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.drawImage(this.gradientBitmap, 0, 0, this.w, this.h);
        this.ctx.imageSmoothingEnabled = true;
      }
    }
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

  // Render the configured radial gradient into an offscreen bitmap.
  //
  // Anti-banding stack:
  //   1. Smoothstep falloff — zero derivative at both ends suppresses
  //      Mach-band perception at the inner/outer edges of the gradient.
  //   2. 8×8 Bayer ordered dither at ±1 LSB — finer pattern than 4×4 (64
  //      unique thresholds), enough amplitude to cross integer boundaries
  //      even in channels whose total delta is only 3–5 steps.
  //   3. sRGB-space interpolation to match the original design intent (a
  //      linear-light blend looks much brighter because the accent color
  //      dominates in linear terms).
  _bakeGradient() {
    const g = this.gradient;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(this.w * dpr);
    const ph = Math.round(this.h * dpr);
    if (pw <= 0 || ph <= 0) return;
    if (!this.gradientBitmap) this.gradientBitmap = document.createElement('canvas');
    const bmp = this.gradientBitmap;
    bmp.width = pw;
    bmp.height = ph;
    const bmpCtx = bmp.getContext('2d');
    const img = bmpCtx.createImageData(pw, ph);
    const data = img.data;

    const cxPx = g.cx * pw;
    const cyPx = g.cy * ph;
    const corner = Math.max(
      Math.hypot(cxPx, cyPx),
      Math.hypot(pw - cxPx, cyPx),
      Math.hypot(cxPx, ph - cyPx),
      Math.hypot(pw - cxPx, ph - cyPx),
    );
    const stopEndPx = g.stopEnd * corner;
    const invStopEnd = stopEndPx > 0 ? 1 / stopEndPx : 0;
    const bayer = WelcomeBackground.BAYER8;
    const peak = g.alpha;
    const tR = g.tint[0], tG = g.tint[1], tB = g.tint[2];
    const bR = g.bg[0],   bG = g.bg[1],   bB = g.bg[2];
    const dR = tR - bR, dG = tG - bG, dB = tB - bB;

    let idx = 0;
    for (let py = 0; py < ph; py++) {
      const dy = py - cyPx;
      const dy2 = dy * dy;
      // Pre-select per-channel rows so R/G/B are decorrelated on both axes
      // (not just columns) — prevents residual hue banding.
      const rrow = bayer[py & 7];
      const grow = bayer[(py + 3) & 7];
      const brrow = bayer[(py + 5) & 7];
      for (let px = 0; px < pw; px++) {
        const dx = px - cxPx;
        const d = Math.sqrt(dx * dx + dy2);
        let t = 0;
        if (d < stopEndPx) {
          const u = 1 - d * invStopEnd;
          t = u * u * (3 - 2 * u);           // smoothstep
        }
        const a = peak * t;
        // ±1 LSB Bayer dither, offset per channel on both axes.
        const dR8 = (rrow[px & 7] - 31.5) / 32;
        const dG8 = (grow[(px + 3) & 7] - 31.5) / 32;
        const dB8 = (brrow[(px + 5) & 7] - 31.5) / 32;
        // `| 0` truncates but doesn't clamp; values can land in [-1, 256]
        // at edges. Safe because `data` is Uint8ClampedArray (auto-clamps).
        data[idx]     = (bR + dR * a + dR8 + 0.5) | 0;
        data[idx + 1] = (bG + dG * a + dG8 + 0.5) | 0;
        data[idx + 2] = (bB + dB * a + dB8 + 0.5) | 0;
        data[idx + 3] = 255;
        idx += 4;
      }
    }
    bmpCtx.putImageData(img, 0, 0);
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
    if (this.gradientBitmap) {
      // Nearest-neighbor blit — any bilinear filtering smears the 1px Bayer
      // pattern back into visible bands.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.gradientBitmap, 0, 0, this.w, this.h);
      ctx.imageSmoothingEnabled = true;
    } else {
      ctx.clearRect(0, 0, this.w, this.h);
    }

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
