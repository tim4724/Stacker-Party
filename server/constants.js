'use strict';

// UMD: works in Node.js (require) and browser (window.GameConstants)
(function(exports) {

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

// ===================== BOARD GEOMETRY =====================

// Grid dimensions (flat-top hex board)
const COLS = 11;
const TOTAL_ROWS = 25;   // 4 buffer + 21 visible
const BUFFER_ROWS = 4;
const VISIBLE_ROWS = 21;

// 8 piece types (1-indexed to match grid cell values).
// All 4-hex pieces. Post-redesign set: T removed, q/p are the old L/J,
// and L/J are new true-L/J shaped pieces.
const PIECE_TYPES = ['I', 'O', 'S', 'Z', 'q', 'p', 'L', 'J'];
const PIECE_TYPE_TO_ID = { I: 1, O: 2, S: 3, Z: 4, q: 5, p: 6, L: 7, J: 8 };
const GARBAGE_CELL = 9;

// ===================== ZIGZAG CLEAR DETECTION =====================
// Shared by engine (PlayerBoard) and renderer (BoardRenderer clear preview).

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
  var startRow = minRow != null ? minRow : 0;

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

  // Sort bottom-first: higher max row = lower on board = higher priority.
  // Tie-break by min row so zigzag-down (all at row r) wins over zigzag-up (spans r-1..r).
  allZigzags.sort(function(a, b) {
    var aMax = 0, bMax = 0, aMin = Infinity, bMin = Infinity;
    for (var i = 0; i < a.length; i++) { aMax = Math.max(aMax, a[i][1]); aMin = Math.min(aMin, a[i][1]); }
    for (var j = 0; j < b.length; j++) { bMax = Math.max(bMax, b[j][1]); bMin = Math.min(bMin, b[j][1]); }
    return (bMax - aMax) || (bMin - aMin);
  });

  // Greedily select non-overlapping zigzags
  var usedCells = {};   // string-key set for fast overlap detection
  var clearCells = [];  // flat array of [col, row] pairs
  var linesCleared = 0;
  for (var zi = 0; zi < allZigzags.length; zi++) {
    var zag = allZigzags[zi];
    var overlaps = false;
    for (var ci = 0; ci < zag.length; ci++) {
      if (usedCells[zag[ci][0] + ',' + zag[ci][1]]) { overlaps = true; break; }
    }
    if (!overlaps) {
      linesCleared++;
      for (var cj = 0; cj < zag.length; cj++) {
        usedCells[zag[cj][0] + ',' + zag[cj][1]] = true;
        clearCells.push([zag[cj][0], zag[cj][1]]);
      }
    }
  }

  return { linesCleared: linesCleared, clearCells: clearCells };
}

// ===================== HEX GEOMETRY =====================
// Shared by DisplayUI, BoardRenderer, and UIRenderer.
function computeHexGeometry(boardCols, visRows, cellSize) {
  // hexSize = circumradius that fits boardCols flat-top hexes within cellSize * boardCols width
  var hexSize = boardCols * cellSize / (1.5 * boardCols + 0.5);
  var hexH = Math.sqrt(3) * hexSize;
  var colW = 1.5 * hexSize;
  return {
    hexSize: hexSize,
    hexH: hexH,
    colW: colW,
    boardWidth: colW * (boardCols - 1) + 2 * hexSize,
    boardHeight: hexH * (visRows - 1) + hexH + hexH * 0.5
  };
}

// Compute the outline vertices for a hex board as a flat array of [x, y] pairs.
// bx, by: board origin. hs: hexSize. hexH: hex height. colW: column spacing.
// Used by both traceHexOutline (canvas path) and BoardRenderer (pre-computed cache).
function computeHexOutlineVerts(bx, by, hs, hexH, colW, cols, visRows, outset) {
  var verts = [];
  var lastRow = visRows - 1;
  var lastCol = cols - 1;

  function hc(col, row) {
    return [bx + colW * col + hs, by + hexH * (row + 0.5 * (col & 1)) + hexH / 2];
  }
  function hv(cx, cy, i) {
    var a = Math.PI / 3 * i;
    return [cx + hs * Math.cos(a), cy + hs * Math.sin(a)];
  }

  // Top border: left-to-right across row 0
  var p0 = hc(0, 0);
  verts.push(hv(p0[0], p0[1], 4));
  for (var c = 0; c <= lastCol; c++) {
    var pt = hc(c, 0);
    verts.push(hv(pt[0], pt[1], 5));
    if (c < lastCol) {
      if (c % 2 === 0) {
        verts.push(hv(pt[0], pt[1], 0));
      } else {
        var pn = hc(c + 1, 0);
        verts.push(hv(pn[0], pn[1], 4));
      }
    }
  }
  // Right wall: top-to-bottom along last col
  for (var r = 0; r <= lastRow; r++) {
    var pr = hc(lastCol, r);
    verts.push(hv(pr[0], pr[1], 0));
    verts.push(hv(pr[0], pr[1], 1));
  }
  // Bottom border: right-to-left across last row
  for (var c2 = lastCol; c2 >= 0; c2--) {
    var pb = hc(c2, lastRow);
    verts.push(hv(pb[0], pb[1], 2));
    if (c2 > 0) {
      if (c2 % 2 === 0) {
        var pp = hc(c2 - 1, lastRow);
        verts.push(hv(pp[0], pp[1], 1));
      } else {
        verts.push(hv(pb[0], pb[1], 3));
      }
    }
  }
  // Left wall: bottom-to-top along col 0
  for (var r2 = lastRow; r2 >= 0; r2--) {
    var pl = hc(0, r2);
    verts.push(hv(pl[0], pl[1], 3));
    verts.push(hv(pl[0], pl[1], 4));
  }

  // Offset each vertex outward along the average normal of its two adjacent edges.
  // This ensures uniform perpendicular distance from the original outline.
  if (outset) {
    var n = verts.length;
    var offset = [];
    for (var oi = 0; oi < n; oi++) {
      var prev = verts[(oi - 1 + n) % n];
      var curr = verts[oi];
      var next = verts[(oi + 1) % n];
      // Edge normals (outward = right-hand perpendicular for CW winding)
      var n1x = curr[1] - prev[1], n1y = prev[0] - curr[0];
      var n2x = next[1] - curr[1], n2y = curr[0] - next[0];
      var l1 = Math.sqrt(n1x * n1x + n1y * n1y) || 1;
      var l2 = Math.sqrt(n2x * n2x + n2y * n2y) || 1;
      n1x /= l1; n1y /= l1;
      n2x /= l2; n2y /= l2;
      // Average normal, scaled to maintain perpendicular offset distance
      var ax = n1x + n2x, ay = n1y + n2y;
      var dot = ax * n1x + ay * n1y;
      if (Math.abs(dot) < 0.001) dot = 1;
      var scale = outset / dot;
      offset.push([curr[0] + ax * scale, curr[1] + ay * scale]);
    }
    return offset;
  }

  return verts;
}

// Trace the hex board outline as a closed canvas path (for stroking/clipping).
// cols: column count. visRows: visible row count.
function traceHexOutline(ctx, bx, by, hs, hexH, colW, cols, visRows) {
  var verts = computeHexOutlineVerts(bx, by, hs, hexH, colW, cols, visRows);
  ctx.beginPath();
  ctx.moveTo(verts[0][0], verts[0][1]);
  for (var i = 1; i < verts.length; i++) {
    ctx.lineTo(verts[i][0], verts[i][1]);
  }
  ctx.closePath();
}

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
exports.SOFT_DROP_TIMEOUT_MS = SOFT_DROP_TIMEOUT_MS;
exports.LIVENESS_TIMEOUT_MS = LIVENESS_TIMEOUT_MS;
exports.COLS = COLS;
exports.TOTAL_ROWS = TOTAL_ROWS;
exports.BUFFER_ROWS = BUFFER_ROWS;
exports.VISIBLE_ROWS = VISIBLE_ROWS;
exports.PIECE_TYPES = PIECE_TYPES;
exports.PIECE_TYPE_TO_ID = PIECE_TYPE_TO_ID;
exports.GARBAGE_CELL = GARBAGE_CELL;
exports.findClearableZigzags = findClearableZigzags;
exports.computeHexGeometry = computeHexGeometry;
exports.computeHexOutlineVerts = computeHexOutlineVerts;
exports.traceHexOutline = traceHexOutline;

})(typeof module !== 'undefined' ? module.exports : (window.GameConstants = {}));
