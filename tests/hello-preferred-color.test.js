'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MSG, ROOM_STATE } = require('../public/shared/protocol');
const { PLAYER_COLORS } = require('../public/shared/theme');
const { generateAutoPlayerName, sanitizePlayerName } = require('./auto-name-helper');

// =====================================================================
// Tests for the preferred color riding on HELLO.
//
// Production flow (web controller):
//   1. relay peer_joined -> DisplayConnection.js#onPeerJoined registers the
//      player with an HX fallback name and the default slot color.
//   2. The controller's HELLO carries { name, colorIndex } (the persisted
//      preferred color). DisplayInput.js#onHello applies both and publishes.
//   3. The published snapshot already names the honored color, so the
//      controller's reclaimPreferredColor SET_COLOR round trip no-ops and the
//      controller never renders the default slot color.
// =====================================================================

const PALETTE_SIZE = PLAYER_COLORS.length;

function nextAvailableSlot(players) {
  var used = new Set();
  for (const entry of players) used.add(entry[1].playerIndex);
  for (var i = 0; i < PALETTE_SIZE; i++) { if (!used.has(i)) return i; }
  return -1;
}

// Mirrors DisplayConnection.js#publishRoomState — one retained snapshot every
// controller reads, in place of the old per-recipient fanout.
function publishRoomState(room) {
  var roster = {};
  for (const entry of room.players) {
    roster[entry[0]] = {
      name: entry[1].playerName,
      color: entry[1].playerIndex,
      helloSeen: entry[1].helloSeen !== false
    };
  }
  room.published.push(roster);
}

// The colour slots claimed in a published snapshot, sorted.
function takenIn(roster) {
  return Object.keys(roster)
    .map(function(id) { return roster[id].color; })
    .sort(function(a, b) { return a - b; });
}

function lastPublished(room) {
  return room.published[room.published.length - 1];
}

// Mirrors DisplayConnection.js#onPeerJoined (roster registration only).
function onPeerJoined(room, clientId) {
  if (room.players.has(clientId)) return;
  var index = nextAvailableSlot(room.players);
  if (index < 0) return;
  room.players.set(clientId, {
    playerName: generateAutoPlayerName(room.players, clientId),
    playerIndex: index,
    startLevel: 1,
    // Placeholder until the HELLO lands: the joiner's own controller ignores
    // its row while this is false, so it never renders a guessed identity.
    helloSeen: false
  });
  if (room.roomState === ROOM_STATE.LOBBY) room.playerOrder.push(clientId);
  publishRoomState(room);
}

// Mirrors DisplayInput.js#helloPreferredColor.
function helloPreferredColor(room, fromId, msg) {
  var idx = parseInt(msg.colorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= PALETTE_SIZE) return null;
  for (const entry of room.players) {
    if (entry[0] !== fromId && entry[1].playerIndex === idx) return null;
  }
  return idx;
}

// Mirrors the name/color slice of DisplayInput.js#onHello.
function onHello(room, fromId, msg) {
  var name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 16) : '';

  if (room.players.has(fromId)) {
    var existing = room.players.get(fromId);
    existing.helloSeen = true;
    if (name || msg.autoName === true) {
      existing.playerName = sanitizePlayerName(
        name || existing.playerName, room.players, fromId, msg.autoName === true);
    }
    var preferredColor = helloPreferredColor(room, fromId, msg);
    if (preferredColor != null && existing.playerIndex !== preferredColor) {
      existing.playerIndex = preferredColor;
    }
    // Unconditional: this publish is also what tells the joiner who they are,
    // so it must go out even when the colour did not move.
    publishRoomState(room);
    return;
  }

  // New player (HELLO beat the relay's peer_joined).
  var index = helloPreferredColor(room, fromId, msg);
  if (index == null) index = nextAvailableSlot(room.players);
  if (index < 0) {
    room.errors.push({ to: fromId, message: 'Room is full' });
    return;
  }
  room.players.set(fromId, {
    playerName: sanitizePlayerName(name, room.players, fromId, msg.autoName === true),
    playerIndex: index,
    startLevel: 1,
    helloSeen: true
  });
  if (room.roomState === ROOM_STATE.LOBBY) room.playerOrder.push(fromId);
  publishRoomState(room);
}

describe('Display: preferred color on HELLO', () => {
  let room;

  beforeEach(() => {
    room = {
      players: new Map(),
      playerOrder: [],
      roomState: ROOM_STATE.LOBBY,
      published: [],
      errors: [],
    };
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
    room.players.set('a', { playerName: 'A', playerIndex: 5, startLevel: 1 });
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
    room.players.set('a', { playerName: 'A', playerIndex: 1, startLevel: 1 });
    onPeerJoined(room, 'b');
    room.published = [];

    onHello(room, 'b', { type: MSG.HELLO, name: 'Bob', colorIndex: 6 });
    assert.strictEqual(room.published.length, 1, 'a learns that slot 6 got claimed');
    assert.deepStrictEqual(takenIn(lastPublished(room)), [1, 6]);
  });
});
