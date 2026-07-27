'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePlayerName, AUTO_PLAYER_NAME_BLOCKLIST } = require('./auto-name-helper');

// Load protocol for ROOM_STATE
const { ROOM_STATE, MSG, INPUT } = require('../public/shared/protocol');

// Simulate the minimal globals that DisplayState.js functions depend on
const GameConstants = require('../server/constants');

// =========================================================================
// nextAvailableSlot — player slot allocation
// =========================================================================

function nextAvailableSlot(players) {
  const used = [];
  for (const entry of players) {
    used.push(entry[1].playerIndex);
  }
  for (let i = 0; i < GameConstants.MAX_PLAYERS; i++) {
    if (used.indexOf(i) < 0) return i;
  }
  return -1;
}

describe('nextAvailableSlot', () => {
  it('returns 0 when no players', () => {
    assert.equal(nextAvailableSlot(new Map()), 0);
  });

  it('returns 1 when slot 0 is taken', () => {
    const players = new Map([['a', { playerIndex: 0 }]]);
    assert.equal(nextAvailableSlot(players), 1);
  });

  it('fills gaps when middle slot freed', () => {
    const players = new Map([
      ['a', { playerIndex: 0 }],
      ['c', { playerIndex: 2 }]
    ]);
    assert.equal(nextAvailableSlot(players), 1);
  });

  it('returns -1 when all slots full', () => {
    const players = new Map();
    for (let i = 0; i < GameConstants.MAX_PLAYERS; i++) {
      players.set('p' + i, { playerIndex: i });
    }
    assert.equal(nextAvailableSlot(players), -1);
  });

  it('returns lowest available slot', () => {
    const players = new Map([
      ['a', { playerIndex: 1 }],
      ['b', { playerIndex: 3 }]
    ]);
    assert.equal(nextAvailableSlot(players), 0);
  });
});

// =========================================================================
// sanitizePlayerName
// =========================================================================

describe('sanitizePlayerName', () => {
  // The fallback NUMBER is picked at random from what is free (a sequential
  // pick would read HX-1, HX-2, HX-3 in every room, which looks assigned
  // rather than chosen). So the assertions below are on the properties that
  // matter, not on a particular draw; the exact-value cases are the ones the
  // algorithm really does pin.
  const AUTO = /^HX-([1-9][0-9]?)$/;

  it('returns an HX fallback for an empty name', () => {
    assert.match(sanitizePlayerName(''), AUTO);
    assert.match(sanitizePlayerName(null), AUTO);
  });

  it('never draws a blocked fallback number', () => {
    for (let i = 0; i < 200; i++) {
      const n = Number(sanitizePlayerName('').slice(3));
      assert.ok(!AUTO_PLAYER_NAME_BLOCKLIST.includes(n), `drew a blocked HX-${n}`);
    }
  });

  it('never draws a fallback number already in the room', () => {
    const players = new Map([
      ['a', { playerName: 'HX-1' }],
      ['b', { playerName: 'HX-2' }],
      ['c', { playerName: 'HX-3' }]
    ]);
    const taken = ['HX-1', 'HX-2', 'HX-3'];
    for (let i = 0; i < 200; i++) {
      const name = sanitizePlayerName('', players);
      assert.match(name, AUTO);
      assert.ok(!taken.includes(name), `collided on ${name}`);
    }
  });

  it('treats default P1-P8 names as legacy fallbacks', () => {
    assert.match(sanitizePlayerName('P1'), AUTO);
    assert.match(sanitizePlayerName('P4'), AUTO);
    assert.match(sanitizePlayerName('p3'), AUTO); // case insensitive
  });

  it('preserves custom names', () => {
    assert.equal(sanitizePlayerName('Alice'), 'Alice');
    assert.equal(sanitizePlayerName('Bob'), 'Bob');
  });

  it('preserves names that look like P-names but are out of range', () => {
    assert.equal(sanitizePlayerName('P9'), 'P9');
    assert.equal(sanitizePlayerName('P0'), 'P0');
    assert.equal(sanitizePlayerName('P12'), 'P12');
  });

  it('reuses requested HX fallback when it is available', () => {
    const players = new Map([['a', { playerName: 'HX-7' }]]);
    assert.equal(sanitizePlayerName('HX-8', players, 'b', true), 'HX-8');
  });

  it('reassigns requested HX fallback when it is already taken', () => {
    const players = new Map([['a', { playerName: 'HX-8' }]]);
    const name = sanitizePlayerName('HX-8', players, 'b', true);
    assert.match(name, AUTO);
    assert.notEqual(name, 'HX-8');
  });

  it('never returns a blocked number even when it is the one requested', () => {
    // A returning player's remembered name is honoured only if it is allowed:
    // tvOS used to have no blocklist at all, so it would have handed HX-4 back.
    for (const blocked of AUTO_PLAYER_NAME_BLOCKLIST) {
      assert.notEqual(sanitizePlayerName(`HX-${blocked}`, new Map(), 'b', true), `HX-${blocked}`);
    }
  });
});

// =========================================================================
// Input validation (from DisplayInput.js)
// =========================================================================

const VALID_ACTIONS = new Set(Object.values(INPUT));

describe('Input validation', () => {
  it('accepts all defined INPUT actions', () => {
    for (const action of Object.values(INPUT)) {
      assert.ok(VALID_ACTIONS.has(action), `${action} should be valid`);
    }
  });

  it('rejects unknown actions', () => {
    assert.ok(!VALID_ACTIONS.has('teleport'));
    assert.ok(!VALID_ACTIONS.has(''));
    assert.ok(!VALID_ACTIONS.has(null));
    assert.ok(!VALID_ACTIONS.has(undefined));
  });

  it('rejects actions with wrong case', () => {
    assert.ok(!VALID_ACTIONS.has('LEFT'));
    assert.ok(!VALID_ACTIONS.has('Hard_Drop'));
  });
});

// =========================================================================
// Level validation (from DisplayInput.js onSetLevel)
// =========================================================================

describe('Level validation', () => {
  function isValidLevel(level) {
    const parsed = parseInt(level, 10);
    return !isNaN(parsed) && parsed >= 1 && parsed <= 15;
  }

  it('accepts levels 1-15', () => {
    for (let i = 1; i <= 15; i++) {
      assert.ok(isValidLevel(i), `level ${i} should be valid`);
    }
  });

  it('accepts string levels', () => {
    assert.ok(isValidLevel('5'));
    assert.ok(isValidLevel('15'));
  });

  it('rejects level 0', () => {
    assert.ok(!isValidLevel(0));
  });

  it('rejects level 16+', () => {
    assert.ok(!isValidLevel(16));
    assert.ok(!isValidLevel(99));
  });

  it('rejects NaN', () => {
    assert.ok(!isValidLevel('abc'));
    assert.ok(!isValidLevel(NaN));
  });
});
