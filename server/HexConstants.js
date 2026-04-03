'use strict';

// UMD: works in Node.js (require) and browser (window.HexConstants)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;

// Grid dimensions
var HEX_COLS = 11;
var HEX_TOTAL_ROWS = 25;   // 4 buffer + 21 visible
var HEX_BUFFER_ROWS = 4;
var HEX_VISIBLE_ROWS = 21;

// 7 hex piece types (1-indexed to match grid cell values)
// All 4-hex pieces
var HEX_PIECE_TYPES = ['L', 'S', 'T', 'F', 'Fm', 'I4', 'Tp'];
var HEX_PIECE_TYPE_TO_ID = { L: 1, S: 2, T: 3, F: 4, Fm: 5, I4: 6, Tp: 7 };
var HEX_GARBAGE_CELL = 9;

// Reuse timing/gameplay constants from main game
var LOCK_DELAY_MS = constants.LOCK_DELAY_MS;
var LINE_CLEAR_DELAY_MS = constants.LINE_CLEAR_DELAY_MS;
var MAX_LOCK_RESETS = constants.MAX_LOCK_RESETS;
var MAX_SPEED_LEVEL = constants.MAX_SPEED_LEVEL;
var SOFT_DROP_MULTIPLIER = constants.SOFT_DROP_MULTIPLIER;
var MAX_DROPS_PER_TICK = constants.MAX_DROPS_PER_TICK;

exports.HEX_COLS = HEX_COLS;
exports.HEX_TOTAL_ROWS = HEX_TOTAL_ROWS;
exports.HEX_BUFFER_ROWS = HEX_BUFFER_ROWS;
exports.HEX_VISIBLE_ROWS = HEX_VISIBLE_ROWS;
// ===================== ZIGZAG CLEAR DETECTION =====================
// Shared by engine (HexPlayerBoard) and renderer (HexBoardRenderer clear preview).

// Check if a single zigzag line is full in the given grid.
// type='down': same row index across all cols.
// type='up': even cols at row r, odd cols at row r-1.
// isFilled(col, row) returns truthy if cell counts as filled.
// Returns array of [col, row] cells or null.
function checkZigzag(r, type, cols, totalRows, isFilled) {
  for (var col = 0; col < cols; col++) {
    var row = (type === 'up' && (col & 1)) ? r - 1 : r;
    if (row < 0 || row >= totalRows) return null;
    if (!isFilled(col, row)) return null;
  }
  var cells = [];
  for (var c = 0; c < cols; c++) {
    var rr = (type === 'up' && (c & 1)) ? r - 1 : r;
    cells.push([c, rr]);
  }
  return cells;
}

// Find all clearable zigzag lines (both directions) with bottom-first
// non-overlapping selection. Returns { linesCleared, clearCells }.
// isFilled(col, row) returns truthy if cell counts as filled.
// ghostContributes(col, row) returns truthy if the cell is a ghost cell
// (optional — pass null to skip ghost filtering, used by engine).
function findClearableZigzags(cols, totalRows, isFilled, ghostContributes, minRow) {
  var allZigzags = [];
  var startRow = minRow || 0;

  for (var r = startRow; r < totalRows; r++) {
    var down = checkZigzag(r, 'down', cols, totalRows, isFilled);
    if (down) {
      if (!ghostContributes || down.some(function(c) { return ghostContributes(c[0], c[1]); })) {
        allZigzags.push(down);
      }
    }
    if (r >= 1) {
      var up = checkZigzag(r, 'up', cols, totalRows, isFilled);
      if (up) {
        if (!ghostContributes || up.some(function(c) { return ghostContributes(c[0], c[1]); })) {
          allZigzags.push(up);
        }
      }
    }
  }

  // Sort bottom-first: higher max row = lower on board = higher priority
  allZigzags.sort(function(a, b) {
    var aMax = 0, bMax = 0;
    for (var i = 0; i < a.length; i++) aMax = Math.max(aMax, a[i][1]);
    for (var j = 0; j < b.length; j++) bMax = Math.max(bMax, b[j][1]);
    return bMax - aMax;
  });

  // Greedily select non-overlapping zigzags
  var clearCells = {};
  var linesCleared = 0;
  for (var zi = 0; zi < allZigzags.length; zi++) {
    var zag = allZigzags[zi];
    var overlaps = false;
    for (var ci = 0; ci < zag.length; ci++) {
      if (clearCells[zag[ci][0] + ',' + zag[ci][1]]) { overlaps = true; break; }
    }
    if (!overlaps) {
      linesCleared++;
      for (var cj = 0; cj < zag.length; cj++) {
        clearCells[zag[cj][0] + ',' + zag[cj][1]] = true;
      }
    }
  }

  return { linesCleared: linesCleared, clearCells: clearCells };
}

exports.HEX_PIECE_TYPES = HEX_PIECE_TYPES;
exports.HEX_PIECE_TYPE_TO_ID = HEX_PIECE_TYPE_TO_ID;
exports.HEX_GARBAGE_CELL = HEX_GARBAGE_CELL;
exports.findClearableZigzags = findClearableZigzags;

})(typeof module !== 'undefined' ? module.exports : (window.HexConstants = {}));
