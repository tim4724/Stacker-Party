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

function rotateCW(q, r) { return { q: -r, r: q + r }; }
function rotateCCW(q, r) { return { q: q + r, r: -q }; }

// ===================== PIECE DEFINITIONS =====================
// Same shapes as pointy-top hex — axial coords are orientation-independent.
var HEX_PIECES = {
  L:  [[-1,0],[0,0],[1,0],[1,-1]],
  S:  [[-1,0],[0,0],[0,-1],[1,-1]],
  T:  [[-1,0],[0,0],[1,0],[0,-1]],
  F:  [[-2,1],[-1,1],[0,0],[1,0]],
  Fm: [[-1,0],[0,0],[0,1],[1,1]],
  I4: [[-1,0],[0,0],[1,0],[2,0]],
  Tp: [[0,0],[1,0],[-1,1],[0,-1]],       // Tripod: center + 3 legs, 2 rotations
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
    var a = offsetToAxial(this.anchorCol, this.anchorRow);
    var result = [];
    for (var i = 0; i < this.cells.length; i++) {
      var off = axialToOffset(a.q + this.cells[i].q, a.r + this.cells[i].r);
      result.push([off.col, off.row]);
    }
    return result;
  }

  clone() {
    var p = new HexPiece(this.type);
    p.cells = this.cells.map(function(c) { return { q: c.q, r: c.r }; });
    p.anchorCol = this.anchorCol;
    p.anchorRow = this.anchorRow;
    return p;
  }

  rotateCW() {
    this.cells = this.cells.map(function(c) {
      var rot = rotateCW(c.q, c.r);
      return { q: rot.q, r: rot.r };
    });
  }

  rotateCCW() {
    this.cells = this.cells.map(function(c) {
      var rot = rotateCCW(c.q, c.r);
      return { q: rot.q, r: rot.r };
    });
  }
}

exports.HEX_PIECES = HEX_PIECES;
exports.KICKS = KICKS;
exports.HexPiece = HexPiece;
exports.offsetToAxial = offsetToAxial;
exports.axialToOffset = axialToOffset;

})(typeof module !== 'undefined' ? module.exports : (window.HexPieceModule = {}));
