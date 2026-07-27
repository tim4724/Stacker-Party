'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RoomCore } = require('../server/RoomCore.js');

// =====================================================================
// The retained room snapshot is the controller's single source of truth.
// The display publishes ONE object via party.setState(); the relay pushes it
// live and replays it to any (re)joining peer. Everything a controller shows
// is derived from it: identity, roster, host, pause, liveness, results, and
// which screen is up. No per-recipient message survives alongside it.
//
// The snapshot is built by the REAL production module (server/RoomCore.js),
// which tvOS and Android TV load out of the same bundle, so these assertions
// are about all three displays at once. Only the CONTROLLER side is mirrored
// here (it is still per-shell JavaScript), and the lockstep guard at the
// bottom keeps those two mirrors honest:
//   applyRoster         -> public/controller/ControllerGame.js#applyRoster
//   routeToRoomState    -> public/controller/ControllerGame.js#routeToRoomState
//   legacyWelcomeTo     -> the DELETED per-recipient WELCOME, frozen here as
//                          the historical payload the snapshot must reproduce
//
// The core property under test: for any room, the snapshot round-trips to
// exactly what the old WELCOME told each recipient, screen routing included.
// =====================================================================

// The OLD per-recipient payload (WELCOME), for parity assertions.
function legacyWelcomeTo(room, id) {
  const player = room.players.get(id);
  const hostPlayer = room.hostPeerIndex != null ? room.players.get(room.hostPeerIndex) : null;
  const taken = [];
  for (const entry of room.players) taken.push(entry[1].playerIndex);
  taken.sort((a, b) => a - b);
  const isLateJoiner = (room.roomState === 'playing' || room.roomState === 'countdown')
    && room.playerOrder.indexOf(id) < 0;
  const msg = {
    playerName: player.playerName,
    colorIndex: player.playerIndex,
    playerCount: room.players.size,
    roomState: room.roomState,
    startLevel: player.startLevel || 1,
    isHost: id === room.hostPeerIndex,
    hostName: hostPlayer ? hostPlayer.playerName : null,
    hostColorIndex: hostPlayer ? hostPlayer.playerIndex : null,
    takenColorIndices: taken,
    displayMuted: !!room.muted,
  };
  if (!isLateJoiner) {
    msg.alive = room.lastAliveState[id] != null ? room.lastAliveState[id] : true;
    msg.paused = room.manuallyPaused;
  }
  if (room.roomState === 'results' && room.lastResults) msg.results = room.lastResults.results;
  return msg;
}

// --- Production mirror: controller side ------------------------------------

// Body verbatim from production (which takes the roster as an argument
// because onState already looked our own row up out of it).
function applyRoster(snap, roster, peerIndex) {
  var ids = Object.keys(roster);
  var colors = [];
  for (var i = 0; i < ids.length; i++) {
    var c = roster[ids[i]].color;
    if (typeof c === 'number') colors.push(c);
  }
  colors.sort(function (a, b) { return a - b; });
  var hostIdx = snap.hostPeerIndex;
  var hostEntry = (hostIdx != null) ? roster[hostIdx] : null;
  return {
    playerCount: ids.length,
    takenColorIndices: colors,
    isHost: hostIdx != null && peerIndex === hostIdx,
    hostName: hostEntry ? hostEntry.name : null,
    hostColorIndex: hostEntry ? hostEntry.color : null,
  };
}

// Which screen the snapshot puts this controller on. Mirrors the branch
// structure of routeToRoomState (the screen names are this test's own labels).
function routeToRoomState(snap, peerIndex) {
  var inGame = snap.roomState === 'playing' || snap.roomState === 'countdown';
  var participant = inGame && Array.isArray(snap.participants)
    && snap.participants.indexOf(peerIndex) >= 0;
  const waitingForNextGame = inGame && !participant;
  if (participant) return { screen: 'game', waitingForNextGame };
  if (snap.roomState === 'results' && snap.results) return { screen: 'gameover', waitingForNextGame };
  return { screen: 'lobby', waitingForNextGame };
}

// Everything one controller derives, in the shape the old WELCOME carried, so
// the two can be compared field for field.
function deriveWelcomeEquivalent(snap, peerIndex) {
  const mine = snap.players[peerIndex];
  const roster = applyRoster(snap, snap.players, peerIndex);
  const { waitingForNextGame } = routeToRoomState(snap, peerIndex);
  const out = {
    playerName: mine.name,
    colorIndex: mine.color,
    playerCount: roster.playerCount,
    roomState: snap.roomState,
    startLevel: mine.startLevel,
    isHost: roster.isHost,
    hostName: roster.hostName,
    hostColorIndex: roster.hostColorIndex,
    takenColorIndices: roster.takenColorIndices,
    displayMuted: snap.displayMuted,
  };
  // WELCOME signalled "late joiner" by OMITTING alive/paused. The snapshot
  // says it positively, via absence from `participants`.
  if (!waitingForNextGame) {
    out.alive = mine.alive;
    out.paused = snap.paused;
  }
  if (snap.roomState === 'results' && snap.results) out.results = snap.results;
  return out;
}

// Build a real RoomCore in the described state, then expose it behind the same
// field names legacyWelcomeTo reads, so the frozen WELCOME payload is compared
// against genuine production output rather than a second copy of it.
const STATE_PATH = { lobby: [], countdown: ['countdown'], playing: ['countdown', 'playing'], results: ['countdown', 'playing', 'results'] };

function makeRoom(over) {
  const spec = Object.assign({
    roomState: 'lobby',
    hostPeerIndex: null,
    manuallyPaused: false,
    muted: false,
    playerOrder: [],
    players: new Map(),
    lastAliveState: {},
    lastResults: null,
  }, over);

  // rng is pinned but unused by these fixtures: every row carries an explicit
  // name, so no auto-name is generated.
  const roomCore = new RoomCore({ rng: () => 0 });

  // Seat the intended host first. The first joiner takes the sticky slot, which
  // is how a real room elects one, so the fixture never has to poke at it.
  const ids = [...spec.players.keys()];
  if (spec.hostPeerIndex != null && ids.indexOf(spec.hostPeerIndex) >= 0) {
    ids.splice(ids.indexOf(spec.hostPeerIndex), 1);
    ids.unshift(spec.hostPeerIndex);
  }
  for (const id of ids) roomCore.addPlayer(id, Object.assign({}, spec.players.get(id)));

  for (const step of STATE_PATH[spec.roomState]) roomCore.transitionTo(step);
  roomCore.setParticipants(spec.playerOrder);
  for (const id of Object.keys(spec.lastAliveState)) {
    roomCore.setAlive(Number(id), spec.lastAliveState[id]);
  }
  if (spec.manuallyPaused) roomCore.pause('manual');
  if (spec.muted) roomCore.setMuted(true);
  if (spec.lastResults) roomCore.setResults(spec.lastResults.results);

  return {
    roomCore,
    snapshot: () => roomCore.snapshot(),
    get players() { return roomCore.players; },
    get hostPeerIndex() { return roomCore.host; },
    get roomState() { return roomCore.state; },
    get playerOrder() { return roomCore.participants; },
    get muted() { return roomCore.muted; },
    get manuallyPaused() { return roomCore.pauseReason === 'manual'; },
    lastAliveState: spec.lastAliveState,
    lastResults: spec.lastResults,
  };
}

// Shorthand for the many places that only care about the published object.
function snapshotOf(spec) { return makeRoom(spec).snapshot(); }

describe('room snapshot: display builder', () => {
  test('encodes the roster keyed by peerIndex plus the room-wide state', () => {
    const room = makeRoom({
      hostPeerIndex: 1,
      playerOrder: [1, 3],
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 5 }],
        [3, { playerName: 'Bo', playerIndex: 0, startLevel: 1 }],
      ]),
    });
    assert.deepEqual(room.snapshot(), {
      roomState: 'lobby',
      hostPeerIndex: 1,
      paused: false,
      displayMuted: false,
      participants: [1, 3],
      players: {
        1: { name: 'Ann', color: 2, startLevel: 5, alive: true, helloSeen: true },
        3: { name: 'Bo', color: 0, startLevel: 1, alive: true, helloSeen: true },
      },
    });
  });

  test('carries startLevel per player, defaulting to 1', () => {
    const room = makeRoom({
      hostPeerIndex: 1,
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 9 }],
        [3, { playerName: 'Bo', playerIndex: 0 }],
      ]),
    });
    const snap = room.snapshot();
    assert.equal(snap.players[1].startLevel, 9);
    assert.equal(snap.players[3].startLevel, 1);
  });

  test('a KO flips only that player alive:false', () => {
    const room = makeRoom({
      roomState: 'playing',
      hostPeerIndex: 1,
      playerOrder: [1, 3],
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 1 }],
        [3, { playerName: 'Bo', playerIndex: 0, startLevel: 1 }],
      ]),
      lastAliveState: { 3: false },
    });
    const snap = room.snapshot();
    assert.equal(snap.players[1].alive, true);
    assert.equal(snap.players[3].alive, false);
  });

  test('results ride the snapshot, and only in the results state', () => {
    const results = { elapsed: 1234, results: [{ playerId: 1, rank: 1, lines: 20 }] };
    const players = new Map([[1, { playerName: 'Ann', playerIndex: 2, startLevel: 1 }]]);
    assert.deepEqual(
      snapshotOf(({ roomState: 'results', players, lastResults: results })).results,
      results.results
    );
    // Same cached ranking, mid-game: must not leak into a playing snapshot.
    assert.equal(
      snapshotOf(({ roomState: 'playing', players, lastResults: results })).results,
      undefined
    );
  });

  // peer_joined reaches the display before the joiner's HELLO, so their row
  // starts as a guess (auto name, next free colour slot). It has to be in the
  // snapshot — it claims a palette slot the other pickers must grey out — but
  // it is flagged so the joiner's own controller waits rather than rendering a
  // name it is about to replace.
  test('a peer registered before its HELLO is flagged helloSeen:false', () => {
    const room = makeRoom({
      hostPeerIndex: 1,
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 1, helloSeen: true }],
        [3, { playerName: 'HX-8', playerIndex: 0, startLevel: 1, helloSeen: false }],
      ]),
    });
    const snap = room.snapshot();
    assert.equal(snap.players[1].helloSeen, true);
    assert.equal(snap.players[3].helloSeen, false);
    // The placeholder still claims its colour for everyone else's picker.
    assert.deepEqual(applyRoster(snap, snap.players, 1).takenColorIndices, [0, 2]);
    assert.equal(applyRoster(snap, snap.players, 1).playerCount, 2);
  });

  test('an emptied lobby publishes an honest empty roster (no departed ghost / stale host)', () => {
    // When the last lobby player leaves, the display republishes so the relay
    // never replays a snapshot naming a player who is gone.
    const snap = snapshotOf(({}));
    assert.deepEqual(snap.players, {});
    assert.equal(snap.hostPeerIndex, null);
    // A peer that isn't in the roster has no identity to render: the controller
    // early-returns on that, so an empty snapshot can never route a screen or
    // cancel a display-gone bail.
    assert.equal(snap.players[1], undefined);
  });

  test('stays tiny — a full 9-player room on results is far under the 16 KiB relay cap', () => {
    const players = new Map();
    const results = [];
    for (let i = 1; i <= 9; i++) {
      players.set(i, { playerName: 'Player-' + i, playerIndex: i - 1, startLevel: 1 });
      results.push({ playerId: i, playerName: 'Player-' + i, colorIndex: i - 1, rank: i, lines: 40, level: 12 });
    }
    const snap = snapshotOf(({
      roomState: 'results',
      hostPeerIndex: 1,
      playerOrder: [...players.keys()],
      players,
      lastResults: { elapsed: 90000, results },
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(snap)) < 16 * 1024);
  });
});

describe('room snapshot: controller derivation parity with the deleted WELCOME', () => {
  const cases = [
    ['lobby', makeRoom({
      hostPeerIndex: 1,
      playerOrder: [1, 3, 4],
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 5 }],
        [3, { playerName: 'Bo', playerIndex: 0, startLevel: 7 }],
        [4, { playerName: 'Cy', playerIndex: 5, startLevel: 1 }],
      ]),
    })],
    ['mid-game with a KO, a manual pause and a late joiner', makeRoom({
      roomState: 'playing',
      hostPeerIndex: 1,
      manuallyPaused: true,
      muted: true,
      playerOrder: [1, 3],
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 5 }],
        [3, { playerName: 'Bo', playerIndex: 0, startLevel: 7 }],
        [9, { playerName: 'Zed', playerIndex: 6, startLevel: 1 }],
      ]),
      lastAliveState: { 3: false },
    })],
    ['results', makeRoom({
      roomState: 'results',
      hostPeerIndex: 3,
      playerOrder: [1, 3],
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 5 }],
        [3, { playerName: 'Bo', playerIndex: 0, startLevel: 7 }],
      ]),
      lastResults: { elapsed: 1000, results: [{ playerId: 3, rank: 1 }, { playerId: 1, rank: 2 }] },
    })],
  ];

  for (const [label, room] of cases) {
    test(`every recipient derives what WELCOME told them — ${label}`, () => {
      const snap = room.snapshot();
      for (const id of room.players.keys()) {
        assert.deepEqual(deriveWelcomeEquivalent(snap, id), legacyWelcomeTo(room, id), 'parity for peer ' + id);
      }
    });
  }

  test('non-host derives isHost=false; host derives isHost=true', () => {
    const snap = snapshotOf(({
      hostPeerIndex: 1,
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 1 }],
        [3, { playerName: 'Bo', playerIndex: 0, startLevel: 1 }],
      ]),
    }));
    assert.equal(applyRoster(snap, snap.players, 1).isHost, true);
    assert.equal(applyRoster(snap, snap.players, 3).isHost, false);
    assert.equal(applyRoster(snap, snap.players, 3).hostName, 'Ann');
    assert.equal(applyRoster(snap, snap.players, 3).hostColorIndex, 2);
  });

  test('a color pick is reflected back to the picker via the roster', () => {
    // Ann picks color 4; the display updates the roster and republishes.
    const snap = snapshotOf(({
      hostPeerIndex: 1,
      players: new Map([[1, { playerName: 'Ann', playerIndex: 4, startLevel: 1 }]]),
    }));
    assert.equal(snap.players[1].color, 4);
    assert.deepEqual(applyRoster(snap, snap.players, 1).takenColorIndices, [4]);
  });
});

describe('room snapshot: screen routing', () => {
  function snapshotIn(roomState, over) {
    return snapshotOf((Object.assign({
      roomState,
      hostPeerIndex: 1,
      playerOrder: [1, 3],
      players: new Map([
        [1, { playerName: 'Ann', playerIndex: 2, startLevel: 1 }],
        [3, { playerName: 'Bo', playerIndex: 0, startLevel: 1 }],
        [9, { playerName: 'Zed', playerIndex: 6, startLevel: 1 }],
      ]),
    }, over)));
  }

  test('lobby routes everyone to the lobby', () => {
    const snap = snapshotIn('lobby');
    assert.deepEqual(routeToRoomState(snap, 1), { screen: 'lobby', waitingForNextGame: false });
    assert.deepEqual(routeToRoomState(snap, 9), { screen: 'lobby', waitingForNextGame: false });
  });

  for (const state of ['countdown', 'playing']) {
    test(`${state} routes participants to the game and late joiners to the lobby`, () => {
      const snap = snapshotIn(state);
      assert.deepEqual(routeToRoomState(snap, 1), { screen: 'game', waitingForNextGame: false });
      // Peer 9 is in the roster but absent from participants — the positive
      // signal that replaced WELCOME's "alive field omitted" convention.
      assert.deepEqual(routeToRoomState(snap, 9), { screen: 'lobby', waitingForNextGame: true });
    });
  }

  test('results routes everyone (late joiners included) to the gameover screen', () => {
    const snap = snapshotIn('results', {
      lastResults: { elapsed: 1, results: [{ playerId: 1, rank: 1 }] },
    });
    assert.deepEqual(routeToRoomState(snap, 1), { screen: 'gameover', waitingForNextGame: false });
    assert.deepEqual(routeToRoomState(snap, 9), { screen: 'gameover', waitingForNextGame: false });
  });

  test('results with no ranking to show falls back to the lobby', () => {
    const snap = snapshotIn('results');
    assert.equal(snap.results, undefined);
    assert.equal(routeToRoomState(snap, 1).screen, 'lobby');
  });
});

// =====================================================================
// Production lockstep drift guard
// =====================================================================
// The two controller-side functions above are hand-copied MIRRORS of
// production logic (the display side now calls the real module). Nothing structural forces them to track the source, so this guard
// reads the REAL production files and asserts that each mirror's load-bearing
// lines still appear in BOTH the production source AND the mirror's own body.
// If production changes a mirrored line without this test being updated (or
// vice versa), the fragment stops matching one side and the guard fails,
// catching silent drift while the value-parity tests above stay green.
//
// Robustness: fragments are matched after stripping line comments and ALL
// whitespace, so cosmetic reformatting (indentation, `function (a,b)` vs
// `function(a,b)`) never trips the guard, but any token/logic change does.
// Fragments are chosen from lines that are token-identical on both sides;
// lines that differ only in wiring (the mirror reads `room.hostPeerIndex`
// where production calls `getHostPeerIndex()`) are left out and covered
// indirectly by an adjacent identical line, so the guard stays strict without
// pinning cosmetics.

function stripToTokens(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
}

const CONTROLLER_SRC = stripToTokens(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'controller', 'ControllerGame.js'), 'utf8')
);

// Each entry pins a mirror to the production function it claims to copy. Every
// fragment must appear (token-normalized) in BOTH the mirror's own source and
// the production file.
const LOCKSTEP = [
  {
    what: 'applyRoster mirrors ControllerGame.js#applyRoster',
    mirror: applyRoster,
    prod: CONTROLLER_SRC,
    fragments: [
      'var ids = Object.keys(roster);',
      'var c = roster[ids[i]].color;',
      "if (typeof c === 'number') colors.push(c);",
      'colors.sort(function(a, b) { return a - b; });',
      'var hostIdx = snap.hostPeerIndex;',
      'var hostEntry = (hostIdx != null) ? roster[hostIdx] : null;',
    ],
  },
  {
    what: 'routeToRoomState mirrors ControllerGame.js#routeToRoomState',
    mirror: routeToRoomState,
    prod: CONTROLLER_SRC,
    fragments: [
      "var inGame = snap.roomState === 'playing' || snap.roomState === 'countdown';",
      'var participant = inGame && Array.isArray(snap.participants)',
      '&& snap.participants.indexOf(peerIndex) >= 0;',
    ],
  },
];

describe('room snapshot: production lockstep guard', () => {
  for (const { what, mirror, prod, fragments } of LOCKSTEP) {
    const mirrorSrc = stripToTokens(mirror.toString());
    for (const fragment of fragments) {
      test(`${what}: "${fragment}"`, () => {
        const needle = stripToTokens(fragment);
        assert.ok(
          mirrorSrc.includes(needle),
          'the test mirror no longer contains this asserted line; update the fragment list'
        );
        assert.ok(
          prod.includes(needle),
          'production source no longer contains this mirrored line; the test mirror is stale'
        );
      });
    }
  }
});
