#!/usr/bin/env node
'use strict';

// Generate the cross-platform RoomCore golden.
//
// Replays tests/fixtures/room-core-ops.js against the real module and writes a
// SELF-CONTAINED JSON artifact: the constructor options, the op log, and the
// expected return value + full snapshot after every step. Self-contained because
// the tvOS and Android conformance tests cannot `require` a JS fixture; they
// read this one file, replay the ops through their own bridge, and diff.
//
// Regenerate with `npm run build:golden` whenever RoomCore's behaviour changes
// ON PURPOSE, and review the diff: an unexpected line in it is the whole point
// of the gate.

const fs = require('fs');
const path = require('path');
const { RoomCore } = require('../server/RoomCore.js');
const { INIT, OPS } = require('../tests/fixtures/room-core-ops.js');

const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'room-core-golden.json');

/** Replay the op log, recording each step's return value and resulting snapshot. */
function replay() {
  const roomCore = new RoomCore(INIT);
  return OPS.map((step) => {
    let result;
    if (step.g !== undefined) {
      result = roomCore[step.g];
    } else {
      const fn = roomCore[step.m];
      if (typeof fn !== 'function') throw new Error(`RoomCore has no method ${step.m}`);
      result = fn.apply(roomCore, step.a || []);
    }
    return {
      // JSON round-trip so the recorded value matches exactly what a bridge
      // would hand back (undefined -> null, Map/Set would surface as {}).
      result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
      snapshot: roomCore.snapshot(),
    };
  });
}

const golden = { init: INIT, ops: OPS, steps: replay() };
fs.writeFileSync(OUT, JSON.stringify(golden, null, 2) + '\n');
console.log(`build: ${path.relative(path.join(__dirname, '..'), OUT)} (${golden.ops.length} ops)`);

module.exports = { replay };
