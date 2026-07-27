'use strict';

// Apple TV <-> web protocol/constants lockstep guard.
//
// appletv/Sources/HexStackerKit/Net/Protocol.swift hand-mirrors the wire
// protocol from public/shared/protocol.js. A drifted message-type string is a
// silent production bug (a typo'd type is just an ignored message), so this
// gate re-derives every mirrored value from the canonical JS and fails on any
// mismatch. It is the Swift analog of tests/protocol-android-parity.test.js
// and uses the same technique: the values are compile-time constants, so
// narrow regexes over the source text are the honest place to read them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MSG, INPUT, ROOM_STATE, RELAY_URL, STUN_URL } = require('../public/shared/protocol.js');
const constants = require('../server/constants.js');
const { RoomBrain } = require('../server/RoomBrain.js');

const ROOT = path.join(__dirname, '..');
const SWIFT = read('appletv/Sources/HexStackerKit/Net/Protocol.swift');
const COORDINATOR = read('appletv/Sources/HexStackerKit/Game/DisplayCoordinator.swift');

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

/** The body of `public enum <name> ... { ... }` (these enums have no nested braces). */
function swiftEnum(name) {
  const m = SWIFT.match(new RegExp(`public enum ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `Swift enum ${name} not found`);
  return m[1];
}

/** `static let name = "value"` pairs -> { name: 'value' }. */
function swiftStringConsts(block) {
  const out = {};
  for (const m of block.matchAll(/static let (\w+) = "([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Swift camelCase const name -> the JS UPPER_SNAKE key (rotateCW -> ROTATE_CW). */
function upperSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Raw-string enum cases (`case left` / `case rotateCW = "rotate_cw"`) -> { NAME: 'wire' }. */
function swiftWireEnum(block) {
  const out = {};
  for (const m of block.matchAll(/^\s*case (\w+)(?:\s*=\s*"([^"]+)")?\s*$/gm)) {
    out[upperSnake(m[1])] = m[2] !== undefined ? m[2] : m[1];
  }
  return out;
}

test('MSG strings mirror protocol.js MSG', () => {
  const problems = [];
  const consts = swiftStringConsts(swiftEnum('MSG'));
  for (const [name, value] of Object.entries(consts)) {
    if (name === 'heartbeat') continue; // display-internal, not in MSG (checked below)
    const key = upperSnake(name);
    if (MSG[key] === undefined) problems.push(`MSG.${name}: no MSG.${key} in protocol.js`);
    else if (MSG[key] !== value) problems.push(`MSG.${name}: '${value}' != web '${MSG[key]}'`);
  }
  assert.deepStrictEqual(problems, []);
});

test('the display heartbeat canary and clientId match the web display', () => {
  const displayConnection = read('public/display/DisplayConnection.js');
  assert.strictEqual(swiftStringConsts(swiftEnum('MSG')).heartbeat, '_heartbeat');
  assert.ok(displayConnection.includes("'_heartbeat'"), 'web display no longer uses _heartbeat');
  assert.strictEqual(swiftStringConsts(swiftEnum('Protocol')).displayClientId, 'display');
  assert.ok(displayConnection.includes("clientId: 'display'"), "web display no longer uses clientId 'display'");
});

test('RoomState and InputAction wire values mirror protocol.js', () => {
  assert.deepStrictEqual(swiftWireEnum(swiftEnum('RoomState')), ROOM_STATE, 'RoomState wire values');
  assert.deepStrictEqual(swiftWireEnum(swiftEnum('InputAction')), INPUT, 'InputAction wire values');
});

test('relay endpoints and limits mirror the web', () => {
  const proto = swiftStringConsts(swiftEnum('Protocol'));
  assert.strictEqual(proto.relayURL, RELAY_URL);
  assert.strictEqual(proto.stunURL, STUN_URL);
  // Display slot 0 + MAX_PLAYERS controllers, same as the web's create call
  // (pinned to the web source in tests/protocol-android-parity.test.js).
  const maxClients = SWIFT.match(/static let maxClients = (\d+)/);
  assert.ok(maxClients, 'Swift const maxClients not found');
  assert.strictEqual(Number(maxClients[1]), constants.MAX_PLAYERS + 1);
});

test('the controller base URL matches the Android mirror', () => {
  // The web display derives the QR join URL from window.location, so there is
  // no canonical JS constant; the two native mirrors must at least agree with
  // each other.
  const kotlin = read('android/core/src/commonMain/kotlin/com/hexstacker/core/net/Protocol.kt');
  const kt = kotlin.match(/const val CONTROLLER_BASE_URL = "([^"]*)"/);
  assert.ok(kt, 'Kotlin const CONTROLLER_BASE_URL not found');
  assert.strictEqual(swiftStringConsts(swiftEnum('Protocol')).controllerBaseURL, kt[1]);
});

// The room LAYER is no longer mirrored — tvOS runs server/RoomBrain.js itself, and
// RoomBrainConformanceTests replays the shared golden through its bridge — so there
// is nothing left here to pin about naming, colours, host election or the snapshot.
// What survives is the handful of numbers the shell still has to hold in Swift,
// because they configure or schedule the brain rather than living inside it.
test('the snapshot throttle is READ from the brain, not mirrored in Swift', () => {
  // The brain hands back a 'now' | 'soon' | 'none' hint per mutator; the WINDOW
  // the 'soon' hint is throttled by has to be the brain's own. Swift reads it
  // through roomGet at roomInit time, exactly as Kotlin does, so there is no
  // constant here to drift. This asserts the READ still happens: a future edit
  // that quietly reinstates a Swift literal would otherwise go unnoticed.
  assert.match(
    COORDINATOR,
    /roomGet\(Double\.self, "snapshotThrottleMs"\)/,
    'Swift no longer reads the throttle window from the brain'
  );
  assert.ok(
    !/(static )?let snapshotThrottleMs = /.test(COORDINATOR),
    'the throttle window is mirrored as a Swift constant again; read it from the brain instead'
  );
});

test('the liveness policy handed to the brain matches the canonical constants', () => {
  // Constructor options, so they are Swift-side by necessity; the web display passes
  // the same two values from server/constants.js.
  const timeout = COORDINATOR.match(/static let livenessTimeoutMs = (\d+)/);
  const grace = COORDINATOR.match(/static let lateJoinerGraceMs = (\d+)/);
  assert.ok(timeout && grace, 'Swift liveness constants not found');
  assert.strictEqual(Number(timeout[1]), constants.LIVENESS_TIMEOUT_MS);
  assert.strictEqual(Number(grace[1]), constants.LATE_JOINER_GRACE_MS);
});

test('the controller-URL template registered on create mirrors the web shape', () => {
  // Same guard as tests/protocol-android-parity.test.js: every display flavor
  // registers <base>/{room}#{instance} on create so a code-only join resolves
  // to the same controller page regardless of which display hosts the room.
  const proto = swiftStringConsts(swiftEnum('Protocol'));
  assert.strictEqual(proto.controllerURLTemplate, `${proto.controllerBaseURL}/{room}#{instance}`);
});
