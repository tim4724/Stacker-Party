'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { GarbageManager } = require('../server/GarbageManager');
const { Game } = require('../server/Game');

// ---------------------------------------------------------------------------
// Helper: create a Game with N players and capture events
// ---------------------------------------------------------------------------
function createGame(playerIds, seed) {
  const players = new Map();
  for (const id of playerIds) players.set(id, {});
  const events = [];
  const states = [];
  const game = new Game(players, {
    onGameState: (s) => states.push(s),
    onEvent: (e) => events.push(e),
    onGameEnd: () => {}
  }, seed || 42);
  return { game, events, states };
}

// ---------------------------------------------------------------------------
// GarbageManager.processLineClear — defenseLines parameter
// ---------------------------------------------------------------------------
describe('GarbageManager - defenseLines parameter', () => {
  let gm;

  beforeEach(() => {
    gm = new GarbageManager(() => 0.5);
    gm.addPlayer('p1');
    gm.addPlayer('p2');
  });

  test('defenseLines limits queue cancellation independently of attack', () => {
    // p1 has 4 incoming garbage
    gm.queues.get('p1').push({ lines: 4, gapColumn: 0, senderId: 'p2', ticksLeft: 5 });

    // Clear 4 lines (attack = 4) but only 1 defenseLines remaining
    const result = gm.processLineClear('p1', 4, false, -1, false, () => 5, 1);

    assert.strictEqual(result.cancelled, 1, 'only 1 line cancelled from queue');
    assert.strictEqual(gm.queues.get('p1')[0].lines, 3, '3 lines remain in queue');
    // Attack is still based on 4 lines cleared: GARBAGE_TABLE[4]=4, minus 1 cancelled = 3
    assert.strictEqual(result.sent, 3, 'net attack = 4 - 1 = 3');
  });

  test('defenseLines=0 skips queue cancellation entirely', () => {
    gm.queues.get('p1').push({ lines: 2, gapColumn: 0, senderId: 'p2', ticksLeft: 5 });

    // Clear 4 lines but 0 defenseLines (board-pending already absorbed all defense)
    const result = gm.processLineClear('p1', 4, false, -1, false, () => 5, 0);

    assert.strictEqual(result.cancelled, 0, 'no queue cancellation');
    assert.strictEqual(gm.queues.get('p1')[0].lines, 2, 'queue unchanged');
    assert.strictEqual(result.sent, 4, 'full attack sent');
  });

  test('defenseLines=null falls back to linesCleared', () => {
    gm.queues.get('p1').push({ lines: 2, gapColumn: 0, senderId: 'p2', ticksLeft: 5 });

    const result = gm.processLineClear('p1', 4, false, -1, false, () => 5, null);

    assert.strictEqual(result.cancelled, 2, 'cancels using linesCleared as defense');
  });

  test('defenseLines undefined falls back to linesCleared', () => {
    gm.queues.get('p1').push({ lines: 2, gapColumn: 0, senderId: 'p2', ticksLeft: 5 });

    const result = gm.processLineClear('p1', 4, false, -1, false, () => 5);

    assert.strictEqual(result.cancelled, 2, 'cancels using linesCleared as defense');
  });
});

// ---------------------------------------------------------------------------
// Game.handleLineClear — board-pending cancellation
// ---------------------------------------------------------------------------
describe('Game - board-pending garbage cancellation', () => {
  test('line clear cancels board-pending garbage before manager queue', () => {
    const { game, events } = createGame(['p1', 'p2']);
    const board = game.boards.get('p1');
    board.spawnPiece();

    // Simulate garbage already delivered to board (past the delay)
    board.pendingGarbage.push({ lines: 2, gapColumn: 3 });

    // Also queue delayed garbage in the manager
    game.garbageManager.queues.get('p1').push(
      { lines: 2, gapColumn: 5, senderId: 'p2', ticksLeft: 50 }
    );

    // Simulate a 4-line clear
    game.handleLineClear('p1', {
      linesCleared: 4,
      fullRows: [20, 21, 22, 23],
      scoreResult: { combo: -1, backToBack: false }
    });

    const cancelled = events.find(e => e.type === 'garbage_cancelled');
    assert.ok(cancelled, 'garbage_cancelled event should fire');
    assert.strictEqual(cancelled.lines, 4, 'should cancel 2 board-pending + 2 manager queue');

    // Board pending should be empty
    assert.strictEqual(board.pendingGarbage.length, 0, 'board pending garbage cleared');

    // Manager queue should also be empty
    assert.strictEqual(game.garbageManager.queues.get('p1').length, 0, 'manager queue cleared');
  });

  test('board-pending garbage cancelled first, then manager queue', () => {
    const { game, events } = createGame(['p1', 'p2']);
    const board = game.boards.get('p1');
    board.spawnPiece();

    // 3 lines on board, 3 in manager queue
    board.pendingGarbage.push({ lines: 3, gapColumn: 0 });
    game.garbageManager.queues.get('p1').push(
      { lines: 3, gapColumn: 0, senderId: 'p2', ticksLeft: 50 }
    );

    // Clear 4 lines: should cancel all 3 board-pending, then 1 from manager
    game.handleLineClear('p1', {
      linesCleared: 4,
      fullRows: [20, 21, 22, 23],
      scoreResult: { combo: -1, backToBack: false }
    });

    assert.strictEqual(board.pendingGarbage.length, 0, 'board pending fully cancelled');
    assert.strictEqual(game.garbageManager.queues.get('p1')[0].lines, 2, '2 lines remain in manager');

    const cancelled = events.find(e => e.type === 'garbage_cancelled');
    assert.strictEqual(cancelled.lines, 4, 'total cancelled = 3 + 1');
  });

  test('single line clear cancels 1 board-pending garbage line', () => {
    const { game, events } = createGame(['p1', 'p2']);
    const board = game.boards.get('p1');
    board.spawnPiece();

    board.pendingGarbage.push({ lines: 4, gapColumn: 0 });

    game.handleLineClear('p1', {
      linesCleared: 1,
      fullRows: [23],
      scoreResult: { combo: -1, backToBack: false }
    });

    assert.strictEqual(board.pendingGarbage[0].lines, 3, '3 lines remain on board');
    assert.strictEqual(events.find(e => e.type === 'garbage_cancelled').lines, 1);
  });

  test('no pending garbage means full attack sent', () => {
    const { game, events } = createGame(['p1', 'p2']);
    const board = game.boards.get('p1');
    board.spawnPiece();

    // No pending garbage anywhere
    game.handleLineClear('p1', {
      linesCleared: 4,
      fullRows: [20, 21, 22, 23],
      scoreResult: { combo: -1, backToBack: false }
    });

    const sent = events.find(e => e.type === 'garbage_sent');
    assert.ok(sent, 'garbage_sent event should fire');
    assert.strictEqual(sent.lines, 4, 'full tetris attack sent');

    const cancelled = events.find(e => e.type === 'garbage_cancelled');
    assert.strictEqual(cancelled, undefined, 'no cancellation event');
  });

  test('multiple board-pending entries cancelled front-to-back', () => {
    const { game } = createGame(['p1', 'p2']);
    const board = game.boards.get('p1');
    board.spawnPiece();

    board.pendingGarbage.push({ lines: 1, gapColumn: 0 });
    board.pendingGarbage.push({ lines: 1, gapColumn: 3 });
    board.pendingGarbage.push({ lines: 2, gapColumn: 5 });

    // Clear 3 lines: cancels entries [1, 1, partial 2→1]
    game.handleLineClear('p1', {
      linesCleared: 3,
      fullRows: [21, 22, 23],
      scoreResult: { combo: -1, backToBack: false }
    });

    assert.strictEqual(board.pendingGarbage.length, 1, 'one entry remains');
    assert.strictEqual(board.pendingGarbage[0].lines, 1, 'partially cancelled');
    assert.strictEqual(board.pendingGarbage[0].gapColumn, 5, 'correct entry remains');
  });
});

// ---------------------------------------------------------------------------
// Game.logicTick — garbage not delivered during line clear animation
// ---------------------------------------------------------------------------
describe('Game - garbage delivery during line clear animation', () => {
  test('garbage is re-queued when board is clearing lines', () => {
    const { game } = createGame(['p1', 'p2']);
    const board = game.boards.get('p1');
    board.spawnPiece();

    // Put board into clearing state
    board.clearingRows = [20, 21];
    board.clearingStartTime = Date.now();

    // Queue garbage that expires this tick
    game.garbageManager.queues.get('p1').push(
      { lines: 3, gapColumn: 2, senderId: 'p2', ticksLeft: 1 }
    );

    // Run garbage delivery (extracted from logicTick)
    const readyGarbage = game.garbageManager.tick();
    for (const g of readyGarbage) {
      const b = game.boards.get(g.playerId);
      if (b && b.alive) {
        if (b.clearingRows) {
          const queue = game.garbageManager.queues.get(g.playerId);
          if (queue) {
            queue.push({ lines: g.lines, gapColumn: g.gapColumn, senderId: g.senderId, ticksLeft: 1 });
          }
        } else {
          b.addPendingGarbage(g.lines, g.gapColumn);
        }
      }
    }

    // Board should NOT have received the garbage
    assert.strictEqual(board.pendingGarbage.length, 0, 'no garbage delivered during clear');

    // Garbage should be re-queued in manager with 1 tick delay
    const requeued = game.garbageManager.queues.get('p1');
    assert.strictEqual(requeued.length, 1, 'garbage re-queued');
    assert.strictEqual(requeued[0].lines, 3);
    assert.strictEqual(requeued[0].ticksLeft, 1);
    assert.strictEqual(requeued[0].senderId, 'p2');
  });

  test('garbage is delivered normally when board is not clearing', () => {
    const { game } = createGame(['p1', 'p2']);
    const board = game.boards.get('p1');
    board.spawnPiece();

    // Board is NOT clearing
    assert.strictEqual(board.clearingRows, null);

    game.garbageManager.queues.get('p1').push(
      { lines: 2, gapColumn: 4, senderId: 'p2', ticksLeft: 1 }
    );

    const readyGarbage = game.garbageManager.tick();
    for (const g of readyGarbage) {
      const b = game.boards.get(g.playerId);
      if (b && b.alive) {
        if (b.clearingRows) {
          const queue = game.garbageManager.queues.get(g.playerId);
          if (queue) {
            queue.push({ lines: g.lines, gapColumn: g.gapColumn, senderId: g.senderId, ticksLeft: 1 });
          }
        } else {
          b.addPendingGarbage(g.lines, g.gapColumn);
        }
      }
    }

    assert.strictEqual(board.pendingGarbage.length, 1, 'garbage delivered');
    assert.strictEqual(board.pendingGarbage[0].lines, 2);
  });
});
