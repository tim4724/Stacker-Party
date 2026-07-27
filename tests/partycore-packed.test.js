'use strict';

// Packed native wire format (PartyCore.packFrame / unpackFrame).
//
// The format exists because the JS<->native boundary, not the simulation, is what
// costs a frame: at eight boards the physics is ~0.5ms while JSON.stringify plus
// the native decode is ~11ms. See the packing notes in server/PartyCore.js.
//
// unpackFrame is the REFERENCE decoder — the Kotlin (PackedFrame.kt) and Swift
// (PackedFrame.swift) readers are ports of it. This file gates the JS pair against
// each other over a driven corpus; the native ports are gated against the fixture
// this writes (tests/fixtures/partycore-packed-golden.json).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PartyCore } = require('../server/PartyCore');

const FIXTURE = path.join(__dirname, 'fixtures', 'partycore-packed-golden.json');

// `elapsed` crosses at whole-ms precision by design (its only readers floor it to
// seconds), so normalise it before comparing. Everything else must be exact.
function normalize(frame) {
  const c = JSON.parse(JSON.stringify(frame));
  if (c.snapshot) c.snapshot.elapsed = Math.floor(c.snapshot.elapsed);
  else delete c.snapshot;
  return c;
}

function decoded(packed) {
  const back = JSON.parse(JSON.stringify(PartyCore.unpackFrame(packed)));
  if (back.snapshot === null) delete back.snapshot;
  return back;
}

/** Drive a match hard enough to reach locks, line clears and KOs. */
function driveMatch(players, frames, onFrame) {
  const roster = new Map();
  for (let i = 1; i <= players; i++) roster.set(i, { startLevel: 1 });
  const core = new PartyCore(roster, 0xC0FFEE);
  core.init();
  let t = 0;
  for (let i = 0; i < frames; i++) {
    t += 16.667;
    const pid = 1 + (i % players);
    // Stack fast: hard-drop most frames, shuffling columns so rows actually fill.
    if (i % 3 === 0) core.processInput(pid, ['left', 'right', 'rotate_cw'][i % 3]);
    if (i % 4 === 0) core.processInput(pid, 'hard_drop');
    if (i % 97 === 0) core.processInput(pid, 'hold');
    onFrame(core.deliverFrame(t), i);
  }
}

test('pack -> unpack round-trips every delivered frame', () => {
  const seen = { grids: 0, clearing: 0, hold: 0, events: 0, omitted: 0, ghost: 0 };
  for (const players of [1, 2, 8]) {
    driveMatch(players, 1200, (frame, i) => {
      const packed = PartyCore.packFrame(frame);
      assert.deepStrictEqual(decoded(packed), normalize(frame),
        players + 'p: packed frame ' + i + ' did not survive the round trip');
      if (!frame.snapshot) { seen.omitted++; return; }
      if (frame.events.length) seen.events++;
      for (const p of frame.snapshot.players) {
        if (p.grid) seen.grids++;
        if (p.clearingCells) seen.clearing++;
        if (p.holdPiece) seen.hold++;
        if (p.ghost) seen.ghost++;
      }
    });
  }
  // A round-trip test that never exercised a branch proves nothing about it.
  assert.ok(seen.grids > 0, 'corpus never carried a grid');
  assert.ok(seen.hold > 0, 'corpus never carried a hold piece');
  assert.ok(seen.ghost > 0, 'corpus never carried a ghost');
  assert.ok(seen.events > 0, 'corpus never carried events');
  assert.ok(seen.omitted > 0, 'corpus never omitted a render-identical snapshot');
});

// The driven corpus above reaches whatever the engine happens to emit, which does
// not include every SHAPE the format has to carry. These are built by hand so each
// branch — absent piece, absent ghost, clearing cells, empty queues, values past
// the split (and exactly on its NUL boundary) — is exercised deliberately rather
// than by luck.
function player(over) {
  return Object.assign({
    id: 3,
    grid: Array.from({ length: 15 }, (_, r) => Array.from({ length: 9 }, (_, c) => (r + c) % 7)),
    currentPiece: {
      type: 'T3', typeId: 3, anchorCol: 4, anchorRow: -3,
      cells: [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }],
      blocks: [[4, -3], [5, -3], [4, -2]]
    },
    ghost: { typeId: 3, anchorCol: 4, anchorRow: 11, blocks: [[4, 11], [5, 11], [4, 12]] },
    holdPiece: 'b',
    nextPieces: ['o', 'd', 'I3'],
    level: 7,
    lines: 42,
    alive: true,
    pendingGarbage: 3,
    clearingCells: null,
    gridVersion: 9
  }, over);
}

const EDGE_CASES = {
  'clearing cells present': player({ clearingCells: [[0, 14], [1, 14], [8, 13]] }),
  'no current piece (mid clear)': player({ currentPiece: null, ghost: null }),
  'no ghost': player({ ghost: null }),
  'ghost with null typeId': player({ ghost: { typeId: null, anchorCol: 0, anchorRow: 0, blocks: [] } }),
  'no hold piece': player({ holdPiece: null }),
  'empty next queue': player({ nextPieces: [] }),
  'dead player': player({ alive: false }),
  'grid stripped': (() => { const p = player({}); delete p.grid; return p; })(),
  'values past the split': player({ lines: 70000, gridVersion: 131073 }),
  // 0xffff is the value the +1 bias turns back into a NUL (fromCharCode takes its
  // argument mod 0x10000), so every split field is pinned at exactly that boundary
  // and on both sides of it. This is why halves are 15 bits, not 16.
  'split halves land exactly on 0xffff': player({ lines: 0xffff, gridVersion: 0xffff }),
  'split halves either side of 0xffff': player({ lines: 0xfffe, gridVersion: 0x10000 }),
  'negative coordinates throughout': player({
    currentPiece: {
      type: 'I3', typeId: 1, anchorCol: 0, anchorRow: -4,
      cells: [{ q: -1, r: -1 }, { q: 0, r: -1 }, { q: 1, r: -1 }],
      blocks: [[0, -4], [1, -4], [2, -4]]
    },
    ghost: { typeId: 1, anchorCol: 0, anchorRow: -1, blocks: [[0, -1]] },
    clearingCells: [[0, -2]]
  })
};

test('every snapshot shape survives the round trip', () => {
  for (const [name, p] of Object.entries(EDGE_CASES)) {
    const frame = { events: [], snapshot: { players: [p], elapsed: 1234 }, commands: [] };
    const packed = PartyCore.packFrame(frame);
    assert.equal(packed.indexOf('\u0000'), -1, name + ': packed a NUL');
    assert.deepStrictEqual(decoded(packed), normalize(frame), name + ': round trip drifted');
  }
});

test('several seats in one frame keep their order and identity', () => {
  const players = [player({ id: 0 }), player({ id: 5, alive: false }), player({ id: 7, holdPiece: null })];
  const frame = { events: [], snapshot: { players, elapsed: 999999 }, commands: [] };
  assert.deepStrictEqual(decoded(PartyCore.packFrame(frame)), normalize(frame));
});

test('payload never contains a NUL, at any board state', () => {
  // Both native bridges marshal JS strings as C strings, so one NUL truncates the
  // frame — and 0 is the most common raw value in this data (every empty cell).
  // This is the invariant the +1 bias exists for.
  for (const players of [1, 8]) {
    driveMatch(players, 900, (frame, i) => {
      const packed = PartyCore.packFrame(frame);
      assert.equal(packed.indexOf('\u0000'), -1,
        players + 'p: frame ' + i + ' packed a NUL, which truncates on both bridges');
    });
  }
});

// `elapsed` is the split field a real match actually drives through the danger
// zone: its low half lands on 0xffff at 65.535s, and again every 65.536s after.
// With 16-bit halves that packed a NUL and truncated the frame on both TVs, which
// ~18% of four-minute matches would have hit at least once.
test('a match crossing every elapsed boundary never packs a NUL', () => {
  const CYCLE = 0x10000;
  for (let cycle = 1; cycle <= 4; cycle++) {
    // Straddle the boundary at ms resolution rather than trusting a 60Hz lattice
    // to land on it — real frame deltas jitter, so eventually one does.
    for (let e = cycle * CYCLE - 3; e <= cycle * CYCLE + 3; e++) {
      const frame = { events: [], snapshot: { players: [player({})], elapsed: e }, commands: [] };
      const packed = PartyCore.packFrame(frame);
      assert.equal(packed.indexOf('\u0000'), -1, 'elapsed=' + e + ' packed a NUL');
      assert.equal(PartyCore.unpackFrame(packed).snapshot.elapsed, e,
        'elapsed=' + e + ' did not survive the round trip');
    }
  }
});

// The guard is the durable half of the fix: 15-bit halves keep today's fields in
// range, and this makes a future field that outgrows it fail here rather than
// silently corrupt a frame on a TV, where fromCharCode's mod 0x10000 would hide it.
test('a value outside the wire range is refused, not silently wrapped', () => {
  const frame = { events: [], snapshot: { players: [player({ level: 0x10000 })], elapsed: 0 }, commands: [] };
  assert.throws(() => PartyCore.packFrame(frame), /outside wire range/);
  const negative = { events: [], snapshot: { players: [player({ level: -1 })], elapsed: 0 }, commands: [] };
  assert.throws(() => PartyCore.packFrame(negative), /outside wire range/);
  // A split field is checked before it is masked: masking an oversized value would
  // produce two legal-looking halves that sail past the range guard above and decode
  // as a different number.
  const wide = { events: [], snapshot: { players: [player({ lines: 2 ** 30 })], elapsed: 0 }, commands: [] };
  assert.throws(() => PartyCore.packFrame(wide), /outside split range/);
});

test('packed frames are substantially smaller than JSON', () => {
  let packedTotal = 0;
  let jsonTotal = 0;
  driveMatch(8, 600, (frame) => {
    packedTotal += PartyCore.packFrame(frame).length;
    jsonTotal += JSON.stringify(frame).length;
  });
  assert.ok(packedTotal * 2 < jsonTotal,
    'expected packed to be well under half of JSON, got packed=' + packedTotal + ' json=' + jsonTotal);
});

test('a foreign layout version is rejected, not misread', () => {
  const bumped = String.fromCharCode(99) + PartyCore.packFrame({ events: [], commands: [] }).slice(1);
  assert.throws(() => PartyCore.unpackFrame(bumped), /version/);
});

test('an omitted snapshot round-trips as no snapshot at all', () => {
  const packed = PartyCore.packFrame({ events: [], commands: [] });
  const back = PartyCore.unpackFrame(packed);
  assert.equal(back.snapshot, null);
  assert.deepStrictEqual(back.events, []);
  assert.deepStrictEqual(back.commands, []);
});

test('events and commands survive verbatim alongside a packed snapshot', () => {
  let checked = 0;
  driveMatch(4, 900, (frame) => {
    if (!frame.events.length && !frame.commands.length) return;
    const back = PartyCore.unpackFrame(PartyCore.packFrame(frame));
    assert.deepStrictEqual(back.events, frame.events);
    assert.deepStrictEqual(back.commands, frame.commands);
    checked++;
  });
  assert.ok(checked > 0, 'no frame in the corpus carried events or commands');
});

// The fixture the native readers are gated against: a fixed corpus of packed
// payloads plus the frames they must decode to. Re-record after an INTENTIONAL
// layout change (and bump PACK_VERSION):
//   RECORD_PACKED_GOLDEN=1 node --test tests/partycore-packed.test.js
function recordGolden() {
  const steps = [];
  driveMatch(4, 400, (frame, i) => {
    if (i % 8 !== 0) return; // sample, so the fixture stays reviewable
    steps.push({ packed: PartyCore.packFrame(frame), frame: normalize(frame) });
  });
  // A driven match never reaches a split value whose HIGH half is non-zero (a few
  // seconds of elapsed, single-digit gridVersions), and with a zero high half every
  // shift width decodes identically — a port using 16-bit halves replayed the
  // driven corpus byte-for-byte. These steps are what make the fixture able to tell
  // the ports apart at all, so they pin the split explicitly, including the 0xffff
  // boundary the +1 bias turns back into a NUL.
  var SPLIT_PROBES = [
    { elapsed: 100000, over: { lines: 70000, gridVersion: 131073 } },
    { elapsed: 65535, over: { lines: 0xffff, gridVersion: 0xffff } },
    { elapsed: 1073741823, over: { lines: 0xfffe, gridVersion: 0x10000 } },
  ];
  for (const probe of SPLIT_PROBES) {
    const frame = {
      events: [],
      snapshot: { players: [player(probe.over)], elapsed: probe.elapsed },
      commands: []
    };
    steps.push({ packed: PartyCore.packFrame(frame), frame: normalize(frame) });
  }
  return { version: 2, steps };
}

if (process.env.RECORD_PACKED_GOLDEN === '1') {
  fs.writeFileSync(FIXTURE, JSON.stringify(recordGolden(), null, 2) + '\n');
  console.log('[packed-golden] recorded', recordGolden().steps.length, 'steps to', FIXTURE);
}

test('packed golden replays exactly (the fixture the native readers are gated on)', () => {
  assert.ok(fs.existsSync(FIXTURE),
    'fixture missing — record it with RECORD_PACKED_GOLDEN=1 node --test tests/partycore-packed.test.js');
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const actual = recordGolden();
  assert.equal(actual.steps.length, expected.steps.length, 'step count drifted');
  for (let i = 0; i < expected.steps.length; i++) {
    assert.equal(actual.steps[i].packed, expected.steps[i].packed, 'packed payload drifted at step ' + i);
    assert.deepStrictEqual(actual.steps[i].frame, expected.steps[i].frame, 'frame drifted at step ' + i);
  }
});
