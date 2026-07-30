'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RoomCore } = require('../server/RoomCore.js');
const LegacyDisplayRoom = require('../public/controller/ControllerLegacyDisplay.js');

// =====================================================================
// LEGACY DISPLAY COMPAT — delete with public/controller/ControllerLegacyDisplay.js
// =====================================================================
//
// Apple TV 4.6.0 publishes no room snapshot; it speaks the per-message fanout
// the snapshot replaced. The shim rebuilds a snapshot from that fanout, and the
// property under test is the one that makes it safe: for the same room, the
// controller must READ THE SAME THINGS out of the shim's snapshot as it would
// out of the real one.
//
// So the left side here is the production RoomCore (the module all three
// displays run) and the right side is the shim fed messages built exactly the
// way 4.6.0's DisplayCoordinator built them. Both are projected through
// `derive`, which mirrors what the controller actually consumes: applyRoster,
// applyOwnIdentity and routeToRoomState. Anything outside that projection
// (other players' rows) is unknowable over the legacy wire, and unread.

// =====================================================================
// The legacy wire, mirroring 4.6.0's DisplayCoordinator outbound builders
// =====================================================================

function takenColorSlots(room) {
  const out = [];
  for (const entry of room.players) out.push(entry[1].playerIndex);
  out.sort((a, b) => a - b);
  return out;
}

// 4.6.0 omitted the host fields entirely when the room had no host, rather than
// sending nulls (Optional.none as Any is a JSONSerialization footgun there).
function hostFields(room) {
  const rec = room.host != null ? room.players.get(room.host) : null;
  if (!rec) return {};
  return { hostName: rec.playerName, hostColorIndex: rec.playerIndex };
}

function isAlive(room, id) {
  const row = room.snapshot().players[id];
  return !row || row.alive !== false;
}

function welcome(room, id) {
  const rec = room.players.get(id);
  const inGame = room.state === 'playing' || room.state === 'countdown';
  const lateJoiner = inGame && !room.isParticipant(id);
  const msg = Object.assign({
    type: 'welcome',
    playerName: rec.playerName,
    colorIndex: rec.playerIndex,
    playerCount: room.size,
    roomState: room.state,
    startLevel: rec.startLevel || 1,
    isHost: id === room.host,
    takenColorIndices: takenColorSlots(room),
    displayMuted: room.muted,
  }, hostFields(room));
  // The late-joiner signal: alive and paused go only to a participant.
  if (!lateJoiner) {
    msg.alive = isAlive(room, id);
    msg.paused = room.paused;
  }
  if (room.state === 'results' && room.results) msg.results = room.results;
  return msg;
}

function lobbyUpdate(room, id) {
  const rec = room.players.get(id);
  return Object.assign({
    type: 'lobby_update',
    playerCount: room.size,
    startLevel: rec.startLevel || 1,
    isHost: id === room.host,
    colorIndex: rec.playerIndex,
    takenColorIndices: takenColorSlots(room),
  }, hostFields(room));
}

// =====================================================================
// What the controller reads out of a snapshot, whichever kind it is
// =====================================================================

function derive(snap, peerIndex) {
  const roster = snap.players;
  const ids = Object.keys(roster);
  const colors = ids
    .map((k) => roster[k].color)
    .filter((c) => typeof c === 'number')
    .sort((a, b) => a - b);
  const hostIdx = snap.hostPeerIndex;
  const hostEntry = hostIdx != null ? roster[hostIdx] : null;
  const mine = roster[peerIndex];

  // routeToRoomState, verbatim.
  const inGame = snap.roomState === 'playing' || snap.roomState === 'countdown';
  const participant = inGame && Array.isArray(snap.participants)
    && snap.participants.indexOf(peerIndex) >= 0;
  let screen = 'lobby';
  if (participant) screen = 'game';
  else if (snap.roomState === 'results' && snap.results) screen = 'gameover';

  return {
    screen: screen,
    waitingForNextGame: inGame && !participant,
    paused: !!snap.paused,
    displayMuted: snap.displayMuted,
    results: snap.results || null,
    // applyRoster
    playerCount: ids.length,
    takenColorIndices: colors,
    isHost: hostIdx != null && peerIndex === hostIdx,
    hostName: hostEntry ? hostEntry.name : null,
    hostColorIndex: hostEntry && hostEntry.color != null ? hostEntry.color : null,
    // applyOwnIdentity
    ownName: mine ? mine.name : null,
    ownColor: mine ? mine.color : null,
    ownStartLevel: mine && mine.startLevel != null ? mine.startLevel : 1,
    ownAlive: mine ? mine.alive !== false : null,
  };
}

// =====================================================================
// Harness: one shim per phone, fed the way the display would feed it
// =====================================================================

function newRoom() {
  return new RoomCore({
    maxPlayers: 8,
    rngSeed: 20260730,
    liveness: { timeoutMs: 3000, graceMs: 5000 },
  });
}

function makePhones() {
  const shims = new Map();
  return {
    of(id) {
      if (!shims.has(id)) shims.set(id, new LegacyDisplayRoom());
      return shims.get(id);
    },
    ids() { return Array.from(shims.keys()); },
    broadcast(msg) {
      for (const id of shims.keys()) shims.get(id).apply(msg);
    },
  };
}

// The display's own join handling: welcome to the joiner, then a lobby fanout
// while the room is idle (4.6.0 gated broadcastLobby on lobby/results).
function join(room, phones, id, hello, nowMs) {
  room.peerJoined(id, nowMs);
  room.hello(id, hello, nowMs);
  phones.of(id).apply(welcome(room, id));
  if (room.state === 'lobby' || room.state === 'results') fanoutLobby(room, phones);
}

function fanoutLobby(room, phones) {
  for (const id of room.players.keys()) {
    if (phones.ids().indexOf(id) >= 0) phones.of(id).apply(lobbyUpdate(room, id));
  }
}

// `skip` drops projection keys from the comparison. Its only use is the roster
// size mid-round: 4.6.0 fanned the lobby out in lobby/results only, so a phone
// that joins during a match is invisible to the others until it ends. That
// staleness shipped with 4.6.0 and is pinned on its own below rather than
// papered over here.
function assertAgrees(room, phones, ids, label, skip) {
  const real = room.snapshot();
  for (const id of ids) {
    const mine = derive(phones.of(id).snapshot(id), id);
    const theirs = derive(real, id);
    for (const key of skip || []) { delete mine[key]; delete theirs[key]; }
    assert.deepEqual(mine, theirs, `${label}: peer ${id} would render a different room`);
  }
}

// The projection keys the mid-round roster staleness above can move.
const ROSTER_KEYS = ['playerCount', 'takenColorIndices'];

// =====================================================================

describe('legacy display shim', () => {
  test('a full match agrees with the real snapshot at every step', () => {
    const room = newRoom();
    const phones = makePhones();

    // --- lobby: three phones join --------------------------------------
    join(room, phones, 1, { name: 'Ann' }, 1000);
    join(room, phones, 2, { name: 'Bo' }, 1100);
    join(room, phones, 3, { name: 'Cy', autoName: true }, 1200);
    assertAgrees(room, phones, [1, 2, 3], 'lobby');

    // --- a level pick, echoed only to the sender (sendLobbyUpdateTo) ----
    room.setLevel(2, 7);
    phones.of(2).apply(lobbyUpdate(room, 2));
    assertAgrees(room, phones, [1, 2, 3], 'after set_level');

    // --- a colour pick, echoed to the whole room ------------------------
    room.setColor(3, 4);
    fanoutLobby(room, phones);
    assertAgrees(room, phones, [1, 2, 3], 'after set_color');

    // --- countdown ------------------------------------------------------
    room.setParticipants([1, 2, 3]);
    room.freezeParticipantOrder();
    room.transitionTo('countdown');
    for (const value of [3, 2, 1]) {
      phones.broadcast({ type: 'countdown', value: value });
      assertAgrees(room, phones, [1, 2, 3], `countdown ${value}`);
    }

    // GO is where the pre-snapshot controller armed its input, half a beat
    // before the display's game_start. The shim goes live there too, so this
    // one instant is deliberately AHEAD of the room, not in step with it.
    phones.broadcast({ type: 'countdown', value: 'GO' });
    assert.equal(phones.of(1).snapshot(1).roomState, 'playing');
    assert.equal(room.state, 'countdown');

    // --- playing --------------------------------------------------------
    room.transitionTo('playing');
    phones.broadcast({ type: 'game_start' });
    assertAgrees(room, phones, [1, 2, 3], 'playing');

    // --- a phone arrives mid-round and sits it out -----------------------
    // No lobby fanout here: 4.6.0 skipped it outside lobby/results, which is
    // why only the joiner is compared. The other three keep a stale
    // playerCount until the round ends, exactly as they did when 4.6.0
    // shipped, and nothing renders it mid-game.
    room.peerJoined(4, 2000);
    room.hello(4, { name: 'Dee' }, 2000);
    phones.of(4).apply(welcome(room, 4));
    assertAgrees(room, phones, [4], 'late joiner');
    assert.equal(derive(phones.of(4).snapshot(4), 4).screen, 'lobby');
    assert.equal(derive(phones.of(4).snapshot(4), 4).waitingForNextGame, true);

    // game_start from the round they are sitting out must not pull them in.
    phones.of(4).apply({ type: 'game_start' });
    assert.equal(derive(phones.of(4).snapshot(4), 4).screen, 'lobby');

    // The staleness that costs, stated outright: the three phones already in
    // the match still count three players until the round ends. Nothing on
    // their screens shows a count while playing, and the return-to-lobby
    // fanout below settles it.
    assert.equal(derive(phones.of(1).snapshot(1), 1).playerCount, 3);
    assert.equal(derive(room.snapshot(), 1).playerCount, 4);

    // --- a KO -----------------------------------------------------------
    room.setAlive(2, false);
    phones.of(2).apply({ type: 'player_state', alive: false });
    assertAgrees(room, phones, [1, 2, 3], 'after KO', ROSTER_KEYS);
    assert.equal(derive(phones.of(2).snapshot(2), 2).ownAlive, false);
    assert.equal(derive(phones.of(2).snapshot(2), 2).screen, 'game');

    // --- host pauses ----------------------------------------------------
    room.pause('manual');
    phones.broadcast({ type: 'game_paused' });
    assertAgrees(room, phones, [1, 2, 3], 'paused', ROSTER_KEYS);

    room.resume('manual');
    phones.broadcast({ type: 'game_resumed' });
    assertAgrees(room, phones, [1, 2, 3], 'resumed', ROSTER_KEYS);

    // --- results --------------------------------------------------------
    const ranking = room.enrichResults([
      { playerId: 1, rank: 1, lines: 12, level: 3, alive: true },
      { playerId: 3, rank: 2, lines: 8, level: 2, alive: true },
      { playerId: 2, rank: 3, lines: 4, level: 1, alive: false },
    ]);
    room.setResults(ranking);
    room.transitionTo('results');
    phones.broadcast({ type: 'game_end', elapsed: 91234, results: ranking });
    assertAgrees(room, phones, [1, 2, 3, 4], 'results', ROSTER_KEYS);
    assert.equal(derive(phones.of(4).snapshot(4), 4).screen, 'gameover');

    // --- back to the lobby ----------------------------------------------
    room.admitWaiting();
    room.transitionTo('lobby');
    room.setResults(null);
    room.clearAlive();
    room.setParticipants([]);
    phones.broadcast({ type: 'return_to_lobby', playerCount: room.size });
    fanoutLobby(room, phones);
    assertAgrees(room, phones, [1, 2, 3, 4], 'return to lobby');

    // --- the display's mute toggle --------------------------------------
    room.setMuted(true);
    phones.broadcast({ type: 'display_muted', muted: true });
    assertAgrees(room, phones, [1, 2, 3, 4], 'muted');

    // --- the host leaves, host moves on ---------------------------------
    room.peerLeft(1);
    fanoutLobby(room, phones);
    assertAgrees(room, phones, [2, 3, 4], 'after host left');
    assert.equal(derive(phones.of(2).snapshot(2), 2).isHost, true);
    assert.equal(derive(phones.of(3).snapshot(3), 3).hostName, 'Bo');
  });

  test('a rejoin mid-game resyncs off the welcome alone', () => {
    const room = newRoom();
    const phones = makePhones();
    join(room, phones, 1, { name: 'Ann' }, 1000);
    join(room, phones, 2, { name: 'Bo' }, 1000);
    room.setLevel(2, 5);
    room.setParticipants([1, 2]);
    room.freezeParticipantOrder();
    room.transitionTo('countdown');
    room.transitionTo('playing');
    room.setAlive(2, false);
    room.pause('manual');

    // A phone that was never in this session at all (page reload mid-match)
    // gets one welcome and must land on the right screen, KO and pause
    // included.
    const fresh = new LegacyDisplayRoom();
    fresh.apply(welcome(room, 2));
    const got = derive(fresh.snapshot(2), 2);
    assert.deepEqual(got, derive(room.snapshot(), 2));
    assert.equal(got.screen, 'game');
    assert.equal(got.ownAlive, false);
    assert.equal(got.paused, true);
    assert.equal(got.ownStartLevel, 5);
  });

  test('the synthetic roster carries the count and the taken colours', () => {
    const room = newRoom();
    const phones = makePhones();
    join(room, phones, 1, { name: 'Ann', colorIndex: 6 }, 1000);
    join(room, phones, 2, { name: 'Bo', colorIndex: 2 }, 1000);
    join(room, phones, 3, { name: 'Cy', colorIndex: 5 }, 1000);

    const snap = phones.of(3).snapshot(3);
    assert.equal(Object.keys(snap.players).length, 3);
    assert.deepEqual(derive(snap, 3).takenColorIndices, takenColorSlots(room));
    // Rows for the seats we can't see carry a colour and nothing else: no
    // invented names can reach the UI through them.
    for (const key of Object.keys(snap.players)) {
      if (key === '3' || key === 'host') continue;
      assert.deepEqual(Object.keys(snap.players[key]), ['color']);
    }
    // The host is somebody else, so their row hangs off a key that cannot
    // collide with a peer index.
    assert.equal(snap.hostPeerIndex, 'host');
    assert.equal(snap.players.host.name, 'Ann');
  });

  test('results ride the snapshot only while the room is showing them', () => {
    const shim = new LegacyDisplayRoom();
    shim.apply({ type: 'welcome', playerName: 'Ann', colorIndex: 0, roomState: 'lobby', playerCount: 1, isHost: true, takenColorIndices: [0], displayMuted: false, alive: true, paused: false });
    shim.apply({ type: 'game_end', results: [{ playerId: 1, rank: 1 }] });
    assert.equal(shim.snapshot(1).results.length, 1);
    shim.apply({ type: 'return_to_lobby', playerCount: 1 });
    assert.equal(shim.snapshot(1).results, undefined);
  });

  describe('what it declines to act on', () => {
    test('legacy traffic before the first welcome is ignored', () => {
      const shim = new LegacyDisplayRoom();
      for (const type of ['lobby_update', 'countdown', 'game_start', 'game_end',
        'game_paused', 'game_resumed', 'display_muted', 'return_to_lobby',
        'game_over', 'player_state']) {
        assert.equal(shim.apply({ type: type, alive: false }), null, type);
      }
      assert.equal(shim.active, false);
    });

    test('snapshot-era traffic is left to the normal dispatcher', () => {
      const shim = new LegacyDisplayRoom();
      shim.apply({ type: 'welcome', playerName: 'Ann', colorIndex: 0, roomState: 'lobby', playerCount: 1, isHost: true, takenColorIndices: [0], displayMuted: false, alive: true, paused: false });
      assert.equal(shim.apply({ type: 'pong', t: 1 }), null);
      assert.equal(shim.apply({ type: 'error', message: 'Room is full' }), null);
      assert.equal(shim.apply(null), null);
    });

    test('a player_state republishes only on the KO, and never exclusively', () => {
      const shim = new LegacyDisplayRoom();
      shim.apply({ type: 'welcome', playerName: 'Ann', colorIndex: 0, roomState: 'playing', playerCount: 1, isHost: true, takenColorIndices: [0], displayMuted: false, alive: true, paused: false });
      // Line-clear telemetry changes nothing about the room.
      assert.equal(shim.apply({ type: 'player_state', level: 2, lines: 4, alive: true }), null);
      // The KO does, and onPlayerState still has to see it for the audio.
      assert.equal(shim.apply({ type: 'player_state', alive: false }), LegacyDisplayRoom.SHARED);
      assert.equal(shim.apply({ type: 'player_state', alive: false }), null);
    });
  });
});
