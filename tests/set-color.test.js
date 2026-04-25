'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MSG, ROOM_STATE } = require('../public/shared/protocol');
const { PLAYER_COLORS } = require('../public/shared/theme');

// =====================================================================
// Tests for the lobby color-picker protocol (MSG.SET_COLOR).
//
// onSetColor mirrors the production handler in public/display/DisplayInput.js:
//   - Reject invalid indices (non-integer, out-of-range).
//   - Reject if another player already claims the target index.
//   - Allow during LOBBY unconditionally.
//   - Allow for a late joiner (not in playerOrder) at any roomState.
//   - Reject for an active participant (in playerOrder) unless roomState is LOBBY.
//
// broadcastLobbyUpdate mirrors the production broadcaster: its outgoing
// takenColorIndices payload should reflect the post-swap state.
// =====================================================================

const PALETTE_SIZE = PLAYER_COLORS.length;

function collectTakenColorIndices(players) {
  var out = [];
  for (const entry of players) out.push(entry[1].playerIndex);
  out.sort(function(a, b) { return a - b; });
  return out;
}

function broadcastLobbyUpdate(players, playerOrder, roomState, party) {
  var takenColorIndices = collectTakenColorIndices(players);
  for (const entry of players) {
    party.sendTo(entry[0], {
      type: MSG.LOBBY_UPDATE,
      playerCount: players.size,
      colorIndex: entry[1].playerIndex,
      takenColorIndices: takenColorIndices
    });
  }
}

function nextAvailableSlot(players) {
  var used = new Set();
  for (const entry of players) used.add(entry[1].playerIndex);
  for (var i = 0; i < PALETTE_SIZE; i++) { if (!used.has(i)) return i; }
  return -1;
}

// Mirrors DisplayConnection.js#onPeerJoined — the display-side handler that
// fires on the relay's peer_joined event (before the joiner's HELLO).
// Claims the next free palette slot and, in LOBBY, broadcasts so existing
// controllers can grey out the newly-taken swatch immediately.
function onPeerJoined(players, playerOrder, roomState, party, clientId) {
  if (players.has(clientId)) return;
  var index = nextAvailableSlot(players);
  if (index < 0) return;
  players.set(clientId, {
    playerName: 'P' + (index + 1),
    playerIndex: index,
    startLevel: 1,
    lastPingTime: Date.now()
  });
  if (roomState === ROOM_STATE.LOBBY) {
    playerOrder.push(clientId);
    broadcastLobbyUpdate(players, playerOrder, roomState, party);
  }
}

// Mirrors DisplayInput.js#onSetColor.
function onSetColor(players, playerOrder, roomState, party, fromId, msg) {
  if (!players.has(fromId)) return;
  var idx = parseInt(msg.colorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= PALETTE_SIZE) return;

  var isActiveParticipant = playerOrder.indexOf(fromId) >= 0 && roomState !== ROOM_STATE.LOBBY;
  if (isActiveParticipant) return;

  var player = players.get(fromId);
  if (player.playerIndex === idx) return;

  for (const entry of players) {
    if (entry[0] !== fromId && entry[1].playerIndex === idx) return;
  }

  player.playerIndex = idx;
  broadcastLobbyUpdate(players, playerOrder, roomState, party);
}

function seedPlayer(players, id, playerIndex) {
  players.set(id, { playerName: id, playerIndex: playerIndex, startLevel: 1 });
}

describe('Display: onSetColor', () => {
  let players, playerOrder, roomState, sent, party;

  beforeEach(() => {
    players = new Map();
    playerOrder = [];
    roomState = ROOM_STATE.LOBBY;
    sent = [];
    party = { sendTo: (to, msg) => { sent.push({ to, msg }); } };
  });

  test('accepts an unclaimed color in LOBBY', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 4 });
    assert.strictEqual(players.get('a').playerIndex, 4);
    // One LOBBY_UPDATE fanout, taken reflects the new slot.
    const lobbyMsgs = sent.filter(s => s.msg.type === MSG.LOBBY_UPDATE);
    assert.ok(lobbyMsgs.length >= 1);
    assert.deepStrictEqual(lobbyMsgs[0].msg.takenColorIndices, [4]);
  });

  test('rejects collision with another player', () => {
    seedPlayer(players, 'a', 0);
    seedPlayer(players, 'b', 3);
    playerOrder.push('a', 'b');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 3 });
    assert.strictEqual(players.get('a').playerIndex, 0, 'should not change on collision');
    assert.strictEqual(sent.length, 0, 'no broadcast on rejection');
  });

  test('no-op if requesting the same color already held', () => {
    seedPlayer(players, 'a', 2);
    playerOrder.push('a');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 2 });
    assert.strictEqual(players.get('a').playerIndex, 2);
    assert.strictEqual(sent.length, 0);
  });

  test('rejects invalid indices', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: -1 });
    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: PALETTE_SIZE });
    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 99 });
    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 'red' });
    onSetColor(players, playerOrder, roomState, party, 'a', {});

    assert.strictEqual(players.get('a').playerIndex, 0);
    assert.strictEqual(sent.length, 0);
  });

  test('rejects an active participant during PLAYING', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');
    roomState = ROOM_STATE.PLAYING;

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 0, 'active participant is locked');
    assert.strictEqual(sent.length, 0);
  });

  test('rejects an active participant during COUNTDOWN', () => {
    // Same lockout as PLAYING — covered separately so a refactor that
    // narrowed the guard from "!== LOBBY" to "=== PLAYING" would fail
    // here instead of silently unlocking the countdown window.
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');
    roomState = ROOM_STATE.COUNTDOWN;

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 0);
    assert.strictEqual(sent.length, 0);
  });

  test('rejects an active participant during RESULTS', () => {
    // Same reasoning as COUNTDOWN — the results screen renders each
    // player's color in their rank row, so a mid-RESULTS color change
    // would desync the visible ranking from the player's identity.
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');
    roomState = ROOM_STATE.RESULTS;

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 0);
    assert.strictEqual(sent.length, 0);
  });

  test('accepts a late joiner (not in playerOrder) during PLAYING', () => {
    seedPlayer(players, 'a', 0);
    playerOrder.push('a');
    seedPlayer(players, 'late', 1);
    // 'late' joined mid-game, so onPeerJoined did not append to playerOrder.
    roomState = ROOM_STATE.PLAYING;

    onSetColor(players, playerOrder, roomState, party, 'late', { colorIndex: 6 });
    assert.strictEqual(players.get('late').playerIndex, 6);
    const lobbyMsgs = sent.filter(s => s.msg.type === MSG.LOBBY_UPDATE);
    assert.ok(lobbyMsgs.length >= 1);
    assert.deepStrictEqual(lobbyMsgs[0].msg.takenColorIndices, [0, 6]);
  });

  test('ignores unknown sender', () => {
    onSetColor(players, playerOrder, roomState, party, 'ghost', { colorIndex: 0 });
    assert.strictEqual(sent.length, 0);
  });

  test('onPeerJoined broadcasts so existing controllers see the new slot as taken', () => {
    // Regression: onPeerJoined used to claim the slot silently. The
    // subsequent HELLO from the joiner takes onHello's reconnect branch
    // (player already in Map) and does NOT broadcast, so Alice's picker
    // would keep showing Bob's color as available until some unrelated
    // LOBBY_UPDATE (e.g. a level change) finally refreshed it.
    seedPlayer(players, 'alice', 0);
    playerOrder.push('alice');
    sent.length = 0;

    onPeerJoined(players, playerOrder, roomState, party, 'bob');

    assert.strictEqual(players.get('bob').playerIndex, 1, 'bob claims the next free slot');

    const aliceUpdate = sent.find(s => s.to === 'alice' && s.msg.type === MSG.LOBBY_UPDATE);
    assert.ok(aliceUpdate, 'alice receives a LOBBY_UPDATE when bob joins');
    assert.deepStrictEqual(aliceUpdate.msg.takenColorIndices, [0, 1]);
  });

  test('LOBBY_UPDATE fanout tags each recipient with their own colorIndex', () => {
    seedPlayer(players, 'a', 0);
    seedPlayer(players, 'b', 1);
    playerOrder.push('a', 'b');

    onSetColor(players, playerOrder, roomState, party, 'a', { colorIndex: 7 });
    const byRecipient = new Map();
    for (const s of sent) if (s.msg.type === MSG.LOBBY_UPDATE) byRecipient.set(s.to, s.msg.colorIndex);
    assert.strictEqual(byRecipient.get('a'), 7);
    assert.strictEqual(byRecipient.get('b'), 1);
  });
});
