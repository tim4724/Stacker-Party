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
      // Args are deep-copied, not passed through: OPS is a shared fixture and some
      // mutators write to their argument (enrichResults labels the ranking rows it
      // is handed). Passing the live objects let a replay REWRITE the op log it was
      // replaying, so the recorder serialized ops that no longer matched the
      // fixture on disk and a second replay in the same process started from
      // already-enriched rows. Copying also matches how a native bridge delivers
      // args, which is JSON, i.e. always a copy.
      result = fn.apply(roomCore, JSON.parse(JSON.stringify(step.a || [])));
    }
    return {
      // JSON round-trip so the recorded value matches exactly what a bridge
      // would hand back (undefined -> null, Map/Set would surface as {}).
      result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
      // Round-tripped for the same reason as `result` above, plus one of its own:
      // snapshot() hands back `results` as a LIVE reference to the stored ranking
      // (unlike `participants`, which it slices), and enrichResults relabels those
      // row objects in place. Recording the reference made all 105 steps share one
      // array, so every step serialized the FINAL ranking and no step's results
      // could ever disagree with another's, leaving the field unfalsifiable.
      snapshot: JSON.parse(JSON.stringify(roomCore.snapshot())),
    };
  });
}

// ONLY when run as `npm run build:golden`. The conformance test imports replay()
// from here, so writing at module load meant the test rewrote the fixture it was
// about to assert against: the recorded steps were re-derived from whatever the
// code did that instant, `replay()` then matched them by construction, and the
// JS half of the gate could not fail. A behaviour change showed up as a dirty
// fixture in `git status` and nothing else. Regenerating stays deliberate.
if (require.main === module) {
  const golden = { init: INIT, ops: OPS, steps: replay() };
  fs.writeFileSync(OUT, JSON.stringify(golden, null, 2) + '\n');
  console.log(`build: ${path.relative(path.join(__dirname, '..'), OUT)} (${golden.ops.length} ops)`);
}

module.exports = { replay };
