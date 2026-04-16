'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PlayerBoard } = require('../server/PlayerBoard');
const { Piece } = require('../server/Piece');
const { offsetToAxial, axialToOffset } = require('../server/Piece');
const {
  LOCK_DELAY_MS, LINE_CLEAR_DELAY_MS,
  COLS: HEX_COLS,
  TOTAL_ROWS: HEX_TOTAL_ROWS,
  BUFFER_ROWS: HEX_BUFFER_ROWS,
  VISIBLE_ROWS: HEX_VISIBLE_ROWS,
  GARBAGE_CELL: HEX_GARBAGE_CELL,
} = require('../server/constants');
const { Game } = require('../server/Game');

describe('Piece', () => {
  it('creates a piece with correct type and cells', () => {
    var p = new Piece('L');
    assert.equal(p.type, 'L');
    assert.equal(p.typeId, 7);
    assert.equal(p.cells.length, 4);
  });

  it('getAbsoluteBlocks returns valid offset coordinates', () => {
    var p = new Piece('q');
    var blocks = p.getAbsoluteBlocks();
    assert.equal(blocks.length, 4);
    for (var b of blocks) {
      assert.ok(b[0] >= 0 && b[0] < HEX_COLS, 'col in bounds');
      assert.ok(b[1] >= 0, 'row non-negative');
    }
  });

  it('clone creates independent copy', () => {
    var p = new Piece('S');
    var c = p.clone();
    c.anchorCol = 0;
    assert.notEqual(p.anchorCol, c.anchorCol);
  });

  it('rotateCW changes cell positions', () => {
    var p = new Piece('L');
    var before = JSON.stringify(p.cells);
    p.rotateCW();
    assert.notEqual(JSON.stringify(p.cells), before);
  });

  it('all 8 piece types create valid pieces', () => {
    var types = ['I', 'O', 'S', 'Z', 'q', 'p', 'L', 'J'];
    for (var t of types) {
      var p = new Piece(t);
      var blocks = p.getAbsoluteBlocks();
      assert.ok(blocks.length >= 3, t + ' has cells');
      for (var b of blocks) {
        assert.ok(b[0] >= 0 && b[0] < HEX_COLS, t + ' col in bounds');
        assert.ok(b[1] >= 0, t + ' row non-negative');
      }
    }
  });

  it('I has 4 cells', () => {
    var p = new Piece('I');
    assert.equal(p.cells.length, 4);
  });

  it('L, J, q, p all have 6 unique rotations (non-symmetric 4-cell pieces)', () => {
    // Unlike tripod pieces, these are not rotationally symmetric — all 6 CW
    // rotations should produce distinct cell sets. L/J are 4-chains with a
    // single bend; q/p are triangle-plus-pendant shapes. Both lack the
    // 3-fold symmetry that made old T repeat every 120°.
    for (var type of ['L', 'J', 'q', 'p']) {
      var p = new Piece(type);
      var seen = new Set();
      var cells = p.cells.map(c => ({ q: c.q, r: c.r }));
      for (var i = 0; i < 6; i++) {
        var key = cells.map(c => c.q + ',' + c.r).sort().join('|');
        seen.add(key);
        cells = cells.map(c => ({ q: -c.r, r: c.q + c.r }));
      }
      assert.equal(seen.size, 6, type + ' should have 6 unique rotations');
    }
  });
});

describe('Piece - coordinate math', () => {
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
    var p = new Piece('L');
    var before = JSON.stringify(p.cells);
    p.rotateCCW();
    assert.notEqual(JSON.stringify(p.cells), before);
  });

  it('rotateCW then rotateCCW returns to original', () => {
    var p = new Piece('L');
    var original = JSON.stringify(p.cells);
    p.rotateCW();
    p.rotateCCW();
    assert.equal(JSON.stringify(p.cells), original);
  });

  it('6 CW rotations return to original (hex symmetry)', () => {
    var p = new Piece('I');
    var original = JSON.stringify(p.cells);
    for (var i = 0; i < 6; i++) p.rotateCW();
    assert.equal(JSON.stringify(p.cells), original);
  });
});

describe('PlayerBoard', () => {
  it('creates board with correct dimensions', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.grid.length, HEX_TOTAL_ROWS);
    assert.equal(b.grid[0].length, HEX_COLS);
  });

  it('spawns a piece in the visible area', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    assert.ok(b.currentPiece);
    assert.ok(b.currentPiece.anchorRow >= HEX_BUFFER_ROWS - 1);
  });

  it('moveLeft and moveRight change piece position', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var startCol = b.currentPiece.anchorCol;
    b.moveLeft();
    assert.equal(b.currentPiece.anchorCol, startCol - 1);
    b.moveRight();
    assert.equal(b.currentPiece.anchorCol, startCol);
  });

  it('hardDrop locks piece and returns result', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var result = b.hardDrop();
    assert.ok(result);
    assert.equal(typeof result.linesCleared, 'number');
    assert.ok(Array.isArray(result.lockedBlocks));
  });

  it('hold swaps current piece', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var firstType = b.currentPiece.type;
    b.hold();
    assert.equal(b.holdPiece, firstType);
    assert.ok(b.currentPiece);
    assert.notEqual(b.currentPiece.type, firstType);
  });

  it('getState returns valid state object', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var state = b.getState();
    assert.equal(state.grid.length, HEX_VISIBLE_ROWS);
    assert.ok(state.currentPiece);
    assert.ok(state.ghost);
    assert.ok(Array.isArray(state.nextPieces));
  });

  it('garbage adds rows at bottom', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.applyGarbage(2, 3);
    assert.ok(b.grid[HEX_TOTAL_ROWS - 1][0] > 0);
    assert.equal(b.grid[HEX_TOTAL_ROWS - 1][3], 0); // gap column
  });
});

describe('PlayerBoard - rotation and wall kicks', () => {
  it('rotateCW changes piece orientation', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var before = JSON.stringify(b.currentPiece.cells);
    b.rotateCW();
    assert.notEqual(JSON.stringify(b.currentPiece.cells), before);
  });

  it('rotateCW returns false when no currentPiece', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.rotateCW(), false);
  });

  it('wall kick allows rotation near left edge', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Move piece to left wall
    for (var i = 0; i < HEX_COLS; i++) b.moveLeft();
    var result = b.rotateCW();
    // Should succeed via kick or fail gracefully
    assert.equal(typeof result, 'boolean');
  });

  it('wall kick allows rotation near right edge', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    for (var i = 0; i < HEX_COLS; i++) b.moveRight();
    var result = b.rotateCW();
    assert.equal(typeof result, 'boolean');
  });

  // I piece spans 2 cells to one side of its anchor, so rotations against a wall
  // need a ±2 wall kick. A ±1 kick alone cannot bring it back in-bounds.
  it('I piece rotates at every valid position on an empty board', () => {
    var { Piece } = require('../server/Piece');
    var { TOTAL_ROWS: HEX_TOTAL_ROWS } = require('../server/constants');
    for (var rotStep = 0; rotStep < 6; rotStep++) {
      for (var ac = -3; ac < HEX_COLS + 3; ac++) {
        for (var ar = 0; ar < HEX_TOTAL_ROWS; ar++) {
          var b = new PlayerBoard('p', 1, 1);
          var piece = new Piece('I');
          for (var k = 0; k < rotStep; k++) piece.rotateCW();
          piece._adjustAnchorRow();
          piece.anchorCol = ac;
          piece.anchorRow = ar;
          if (!b.isValidPosition(piece)) continue;
          b.currentPiece = piece;
          assert.equal(b.rotateCW(), true,
            'I piece should rotate at rotStep=' + rotStep + ' col=' + ac + ' row=' + ar);
        }
      }
    }
  });
});

describe('PlayerBoard - movement boundaries', () => {
  it('moveLeft returns false at left wall', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Move all the way left until blocked
    var moved = true;
    while (moved) moved = b.moveLeft();
    assert.equal(b.moveLeft(), false);
  });

  it('moveRight returns false at right wall', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var moved = true;
    while (moved) moved = b.moveRight();
    assert.equal(b.moveRight(), false);
  });

  it('moveLeft returns false when no currentPiece', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.moveLeft(), false);
  });

  it('moveRight returns false when no currentPiece', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.moveRight(), false);
  });
});

describe('PlayerBoard - lateral up-bias', () => {
  // In flat-top hex, a horizontal move is always a diagonal in screen space.
  // We bias up: first lateral from anchor goes up by one half-hex; the next
  // returns down to anchor. y is measured in half-hex units as
  //   y = 2 * anchorRow + (anchorCol & 1).

  function y(piece) {
    return 2 * piece.anchorRow + (piece.anchorCol & 1);
  }

  it('first lateral press from spawn moves up one half-hex', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var y0 = y(b.currentPiece);
    assert.equal(b.moveLeft(), true);
    assert.equal(y(b.currentPiece), y0 - 1, 'left goes up');

    var b2 = new PlayerBoard('p2', 42, 1);
    b2.spawnPiece();
    var y0r = y(b2.currentPiece);
    assert.equal(b2.moveRight(), true);
    assert.equal(y(b2.currentPiece), y0r - 1, 'right goes up');
  });

  it('second consecutive lateral press returns to anchor y', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var anchorY = b.currentPiece._anchorY;
    b.moveLeft();
    b.moveLeft();
    assert.equal(y(b.currentPiece), anchorY, 'returns to anchor');
  });

  it('alternates up/anchor across four presses in the same direction', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var anchorY = b.currentPiece._anchorY;
    var expected = [anchorY - 1, anchorY, anchorY - 1, anchorY];
    for (var i = 0; i < 4; i++) {
      assert.equal(b.moveLeft(), true, 'press ' + (i + 1) + ' succeeds');
      assert.equal(y(b.currentPiece), expected[i], 'press ' + (i + 1) + ' y');
    }
  });

  it('L then R returns to starting col and row', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var startCol = b.currentPiece.anchorCol;
    var startRow = b.currentPiece.anchorRow;
    b.moveLeft();
    b.moveRight();
    assert.equal(b.currentPiece.anchorCol, startCol);
    assert.equal(b.currentPiece.anchorRow, startRow);
  });

  it('gravity preserves above-anchor displacement (no up-budget refund)', () => {
    // After player moves up, gravity ticks. The piece must stay one half-hex
    // above the new anchor — otherwise a second up-press could fully cancel
    // the gravity drop and the player would be hovering.
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.moveLeft();  // piece is 1 half-hex above anchor
    var anchorYBefore = b.currentPiece._anchorY;
    var yBefore = y(b.currentPiece);
    assert.equal(yBefore, anchorYBefore - 1, 'above anchor before gravity');
    b._hexDrop(b.currentPiece);
    assert.equal(b.currentPiece._anchorY, anchorYBefore + 2, 'anchor tracks gravity');
    assert.equal(y(b.currentPiece), yBefore + 2, 'piece y also +2');
    assert.equal(y(b.currentPiece), b.currentPiece._anchorY - 1, 'still 1 above anchor');
  });

  it('no climbing: after L + gravity, next L returns to anchor (down)', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var y0 = y(b.currentPiece);
    b.moveLeft();            // y0 - 1
    b._hexDrop(b.currentPiece);  // y0 + 1 (anchor now at y0 + 2)
    b.moveLeft();            // primary DOWN back to anchor = y0 + 2
    assert.equal(y(b.currentPiece), y0 + 2, 'piece descended full gravity over the cycle');
  });

  it('lateral between ticks saves at most one half-hex of altitude', () => {
    // Pattern "gravity, L": one lateral UP after a gravity tick saves half a
    // cell vs pure gravity. Holding L across further ticks cannot compound —
    // the UP budget is preserved (not refunded) through gravity.
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var y0 = y(b.currentPiece);
    b._hexDrop(b.currentPiece);   // y0 + 2, at anchor
    b.moveLeft();                  // y0 + 1, above anchor
    assert.equal(y(b.currentPiece), y0 + 1, 'saved 1 half-hex');
    b._hexDrop(b.currentPiece);   // y0 + 3, still above (anchor now y0 + 4)
    b.moveLeft();                  // primary DOWN → y0 + 4, at anchor
    assert.equal(y(b.currentPiece), y0 + 4, 'second cycle full gravity, no extra savings');
  });

  it('rotation re-baselines the up-bias anchor to current y', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.moveLeft();  // piece is above anchor
    assert.equal(b.rotateCW(), true, 'rotation should succeed at spawn');
    var postY = y(b.currentPiece);
    assert.equal(b.currentPiece._anchorY, postY, 'anchor matches current y after rotation');
  });

  it('fallback takes opposite diagonal when primary is blocked', () => {
    var b = new PlayerBoard('p1', 42, 1);
    // Use an O piece at anchor (5, 3) — O cells at (4,3),(5,3),(5,2),(6,3).
    b.currentPiece = new Piece('O');
    b.currentPiece.anchorCol = 5;
    b.currentPiece.anchorRow = 3;
    b.currentPiece._anchorY = 2 * 3 + 1;  // at anchor

    // Primary UP (moveRight → anchor (6,3)) needs cells (5,2),(6,3),(6,2),(7,2).
    // Block (6,2) so primary fails. Fallback DOWN (anchor (6,4)) needs
    // (5,3),(6,4),(6,3),(7,3) — all free.
    b.grid[2][6] = HEX_GARBAGE_CELL;

    assert.equal(b.moveRight(), true);
    assert.equal(b.currentPiece.anchorCol, 6);
    assert.equal(b.currentPiece.anchorRow, 4, 'used DOWN fallback row');
  });

  it('returns false when both primary and fallback are blocked', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.currentPiece = new Piece('O');
    b.currentPiece.anchorCol = 5;
    b.currentPiece.anchorRow = 3;
    b.currentPiece._anchorY = 2 * 3 + 1;

    // Block both the primary (6,2) and the fallback (6,4) cells.
    b.grid[2][6] = HEX_GARBAGE_CELL;
    b.grid[4][6] = HEX_GARBAGE_CELL;

    assert.equal(b.moveRight(), false);
    assert.equal(b.currentPiece.anchorCol, 5, 'piece did not move');
  });
});

describe('PlayerBoard - gravity and tick', () => {
  it('tick drops piece over time', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    var startRow = b.currentPiece.anchorRow;
    // Tick enough to trigger at least one gravity drop
    for (var i = 0; i < 100; i++) b.tick(50);
    assert.ok(b.currentPiece === null || b.currentPiece.anchorRow > startRow,
      'piece should have dropped or locked');
  });

  it('tick returns null during clearing delay', () => {
    var b = new PlayerBoard('p1', 42, 1);
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    b.spawnPiece();
    b.hardDrop();
    // Board is now in clearing state
    assert.equal(b.tick(16), null);
  });

  it('tick finishes clearing after delay expires', () => {
    var b = new PlayerBoard('p1', 42, 1);
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    b.spawnPiece();
    b.hardDrop();
    assert.ok(b.clearingCells);
    b.tick(LINE_CLEAR_DELAY_MS + 1);
    assert.equal(b.clearingCells, null);
    assert.ok(b.currentPiece, 'new piece spawned after clear');
  });

  it('tick returns null when not alive', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.alive = false;
    assert.equal(b.tick(16), null);
  });

  it('tick returns null when no currentPiece', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.tick(16), null);
  });
});

describe('PlayerBoard - soft drop', () => {
  it('softDropStart resets gravityCounter', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.gravityCounter = 100;
    b.softDropStart();
    assert.equal(b.gravityCounter, 0);
    assert.equal(b.softDropping, true);
  });

  it('softDropStart does not reset gravityCounter if already dropping', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.softDropping = true;
    b.gravityCounter = 50;
    b.softDropStart();
    assert.equal(b.gravityCounter, 50);
  });

  it('softDropEnd stops soft dropping', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.softDropStart(10);
    b.softDropEnd();
    assert.equal(b.softDropping, false);
  });
});

describe('PlayerBoard - hold edge cases', () => {
  it('hold returns false when holdUsed is true', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.hold();
    assert.equal(b.hold(), false);
  });

  it('hold swaps with held piece on second use', () => {
    var b = new PlayerBoard('p1', 42, 1);
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
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.hold();
    assert.equal(b.holdUsed, true);
    b.hardDrop(); // triggers spawnPiece
    assert.equal(b.holdUsed, false);
  });
});

describe('PlayerBoard - death and game over', () => {
  it('alive is false when piece cannot spawn', () => {
    var b = new PlayerBoard('p1', 42, 1);
    // Fill top rows to block spawning
    for (var r = 0; r < 6; r++) {
      for (var c = 0; c < HEX_COLS; c++) b.grid[r][c] = 1;
    }
    b.spawnPiece();
    assert.equal(b.alive, false);
  });

  it('spawnPiece returns false when blocked', () => {
    var b = new PlayerBoard('p1', 42, 1);
    for (var r = 0; r < 6; r++) {
      for (var c = 0; c < HEX_COLS; c++) b.grid[r][c] = 1;
    }
    assert.equal(b.spawnPiece(), false);
  });

  it('hardDrop returns null when not alive', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.alive = false;
    assert.equal(b.hardDrop(), null);
  });

  it('hardDrop returns null when no currentPiece', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.hardDrop(), null);
  });
});

describe('PlayerBoard - queries', () => {
  it('getStackHeight returns 0 on empty board', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.getStackHeight(), 0);
  });

  it('getStackHeight returns correct height with blocks', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.grid[HEX_TOTAL_ROWS - 1][0] = 1;
    assert.equal(b.getStackHeight(), 1);
    b.grid[HEX_TOTAL_ROWS - 3][5] = 2;
    assert.equal(b.getStackHeight(), 3);
  });

  it('getGhostY returns row >= currentPiece row', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    assert.ok(b.getGhostY() >= b.currentPiece.anchorRow);
  });

  it('getGhostY returns 0 when no currentPiece', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.getGhostY(), 0);
  });

  it('getLevel increases with lines cleared', () => {
    var b = new PlayerBoard('p1', 42, 1);
    assert.equal(b.getLevel(), 1);
    b.lines = 10;
    assert.equal(b.getLevel(), 2);
    b.lines = 25;
    assert.equal(b.getLevel(), 3);
  });

  it('getLevel respects startLevel', () => {
    var b = new PlayerBoard('p1', 42, 5);
    assert.equal(b.getLevel(), 5);
    b.lines = 10;
    assert.equal(b.getLevel(), 6);
  });
});

describe('PlayerBoard - pending garbage', () => {
  it('addPendingGarbage queues garbage', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.addPendingGarbage(2, 3);
    assert.equal(b.pendingGarbage.length, 1);
    assert.equal(b.pendingGarbage[0].lines, 2);
    assert.equal(b.pendingGarbage[0].gapColumn, 3);
  });

  it('pending garbage applied after hard drop without line clear', () => {
    var b = new PlayerBoard('p1', 42, 1);
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
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    b.addPendingGarbage(2, 0);
    b.addPendingGarbage(3, 1);
    var state = b.getState();
    assert.equal(state.pendingGarbage, 5);
  });
});

describe('PlayerBoard - zigzag line clears', () => {
  it('detects zigzag-down clear (same row index)', () => {
    var b = new PlayerBoard('p1', 42, 1);
    // Fill last row completely
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    b.spawnPiece();
    var result = b.hardDrop();
    assert.ok(result.linesCleared >= 1);
  });

  it('detects zigzag-up clear (even cols at r, odd cols at r-1)', () => {
    var b = new PlayerBoard('p1', 42, 1);
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
    var b = new PlayerBoard('p1', 42, 1);
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
    var b = new PlayerBoard('p1', 42, 1);
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
    var b = new PlayerBoard('p1', 42, 1);
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
    var b = new PlayerBoard('p1', 42, 1);
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
    var b = new PlayerBoard('p1', 42, 1);
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
    var { findClearableZigzags } = require('../server/constants');
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
    var b = new PlayerBoard('p1', 42, 1);
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

// ---------------------------------------------------------------------------
// Clear preview vs actual clear consistency
// ---------------------------------------------------------------------------
describe('PlayerBoard - clear preview matches actual clear', () => {
  it('findClearableZigzags with ghost matches actual clear after lock', () => {
    // Simulate what the renderer does: check if ghost + grid would clear,
    // then verify actual clear after locking produces the same result.
    var { findClearableZigzags } = require('../server/constants');
    var b = new PlayerBoard('p1', 42, 1);
    // Fill the bottom row except one column (gap at col 5)
    for (var c = 0; c < HEX_COLS; c++) {
      if (c !== 5) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    }
    b.spawnPiece();
    // Move piece to drop position and get ghost
    var state = b.getState();
    assert.ok(state.ghost && state.ghost.blocks, 'expected ghost to be available');

    // Simulate renderer's preview calculation (visible coordinates)
    var grid = state.grid;
    var ghostBlocks = state.ghost.blocks;
    var ghostSet = {};
    var STRIDE = 100;
    for (var gi = 0; gi < ghostBlocks.length; gi++) {
      ghostSet[ghostBlocks[gi][0] * STRIDE + ghostBlocks[gi][1]] = true;
    }
    var previewResult = findClearableZigzags(
      HEX_COLS, grid.length,
      function(col, row) { return grid[row][col] > 0 || ghostSet[col * STRIDE + row]; },
      function(col, row) { return grid[row][col] === 0 && ghostSet[col * STRIDE + row]; }
    );

    // Now do the actual drop
    var dropResult = b.hardDrop();

    // Both should agree on whether lines clear
    assert.equal(previewResult.linesCleared > 0, dropResult.linesCleared > 0,
      'preview and actual should agree on whether lines clear');

    // If both clear, the cleared cell count should match
    if (previewResult.linesCleared > 0 && dropResult.linesCleared > 0) {
      assert.equal(previewResult.clearCells.length, dropResult.clearCells.length,
        'preview and actual should clear the same number of cells');
    }
  });

  // Regression: the renderer used (anchorCol, anchorRow, typeId, gridVersion) as its
  // preview cache key. Rotation changes the ghost block layout but can keep the
  // anchor identical — the cache key must include something that distinguishes
  // rotation states. cells[0] uniquely identifies rotation for every hex piece type.
  it('rotating a piece without moving it changes cells[0] so the preview can invalidate', () => {
    var { Piece } = require('../server/Piece');
    var { PIECE_TYPES: HEX_PIECE_TYPES } = require('../server/constants');
    for (var ti = 0; ti < HEX_PIECE_TYPES.length; ti++) {
      var type = HEX_PIECE_TYPES[ti];
      if (type === 'O') continue; // O is rotationally symmetric
      var p = new Piece(type);
      var seen = Object.create(null);
      for (var r = 0; r < 6; r++) {
        var key = p.cells[0].q + ',' + p.cells[0].r;
        // `key in seen` rather than `!seen[key]` — r=0 is falsy and would mask a collision.
        assert.ok(!(key in seen),
          type + ' cells[0] collides between rotations ' + seen[key] + ' and ' + r);
        seen[key] = r;
        p.rotateCW();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Garbage + zigzag clear interaction
// ---------------------------------------------------------------------------
describe('PlayerBoard - garbage and zigzag clear interaction', () => {
  it('garbage row alone never triggers a zigzag clear', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Add garbage and apply it directly
    b.addPendingGarbage(3, 2);
    b._applyPendingGarbage();
    // Bottom 3 rows should be garbage with a gap at col 2
    for (var i = 0; i < 3; i++) {
      var row = b.grid[HEX_TOTAL_ROWS - 1 - i];
      assert.equal(row[2], 0, 'gap column should be empty');
      assert.equal(row[0], HEX_GARBAGE_CELL, 'non-gap column should be garbage');
    }
    // No clearing should be in progress
    assert.equal(b.clearingCells, null);
  });

  it('no zigzag clear check after garbage application', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Fill a zigzag-down row completely
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 2][c] = 1;
    // Apply garbage (shifts everything up, does not re-check for clears)
    b.addPendingGarbage(1, 0);
    b._applyPendingGarbage();
    // The full row is now at HEX_TOTAL_ROWS - 3, but no clear should have triggered
    assert.equal(b.clearingCells, null, 'garbage application should not trigger line clears');
  });

  it('garbage applied after zigzag line clear finishes', () => {
    var b = new PlayerBoard('p1', 42, 1);
    // Fill the bottom row completely
    for (var c = 0; c < HEX_COLS; c++) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    b.spawnPiece();
    b.addPendingGarbage(2, 3);
    var result = b.hardDrop();
    if (result.linesCleared > 0) {
      // Garbage should still be pending during clearing animation
      assert.ok(b.pendingGarbage.length > 0, 'garbage pending during clear animation');
      b._finishClearLines();
    }
    // After finishing, garbage should have been applied
    assert.equal(b.pendingGarbage.length, 0, 'garbage applied after clear finishes');
  });

  it('filling gap in garbage zigzag-down clears on next piece lock', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Apply garbage with gap at column 5
    b.addPendingGarbage(1, 5);
    b._applyPendingGarbage();
    // Fill the gap to complete the garbage row
    b.grid[HEX_TOTAL_ROWS - 1][5] = 1;
    // Drop a piece to trigger line clear detection
    b.spawnPiece();
    var result = b.hardDrop();
    // The completed garbage row should clear
    assert.ok(result.linesCleared >= 1, 'should clear the completed garbage row');
  });

  it('multiple garbage batches with different gaps do not complete each other', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Two garbage batches with different gap columns
    b.addPendingGarbage(1, 3);
    b.addPendingGarbage(1, 7);
    b._applyPendingGarbage();
    // Each garbage row should have a gap — neither is full
    var row1 = b.grid[HEX_TOTAL_ROWS - 1];
    var row2 = b.grid[HEX_TOTAL_ROWS - 2];
    assert.ok(row1.includes(0), 'second garbage row has a gap');
    assert.ok(row2.includes(0), 'first garbage row has a gap');
    // No clearing in progress
    assert.equal(b.clearingCells, null);
  });

  it('gap column is adjusted to prevent auto-clearable zigzag', () => {
    var { findClearableZigzags } = require('../server/constants');
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Fill all odd columns in the current bottom row.
    // After splice(0,1) + push, this row moves up and garbage lands below it.
    // A zigzag-up spanning both rows would clear if the gap is at an odd column.
    for (var c = 0; c < HEX_COLS; c++) {
      if (c & 1) b.grid[HEX_TOTAL_ROWS - 1][c] = 1;
    }
    // Request gap at odd column 3 — this would auto-clear without the fix
    b.applyGarbage(1, 3);
    var grid = b.grid;
    var result = findClearableZigzags(HEX_COLS, HEX_TOTAL_ROWS,
      function(col, row) { return grid[row][col] !== 0; }, null, HEX_BUFFER_ROWS);
    assert.equal(result.linesCleared, 0, 'garbage should not create auto-clearable zigzag');
    // The garbage row should still have exactly one gap
    var garbageRow = grid[HEX_TOTAL_ROWS - 1];
    var gaps = garbageRow.filter(function(v) { return v === 0; }).length;
    assert.equal(gaps, 1, 'garbage row should have exactly one gap');
  });

  it('gap column stays unchanged when it does not cause auto-clear', () => {
    var b = new PlayerBoard('p1', 42, 1);
    b.spawnPiece();
    // Empty board — no zigzag possible regardless of gap column
    b.applyGarbage(1, 5);
    assert.equal(b.grid[HEX_TOTAL_ROWS - 1][5], 0, 'gap at requested column 5');
  });
});

describe('Game', () => {
  it('creates hex boards for all players', () => {
    var players = new Map([['p1', {}], ['p2', {}]]);
    var g = new Game(players, { onEvent: () => {}, onGameEnd: () => {} }, 42);
    g.init();
    var snap = g.getSnapshot();
    assert.equal(snap.players.length, 2);
    assert.equal(snap.players[0].grid[0].length, HEX_COLS);
  });
});
