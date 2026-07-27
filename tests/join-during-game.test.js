'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROOM_STATE } = require('../public/shared/protocol');
const { RoomBrain } = require('../server/RoomBrain.js');

// =====================================================================
// Joining while a round is already running, and the participant order that
// decides board layout. Driven against the REAL handlers in
// server/RoomBrain.js, which is what all three displays run.
//
// Someone who joins mid-round is in the ROSTER but not in `participants`.
// That absence is the positive signal a controller routes on: it stays in the
// lobby with a "game in progress" banner instead of being handed a board.
// (The retired WELCOME said the same thing by OMITTING its alive/paused
// fields, which is exactly the kind of implicit contract the snapshot
// replaced. tests/room-snapshot.test.js pins the two against each other.)
// =====================================================================

function makeBrain() {
  return new RoomBrain({ rngSeed: 4242 });
}

// Drive the room into a state through the real transition table.
const STATE_PATH = {
  [ROOM_STATE.LOBBY]: [],
  [ROOM_STATE.COUNTDOWN]: ['countdown'],
  [ROOM_STATE.PLAYING]: ['countdown', 'playing'],
  [ROOM_STATE.RESULTS]: ['countdown', 'playing', 'results'],
};

function enter(brain, state) {
  for (const step of STATE_PATH[state]) brain.transitionTo(step);
}

describe('Display: joining during a game', () => {
  let brain;

  beforeEach(() => {
    brain = makeBrain();
  });

  test('a lobby joiner becomes a participant', () => {
    brain.hello('player1', { name: 'Alice' }, 1000);
    assert.ok(brain.has('player1'));
    assert.ok(brain.isParticipant('player1'));
    assert.deepEqual(brain.snapshot().participants, ['player1']);
  });

  for (const state of [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING]) {
    test(`a ${state} joiner is in the roster but NOT a participant`, () => {
      enter(brain, state);
      brain.hello('player2', { name: 'Bob' }, 1000);

      const snap = brain.snapshot();
      assert.equal(snap.roomState, state);
      assert.ok(snap.players['player2'], 'roster carries them, so their slot is claimed');
      assert.deepEqual(snap.participants, [], 'but they are not in the round');
    });
  }

  test('the production order, peer_joined then HELLO, also withholds participation', () => {
    // The relay fires peer_joined before the controller's HELLO, so the row
    // starts as a placeholder and the join decision is made there, not on HELLO.
    enter(brain, ROOM_STATE.PLAYING);
    const joined = brain.peerJoined('player4', 1000);

    assert.ok(joined.added);
    assert.equal(joined.joinedLobby, false);
    assert.ok(brain.has('player4'));
    assert.ok(!brain.isParticipant('player4'));
    assert.equal(brain.snapshot().players['player4'].helloSeen, false,
      'placeholder until their HELLO lands');

    brain.hello('player4', { name: 'Dave' }, 1100);
    assert.equal(brain.snapshot().players['player4'].helloSeen, true);
    assert.ok(!brain.isParticipant('player4'), 'still waiting out the round');
  });

  test('an active player reconnecting mid-game is NOT demoted to a late joiner', () => {
    brain.hello('player1', { name: 'Alice' }, 1000);
    assert.ok(brain.isParticipant('player1'));

    enter(brain, ROOM_STATE.PLAYING);

    // peer_joined for a peer we already know is a no-op; the HELLO refreshes them.
    assert.equal(brain.peerJoined('player1', 2000).added, false);
    brain.hello('player1', { name: 'Alice' }, 2000);

    assert.ok(brain.isParticipant('player1'), 'keeps their seat in the running round');
    assert.deepEqual(brain.snapshot().participants, ['player1']);
  });

  test('a KO is carried per player, and only for the player it hit', () => {
    brain.hello('player1', { name: 'Alice' }, 1000);
    brain.hello('player2', { name: 'Bob' }, 1000);
    enter(brain, ROOM_STATE.PLAYING);
    brain.setAlive('player1', false);

    const snap = brain.snapshot();
    assert.equal(snap.players['player1'].alive, false);
    assert.equal(snap.players['player2'].alive, true);
  });

  test('someone joining on the results screen sees the ranking', () => {
    brain.hello('player1', { name: 'Alice' }, 1000);
    enter(brain, ROOM_STATE.RESULTS);
    const ranking = [{ rank: 1, playerId: 'player1', lines: 10 }];
    brain.setResults(ranking);

    brain.hello('player5', { name: 'Eve' }, 2000);
    const snap = brain.snapshot();
    assert.equal(snap.roomState, ROOM_STATE.RESULTS);
    assert.deepEqual(snap.results, ranking);
  });

  test('the ranking never leaks into a snapshot that is not on results', () => {
    brain.hello('player1', { name: 'Alice' }, 1000);
    enter(brain, ROOM_STATE.PLAYING);
    brain.setResults([{ rank: 1, playerId: 'player1' }]);
    assert.equal(brain.snapshot().results, undefined);
  });
});

// =====================================================================
// Participant order decides board layout: first joiner leftmost. The colour
// slot (playerIndex) is a palette choice and has nothing to do with position.
// =====================================================================

describe('Display: participant order', () => {
  let brain;

  beforeEach(() => {
    brain = makeBrain();
  });

  function join(id) {
    brain.peerJoined(id, 1000);
  }

  test('matches join order after normal joins', () => {
    join('p1');
    join('p2');
    assert.deepEqual(brain.freezeParticipantOrder(), ['p1', 'p2']);
  });

  test('reconnecting under a new peer index appends; older joiners keep their seat', () => {
    join('p1');
    join('p2');

    brain.peerLeft('p1');
    assert.deepEqual(brain.participants, ['p2']);

    // p1 comes back as a fresh client, so a new joinedAt puts them at the end.
    join('p1-new');
    assert.deepEqual(brain.freezeParticipantOrder(), ['p2', 'p1-new']);
  });

  test('colour changes do NOT reorder', () => {
    join('p1');
    join('p2');
    join('p3');
    brain.setColor('p1', 7);
    brain.setColor('p3', 0); // freed by p1 moving off it
    assert.deepEqual(brain.freezeParticipantOrder(), ['p1', 'p2', 'p3']);
  });

  test('late joiners admitted at the next round land at the end', () => {
    join('p1');
    join('p2');
    brain.transitionTo('countdown');
    brain.freezeParticipantOrder();
    brain.transitionTo('playing');

    join('late');
    assert.ok(!brain.isParticipant('late'));

    brain.transitionTo('lobby');
    brain.admitWaiting();
    assert.deepEqual(brain.freezeParticipantOrder(), ['p1', 'p2', 'late']);
  });

  test('freezing snapshots the array, so a later roster edit cannot shift layout', () => {
    join('p1');
    join('p2');
    const frozen = brain.freezeParticipantOrder();
    join('p3');
    brain.admitWaiting();
    assert.deepEqual(frozen, ['p1', 'p2'], 'the returned order is a copy');
  });
});
