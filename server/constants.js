'use strict';

// UMD: works in Node.js (require) and browser (window.GameConstants)
(function(exports) {

const MAX_SPEED_LEVEL = 15;    // Gravity cap at this level
const SOFT_DROP_MULTIPLIER = 20;
const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 10;
const LINE_CLEAR_DELAY_MS = 400; // Delay before cleared rows are removed (< client animation 500ms for graceful fade)
const MAX_DROPS_PER_TICK = 5;    // Safety cap to prevent teleporting

// Timing
const LOGIC_TICK_MS = 1000 / 60;    // 60Hz game logic

// Garbage lines sent for competitive mode
// No piece in the casual bag spans more than 3 rows in any rotation, so a
// quad clear is unreachable. Triple is the new top-end reward; bumping its
// send count from 2 to 3 restores the progressive escalation the old quad
// provided (was 0,1,2,4; now 0,1,3).
const GARBAGE_TABLE = {
  1: 0,  // single sends 0
  2: 1,  // double sends 1
  3: 3,  // triple sends 3 — the new ceiling
};

const GARBAGE_DELAY_MS = 2000;   // Milliseconds before garbage rises, allowing counterplay

// Room settings
const MAX_PLAYERS = 8;
// Countdown. The sequencing stays per-shell on purpose (the web runs a repeating
// timer, the TVs a frame accumulator) — only one display ever runs in a room, so
// nothing has to agree with anything at runtime. These two numbers still live
// here so the three copies of the RULE can't quietly disagree about how long a
// beat lasts; the parity tests pin them.
const COUNTDOWN_SECONDS = 3;
const COUNTDOWN_STEP_MS = 1000;      // one beat per number: 3, 2, 1
const COUNTDOWN_GO_HOLD_MS = 500;    // GO stays up this long before the game starts

// Input timing
const SOFT_DROP_TIMEOUT_MS = 300;        // Auto-end soft drop if no further soft_drop message arrives within this window
const HARD_DROP_MIN_INTERVAL_MS = 150;   // Per-player floor between hard drops; rapid repeats (queued messages) are dropped

// Frame loop
const MAX_FRAME_DELTA_MS = 50;           // Cap per-frame delta (~3 frames at 60Hz) — prevents catch-up jumps after a tab/app unfreeze; shared by the web rAF loop and PartyCore.frame()

// Display-side timing
const LIVENESS_TIMEOUT_MS = 3000;   // Controller considered disconnected after this silence
// Grace before returning to lobby when every active participant has dropped but
// late joiners are waiting — lets the host reconnect before we bail out.
const LATE_JOINER_GRACE_MS = 5000;
// Display self-heartbeat dead-detection threshold. The display loops a 1 Hz
// `_heartbeat` back through the relay to itself; if echoes stop arriving for
// this long it tears down the WS and reconnects. Set to 6x the heartbeat
// interval to mirror PartyFastlane's watchdog margin: with fastlane in use
// the WS is otherwise near-idle, so a single 2-3 s jitter spike would
// otherwise trigger a false reconnect.
const SELF_HEARTBEAT_DEAD_MS = 6000;

// ===================== BOARD GEOMETRY =====================

// Grid dimensions (flat-top hex board). Sized for the casual mixed-bag pacing:
// 9 cols * avg 3.5 cells/piece = 2.57 placements per zigzag row, matching the
// Tetris baseline (10/4 = 2.5). 15 visible rows keeps games short enough that
// a topped-out board doesn't feel like a slog to recover from.
const COLS = 9;
const BUFFER_ROWS = 4;
const VISIBLE_ROWS = 15;
const TOTAL_ROWS = BUFFER_ROWS + VISIBLE_ROWS;

// Upper bound on the `n` an INPUT message may carry. A drag can cross several
// ratchet steps inside one pointermove and ships them as one counted message
// (TouchInput._onPointerMove), so every display expands `n` into that many engine
// inputs; the count comes off the wire, so it needs a ceiling.
// COLS - 1 is the most moves that can do anything (a piece any further along is
// already against the wall), so clamping here costs no reachable input.
const INPUT_MAX_REPEAT = COLS - 1;

// 6-piece casual bag (1-indexed to match grid cell values): 3 trominoes for
// low spatial-planning load + 3 small-footprint tetrominoes to keep the game
// from going trivial. d/b are starter geometries — iterate once playtested.
const PIECE_TYPES = ['I3', 'V3', 'T3', 'o', 'd', 'b'];
const PIECE_TYPE_TO_ID = { I3: 1, V3: 2, T3: 3, o: 4, d: 5, b: 6 };
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

// Find empty cells where filling that single cell would complete a zigzag
// (down or up). Returns array of [col, row] pairs; an empty cell that's the
// sole gap in more than one zigzag appears only once.
function findNearClearZigzags(cols, totalRows, isFilled, minRow) {
  var startRow = minRow != null ? minRow : 0;
  var seen = {};
  var out = [];

  function scan(r, type) {
    var gap = null;
    for (var col = 0; col < cols; col++) {
      var row = (type === 'up' && (col & 1)) ? r - 1 : r;
      if (row < 0 || row >= totalRows) return;
      if (!isFilled(col, row)) {
        if (gap !== null) return; // 2+ empty cells — not a single-cell completer
        gap = [col, row];
      }
    }
    if (gap === null) return; // already complete
    var key = gap[0] + ',' + gap[1];
    if (!seen[key]) {
      seen[key] = true;
      out.push(gap);
    }
  }

  for (var r = startRow; r < totalRows; r++) {
    scan(r, 'down');
    if (r >= 1) scan(r, 'up');
  }
  return out;
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
// Used by web canvas renderers (traceHexOutline in CanvasUtils, BoardRenderer's
// pre-computed cache); the pure math stays here for the portable surface.
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
exports.COUNTDOWN_SECONDS = COUNTDOWN_SECONDS;
exports.COUNTDOWN_STEP_MS = COUNTDOWN_STEP_MS;
exports.COUNTDOWN_GO_HOLD_MS = COUNTDOWN_GO_HOLD_MS;
exports.SOFT_DROP_TIMEOUT_MS = SOFT_DROP_TIMEOUT_MS;
exports.HARD_DROP_MIN_INTERVAL_MS = HARD_DROP_MIN_INTERVAL_MS;
exports.MAX_FRAME_DELTA_MS = MAX_FRAME_DELTA_MS;
exports.LIVENESS_TIMEOUT_MS = LIVENESS_TIMEOUT_MS;
exports.LATE_JOINER_GRACE_MS = LATE_JOINER_GRACE_MS;
exports.SELF_HEARTBEAT_DEAD_MS = SELF_HEARTBEAT_DEAD_MS;
exports.COLS = COLS;
exports.TOTAL_ROWS = TOTAL_ROWS;
exports.BUFFER_ROWS = BUFFER_ROWS;
exports.VISIBLE_ROWS = VISIBLE_ROWS;
exports.INPUT_MAX_REPEAT = INPUT_MAX_REPEAT;
exports.PIECE_TYPES = PIECE_TYPES;
exports.PIECE_TYPE_TO_ID = PIECE_TYPE_TO_ID;
exports.GARBAGE_CELL = GARBAGE_CELL;
exports.findClearableZigzags = findClearableZigzags;
exports.findNearClearZigzags = findNearClearZigzags;
exports.computeHexGeometry = computeHexGeometry;
exports.computeHexOutlineVerts = computeHexOutlineVerts;

})(typeof module !== 'undefined' ? module.exports : (window.GameConstants = {}));
