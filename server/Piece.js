'use strict';

// UMD: works in Node.js (require) and browser (window.PieceModule)
// Flat-top hexagons with odd-q offset coordinates.
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var PIECE_TYPE_TO_ID = constants.PIECE_TYPE_TO_ID;

// ===================== HEX MATH (flat-top, odd-q offset) =====================
function offsetToAxial(col, row) {
  return { q: col, r: row - ((col - (col & 1)) >> 1) };
}

function axialToOffset(q, r) {
  return { col: q, row: r + ((q - (q & 1)) >> 1) };
}

// Scratch arrays for getAbsoluteBlocks — avoids allocation on every call.
// All PIECES have exactly 4 cells; update if a 5+ cell piece is added.
var _absBlocksScratch = [[0,0],[0,0],[0,0],[0,0]];

// ===================== PIECE DEFINITIONS =====================
// Flat-top hex piece set (v2 — post-redesign).
// - T (tripod) removed: every rotation leaves a hole between its legs.
// - q and p are the old L and J pieces, renamed: in flat-top rendering their
//   silhouettes (chevron ribbon + stem) read more like lowercase q and p.
// - L and J are new 4-chain pieces with a single 60° bend, giving true L/J
//   silhouettes. Default orientations were chosen for visual readability.
var PIECES = {
  I:  [[-1,0],[0,0],[1,0],[2,0]],
  O:  [[-1,0],[0,0],[0,-1],[1,-1]],
  S:  [[-2,1],[-1,1],[0,0],[1,0]],
  Z:  [[-1,1],[0,0],[1,0],[2,-1]],
  q:  [[-1,0],[0,0],[1,0],[1,-1]],    // was L — chevron ribbon + right stem
  p:  [[-1,1],[0,0],[1,-1],[-1,0]],   // was J — chevron ribbon + left stem
  // L and J use different axial axes ((1,-1) and (-1,0) respectively) so that
  // they render as true visual mirrors in flat-top odd-q — a pure axial q-flip
  // would produce a steep zigzag instead of the gentle L/J silhouette.
  L:  [[-1,1],[0,0],[1,-1],[1,-2]],   // new — 3-cell up-right diagonal + top-right vertical extension
  J:  [[1,0],[0,0],[-1,0],[-1,-1]],   // new — 3-cell up-left diagonal + top-left vertical extension
};

// The I piece spans 2 cells to one side of its anchor, so rotating it against a
// wall or floor needs shifts of ±2 — a ±1 kick alone can't bring it back in-bounds.
var KICKS = [
  [0,0],
  [-1,0], [1,0], [0,-1], [0,1],
  [-1,-1], [1,-1], [-1,1], [1,1],
  [-2,0], [2,0], [0,-2], [0,2]
];

// ===================== HEX PIECE CLASS =====================
class Piece {
  constructor(type) {
    this.type = type;
    this.typeId = PIECE_TYPE_TO_ID[type];
    this.cells = PIECES[type].map(function(c) { return { q: c[0], r: c[1] }; });
    this.anchorCol = 5;  // center of 11-col grid
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
  _absoluteBlocksFast() {
    while (_absBlocksScratch.length < this.cells.length) _absBlocksScratch.push([0, 0]);
    var ac = this.anchorCol, ar = this.anchorRow;
    var aq = ac, aRr = ar - ((ac - (ac & 1)) >> 1);
    for (var i = 0; i < this.cells.length; i++) {
      var cq = aq + this.cells[i].q;
      var cr = aRr + this.cells[i].r;
      _absBlocksScratch[i][0] = cq;
      _absBlocksScratch[i][1] = cr + ((cq - (cq & 1)) >> 1);
    }
    return _absBlocksScratch;
  }

  clone() {
    var p = Object.create(Piece.prototype);
    p.type = this.type;
    p.typeId = this.typeId;
    p.cells = this.cells.map(function(c) { return { q: c.q, r: c.r }; });
    p.anchorCol = this.anchorCol;
    p.anchorRow = this.anchorRow;
    p._rotId = this._rotId;
    p._anchorY = this._anchorY;
    return p;
  }

  // Mutates cells in place — call on a clone() to preserve the original.
  rotateCW() {
    this._rotId++;
    for (var i = 0; i < this.cells.length; i++) {
      var q = this.cells[i].q, r = this.cells[i].r;
      this.cells[i].q = -r;
      this.cells[i].r = q + r;
    }
  }

  rotateCCW() {
    this._rotId++;
    for (var i = 0; i < this.cells.length; i++) {
      var q = this.cells[i].q, r = this.cells[i].r;
      this.cells[i].q = q + r;
      this.cells[i].r = -q;
    }
  }
}

exports.PIECES = PIECES;
exports.KICKS = KICKS;
exports.Piece = Piece;
exports.offsetToAxial = offsetToAxial;
exports.axialToOffset = axialToOffset;

})(typeof module !== 'undefined' ? module.exports : (window.PieceModule = {}));
