'use strict';

// UMD: works in Node.js (require) and browser (window.GamePiece)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var PIECE_TYPE_TO_ID = constants.PIECE_TYPE_TO_ID;

// Rotation states for all 7 piece types
// Each piece type maps to 4 rotation states (0-3)
// Each state is an array of [col, row] block positions
const PIECES = {
  I: [
    [[0,1],[1,1],[2,1],[3,1]],  // 0: horizontal
    [[2,0],[2,1],[2,2],[2,3]],  // 1: vertical
    [[0,2],[1,2],[2,2],[3,2]],  // 2: horizontal flipped
    [[1,0],[1,1],[1,2],[1,3]]   // 3: vertical flipped
  ],
  J: [
    [[0,0],[0,1],[1,1],[2,1]],  // 0
    [[1,0],[2,0],[1,1],[1,2]],  // 1
    [[0,1],[1,1],[2,1],[2,2]],  // 2
    [[1,0],[1,1],[0,2],[1,2]]   // 3
  ],
  L: [
    [[2,0],[0,1],[1,1],[2,1]],  // 0
    [[1,0],[1,1],[1,2],[2,2]],  // 1
    [[0,1],[1,1],[2,1],[0,2]],  // 2
    [[0,0],[1,0],[1,1],[1,2]]   // 3
  ],
  O: [
    [[1,0],[2,0],[1,1],[2,1]],  // all same
    [[1,0],[2,0],[1,1],[2,1]],
    [[1,0],[2,0],[1,1],[2,1]],
    [[1,0],[2,0],[1,1],[2,1]]
  ],
  S: [
    [[1,0],[2,0],[0,1],[1,1]],  // 0
    [[1,0],[1,1],[2,1],[2,2]],  // 1
    [[1,1],[2,1],[0,2],[1,2]],  // 2
    [[0,0],[0,1],[1,1],[1,2]]   // 3
  ],
  T: [
    [[1,0],[0,1],[1,1],[2,1]],  // 0
    [[1,0],[1,1],[2,1],[1,2]],  // 1
    [[0,1],[1,1],[2,1],[1,2]],  // 2
    [[1,0],[0,1],[1,1],[1,2]]   // 3
  ],
  Z: [
    [[0,0],[1,0],[1,1],[2,1]],  // 0
    [[2,0],[1,1],[2,1],[1,2]],  // 1
    [[0,1],[1,1],[1,2],[2,2]],  // 2
    [[1,0],[0,1],[1,1],[0,2]]   // 3
  ]
};

// Wall kick offsets — try nearby positions when rotation collides.
// Standard pieces try ±1 horizontally, then up 1-2 (floor kick), then down 1.
// I piece uses wider ±2 horizontal shifts since it spans 4 cells.
const STANDARD_KICKS = [[0,0], [-1,0], [1,0], [0,1], [0,2], [0,-1]];
const I_KICKS = [[0,0], [-2,0], [2,0], [-1,0], [1,0], [0,1], [0,2], [0,-1]];

class Piece {
  constructor(type) {
    this.type = type;
    this.typeId = PIECE_TYPE_TO_ID[type];
    this.rotation = 0;
    // Spawn position: centered horizontally, at top of buffer zone
    this.x = 3;
    this.y = 0;
  }

  getBlocks() {
    return PIECES[this.type][this.rotation];
  }

  getAbsoluteBlocks() {
    return this.getBlocks().map(([col, row]) => [col + this.x, row + this.y]);
  }

  clone() {
    const p = new Piece(this.type);
    p.rotation = this.rotation;
    p.x = this.x;
    p.y = this.y;
    return p;
  }

  getWallKicks() {
    return this.type === 'I' ? I_KICKS : STANDARD_KICKS;
  }
}

exports.PIECES = PIECES;
exports.STANDARD_KICKS = STANDARD_KICKS;
exports.I_KICKS = I_KICKS;
exports.Piece = Piece;

})(typeof module !== 'undefined' ? module.exports : (window.GamePiece = {}));
