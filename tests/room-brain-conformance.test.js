'use strict';

// RoomBrain conformance: Node leg.
//
// The same op log runs three times against the same module — here in Node, in
// JavaScriptCore on tvOS (RoomBrainConformanceTests.swift), and in QuickJS on
// Android TV (RoomBrainConformanceTest.kt) — and every step's return value and
// resulting snapshot must match tests/fixtures/room-brain-golden.json exactly.
//
// This leg has two jobs. It proves the golden still describes the module (so a
// behaviour change has to be an explicit regeneration, reviewed in the diff),
// and it proves the golden is reachable and well-formed for the two native legs
// that cannot run Node.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RoomBrain } = require('../server/RoomBrain.js');
const { INIT, OPS } = require('./fixtures/room-brain-ops.js');
const { replay } = require('../scripts/gen-room-brain-golden.js');

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'room-brain-golden.json');

describe('RoomBrain conformance', () => {
  test('the checked-in golden is present and matches the op log', () => {
    assert.ok(
      fs.existsSync(GOLDEN_PATH),
      'tests/fixtures/room-brain-golden.json is missing — run `npm run build:golden`'
    );
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    assert.deepEqual(golden.init, INIT, 'golden init options are stale');
    assert.deepEqual(golden.ops, JSON.parse(JSON.stringify(OPS)), 'golden op log is stale');
  });

  test('replaying the op log reproduces the golden step for step', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    const actual = replay();
    assert.equal(actual.length, golden.steps.length);
    for (let i = 0; i < actual.length; i++) {
      const label = OPS[i].g !== undefined
        ? `step ${i} (get ${OPS[i].g})`
        : `step ${i} (${OPS[i].m})`;
      assert.deepEqual(actual[i].result, golden.steps[i].result, `${label}: return value`);
      assert.deepEqual(actual[i].snapshot, golden.steps[i].snapshot, `${label}: snapshot`);
    }
  });

  test('the seeded rng makes auto-naming reproducible', () => {
    // Auto-naming is deliberately random, and was one of the behaviours that
    // had silently diverged across the three platforms. It has to be IN the
    // conformance log, so it has to be seedable across a JSON-only bridge.
    const names = () => {
      const b = new RoomBrain(INIT);
      b.peerJoined(1, 0); b.peerJoined(2, 0); b.peerJoined(3, 0);
      return [1, 2, 3].map((i) => b.get(i).playerName);
    };
    assert.deepEqual(names(), names());
    assert.ok(names().every((n) => /^HX-([1-9][0-9]?)$/.test(n)), 'auto names are HX-<n>');
    assert.equal(new Set(names()).size, 3, 'auto names are room-unique');
  });

  test('the blocklist is honoured on every platform, because there is only one', () => {
    // tvOS used to name players "HX-(slot + 1)" with no blocklist at all, so a
    // real Apple TV room could seat HX-4 and HX-13. The whole point of a shared
    // module is that this cannot be true on one platform and false on another.
    assert.deepEqual(RoomBrain.AUTO_NAME_BLOCKLIST, [4, 13, 17, 69]);
    const b = new RoomBrain({ rngSeed: 1 });
    for (let i = 0; i < 200; i++) {
      const name = b.generateAutoName(null);
      const num = Number(name.slice(3));
      assert.ok(!RoomBrain.AUTO_NAME_BLOCKLIST.includes(num), `generated a blocklisted ${name}`);
    }
  });
});
