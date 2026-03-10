'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { GarbageManager } = require('../server/GarbageManager');

describe('GarbageManager - tick', () => {
  let gm;

  beforeEach(() => {
    gm = new GarbageManager(() => 0.5);
    gm.addPlayer('p1');
    gm.addPlayer('p2');
  });

  test('tick decrements msLeft on queued garbage', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 2, gapColumn: 3, senderId: 'p2', msLeft: 100 });
    gm.tick(20);
    assert.strictEqual(queue[0].msLeft, 80);
  });

  test('tick returns garbage when msLeft reaches 0', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 3, gapColumn: 5, senderId: 'p2', msLeft: 16 });
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].playerId, 'p1');
    assert.strictEqual(ready[0].lines, 3);
    assert.strictEqual(ready[0].gapColumn, 5);
    assert.strictEqual(ready[0].senderId, 'p2');
    // Should be removed from queue
    assert.strictEqual(queue.length, 0);
  });

  test('tick returns empty array when no garbage is ready', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 2, gapColumn: 3, senderId: 'p2', msLeft: 200 });
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 0);
    assert.strictEqual(queue.length, 1);
  });

  test('tick processes multiple players independently', () => {
    gm.queues.get('p1').push({ lines: 1, gapColumn: 0, senderId: 'p2', msLeft: 16 });
    gm.queues.get('p2').push({ lines: 2, gapColumn: 4, senderId: 'p1', msLeft: 16 });
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 2);
    const ids = ready.map(g => g.playerId).sort();
    assert.deepStrictEqual(ids, ['p1', 'p2']);
  });

  test('tick handles multiple garbage entries for same player', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 1, gapColumn: 0, senderId: 'p2', msLeft: 16 });
    queue.push({ lines: 2, gapColumn: 3, senderId: 'p2', msLeft: 48 });
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].lines, 1);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].msLeft, 32);
  });

  test('multiple ticks count down correctly', () => {
    const queue = gm.queues.get('p1');
    queue.push({ lines: 4, gapColumn: 7, senderId: 'p2', msLeft: 48 });
    assert.strictEqual(gm.tick(16).length, 0);
    assert.strictEqual(gm.tick(16).length, 0);
    const ready = gm.tick(16);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].lines, 4);
  });
});

describe('GarbageManager - processLineClear delivery', () => {
  let gm;

  beforeEach(() => {
    gm = new GarbageManager(() => 0.5);
    gm.addPlayer('p1');
    gm.addPlayer('p2');
    gm.addPlayer('p3');
  });

  test('sends garbage to opponent with lowest stack', () => {
    const result = gm.processLineClear('p1', 4, false, 0, false, (id) => {
      return id === 'p2' ? 5 : 10;
    });
    assert.strictEqual(result.sent > 0, true);
    assert.strictEqual(result.deliveries[0].toId, 'p2');
  });

  test('garbage cancels incoming before sending', () => {
    // Give p1 some pending garbage
    gm.queues.get('p1').push({ lines: 2, gapColumn: 0, senderId: 'p2', msLeft: 100 });
    const result = gm.processLineClear('p1', 4, false, 0, false, () => 5);
    assert.strictEqual(result.cancelled, 2);
  });

  test('no garbage sent for 0 lines cleared', () => {
    const result = gm.processLineClear('p1', 0, false, 0, false, () => 5);
    assert.deepStrictEqual(result, { sent: 0, cancelled: 0, deliveries: [] });
  });
});
