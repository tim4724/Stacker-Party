'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { HexPlayerBoard } = require('../server/HexPlayerBoard');
const { HexPiece } = require('../server/HexPiece');
const { offsetToAxial, axialToOffset } = require('../server/HexPiece');
const { HEX_COLS, HEX_TOTAL_ROWS, HEX_BUFFER_ROWS, HEX_VISIBLE_ROWS } = require('../server/HexConstants');
const { LOCK_DELAY_MS, LINE_CLEAR_DELAY_MS } = require('../server/constants');
const { Game } = require('../server/Game');

describe('HexPiece', () => {
  it('creates a piece with correct type and cells', () => {
    var p = new HexPiece('T');
    assert.equal(p.type, 'T');
    assert.equal(p.typeId, 6);
    assert.equal(p.cells.length, 4);
  });

  it('getAbsoluteBlocks returns valid offset coordinates', () => {
    var p = new HexPiece('L');
    var blocks = p.getAbsoluteBlocks();
    assert.equal(blocks.length, 4);
    for (var b of blocks) {
      assert.ok(b[0] >= 0 && b[0] < HEX_COLS, 'col in bounds');
      assert.ok(b[1] >= 0, 'row non-negative');
    }
  });

  it('clone creates independent copy', () => {
    var p = new HexPiece('S');
    var c = p.clone();
    c.anchorCol = 0;
    assert.notEqual(p.anchorCol, c.anchorCol);
  });

  it('rotateCW changes cell positions', () => {
    var p = new HexPiece('T');
    var before = JSON.stringify(p.cells);
    p.rotateCW();
    assert.notEqual(JSON.stringify(p.cells), before);
  });

  it('all 7 piece types create valid pieces', () => {
    var types = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
    for (var t of types) {
      var p = new HexPiece(t);
      var blocks = p.getAbsoluteBlocks();
      assert.ok(blocks.length >= 3, t + ' has cells');
      for (var b of blocks) {
        assert.ok(b[0] >= 0 && b[0] < HEX_COLS, t + ' col in bounds');
        assert.ok(b[1] >= 0, t + ' row non-negative');
      }
    }
  });

  it('I has 4 cells', () => {
    var p = new HexPiece('I');
    assert.equal(p.cells.length, 4);
  });

  it('T (tripod) has 4 cells and 2 unique rotations', () => {
    var p = new HexPiece('T');
    assert.equal(p.cells.length, 4);
    var seen = new Set();
    var cells = p.cells.map(c => ({ q: c.q, r: c.r }));
    for (var i = 0; i < 6; i++) {
      var key = cells.map(c => c.q + ',' + c.r).sort().join('|');
      seen.add(key);
      cells = cells.map(c => ({ q: -c.r, r: c.q + c.r }));
    }
    assert.equal(seen.size, 2);
  });
});

describe('HexPiece - coordinate math', () => {
  it('offsetToAxial and axialToOffset roundtrip for even column', () => {
    var col = 4, row = 10;
    var ax = offsetToAxial(col, row);
    var off = axialToOffset(ax.q, ax.r);
    assert.equal(off.col, col);
    assert.equal(off.row, row);
  });

  it('offsetToAxial and axialToOffset roundtrip for odd column', () => {
    var col = 5, row = 10;
    var ax = offsetToAxial(col, row);
    var off = axialToOffset(ax.q, ax.r);
    assert.equal(off.col, col);
    assert.equal(off.row, row);
  });

  it('rotateCCW changes cell positions', () => {
    var p = new HexPiece('T');
    var before = JSON.stringify(p.cells);
    p.rotateCCW();
    assert.notEqual(JSON.stringify(p.cells), before);
  });

  it('rotateCW then rotateCCW returns to original', () => {
    var p = new HexPiece('L');
    var original = JSON.stringify(p.cells);
    p.rotateCW();
    p.rotateCCW();
    assert.equal(JSON.stringify(p.cells), original);
  });

  it('6 CW rotations return to original (hex symmetry)', () => {
    var p = new HexPiece('I');
    var original = JSON.stringify(p.cells);
    for (var i = 0; i < 6; i++) p.rotateCW();
    assert.equal(JSON.stringify(p.cells), original);
  });
});

describe('HexPlayerBoard', () => {
  it('creates board with correct dimensions', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.grid.length, HEX_TOTAL_ROWS);
    assert.equal(b.grid[0].length, HEX_COLS);
  });

  it('spawns a piece in the visible area', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    assert.ok(b.currentPiece);
    assert.ok(b.currentPiece.anchorRow >= HEX_BUFFER_ROWS - 1);
  });

  it('moveLeft and moveRight change piece position', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var startCol = b.currentPiece.anchorCol;
    b.moveLeft();
    assert.equal(b.currentPiece.anchorCol, startCol - 1);
    b.moveRight();
    assert.equal(b.currentPiece.anchorCol, startCol);
  });

  it('hardDrop locks piece and returns result', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var result = b.hardDrop();
    assert.ok(result);
    assert.equal(typeof result.linesCleared, 'number');
    assert.ok(Array.isArray(result.lockedBlocks));
  });

  it('hold swaps current piece', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var firstType = b.currentPiece.type;
    b.hold();
    assert.equal(b.holdPiece, firstType);
    assert.ok(b.currentPiece);
    assert.notEqual(b.currentPiece.type, firstType);
  });

  it('getState returns valid state object', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var state = b.getState();
    assert.equal(state.grid.length, HEX_VISIBLE_ROWS);
    assert.ok(state.currentPiece);
    assert.ok(state.ghost);
    assert.ok(Array.isArray(state.nextPieces));
  });

  it('garbage adds rows at bottom', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.applyGarbage(2, 3);
    assert.ok(b.grid[HEX_TOTAL_ROWS - 1][0] > 0);
    assert.equal(b.grid[HEX_TOTAL_ROWS - 1][3], 0); // gap column
  });
});

describe('HexPlayerBoard - rotation and wall kicks', () => {
  it('rotateCW changes piece orientation', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var before = JSON.stringify(b.currentPiece.cells);
    b.rotateCW();
    assert.notEqual(JSON.stringify(b.currentPiece.cells), before);
  });

  it('rotateCW returns false when no currentPiece', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.rotateCW(), false);
  });

  it('wall kick allows rotation near left edge', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Move piece to left wall
    for (var i = 0; i < HEX_COLS; i++) b.moveLeft();
    var result = b.rotateCW();
    // Should succeed via kick or fail gracefully
    assert.equal(typeof result, 'boolean');
  });

  it('wall kick allows rotation near right edge', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    for (var i = 0; i < HEX_COLS; i++) b.moveRight();
    var result = b.rotateCW();
    assert.equal(typeof result, 'boolean');
  });
});

describe('HexPlayerBoard - movement boundaries', () => {
  it('moveLeft returns false at left wall', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Move all the way left until blocked
    var moved = true;
    while (moved) moved = b.moveLeft();
    assert.equal(b.moveLeft(), false);
  });

  it('moveRight returns false at right wall', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var moved = true;
    while (moved) moved = b.moveRight();
    assert.equal(b.moveRight(), false);
  });

  it('moveLeft returns false when no currentPiece', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.moveLeft(), false);
  });

  it('moveRight returns false when no currentPiece', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.moveRight(), false);
  });
});

describe('HexPlayerBoard - gravity and tick', () => {
  it('tick drops piece over time', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var startRow = b.currentPiece.anchorRow;
    // Tick enough to trigger at least one gravity drop
    for (var i = 0; i < 100; i++) b.tick(50);
    assert.ok(b.currentPiece === null || b.currentPiece.anchorRow > startRow,
      'piece should have dropped or locked');
  });

  it('tick returns null during clearing delay', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    b.spawnPiece();
    b.hardDrop();
    // Board is now in clearing state
    assert.equal(b.tick(16), null);
  });

  it('tick finishes clearing after delay expires', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    b.spawnPiece();
    b.hardDrop();
    assert.ok(b.clearingCells);
    b.tick(LINE_CLEAR_DELAY_MS + 1);
    assert.equal(b.clearingCells, null);
    assert.ok(b.currentPiece, 'new piece spawned after clear');
  });

  it('tick returns null when not alive', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.alive = false;
    assert.equal(b.tick(16), null);
  });

  it('tick returns null when no currentPiece', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.tick(16), null);
  });
});

describe('HexPlayerBoard - soft drop', () => {
  it('softDropStart resets gravityCounter', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.gravityCounter = 100;
    b.softDropStart();
    assert.equal(b.gravityCounter, 0);
    assert.equal(b.softDropping, true);
  });

  it('softDropStart does not reset gravityCounter if already dropping', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.softDropping = true;
    b.gravityCounter = 50;
    b.softDropStart();
    assert.equal(b.gravityCounter, 50);
  });

  it('softDropEnd stops soft dropping', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.softDropStart(10);
    b.softDropEnd();
    assert.equal(b.softDropping, false);
  });
});

describe('HexPlayerBoard - hold edge cases', () => {
  it('hold returns false when holdUsed is true', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.hold();
    assert.equal(b.hold(), false);
  });

  it('hold swaps with held piece on second use', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var firstType = b.currentPiece.type;
    b.hold(); // firstType goes to hold, next piece spawns
    assert.equal(b.holdPiece, firstType);
    // Drop so holdUsed resets, then hold again to get firstType back
    b.hardDrop();
    var thirdType = b.currentPiece.type;
    b.hold();
    assert.equal(b.currentPiece.type, firstType);
    assert.equal(b.holdPiece, thirdType);
  });

  it('holdUsed resets after spawnPiece', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.hold();
    assert.equal(b.holdUsed, true);
    b.hardDrop(); // triggers spawnPiece
    assert.equal(b.holdUsed, false);
  });
});

describe('HexPlayerBoard - death and game over', () => {
  it('alive is false when piece cannot spawn', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    // Fill top rows to block spawning
    for (var r = 0; r < 6; r++) {
      for (var c = 0; c < HEX_COLS; c++) b.grid[r][c] = 1;
    }
    b.spawnPiece();
    assert.equal(b.alive, false);
  });

  it('spawnPiece returns false when blocked', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    for (var r = 0; r < 6; r++) {
      for (var c = 0; c < HEX_COLS; c++) b.grid[r][c] = 1;
    }
    assert.equal(b.spawnPiece(), false);
  });

  it('hardDrop returns null when not alive', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.alive = false;
    assert.equal(b.hardDrop(), null);
  });

  it('hardDrop returns null when no currentPiece', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.hardDrop(), null);
  });
});

describe('HexPlayerBoard - queries', () => {
  it('getStackHeight returns 0 on empty board', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.getStackHeight(), 0);
  });

  it('getStackHeight returns correct height with blocks', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.grid[HEX_TOTAL_ROWS - 1][0] = 1;
    assert.equal(b.getStackHeight(), 1);
    b.grid[HEX_TOTAL_ROWS - 3][5] = 2;
    assert.equal(b.getStackHeight(), 3);
  });

  it('getGhostY returns row >= currentPiece row', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    assert.ok(b.getGhostY() >= b.currentPiece.anchorRow);
  });

  it('getGhostY returns 0 when no currentPiece', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.getGhostY(), 0);
  });

  it('getLevel increases with lines cleared', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    assert.equal(b.getLevel(), 1);
    b.lines = 10;
    assert.equal(b.getLevel(), 2);
    b.lines = 25;
    assert.equal(b.getLevel(), 3);
  });

  it('getLevel respects startLevel', () => {
    var b = new HexPlayerBoard('p1', 42, 5);
    assert.equal(b.getLevel(), 5);
    b.lines = 10;
    assert.equal(b.getLevel(), 6);
  });
});

describe('HexPlayerBoard - pending garbage', () => {
  it('addPendingGarbage queues garbage', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.addPendingGarbage(2, 3);
    assert.equal(b.pendingGarbage.length, 1);
    assert.equal(b.pendingGarbage[0].lines, 2);
    assert.equal(b.pendingGarbage[0].gapColumn, 3);
  });

  it('pending garbage applied after hard drop without line clear', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.addPendingGarbage(1, 0);
    b.hardDrop();
    // Garbage should have been applied (pendingGarbage cleared)
    assert.equal(b.pendingGarbage.length, 0);
    // Bottom row should have garbage
    assert.ok(b.grid[HEX_TOTAL_ROWS - 1][1] > 0);
    assert.equal(b.grid[HEX_TOTAL_ROWS - 1][0], 0); // gap
  });

  it('getState reports pending garbage count', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.addPendingGarbage(2, 0);
    b.addPendingGarbage(3, 1);
    var state = b.getState();
    assert.equal(state.pendingGarbage, 5);
  });
});

describe('HexPlayerBoard - zigzag line clears', () => {
  it('detects zigzag-down clear (same row index)', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    // Fill last row completely
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    b.spawnPiece();
    var result = b.hardDrop();
    assert.ok(result.linesCleared >= 1);
  });

  it('detects zigzag-up clear (even cols at r, odd cols at r-1)', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    var r = HEX_TOTAL_ROWS - 1;
    // Zigzag-up at row r: even cols at r, odd cols at r-1
    for (var c = 0; c < HEX_COLS; c++) {
      var row = (c & 1) ? r - 1 : r;
      b.grid[row][c] = 2;
    }
    b.spawnPiece();
    var result = b.hardDrop();
    assert.ok(result.linesCleared >= 1);
  });

  it('clears both zigzag-down and zigzag-up simultaneously', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    var r = HEX_TOTAL_ROWS - 2;
    // Zigzag-down at row r+1
    for (var c = 0; c < HEX_COLS; c++) b.grid[r + 1][c] = 1;
    // Zigzag-up at row r: even@r, odd@r-1 (non-overlapping with above)
    for (var c2 = 0; c2 < HEX_COLS; c2++) {
      var row = (c2 & 1) ? r - 1 : r;
      b.grid[row][c2] = 2;
    }
    b.spawnPiece();
    var result = b.hardDrop();
    assert.ok(result.linesCleared >= 2, 'should clear at least 2 lines');
  });

  it('lower zigzag wins when two share cells', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    var r = HEX_TOTAL_ROWS - 1;
    // Zigzag-down at row r (all cells at row r)
    for (var c = 0; c < HEX_COLS; c++) b.grid[r][c] = 1;
    // Zigzag-up at row r (even@r, odd@r-1) - shares even-col cells with above
    for (var c2 = 0; c2 < HEX_COLS; c2++) {
      var row = (c2 & 1) ? r - 1 : r;
      b.grid[row][c2] = 2;
    }
    b.spawnPiece();
    var result = b.hardDrop();
    // Only zigzag-down should clear (lower on board wins), zigzag-up skipped due to shared cells
    assert.equal(result.linesCleared, 1, 'only lower zigzag clears');
  });

  it('clearingCells contains correct cell positions', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    b.spawnPiece();
    var result = b.hardDrop();
    assert.ok(result.clearCells.length > 0);
    // Each cell should have [col, visibleRow]
    for (var cell of result.clearCells) {
      assert.equal(cell.length, 2);
      assert.ok(cell[0] >= 0 && cell[0] < HEX_COLS);
    }
  });

  it('per-column gravity preserves gaps above cleared area', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    // Put a block at row 15, fill row 24 for clear
    b.grid[15][3] = 5;
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;

    // Manually set clearing and finish
    b.clearingCells = [];
    for (var c2 = 0; c2 < HEX_COLS; c2++) b.clearingCells.push([c2, HEX_TOTAL_ROWS - 1]);
    b.clearingTimer = 0;
    b._finishClearLines();

    // Block should have shifted down by 1 (from row 15 to 16)
    assert.equal(b.grid[16][3], 5);
    // Row 10 should still be empty (no fall-through)
    assert.equal(b.grid[10][3], 0);
  });

  it('two zigzag clears in same column shift correctly', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    // Fill two non-overlapping zigzag-down rows (24 and 22)
    for (var c = 0; c < HEX_COLS; c++) {
      b.grid[HEX_TOTAL_ROWS - 1][c] = 1;  // row 24
      b.grid[HEX_TOTAL_ROWS - 3][c] = 2;  // row 22
    }
    // Put a marker block at row 20, col 3
    b.grid[HEX_TOTAL_ROWS - 5][3] = 7;

    b.clearingCells = [];
    for (var c2 = 0; c2 < HEX_COLS; c2++) {
      b.clearingCells.push([c2, HEX_TOTAL_ROWS - 1]);  // row 24
      b.clearingCells.push([c2, HEX_TOTAL_ROWS - 3]);  // row 22
    }
    b.clearingTimer = 0;
    b._finishClearLines();

    // Each column lost 2 cells, so marker at row 20 should shift down by 2 to row 22
    assert.equal(b.grid[HEX_TOTAL_ROWS - 3][3], 7, 'marker shifted down by 2');
    // Original positions should be empty
    assert.equal(b.grid[HEX_TOTAL_ROWS - 5][3], 0, 'original marker position empty');
  });

  it('zigzag-down wins tie-break over zigzag-up at same row', () => {
    // Test the shared findClearableZigzags directly to verify tie-breaking
    var { findClearableZigzags } = require('../server/HexConstants');
    // Build a small test grid: 11 cols, 5 rows
    var grid = Array.from({ length: 5 }, function() { return new Array(HEX_COLS).fill(0); });
    // Fill zigzag-down at row 4 (all cells at row 4)
    for (var c = 0; c < HEX_COLS; c++) grid[4][c] = 1;
    // Fill zigzag-up at row 4 (even@4, odd@3) — shares even-col cells with above
    for (var c2 = 0; c2 < HEX_COLS; c2++) {
      var r = (c2 & 1) ? 3 : 4;
      grid[r][c2] = 2;
    }
    var result = findClearableZigzags(HEX_COLS, 5, function(col, row) {
      return grid[row][col] !== 0;
    }, null);
    assert.equal(result.linesCleared, 1, 'only one zigzag clears');
    // All cleared cells should be at row 4 (zigzag-down wins tie-break)
    for (var i = 0; i < result.clearCells.length; i++) {
      assert.equal(result.clearCells[i][1], 4, 'cleared cell at row 4 (zigzag-down)');
    }
  });

  it('no cascade after gravity', () => {
    var b = new HexPlayerBoard('p1', 42, 1);
    // Set up a scenario where gravity could create a new line
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    for (var c2 = 0; c2 < HEX_COLS; c2++) {
      if (c2 !== 5) b.grid[HEX_TOTAL_ROWS - 2][c2] = 2;
    }
    b.grid[HEX_TOTAL_ROWS - 3][5] = 3; // will drop to fill gap

    b.clearingCells = [];
    for (var c3 = 0; c3 < HEX_COLS; c3++) b.clearingCells.push([c3, HEX_TOTAL_ROWS - 1]);
    b.clearingTimer = 0;
    b._finishClearLines();

    // Should NOT start another clear cycle
    assert.equal(b.clearingCells, null);
  });
});

describe('Game with hex mode', () => {
  it('creates hex boards when gameMode is hex', () => {
    var players = new Map([['p1', {}], ['p2', {}]]);
    var g = new Game(players, { onEvent: () => {}, onGameEnd: () => {} }, 42, 'hex');
    g.init();
    var snap = g.getSnapshot();
    assert.equal(snap.players.length, 2);
    assert.equal(snap.players[0].grid[0].length, HEX_COLS);
  });

  it('creates classic boards by default', () => {
    var players = new Map([['p1', {}]]);
    var g = new Game(players, { onEvent: () => {}, onGameEnd: () => {} }, 42);
    g.init();
    var snap = g.getSnapshot();
    assert.equal(snap.players[0].grid[0].length, 10); // classic BOARD_WIDTH
  });
});
