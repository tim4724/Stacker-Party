'use strict';

// UMD: works in Node.js (require) and browser (window.GamePlayerBoard)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var BOARD_WIDTH = constants.BOARD_WIDTH;
var BOARD_HEIGHT = constants.BOARD_HEIGHT;

var BUFFER_ROWS = constants.BUFFER_ROWS;
var SOFT_DROP_MULTIPLIER = constants.SOFT_DROP_MULTIPLIER;
var LOCK_DELAY_MS = constants.LOCK_DELAY_MS;
var MAX_LOCK_RESETS = constants.MAX_LOCK_RESETS;
var GARBAGE_CELL = constants.GARBAGE_CELL;
var LINE_CLEAR_DELAY_MS = constants.LINE_CLEAR_DELAY_MS;
var MAX_DROPS_PER_TICK = constants.MAX_DROPS_PER_TICK;
var MAX_SPEED_LEVEL = constants.MAX_SPEED_LEVEL;

var Piece = ((typeof require !== 'undefined') ? require('./Piece') : window.GamePiece).Piece;
var Randomizer = ((typeof require !== 'undefined') ? require('./Randomizer') : window.GameRandomizer).Randomizer;
const NEXT_QUEUE_SIZE = 4;

class PlayerBoard {
  constructor(playerId, seed, startLevel) {
    this.playerId = playerId;
    // 10 wide x 26 tall grid (0=empty, 1-7=piece type, 8=garbage)
    this.grid = Array.from({ length: BOARD_HEIGHT }, () => new Array(BOARD_WIDTH).fill(0));
    this.currentPiece = null;
    this.holdPiece = null;
    this.holdUsed = false;
    this.nextPieces = [];
    this.lines = 0;
    this.startLevel = startLevel || 1;
    this.randomizer = new Randomizer(seed);
    this.alive = true;
    this.lockTimer = null;
    this.lockResets = 0;
    this.gravityCounter = 0;
    this.softDropping = false;
    this.softDropSpeed = SOFT_DROP_MULTIPLIER;
    this.pendingGarbage = [];

    // Line clear animation state
    this.clearingRows = null;
    this.clearingTimer = null;

    // Fill the next queue
    this._fillNextQueue();
  }

  _fillNextQueue() {
    while (this.nextPieces.length < NEXT_QUEUE_SIZE + 1) {
      this.nextPieces.push(this.randomizer.next());
    }
  }

  spawnPiece() {
    this._fillNextQueue();
    const type = this.nextPieces.shift();
    this.currentPiece = new Piece(type);
    this.holdUsed = false;
    this.lockTimer = null;
    this.lockResets = 0;

    // Check if spawn position is valid
    if (!this.isValidPosition(this.currentPiece)) {
      this.alive = false;
      return false;
    }

    this._preDropToVisible();
    return true;
  }

  // Pre-drop piece to the edge of the visible area so it appears immediately.
  _preDropToVisible() {
    if (!this.currentPiece) return;
    const targetY = BUFFER_ROWS - 1;
    while (this.currentPiece.y < targetY) {
      const test = this.currentPiece.clone();
      test.y += 1;
      if (this.isValidPosition(test)) {
        this.currentPiece.y = test.y;
      } else {
        break;
      }
    }
    // Reset gravity counter for fresh timing
    this.gravityCounter = 0;
  }

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

  _resetLockTimerIfOnSurface() {
    if (!this.currentPiece) return;
    if (this._isOnSurface()) {
      if (this.lockResets < MAX_LOCK_RESETS) {
        this.lockTimer = LOCK_DELAY_MS;
        this.lockResets++;
      }
    } else {
      // Piece moved to a position with space below — clear lock timer so gravity continues
      this.lockTimer = null;
    }
  }

  _isOnSurface() {
    if (!this.currentPiece) return false;
    const test = this.currentPiece.clone();
    test.y += 1;
    return !this.isValidPosition(test);
  }

  softDropStart(speed) {
    if (!this.softDropping) {
      // Reset gravity counter to prevent teleporting from accumulated gravity
      this.gravityCounter = 0;
    }
    this.softDropping = true;
    if (speed != null) {
      this.softDropSpeed = speed;
    }
  }

  softDropEnd() {
    this.softDropping = false;
    this.softDropSpeed = SOFT_DROP_MULTIPLIER;
  }

  getLevel() {
    return Math.floor(this.lines / 10) + this.startLevel;
  }

  hardDrop() {
    if (!this.currentPiece || !this.alive) return null;
    while (true) {
      const test = this.currentPiece.clone();
      test.y += 1;
      if (this.isValidPosition(test)) {
        this.currentPiece.y = test.y;
      } else {
        break;
      }
    }
    return this._lockAndProcess();
  }

  hold() {
    if (!this.currentPiece || !this.alive || this.holdUsed) return false;
    const currentType = this.currentPiece.type;

    if (this.holdPiece) {
      this.currentPiece = new Piece(this.holdPiece);
      this.holdPiece = currentType;
    } else {
      this.holdPiece = currentType;
      this._fillNextQueue();
      const nextType = this.nextPieces.shift();
      this.currentPiece = new Piece(nextType);
    }

    this.holdUsed = true;
    this.lockTimer = null;
    this.lockResets = 0;

    if (!this.isValidPosition(this.currentPiece)) {
      this.alive = false;
      return false;
    }
    this._preDropToVisible();
    return true;
  }

  tick(deltaMs) {
    if (!this.alive) return null;

    // Handle line clear animation delay
    if (this.clearingRows) {
      this.clearingTimer -= deltaMs;
      if (this.clearingTimer <= 0) {
        this._finishClearLines();
      }
      return null;
    }

    if (!this.currentPiece) return null;

    const level = this.getLevel();
    let gravityFrames = Math.max(2, Math.round(50 / (1 + Math.min(level, MAX_SPEED_LEVEL) * 0.45)));

    // Soft drop accelerates gravity
    if (this.softDropping) {
      gravityFrames = Math.max(1, Math.floor(gravityFrames / this.softDropSpeed));
    }

    // Convert deltaMs to frames (60fps)
    const frames = deltaMs / (1000 / 60);
    this.gravityCounter += frames;

    // Apply gravity with safety cap to prevent teleporting
    let softDropCells = 0;
    let dropsThisTick = 0;
    while (this.gravityCounter >= gravityFrames && dropsThisTick < MAX_DROPS_PER_TICK) {
      this.gravityCounter -= gravityFrames;
      dropsThisTick++;
      const test = this.currentPiece.clone();
      test.y += 1;
      if (this.isValidPosition(test)) {
        this.currentPiece.y = test.y;
        if (this.softDropping) {
          softDropCells++;
        }
        // Reset lock timer when piece moves down
        if (this._isOnSurface()) {
          if (this.lockTimer === null) {
            this.lockTimer = LOCK_DELAY_MS;
          }
        } else {
          this.lockTimer = null;
        }
      } else {
        // Can't drop further, start lock timer if not already
        if (this.lockTimer === null) {
          this.lockTimer = LOCK_DELAY_MS;
        }
        this.gravityCounter = 0;
        break;
      }
    }

    // Reset excess accumulation if cap was hit
    if (dropsThisTick >= MAX_DROPS_PER_TICK) {
      this.gravityCounter = 0;
    }

    // Decrement and check lock timer
    if (this.lockTimer !== null) {
      this.lockTimer -= deltaMs;
      if (this.lockTimer <= 0) {
        return this._lockAndProcess();
      }
    }

    return null;
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

  lockPiece() {
    if (!this.currentPiece) return;
    const blocks = this.currentPiece.getAbsoluteBlocks();
    for (const [col, row] of blocks) {
      if (row >= 0 && row < BOARD_HEIGHT && col >= 0 && col < BOARD_WIDTH) {
        this.grid[row][col] = this.currentPiece.typeId;
      }
    }
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
  }

  addPendingGarbage(lines, gapColumn) {
    this.pendingGarbage.push({ lines, gapColumn });
  }

  _applyPendingGarbage() {
    for (const { lines, gapColumn } of this.pendingGarbage) {
      this.applyGarbage(lines, gapColumn);
    }
    this.pendingGarbage = [];
  }

  getGhostY() {
    if (!this.currentPiece) return 0;
    const test = this.currentPiece.clone();
    while (true) {
      test.y += 1;
      if (!this.isValidPosition(test)) {
        return test.y - 1;
      }
    }
  }

  isValidPosition(piece) {
    const blocks = piece.getAbsoluteBlocks();
    for (const [col, row] of blocks) {
      if (col < 0 || col >= BOARD_WIDTH) return false;
      if (row < 0 || row >= BOARD_HEIGHT) return false;
      if (this.grid[row][col] !== 0) return false;
    }
    return true;
  }

  getStackHeight() {
    for (let row = 0; row < BOARD_HEIGHT; row++) {
      for (let col = 0; col < BOARD_WIDTH; col++) {
        if (this.grid[row][col] !== 0) return BOARD_HEIGHT - row;
      }
    }
    return 0;
  }

  getState() {
    // Return only visible rows (bottom 22 of the 26-row grid)
    const visibleGrid = this.grid.slice(BUFFER_ROWS);

    return {
      grid: visibleGrid,
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
      nextPieces: this.nextPieces.slice(0, 3),
      level: this.getLevel(),
      lines: this.lines,
      alive: this.alive,
      pendingGarbage: this.pendingGarbage.reduce((sum, g) => sum + g.lines, 0),
      clearingRows: this.clearingRows ? this.clearingRows.map(r => r - BUFFER_ROWS) : null
    };
  }
}

exports.PlayerBoard = PlayerBoard;

})(typeof module !== 'undefined' ? module.exports : (window.GamePlayerBoard = {}));
