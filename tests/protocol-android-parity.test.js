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
const { RoomBrain } = require('../server/RoomBrain.js');

const ROOT = path.join(__dirname, '..');
const KOTLIN = {
  protocol: read('android/core/src/commonMain/kotlin/com/hexstacker/core/net/Protocol.kt'),
  inputAction: read('android/core/src/commonMain/kotlin/com/hexstacker/core/engine/InputAction.kt'),
  roomFlow: read('android/core/src/commonMain/kotlin/com/hexstacker/core/room/RoomFlow.kt'),
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

/** Enum entries of the form NAME("wire") -> { NAME: 'wire' }. */
function kotlinWireEnum(src) {
  const out = {};
  for (const m of src.matchAll(/^\s*([A-Z_]+)\("([a-z_]+)"\),?;?\s*$/gm)) out[m[1]] = m[2];
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
  assert.deepStrictEqual(kotlinWireEnum(KOTLIN.protocol), ROOM_STATE, 'RoomState wire values');
  assert.deepStrictEqual(kotlinWireEnum(KOTLIN.inputAction), INPUT, 'InputAction wire values');
});

test('relay endpoints and limits mirror the web', () => {
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'RELAY_URL'), RELAY_URL);
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'STUN_URL'), STUN_URL);
  assert.strictEqual(kotlinConst(KOTLIN.roomFlow, 'MAX_PLAYERS'), constants.MAX_PLAYERS);
  // Display slot 0 + MAX_PLAYERS controllers; the web hardcodes the same figure
  // in its create call.
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'MAX_CLIENTS'), constants.MAX_PLAYERS + 1);
  assert.ok(
    read('public/display/DisplayConnection.js').includes(`party.create(${constants.MAX_PLAYERS + 1},`),
    'web display create() no longer matches MAX_PLAYERS + 1',
  );
});

test('the controller-URL template registered on create mirrors the web shape', () => {
  // The web display derives the template from its origin at runtime
  // (controllerUrlTemplate in DisplayConnection.js); the native mirror
  // hardcodes the prod origin. Both must register the same
  // <base>/{room}#{instance} shape or a code-only join resolves to
  // different pages depending on which display hosts the room.
  const base = kotlinConst(KOTLIN.protocol, 'CONTROLLER_BASE_URL');
  assert.strictEqual(
    kotlinConst(KOTLIN.protocol, 'CONTROLLER_URL_TEMPLATE'),
    `${base}/{room}#{instance}`,
  );
  assert.ok(
    read('public/display/DisplayConnection.js').includes("'/{room}#{instance}'"),
    'web display no longer builds the /{room}#{instance} template',
  );
});

test('timing constants mirror server/constants.js and PartyConnection.js', () => {
  assert.strictEqual(kotlinConst(KOTLIN.protocol, 'SELF_HEARTBEAT_DEAD_MS'), constants.SELF_HEARTBEAT_DEAD_MS);

  // DisplayCoordinator wires RoomFlow with literals mirroring constants.js.
  const liveness = KOTLIN.coordinator.match(/livenessTimeoutMs = ([\d.]+)/);
  const grace = KOTLIN.coordinator.match(/graceMs = ([\d.]+)/);
  assert.strictEqual(Number(liveness[1]), constants.LIVENESS_TIMEOUT_MS);
  assert.strictEqual(Number(grace[1]), constants.LATE_JOINER_GRACE_MS);

  // Snapshot-publish throttle. Read from the canonical module rather than from
  // web source text: every display, this one included, gets the value from
  // RoomBrain now, so this pins Kotlin to the same constant the web reads.
  assert.strictEqual(
    kotlinConst(KOTLIN.coordinator, 'LOBBY_BROADCAST_MIN_INTERVAL_MS'),
    RoomBrain.SNAPSHOT_THROTTLE_MS
  );

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
