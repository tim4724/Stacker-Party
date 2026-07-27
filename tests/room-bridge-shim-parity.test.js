'use strict';

// The two native JS shims must expose an IDENTICAL room API.
//
// tvOS (EngineBridge.swift `bootstrapJS`) and Android TV (EngineBootstrap.kt
// `SHIM`) each embed a hand-written JS shim that flattens `HexCore.*` into a
// JSON-in/JSON-out method table. The engine halves of those two shims have
// already drifted from each other in production (Android grew a scene-signature
// fast path and read guards; tvOS grew `update`, `rekeyPlayer` and the gallery
// accessors) and nothing caught it, because each platform only ever tests its
// own copy.
//
// The room half must not go the same way: it is the surface through which both
// displays reach the single source of truth, so an accessor added to one shim
// and forgotten in the other would silently pass every existing test and leave
// one TV publishing a snapshot the other cannot. This gate reads both files and
// asserts the marked blocks are token-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const SWIFT = fs.readFileSync(
  path.join(ROOT, 'appletv/Sources/HexStackerKit/Engine/EngineBridge.swift'), 'utf8');
const KOTLIN = fs.readFileSync(
  path.join(ROOT, 'android/core/src/commonMain/kotlin/com/hexstacker/core/engine/EngineBootstrap.kt'), 'utf8');

// Pull the text between `// <name>-BEGIN` and `// <name>-END`.
function block(src, name, label) {
  const re = new RegExp(`// ${name}-BEGIN([\\s\\S]*?)// ${name}-END`);
  const m = src.match(re);
  assert.ok(m, `${label}: ${name} markers not found — did the shim get reformatted?`);
  return m[1];
}

// Strip line comments and ALL whitespace so indentation and reflowed comments
// never trip the gate, and drop a trailing comma: the tvOS block is followed by
// the gallery accessors and so needs one, the Android block ends the table.
function normalize(text) {
  return text.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '').replace(/,$/, '');
}

for (const name of ['ROOM-SHIM', 'ROOM-API']) {
  test(`${name} is identical in the tvOS and Android shims`, () => {
    assert.equal(
      normalize(block(SWIFT, name, 'EngineBridge.swift')),
      normalize(block(KOTLIN, name, 'EngineBootstrap.kt')),
      `${name} has drifted between the two native shims`
    );
  });
}

test('the room API exposes exactly the four entry points both shells rely on', () => {
  const api = block(SWIFT, 'ROOM-API', 'EngineBridge.swift');
  for (const method of ['roomInit', 'roomCall', 'roomGet', 'roomSnapshotJSON']) {
    assert.ok(new RegExp(`\\b${method}:\\s*function`).test(api), `missing ${method}`);
  }
});

test('the shim reaches RoomBrain through the bundle global, which the bundle exports', () => {
  // If core-entry.js ever stops exporting RoomBrain, both shells break at
  // roomInit with a TypeError that only shows up on a real device.
  assert.ok(
    /HexCore\.RoomBrain/.test(block(SWIFT, 'ROOM-API', 'EngineBridge.swift')),
    'the shim no longer constructs HexCore.RoomBrain'
  );
  assert.ok(
    /exports\.RoomBrain\s*=/.test(fs.readFileSync(path.join(ROOT, 'server/core-entry.js'), 'utf8')),
    'core-entry.js no longer exports RoomBrain'
  );
});
