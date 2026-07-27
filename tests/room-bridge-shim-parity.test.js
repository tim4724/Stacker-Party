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
const vm = require('node:vm');
const esbuild = require('esbuild');
const { coreOptions } = require('../scripts/build.js');

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

// Both shims are JS embedded in Swift/Kotlin string literals, so nothing on
// either platform type-checks them: a typo only shows up when a real device
// runs the room API. Pull each one out, run it on top of the real bundle in a
// bare VM (no require/window/DOM/timers, like JavaScriptCore and QuickJS), and
// drive the room through it exactly as the shells will.
function extractShim(src, open, close) {
  const start = src.indexOf(open);
  assert.ok(start >= 0, `shim opening marker not found: ${open}`);
  const from = start + open.length;
  const end = src.indexOf(close, from);
  assert.ok(end >= 0, 'shim closing marker not found');
  return src.slice(from, end);
}

const SHIMS = {
  tvOS: () => extractShim(SWIFT, 'private static let bootstrapJS = """\n', '\n    """'),
  Android: () => {
    // Kotlin uses trimIndent() at runtime; the leading indentation is uniform,
    // so stripping it here reproduces what QuickJS actually evaluates.
    const raw = extractShim(KOTLIN, 'val SHIM: String = """\n', '\n    """.trimIndent()');
    return raw.replace(/^ {4}/gm, '');
  },
};

// Bundle in memory with the SAME options build.js ships, so this gate needs no
// prior `npm run build` (dist/ is gitignored and CI's unit job does not build)
// and can never drift from the artifact the TVs actually load.
async function bundleCore() {
  const result = await esbuild.build(coreOptions({ write: false }));
  return result.outputFiles[0].text;
}

for (const [platform, getShim] of Object.entries(SHIMS)) {
  test(`the ${platform} shim's room API works against the real bundle in a bare VM`, async () => {
    const ctx = vm.createContext({});
    vm.runInContext(await bundleCore(), ctx);
    vm.runInContext(getShim(), ctx);

    const call = (js) => JSON.parse(vm.runInContext(js, ctx));

    // Reading before roomInit must fail loudly rather than return an empty room:
    // a shell that publishes a blank snapshot looks like an emptied lobby to
    // every controller, which is worse than an error in the log.
    assert.throws(() => vm.runInContext('Bridge.roomSnapshotJSON()', ctx), /roomInit/);

    vm.runInContext('Bridge.roomInit(JSON.stringify({ rngSeed: 3 }))', ctx);

    assert.deepEqual(
      call('Bridge.roomCall("peerJoined", JSON.stringify([1, 1000]))'),
      { added: true, colorIndex: 0, joinedLobby: true, publish: 'now' }
    );
    call('Bridge.roomCall("hello", JSON.stringify([1, { name: "Ann", colorIndex: 4 }, 1100]))');
    assert.equal(
      call('Bridge.roomCall("setLevel", JSON.stringify([1, 9]))').publish,
      'soon',
      'the throttle hint has to survive the bridge, or the natives publish on every tap'
    );

    const snap = call('Bridge.roomSnapshotJSON()');
    assert.equal(snap.players['1'].name, 'Ann');
    assert.equal(snap.players['1'].color, 4);
    assert.equal(snap.players['1'].startLevel, 9);
    assert.equal(call('Bridge.roomGet("host")'), 1);
    assert.equal(call('Bridge.roomGet("state")'), 'lobby');

    // A void method must marshal as null, not undefined: Android decodes the
    // completion value and `undefined` has no JSON representation.
    assert.equal(call('Bridge.roomCall("setResults", JSON.stringify([null]))'), null);

    // A name carrying a quote, a backslash and a control character has to
    // survive the round trip. On Android this string is spliced into evaluated
    // SOURCE, which is what jsString() exists to make safe.
    const nasty = 'a"b\\cd';
    vm.runInContext(
      `Bridge.roomCall("setName", ${JSON.stringify(JSON.stringify([1, nasty]))})`, ctx);
    assert.equal(call('Bridge.roomSnapshotJSON()').players['1'].name, 'a"b\\cd',
      'control char stripped, quote and backslash preserved');

    assert.throws(() => vm.runInContext('Bridge.roomCall("noSuchMethod", "[]")', ctx), /no method/);
  });
}

test('the shim reaches RoomCore through the bundle global, which the bundle exports', () => {
  // If core-entry.js ever stops exporting RoomCore, both shells break at
  // roomInit with a TypeError that only shows up on a real device.
  assert.ok(
    /HexCore\.RoomCore/.test(block(SWIFT, 'ROOM-API', 'EngineBridge.swift')),
    'the shim no longer constructs HexCore.RoomCore'
  );
  assert.ok(
    /exports\.RoomCore\s*=/.test(fs.readFileSync(path.join(ROOT, 'server/core-entry.js'), 'utf8')),
    'core-entry.js no longer exports RoomCore'
  );
});
