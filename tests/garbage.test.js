'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { GarbageManager } = require('../server/GarbageManager');

function makeManager(...playerIds) {
  const mgr = new GarbageManager();
  for (const id of playerIds) mgr.addPlayer(id);
  return mgr;
}

describe('GarbageManager - garbage lines sent per clear type', () => {
  test('single clear sends 0 garbage lines', () => {
    const mgr = makeManager('p1', 'p2');
    const { sent } = mgr.processLineClear('p1', 1, false, -1, false);
    assert.strictEqual(sent, 0);
  });

  test('double clear sends 1 garbage line', () => {
    const mgr = makeManager('p1', 'p2');
    const { sent } = mgr.processLineClear('p1', 2, false, -1, false);
    assert.strictEqual(sent, 1);
  });

  test('triple clear sends 2 garbage lines', () => {
    const mgr = makeManager('p1', 'p2');
    const { sent } = mgr.processLineClear('p1', 3, false, -1, false);
    assert.strictEqual(sent, 2);
  });

  test('tetris sends 4 garbage lines', () => {
    const mgr = makeManager('p1', 'p2');
    const { sent } = mgr.processLineClear('p1', 4, false, -1, false);
    assert.strictEqual(sent, 4);
  });
});

describe('GarbageManager - T-spin garbage multiplier', () => {
  test('T-spin doubles the garbage for double (1→2)', () => {
    const mgr = makeManager('p1', 'p2');
    const { sent } = mgr.processLineClear('p1', 2, true, -1, false);
    // GARBAGE_TABLE[2]=1, * TSPIN_GARBAGE_MULTIPLIER(2) = 2
    assert.strictEqual(sent, 2);
  });

  test('T-spin triple sends double the normal triple garbage (2→4)', () => {
    const mgr = makeManager('p1', 'p2');
    const { sent } = mgr.processLineClear('p1', 3, true, -1, false);
    // GARBAGE_TABLE[3]=2, * TSPIN_GARBAGE_MULTIPLIER(2) = 4
    assert.strictEqual(sent, 4);
  });

  test('T-spin single (1→0 × 2 = 0 garbage)', () => {
    // GARBAGE_TABLE[1] = 0, * 2 = 0 still
    const mgr = makeManager('p1', 'p2');
    const { sent } = mgr.processLineClear('p1', 1, true, -1, false);
    assert.strictEqual(sent, 0);
  });

  test('T-spin tetris (4→8 garbage)', () => {
    const mgr = makeManager('p1', 'p2');
    const { sent } = mgr.processLineClear('p1', 4, true, -1, false);
    assert.strictEqual(sent, 8); // 4 * 2 = 8
  });
});

describe('GarbageManager - cancellation of incoming garbage', () => {
  test('incoming garbage is cancelled before sending remainder', () => {
    const mgr = makeManager('p1', 'p2');
    // Queue 4 incoming garbage lines for p1 (simulating p2 sent a tetris)
    mgr.queues.get('p1').push({ lines: 4, gapColumn: 0 });

    // p1 clears a tetris (4 garbage to send)
    const { sent, cancelled } = mgr.processLineClear('p1', 4, false, -1, false);
    assert.strictEqual(cancelled, 4, 'All 4 incoming garbage should be cancelled');
    assert.strictEqual(sent, 0, 'No garbage should be sent after full cancellation');
  });

  test('partial cancellation: remaining garbage is sent to opponents', () => {
    const mgr = makeManager('p1', 'p2');
    // Queue 2 incoming garbage lines for p1
    mgr.queues.get('p1').push({ lines: 2, gapColumn: 0 });

    // p1 clears a tetris (4 garbage): cancels 2, sends 2
    const { sent, cancelled } = mgr.processLineClear('p1', 4, false, -1, false);
    assert.strictEqual(cancelled, 2, '2 lines of incoming should be cancelled');
    assert.strictEqual(sent, 2, '2 lines should be sent to opponents');
  });

  test('excess incoming garbage remains in queue after partial cancel', () => {
    const mgr = makeManager('p1', 'p2');
    // 6 incoming garbage, p1 clears a double (defense = 2 lines cleared)
    mgr.queues.get('p1').push({ lines: 6, gapColumn: 3 });

    const { cancelled } = mgr.processLineClear('p1', 2, false, -1, false);
    assert.strictEqual(cancelled, 2, '2 lines cancelled (defense = lines cleared)');

    const remaining = mgr.queues.get('p1');
    assert.strictEqual(remaining.length, 1, 'Remaining garbage entry should still exist');
    assert.strictEqual(remaining[0].lines, 4, '4 lines should remain in queue');
  });

  test('single clear cancels 1 incoming garbage line', () => {
    const mgr = makeManager('p1', 'p2');
    mgr.queues.get('p1').push({ lines: 3, gapColumn: 0 });

    const { sent, cancelled } = mgr.processLineClear('p1', 1, false, -1, false);
    assert.strictEqual(cancelled, 1, 'Single cancels 1 incoming garbage');
    assert.strictEqual(sent, 0, 'Single sends no attack');
    assert.strictEqual(mgr.queues.get('p1')[0].lines, 2, '2 lines remain');
  });
});

describe('GarbageManager - garbage distribution', () => {
  test('garbage targets opponent with lowest stack (strongest player)', () => {
    const mgr = makeManager('p1', 'p2', 'p3');
    // p2 has the lowest stack, so it should be targeted
    const getStackHeight = (id) => (id === 'p3' ? 10 : 3);
    const { deliveries } = mgr.processLineClear('p1', 4, false, -1, false, getStackHeight);

    const p2Queue = mgr.queues.get('p2');
    const p3Queue = mgr.queues.get('p3');
    const p1Queue = mgr.queues.get('p1');

    assert.strictEqual(p2Queue.length, 1, 'p2 (lowest stack) should receive garbage');
    assert.strictEqual(p3Queue.length, 0, 'p3 should not receive garbage');
    assert.strictEqual(p1Queue.length, 0, 'p1 (sender) should not receive own garbage');
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].toId, 'p2');
    assert.strictEqual(deliveries[0].lines, 4);
    assert.strictEqual(p2Queue[0].senderId, 'p1', 'queued garbage should retain sender');
  });

  test('single clear sends no garbage to anyone', () => {
    const mgr = makeManager('p1', 'p2');
    mgr.processLineClear('p1', 1, false, -1, false);

    const p2Queue = mgr.queues.get('p2');
    assert.strictEqual(p2Queue.length, 0, 'p2 should not receive garbage from single clear');
  });

  test('0 lines cleared sends 0 garbage', () => {
    const mgr = makeManager('p1', 'p2');
    const { sent, cancelled } = mgr.processLineClear('p1', 0, false, -1, false);
    assert.strictEqual(sent, 0);
    assert.strictEqual(cancelled, 0);
  });
});

describe('GarbageManager - target selection', () => {
  test('garbage targets lowest stack when multiple opponents exist', () => {
    const mgr = makeManager('p1', 'p2', 'p3', 'p4');
    const getStackHeight = (id) => ({ p2: 8, p3: 2, p4: 12 })[id] || 0;
    const { deliveries } = mgr.processLineClear('p1', 4, false, -1, false, getStackHeight);

    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].toId, 'p3', 'should target p3 with lowest stack (2)');
  });

  test('garbage targets first opponent when stacks are equal', () => {
    const mgr = makeManager('p1', 'p2', 'p3');
    const getStackHeight = () => 5;
    const { deliveries } = mgr.processLineClear('p1', 4, false, -1, false, getStackHeight);

    assert.strictEqual(deliveries.length, 1);
    // When equal, first non-sender in iteration order wins
    assert.ok(deliveries[0].toId !== 'p1', 'should not target sender');
  });
});

describe('GarbageManager - time-based garbage delay', () => {
  test('garbage is not ready until delay ms elapse', () => {
    const { LOGIC_TICK_MS } = require('../server/constants');
    const mgr = makeManager('p1', 'p2');
    mgr.processLineClear('p1', 4, false, -1, false); // sends 4 to p2

    assert.strictEqual(mgr.getPendingLines('p2'), 4, 'p2 has 4 pending lines');

    // Tick once — not ready yet
    const ready = mgr.tick(LOGIC_TICK_MS);
    assert.strictEqual(ready.length, 0, 'garbage should not be ready after 1 tick');
    assert.strictEqual(mgr.getPendingLines('p2'), 4, 'still pending');
  });

  test('garbage becomes ready after GARBAGE_DELAY_MS', () => {
    const { GARBAGE_DELAY_MS, LOGIC_TICK_MS } = require('../server/constants');
    const mgr = makeManager('p1', 'p2');
    mgr.processLineClear('p1', 4, false, -1, false);

    // Tick through the full delay
    const tickCount = Math.ceil(GARBAGE_DELAY_MS / LOGIC_TICK_MS);
    let allReady = [];
    for (let i = 0; i < tickCount; i++) {
      allReady.push(...mgr.tick(LOGIC_TICK_MS));
    }

    assert.strictEqual(allReady.length, 1);
    assert.strictEqual(allReady[0].playerId, 'p2');
    assert.strictEqual(allReady[0].lines, 4);
    assert.strictEqual(allReady[0].senderId, 'p1');
    assert.strictEqual(mgr.getPendingLines('p2'), 0, 'queue should be empty after delivery');
  });

  test('getPendingLines returns 0 when no garbage queued', () => {
    const mgr = makeManager('p1');
    assert.strictEqual(mgr.getPendingLines('p1'), 0);
  });
});

describe('GarbageManager - player management', () => {
  test('addPlayer creates an empty queue for the player', () => {
    const mgr = new GarbageManager();
    mgr.addPlayer('player1');
    assert.ok(mgr.queues.has('player1'));
    assert.deepStrictEqual(mgr.queues.get('player1'), []);
  });

  test('removePlayer deletes the player queue', () => {
    const mgr = makeManager('p1');
    mgr.removePlayer('p1');
    assert.strictEqual(mgr.queues.has('p1'), false);
  });
});
