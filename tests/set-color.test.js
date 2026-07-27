const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROOM_STATE } = require('../public/shared/protocol');
const { PLAYER_COLORS } = require('../public/shared/theme');
const { RoomBrain } = require('../server/RoomBrain.js');

// =====================================================================
// The lobby colour-picker protocol (MSG.SET_COLOR), driven against the REAL
// handler in server/RoomBrain.js rather than a mirror of it. The rules:
//   - Reject invalid indices (non-integer, out-of-range).
//   - Reject if another player already claims the target index.
//   - No-op if the sender already holds the target index.
//   - Not state-gated: accepted in every roomState. The controller's colour
//     picker is reachable only in the lobby, so a mid-game pick cannot occur
//     in practice, but the handler itself imposes no lock.
//
// The display publishes ONE retained snapshot, not a per-recipient fanout, so
// the assertions read the roster back out of what was published.
// =====================================================================

const PALETTE_SIZE = PLAYER_COLORS.length;

// The colour slots claimed in a published snapshot, sorted: what a controller
// derives as takenColorIndices.
function takenIn(snap) {
  return Object.keys(snap.players)
    .map(function(id) { return snap.players[id].color; })
    .sort(function(a, b) { return a - b; });
}

// The thin shell around the brain: honour the publish hint, exactly as
// DisplayInput.js#onSetColor and DisplayConnection.js#onPeerJoined do.
function publishAs(room, hint) {
  if (hint === 'now' || hint === 'soon') room.party.setState(room.brain.snapshot());
}

function onSetColor(room, fromId, msg) {
  publishAs(room, room.brain.setColor(fromId, msg.colorIndex).publish);
}

function onPeerJoined(room, peerIndex) {
  publishAs(room, room.brain.peerJoined(peerIndex, 1000).publish);
}

describe('Display: onSetColor', () => {
  let room, players, sent;

  beforeEach(() => {
    sent = [];
    room = {
      brain: new RoomBrain({ rngSeed: 7 }),
      party: { setState: (snap) => { sent.push(snap); } },
    };
    players = room.brain.players;
  });

  // Seat a player directly in a chosen slot (the fixture path: a real join
  // allocates the lowest free one).
  function seedPlayer(id, playerIndex) {
    room.brain.addPlayer(id, { playerName: id, playerIndex: playerIndex, startLevel: 1 });
    room.brain.addParticipant(id);
  }

  // Drive the room into a non-lobby state through the real transition table.
  function enter(state) {
    for (const step of { countdown: ['countdown'], playing: ['countdown', 'playing'],
                         results: ['countdown', 'playing', 'results'] }[state] || []) {
      room.brain.transitionTo(step);
    }
    sent.length = 0;
  }

  test('accepts an unclaimed color in LOBBY', () => {
    seedPlayer('a', 0);

    onSetColor(room, 'a', { colorIndex: 4 });
    assert.strictEqual(players.get('a').playerIndex, 4);
    // One publish, and its roster reflects the new slot.
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(takenIn(sent[0]), [4]);
  });

  test('rejects collision with another player', () => {
    seedPlayer('a', 0);
    seedPlayer('b', 3);

    onSetColor(room, 'a', { colorIndex: 3 });
    assert.strictEqual(players.get('a').playerIndex, 0, 'should not change on collision');
    assert.strictEqual(sent.length, 0, 'no publish on rejection');
  });

  test('no-op if requesting the same color already held', () => {
    seedPlayer('a', 2);

    onSetColor(room, 'a', { colorIndex: 2 });
    assert.strictEqual(players.get('a').playerIndex, 2);
    assert.strictEqual(sent.length, 0);
  });

  test('rejects invalid indices', () => {
    seedPlayer('a', 0);

    onSetColor(room, 'a', { colorIndex: -1 });
    onSetColor(room, 'a', { colorIndex: PALETTE_SIZE });
    onSetColor(room, 'a', { colorIndex: 99 });
    onSetColor(room, 'a', { colorIndex: 'red' });
    onSetColor(room, 'a', {});

    assert.strictEqual(players.get('a').playerIndex, 0);
    assert.strictEqual(sent.length, 0);
  });

  // Not state-gated: an active participant can recolor in any roomState. The
  // production picker is lobby-only so this can't happen in practice, but the
  // handler imposes no lock — covered across PLAYING/COUNTDOWN/RESULTS so a
  // re-added guard fails here.
  test('accepts a color change during PLAYING', () => {
    seedPlayer('a', 0);
    enter('playing');

    onSetColor(room, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 5);
    assert.deepStrictEqual(takenIn(sent[0]), [5], 'publishes the swap');
  });

  test('accepts a color change during COUNTDOWN', () => {
    seedPlayer('a', 0);
    enter('countdown');

    onSetColor(room, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 5);
  });

  test('accepts a color change during RESULTS', () => {
    seedPlayer('a', 0);
    enter('results');

    onSetColor(room, 'a', { colorIndex: 5 });
    assert.strictEqual(players.get('a').playerIndex, 5);
  });

  test('collision rejection still applies mid-game', () => {
    seedPlayer('a', 0);
    seedPlayer('b', 6);
    enter('playing');

    onSetColor(room, 'a', { colorIndex: 6 });
    assert.strictEqual(players.get('a').playerIndex, 0, 'taken slot is still refused');
    assert.strictEqual(sent.length, 0);
  });

  test('ignores unknown sender', () => {
    onSetColor(room, 'ghost', { colorIndex: 0 });
    assert.strictEqual(sent.length, 0);
  });

  test('onPeerJoined publishes so existing controllers see the new slot as taken', () => {
    // Regression: onPeerJoined used to claim the slot silently, so Alice's
    // picker kept showing Bob's colour as available until some unrelated
    // update (e.g. a level change) finally refreshed it.
    seedPlayer('alice', 0);
    sent.length = 0;

    onPeerJoined(room, 'bob');

    assert.strictEqual(players.get('bob').playerIndex, 1, 'bob claims the next free slot');
    assert.strictEqual(sent.length, 1, 'the join republishes');
    assert.deepStrictEqual(takenIn(sent[0]), [0, 1]);
  });

  test('one snapshot serves every controller: each finds its own colour by peerIndex', () => {
    seedPlayer('a', 0);
    seedPlayer('b', 1);

    onSetColor(room, 'a', { colorIndex: 7 });
    // The old fanout sent one tagged message per recipient; the snapshot is a
    // single object each controller indexes with its own peerIndex.
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].players['a'].color, 7);
    assert.strictEqual(sent[0].players['b'].color, 1);
  });
});
