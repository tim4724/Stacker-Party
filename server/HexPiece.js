'use strict';

// UMD: works in Node.js (require) and browser (window.HexPieceModule)
// Flat-top hexagons with odd-q offset coordinates.
(function(exports) {

var hexConst = (typeof require !== 'undefined') ? require('./HexConstants') : window.HexConstants;
var HEX_PIECE_TYPE_TO_ID = hexConst.HEX_PIECE_TYPE_TO_ID;

// ===================== HEX MATH (flat-top, odd-q offset) =====================
function offsetToAxial(col, row) {
  return { q: col, r: row - ((col - (col & 1)) >> 1) };
}

function axialToOffset(q, r) {
  return { col: q, row: r + ((q - (q & 1)) >> 1) };
}

// Scratch arrays for getAbsoluteBlocks — avoids allocation on every call.
// All HEX_PIECES have exactly 4 cells; update if a 5+ cell piece is added.
var _absBlocksScratch = [[0,0],[0,0],[0,0],[0,0]];

// ===================== PIECE DEFINITIONS =====================
// Same shapes as pointy-top hex — axial coords are orientation-independent.
var HEX_PIECES = {
  I:  [[-1,0],[0,0],[1,0],[2,0]],
  J:  [[-1,1],[0,0],[1,-1],[-1,0]],
  L:  [[-1,0],[0,0],[1,0],[1,-1]],
  O:  [[-1,0],[0,0],[0,-1],[1,-1]],
  S:  [[-2,1],[-1,1],[0,0],[1,0]],
  T:  [[0,0],[1,0],[-1,1],[0,-1]],
  Z:  [[-1,1],[0,0],[1,0],[2,-1]],
};

var KICKS = [[0,0], [-1,0], [1,0], [0,-1], [0,1], [-1,-1], [1,-1], [-1,1], [1,1]];

// ===================== HEX PIECE CLASS =====================
class HexPiece {
  constructor(type) {
    this.type = type;
    this.typeId = HEX_PIECE_TYPE_TO_ID[type];
    this.cells = HEX_PIECES[type].map(function(c) { return { q: c[0], r: c[1] }; });
    this.anchorCol = 5;  // center of 11-col grid
    this.anchorRow = 0;
    this._rotId = 0;    // incremented on rotate, used for ghost cache key
    // In odd-q (flat-top), column parity affects offset row mapping,
    // so we must compute the actual minimum offset row of all blocks.
    this._adjustAnchorRow();
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
    var p = Object.create(HexPiece.prototype);
    p.type = this.type;
    p.typeId = this.typeId;
    p.cells = this.cells.map(function(c) { return { q: c.q, r: c.r }; });
    p.anchorCol = this.anchorCol;
    p.anchorRow = this.anchorRow;
    p._rotId = this._rotId;
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

exports.HEX_PIECES = HEX_PIECES;
exports.KICKS = KICKS;
exports.HexPiece = HexPiece;
exports.offsetToAxial = offsetToAxial;
exports.axialToOffset = axialToOffset;

})(typeof module !== 'undefined' ? module.exports : (window.HexPieceModule = {}));
