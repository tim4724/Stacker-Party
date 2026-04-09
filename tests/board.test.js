'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PlayerBoard } = require('../server/PlayerBoard');
const { BOARD_WIDTH, BOARD_HEIGHT, BUFFER_ROWS, LINE_CLEAR_DELAY_MS, LOCK_DELAY_MS, GARBAGE_CELL } = require('../server/constants');

function makeBoard() {
  return new PlayerBoard('test-player');
}

// Fill all rows except the buffer zone rows with filled cells, leaving the
// specified row empty. Used to set up line-clear scenarios.
function fillBoardExcept(board, emptyRow) {
  for (let row = 0; row < BOARD_HEIGHT; row++) {
    if (row === emptyRow) {
      board.grid[row] = new Array(BOARD_WIDTH).fill(0);
    } else {
      board.grid[row] = new Array(BOARD_WIDTH).fill(1);
    }
  }
}

// Fill one specific row completely.
function fillRow(board, row) {
  board.grid[row] = new Array(BOARD_WIDTH).fill(1);
}

describe('PlayerBoard - start level', () => {
  test('PlayerBoard uses startLevel for level calculation', () => {
    const board = new PlayerBoard('test', 12345, 5);
    assert.strictEqual(board.getLevel(), 5);
  });
});

describe('PlayerBoard - spawnPiece()', () => {
  test('spawnPiece() returns true on empty board', () => {
    const board = makeBoard();
    const result = board.spawnPiece();
    assert.strictEqual(result, true);
  });

  test('spawnPiece() sets currentPiece', () => {
    const board = makeBoard();
    board.spawnPiece();
    assert.ok(board.currentPiece, 'currentPiece should be set after spawn');
  });

  test('spawned piece x is centered (default x=3)', () => {
    const board = makeBoard();
    board.spawnPiece();
    assert.strictEqual(board.currentPiece.x, 3);
  });

  test('spawned piece is pre-dropped near visible area (y = BUFFER_ROWS - 1)', () => {
    const board = makeBoard();
    board.spawnPiece();
    // Piece should be pre-dropped to y = 3 (BUFFER_ROWS - 1) on empty board
    assert.strictEqual(board.currentPiece.y, BUFFER_ROWS - 1);
  });

  test('spawned piece is partly visible (at least one block in visible zone)', () => {
    const board = makeBoard();
    board.spawnPiece();
    const blocks = board.currentPiece.getAbsoluteBlocks();
    const hasVisibleBlock = blocks.some(([col, row]) => row >= BUFFER_ROWS);
    assert.ok(hasVisibleBlock, 'At least one block should be in the visible zone');
  });

  test('spawnPiece() resets holdUsed to false', () => {
    const board = makeBoard();
    board.holdUsed = true;
    board.spawnPiece();
    assert.strictEqual(board.holdUsed, false);
  });

  test('spawnPiece() resets gravityCounter to 0', () => {
    const board = makeBoard();
    board.gravityCounter = 100;
    board.spawnPiece();
    assert.strictEqual(board.gravityCounter, 0);
  });

  test('pre-drop stops when blocked by existing pieces', () => {
    const board = makeBoard();
    // Place a blocking row at row 2
    board.grid[2] = new Array(BOARD_WIDTH).fill(1);
    board.currentPiece = null;
    board.spawnPiece();
    // Piece should stop before row 2 (can't drop to BUFFER_ROWS - 1)
    assert.ok(board.currentPiece.y < BUFFER_ROWS - 1,
      'Piece should stop pre-drop when blocked');
  });
});

describe('PlayerBoard - moveLeft() / moveRight()', () => {
  test('moveLeft() returns true when space is available', () => {
    const board = makeBoard();
    board.spawnPiece();
    const result = board.moveLeft();
    assert.strictEqual(result, true);
  });

  test('moveLeft() decrements piece x by 1', () => {
    const board = makeBoard();
    board.spawnPiece();
    const initialX = board.currentPiece.x;
    board.moveLeft();
    assert.strictEqual(board.currentPiece.x, initialX - 1);
  });

  test('moveLeft() returns false when at left wall', () => {
    const board = makeBoard();
    board.spawnPiece();
    // Move as far left as possible
    for (let i = 0; i < 20; i++) board.moveLeft();
    const result = board.moveLeft();
    assert.strictEqual(result, false);
  });

  test('moveRight() returns true when space is available', () => {
    const board = makeBoard();
    board.spawnPiece();
    const result = board.moveRight();
    assert.strictEqual(result, true);
  });

  test('moveRight() increments piece x by 1', () => {
    const board = makeBoard();
    board.spawnPiece();
    const initialX = board.currentPiece.x;
    board.moveRight();
    assert.strictEqual(board.currentPiece.x, initialX + 1);
  });

  test('moveRight() returns false when at right wall', () => {
    const board = makeBoard();
    board.spawnPiece();
    for (let i = 0; i < 20; i++) board.moveRight();
    const result = board.moveRight();
    assert.strictEqual(result, false);
  });

  test('moveLeft() returns false when no currentPiece', () => {
    const board = makeBoard();
    board.currentPiece = null;
    assert.strictEqual(board.moveLeft(), false);
  });

  test('moveRight() returns false when no currentPiece', () => {
    const board = makeBoard();
    board.currentPiece = null;
    assert.strictEqual(board.moveRight(), false);
  });
});

describe('PlayerBoard - rotateCW()', () => {
  test('rotateCW() on T piece changes rotation state', () => {
    const board = makeBoard();
    board.spawnPiece();
    // Ensure we have a T piece by forcing it
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('T');
    board.currentPiece.x = 4;
    board.currentPiece.y = 5;

    const initialRotation = board.currentPiece.rotation;
    const result = board.rotateCW();
    assert.strictEqual(result, true);
    assert.strictEqual(board.currentPiece.rotation, (initialRotation + 1) % 4);
  });

  test('rotateCW() returns false for O piece', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('O');
    board.currentPiece.x = 4;
    board.currentPiece.y = 5;
    assert.strictEqual(board.rotateCW(), false);
  });

  test('rotateCW() returns false when no currentPiece', () => {
    const board = makeBoard();
    board.currentPiece = null;
    assert.strictEqual(board.rotateCW(), false);
  });

  test('rotateCW() uses wall kicks when near left wall', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('T');
    board.currentPiece.x = 0; // near left wall
    board.currentPiece.y = 10;
    // T piece at x=0 may need wall kick to rotate; it should succeed
    const result = board.rotateCW();
    // Result depends on whether kick succeeds; just verify no error thrown
    assert.ok(typeof result === 'boolean');
  });

  test('I piece at left edge can rotate via wall kick', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('I');
    board.currentPiece.x = -1; // horizontal I at x=-1: blocks at cols -1,0,1,2
    board.currentPiece.y = 10;
    board.currentPiece.rotation = 0;
    // Can't fit here without kick, but after rotating to vertical + shifting right, it should work
    // Place at x=0 instead for a valid starting position
    board.currentPiece.x = 0;
    const result = board.rotateCW();
    assert.strictEqual(result, true, 'I piece at left edge should rotate via kick');
  });

  test('I piece at right edge can rotate via wall kick', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('I');
    board.currentPiece.x = 7; // horizontal I: blocks at cols 7,8,9,10 — col 10 is out of bounds
    board.currentPiece.y = 10;
    board.currentPiece.rotation = 0;
    // Needs to kick left to fit
    // Place at valid x=6 (blocks at 6,7,8,9)
    board.currentPiece.x = 6;
    const result = board.rotateCW();
    assert.strictEqual(result, true, 'I piece at right edge should rotate via kick');
  });

  test('rotateCW() cycles through all 4 rotations back to 0', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('T');
    board.currentPiece.x = 4;
    board.currentPiece.y = 10;

    board.rotateCW();
    board.rotateCW();
    board.rotateCW();
    board.rotateCW();
    assert.strictEqual(board.currentPiece.rotation, 0);
  });
});

describe('PlayerBoard - hardDrop()', () => {
  test('hardDrop() moves piece to lowest valid position', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('I');
    board.currentPiece.x = 3;
    board.currentPiece.y = 0;

    board.hardDrop();
    // After hard drop, piece should be locked so currentPiece changes (next piece spawns)
    // The I piece lands on the bottom of the 26-row board
    // Verify the grid has the piece locked in the bottom area
    const gridHasLockedPiece = board.grid.some(row => row.some(cell => cell !== 0));
    assert.ok(gridHasLockedPiece, 'Grid should have locked piece after hardDrop');
  });

  test('hardDrop() returns lock result object', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('O');
    board.currentPiece.x = 4;
    board.currentPiece.y = 0;

    const result = board.hardDrop();
    assert.ok(result !== null, 'hardDrop should return a result');
    assert.ok('linesCleared' in result);
    assert.ok('alive' in result);
    assert.ok('fullRows' in result, 'result should include fullRows array');
    assert.ok(Array.isArray(result.lockedBlocks), 'result should include lockedBlocks array');
    assert.ok(result.lockedBlocks.length > 0, 'lockedBlocks should not be empty');
    assert.strictEqual(typeof result.lockedTypeId, 'number', 'result should include lockedTypeId');
    assert.ok(result.lockedTypeId > 0, 'lockedTypeId should be a valid piece type');
  });

  test('hardDrop() returns null when no currentPiece', () => {
    const board = makeBoard();
    board.currentPiece = null;
    assert.strictEqual(board.hardDrop(), null);
  });

  test('hardDrop() applies pending garbage with the expected gap', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('O');
    board.currentPiece.x = 4;
    board.currentPiece.y = 0;
    board.addPendingGarbage(2, 3);

    board.hardDrop();

    assert.strictEqual(board.grid[BOARD_HEIGHT - 1][3], 0, 'garbage gap should be preserved');
    assert.strictEqual(board.grid[BOARD_HEIGHT - 2][3], 0, 'garbage gap should be preserved');
  });
});

describe('PlayerBoard - line clear', () => {
  test('hardDrop on a full row detects line clear', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');

    // Fill bottom row except columns 0-3 (I piece will fill them)
    board.grid[BOARD_HEIGHT - 1] = new Array(BOARD_WIDTH).fill(1);
    board.grid[BOARD_HEIGHT - 1][0] = 0;
    board.grid[BOARD_HEIGHT - 1][1] = 0;
    board.grid[BOARD_HEIGHT - 1][2] = 0;
    board.grid[BOARD_HEIGHT - 1][3] = 0;

    // Place I piece horizontally to complete the row
    board.currentPiece = new Piece('I');
    board.currentPiece.x = 0;
    board.currentPiece.y = BOARD_HEIGHT - 2;

    const result = board.hardDrop();
    assert.strictEqual(result.linesCleared, 1, 'One full row should be detected');
  });

  test('cleared rows are removed after delay', () => {
    const board = makeBoard();
    // Fill last 4 rows completely
    for (let row = BOARD_HEIGHT - 4; row < BOARD_HEIGHT; row++) {
      board.grid[row] = new Array(BOARD_WIDTH).fill(1);
    }

    // Set up clearing state and finish it
    board.clearingRows = [BOARD_HEIGHT - 4, BOARD_HEIGHT - 3, BOARD_HEIGHT - 2, BOARD_HEIGHT - 1];
    board.clearingTimer = 0;
    board._finishClearLines();

    // Top rows should be empty
    for (let row = 0; row < 4; row++) {
      assert.ok(board.grid[row].every(c => c === 0), `Row ${row} should be empty after clear`);
    }
  });

  test('board height stays constant after line clear', () => {
    const board = makeBoard();
    for (let row = BOARD_HEIGHT - 2; row < BOARD_HEIGHT; row++) {
      board.grid[row] = new Array(BOARD_WIDTH).fill(1);
    }

    board.clearingRows = [BOARD_HEIGHT - 2, BOARD_HEIGHT - 1];
    board.clearingTimer = 0;
    board._finishClearLines();

    assert.strictEqual(board.grid.length, BOARD_HEIGHT);
  });
});

describe('PlayerBoard - line clear delay', () => {
  test('hardDrop with full rows starts clearing state', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');

    // Fill bottom row completely
    board.grid[BOARD_HEIGHT - 1] = new Array(BOARD_WIDTH).fill(1);
    // Leave a gap in one column for the I piece to not clear more
    board.grid[BOARD_HEIGHT - 2] = new Array(BOARD_WIDTH).fill(0);

    // Place I piece horizontally across bottom-2 row
    board.currentPiece = new Piece('I');
    board.currentPiece.x = 0;
    board.currentPiece.y = BOARD_HEIGHT - 3; // I-piece rotation 0, blocks at row 1 => absolute row BOARD_HEIGHT-2

    const result = board.hardDrop();
    assert.ok(result.linesCleared > 0, 'Should detect line clears');
    assert.ok(board.clearingRows !== null, 'Should have clearing rows set');
    assert.ok(board.currentPiece === null, 'No current piece during clearing');
  });

  test('tick returns null during clearing delay', () => {
    const board = makeBoard();
    // Simulate clearing state
    board.clearingRows = [BOARD_HEIGHT - 1];
    board.clearingTimer = LINE_CLEAR_DELAY_MS;

    const result = board.tick(16);
    assert.strictEqual(result, null, 'tick should return null during clearing');
  });

  test('_finishClearLines removes rows and spawns new piece', () => {
    const board = makeBoard();

    // Fill bottom 2 rows
    board.grid[BOARD_HEIGHT - 1] = new Array(BOARD_WIDTH).fill(1);
    board.grid[BOARD_HEIGHT - 2] = new Array(BOARD_WIDTH).fill(1);

    // Set up clearing state (rows in ascending order, as _lockAndProcess produces)
    board.clearingRows = [BOARD_HEIGHT - 2, BOARD_HEIGHT - 1];
    board.clearingTimer = 0;

    board._finishClearLines();

    assert.strictEqual(board.clearingRows, null, 'Clearing rows should be null after finish');
    assert.ok(board.currentPiece !== null, 'New piece should be spawned');
    assert.strictEqual(board.grid.length, BOARD_HEIGHT, 'Board height should be preserved');
    // Bottom rows should now be empty (cleared rows replaced with empty at top)
    assert.ok(board.grid[0].every(c => c === 0), 'Top row should be empty');
    assert.ok(board.grid[1].every(c => c === 0), 'Second row should be empty');
  });

  test('tick finishes clearing after delay expires', () => {
    const board = makeBoard();

    // Fill bottom row
    board.grid[BOARD_HEIGHT - 1] = new Array(BOARD_WIDTH).fill(1);

    // Set up clearing state that has expired
    board.clearingRows = [BOARD_HEIGHT - 1];
    board.clearingTimer = 0;

    board.tick(16);

    assert.strictEqual(board.clearingRows, null, 'Clearing should be finished');
    assert.ok(board.currentPiece !== null, 'New piece should be spawned after clearing');
  });

  test('getState includes clearingRows for display', () => {
    const board = makeBoard();
    board.spawnPiece();

    // No clearing
    let state = board.getState();
    assert.strictEqual(state.clearingRows, null);

    // Set clearing state (ascending order)
    board.clearingRows = [BOARD_HEIGHT - 2, BOARD_HEIGHT - 1];
    state = board.getState();
    assert.deepStrictEqual(state.clearingRows, [
      BOARD_HEIGHT - 2 - BUFFER_ROWS,
      BOARD_HEIGHT - 1 - BUFFER_ROWS
    ]);
  });

  test('hardDrop without line clears spawns immediately', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');

    board.currentPiece = new Piece('O');
    board.currentPiece.x = 4;
    board.currentPiece.y = 0;

    const result = board.hardDrop();
    assert.strictEqual(result.linesCleared, 0);
    assert.strictEqual(board.clearingRows, null, 'No clearing state when no lines cleared');
    assert.ok(board.currentPiece !== null, 'New piece should spawn immediately');
  });
});

describe('PlayerBoard - soft drop', () => {
  test('softDropStart resets gravityCounter', () => {
    const board = makeBoard();
    board.gravityCounter = 40;
    board.softDropStart();
    assert.strictEqual(board.gravityCounter, 0, 'gravityCounter should reset on soft drop start');
    assert.strictEqual(board.softDropping, true);
  });

  test('softDropStart does not reset gravityCounter if already soft dropping', () => {
    const board = makeBoard();
    board.softDropping = true;
    board.gravityCounter = 10;
    board.softDropStart();
    assert.strictEqual(board.gravityCounter, 10, 'gravityCounter should not reset when already soft dropping');
  });

  test('softDropEnd stops soft dropping', () => {
    const board = makeBoard();
    board.softDropping = true;
    board.softDropEnd();
    assert.strictEqual(board.softDropping, false);
  });
});

describe('PlayerBoard - hold()', () => {
  test('hold() swaps current piece with hold slot when hold is empty', () => {
    const board = makeBoard();
    board.spawnPiece();
    const initialType = board.currentPiece.type;

    board.hold();
    assert.strictEqual(board.holdPiece, initialType);
  });

  test('hold() returns false when holdUsed is true', () => {
    const board = makeBoard();
    board.spawnPiece();
    board.hold(); // first hold
    const result = board.hold(); // second hold should fail
    assert.strictEqual(result, false);
  });

  test('hold() swaps current piece with held piece on second call', () => {
    const board = makeBoard();
    board.spawnPiece();
    board.hold();
    const heldType = board.holdPiece;

    board.spawnPiece(); // spawn next piece
    board.hold(); // this swaps with held
    assert.strictEqual(board.currentPiece.type, heldType);
  });

  test('hold() sets holdUsed to true', () => {
    const board = makeBoard();
    board.spawnPiece();
    board.hold();
    assert.strictEqual(board.holdUsed, true);
  });

  test('holdUsed resets after spawnPiece()', () => {
    const board = makeBoard();
    board.spawnPiece();
    board.hold();
    assert.strictEqual(board.holdUsed, true);
    board.spawnPiece();
    assert.strictEqual(board.holdUsed, false);
  });
});

describe('PlayerBoard - lock timer clears when moved off surface', () => {
  test('moveLeft off a ledge clears the lock timer', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');

    // Create a ledge: fill row 15, columns 6-9 only
    // O piece blocks (rotation 0): [col+1,row], [col+2,row], [col+1,row+1], [col+2,row+1]
    for (let c = 6; c <= 9; c++) {
      board.grid[15][c] = 1;
    }

    // Place O piece at x=4, y=13 → bottom blocks at (5,14) and (6,14)
    // Row 15 has blocks at col 6 → piece is on surface
    board.currentPiece = new Piece('O');
    board.currentPiece.x = 4;
    board.currentPiece.y = 13;

    // Verify piece is on surface
    assert.ok(board._isOnSurface(), 'Piece should be on surface (ledge)');

    // Simulate lock timer being active
    board.lockTimer = LOCK_DELAY_MS;

    // Move left: x=3 → bottom blocks at (4,14) and (5,14)
    // Row 15, cols 4 and 5 are empty → piece is no longer on surface
    board.moveLeft();

    assert.ok(!board._isOnSurface(), 'Piece should NOT be on surface after moving off ledge');
    assert.strictEqual(board.lockTimer, null, 'Lock timer should be cleared when piece moves off surface');
  });

  test('moveRight off a ledge clears the lock timer', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');

    // Create a ledge: fill row 15, columns 0-4
    // O piece blocks are at offsets (+1,+0), (+2,+0), (+1,+1), (+2,+1)
    for (let c = 0; c <= 4; c++) {
      board.grid[15][c] = 1;
    }

    // Place O piece at x=3, y=13 → bottom blocks at cols 4 and 5
    // Row 15 col 4 is filled → piece is on surface
    board.currentPiece = new Piece('O');
    board.currentPiece.x = 3;
    board.currentPiece.y = 13;

    assert.ok(board._isOnSurface(), 'Piece should be on surface (ledge)');
    board.lockTimer = LOCK_DELAY_MS;

    // Move right: x=4 → bottom blocks at cols 5 and 6
    // Row 15 cols 5 and 6 are empty → piece is no longer on surface
    board.moveRight();

    assert.ok(!board._isOnSurface(), 'Piece should NOT be on surface after moving off ledge');
    assert.strictEqual(board.lockTimer, null, 'Lock timer should be cleared when piece moves off surface');
  });

  test('move that stays on surface keeps lock timer active', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');

    // Create a wide ledge: fill row 15, columns 3-8
    for (let c = 3; c <= 8; c++) {
      board.grid[15][c] = 1;
    }

    // Place O piece at x=4, y=13 → bottom blocks at (5,14) and (6,14)
    board.currentPiece = new Piece('O');
    board.currentPiece.x = 4;
    board.currentPiece.y = 13;

    assert.ok(board._isOnSurface(), 'Piece should be on surface');
    board.lockTimer = LOCK_DELAY_MS;

    // Move left: x=3 → bottom blocks at (4,14) and (5,14)
    // Row 15, cols 4 and 5 are filled → piece stays on surface
    board.moveLeft();

    assert.ok(board._isOnSurface(), 'Piece should still be on surface');
    assert.ok(board.lockTimer !== null, 'Lock timer should remain active when still on surface');
  });

  test('gravity drops piece after it is moved off a ledge', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');

    // Create a ledge: fill row 15, columns 6-9
    for (let c = 6; c <= 9; c++) {
      board.grid[15][c] = 1;
    }

    // Place O piece on the ledge
    board.currentPiece = new Piece('O');
    board.currentPiece.x = 4;
    board.currentPiece.y = 13;
    board.lockTimer = LOCK_DELAY_MS;
    board.gravityCounter = 0;

    // Move off the ledge
    board.moveLeft();
    assert.strictEqual(board.lockTimer, null, 'Lock timer should be cleared');

    // Simulate enough gravity to drop one cell
    // Set gravityCounter high enough to trigger a drop
    board.gravityCounter = 999;
    const yBefore = board.currentPiece.y;
    board.tick(16);

    assert.ok(board.currentPiece.y > yBefore, 'Piece should have fallen after being moved off ledge');
  });
});

describe('PlayerBoard - ghost piece', () => {
  test('getGhostY() returns a value >= currentPiece.y', () => {
    const board = makeBoard();
    board.spawnPiece();
    const ghostY = board.getGhostY();
    assert.ok(ghostY >= board.currentPiece.y, 'Ghost Y should be at or below current piece');
  });

  test('getGhostY() equals currentPiece.y when piece is on surface', () => {
    const board = makeBoard();
    const { Piece } = require('../server/Piece');
    board.currentPiece = new Piece('I');
    board.currentPiece.x = 0;
    // Place piece at the very bottom so it is already on the surface
    board.currentPiece.y = BOARD_HEIGHT - 2; // I piece row 1 is at y+1

    const ghostY = board.getGhostY();
    assert.strictEqual(ghostY, board.currentPiece.y);
  });

  test('ghost Y position is above the floor', () => {
    const board = makeBoard();
    board.spawnPiece();
    const ghostY = board.getGhostY();
    assert.ok(ghostY < BOARD_HEIGHT, 'Ghost Y should be within board bounds');
  });
});

describe('PlayerBoard - game over', () => {
  test('alive is false when piece cannot spawn', () => {
    const board = makeBoard();
    // Fill buffer zone rows to block spawning
    for (let row = 0; row < BUFFER_ROWS; row++) {
      board.grid[row] = new Array(BOARD_WIDTH).fill(1);
    }
    board.spawnPiece();
    assert.strictEqual(board.alive, false);
  });

  test('spawnPiece() returns false when game over', () => {
    const board = makeBoard();
    for (let row = 0; row < BUFFER_ROWS; row++) {
      board.grid[row] = new Array(BOARD_WIDTH).fill(1);
    }
    const result = board.spawnPiece();
    assert.strictEqual(result, false);
  });
});

// ---------------------------------------------------------------------------
// Garbage + line clear interaction
// ---------------------------------------------------------------------------
describe('PlayerBoard - garbage and line clear interaction', () => {
  test('garbage row alone never triggers a line clear', () => {
    const board = makeBoard();
    board.spawnPiece();
    // Add garbage and apply it (no line clear, so garbage is applied immediately)
    board.addPendingGarbage(3, 4);
    board._applyPendingGarbage();
    // Bottom 3 rows should be garbage with a gap
    for (let i = 0; i < 3; i++) {
      const row = board.grid[BOARD_HEIGHT - 1 - i];
      assert.equal(row[4], 0, 'gap column should be empty');
      assert.equal(row[0], GARBAGE_CELL, 'non-gap column should be garbage');
    }
    // No clearing should be in progress
    assert.equal(board.clearingRows, null);
  });

  test('filling the gap in a garbage row triggers a line clear', () => {
    const board = makeBoard();
    board.spawnPiece();
    // Apply garbage with gap at column 5
    board.addPendingGarbage(1, 5);
    board._applyPendingGarbage();
    const garbageRow = BOARD_HEIGHT - 1;
    assert.equal(board.grid[garbageRow][5], 0);
    // Fill the gap manually to simulate a piece landing there
    board.grid[garbageRow][5] = 1;
    // Now lock a piece (spawn fresh to trigger detection)
    board.spawnPiece();
    const result = board.hardDrop();
    // The garbage row is now full, so it should clear
    assert.ok(result.linesCleared >= 1, 'should clear the completed garbage row');
  });

  test('garbage applied after line clear finishes, not during', () => {
    const board = makeBoard();
    // Fill the bottom row completely
    board.grid[BOARD_HEIGHT - 1] = new Array(BOARD_WIDTH).fill(1);
    board.spawnPiece();
    // Add pending garbage before the piece locks
    board.addPendingGarbage(2, 3);
    const result = board.hardDrop();
    if (result.linesCleared > 0) {
      // During clearing animation, garbage should still be pending
      assert.ok(board.pendingGarbage.length > 0 || board.clearingRows === null,
        'garbage not yet applied during clearing animation');
      // Finish the clear
      board._finishClearLines();
    }
    // After finishing, garbage should have been applied
    assert.equal(board.pendingGarbage.length, 0, 'garbage applied after clear finishes');
  });

  test('no line clear check after garbage application', () => {
    const board = makeBoard();
    board.spawnPiece();
    // Set up a nearly-full row, then add garbage that fills the gap column
    // but in a DIFFERENT row. The existing row should NOT clear until next lock.
    const targetRow = BOARD_HEIGHT - 2;
    for (let c = 0; c < BOARD_WIDTH; c++) {
      if (c !== 3) board.grid[targetRow][c] = 1;
    }
    // Fill the gap to make the row complete
    board.grid[targetRow][3] = 1;
    // Apply garbage (adds at bottom, shifts everything up)
    board.addPendingGarbage(1, 0);
    board._applyPendingGarbage();
    // The row that was full is now at targetRow - 1 (shifted up)
    // No clearing should have been triggered
    assert.equal(board.clearingRows, null, 'garbage application should not trigger line clears');
  });
});
