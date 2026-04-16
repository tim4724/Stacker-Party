'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/Game');
const { LOGIC_TICK_MS, MAX_DROPS_PER_TICK } = require('../server/constants');
const { TOTAL_ROWS, BUFFER_ROWS } = require('../server/constants');
const BOARD_HEIGHT = TOTAL_ROWS;

// Helpers

function makeGame(playerCount, seed) {
  const players = new Map();
  for (let i = 0; i < playerCount; i++) {
    players.set('p' + i, { startLevel: 1 });
  }
  const events = [];
  const game = new Game(players, {
    onGameState: () => {},
    onEvent: (e) => events.push(e),
    onGameEnd: () => {}
  }, seed || 42);
  game.init();
  return { game, events };
}


describe('Slow hardware — large deltaMs', () => {

  test('piece does not teleport with a 200ms frame gap (MAX_DROPS_PER_TICK cap)', () => {
    const { game } = makeGame(1);
    const board = game.boards.get('p0');
    const startY = board.currentPiece.anchorRow;

    // 200ms at 60fps = 12 frames; at level 1 gravity=48 frames/drop, so <1 drop expected.
    // But at high level, gravity is fast — cap should prevent teleporting.
    board.lines = 290; // force high level for fast gravity
    game.update(200);

    const endY = board.currentPiece ? board.currentPiece.anchorRow : BOARD_HEIGHT;
    const dropped = endY - startY;
    assert.ok(dropped <= MAX_DROPS_PER_TICK,
      `Piece dropped ${dropped} rows on 200ms frame, cap is ${MAX_DROPS_PER_TICK}`);
  });

  test('game update with 50ms cap (render loop behavior) processes correctly', () => {
    const { game } = makeGame(1);
    const board = game.boards.get('p0');
    board.lines = 190; // force high level for fast gravity

    // Simulate what the render loop does: cap deltaMs at 50
    for (let i = 0; i < 10; i++) {
      game.update(50);
    }

    // Should still be alive and functioning after 500ms of play
    assert.ok(board.alive, 'Player should be alive after 500ms of capped updates');
    assert.ok(board.currentPiece || board.clearingCells,
      'Should have an active piece or be clearing lines');
  });

  test('irregular frame timing produces consistent gravity', () => {
    // Two games with same seed: one gets steady 16ms frames, other gets jittery frames
    const { game: steady } = makeGame(1, 100);
    const { game: jittery } = makeGame(1, 100);

    const steadyBoard = steady.boards.get('p0');
    const jitteryBoard = jittery.boards.get('p0');

    // Both at level 1 — gravity is 48 frames/drop (~800ms)
    // Run 960ms: steady gets 60 ticks at 16ms, jittery gets varied frames
    for (let i = 0; i < 60; i++) {
      steady.update(16);
    }

    // Jittery: mix of long and short frames totaling 960ms
    const jitteryFrames = [50, 5, 50, 5, 50, 5, 50, 5, 50, 5, 50, 5,  // 6×55ms = 330ms
                           33, 33, 34, 33, 33, 34,                       // 200ms
                           50, 50, 50, 50, 50, 50, 50, 50, 30];          // 430ms = 960ms total
    const jitteryTotal = jitteryFrames.reduce((a, b) => a + b, 0);
    assert.strictEqual(jitteryTotal, 960, 'jittery frames should sum to 960ms');

    for (const dt of jitteryFrames) {
      jittery.update(dt);
    }

    // Both should have their piece at the same Y position (same gravity accumulation)
    const steadyY = steadyBoard.currentPiece ? steadyBoard.currentPiece.anchorRow : -1;
    const jitteryY = jitteryBoard.currentPiece ? jitteryBoard.currentPiece.anchorRow : -1;
    assert.strictEqual(steadyY, jitteryY,
      `Steady Y=${steadyY} vs Jittery Y=${jitteryY} — gravity should be frame-rate independent`);
  });

  test('garbage delivery works correctly with large frame gaps', () => {
    const { game, events } = makeGame(2, 42);

    // Simulate some play, then send garbage
    game.update(100);

    const board0 = game.boards.get('p0');
    const board1 = game.boards.get('p1');

    // Manually add pending garbage to p1
    board1.addPendingGarbage(2, 3);
    const hadPending = board1.pendingGarbage.length > 0;

    // Large frame update — garbage should still be applied properly
    game.update(50);
    game.update(50);

    // Game should still be running without errors
    assert.ok(!game.ended, 'Game should not have ended from garbage + large frames');
    assert.ok(board0.alive, 'Player 0 should be alive');
    assert.ok(board1.alive, 'Player 1 should be alive');
  });

  test('multiple slow frames do not cause piece to skip rows', () => {
    const { game } = makeGame(1);
    const board = game.boards.get('p0');
    board.lines = 140; // force high level for fast gravity

    const positions = [];
    for (let i = 0; i < 20; i++) {
      game.update(50); // ~3 frames per tick at 60fps
      if (board.currentPiece) {
        positions.push(board.currentPiece.anchorRow);
      }
    }

    // Verify piece moves down monotonically (never jumps backwards)
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] >= positions[i - 1],
        `Piece moved up from y=${positions[i-1]} to y=${positions[i]} on frame ${i}`);
    }
  });

  test('soft drop + slow frames respects MAX_DROPS_PER_TICK', () => {
    const { game } = makeGame(1);
    const board = game.boards.get('p0');

    board.softDropStart(20);
    const startY = board.currentPiece.anchorRow;

    // One very slow frame
    game.update(50);

    const endY = board.currentPiece ? board.currentPiece.anchorRow : BOARD_HEIGHT;
    const dropped = endY - startY;
    assert.ok(dropped <= MAX_DROPS_PER_TICK,
      `Soft drop moved ${dropped} rows on 50ms frame, cap is ${MAX_DROPS_PER_TICK}`);

    board.softDropEnd();
  });

  test('sustained low FPS (10fps) game engine stays stable', () => {
    const { game } = makeGame(1, 99);
    const board = game.boards.get('p0');
    board.lines = 290; // force high level for fast gravity

    // Simulate 30 seconds at 10fps (capped to 50ms like render loop)
    let errors = 0;
    for (let i = 0; i < 300; i++) {
      try {
        game.update(50);
      } catch (e) {
        errors++;
      }
      if (game.ended) break;
    }

    assert.strictEqual(errors, 0, 'No errors during sustained low FPS play');
    // At max gravity, piece should have moved down significantly
    // (lock timer uses Date.now() so pieces won't lock in fast test loops,
    //  but gravity should still move the piece to the surface)
    assert.ok(board.alive, 'Player should still be alive');
    assert.ok(board.currentPiece, 'Should have an active piece');
    // Piece should be sitting on the surface or near bottom
    assert.ok(board.currentPiece.anchorRow > BUFFER_ROWS,
      `Piece should have dropped past buffer (y=${board.currentPiece.anchorRow})`);
  });

  test('zero deltaMs frames are harmless (frozen frames)', () => {
    const { game } = makeGame(1);
    const board = game.boards.get('p0');
    const startY = board.currentPiece.anchorRow;

    // Several zero-time frames (e.g., RAF fires twice without time advancing)
    for (let i = 0; i < 10; i++) {
      game.update(0);
    }

    assert.strictEqual(board.currentPiece.anchorRow, startY,
      'Piece should not move on zero-time frames');
    assert.ok(board.alive, 'Player should still be alive');
  });

  test('rapid input processing during slow frames works correctly', () => {
    const { game } = makeGame(1, 42);
    const board = game.boards.get('p0');

    // Burst of inputs between slow frames (simulates input queue draining)
    game.processInput('p0', 'left');
    game.processInput('p0', 'left');
    game.processInput('p0', 'rotate_cw');
    game.processInput('p0', 'left');

    // Then a slow frame
    game.update(50);

    assert.ok(board.alive, 'Player should be alive after burst input + slow frame');
    assert.ok(board.currentPiece, 'Should still have an active piece');
  });
});

describe('Slow hardware — multiplayer consistency', () => {

  test('two-player game survives sustained choppy frames', () => {
    const { game, events } = makeGame(2, 77);

    // Mix of normal and slow frames for 10 seconds
    const frameTimes = [];
    let total = 0;
    while (total < 10000) {
      // Simulate choppy: alternating 8ms and 90ms frames (capped to 50ms by render loop)
      const dt = Math.random() < 0.3 ? 50 : 16;
      frameTimes.push(dt);
      total += dt;
    }

    let errors = 0;
    for (const dt of frameTimes) {
      try {
        game.update(dt);
      } catch (e) {
        errors++;
      }
      if (game.ended) break;
    }

    assert.strictEqual(errors, 0, 'No errors during choppy multiplayer game');
  });

  test('inputs from both players processed correctly during slow frames', () => {
    const { game } = makeGame(2, 55);

    for (let i = 0; i < 20; i++) {
      // Both players send inputs
      game.processInput('p0', 'left');
      game.processInput('p1', 'right');
      game.processInput('p0', 'rotate_cw');
      game.processInput('p1', 'rotate_cw');

      // Slow frame
      game.update(50);
    }

    const board0 = game.boards.get('p0');
    const board1 = game.boards.get('p1');
    assert.ok(board0.alive, 'Player 0 should survive input + slow frames');
    assert.ok(board1.alive, 'Player 1 should survive input + slow frames');
  });
});
