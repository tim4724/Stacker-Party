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

var _SQRT3 = Math.sqrt(3);

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

// Rounded-corner flat-top hex path. `radius` is the corner arc radius.
// Starts at the midpoint of the V5→V0 edge so the first arcTo has a valid tangent.
function hexPathRounded(ctx, cx, cy, size, radius) {
  if (radius <= 0) { hexPath(ctx, cx, cy, size); return; }
  var V = HEX_UNIT_VERTICES;
  ctx.beginPath();
  ctx.moveTo(cx + size * (V[10] + V[0]) / 2, cy + size * (V[11] + V[1]) / 2);
  for (var i = 0; i < 6; i++) {
    var a = (i * 2) % 12;
    var b = ((i + 1) * 2) % 12;
    ctx.arcTo(cx + size * V[a], cy + size * V[a + 1],
              cx + size * V[b], cy + size * V[b + 1], radius);
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
// Hex stamp cache — pre-renders each (tier, color, size) hex
// to an offscreen canvas for single drawImage() blits.
// Rendered at devicePixelRatio resolution for crisp display.
// size = drawn cell height.
// ============================================================
var _stampCache = new Map();
var _stampDpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;

function clearStampCache() {
  _stampDpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  _stampCache.clear();
}

function getHexStamp(tier, color, size) {
  var sizeKey = Math.round(size * 10);
  var key = 'hx_' + tier + '_' + color + '_' + sizeKey + '_' + _stampDpr;
  var stamp = _stampCache.get(key);
  if (stamp) return stamp;
  var cr = size / _SQRT3;  // circumradius for hex path
  // Pad enough for the widest stroke any tier draws (NEON_FLAT bw = size*0.08,
  // half-stroke bleeds outside the path). +1 extra for sub-pixel safety.
  var pad = Math.max(2, Math.ceil(size * 0.04) + 1);
  var w = Math.ceil(2 * cr) + pad * 2;
  var h = Math.ceil(size) + pad * 2;
  var pw = Math.ceil(w * _stampDpr);
  var ph = Math.ceil(h * _stampDpr);
  var oc;
  if (typeof OffscreenCanvas !== 'undefined') oc = new OffscreenCanvas(pw, ph);
  else { oc = document.createElement('canvas'); oc.width = pw; oc.height = ph; }
  oc.cssW = w;
  oc.cssH = h;
  var c = oc.getContext('2d');
  c.setTransform(_stampDpr, 0, 0, _stampDpr, 0, 0);
  var cx = cr + pad, cy = h / 2;

  if (tier === STYLE_TIERS.PILLOW) {
    _stampHexPillow(c, cx, cy, cr, size, color);
  } else if (tier === STYLE_TIERS.NEON_FLAT) {
    _stampHexNeonFlat(c, cx, cy, cr, size, color);
  } else {
    _stampHexNormal(c, cx, cy, cr, size, color);
  }

  _stampCache.set(key, oc);
  return oc;
}

function _stampHexNormal(c, cx, cy, cr, size, color) {
  // cr = circumradius (for hex path), size = drawn height (for proportions)
  hexPath(c, cx, cy, cr);
  c.save();
  c.clip();
  var ng = c.createLinearGradient(cx, cy - cr, cx, cy + cr);
  ng.addColorStop(0, lightenColor(color, 15));
  ng.addColorStop(1, darkenColor(color, 10));
  c.fillStyle = ng;
  c.fill();
  c.fillStyle = 'rgba(255,255,255,' + THEME.opacity.highlight + ')';
  c.fillRect(cx - cr * 0.5, cy - cr * 0.88, cr, size * 0.08);
  c.fillStyle = 'rgba(0,0,0,' + THEME.opacity.shadow + ')';
  c.fillRect(cx - cr * 0.5, cy + cr * 0.76, cr, size * 0.08);
  c.fillStyle = 'rgba(255,255,255,' + THEME.opacity.subtle + ')';
  var sh = size * 0.35;
  c.fillRect(cx - cr * 0.35, cy - cr * 0.5, sh, sh * 0.36);
  c.restore();
}

function _stampHexPillow(c, cx, cy, cr, size, color) {
  var cornerR = cr * 0.15;
  var lineInset = cornerR / _SQRT3;  // pull highlight/shadow lines inside the rounded corner
  hexPathRounded(c, cx, cy, cr, cornerR);
  c.fillStyle = color;
  c.fill();
  hexPathRounded(c, cx, cy, cr, cornerR);
  c.save();
  c.clip();
  var g = c.createRadialGradient(cx - cr * 0.05, cy - cr * 0.1, 0, cx, cy, cr * 1.1);
  g.addColorStop(0, 'rgba(255,255,255,0.3)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fill();
  c.restore();
  c.strokeStyle = 'rgba(255,255,255,0.3)';
  c.lineWidth = Math.max(0.5, size * 0.04);
  c.beginPath();
  c.moveTo(cx + cr * HEX_UNIT_VERTICES[8] + lineInset, cy + cr * HEX_UNIT_VERTICES[9]);
  c.lineTo(cx + cr * HEX_UNIT_VERTICES[10] - lineInset, cy + cr * HEX_UNIT_VERTICES[11]);
  c.stroke();
  c.strokeStyle = 'rgba(0,0,0,0.25)';
  c.beginPath();
  c.moveTo(cx + cr * HEX_UNIT_VERTICES[2] - lineInset, cy + cr * HEX_UNIT_VERTICES[3]);
  c.lineTo(cx + cr * HEX_UNIT_VERTICES[4] + lineInset, cy + cr * HEX_UNIT_VERTICES[5]);
  c.stroke();
}

function _stampHexNeonFlat(c, cx, cy, cr, size, color) {
  var rgb = hexToRgb(color);
  if (!rgb) return;
  var darkFill = 'rgb(' + (rgb.r * 0.3 | 0) + ',' + (rgb.g * 0.3 | 0) + ',' + (rgb.b * 0.3 | 0) + ')';
  hexPath(c, cx, cy, cr);
  c.fillStyle = darkFill;
  c.fill();
  var bw = Math.max(1, size * 0.08);
  c.strokeStyle = color;
  c.lineWidth = bw;
  hexPath(c, cx, cy, cr);
  c.stroke();
  var insetScale = 1 - bw / cr;
  c.globalAlpha = 0.45;
  c.beginPath();
  c.moveTo(cx + cr * insetScale * HEX_UNIT_VERTICES[8], cy + cr * insetScale * HEX_UNIT_VERTICES[9]);
  c.lineTo(cx + cr * insetScale * HEX_UNIT_VERTICES[10], cy + cr * insetScale * HEX_UNIT_VERTICES[11]);
  c.strokeStyle = lightenColor(color, 20);
  c.lineWidth = Math.max(0.5, size * 0.032);
  c.stroke();
  c.globalAlpha = 1;
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
