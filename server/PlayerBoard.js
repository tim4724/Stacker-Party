'use strict';

// UMD: works in Node.js (require) and browser (window.PlayerBoardModule)
// Flat-top hex board — columns are vertically aligned, so left/right is col ± 1.
(function(exports) {

const constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
const GameRandomizer = (typeof require !== 'undefined') ? require('./Randomizer') : window.GameRandomizer;
const PieceModule = (typeof require !== 'undefined') ? require('./Piece') : window.PieceModule;

const LOCK_DELAY_MS = constants.LOCK_DELAY_MS;
const MAX_LOCK_RESETS = constants.MAX_LOCK_RESETS;
const LINE_CLEAR_DELAY_MS = constants.LINE_CLEAR_DELAY_MS;
const MAX_DROPS_PER_TICK = constants.MAX_DROPS_PER_TICK;
const MAX_SPEED_LEVEL = constants.MAX_SPEED_LEVEL;
const SOFT_DROP_MULTIPLIER = constants.SOFT_DROP_MULTIPLIER;

const findClearableZigzags = constants.findClearableZigzags;
const COLS = constants.COLS;
const TOTAL_ROWS = constants.TOTAL_ROWS;
const BUFFER_ROWS = constants.BUFFER_ROWS;
const GARBAGE_CELL = constants.GARBAGE_CELL;

const Randomizer = GameRandomizer.Randomizer;
const Piece = PieceModule.Piece;
const KICKS = PieceModule.KICKS;

const NEXT_QUEUE_SIZE = 4;

class PlayerBoard {
  constructor(playerId, seed, startLevel) {
    this.playerId = playerId;
    this.grid = Array.from({ length: TOTAL_ROWS }, () => new Array(COLS).fill(0));
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
    this.clearingCells = null;
    this.clearingTimer = null;
    this.gridVersion = 0;   // bumped on lock/clear/garbage for dirty tracking
    this._nextVersion = 0;  // bumped when nextPieces changes (hold, spawn)

    this._visibleClearingCellsCache = null;

    // Pre-allocated block arrays for getState() — avoids per-frame allocation.
    // Each board instance gets its own arrays so multi-player snapshots don't alias.
    // Pre-sized for 4 cells; auto-expands in getState() if needed.
    this._stateBlocksCurrent = [[0,0],[0,0],[0,0],[0,0]];
    this._stateBlocksGhost = [[0,0],[0,0],[0,0],[0,0]];

    // Ghost cache (invalidated when piece moves or grid changes)
    this._cachedGhost = null;
    this._ghostKeyCol = -1;
    this._ghostKeyRow = -1;
    this._ghostKeyRot = -1;
    this._ghostKeyGV = -1;

    // Visible grid cache (re-sliced only when gridVersion changes)
    this._visibleGrid = null;
    this._visibleGridVersion = -1;
    this._cachedNextPieces = null;
    this._cachedNextVersion = -1;

    this._fillNextQueue();
  }

  _fillNextQueue() {
    while (this.nextPieces.length < NEXT_QUEUE_SIZE + 1) {
      this.nextPieces.push(this.randomizer.next());
    }
  }

  isValidPosition(piece) {
    const blocks = piece._absoluteBlocksFast();
    for (let i = 0; i < blocks.length; i++) {
      const col = blocks[i][0], row = blocks[i][1];
      if (col < 0 || col >= COLS) return false;
      if (row < 0 || row >= TOTAL_ROWS) return false;
      if (this.grid[row][col] !== 0) return false;
    }
    return true;
  }

  lockPiece() {
    if (!this.currentPiece) return;
    const blocks = this.currentPiece._absoluteBlocksFast();
    for (let i = 0; i < blocks.length; i++) {
      const col = blocks[i][0], row = blocks[i][1];
      if (row >= 0 && row < TOTAL_ROWS && col >= 0 && col < COLS) {
        this.grid[row][col] = this.currentPiece.typeId;
      }
    }
    this.gridVersion++;
  }

  spawnPiece() {
    this._fillNextQueue();
    const type = this.nextPieces.shift();
    this._nextVersion++;
    this.currentPiece = new Piece(type);
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
      this.currentPiece = new Piece(this.holdPiece);
      this.holdPiece = currentType;
    } else {
      this.holdPiece = currentType;
      this._fillNextQueue();
      const nextType = this.nextPieces.shift();
      this._nextVersion++;
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

  _isOnSurface() {
    if (!this.currentPiece) return false;
    if (this.currentPiece.anchorRow + 1 >= TOTAL_ROWS) return true;
    this.currentPiece.anchorRow += 1;
    var blocked = !this.isValidPosition(this.currentPiece);
    this.currentPiece.anchorRow -= 1;
    return blocked;
  }

  _preDropToVisible() {
    if (!this.currentPiece) return;
    while (this.currentPiece.anchorRow < BUFFER_ROWS - 1) {
      if (!this._hexDrop(this.currentPiece)) break;
    }
    this.gravityCounter = 0;
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
    for (let row = 0; row < TOTAL_ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (this.grid[row][col] !== 0) return TOTAL_ROWS - row;
      }
    }
    return 0;
  }

  tick(deltaMs) {
    if (!this.alive) return null;

    // Handle line clear animation delay
    if (this.clearingCells !== null) {
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
      if (this._hexDrop(this.currentPiece)) {
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

  // ===================== HEX DROP / GHOST =====================

  // Simple drop: row + 1, same column. Mutates piece in place; restores on failure.
  // _anchorY tracks with gravity (+=2 per row drop) instead of resetting, so the
  // piece's up-displacement is preserved through gravity. Otherwise a player
  // could press UP, let gravity tick, press UP again and fully cancel the drop.
  _hexDrop(piece) {
    if (piece.anchorRow + 1 >= TOTAL_ROWS) return null;
    piece.anchorRow += 1;
    if (this.isValidPosition(piece)) {
      piece._anchorY += 2;
      return piece;
    }
    piece.anchorRow -= 1;
    return null;
  }

  _ghostOf(piece) {
    if (piece.anchorCol === this._ghostKeyCol && piece.anchorRow === this._ghostKeyRow &&
        piece._rotId === this._ghostKeyRot && this.gridVersion === this._ghostKeyGV) {
      return this._cachedGhost;
    }
    let g = piece.clone();
    for (let i = 0; i < TOTAL_ROWS; i++) {
      if (!this._hexDrop(g)) break;
    }
    this._cachedGhost = g;
    this._ghostKeyCol = piece.anchorCol; this._ghostKeyRow = piece.anchorRow;
    this._ghostKeyRot = piece._rotId; this._ghostKeyGV = this.gridVersion;
    return g;
  }

  // ===================== MOVEMENT =====================
  moveLeft() {
    if (!this.currentPiece || !this.alive) return false;
    return this._move(-1);
  }

  moveRight() {
    if (!this.currentPiece || !this.alive) return false;
    return this._move(1);
  }

  // Flat-top hex has no pure east/west neighbor — every lateral move is diagonal.
  // We bias up: from the anchor y, the first press goes up by one half-hex; the
  // next press returns down to the anchor. Measuring in half-hex units with
  //   currentY = 2 * anchorRow + (anchorCol & 1)
  // under normal movement currentY ∈ { _anchorY, _anchorY - 1 }. The fallback
  // (when the primary diagonal is blocked) can push currentY outside that
  // range, but subsequent presses naturally pull it back toward the invariant.
  _move(dir) {
    const piece = this.currentPiece;
    const newCol = piece.anchorCol + dir;
    if (newCol < 0 || newCol >= COLS) return false;

    const currentY = 2 * piece.anchorRow + (piece.anchorCol & 1);
    const anchorY = piece._anchorY;
    const aboveAnchor = currentY < anchorY;
    const newColParity = newCol & 1;

    // Primary: above-anchor bias. If at/below anchor, go up; if above, go down.
    const primaryY = aboveAnchor ? currentY + 1 : currentY - 1;
    const fallbackY = aboveAnchor ? currentY - 1 : currentY + 1;

    // y and col parity always match (2*row + parity has parity == col parity),
    // and primary/fallback shift y by ±1 so new y's parity matches newColParity.
    const primaryRow = (primaryY - newColParity) >> 1;
    const fallbackRow = (fallbackY - newColParity) >> 1;

    const test = piece.clone();
    test.anchorCol = newCol;
    test.anchorRow = primaryRow;
    if (!this.isValidPosition(test)) {
      test.anchorRow = fallbackRow;
      if (!this.isValidPosition(test)) return false;
    }
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
    const test = this.currentPiece.clone();
    if (dir === 'cw') test.rotateCW(); else test.rotateCCW();
    test._adjustAnchorRow();

    for (let i = 0; i < KICKS.length; i++) {
      const kicked = test.clone();
      kicked.anchorCol += KICKS[i][0];
      kicked.anchorRow += KICKS[i][1];
      if (!this.isValidPosition(kicked)) continue;
      // Rotation (and any kick displacement) re-baselines the lateral up-bias.
      kicked._resetAnchorY();
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

  // ===================== LOCK & LINE CLEAR =====================
  _lockAndProcess() {
    const lockedBlocks = [];
    let lockedTypeId = 0;
    if (this.currentPiece) {
      lockedTypeId = this.currentPiece.typeId;
      const abs = this.currentPiece.getAbsoluteBlocks();
      for (let i = 0; i < abs.length; i++) {
        const visibleRow = abs[i][1] - BUFFER_ROWS;
        if (visibleRow >= 0) lockedBlocks.push([abs[i][0], visibleRow]);
      }
    }

    this.lockPiece();

    const grid = this.grid;
    const result = findClearableZigzags(COLS, TOTAL_ROWS, function(col, row) {
      return grid[row][col] !== 0;
    }, null, BUFFER_ROWS);
    const linesCleared = result.linesCleared;
    const clearCells = result.clearCells;

    if (linesCleared > 0) {
      this.lines += linesCleared;
      this.clearingCells = clearCells;
      // Pre-compute visible-coordinate version once (stable during animation)
      this._visibleClearingCellsCache = this._computeVisibleClearingCells();
      this.clearingTimer = LINE_CLEAR_DELAY_MS;
      this.currentPiece = null;
    } else {
      this._applyPendingGarbage();
      this.spawnPiece();
    }

    return {
      linesCleared,
      clearCells: this._visibleClearingCellsCache || [],
      alive: this.alive,
      lockedBlocks,
      lockedTypeId
    };
  }

  _finishClearLines() {
    if (!this.clearingCells) return;
    this.gridVersion++;

    // Build set of cleared positions per column, sorted top-to-bottom
    const clearedByCol = {};
    for (let i = 0; i < this.clearingCells.length; i++) {
      const col = this.clearingCells[i][0], row = this.clearingCells[i][1];
      if (row >= 0 && row < TOTAL_ROWS && col >= 0 && col < COLS) {
        if (!clearedByCol[col]) clearedByCol[col] = [];
        clearedByCol[col].push(row);
      }
    }

    // For each column, remove only the cleared cells and shift above down.
    for (let c = 0; c < COLS; c++) {
      const cleared = clearedByCol[c];
      if (!cleared) continue;
      cleared.sort((a, b) => b - a); // bottom-first
      for (let ci = 0; ci < cleared.length; ci++) {
        const cr = cleared[ci];
        for (let sr = cr; sr > 0; sr--) {
          this.grid[sr][c] = this.grid[sr - 1][c];
        }
        this.grid[0][c] = 0;
        // Cells above cr shifted down by 1, so bump their tracked indices.
        // cleared is sorted descending, so all remaining entries are above cr.
        for (let cj = ci + 1; cj < cleared.length; cj++) {
          cleared[cj]++;
        }
      }
    }

    this.clearingCells = null;
    this._visibleClearingCellsCache = null;
    this.clearingTimer = null;
    this._applyPendingGarbage();
    this.spawnPiece();
  }

  // ===================== GARBAGE =====================
  applyGarbage(lines, gapColumn) {
    lines = Math.min(lines, TOTAL_ROWS);
    this.grid.splice(0, lines);
    for (let i = 0; i < lines; i++) {
      this.grid.push(new Array(COLS).fill(0));
    }

    // Baseline: clearable zigzags that already exist (empty bottom rows).
    const grid = this.grid;
    const isFilled = function(col, row) { return grid[row][col] !== 0; };
    const baseline = findClearableZigzags(COLS, TOTAL_ROWS, isFilled, null, BUFFER_ROWS);

    // Try gap columns until one doesn't add new clearable zigzags.
    // The original gapColumn is tried first; if it creates new clears, shift by 1.
    const firstGarbageRow = TOTAL_ROWS - lines;
    let gap;
    for (let attempt = 0; attempt < COLS; attempt++) {
      gap = (gapColumn + attempt) % COLS;
      for (let i = 0; i < lines; i++) {
        const row = grid[firstGarbageRow + i];
        for (let c = 0; c < COLS; c++) row[c] = GARBAGE_CELL;
        row[gap] = 0;
      }
      const result = findClearableZigzags(COLS, TOTAL_ROWS, isFilled, null, BUFFER_ROWS);
      if (result.linesCleared <= baseline.linesCleared) break;
    }

    this.gridVersion++;
  }

  // ===================== QUERIES =====================
  getGhostY() {
    if (!this.currentPiece) return 0;
    const ghost = this._ghostOf(this.currentPiece);
    return ghost.anchorRow;
  }

  _computeVisibleClearingCells() {
    var out = [];
    for (var i = 0; i < this.clearingCells.length; i++) {
      var vr = this.clearingCells[i][1] - BUFFER_ROWS;
      if (vr >= 0) out.push([this.clearingCells[i][0], vr]);
    }
    return out;
  }

  // Returns snapshot for rendering. grid, nextPieces, and blocks are live references —
  // callers must treat the returned object as read-only and consume before the next tick.
  getState() {
    if (this.gridVersion !== this._visibleGridVersion) {
      this._visibleGrid = this.grid.slice(BUFFER_ROWS);
      this._visibleGridVersion = this.gridVersion;
    }
    if (this._nextVersion !== this._cachedNextVersion) {
      this._cachedNextPieces = this.nextPieces.slice(0, 3);
      this._cachedNextVersion = this._nextVersion;
    }
    const visibleGrid = this._visibleGrid;
    const ghost = this.currentPiece ? this._ghostOf(this.currentPiece) : null;

    // Populate pre-allocated block arrays from scratch (no allocation).
    // _absoluteBlocksFast() returns a shared module-level scratch array.
    // Each block must be fully copied before the next _absoluteBlocksFast() call.
    var cpBlocks = null;
    if (this.currentPiece) {
      var abs = this.currentPiece._absoluteBlocksFast();
      var absLen = abs.length;
      cpBlocks = this._stateBlocksCurrent;
      while (cpBlocks.length < absLen) cpBlocks.push([0, 0]);
      cpBlocks.length = absLen;
      for (var bi = 0; bi < absLen; bi++) {
        cpBlocks[bi][0] = abs[bi][0];
        cpBlocks[bi][1] = abs[bi][1] - BUFFER_ROWS;
      }
    }
    var ghostBlocks = null;
    if (ghost) {
      var gAbs = ghost._absoluteBlocksFast();
      var gAbsLen = gAbs.length;
      ghostBlocks = this._stateBlocksGhost;
      while (ghostBlocks.length < gAbsLen) ghostBlocks.push([0, 0]);
      ghostBlocks.length = gAbsLen;
      for (var gi = 0; gi < gAbsLen; gi++) {
        ghostBlocks[gi][0] = gAbs[gi][0];
        ghostBlocks[gi][1] = gAbs[gi][1] - BUFFER_ROWS;
      }
    }

    return {
      grid: visibleGrid,
      currentPiece: this.currentPiece ? {
        type: this.currentPiece.type,
        typeId: this.currentPiece.typeId,
        anchorCol: this.currentPiece.anchorCol,
        anchorRow: this.currentPiece.anchorRow - BUFFER_ROWS,
        cells: this.currentPiece.cells,
        blocks: cpBlocks
      } : null,
      ghost: ghost ? {
        anchorCol: ghost.anchorCol,
        anchorRow: ghost.anchorRow - BUFFER_ROWS,
        blocks: ghostBlocks
      } : null,
      holdPiece: this.holdPiece,
      nextPieces: this._cachedNextPieces,
      level: this.getLevel(),
      lines: this.lines,
      alive: this.alive,
      pendingGarbage: this.pendingGarbage.reduce((sum, g) => sum + g.lines, 0),
      clearingCells: this._visibleClearingCellsCache,
      gridVersion: this.gridVersion
    };
  }
}

exports.PlayerBoard = PlayerBoard;

})(typeof module !== 'undefined' ? module.exports : (window.PlayerBoardModule = {}));
