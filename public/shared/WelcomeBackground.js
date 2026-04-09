'use strict';

var _SQRT3 = Math.sqrt(3);

// Falling ghost-piece background animation for the welcome screen.
// Renders translucent piece silhouettes on a canvas behind the DOM overlay.
// Supports both classic (square blocks) and hex (hexagonal cells) modes.
//
// Piece data is derived from engine modules (GamePiece, HexPieceModule) at
// runtime so it stays in sync automatically when pieces change.

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
  // Populated once from engine modules via _syncFromEngine()
  static SHAPES = null;
  static PIECE_KEYS = null;
  static SHAPE_COLOR_INDEX = null;
  static HEX_SHAPES = null;
  static HEX_PIECE_KEYS = null;
  static HEX_SHAPE_COLOR_INDEX = null;
  static _synced = false;

  // Build classic piece shapes from GamePiece.PIECES.
  // Deduplicates rotations (e.g. O piece has 4 identical states).
  static _buildClassicShapes() {
    var src = GamePiece.PIECES;
    var shapes = {};
    for (var key in src) {
      var seen = [];
      shapes[key] = [];
      for (var i = 0; i < src[key].length; i++) {
        var sig = JSON.stringify(src[key][i]);
        if (seen.indexOf(sig) === -1) {
          seen.push(sig);
          shapes[key].push(src[key][i]);
        }
      }
    }
    return shapes;
  }

  // Build hex piece shapes from HexPieceModule.HEX_PIECES.
  // Generates all unique rotations for each piece type.
  static _buildHexShapes() {
    var src = HexPieceModule.HEX_PIECES;
    var shapes = {};
    for (var key in src) {
      shapes[key] = WelcomeBackground._generateHexRotations(src[key]);
    }
    return shapes;
  }

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

  // One-time initialization: read piece data from engine modules.
  static _syncFromEngine() {
    // Classic pieces
    WelcomeBackground.SHAPES = WelcomeBackground._buildClassicShapes();
    WelcomeBackground.PIECE_KEYS = Object.keys(WelcomeBackground.SHAPES);
    WelcomeBackground.SHAPE_COLOR_INDEX = GameConstants.PIECE_TYPE_TO_ID;

    // Hex pieces
    WelcomeBackground.HEX_SHAPES = WelcomeBackground._buildHexShapes();
    WelcomeBackground.HEX_PIECE_KEYS = Object.keys(WelcomeBackground.HEX_SHAPES);
    WelcomeBackground.HEX_SHAPE_COLOR_INDEX = HexConstants.HEX_PIECE_TYPE_TO_ID;
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
    this.mode = 'classic';

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

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // Replace all pool shapes with new mode shapes (keep positions/speeds)
    for (let i = 0; i < this.pool.length; i++) {
      const old = this.pool[i];
      const shape = this._makeShape();
      shape.x = old.x;
      shape.y = old.y;
      shape.speed = old.speed;
      this.pool[i] = shape;
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
    if (this.mode === 'hex') return this._makeHexShape();
    return this._makeClassicShape();
  }

  _makeClassicShape() {
    const key = WelcomeBackground.PIECE_KEYS[Math.floor(Math.random() * WelcomeBackground.PIECE_KEYS.length)];
    const rotations = WelcomeBackground.SHAPES[key];
    const rotated = rotations[Math.floor(Math.random() * rotations.length)];
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
      hex: false,
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

  _makeHexShape() {
    const keys = WelcomeBackground.HEX_PIECE_KEYS;
    const key = keys[Math.floor(Math.random() * keys.length)];
    const rotations = WelcomeBackground.HEX_SHAPES[key];
    const cells = rotations[Math.floor(Math.random() * rotations.length)];
    const blockSize = 12 + Math.random() * 20; // 12-32px (hex radius)
    const speed = 15 + (32 - blockSize) / 20 * 25;
    const boost = (key === 'T' || key === 'F') ? 0.03 : 0;
    const opacity = 0.05 + Math.random() * 0.04 + boost;

    const colorIdx = WelcomeBackground.HEX_SHAPE_COLOR_INDEX[key];
    const color = typeof PIECE_COLORS !== 'undefined' ? PIECE_COLORS[colorIdx] : '#4444ff';

    return {
      hex: true,
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

      ctx.globalAlpha = p.opacity;

      if (p.hex) {
        this._drawHexPiece(ctx, p);
      } else {
        this._drawClassicPiece(ctx, p);
      }

      ctx.globalAlpha = 1;
    }
  };

  _drawClassicPiece(ctx, p) {
    const size = p.blockSize;
    const hasStamps = typeof getBlockStamp === 'function';
    if (hasStamps) {
      const stamp = getBlockStamp(STYLE_TIERS.NORMAL, p.color, size);
      for (const [col, row] of p.blocks) {
        ctx.drawImage(stamp, p.x + col * size, p.y + row * size, stamp.cssW, stamp.cssH);
      }
    } else {
      const inset = size * 0.03;
      const s = size - inset * 2;
      const r = size * 0.12;
      for (const [col, row] of p.blocks) {
        const bx = p.x + col * size + inset;
        const by = p.y + row * size + inset;
        // Gradient fill
        const g = ctx.createLinearGradient(bx, by, bx, by + s);
        g.addColorStop(0, p.color);
        g.addColorStop(1, p.color);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.roundRect(bx, by, s, s, r);
        ctx.fill();
        // Darken bottom half
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.fillRect(bx + r, by + s * 0.5, s - r * 2, s * 0.5);
        // Top highlight
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(bx + r, by, s - r * 2, s * 0.1);
      }
    }
  }

  _drawHexPiece(ctx, p) {
    const size = p.blockSize;
    const sCell = size * 0.94;
    const hasStamps = typeof getHexStamp === 'function';
    if (hasStamps) {
      const stamp = getHexStamp(STYLE_TIERS.NORMAL, p.color, _SQRT3 * sCell);
      for (const [q, r] of p.cells) {
        const cx = p.x + size * 1.5 * q;
        const cy = p.y + size * _SQRT3 * (r + q / 2);
        ctx.drawImage(stamp, cx - stamp.cssW / 2, cy - stamp.cssH / 2, stamp.cssW, stamp.cssH);
      }
    } else {
      for (const [q, r] of p.cells) {
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
