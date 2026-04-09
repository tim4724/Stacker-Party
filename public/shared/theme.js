'use strict';

// ============================================================
// Design Tokens — single source of truth for the visual layer
// ============================================================

// --- Piece colors (1=I…7=Z, shared by square and hex modes, garbage: 8-9) ---
const PIECE_COLORS = {
  0: '#000000',    // empty
  1: '#EE4444',    // I - red
  2: '#00CED1',    // J - teal
  3: '#FFD700',    // L - gold
  4: '#7FFF00',    // O - lime
  5: '#9B59F0',    // S - violet
  6: '#FF1493',    // T - hot pink
  7: '#FF8C00',    // Z - amber
  8: '#33AAFF',    // classic garbage - sky blue
  9: '#808080'     // hex garbage - gray
};

// Ghost piece colors — computed from PIECE_COLORS via ghostColor() (CanvasUtils.js).
// Requires CanvasUtils.js to be loaded first (see index.html script order).
var GHOST_COLORS = {};
if (typeof ghostColor === 'function') {
  for (var _i = 1; _i <= 8; _i++) GHOST_COLORS[_i] = ghostColor(PIECE_COLORS[_i]);
} else if (typeof document !== 'undefined') {
  console.warn('ghostColor() not available — CanvasUtils.js must load before theme.js');
}

// Player accent colors
const PLAYER_COLORS = [
  '#FF6B6B', // Player 1 - red
  '#4ECDC4', // Player 2 - teal
  '#FFE66D', // Player 3 - yellow
  '#A78BFA', // Player 4 - purple
  '#7BED6F', // Player 5 - green
  '#FF44CC', // Player 6 - hot magenta
  '#5B7FFF', // Player 7 - indigo
  '#FF7F50'  // Player 8 - coral
];

const PLAYER_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6', 'Player 7', 'Player 8'];

// Neon piece colors — brighter variants for visibility on dark background.
// Falls back to PIECE_COLORS for entries not overridden.
const NEON_PIECE_COLORS = Object.assign({}, PIECE_COLORS, {
  2: '#33E8EC',    // J - brighter teal
  5: '#B580FF',    // S - brighter violet
  7: '#FFB340'     // Z - brighter amber
});

// Neon ghost colors — computed from NEON_PIECE_COLORS
var NEON_GHOST_COLORS = {};
if (typeof ghostColor === 'function') {
  for (var _n = 1; _n <= 8; _n++) NEON_GHOST_COLORS[_n] = ghostColor(NEON_PIECE_COLORS[_n]);
}

// Level-based style tiers
const STYLE_TIERS = Object.freeze({
  NORMAL: 'normal',         // Lv 1–5
  PILLOW: 'pillow',         // Lv 6–10
  NEON_FLAT: 'neonFlat'     // Lv 11+
});

function getStyleTier(level) {
  if (level >= 11) return STYLE_TIERS.NEON_FLAT;
  if (level >= 6)  return STYLE_TIERS.PILLOW;
  return STYLE_TIERS.NORMAL;
}

// --- Theme tokens ---
const THEME = Object.freeze({

  // ---- Colors ----
  color: Object.freeze({
    bg: Object.freeze({
      primary:   '#06060f',
      board:     '#0c0c12',
      secondary: '#12121c',
      card:      '#1a1a2a',
    }),
    text: Object.freeze({
      primary: '#e0e0ff',
      white:   '#ffffff',
    }),
    accent: Object.freeze({
      blue:      '#4444ff',
      cyan:      '#00ccff',
      green:     '#00ff88',
      greenDark: '#00dd77',
    }),
    danger:  '#ff4444',
    garbage: '#3a3a4e',
    ko: Object.freeze({
      text: '#ff4444',
      glow: 'rgba(255, 50, 50, 0.6)',
    }),
    btn: Object.freeze({
      greenText: '#003d1f',
    }),
    // Animation-specific named colors
    quad:    '#ee4444',
    triple:  '#ffd700',
  }),

  // ---- Opacities ----
  opacity: Object.freeze({
    faint:     0.04,  // noise textures, barely-there tints
    tint:      0.06,  // player color surface tints
    subtle:    0.08,  // ghost fills, inner shines, scanlines
    muted:     0.10,  // dot patterns
    grid:      0.18,  // grid lines
    soft:      0.15,  // borders, soft accents
    highlight: 0.22,  // block top highlight
    shadow:    0.25,  // block bottom shadow
    label:     0.6,   // panel labels, toolbar text
    strong:    0.7,   // prominent text
    overlay:   0.75,  // dark overlays
    panel:     0.9,   // card/panel backgrounds
  }),

  // ---- Border Radii (functions of cell/block size) ----
  radius: Object.freeze({
    block: (size) => size * 0.12,
    panel: (size) => size * 0.2,
  }),

  // ---- Stroke Widths (× cellSize) ----
  stroke: Object.freeze({
    grid:   0.03,
    border: 0.04,
    ghost:  0.05,
  }),

  // ---- Animation Timing (ms) ----
  timing: Object.freeze({
    lineClear:    600,
    garbageShake: 180,
    textPopup:    1200,
    ko:           1800,
  }),

  // ---- Font Size Multipliers (× cellSize) with minimum px floors ----
  font: Object.freeze({
    cellScale: Object.freeze({
      name:  0.7,
      label: 0.48,
      timer: 0.65,
      mini:  0.6,
    }),
    minPx: Object.freeze({
      name:  18,
      label: 14,
      timer: 16,
    }),
  }),

  // ---- Sizing Constants ----
  size: Object.freeze({
    panelWidth:  4.5,   // cellSize multiplier for panel width
    panelGap:    0.25,  // panel-to-board gap (× cellSize)
    canvasPad:   5,     // canvas edge padding px
    blockGap:    0.03,  // half-gap between blocks (× cellSize)
  }),
});

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  // IMPORTANT: _gc must mirror ghostColor() in CanvasUtils.js — keep in sync!
  var _gc = function(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return { outline: 'rgba(255,255,255,0.3)', fill: 'rgba(255,255,255,0.15)' };
    var rv = parseInt(m[1],16), gv = parseInt(m[2],16), bv = parseInt(m[3],16);
    var r = Math.min(255, Math.max(80, Math.round(rv + (255-rv)*0.3)));
    var g = Math.min(255, Math.max(80, Math.round(gv + (255-gv)*0.3)));
    var b = Math.min(255, Math.max(80, Math.round(bv + (255-bv)*0.3)));
    var lum = (rv*0.299 + gv*0.587 + bv*0.114) / 255;
    var a = +(0.3 + (1-lum)*0.15).toFixed(2);
    var fillA = +(a * 0.5).toFixed(2);
    return {
      outline: 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')',
      fill: 'rgba(' + r + ',' + g + ',' + b + ',' + fillA + ')'
    };
  };
  for (var _k = 1; _k <= 8; _k++) {
    if (!GHOST_COLORS[_k]) GHOST_COLORS[_k] = _gc(PIECE_COLORS[_k]);
    if (!NEON_GHOST_COLORS[_k]) NEON_GHOST_COLORS[_k] = _gc(NEON_PIECE_COLORS[_k]);
  }
  module.exports = { THEME, PIECE_COLORS, GHOST_COLORS, NEON_PIECE_COLORS, NEON_GHOST_COLORS, STYLE_TIERS, getStyleTier, PLAYER_COLORS, PLAYER_NAMES };
}
