'use strict';

// UMD: works in Node.js (require) and browser (window.GameConstants)
(function(exports) {

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 26; // 22 visible + 4 buffer
const VISIBLE_HEIGHT = 22;
const BUFFER_ROWS = 4;

const MAX_SPEED_LEVEL = 15;    // Gravity and music speed cap at this level
const SOFT_DROP_MULTIPLIER = 20;
const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 10;
const LINE_CLEAR_DELAY_MS = 400; // Delay before cleared rows are removed (< client animation 500ms for graceful fade)
const MAX_DROPS_PER_TICK = 5;    // Safety cap to prevent teleporting

// Timing
const LOGIC_TICK_MS = 1000 / 60;    // 60Hz game logic

// Garbage lines sent for competitive mode
const GARBAGE_TABLE = {
  1: 0,  // single sends 0
  2: 1,  // double sends 1
  3: 2,  // triple sends 2
  4: 4   // quad sends 4
};

const GARBAGE_DELAY_MS = 2000;   // Milliseconds before garbage rises, allowing counterplay

// Room settings
const MAX_PLAYERS = 8;
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
exports.MAX_SPEED_LEVEL = MAX_SPEED_LEVEL;
exports.SOFT_DROP_MULTIPLIER = SOFT_DROP_MULTIPLIER;
exports.LOCK_DELAY_MS = LOCK_DELAY_MS;
exports.MAX_LOCK_RESETS = MAX_LOCK_RESETS;
exports.LINE_CLEAR_DELAY_MS = LINE_CLEAR_DELAY_MS;
exports.MAX_DROPS_PER_TICK = MAX_DROPS_PER_TICK;
exports.LOGIC_TICK_MS = LOGIC_TICK_MS;
exports.GARBAGE_TABLE = GARBAGE_TABLE;
exports.GARBAGE_DELAY_MS = GARBAGE_DELAY_MS;
exports.MAX_PLAYERS = MAX_PLAYERS;
exports.ROOM_CODE_LENGTH = ROOM_CODE_LENGTH;
exports.COUNTDOWN_SECONDS = COUNTDOWN_SECONDS;
exports.PIECE_TYPES = PIECE_TYPES;
exports.PIECE_TYPE_TO_ID = PIECE_TYPE_TO_ID;
exports.GARBAGE_CELL = GARBAGE_CELL;
exports.SOFT_DROP_TIMEOUT_MS = SOFT_DROP_TIMEOUT_MS;
exports.LIVENESS_TIMEOUT_MS = LIVENESS_TIMEOUT_MS;
exports.GAME_MODES = { CLASSIC: 'classic', HEX: 'hex' };

})(typeof module !== 'undefined' ? module.exports : (window.GameConstants = {}));
