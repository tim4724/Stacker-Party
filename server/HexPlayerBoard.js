'use strict';

// UMD: works in Node.js (require) and browser (window.HexPlayerBoardModule)
// Flat-top hex board — columns are vertically aligned, so left/right is col ± 1.
(function(exports) {

var hexConst = (typeof require !== 'undefined') ? require('./HexConstants') : window.HexConstants;
var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var HexPieceModule = (typeof require !== 'undefined') ? require('./HexPiece') : window.HexPieceModule;
var GameRandomizer = (typeof require !== 'undefined') ? require('./Randomizer') : window.GameRandomizer;

var findClearableZigzags = hexConst.findClearableZigzags;
var HEX_COLS = hexConst.HEX_COLS;
var HEX_TOTAL_ROWS = hexConst.HEX_TOTAL_ROWS;
var HEX_BUFFER_ROWS = hexConst.HEX_BUFFER_ROWS;
var HEX_PIECE_TYPES = hexConst.HEX_PIECE_TYPES;
var HEX_GARBAGE_CELL = hexConst.HEX_GARBAGE_CELL;

var LOCK_DELAY_MS = constants.LOCK_DELAY_MS;
var MAX_LOCK_RESETS = constants.MAX_LOCK_RESETS;
var LINE_CLEAR_DELAY_MS = constants.LINE_CLEAR_DELAY_MS;
var MAX_DROPS_PER_TICK = constants.MAX_DROPS_PER_TICK;
var MAX_SPEED_LEVEL = constants.MAX_SPEED_LEVEL;
var SOFT_DROP_MULTIPLIER = constants.SOFT_DROP_MULTIPLIER;

var HexPiece = HexPieceModule.HexPiece;
var KICKS = HexPieceModule.KICKS;
var Randomizer = GameRandomizer.Randomizer;

var NEXT_QUEUE_SIZE = 4;

// ===================== HEX PLAYER BOARD =====================
class HexPlayerBoard {
  constructor(playerId, seed, startLevel) {
    this.playerId = playerId;
    this.grid = Array.from({ length: HEX_TOTAL_ROWS }, function() { return new Array(HEX_COLS).fill(0); });
    this.currentPiece = null;
    this.holdPiece = null;
    this.holdUsed = false;
    this.nextPieces = [];
    this.lines = 0;
    this.startLevel = startLevel || 1;
    this.randomizer = new Randomizer(seed, HEX_PIECE_TYPES);
    this.alive = true;
    this.lockTimer = null;
    this.lockResets = 0;
    this.gravityCounter = 0;
    this.softDropping = false;
    this.softDropSpeed = SOFT_DROP_MULTIPLIER;
    this.pendingGarbage = [];

    this.clearingCells = null;
    this.clearingTimer = null;

    this._fillNextQueue();
  }

  _fillNextQueue() {
    while (this.nextPieces.length < NEXT_QUEUE_SIZE + 1) {
      this.nextPieces.push(this.randomizer.next());
    }
  }

  // ===================== DROP =====================
  // Simple drop: row + 1, same column. No lane system needed.
  _hexDrop(piece) {
    var newRow = piece.anchorRow + 1;
    if (newRow >= HEX_TOTAL_ROWS) return null;
    var test = piece.clone();
    test.anchorRow = newRow;
    if (this.isValidPosition(test)) return test;
    return null;
  }

  _ghostOf(piece) {
    var g = piece.clone();
    for (var i = 0; i < HEX_TOTAL_ROWS; i++) {
      var n = this._hexDrop(g);
      if (!n) return g;
      g = n;
    }
    return g;
  }

  // ===================== SPAWN =====================
  spawnPiece() {
    this._fillNextQueue();
    var type = this.nextPieces.shift();
    this.currentPiece = new HexPiece(type);
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

  _preDropToVisible() {
    if (!this.currentPiece) return;
    while (this.currentPiece.anchorRow < HEX_BUFFER_ROWS - 1) {
      var next = this._hexDrop(this.currentPiece);
      if (!next) break;
      this.currentPiece = next;
    }
    this.gravityCounter = 0;
  }

  // ===================== MOVEMENT =====================
  // Flat-top: columns are straight, so left/right is simply col ± 1
  moveLeft() {
    if (!this.currentPiece || !this.alive) return false;
    return this._move(-1);
  }

  moveRight() {
    if (!this.currentPiece || !this.alive) return false;
    return this._move(1);
  }

  _move(dir) {
    var test = this.currentPiece.clone();
    test.anchorCol += dir;
    if (!this.isValidPosition(test)) return false;
    this.currentPiece = test;
    this._resetLockTimerIfOnSurface();
    return true;
  }

  // ===================== ROTATION =====================
  rotateCW() {
    if (!this.currentPiece || !this.alive) return false;
    return this._tryRotate('cw');
  }

  rotateCCW() {
    if (!this.currentPiece || !this.alive) return false;
    return this._tryRotate('ccw');
  }

  _tryRotate(dir) {
    var test = this.currentPiece.clone();
    if (dir === 'cw') test.rotateCW(); else test.rotateCCW();
    test._adjustAnchorRow();

    for (var i = 0; i < KICKS.length; i++) {
      var kicked = test.clone();
      kicked.anchorCol += KICKS[i][0];
      kicked.anchorRow += KICKS[i][1];
      if (!this.isValidPosition(kicked)) continue;
      this.currentPiece = kicked;
      this._resetLockTimerIfOnSurface();
      return true;
    }
    return false;
  }

  // ===================== HARD DROP =====================
  hardDrop() {
    if (!this.currentPiece || !this.alive) return null;
    this.currentPiece = this._ghostOf(this.currentPiece);
    return this._lockAndProcess();
  }

  // ===================== HOLD =====================
  hold() {
    if (!this.currentPiece || !this.alive || this.holdUsed) return false;
    var currentType = this.currentPiece.type;

    if (this.holdPiece) {
      this.currentPiece = new HexPiece(this.holdPiece);
      this.holdPiece = currentType;
    } else {
      this.holdPiece = currentType;
      this._fillNextQueue();
      var nextType = this.nextPieces.shift();
      this.currentPiece = new HexPiece(nextType);
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

  // ===================== SOFT DROP =====================
  softDropStart(speed) {
    if (!this.softDropping) this.gravityCounter = 0;
    this.softDropping = true;
    if (speed != null) this.softDropSpeed = speed;
  }

  softDropEnd() {
    this.softDropping = false;
    this.softDropSpeed = SOFT_DROP_MULTIPLIER;
  }

  // ===================== TICK (GRAVITY) =====================
  getLevel() {
    return Math.floor(this.lines / 10) + this.startLevel;
  }

  tick(deltaMs) {
    if (!this.alive) return null;

    if (this.clearingCells) {
      this.clearingTimer -= deltaMs;
      if (this.clearingTimer <= 0) this._finishClearLines();
      return null;
    }

    if (!this.currentPiece) return null;

    var level = this.getLevel();
    var gravityFrames = Math.max(2, Math.round(50 / (1 + Math.min(level, MAX_SPEED_LEVEL) * 0.45)));

    if (this.softDropping) {
      gravityFrames = Math.max(1, Math.floor(gravityFrames / this.softDropSpeed));
    }

    var frames = deltaMs / (1000 / 60);
    this.gravityCounter += frames;

    var dropsThisTick = 0;
    while (this.gravityCounter >= gravityFrames && dropsThisTick < MAX_DROPS_PER_TICK) {
      this.gravityCounter -= gravityFrames;
      dropsThisTick++;
      var next = this._hexDrop(this.currentPiece);
      if (next) {
        this.currentPiece = next;
        if (this._isOnSurface()) {
          if (this.lockTimer === null) this.lockTimer = LOCK_DELAY_MS;
        } else {
          this.lockTimer = null;
        }
      } else {
        if (this.lockTimer === null) this.lockTimer = LOCK_DELAY_MS;
        this.gravityCounter = 0;
        break;
      }
    }

    if (dropsThisTick >= MAX_DROPS_PER_TICK) this.gravityCounter = 0;

    if (this.lockTimer !== null) {
      this.lockTimer -= deltaMs;
      if (this.lockTimer <= 0) return this._lockAndProcess();
    }

    return null;
  }

  // ===================== LOCK & LINE CLEAR =====================
  _isOnSurface() {
    if (!this.currentPiece) return false;
    return this._hexDrop(this.currentPiece) === null;
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

  _lockAndProcess() {
    var lockedBlocks = [];
    var lockedTypeId = 0;
    if (this.currentPiece) {
      lockedTypeId = this.currentPiece.typeId;
      var abs = this.currentPiece.getAbsoluteBlocks();
      for (var i = 0; i < abs.length; i++) {
        var visibleRow = abs[i][1] - HEX_BUFFER_ROWS;
        if (visibleRow >= 0) lockedBlocks.push([abs[i][0], visibleRow]);
      }
    }

    this.lockPiece();

    var grid = this.grid;
    var result = findClearableZigzags(HEX_COLS, HEX_TOTAL_ROWS, function(col, row) {
      return grid[row][col] !== 0;
    }, null, HEX_BUFFER_ROWS);
    var linesCleared = result.linesCleared;
    var clearCells = result.clearCells;

    if (linesCleared > 0) {
      this.lines += linesCleared;
      // Store clearing cells as array of [col, row] for animation
      this.clearingCells = [];
      for (var key in clearCells) {
        var parts = key.split(',');
        this.clearingCells.push([parseInt(parts[0]), parseInt(parts[1])]);
      }
      this.clearingTimer = LINE_CLEAR_DELAY_MS;
      this.currentPiece = null;
    } else {
      this._applyPendingGarbage();
      this.spawnPiece();
    }

    // Return visible-coordinate cells for renderer
    var visibleClearCells = [];
    if (this.clearingCells) {
      for (var vc = 0; vc < this.clearingCells.length; vc++) {
        var vr = this.clearingCells[vc][1] - HEX_BUFFER_ROWS;
        if (vr >= 0) visibleClearCells.push([this.clearingCells[vc][0], vr]);
      }
    }

    return {
      linesCleared: linesCleared,
      clearCells: visibleClearCells,
      alive: this.alive,
      lockedBlocks: lockedBlocks,
      lockedTypeId: lockedTypeId
    };
  }

  _finishClearLines() {
    if (!this.clearingCells) return;

    // Build set of cleared positions per column, sorted top-to-bottom
    var clearedByCol = {};
    for (var i = 0; i < this.clearingCells.length; i++) {
      var col = this.clearingCells[i][0], row = this.clearingCells[i][1];
      if (row >= 0 && row < HEX_TOTAL_ROWS && col >= 0 && col < HEX_COLS) {
        if (!clearedByCol[col]) clearedByCol[col] = [];
        clearedByCol[col].push(row);
      }
    }

    // For each column, remove only the cleared cells and shift above down.
    // Preserves pre-existing gaps — only the cleared positions collapse.
    for (var c = 0; c < HEX_COLS; c++) {
      var cleared = clearedByCol[c];
      if (!cleared) continue;
      cleared.sort(function(a, b) { return b - a; }); // bottom-first
      for (var ci = 0; ci < cleared.length; ci++) {
        var cr = cleared[ci];
        // Shift everything above cr down by 1
        for (var sr = cr; sr > 0; sr--) {
          this.grid[sr][c] = this.grid[sr - 1][c];
        }
        this.grid[0][c] = 0;
        // Adjust remaining cleared positions (they shifted down by 1 if above cr)
        for (var cj = ci + 1; cj < cleared.length; cj++) {
          if (cleared[cj] < cr) cleared[cj]++;
        }
      }
    }

    this.clearingCells = null;
    this.clearingTimer = null;
    this._applyPendingGarbage();
    this.spawnPiece();
  }

  lockPiece() {
    if (!this.currentPiece) return;
    var blocks = this.currentPiece.getAbsoluteBlocks();
    for (var i = 0; i < blocks.length; i++) {
      var col = blocks[i][0], row = blocks[i][1];
      if (row >= 0 && row < HEX_TOTAL_ROWS && col >= 0 && col < HEX_COLS) {
        this.grid[row][col] = this.currentPiece.typeId;
      }
    }
  }

  // ===================== GARBAGE =====================
  applyGarbage(lines, gapColumn) {
    lines = Math.min(lines, HEX_TOTAL_ROWS);
    this.grid.splice(0, lines);
    for (var i = 0; i < lines; i++) {
      var row = new Array(HEX_COLS).fill(HEX_GARBAGE_CELL);
      row[gapColumn % HEX_COLS] = 0;
      this.grid.push(row);
    }
  }

  addPendingGarbage(lines, gapColumn) {
    this.pendingGarbage.push({ lines: lines, gapColumn: gapColumn });
  }

  _applyPendingGarbage() {
    for (var i = 0; i < this.pendingGarbage.length; i++) {
      this.applyGarbage(this.pendingGarbage[i].lines, this.pendingGarbage[i].gapColumn);
    }
    this.pendingGarbage = [];
  }

  // ===================== QUERIES =====================
  isValidPosition(piece) {
    var blocks = piece.getAbsoluteBlocks();
    for (var i = 0; i < blocks.length; i++) {
      var col = blocks[i][0], row = blocks[i][1];
      if (col < 0 || col >= HEX_COLS) return false;
      if (row < 0 || row >= HEX_TOTAL_ROWS) return false;
      if (this.grid[row][col] !== 0) return false;
    }
    return true;
  }

  getStackHeight() {
    for (var row = 0; row < HEX_TOTAL_ROWS; row++) {
      for (var col = 0; col < HEX_COLS; col++) {
        if (this.grid[row][col] !== 0) return HEX_TOTAL_ROWS - row;
      }
    }
    return 0;
  }

  getGhostY() {
    if (!this.currentPiece) return 0;
    var ghost = this._ghostOf(this.currentPiece);
    return ghost.anchorRow;
  }

  getState() {
    var visibleGrid = this.grid.slice(HEX_BUFFER_ROWS);
    var ghost = this.currentPiece ? this._ghostOf(this.currentPiece) : null;

    return {
      grid: visibleGrid,
      currentPiece: this.currentPiece ? {
        type: this.currentPiece.type,
        typeId: this.currentPiece.typeId,
        anchorCol: this.currentPiece.anchorCol,
        anchorRow: this.currentPiece.anchorRow - HEX_BUFFER_ROWS,
        cells: this.currentPiece.cells,
        blocks: this.currentPiece.getAbsoluteBlocks().map(function(b) {
          return [b[0], b[1] - HEX_BUFFER_ROWS];
        })
      } : null,
      ghost: ghost ? {
        anchorCol: ghost.anchorCol,
        anchorRow: ghost.anchorRow - HEX_BUFFER_ROWS,
        blocks: ghost.getAbsoluteBlocks().map(function(b) {
          return [b[0], b[1] - HEX_BUFFER_ROWS];
        })
      } : null,
      holdPiece: this.holdPiece,
      nextPieces: this.nextPieces.slice(0, 3),
      level: this.getLevel(),
      lines: this.lines,
      alive: this.alive,
      pendingGarbage: this.pendingGarbage.reduce(function(sum, g) { return sum + g.lines; }, 0),
      clearingCells: this.clearingCells ? this.clearingCells.map(function(c) {
        return [c[0], c[1] - HEX_BUFFER_ROWS];
      }).filter(function(c) { return c[1] >= 0; }) : null
    };
  }
}

exports.HexPlayerBoard = HexPlayerBoard;

})(typeof module !== 'undefined' ? module.exports : (window.HexPlayerBoardModule = {}));
