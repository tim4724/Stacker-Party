'use strict';

// The two native JS shims must be IDENTICAL.
//
// tvOS (EngineBridge.swift `bootstrapJS`) and Android TV (EngineBootstrap.kt
// `SHIM`) each embed a hand-written JS shim that flattens `HexCore.*` into a
// JSON-in/JSON-out method table. Only the ROOM half used to be gated, and the
// engine halves duly drifted in production: Android grew a scene-signature fast
// path (skip delivering a render-identical frame) that tvOS never got, so one TV
// re-serialized and re-decoded a full snapshot 60 times a second for frames that
// painted the same picture. Nothing caught it, because each platform only ever
// tested its own copy.
//
// The fix was twofold: that logic now lives in server/PartyCore.js
// (deliverFrame/deliverSnapshot), where all hosts share it, and what remains
// here is marshalling that this gate holds token-identical end to end. Methods
// OUTSIDE the marked blocks are platform-only and must be declared in
// PLATFORM_ONLY below, so adding one is a deliberate, reviewed act.

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
// never trip the gate, and drop a trailing comma: a block followed by more
// entries needs one, a block that ends the table doesn't.
function normalize(text) {
  return text.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '').replace(/,$/, '');
}

// Shim entries neither platform shares. Everything else must sit inside a marked
// block, identical on both sides.
const PLATFORM_ONLY = {
  // `update` is the granular tick EngineBridgeTests drives; the gallery
  // accessors feed the tvOS HEXSHOT states. Android reaches the same fixtures
  // through its own QuickJS context in the screenshot tests, and drives the
  // engine only through frameJSON.
  tvOS: ['update', 'galleryRosterJSON', 'galleryJoinJSON', 'gallerySnapshotJSON',
    'galleryResultsJSON', 'galleryAmbientJSON'],
  Android: [],
};

for (const name of ['ENGINE-SHIM', 'ENGINE-API', 'ROOM-API', 'PAD-API']) {
  test(`${name} is identical in the tvOS and Android shims`, () => {
    assert.equal(
      normalize(block(SWIFT, name, 'EngineBridge.swift')),
      normalize(block(KOTLIN, name, 'EngineBootstrap.kt')),
      `${name} has drifted between the two native shims`
    );
  });
}

test('the shared blocks expose the entry points both shells rely on', () => {
  const has = (src, method) => new RegExp(`\\b${method}:\\s*function`).test(src);
  const engine = block(SWIFT, 'ENGINE-API', 'EngineBridge.swift');
  for (const method of ['create', 'processInput', 'softDropStart', 'softDropEnd',
    'pause', 'resume', 'resetFrameClock', 'rekeyPlayer', 'snapshotPacked',
    'processInputs', 'snapshotPlayerPacked', 'drainEventsJSON', 'framePacked',
    'isEnded']) {
    assert.ok(has(engine, method), `missing ${method}`);
  }
  const room = block(SWIFT, 'ROOM-API', 'EngineBridge.swift');
  for (const method of ['roomInit', 'roomCall', 'roomGet', 'roomSnapshotJSON']) {
    assert.ok(has(room, method), `missing ${method}`);
  }
});

test('every shim method is either shared or a declared platform-only one', () => {
  // The table entries: `<name>: function` at the start of a line. Anything a
  // shim exposes that isn't in a shared block is drift unless it's declared.
  const methods = (src) => [...src.matchAll(/^\s+(\w+): function/gm)].map((m) => m[1]);
  const shared = new Set(
    ['ENGINE-API', 'ROOM-API', 'PAD-API'].flatMap((n) => methods(block(SWIFT, n, 'EngineBridge.swift'))));
  for (const [platform, getShim] of Object.entries(SHIMS)) {
    const extra = methods(getShim()).filter((m) => !shared.has(m));
    assert.deepEqual(extra.sort(), [...PLATFORM_ONLY[platform]].sort(),
      `${platform}: undeclared platform-only shim methods — move them into a shared `
      + 'block, or add them to PLATFORM_ONLY with the reason they can differ');
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
    const nasty = 'a"b\\c\x07d';
    vm.runInContext(
      `Bridge.roomCall("setName", ${JSON.stringify(JSON.stringify([1, nasty]))})`, ctx);
    assert.equal(call('Bridge.roomSnapshotJSON()').players['1'].name, 'a"b\\cd',
      'control char stripped, quote and backslash preserved');

    assert.throws(() => vm.runInContext('Bridge.roomCall("noSuchMethod", "[]")', ctx), /no method/);
  });
}

for (const [platform, getShim] of Object.entries(SHIMS)) {
  test(`the ${platform} shim maps gamepads against the real bundle in a bare VM`, async () => {
    const ctx = vm.createContext({});
    vm.runInContext(await bundleCore(), ctx);
    vm.runInContext(getShim(), ctx);

    const poll = (pads, nowMs, playing) => JSON.parse(vm.runInContext(
      `Bridge.padPollJSON(${JSON.stringify(JSON.stringify(pads))}, ${nowMs}, ${playing})`, ctx));
    const buttons = (...down) => {
      const b = new Array(17).fill(false);
      for (const i of down) b[i] = true;
      return b;
    };

    // Two pads in one call, which is the whole point of the batch: their
    // mappers must be independent, and the seat has to come back with the
    // result or the shell cannot tell whose edges it is holding. Game input
    // never crosses back at all — the shim feeds it to the engine itself
    // (with no game yet it is dropped, exactly as the web drops input with
    // no game running) — so what returns is the edges and the rumble flag.
    const first = poll([
      { seat: 900, buttons: buttons(1), axes: [0, 0] },   // right face: rotate CW
      { seat: 901, buttons: buttons(12), axes: [0, 0] },  // D-pad up: hard drop
    ], 0, true);
    assert.deepEqual(first.map((r) => r.seat), [900, 901]);
    assert.equal(first[0].messages, undefined);
    assert.deepEqual(first[0].pressed, [1]);
    assert.equal(first[0].hardDrop, false);
    assert.deepEqual(first[1].pressed, [12]);
    assert.equal(first[1].hardDrop, true);

    // Held, not re-pressed: edge detection has to survive between calls, which
    // is what the per-seat mapper in the shim's `pads` map is for.
    assert.deepEqual(poll([
      { seat: 900, buttons: buttons(1), axes: [0, 0] },
    ], 16, true)[0].pressed, []);

    // Outside play a press yields its raw index, so the shell can route it to
    // the room instead of the board.
    const menu = poll([{ seat: 900, buttons: buttons(9), axes: [0, 0] }], 32, false);
    assert.deepEqual(menu[0].pressed, [9]);

    // A pad that stops being reported is forgotten, so its held state cannot
    // resurface on whoever lands in that seat next.
    poll([], 48, true);
    assert.deepEqual(
      poll([{ seat: 900, buttons: buttons(1), axes: [0, 0] }], 64, true)[0].pressed,
      [1],
      'a re-seated pad starts from a clean baseline, so the held button reads as a fresh press'
    );

    assert.equal(
      vm.runInContext('Bridge.padName("Xbox Wireless Controller (Vendor: 045e Product: 0b13)")', ctx),
      'Xbox');
  });
}

for (const [platform, getShim] of Object.entries(SHIMS)) {
  test(`the ${platform} shim fuses pad mapping into the frame crossing`, async () => {
    const ctx = vm.createContext({});
    vm.runInContext(await bundleCore(), ctx);
    vm.runInContext(getShim(), ctx);
    vm.runInContext('Bridge.create([[900, 1]], 42)', ctx);

    const buttons = new Array(17).fill(false);
    buttons[12] = true;   // D-pad up: hard drop
    const combined = vm.runInContext(
      `Bridge.framePadsPacked(16, [], ${JSON.stringify(JSON.stringify([
        { seat: 900, buttons, axes: [0, 0] },
      ]))}, 16)`, ctx);

    // The pad results ride ahead of the packed frame as a length-prefixed JSON
    // header (the packed body admits no separator after it).
    const colon = combined.indexOf(':');
    const len = Number(combined.slice(0, colon));
    const pads = JSON.parse(combined.slice(colon + 1, colon + 1 + len));
    const packed = combined.slice(colon + 1 + len);
    assert.deepEqual(pads, [{ seat: 900, pressed: [12], nav: [], hardDrop: true }]);

    // The input was consumed inside the same call, BEFORE the frame ran: the
    // frame that comes back already shows the consequence of the press.
    const unpacked = JSON.parse(vm.runInContext(
      `JSON.stringify((function () {
         var f = HexCore.PartyCore.unpackFrame(${JSON.stringify(packed)});
         return { events: f.events.map(function (e) { return e.type; }), hasSnapshot: !!f.snapshot };
       })())`, ctx));
    assert.ok(unpacked.events.includes('piece_lock'),
      `expected the hard drop's piece_lock in the same frame, saw ${unpacked.events}`);
    assert.ok(unpacked.hasSnapshot, 'the first frame carries a snapshot');
  });
}

for (const [platform, getShim] of Object.entries(SHIMS)) {
  test(`the ${platform} shim delivers frames identically against the real bundle`, async () => {
    const ctx = vm.createContext({});
    vm.runInContext(await bundleCore(), ctx);
    vm.runInContext(getShim(), ctx);

    // Frames cross PACKED now, so unpack them with the bundle's own reference
    // decoder — which also proves packer and unpacker agree inside the very
    // bundle the natives load, not just in the module tests.
    const unpack = (js) =>
      vm.runInContext(`HexCore.PartyCore.unpackFrame(${js})`, ctx);
    const call = (js) => JSON.parse(vm.runInContext(js, ctx));
    const player = (snap, id) => snap.players.find((p) => p.id === id);

    // A read before create() must name the ordering bug rather than surface an
    // opaque TypeError from inside the engine.
    assert.throws(() => vm.runInContext('Bridge.framePacked(0)', ctx), /create\(\)/);

    vm.runInContext('Bridge.create([[1,1],[2,1]], 7)', ctx);

    const opening = unpack('Bridge.framePacked(0)');
    assert.equal(opening.snapshot.players.length, 2, 'the opening frame is always delivered');
    assert.ok(player(opening.snapshot, 1).grid, 'first delivery carries full grids');

    // 1 ms later nothing has moved, so the snapshot is omitted entirely — this is
    // the fast path Android had and tvOS didn't, now shared through PartyCore.
    assert.equal(unpack('Bridge.framePacked(1)').snapshot, null);

    // A hard drop changes one board: delivered again, with that player's grid
    // re-sent (version bumped) and the untouched player's grid stripped.
    vm.runInContext('Bridge.processInput(1, "hard_drop")', ctx);
    const locked = unpack('Bridge.framePacked(17)');
    assert.ok(player(locked.snapshot, 1).grid, "the locked board's grid must ride along");
    assert.equal(player(locked.snapshot, 2).grid, undefined, 'unchanged grid must be stripped');
    assert.ok(locked.commands.some((c) => c.type === 'pieceLock'),
      'commands are never filtered, whatever the snapshot does');

    // An out-of-band pull always returns a snapshot (grids still stripped).
    const pulled = unpack('Bridge.snapshotPacked()').snapshot;
    assert.equal(pulled.players.length, 2);

    // A single seat, the render-on-input path: only that board rides.
    const one = unpack('Bridge.snapshotPlayerPacked(2)').snapshot;
    assert.equal(one.players.length, 1, 'a per-seat pull must carry exactly one board');
    assert.equal(one.players[0].id, 2);
    assert.equal(vm.runInContext('Bridge.snapshotPlayerPacked(99)', ctx), null,
      'an id with no board must answer null, not an empty room');

    // Batched input has to land in order and be indistinguishable from
    // one-at-a-time calls; it is the path every controller input takes.
    vm.runInContext('Bridge.processInputs([[1,"left"],[1,"left"],[2,"rotate_cw"]])', ctx);
    const afterBatch = unpack('Bridge.snapshotPacked()').snapshot;
    assert.ok(player(afterBatch, 1).currentPiece, 'batched input must not lose the piece');
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
