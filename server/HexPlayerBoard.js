'use strict';

// UMD: works in Node.js (require) and browser (window.HexPlayerBoardModule)
// Flat-top hex board — columns are vertically aligned, so left/right is col ± 1.
(function(exports) {

const hexConst = (typeof require !== 'undefined') ? require('./HexConstants') : window.HexConstants;
const BaseBoardModule = (typeof require !== 'undefined') ? require('./BaseBoard') : window.BaseBoardModule;
const HexPieceModule = (typeof require !== 'undefined') ? require('./HexPiece') : window.HexPieceModule;

const findClearableZigzags = hexConst.findClearableZigzags;
const HEX_COLS = hexConst.HEX_COLS;
const HEX_TOTAL_ROWS = hexConst.HEX_TOTAL_ROWS;
const HEX_BUFFER_ROWS = hexConst.HEX_BUFFER_ROWS;
const HEX_PIECE_TYPES = hexConst.HEX_PIECE_TYPES;
const HEX_GARBAGE_CELL = hexConst.HEX_GARBAGE_CELL;

const BaseBoard = BaseBoardModule.BaseBoard;
const LINE_CLEAR_DELAY_MS = BaseBoardModule.LINE_CLEAR_DELAY_MS;

const HexPiece = HexPieceModule.HexPiece;
const KICKS = HexPieceModule.KICKS;

// ===================== HEX PLAYER BOARD =====================
class HexPlayerBoard extends BaseBoard {
  constructor(playerId, seed, startLevel) {
    super(playerId, seed, startLevel, {
      cols: HEX_COLS,
      totalRows: HEX_TOTAL_ROWS,
      bufferRows: HEX_BUFFER_ROWS,
      pieceTypes: HEX_PIECE_TYPES
    });

    this.clearingCells = null;
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

  // --- Abstract method implementations ---

  _createPiece(type) {
    return new HexPiece(type);
  }

  _isClearing() {
    return this.clearingCells !== null;
  }

  _drop(piece) {
    return this._hexDrop(piece);
  }

  _isOnSurface() {
    if (!this.currentPiece) return false;
    if (this.currentPiece.anchorRow + 1 >= HEX_TOTAL_ROWS) return true;
    this.currentPiece.anchorRow += 1;
    var blocked = !this.isValidPosition(this.currentPiece);
    this.currentPiece.anchorRow -= 1;
    return blocked;
  }

  _preDropToVisible() {
    if (!this.currentPiece) return;
    while (this.currentPiece.anchorRow < HEX_BUFFER_ROWS - 1) {
      if (!this._hexDrop(this.currentPiece)) break;
    }
    this.gravityCounter = 0;
  }

  // --- Hex-specific methods ---

  // Simple drop: row + 1, same column. Mutates piece in place; restores on failure.
  _hexDrop(piece) {
    if (piece.anchorRow + 1 >= HEX_TOTAL_ROWS) return null;
    piece.anchorRow += 1;
    if (this.isValidPosition(piece)) return piece;
    piece.anchorRow -= 1;
    return null;
  }

  _ghostOf(piece) {
    if (piece.anchorCol === this._ghostKeyCol && piece.anchorRow === this._ghostKeyRow &&
        piece._rotId === this._ghostKeyRot && this.gridVersion === this._ghostKeyGV) {
      return this._cachedGhost;
    }
    let g = piece.clone();
    for (let i = 0; i < HEX_TOTAL_ROWS; i++) {
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

  _move(dir) {
    const test = this.currentPiece.clone();
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
    const test = this.currentPiece.clone();
    if (dir === 'cw') test.rotateCW(); else test.rotateCCW();
    test._adjustAnchorRow();

    for (let i = 0; i < KICKS.length; i++) {
      const kicked = test.clone();
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

  // ===================== LOCK & LINE CLEAR =====================
  _lockAndProcess() {
    const lockedBlocks = [];
    let lockedTypeId = 0;
    if (this.currentPiece) {
      lockedTypeId = this.currentPiece.typeId;
      const abs = this.currentPiece.getAbsoluteBlocks();
      for (let i = 0; i < abs.length; i++) {
        const visibleRow = abs[i][1] - HEX_BUFFER_ROWS;
        if (visibleRow >= 0) lockedBlocks.push([abs[i][0], visibleRow]);
      }
    }

    this.lockPiece();

    const grid = this.grid;
    const result = findClearableZigzags(HEX_COLS, HEX_TOTAL_ROWS, function(col, row) {
      return grid[row][col] !== 0;
    }, null, HEX_BUFFER_ROWS);
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
      if (row >= 0 && row < HEX_TOTAL_ROWS && col >= 0 && col < HEX_COLS) {
        if (!clearedByCol[col]) clearedByCol[col] = [];
        clearedByCol[col].push(row);
      }
    }

    // For each column, remove only the cleared cells and shift above down.
    for (let c = 0; c < HEX_COLS; c++) {
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
    lines = Math.min(lines, HEX_TOTAL_ROWS);
    this.grid.splice(0, lines);
    for (let i = 0; i < lines; i++) {
      const row = new Array(HEX_COLS).fill(HEX_GARBAGE_CELL);
      row[gapColumn % HEX_COLS] = 0;
      this.grid.push(row);
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
      var vr = this.clearingCells[i][1] - HEX_BUFFER_ROWS;
      if (vr >= 0) out.push([this.clearingCells[i][0], vr]);
    }
    return out;
  }

  // Returns snapshot for rendering. grid, nextPieces, and blocks are live references —
  // callers must treat the returned object as read-only and consume before the next tick.
  getState() {
    if (this.gridVersion !== this._visibleGridVersion) {
      this._visibleGrid = this.grid.slice(HEX_BUFFER_ROWS);
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
        cpBlocks[bi][1] = abs[bi][1] - HEX_BUFFER_ROWS;
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
        ghostBlocks[gi][1] = gAbs[gi][1] - HEX_BUFFER_ROWS;
      }
    }

    return {
      grid: visibleGrid,
      currentPiece: this.currentPiece ? {
        type: this.currentPiece.type,
        typeId: this.currentPiece.typeId,
        anchorCol: this.currentPiece.anchorCol,
        anchorRow: this.currentPiece.anchorRow - HEX_BUFFER_ROWS,
        cells: this.currentPiece.cells,
        blocks: cpBlocks
      } : null,
      ghost: ghost ? {
        anchorCol: ghost.anchorCol,
        anchorRow: ghost.anchorRow - HEX_BUFFER_ROWS,
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

exports.HexPlayerBoard = HexPlayerBoard;

})(typeof module !== 'undefined' ? module.exports : (window.HexPlayerBoardModule = {}));
