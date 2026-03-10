'use strict';

// UMD: works in Node.js (require) and browser (window.GameConstants)
(function(exports) {

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 24; // 20 visible + 4 buffer
const VISIBLE_HEIGHT = 20;
const BUFFER_ROWS = 4;

// Gravity: frames per cell drop at each level (60fps base)
// Standard guideline gravity curve
const GRAVITY_TABLE = [
  48, 43, 38, 33, 28, 23, 18, 13, 8, 6, // levels 0-9
  5, 5, 5, 4, 4, 4, 3, 3, 3, 2,          // levels 10-19
  2, 2, 2, 2, 2, 2, 2, 2, 2, 1           // levels 20-29
];

const SOFT_DROP_MULTIPLIER = 20;
const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 15;
const LINE_CLEAR_DELAY_MS = 400; // Delay before cleared rows are removed (< client animation 500ms for graceful fade)
const MAX_DROPS_PER_TICK = 5;    // Safety cap to prevent teleporting

// Timing
const LOGIC_TICK_MS = 1000 / 60;    // 60Hz game logic

// Scoring (standard guideline)
const LINE_CLEAR_SCORES = {
  1: 100,   // single
  2: 300,   // double
  3: 500,   // triple
  4: 800    // tetris
};

const TSPIN_SCORES = {
  0: 400,   // t-spin no lines
  1: 800,   // t-spin single
  2: 1200,  // t-spin double
  3: 1600   // t-spin triple
};

const TSPIN_MINI_SCORES = {
  0: 100,
  1: 200,
  2: 400
};

const COMBO_TABLE = [0, 50, 50, 100, 100, 150, 150, 200, 200, 250, 250, 300, 300, 350];
const BACK_TO_BACK_MULTIPLIER = 1.5;

// Garbage lines sent for competitive mode
const GARBAGE_TABLE = {
  1: 0,  // single sends 0
  2: 1,  // double sends 1
  3: 2,  // triple sends 2
  4: 4   // tetris sends 4
};

const TSPIN_GARBAGE_MULTIPLIER = 2;
const COMBO_GARBAGE = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
const GARBAGE_DELAY_MS = 2000;   // Milliseconds before garbage rises, allowing counterplay

// Room settings
const MAX_PLAYERS = 4;
const ROOM_CODE_LENGTH = 4;
// Countdown
const COUNTDOWN_SECONDS = 3;

// Display-side timing
const SOFT_DROP_TIMEOUT_MS = 300;   // Auto-end soft drop if no message received within this window
const LIVENESS_TIMEOUT_MS = 3000;   // Controller considered disconnected after this silence

// Piece types (1-indexed to match grid cell values)
const PIECE_TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
const PIECE_TYPE_TO_ID = { I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 };
const GARBAGE_CELL = 8;

exports.BOARD_WIDTH = BOARD_WIDTH;
exports.BOARD_HEIGHT = BOARD_HEIGHT;
exports.VISIBLE_HEIGHT = VISIBLE_HEIGHT;
exports.BUFFER_ROWS = BUFFER_ROWS;
exports.GRAVITY_TABLE = GRAVITY_TABLE;
exports.SOFT_DROP_MULTIPLIER = SOFT_DROP_MULTIPLIER;
exports.LOCK_DELAY_MS = LOCK_DELAY_MS;
exports.MAX_LOCK_RESETS = MAX_LOCK_RESETS;
exports.LINE_CLEAR_DELAY_MS = LINE_CLEAR_DELAY_MS;
exports.MAX_DROPS_PER_TICK = MAX_DROPS_PER_TICK;
exports.LOGIC_TICK_MS = LOGIC_TICK_MS;
exports.LINE_CLEAR_SCORES = LINE_CLEAR_SCORES;
exports.TSPIN_SCORES = TSPIN_SCORES;
exports.TSPIN_MINI_SCORES = TSPIN_MINI_SCORES;
exports.COMBO_TABLE = COMBO_TABLE;
exports.BACK_TO_BACK_MULTIPLIER = BACK_TO_BACK_MULTIPLIER;
exports.GARBAGE_TABLE = GARBAGE_TABLE;
exports.TSPIN_GARBAGE_MULTIPLIER = TSPIN_GARBAGE_MULTIPLIER;
exports.COMBO_GARBAGE = COMBO_GARBAGE;
exports.GARBAGE_DELAY_MS = GARBAGE_DELAY_MS;
exports.MAX_PLAYERS = MAX_PLAYERS;
exports.ROOM_CODE_LENGTH = ROOM_CODE_LENGTH;
exports.COUNTDOWN_SECONDS = COUNTDOWN_SECONDS;
exports.PIECE_TYPES = PIECE_TYPES;
exports.PIECE_TYPE_TO_ID = PIECE_TYPE_TO_ID;
exports.GARBAGE_CELL = GARBAGE_CELL;
exports.SOFT_DROP_TIMEOUT_MS = SOFT_DROP_TIMEOUT_MS;
exports.LIVENESS_TIMEOUT_MS = LIVENESS_TIMEOUT_MS;

})(typeof module !== 'undefined' ? module.exports : (window.GameConstants = {}));
