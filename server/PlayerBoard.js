'use strict';

// UMD: works in Node.js (require) and browser (window.GamePlayerBoard)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var BaseBoardModule = (typeof require !== 'undefined') ? require('./BaseBoard') : window.BaseBoardModule;

var BOARD_WIDTH = constants.BOARD_WIDTH;
var BOARD_HEIGHT = constants.BOARD_HEIGHT;
var BUFFER_ROWS = constants.BUFFER_ROWS;
var GARBAGE_CELL = constants.GARBAGE_CELL;

var BaseBoard = BaseBoardModule.BaseBoard;
var LINE_CLEAR_DELAY_MS = BaseBoardModule.LINE_CLEAR_DELAY_MS;

var Piece = ((typeof require !== 'undefined') ? require('./Piece') : window.GamePiece).Piece;

class PlayerBoard extends BaseBoard {
  constructor(playerId, seed, startLevel) {
    super(playerId, seed, startLevel, {
      cols: BOARD_WIDTH,
      totalRows: BOARD_HEIGHT,
      bufferRows: BUFFER_ROWS
    });

    // Line clear animation state
    this.clearingRows = null;

    // Ghost cache (invalidated when piece moves or grid changes)
    this._cachedGhostY = 0;
    this._ghostKeyX = -1;
    this._ghostKeyY = -1;
    this._ghostKeyRot = -1;
    this._ghostKeyGV = -1;

    // Visible grid cache (re-sliced only when gridVersion changes)
    this._visibleGrid = null;
    this._visibleGridVersion = -1;
    this._cachedNextPieces = null;
    this._cachedNextVersion = -1;

    // Fill the next queue
    this._fillNextQueue();
  }

  // --- Abstract method implementations ---

  _createPiece(type) {
    return new Piece(type);
  }

  _isClearing() {
    return this.clearingRows !== null;
  }

  _drop(piece) {
    piece.y += 1;
    if (this.isValidPosition(piece)) return piece;
    piece.y -= 1;
    return null;
  }

  _isOnSurface() {
    if (!this.currentPiece) return false;
    this.currentPiece.y += 1;
    var blocked = !this.isValidPosition(this.currentPiece);
    this.currentPiece.y -= 1;
    return blocked;
  }

  _preDropToVisible() {
    if (!this.currentPiece) return;
    var targetY = BUFFER_ROWS - 1;
    while (this.currentPiece.y < targetY) {
      this.currentPiece.y += 1;
      if (!this.isValidPosition(this.currentPiece)) {
        this.currentPiece.y -= 1;
        break;
      }
    }
    this.gravityCounter = 0;
  }

  // --- Classic-specific methods ---

  moveLeft() {
    if (!this.currentPiece || !this.alive) return false;
    const test = this.currentPiece.clone();
    test.x -= 1;
    if (this.isValidPosition(test)) {
      this.currentPiece.x = test.x;
      this._resetLockTimerIfOnSurface();
      return true;
    }
    return false;
  }

  moveRight() {
    if (!this.currentPiece || !this.alive) return false;
    const test = this.currentPiece.clone();
    test.x += 1;
    if (this.isValidPosition(test)) {
      this.currentPiece.x = test.x;
      this._resetLockTimerIfOnSurface();
      return true;
    }
    return false;
  }

  rotateCW() {
    if (!this.currentPiece || !this.alive) return false;
    if (this.currentPiece.type === 'O') return false;

    const toRotation = (this.currentPiece.rotation + 1) % 4;
    const kicks = this.currentPiece.getWallKicks();

    for (const [dx, dy] of kicks) {
      const test = this.currentPiece.clone();
      test.rotation = toRotation;
      test.x += dx;
      test.y -= dy; // kick offsets use y-up, our grid is y-down
      if (this.isValidPosition(test)) {
        this.currentPiece.rotation = toRotation;
        this.currentPiece.x = test.x;
        this.currentPiece.y = test.y;
        this._resetLockTimerIfOnSurface();
        return true;
      }
    }
    return false;
  }

  hardDrop() {
    if (!this.currentPiece || !this.alive) return null;
    this.currentPiece.y = this.getGhostY();
    return this._lockAndProcess();
  }

  _lockAndProcess() {
    // Capture locked block positions before lockPiece() clears currentPiece
    var lockedBlocks = [];
    var lockedTypeId = 0;
    if (this.currentPiece) {
      lockedTypeId = this.currentPiece.typeId;
      var abs = this.currentPiece.getAbsoluteBlocks();
      for (var i = 0; i < abs.length; i++) {
        var visibleRow = abs[i][1] - BUFFER_ROWS;
        if (visibleRow >= 0) {
          lockedBlocks.push([abs[i][0], visibleRow]);
        }
      }
    }

    this.lockPiece();

    // Detect full rows
    const fullRows = [];
    for (let row = 0; row < BOARD_HEIGHT; row++) {
      if (this.grid[row].every(cell => cell !== 0)) {
        fullRows.push(row);
      }
    }

    const linesCleared = fullRows.length;

    if (linesCleared > 0) {
      this.lines += linesCleared;

      // Start clearing animation - delay actual row removal
      this.clearingRows = fullRows;
      this.clearingTimer = LINE_CLEAR_DELAY_MS;
      this.currentPiece = null;
    } else {
      this._applyPendingGarbage();
      this.spawnPiece();
    }

    return {
      linesCleared,
      fullRows: fullRows.map(r => r - BUFFER_ROWS),
      alive: this.alive,
      lockedBlocks,
      lockedTypeId
    };
  }

  _finishClearLines() {
    if (!this.clearingRows) return;
    this.gridVersion++;

    // Remove the clearing rows from the grid
    for (let i = this.clearingRows.length - 1; i >= 0; i--) {
      this.grid.splice(this.clearingRows[i], 1);
    }
    // Add empty rows at top to maintain board height
    for (let i = 0; i < this.clearingRows.length; i++) {
      this.grid.unshift(new Array(BOARD_WIDTH).fill(0));
    }

    this.clearingRows = null;
    this.clearingTimer = null;

    this._applyPendingGarbage();
    this.spawnPiece();
  }

  applyGarbage(lines, gapColumn) {
    // Remove rows from top to make room
    this.grid.splice(0, lines);
    // Add garbage rows at bottom
    for (let i = 0; i < lines; i++) {
      const row = new Array(BOARD_WIDTH).fill(GARBAGE_CELL);
      row[gapColumn] = 0;
      this.grid.push(row);
    }
    this.gridVersion++;
  }

  getGhostY() {
    if (!this.currentPiece) return 0;
    var p = this.currentPiece;
    if (p.x === this._ghostKeyX && p.y === this._ghostKeyY &&
        p.rotation === this._ghostKeyRot && this.gridVersion === this._ghostKeyGV) {
      return this._cachedGhostY;
    }
    const test = p.clone();
    while (true) {
      test.y += 1;
      if (!this.isValidPosition(test)) {
        this._cachedGhostY = test.y - 1;
        this._ghostKeyX = p.x; this._ghostKeyY = p.y;
        this._ghostKeyRot = p.rotation; this._ghostKeyGV = this.gridVersion;
        return this._cachedGhostY;
      }
    }
  }

  // Returns snapshot for rendering. grid and nextPieces are cached references —
  // callers must treat the returned object as read-only. Row arrays are shared
  // with the live grid, so call only once per tick after all mutations are complete.
  getState() {
    if (this.gridVersion !== this._visibleGridVersion) {
      this._visibleGrid = this.grid.slice(BUFFER_ROWS);
      this._visibleGridVersion = this.gridVersion;
    }
    if (this._nextVersion !== this._cachedNextVersion) {
      this._cachedNextPieces = this.nextPieces.slice(0, 3);
      this._cachedNextVersion = this._nextVersion;
    }

    return {
      grid: this._visibleGrid,
      currentPiece: this.currentPiece ? {
        type: this.currentPiece.type,
        typeId: this.currentPiece.typeId,
        rotation: this.currentPiece.rotation,
        x: this.currentPiece.x,
        y: this.currentPiece.y - BUFFER_ROWS,
        blocks: this.currentPiece.getBlocks()
      } : null,
      ghostY: this.currentPiece ? this.getGhostY() - BUFFER_ROWS : null,
      holdPiece: this.holdPiece,
      nextPieces: this._cachedNextPieces,
      level: this.getLevel(),
      lines: this.lines,
      alive: this.alive,
      pendingGarbage: this.pendingGarbage.reduce((sum, g) => sum + g.lines, 0),
      clearingRows: this.clearingRows ? this.clearingRows.map(r => r - BUFFER_ROWS) : null,
      gridVersion: this.gridVersion
    };
  }
}

exports.PlayerBoard = PlayerBoard;

})(typeof module !== 'undefined' ? module.exports : (window.GamePlayerBoard = {}));
