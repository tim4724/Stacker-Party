'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Scoring } = require('../server/Scoring');

describe('Scoring - line clear base scores at level 1', () => {
  test('single = 100 × level', () => {
    const scoring = new Scoring();
    scoring.addLineClear(1, false, false);
    assert.strictEqual(scoring.score, 100);
  });

  test('double = 300 × level', () => {
    const scoring = new Scoring();
    scoring.addLineClear(2, false, false);
    assert.strictEqual(scoring.score, 300);
  });

  test('triple = 500 × level', () => {
    const scoring = new Scoring();
    scoring.addLineClear(3, false, false);
    assert.strictEqual(scoring.score, 500);
  });

  test('tetris = 800 × level', () => {
    const scoring = new Scoring();
    scoring.addLineClear(4, false, false);
    assert.strictEqual(scoring.score, 800);
  });
});

describe('Scoring - line clear at higher levels', () => {
  test('single at level 2 = 200', () => {
    const scoring = new Scoring();
    scoring.lines = 10; // level = floor(10/10) + 1 = 2
    scoring.addLineClear(1, false, false);
    assert.strictEqual(scoring.score, 200);
  });

  test('tetris at level 3 = 2400', () => {
    const scoring = new Scoring();
    scoring.lines = 20; // level = floor(20/10) + 1 = 3
    scoring.addLineClear(4, false, false);
    assert.strictEqual(scoring.score, 2400);
  });
});

describe('Scoring - T-spin scoring', () => {
  test('T-spin no lines = 400 at level 1', () => {
    const scoring = new Scoring();
    scoring.addLineClear(0, true, false);
    assert.strictEqual(scoring.score, 400);
  });

  test('T-spin single = 800 at level 1', () => {
    const scoring = new Scoring();
    scoring.addLineClear(1, true, false);
    assert.strictEqual(scoring.score, 800);
  });

  test('T-spin double = 1200 at level 1', () => {
    const scoring = new Scoring();
    scoring.addLineClear(2, true, false);
    assert.strictEqual(scoring.score, 1200);
  });

  test('T-spin triple = 1600 at level 1', () => {
    const scoring = new Scoring();
    scoring.addLineClear(3, true, false);
    assert.strictEqual(scoring.score, 1600);
  });

  test('T-spin mini no lines = 100 at level 1', () => {
    const scoring = new Scoring();
    scoring.addLineClear(0, false, true);
    assert.strictEqual(scoring.score, 100);
  });

  test('T-spin mini single = 200 at level 1', () => {
    const scoring = new Scoring();
    scoring.addLineClear(1, false, true);
    assert.strictEqual(scoring.score, 200);
  });
});

describe('Scoring - combos', () => {
  test('combo starts at -1 and increments on line clears', () => {
    const scoring = new Scoring();
    assert.strictEqual(scoring.combo, -1);
    scoring.addLineClear(1, false, false);
    assert.strictEqual(scoring.combo, 0);
    scoring.addLineClear(1, false, false);
    assert.strictEqual(scoring.combo, 1);
    scoring.addLineClear(2, false, false);
    assert.strictEqual(scoring.combo, 2);
  });

  test('combo resets to -1 when clearLines returns 0 cleared lines', () => {
    const scoring = new Scoring();
    scoring.addLineClear(1, false, false);
    scoring.addLineClear(1, false, false);
    assert.strictEqual(scoring.combo, 1);
    // Simulate no-clear: the board's clearLines sets combo = -1 directly
    scoring.combo = -1;
    assert.strictEqual(scoring.combo, -1);
    scoring.addLineClear(1, false, false);
    assert.strictEqual(scoring.combo, 0);
  });

  test('addLineClear returns combo value in result', () => {
    const scoring = new Scoring();
    const r1 = scoring.addLineClear(1, false, false);
    assert.strictEqual(r1.combo, 0);
    const r2 = scoring.addLineClear(1, false, false);
    assert.strictEqual(r2.combo, 1);
  });

  test('addLineClear returns null when no lines and no tspin', () => {
    const scoring = new Scoring();
    const result = scoring.addLineClear(0, false, false);
    assert.strictEqual(result, null);
  });
});

describe('Scoring - back-to-back bonus', () => {
  test('back-to-back tetris applies 1.5x multiplier', () => {
    const scoring = new Scoring();
    // First tetris sets backToBack flag, no bonus
    scoring.addLineClear(4, false, false);
    const scoreAfterFirst = scoring.score;
    // Second tetris gets 1.5x bonus
    scoring.addLineClear(4, false, false);
    const secondTetrisScore = scoring.score - scoreAfterFirst;
    // 800 * 1.5 = 1200, plus combo bonus of 50 (combo=1)
    assert.strictEqual(secondTetrisScore, Math.floor(800 * 1.5) + 50);
  });

  test('back-to-back flag set after tetris', () => {
    const scoring = new Scoring();
    assert.strictEqual(scoring.backToBack, false);
    scoring.addLineClear(4, false, false);
    assert.strictEqual(scoring.backToBack, true);
  });

  test('back-to-back flag set after T-spin', () => {
    const scoring = new Scoring();
    scoring.addLineClear(1, true, false);
    assert.strictEqual(scoring.backToBack, true);
  });

  test('back-to-back flag cleared after non-difficult clear', () => {
    const scoring = new Scoring();
    scoring.addLineClear(4, false, false);
    assert.strictEqual(scoring.backToBack, true);
    scoring.addLineClear(1, false, false); // single clears backToBack
    assert.strictEqual(scoring.backToBack, false);
  });

  test('back-to-back T-spin single applies 1.5x multiplier', () => {
    const scoring = new Scoring();
    scoring.addLineClear(1, true, false);
    const scoreAfterFirst = scoring.score;
    scoring.addLineClear(1, true, false);
    const secondScore = scoring.score - scoreAfterFirst;
    // 800 * 1.5 = 1200, plus combo bonus of 50
    assert.strictEqual(secondScore, Math.floor(800 * 1.5) + 50);
  });
});

describe('Scoring - level progression', () => {
  test('level starts at 1', () => {
    const scoring = new Scoring();
    assert.strictEqual(scoring.getLevel(), 1);
  });

  test('level increases after 10 lines', () => {
    const scoring = new Scoring();
    scoring.lines = 10;
    assert.strictEqual(scoring.getLevel(), 2);
  });

  test('level increases every 10 lines', () => {
    const scoring = new Scoring();
    scoring.lines = 20;
    assert.strictEqual(scoring.getLevel(), 3);
    scoring.lines = 30;
    assert.strictEqual(scoring.getLevel(), 4);
  });

  test('lines accumulate across clears', () => {
    const scoring = new Scoring();
    scoring.addLineClear(1, false, false);
    scoring.addLineClear(2, false, false);
    scoring.addLineClear(4, false, false);
    assert.strictEqual(scoring.lines, 7);
  });
});

describe('Scoring - drop bonuses', () => {
  test('hard drop = 2 points per cell', () => {
    const scoring = new Scoring();
    scoring.addHardDrop(10);
    assert.strictEqual(scoring.score, 20);
  });

  test('soft drop = 1 point per cell', () => {
    const scoring = new Scoring();
    scoring.addSoftDrop(5);
    assert.strictEqual(scoring.score, 5);
  });

  test('hard drop and soft drop accumulate', () => {
    const scoring = new Scoring();
    scoring.addHardDrop(3);
    scoring.addSoftDrop(4);
    assert.strictEqual(scoring.score, 10); // 6 + 4
  });
});

describe('Scoring - getState', () => {
  test('getState returns correct fields', () => {
    const scoring = new Scoring();
    const state = scoring.getState();
    assert.ok('score' in state);
    assert.ok('level' in state);
    assert.ok('lines' in state);
    assert.ok('combo' in state);
    assert.ok('backToBack' in state);
  });
});
