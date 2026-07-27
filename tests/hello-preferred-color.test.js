'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MSG } = require('../public/shared/protocol');
const { PLAYER_COLORS } = require('../public/shared/theme');
const { RoomBrain } = require('../server/RoomBrain.js');

// =====================================================================
// The preferred colour riding on HELLO, driven against the REAL handlers in
// server/RoomBrain.js rather than a mirror of them.
//
// Production flow (web controller):
//   1. relay peer_joined -> peerJoined registers the player with an HX
//      fallback name, the next free slot, and helloSeen:false.
//   2. The controller's HELLO carries { name, colorIndex } (its persisted
//      preferred colour). hello applies both and asks for a publish.
//   3. The published snapshot already names the honoured colour, so the
//      controller's reclaimPreferredColor SET_COLOR round trip no-ops and the
//      controller never renders the default slot colour.
// =====================================================================

const PALETTE_SIZE = PLAYER_COLORS.length;

// The colour slots claimed in a published roster, sorted.
function takenIn(roster) {
  return Object.keys(roster)
    .map(function(id) { return roster[id].color; })
    .sort(function(a, b) { return a - b; });
}

function lastPublished(room) {
  return room.published[room.published.length - 1];
}

// The thin shell around the brain: honour the publish hint, and send the
// room-full error the brain reports rather than deciding it here.
function publishAs(room, hint) {
  if (hint === 'now' || hint === 'soon') room.published.push(room.brain.snapshot().players);
}

function onPeerJoined(room, peerIndex) {
  publishAs(room, room.brain.peerJoined(peerIndex, 1000).publish);
}

function onHello(room, fromId, msg) {
  const res = room.brain.hello(fromId, msg, 1100);
  if (!res.accepted && res.roomFull) {
    room.errors.push({ to: fromId, message: 'Room is full' });
    return;
  }
  publishAs(room, res.publish);
}

describe('Display: preferred color on HELLO', () => {
  let room;

  beforeEach(() => {
    const brain = new RoomBrain({ rngSeed: 11 });
    room = { brain, players: brain.players, published: [], errors: [] };
  });

  test('preferred color replaces the default slot for a peer_joined-registered player', () => {
    onPeerJoined(room, 'p1');
    assert.strictEqual(room.players.get('p1').playerIndex, 0, 'default slot before HELLO');
    // The placeholder publish is flagged, so p1's controller ignores it and
    // never paints the default slot colour.
    assert.strictEqual(lastPublished(room)['p1'].helloSeen, false);
    room.published = [];

    onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: 5 });
    assert.strictEqual(room.players.get('p1').playerIndex, 5);
    const row = lastPublished(room)['p1'];
    assert.strictEqual(row.helloSeen, true);
    assert.strictEqual(row.color, 5,
      'the first snapshot p1 acts on already has the honored color, so the reclaim SET_COLOR no-ops');
  });

  test('taken preferred color keeps the assigned slot', () => {
    room.brain.addPlayer('a', { playerName: 'A', playerIndex: 5, startLevel: 1 });
    onPeerJoined(room, 'b');
    room.published = [];

    onHello(room, 'b', { type: MSG.HELLO, name: 'Bob', colorIndex: 5 });
    assert.strictEqual(room.players.get('b').playerIndex, 0, 'collision falls back to the slot');
    assert.strictEqual(lastPublished(room)['b'].color, 0);
    assert.deepStrictEqual(takenIn(lastPublished(room)), [0, 5], 'a keeps slot 5');
  });

  test('invalid colorIndex values are ignored', () => {
    onPeerJoined(room, 'p1');
    room.published = [];

    for (const bad of [-1, PALETTE_SIZE, 99, 'red', null, undefined]) {
      onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: bad });
    }
    assert.strictEqual(room.players.get('p1').playerIndex, 0);
    assert.deepStrictEqual(takenIn(lastPublished(room)), [0], 'slot unchanged');
  });

  test('HELLO-beats-peer_joined path assigns the preferred color directly', () => {
    onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: 3 });
    assert.strictEqual(room.players.get('p1').playerIndex, 3);
    assert.strictEqual(lastPublished(room)['p1'].color, 3);
    assert.strictEqual(lastPublished(room)['p1'].helloSeen, true);
  });

  // Every HELLO publishes, even when nothing about the colour moved: the
  // snapshot is what flips helloSeen and hands the joiner its identity.
  test('a HELLO whose preferred color matches the assigned slot still publishes', () => {
    onPeerJoined(room, 'p1');
    room.published = [];

    onHello(room, 'p1', { type: MSG.HELLO, name: 'Alice', colorIndex: 0 });
    assert.strictEqual(room.published.length, 1);
    assert.strictEqual(lastPublished(room)['p1'].helloSeen, true);
  });

  test('honored color is published so existing controllers grey out the swatch', () => {
    room.brain.addPlayer('a', { playerName: 'A', playerIndex: 1, startLevel: 1 });
    onPeerJoined(room, 'b');
    room.published = [];

    onHello(room, 'b', { type: MSG.HELLO, name: 'Bob', colorIndex: 6 });
    assert.strictEqual(room.published.length, 1, 'a learns that slot 6 got claimed');
    assert.deepStrictEqual(takenIn(lastPublished(room)), [1, 6]);
  });
});
