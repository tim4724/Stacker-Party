'use strict';

// Android TV <-> web protocol/constants lockstep guard.
//
// android/core hand-mirrors the wire protocol and timing constants from
// public/shared/protocol.js, server/constants.js and partyplug/PartyConnection.js.
// A drifted message-type string or timeout is a silent production bug (a typo'd
// type is just an ignored message), so this gate re-derives every mirrored value
// from the canonical JS and fails on any mismatch — the strings analog is
// tests/i18n-android-parity.test.js.
//
// The Kotlin side is read with narrow regexes over the source files (the same
// technique as room-snapshot.test.js's production lockstep guard): the values are
// compile-time constants, so source text is the honest place to read them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MSG, INPUT, ROOM_STATE, RELAY_URL, STUN_URL } = require('../public/shared/protocol.js');
const constants = require('../server/constants.js');
const { RoomCore } = require('../server/RoomCore.js');

const ROOT = path.join(__dirname, '..');
const KOTLIN = {
  protocol: read('android/core/src/commonMain/kotlin/com/hexstacker/core/net/Protocol.kt'),
  inputAction: read('android/core/src/commonMain/kotlin/com/hexstacker/core/engine/InputAction.kt'),
  engineConstants: read('android/core/src/commonMain/kotlin/com/hexstacker/core/model/EngineConstants.kt'),
  coordinator: read('android/core/src/commonMain/kotlin/com/hexstacker/core/display/DisplayCoordinator.kt'),
};

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

/** `const val NAME = <literal>` -> string|number (handles "..", 1000L, 1.5, 400.0). */
function kotlinConst(src, name) {
  const m = src.match(new RegExp(`const val ${name}\\s*=\\s*("([^"]*)"|[-\\d.]+L?)`));
  assert.ok(m, `Kotlin const ${name} not found`);
  return m[2] !== undefined ? m[2] : Number(m[1].replace(/L$/, ''));
}

/** Entries of the form NAME("wire") inside `enum class <name>` -> { NAME: 'wire' }.
 *  Scoped to the named enum: Protocol.kt holds several of these, and a file-wide
 *  sweep silently merged them into whichever one was being asserted. */
function kotlinWireEnum(src, name) {
  const block = src.match(new RegExp(`enum class ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(block, `Kotlin enum class ${name} not found`);
  const out = {};
  for (const m of block[1].matchAll(/^\s*([A-Z_]+)\("([a-z_]+)"\),?;?\s*$/gm)) out[m[1]] = m[2];
  return out;
}

test('Msg strings mirror protocol.js MSG', () => {
  const problems = [];
  for (const m of KOTLIN.protocol.matchAll(/const val ([A-Z_]+) = "([^"]*)"/g)) {
    const [, name, value] = m;
    if (!/^[a-z_]+$/.test(value)) continue; // RelayConfig URLs etc., checked below
    if (name === 'HEARTBEAT') continue; // display-internal, not in MSG (checked below)
    if (name === 'DISPLAY_CLIENT_ID') continue; // relay slot-0 anchor, checked below
    if (MSG[name] === undefined) problems.push(`Msg.${name}: no MSG.${name} in protocol.js`);
    else if (MSG[name] !== value) problems.push(`Msg.${name}: '${value}' != web '${MSG[name]}'`);
  }
  assert.deepStrictEqual(problems, []);
});

test('the display heartbeat canary and clientId match the web display', () => {
  const displayConnection = read('public/display/DisplayConnection.js');
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'HEARTBEAT'), '_heartbeat');
  assert.ok(displayConnection.includes("'_heartbeat'"), 'web display no longer uses _heartbeat');
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'DISPLAY_CLIENT_ID'), 'display');
  assert.ok(displayConnection.includes("clientId: 'display'"), "web display no longer uses clientId 'display'");
});

test('RoomState and InputAction wire values mirror protocol.js', () => {
  assert.deepStrictEqual(kotlinWireEnum(KOTLIN.protocol, 'RoomState'), ROOM_STATE, 'RoomState wire values');
  assert.deepStrictEqual(kotlinWireEnum(KOTLIN.inputAction, 'InputAction'), INPUT, 'InputAction wire values');
});

test('PauseReason wire values mirror the room core', () => {
  // The reason never crosses the wire — only the boolean it projects into does —
  // but it IS the argument to roomCall("setPause"), so a drifted spelling reaches
  // the room core as an unknown reason, which it silently refuses. The freeze
  // would then never be recorded and the snapshot would keep saying paused:false.
  assert.deepStrictEqual(
    kotlinWireEnum(KOTLIN.protocol, 'PauseReason'),
    { MANUAL: RoomCore.PAUSE.MANUAL, AUTO: RoomCore.PAUSE.AUTO, CONNECTION: RoomCore.PAUSE.CONNECTION }
  );
});

test('the publish-hint vocabulary matches the room core, and its ranking is READ from it', () => {
  // The three hint strings are compared against in Kotlin, so they have to exist
  // as constants; what must NOT be mirrored is how strong each one is. That
  // ordering decides what a batched group of mutations publishes, and three
  // hand-written copies of it is how one platform ends up shipping a
  // half-finished room. tvOS reads the same property.
  const client = read('android/core/src/commonMain/kotlin/com/hexstacker/core/room/RoomCoreClient.kt');
  const consts = {};
  for (const m of client.matchAll(/const val PUBLISH_(NONE|NOW|SOON) = "([^"]*)"/g)) consts[m[1]] = m[2];
  assert.deepStrictEqual(consts, RoomCore.PUBLISH);
  assert.match(
    client,
    /roomGetJson\("publishRank"\)/,
    'Kotlin no longer reads the hint ranking from the room core'
  );
  assert.ok(
    !/PUBLISH_(NOW|SOON) -> [12]\b/.test(KOTLIN.coordinator),
    'the hint ranking is hand-mirrored in Kotlin again; read publishRank instead'
  );
});

test('relay endpoints and limits mirror the web', () => {
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'RELAY_URL'), RELAY_URL);
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'STUN_URL'), STUN_URL);
  assert.strictEqual(kotlinConst(KOTLIN.engineConstants, 'MAX_PLAYERS'), constants.MAX_PLAYERS);
  // Display slot 0 + MAX_PLAYERS controllers; the web hardcodes the same figure
  // in its create call.
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'MAX_CLIENTS'), constants.MAX_PLAYERS + 1);
  assert.ok(
    read('public/display/DisplayConnection.js').includes(`party.create(${constants.MAX_PLAYERS + 1},`),
    'web display create() no longer matches MAX_PLAYERS + 1',
  );
  // Bound on the input message's repeat count. Drift here is silent both ways: too
  // low and a fast drag loses steps on this platform only, too high and an off-wire
  // count sets the loop bound.
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'INPUT_MAX_REPEAT'), constants.INPUT_MAX_REPEAT);
});

test('the controller-URL template registered on create mirrors the web shape', () => {
  // The web display derives the template from its origin at runtime
  // (controllerUrlTemplate in DisplayConnection.js); the native mirror defaults
  // to the prod origin. Both must register the same
  // <base>/{room}?cpp=<platform>#{instance} shape or a code-only join resolves to
  // different pages depending on which display hosts the room. Only the `cpp`
  // value differs per platform: that IS the point of the query, naming the box to
  // a launcher that resolved a typed room code. The vocabulary is fixed and the
  // launcher owns the wording, so no display ships a free-text label.
  //
  // Derived from the LIVE base (not the prod literal) on purpose: a debug launch
  // pointed at a branch preview must register the preview template too, so the QR
  // and a code-only join resolve to the same origin.
  assert.match(
    KOTLIN.protocol,
    /get\(\) = "\$controllerBaseUrl\/\{room\}\?cpp=androidtv#\{instance\}"/,
    'Kotlin controllerUrlTemplate no longer derives <base>/{room}?cpp=androidtv#{instance} from controllerBaseUrl',
  );
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'DEFAULT_CONTROLLER_BASE_URL'), 'https://hexstacker.com');
  const web = read('public/display/DisplayConnection.js');
  assert.ok(
    web.includes("'/{room}?cpp=web#{instance}'"),
    'web display no longer builds the /{room}?cpp=web#{instance} template',
  );
});

test('timing constants mirror server/constants.js and PartyConnection.js', () => {
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'SELF_HEARTBEAT_DEAD_MS'), constants.SELF_HEARTBEAT_DEAD_MS);

  // DisplayCoordinator hands these to the room core as its `liveness` options.
  assert.strictEqual(kotlinConst(KOTLIN.coordinator, 'LIVENESS_TIMEOUT_MS'), constants.LIVENESS_TIMEOUT_MS);
  assert.strictEqual(kotlinConst(KOTLIN.coordinator, 'LATE_JOINER_GRACE_MS'), constants.LATE_JOINER_GRACE_MS);

  // The countdown SEQUENCING is deliberately per-shell (setInterval on web, a
  // frame accumulator here): only one display ever runs in a room, so nothing
  // has to agree at runtime. The durations are pinned anyway, because three
  // hand-typed copies of "one second" is how a beat quietly becomes 1.2s.
  assert.strictEqual(kotlinConst(KOTLIN.coordinator, 'STEP_MS'), constants.COUNTDOWN_STEP_MS);
  assert.strictEqual(kotlinConst(KOTLIN.coordinator, 'GO_HOLD_MS'), constants.COUNTDOWN_GO_HOLD_MS);

  // The snapshot-publish throttle is NOT pinned here any more: Kotlin no longer
  // declares it. DisplayCoordinator reads RoomCore.SNAPSHOT_THROTTLE_MS out of the
  // bundle at start-up (RoomCoreClient.snapshotThrottleMs), so there is no second
  // copy of the value to keep in step — which is a stronger guarantee than this
  // file could give. The read itself is covered by the Kotlin conformance test.

  // Reconnect backoff (web PartyConnection: `|| 5` default attempts and
  // `Math.min(1000 * Math.pow(1.5, attempt - 1), 5000)`).
  const pc = read('partyplug/PartyConnection.js');
  const attempts = pc.match(/maxReconnectAttempts\) \|\| (\d+)/);
  const backoff = pc.match(/Math\.min\((\d+) \* Math\.pow\(([\d.]+), [^)]+\), (\d+)\)/);
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'MAX_RECONNECT_ATTEMPTS'), Number(attempts[1]));
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'RECONNECT_BASE_MS'), Number(backoff[1]));
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'RECONNECT_FACTOR'), Number(backoff[2]));
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'RECONNECT_CAP_MS'), Number(backoff[3]));

  // Slot eviction close code (web PartyConnection `event.code === 4000`).
  const evict = pc.match(/event\.code === (\d+)/);
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'CLOSE_CODE_REPLACED'), Number(evict[1]));
});
