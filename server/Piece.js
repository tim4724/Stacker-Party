'use strict';

// UMD: works in Node.js (require) and browser (window.PieceModule)
// Flat-top hexagons with odd-q offset coordinates.
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var PIECE_TYPE_TO_ID = constants.PIECE_TYPE_TO_ID;
var COLS = constants.COLS;

// ===================== HEX MATH (flat-top, odd-q offset) =====================
function offsetToAxial(col, row) {
  return { q: col, r: row - ((col - (col & 1)) >> 1) };
}

function axialToOffset(q, r) {
  return { col: q, row: r + ((q - (q & 1)) >> 1) };
}

// Scratch arrays for getAbsoluteBlocks — avoids allocation on every call.
// Sized for the largest piece in the bag (4-cell tetrominoes); the
// non-allocating fast path expands on demand for any future size.
var _absBlocksScratch = [[0,0],[0,0],[0,0],[0,0]];

// ===================== PIECE DEFINITIONS =====================
// Casual mixed bag: 3 trominoes (3-cell) + 3 small tetrominoes (4-cell).
// Trominoes lower mental-rotation load; tetrominoes preserve challenge.
//
// d and b are starter geometries — letter silhouettes are approximate in
// flat-top odd-q with only 4 cells. Iterate visually if needed.
// Spawn orientations chosen to minimize spawn-row span ("flattest possible"),
// so the piece occupies as few rows as possible the moment it enters visible
// area and top-out risk stays low. Within ties, the orientation with the
// anchor near the top of the piece wins so rotation feels like a wrist-flick
// rather than a swing.
//
// cells[0] must NOT be the (0,0) anchor — rotation keeps the anchor fixed,
// so an anchor-first piece's cells[0] is invariant across rotations and the
// renderer's ghost-preview cache can't tell rotations apart. List a non-anchor
// cell first for every piece. (See "rotating a piece without moving it" test.)
var PIECES = {
  I3: [[-1,0],[0,0],[1,0]],             // straight 3-line, one rotation per hex axis
  V3: [[1,-1],[0,0],[-1,0]],            // 60° bend chain laid flat (V-shape, anchor at the bottom point)
  T3: [[1,0],[0,0],[0,1]],              // tight 3-triangle (3 mutually-adjacent cells)
  o:  [[-1,0],[0,0],[0,-1],[1,-1]],     // compact 4-cell rhombus — safe placement piece
  d:  [[1,0],[0,0],[-1,0],[-1,1]],      // 4-cell wedge, anchor at the upper apex, bulk extends below-and-left (spawn is rot-2 of the original "d" stem)
  b:  [[-1,1],[0,0],[1,-1],[1,0]],      // visual mirror of d, bulk extends below-and-right (spawn is rot-4 of the original "b" stem)
};

// No piece in the casual bag spans more than 1 cell from its anchor in any
// rotation, so a ±1 kick is always sufficient to recover from a wall hit.
var KICKS = [
  [0,0],
  [-1,0], [1,0], [0,-1], [0,1],
  [-1,-1], [1,-1], [-1,1], [1,1]
];

// ===================== ROTATION CYCLE TABLE =====================
// rotateCW/rotateCCW cycle through PIECE_ROTATIONS[type], a precomputed list
// of distinct piece orientations. Two rotations are "distinct" iff their
// cells form different shapes — pieces with rotational symmetry (I3, T3, o)
// have fewer than 6 entries. Within each shape-equivalence class, we pick the
// rotation whose vertical centroid (axial r + q/2) is closest to rot 0's, so
// rotating doesn't visually push the piece down off-screen.

function _rotateCellsCW(cells) {
  var out = new Array(cells.length);
  for (var i = 0; i < cells.length; i++) {
    out[i] = { q: -cells[i].r, r: cells[i].q + cells[i].r };
  }
  return out;
}

// Translation-invariant signature: cells with the same shape but different
// positions get the same key.
function _shapeKey(cells) {
  var minQ = Infinity, minR = Infinity;
  for (var i = 0; i < cells.length; i++) {
    if (cells[i].q < minQ) minQ = cells[i].q;
    if (cells[i].r < minR) minR = cells[i].r;
  }
  var parts = new Array(cells.length);
  for (var j = 0; j < cells.length; j++) {
    parts[j] = (cells[j].q - minQ) + ',' + (cells[j].r - minR);
  }
  parts.sort();
  return parts.join('|');
}

// Visual vertical centroid offset from the anchor — derives directly from
// the offset-row formula: vert(cell) = row + 0.5 * (col & 1) collapses to
// r + q/2 regardless of column parity. Smaller value = piece sits higher.
function _vertCentroid(cells) {
  var sum = 0;
  for (var i = 0; i < cells.length; i++) sum += cells[i].r + cells[i].q / 2;
  return sum / cells.length;
}

function _buildRotationCycle(initialCells) {
  var rotations = [initialCells];
  for (var i = 1; i < 6; i++) rotations.push(_rotateCellsCW(rotations[i - 1]));

  // Group rotations by shape, preserving first-occurrence order so rot 0's
  // class is always first in the cycle.
  var classOrder = [];                 // shapeKey, first-encountered order
  var classMembers = {};               // shapeKey -> [rotIdx]
  for (var r = 0; r < 6; r++) {
    var key = _shapeKey(rotations[r]);
    if (!classMembers[key]) { classMembers[key] = []; classOrder.push(key); }
    classMembers[key].push(r);
  }

  // Pick the representative in each class whose vertical centroid is closest
  // to rot 0's. This is what prevents the "rot 2 pushes the piece down" feel:
  // among shape-equivalent rotations, the one whose visual vert matches the
  // spawn stays at the spawn altitude.
  var targetVert = _vertCentroid(rotations[0]);
  var cycle = [];
  for (var c = 0; c < classOrder.length; c++) {
    var members = classMembers[classOrder[c]];
    var bestIdx = members[0];
    var bestDist = Math.abs(_vertCentroid(rotations[bestIdx]) - targetVert);
    for (var m = 1; m < members.length; m++) {
      var dist = Math.abs(_vertCentroid(rotations[members[m]]) - targetVert);
      if (dist < bestDist) { bestDist = dist; bestIdx = members[m]; }
    }
    cycle.push(rotations[bestIdx]);
  }
  return cycle;
}

var PIECE_ROTATIONS = {};
for (var _type in PIECES) {
  var _initial = PIECES[_type].map(function(c) { return { q: c[0], r: c[1] }; });
  PIECE_ROTATIONS[_type] = _buildRotationCycle(_initial);
}

class Piece {
  constructor(type) {
    this.type = type;
    this.typeId = PIECE_TYPE_TO_ID[type];
    this._rotIndex = 0;
    this._cycle = PIECE_ROTATIONS[type];     // shared, read-only — never mutate
    this.cycleLength = this._cycle.length;   // 2 (T3), 3 (I3, o), or 6 (V3, d, b)
    var src = this._cycle[0];
    this.cells = new Array(src.length);
    for (var i = 0; i < src.length; i++) this.cells[i] = { q: src[i].q, r: src[i].r };
    this.anchorCol = COLS >> 1;  // spawn at horizontal center
    this.anchorRow = 0;
    this._rotId = 0;    // incremented on rotate, used for ghost cache key
    // In odd-q (flat-top), column parity affects offset row mapping,
    // so we must compute the actual minimum offset row of all blocks.
    this._adjustAnchorRow();
    // Lateral moves in flat-top hex are diagonal (half a cell up or down).
    // _anchorY is the piece's "resting" visual y in half-hex units. Lateral
    // moves oscillate between y == _anchorY and y == _anchorY - 1, biased up,
    // so holding a column never costs altitude. Gravity/rotation reset it.
    this._anchorY = 2 * this.anchorRow + (this.anchorCol & 1);
  }

  _resetAnchorY() {
    this._anchorY = 2 * this.anchorRow + (this.anchorCol & 1);
  }

  // Ensure no block has a negative offset row by raising anchorRow
  _adjustAnchorRow() {
    var minOffRow = 0;
    var a = offsetToAxial(this.anchorCol, this.anchorRow);
    for (var i = 0; i < this.cells.length; i++) {
      var off = axialToOffset(a.q + this.cells[i].q, a.r + this.cells[i].r);
      if (off.row < minOffRow) minOffRow = off.row;
    }
    if (minOffRow < 0) this.anchorRow -= minOffRow;
  }

  getAbsoluteBlocks() {
    var ac = this.anchorCol, ar = this.anchorRow;
    var aq = ac, aRr = ar - ((ac - (ac & 1)) >> 1);
    var result = [];
    for (var i = 0; i < this.cells.length; i++) {
      var cq = aq + this.cells[i].q;
      var cr = aRr + this.cells[i].r;
      result.push([cq, cr + ((cq - (cq & 1)) >> 1)]);
    }
    return result;
  }

  // Non-allocating version for hot paths (isValidPosition, lockPiece).
  // Returns a shared scratch array — caller must consume before the next call.
  // Scratch length is normalized to this.cells.length each call so a 3-cell
  // tromino doesn't expose stale entries left over from a previous 4-cell
  // piece (callers iterate `blocks.length`).
  _absoluteBlocksFast() {
    var n = this.cells.length;
    while (_absBlocksScratch.length < n) _absBlocksScratch.push([0, 0]);
    var ac = this.anchorCol, ar = this.anchorRow;
    var aq = ac, aRr = ar - ((ac - (ac & 1)) >> 1);
    for (var i = 0; i < n; i++) {
      var cq = aq + this.cells[i].q;
      var cr = aRr + this.cells[i].r;
      _absBlocksScratch[i][0] = cq;
      _absBlocksScratch[i][1] = cr + ((cq - (cq & 1)) >> 1);
    }
    _absBlocksScratch.length = n;
    return _absBlocksScratch;
  }

  clone() {
    var p = Object.create(Piece.prototype);
    p.type = this.type;
    p.typeId = this.typeId;
    p._rotIndex = this._rotIndex;
    p._cycle = this._cycle;
    p.cycleLength = this.cycleLength;
    p.cells = this.cells.map(function(c) { return { q: c.q, r: c.r }; });
    p.anchorCol = this.anchorCol;
    p.anchorRow = this.anchorRow;
    p._rotId = this._rotId;
    p._anchorY = this._anchorY;
    return p;
  }

  // Advance through the cached rotation cycle. For 2-/3-/6-step pieces this
  // skips shape-equivalent orientations (e.g. T3 flips between two states,
  // not six) and within each shape it lands on the centroid-matched
  // representative, so the piece doesn't visually drift across rotations.
  _setCells(index) {
    this._rotId++;
    this._rotIndex = index;
    var src = this._cycle[index];
    for (var i = 0; i < src.length; i++) {
      this.cells[i].q = src[i].q;
      this.cells[i].r = src[i].r;
    }
  }

  rotateCW() {
    this._setCells((this._rotIndex + 1) % this.cycleLength);
  }

  rotateCCW() {
    this._setCells((this._rotIndex - 1 + this.cycleLength) % this.cycleLength);
  }
}

// Drop the piece by repeatedly incrementing anchorRow until any block would
// leave the grid or hit a filled cell. Mutates anchorRow in place; does not
// touch _anchorY (rendering-only, irrelevant for ghost/preview callers).
// Shared by PlayerBoard._ghostOf and the display test harness so the gallery
// matches in-game ghost placement.
function dropToFloor(piece, grid, totalRows, cols) {
  while (piece.anchorRow + 1 < totalRows) {
    piece.anchorRow += 1;
    var blocks = piece._absoluteBlocksFast();
    var valid = true;
    for (var i = 0; i < blocks.length; i++) {
      var col = blocks[i][0], row = blocks[i][1];
      if (col < 0 || col >= cols || row < 0 || row >= totalRows || grid[row][col] !== 0) {
        valid = false; break;
      }
    }
    if (!valid) { piece.anchorRow -= 1; return piece; }
  }
  return piece;
}

exports.PIECES = PIECES;
exports.PIECE_ROTATIONS = PIECE_ROTATIONS;
exports.KICKS = KICKS;
exports.Piece = Piece;
exports.dropToFloor = dropToFloor;
exports.offsetToAxial = offsetToAxial;
exports.axialToOffset = axialToOffset;

})(typeof module !== 'undefined' ? module.exports : (window.PieceModule = {}));
