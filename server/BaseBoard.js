'use strict';

// UMD: works in Node.js (require) and browser (window.BaseBoardModule)
(function(exports) {

const constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
const GameRandomizer = (typeof require !== 'undefined') ? require('./Randomizer') : window.GameRandomizer;

const LOCK_DELAY_MS = constants.LOCK_DELAY_MS;
const MAX_LOCK_RESETS = constants.MAX_LOCK_RESETS;
const LINE_CLEAR_DELAY_MS = constants.LINE_CLEAR_DELAY_MS;
const MAX_DROPS_PER_TICK = constants.MAX_DROPS_PER_TICK;
const MAX_SPEED_LEVEL = constants.MAX_SPEED_LEVEL;
const SOFT_DROP_MULTIPLIER = constants.SOFT_DROP_MULTIPLIER;

const Randomizer = GameRandomizer.Randomizer;

const NEXT_QUEUE_SIZE = 4;

class BaseBoard {
  /**
   * @param {string} playerId
   * @param {number} seed
   * @param {number} startLevel
   * @param {object} config - { cols, totalRows, bufferRows, pieceTypes }
   *   pieceTypes is optional; passed to Randomizer if provided.
   */
  constructor(playerId, seed, startLevel, config) {
    this.playerId = playerId;
    this.cols = config.cols;
    this.totalRows = config.totalRows;
    this.bufferRows = config.bufferRows;
    this.grid = Array.from({ length: config.totalRows }, () => new Array(config.cols).fill(0));
    this.currentPiece = null;
    this.holdPiece = null;
    this.holdUsed = false;
    this.nextPieces = [];
    this.lines = 0;
    this.startLevel = startLevel || 1;
    this.randomizer = config.pieceTypes
      ? new Randomizer(seed, config.pieceTypes)
      : new Randomizer(seed);
    this.alive = true;
    this.lockTimer = null;
    this.lockResets = 0;
    this.gravityCounter = 0;
    this.softDropping = false;
    this.softDropSpeed = SOFT_DROP_MULTIPLIER;
    this.pendingGarbage = [];
    this.clearingTimer = null;
    this.gridVersion = 0;   // bumped on lock/clear/garbage for dirty tracking

    // Subclasses must call this._fillNextQueue() in their own constructor
    // (after setting up any subclass-specific state).
  }

  _fillNextQueue() {
    while (this.nextPieces.length < NEXT_QUEUE_SIZE + 1) {
      this.nextPieces.push(this.randomizer.next());
    }
  }

  // --- Abstract methods (must be overridden) ---

  /** Create a new piece of the given type. */
  _createPiece(type) {
    throw new Error('BaseBoard._createPiece() must be overridden');
  }

  /** Returns true if the board is in a line-clearing animation state. */
  _isClearing() {
    throw new Error('BaseBoard._isClearing() must be overridden');
  }

  /** Try to drop piece by one cell. Returns the new piece, or null if blocked. */
  _drop(piece) {
    throw new Error('BaseBoard._drop() must be overridden');
  }

  /** Check if piece is resting on a surface (cannot drop further). */
  _isOnSurface() {
    throw new Error('BaseBoard._isOnSurface() must be overridden');
  }

  /** Pre-drop piece to visible area. Called after spawn/hold. */
  _preDropToVisible() {
    throw new Error('BaseBoard._preDropToVisible() must be overridden');
  }

  isValidPosition(piece) {
    // Classic Piece has getBlocks() (static array) + x/y offset — no allocation.
    // HexPiece lacks getBlocks(); uses _absoluteBlocksFast() for axial→offset conversion.
    if (piece.getBlocks) {
      const blocks = piece.getBlocks();
      const px = piece.x, py = piece.y;
      for (let i = 0; i < blocks.length; i++) {
        const col = blocks[i][0] + px, row = blocks[i][1] + py;
        if (col < 0 || col >= this.cols) return false;
        if (row < 0 || row >= this.totalRows) return false;
        if (this.grid[row][col] !== 0) return false;
      }
    } else {
      const blocks = piece._absoluteBlocksFast();
      for (let i = 0; i < blocks.length; i++) {
        const col = blocks[i][0], row = blocks[i][1];
        if (col < 0 || col >= this.cols) return false;
        if (row < 0 || row >= this.totalRows) return false;
        if (this.grid[row][col] !== 0) return false;
      }
    }
    return true;
  }

  lockPiece() {
    if (!this.currentPiece) return;
    if (this.currentPiece.getBlocks) {
      const blocks = this.currentPiece.getBlocks();
      const px = this.currentPiece.x, py = this.currentPiece.y;
      for (let i = 0; i < blocks.length; i++) {
        const col = blocks[i][0] + px, row = blocks[i][1] + py;
        if (row >= 0 && row < this.totalRows && col >= 0 && col < this.cols) {
          this.grid[row][col] = this.currentPiece.typeId;
        }
      }
    } else {
      const blocks = this.currentPiece._absoluteBlocksFast();
      for (let i = 0; i < blocks.length; i++) {
        const col = blocks[i][0], row = blocks[i][1];
        if (row >= 0 && row < this.totalRows && col >= 0 && col < this.cols) {
          this.grid[row][col] = this.currentPiece.typeId;
        }
      }
    }
    this.gridVersion++;
  }

  /** Lock and process (clear lines, spawn next). Returns result object. */
  _lockAndProcess() {
    throw new Error('BaseBoard._lockAndProcess() must be overridden');
  }

  /** Finish clearing animation and remove lines. */
  _finishClearLines() {
    throw new Error('BaseBoard._finishClearLines() must be overridden');
  }

  // --- Shared methods ---

  spawnPiece() {
    this._fillNextQueue();
    const type = this.nextPieces.shift();
    this.currentPiece = this._createPiece(type);
    this.holdUsed = false;
    this.lockTimer = null;
    this.lockResets = 0;

    if (!this.isValidPosition(this.currentPiece)) {
      this.alive = false;
      return false;
    }

    this._preDropToVisible();
    return true;
  }

  hold() {
    if (!this.currentPiece || !this.alive || this.holdUsed) return false;
    const currentType = this.currentPiece.type;

    if (this.holdPiece) {
      this.currentPiece = this._createPiece(this.holdPiece);
      this.holdPiece = currentType;
    } else {
      this.holdPiece = currentType;
      this._fillNextQueue();
      const nextType = this.nextPieces.shift();
      this.currentPiece = this._createPiece(nextType);
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

  softDropStart(speed) {
    if (!this.softDropping) {
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

  _resetLockTimerIfOnSurface() {
    if (!this.currentPiece) return;
    if (this._isOnSurface()) {
      if (this.lockResets < MAX_LOCK_RESETS) {
        this.lockTimer = LOCK_DELAY_MS;
        this.lockResets++;
      }
    } else {
      this.lockTimer = null;
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

  getStackHeight() {
    for (let row = 0; row < this.totalRows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (this.grid[row][col] !== 0) return this.totalRows - row;
      }
    }
    return 0;
  }

  tick(deltaMs) {
    if (!this.alive) return null;

    // Handle line clear animation delay
    if (this._isClearing()) {
      this.clearingTimer -= deltaMs;
      if (this.clearingTimer <= 0) {
        this._finishClearLines();
      }
      return null;
    }

    if (!this.currentPiece) return null;

    const level = this.getLevel();
    let gravityFrames = Math.max(2, Math.round(50 / (1 + Math.min(level, MAX_SPEED_LEVEL) * 0.45)));

    if (this.softDropping) {
      gravityFrames = Math.max(1, Math.floor(gravityFrames / this.softDropSpeed));
    }

    const frames = deltaMs / (1000 / 60);
    this.gravityCounter += frames;

    let dropsThisTick = 0;
    while (this.gravityCounter >= gravityFrames && dropsThisTick < MAX_DROPS_PER_TICK) {
      this.gravityCounter -= gravityFrames;
      dropsThisTick++;
      const dropped = this._drop(this.currentPiece);
      if (dropped) {
        this.currentPiece = dropped;
        if (this._isOnSurface()) {
          if (this.lockTimer === null) {
            this.lockTimer = LOCK_DELAY_MS;
          }
        } else {
          this.lockTimer = null;
        }
      } else {
        if (this.lockTimer === null) {
          this.lockTimer = LOCK_DELAY_MS;
        }
        this.gravityCounter = 0;
        break;
      }
    }

    if (dropsThisTick >= MAX_DROPS_PER_TICK) {
      this.gravityCounter = 0;
    }

    if (this.lockTimer !== null) {
      this.lockTimer -= deltaMs;
      if (this.lockTimer <= 0) {
        return this._lockAndProcess();
      }
    }

    return null;
  }
}

exports.BaseBoard = BaseBoard;
exports.LINE_CLEAR_DELAY_MS = LINE_CLEAR_DELAY_MS;

})(typeof module !== 'undefined' ? module.exports : (window.BaseBoardModule = {}));
