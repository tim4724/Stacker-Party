'use strict';

// ============================================================
// Design Tokens — single source of truth for the visual layer
// ============================================================

// --- Tetromino colors (index matches PIECE_TYPE_TO_ID: 1=I … 7=Z) ---
const PIECE_COLORS = {
  0: '#000000',    // empty
  1: '#00F0F0',    // I - cyan
  2: '#0000F0',    // J - blue
  3: '#F0A000',    // L - orange
  4: '#F0F000',    // O - yellow
  5: '#00F000',    // S - green
  6: '#A000F0',    // T - purple
  7: '#F00000',    // Z - red
  8: '#808080'     // garbage - gray
};

// Ghost piece colors — lightened with higher opacity for dark-background visibility.
// Low-luminance hues (blue, purple, red) get extra boost.
const GHOST_COLORS = {
  1: 'rgba(80, 240, 240, 0.38)',   // I - cyan
  2: 'rgba(140, 140, 255, 0.4)',   // J - blue  (lightened to compensate low luminance)
  3: 'rgba(240, 180, 60, 0.4)',    // L - orange
  4: 'rgba(240, 240, 80, 0.35)',   // O - yellow (highest luminance)
  5: 'rgba(80, 240, 80, 0.35)',    // S - green
  6: 'rgba(200, 120, 255, 0.4)',   // T - purple (lightened to compensate low luminance)
  7: 'rgba(255, 80, 80, 0.45)'    // Z - red
};

// Player accent colors
const PLAYER_COLORS = [
  '#FF6B6B', // Player 1 - red
  '#4ECDC4', // Player 2 - teal
  '#FFE66D', // Player 3 - yellow
  '#A78BFA', // Player 4 - purple
  '#FF9F43', // Player 5 - orange
  '#54A0FF', // Player 6 - blue
  '#FF6FB5', // Player 7 - pink
  '#1DD1A1'  // Player 8 - mint
];

const PLAYER_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6', 'Player 7', 'Player 8'];

// --- Theme tokens ---
const THEME = Object.freeze({

  // ---- Colors ----
  color: Object.freeze({
    bg: Object.freeze({
      primary:   '#06060f',
      board:     '#080810',
      secondary: '#0c0c1a',
      card:      '#12122a',
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
    medal: Object.freeze({
      gold:   '#ffd700',
      silver: '#c0c0c0',
      bronze: '#cd7f32',
    }),
    ko: Object.freeze({
      text: '#ff4444',
      glow: 'rgba(255, 50, 50, 0.6)',
    }),
    btn: Object.freeze({
      greenText: '#003d1f',
    }),
    // Animation-specific named colors
    tetris:  '#00ffff',
    triple:  '#ffaa00',
    combo:   '#ffe66d',
    tSpin:   '#a000f0',
  }),

  // ---- Opacities ----
  opacity: Object.freeze({
    faint:     0.04,  // noise textures, barely-there tints
    tint:      0.06,  // player color surface tints
    subtle:    0.08,  // ghost fills, inner shines, scanlines
    muted:     0.10,  // grid lines, dot patterns
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
    mini:  (size) => size * 0.1,
    panel: (size) => size * 0.2,
  }),

  // ---- Stroke Widths (× cellSize) ----
  stroke: Object.freeze({
    grid:   0.02,
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
      name:  0.55,
      label: 0.38,
      score: 0.7,
      timer: 0.52,
      mini:  0.6,
    }),
    minPx: Object.freeze({
      name:  16,
      label: 12,
      score: 18,
      timer: 14,
    }),
  }),

  // ---- Sizing Constants ----
  size: Object.freeze({
    panelWidth:  4.5,   // cellSize multiplier for panel width
    panelGap:    0.25,  // panel-to-board gap (× cellSize)
    canvasPad:   5,     // canvas edge padding px
    boardInset:  0.035, // block inset from cell edge (× cellSize)
  }),
});

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { THEME, PIECE_COLORS, GHOST_COLORS, PLAYER_COLORS, PLAYER_NAMES };
}
