'use strict';

// ============================================================
// Shared Canvas Utilities — used by BoardRenderer, UIRenderer,
// and display.js for common drawing operations
// ============================================================

var _hexToRgbCache = new Map();
function hexToRgb(hex) {
  let cached = _hexToRgbCache.get(hex);
  if (cached !== undefined) return cached;
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  cached = result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
  _hexToRgbCache.set(hex, cached);
  return cached;
}

// Feature-detect native ctx.roundRect (Chrome 99+, Safari 15.4+, Firefox 112+).
var _hasNativeRoundRect = false;
if (typeof document !== 'undefined') {
  try { _hasNativeRoundRect = typeof document.createElement('canvas').getContext('2d').roundRect === 'function'; } catch(e) {}
} else if (typeof OffscreenCanvas !== 'undefined') {
  try { _hasNativeRoundRect = typeof new OffscreenCanvas(1,1).getContext('2d').roundRect === 'function'; } catch(e) {}
}

// Add a rounded-rect sub-path (no beginPath — for compound paths / batching).
var _addRoundRectSubPath = _hasNativeRoundRect
  ? function(ctx, x, y, w, h, r) {
      ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
    }
  : function(ctx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

// Begin a new path + add a rounded rect (replaces old roundRect).
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  _addRoundRectSubPath(ctx, x, y, w, h, r);
}

var _lightenCache = new Map();
function lightenColor(hex, percent) {
  const key = hex + '_' + percent;
  let cached = _lightenCache.get(key);
  if (cached !== undefined) return cached;
  const rgb = hexToRgb(hex);
  if (!rgb) { _lightenCache.set(key, hex); return hex; }
  const factor = 1 + percent / 100;
  const r = Math.min(255, Math.round(rgb.r * factor));
  const g = Math.min(255, Math.round(rgb.g * factor));
  const b = Math.min(255, Math.round(rgb.b * factor));
  cached = `rgb(${r}, ${g}, ${b})`;
  _lightenCache.set(key, cached);
  return cached;
}

var _darkenCache = new Map();
function darkenColor(hex, percent) {
  const key = hex + '_' + percent;
  let cached = _darkenCache.get(key);
  if (cached !== undefined) return cached;
  const rgb = hexToRgb(hex);
  if (!rgb) { _darkenCache.set(key, hex); return hex; }
  const factor = 1 - percent / 100;
  const r = Math.round(rgb.r * factor);
  const g = Math.round(rgb.g * factor);
  const b = Math.round(rgb.b * factor);
  cached = `rgb(${r}, ${g}, ${b})`;
  _darkenCache.set(key, cached);
  return cached;
}

// Precomputed unit vertices for flat-top hexagons (0°, 60°, 120°, ...).
// Flat array [cos0, sin0, cos1, sin1, ...] for cache-line friendliness.
var HEX_UNIT_VERTICES = [];
for (var _vi = 0; _vi < 6; _vi++) {
  var _va = Math.PI / 3 * _vi;
  HEX_UNIT_VERTICES.push(Math.cos(_va), Math.sin(_va));
}

// Trace a flat-top hex path centered at (cx, cy) with circumradius `size`.
function hexPath(ctx, cx, cy, size) {
  ctx.beginPath();
  ctx.moveTo(cx + size * HEX_UNIT_VERTICES[0], cy + size * HEX_UNIT_VERTICES[1]);
  for (var i = 2; i < 12; i += 2) {
    ctx.lineTo(cx + size * HEX_UNIT_VERTICES[i], cy + size * HEX_UNIT_VERTICES[i + 1]);
  }
  ctx.closePath();
}

// Compute ghost-piece colors from any hex piece color.
// Lightens dark channels for visibility on dark backgrounds, with alpha
// scaled by luminance (darker pieces get higher alpha).
// Returns { outline: 'rgba(...)', fill: 'rgba(...)' } for direct use in rendering.
var _ghostColorCache = new Map();
function ghostColor(hex) {
  var cached = _ghostColorCache.get(hex);
  if (cached) return cached;
  const rgb = hexToRgb(hex);
  if (!rgb) return { outline: 'rgba(255,255,255,0.3)', fill: 'rgba(255,255,255,0.15)' };
  var r = Math.min(255, Math.max(80, Math.round(rgb.r + (255 - rgb.r) * 0.3)));
  var g = Math.min(255, Math.max(80, Math.round(rgb.g + (255 - rgb.g) * 0.3)));
  var b = Math.min(255, Math.max(80, Math.round(rgb.b + (255 - rgb.b) * 0.3)));
  var lum = (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) / 255;
  var a = +(0.3 + (1 - lum) * 0.15).toFixed(2);
  var fillA = +(a * 0.5).toFixed(2);
  var result = {
    outline: 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')',
    fill: 'rgba(' + r + ',' + g + ',' + b + ',' + fillA + ')'
  };
  _ghostColorCache.set(hex, result);
  return result;
}

// ============================================================
// Offscreen block stamp cache — pre-renders each (tier, color,
// cellSize) block to a small canvas so the main render loop
// can blit with a single drawImage() call.
// ============================================================
var _stampCache = new Map();

function _createStampCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  var c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}

function getBlockStamp(tier, color, cellSize) {
  var size = Math.round(cellSize);
  var key = tier + '_' + color + '_' + size;
  var stamp = _stampCache.get(key);
  if (stamp) return stamp;
  var inset = size * THEME.size.blockGap;
  var s = size - inset * 2;
  var r = THEME.radius.block(size);
  var oc = _createStampCanvas(size);
  var c = oc.getContext('2d');

  if (tier === STYLE_TIERS.PILLOW) {
    _stampPillow(c, size, inset, s, r, color);
  } else if (tier === STYLE_TIERS.NEON_FLAT) {
    _stampNeonFlat(c, size, inset, s, r, color);
  } else {
    _stampNormal(c, size, inset, s, r, color);
  }

  _stampCache.set(key, oc);
  return oc;
}

function getMiniBlockStamp(tier, color, miniSize) {
  var size = Math.round(miniSize);
  var key = 'mi_' + tier + '_' + color + '_' + size;
  var stamp = _stampCache.get(key);
  if (stamp) return stamp;
  var inset = size * THEME.size.blockGap;
  var s = size - inset * 2;
  var r = THEME.radius.mini(size);
  var oc = _createStampCanvas(size);
  var c = oc.getContext('2d');

  if (tier === STYLE_TIERS.PILLOW) {
    _stampPillow(c, size, inset, s, r, color);
  } else if (tier === STYLE_TIERS.NEON_FLAT) {
    _stampNeonFlat(c, size, inset, s, r, color);
  } else {
    _stampMiniNormal(c, size, inset, s, r, color);
  }

  _stampCache.set(key, oc);
  return oc;
}

function getGarbageStamp(cellSize) {
  var size = Math.round(cellSize);
  var key = 'g_' + size;
  var stamp = _stampCache.get(key);
  if (stamp) return stamp;
  var inset = size * THEME.size.blockGap;
  var s = size - inset * 2;
  var r = THEME.radius.block(size);
  var oc = _createStampCanvas(size);
  var c = oc.getContext('2d');

  c.fillStyle = THEME.color.garbage;
  roundRect(c, inset, inset, s, s, r);
  c.fill();
  c.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.faint + ')';
  c.fillRect(inset * 2, inset * 2, s - inset * 2, inset);

  _stampCache.set(key, oc);
  return oc;
}

function clearStampCache() {
  _stampCache.clear();
}

// ============================================================
// Hex stamp cache — pre-renders each (tier, color, hexSize)
// hexagon to an offscreen canvas for single drawImage() blits.
// ============================================================

function _createHexStampCanvas(hexSize) {
  var w = Math.ceil(2 * hexSize) + 2;   // +2 for stroke bleed
  var h = Math.ceil(Math.sqrt(3) * hexSize) + 2;
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function getHexStamp(tier, color, hexSize) {
  // Use rounded-tenth key to avoid cache explosion from float drift,
  // but render at exact size to prevent blurriness
  var sizeKey = Math.round(hexSize * 10);
  var key = 'hx_' + tier + '_' + color + '_' + sizeKey;
  var stamp = _stampCache.get(key);
  if (stamp) return stamp;
  var size = hexSize;
  var oc = _createHexStampCanvas(size);
  var c = oc.getContext('2d');
  var cx = size + 1, cy = oc.height / 2;  // +1 for stroke padding

  if (tier === STYLE_TIERS.PILLOW) {
    _stampHexPillow(c, cx, cy, size, color);
  } else if (tier === STYLE_TIERS.NEON_FLAT) {
    _stampHexNeonFlat(c, cx, cy, size, color);
  } else {
    _stampHexNormal(c, cx, cy, size, color);
  }

  _stampCache.set(key, oc);
  return oc;
}

function getMiniHexStamp(tier, color, hexSize) {
  var sizeKey = Math.round(hexSize * 10);
  var key = 'mhx_' + tier + '_' + color + '_' + sizeKey;
  var stamp = _stampCache.get(key);
  if (stamp) return stamp;
  var size = hexSize;
  var oc = _createHexStampCanvas(size);
  var c = oc.getContext('2d');
  var cx = size + 1, cy = oc.height / 2;

  if (tier === STYLE_TIERS.PILLOW) {
    _stampHexPillow(c, cx, cy, size, color);
  } else if (tier === STYLE_TIERS.NEON_FLAT) {
    _stampHexNeonFlat(c, cx, cy, size, color);
  } else {
    _stampHexMiniNormal(c, cx, cy, size, color);
  }

  _stampCache.set(key, oc);
  return oc;
}

function _stampHexNormal(c, cx, cy, size, color) {
  // Clip to hex shape
  hexPath(c, cx, cy, size);
  c.save();
  c.clip();
  // Gradient fill
  var ng = c.createLinearGradient(cx, cy - size, cx, cy + size);
  ng.addColorStop(0, lightenColor(color, 15));
  ng.addColorStop(1, darkenColor(color, 10));
  c.fillStyle = ng;
  c.fill();
  // Top highlight
  c.fillStyle = 'rgba(255,255,255,' + THEME.opacity.highlight + ')';
  c.fillRect(cx - size * 0.5, cy - size * 0.88, size, size * 0.12);
  // Left highlight
  c.fillStyle = 'rgba(255,255,255,' + THEME.opacity.muted + ')';
  c.fillRect(cx - size * 0.9, cy - size * 0.5, size * 0.1, size);
  // Bottom shadow
  c.fillStyle = 'rgba(0,0,0,' + THEME.opacity.shadow + ')';
  c.fillRect(cx - size * 0.5, cy + size * 0.76, size, size * 0.12);
  // Inner shine
  c.fillStyle = 'rgba(255,255,255,' + THEME.opacity.subtle + ')';
  var sh = size * 0.3;
  c.fillRect(cx - size * 0.3, cy - size * 0.4, sh, sh * 0.5);
  c.restore();
  // Border
  hexPath(c, cx, cy, size);
  c.strokeStyle = 'rgba(255,255,255,0.15)';
  c.lineWidth = 1.5;
  c.stroke();
}

function _stampHexPillow(c, cx, cy, size, color) {
  // Flat fill
  hexPath(c, cx, cy, size);
  c.fillStyle = color;
  c.fill();
  // Clip + radial gradient
  var rgb = hexToRgb(color);
  var lum = rgb ? (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) / 255 : 0.5;
  var hiAlpha = 0.14 + lum * 0.46;
  hexPath(c, cx, cy, size);
  c.save();
  c.clip();
  var g = c.createRadialGradient(cx - size * 0.1, cy - size * 0.2, 0, cx, cy, size * 0.9);
  g.addColorStop(0, 'rgba(255,255,255,' + hiAlpha.toFixed(2) + ')');
  g.addColorStop(0.6, 'rgba(255,255,255,0.03)');
  g.addColorStop(1, 'rgba(0,0,0,0.2)');
  c.fillStyle = g;
  c.fill();
  c.restore();
  // Top edge highlight
  var edgeAlpha = 0.12 + lum * 0.38;
  c.strokeStyle = 'rgba(255,255,255,' + edgeAlpha.toFixed(2) + ')';
  c.lineWidth = Math.max(0.5, size * 0.05);
  c.beginPath();
  c.moveTo(cx + size * HEX_UNIT_VERTICES[8], cy + size * HEX_UNIT_VERTICES[9]);   // vertex 4
  c.lineTo(cx + size * HEX_UNIT_VERTICES[10], cy + size * HEX_UNIT_VERTICES[11]); // vertex 5
  c.stroke();
  // Bottom edge shadow
  c.strokeStyle = 'rgba(0,0,0,0.25)';
  c.beginPath();
  c.moveTo(cx + size * HEX_UNIT_VERTICES[2], cy + size * HEX_UNIT_VERTICES[3]);  // vertex 1
  c.lineTo(cx + size * HEX_UNIT_VERTICES[4], cy + size * HEX_UNIT_VERTICES[5]);  // vertex 2
  c.stroke();
}

function _stampHexNeonFlat(c, cx, cy, size, color) {
  var rgb = hexToRgb(color);
  if (!rgb) return;
  // Dark fill
  var darkFill = 'rgba(' + (rgb.r * 0.2 | 0) + ',' + (rgb.g * 0.2 | 0) + ',' + (rgb.b * 0.2 | 0) + ',0.92)';
  hexPath(c, cx, cy, size);
  c.fillStyle = darkFill;
  c.fill();
  // Colored border
  var bw = Math.max(1, size * 0.12);
  c.strokeStyle = color;
  c.lineWidth = bw;
  hexPath(c, cx, cy, size);
  c.stroke();
  // Top highlight line (vertices 4→5)
  c.globalAlpha = 0.25;
  c.beginPath();
  c.moveTo(cx + size * 0.85 * HEX_UNIT_VERTICES[8], cy + size * 0.85 * HEX_UNIT_VERTICES[9]);
  c.lineTo(cx + size * 0.85 * HEX_UNIT_VERTICES[10], cy + size * 0.85 * HEX_UNIT_VERTICES[11]);
  c.strokeStyle = '#fff';
  c.lineWidth = Math.max(0.5, size * 0.04);
  c.stroke();
  c.globalAlpha = 1;
}

function _stampHexMiniNormal(c, cx, cy, size, color) {
  hexPath(c, cx, cy, size);
  c.save();
  c.clip();
  var mg = c.createLinearGradient(cx, cy - size, cx, cy + size);
  mg.addColorStop(0, color);
  mg.addColorStop(1, darkenColor(color, 15));
  c.fillStyle = mg;
  c.fill();
  c.fillStyle = 'rgba(255,255,255,' + THEME.opacity.highlight + ')';
  c.fillRect(cx - size * 0.5, cy - size * 0.88, size, size * 0.1);
  c.restore();
}

// --- Square stamp drawing helpers (draw at 0,0 on offscreen context) ---

function _stampNormal(c, size, inset, s, r, color) {
  var g = c.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, lightenColor(color, 15));
  g.addColorStop(1, darkenColor(color, 10));
  c.fillStyle = g;
  roundRect(c, inset, inset, s, s, r);
  c.fill();
  c.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.highlight + ')';
  c.fillRect(inset + r, inset, s - r * 2, size * 0.08);
  c.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.muted + ')';
  c.fillRect(inset, inset + r, size * 0.07, s - r * 2);
  c.fillStyle = 'rgba(0, 0, 0, ' + THEME.opacity.shadow + ')';
  c.fillRect(inset + r, size - inset - size * 0.08, s - r * 2, size * 0.08);
  c.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.subtle + ')';
  var sh = size * 0.25;
  c.fillRect(size * 0.25, size * 0.2, sh, sh * 0.5);
}

function _stampPillow(c, size, inset, s, r, color) {
  c.fillStyle = color;
  roundRect(c, inset, inset, s, s, r);
  c.fill();
  // Scale highlight/shadow intensity by luminance — dark colors (blue) get softer
  // highlights to avoid looking blown out compared to bright colors (yellow, cyan).
  var rgb = hexToRgb(color);
  var lum = rgb ? (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) / 255 : 0.5;
  var hiAlpha = 0.14 + lum * 0.46;   // dark ~0.14, bright ~0.60
  var edgeAlpha = 0.12 + lum * 0.38; // dark ~0.12, bright ~0.50
  var half = size / 2;
  var g = c.createRadialGradient(half * 0.9, half * 0.8, 0, half, half, size * 0.65);
  g.addColorStop(0, 'rgba(255, 255, 255, ' + hiAlpha.toFixed(2) + ')');
  g.addColorStop(0.6, 'rgba(255, 255, 255, 0.03)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.2)');
  c.fillStyle = g;
  roundRect(c, inset, inset, s, s, r);
  c.fill();
  c.strokeStyle = 'rgba(255, 255, 255, ' + edgeAlpha.toFixed(2) + ')';
  c.lineWidth = Math.max(0.5, size * 0.04);
  c.beginPath();
  c.moveTo(inset + r, inset + size * 0.015);
  c.lineTo(inset + s - r, inset + size * 0.015);
  c.stroke();
  c.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  c.beginPath();
  c.moveTo(inset + r, inset + s - size * 0.015);
  c.lineTo(inset + s - r, inset + s - size * 0.015);
  c.stroke();
}

function _stampNeonFlat(c, size, inset, s, r, color) {
  var rgb = hexToRgb(color);
  if (!rgb) return;
  var bw = Math.max(1, size * 0.08);
  var half = bw / 2;
  c.fillStyle = 'rgba(' + (rgb.r * 0.2 | 0) + ',' + (rgb.g * 0.2 | 0) + ',' + (rgb.b * 0.2 | 0) + ',0.92)';
  roundRect(c, inset, inset, s, s, r);
  c.fill();
  c.strokeStyle = color;
  c.lineWidth = bw;
  roundRect(c, inset + half, inset + half, s - bw, s - bw, r);
  c.stroke();
  c.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  c.lineWidth = Math.max(0.5, size * 0.025);
  c.beginPath();
  c.moveTo(inset + r + bw, inset + bw);
  c.lineTo(size - inset - r - bw, inset + bw);
  c.stroke();
}

function _stampMiniNormal(c, size, inset, s, r, color) {
  var g = c.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, color);
  g.addColorStop(1, darkenColor(color, 15));
  c.fillStyle = g;
  roundRect(c, inset, inset, s, s, r);
  c.fill();
  c.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.highlight + ')';
  c.fillRect(inset + r, inset, s - r * 2, size * 0.06);
}

// Shared font detection — returns the preferred display font family string.
// Checks whether Orbitron has loaded; falls back to monospace.
// Re-checks on each font load event until Orbitron is detected.
var _fontLoaded = false;
if (typeof document !== 'undefined' && document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('loadingdone', function() {
    if (!_fontLoaded) {
      _fontLoaded = document.fonts?.check?.('700 12px Orbitron') ?? false;
    }
  });
}
function getDisplayFont() {
  if (!_fontLoaded) {
    _fontLoaded = document.fonts?.check?.('700 12px Orbitron') ?? false;
  }
  return _fontLoaded ? 'Orbitron' : '"Courier New", monospace';
}
