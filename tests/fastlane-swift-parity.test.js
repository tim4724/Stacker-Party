'use strict';

// Apple TV <-> web fastlane lockstep guard.
//
// appletv/.../Net/Fastlane.swift (netcode) and Sources/HexStackerTV/WebRTCFastlane.swift
// (transport) hand-mirror the DataChannel wire format and signaling envelope of
// partyplug/PartyFastlane.js, which controllers speak. Nothing links them, and a
// drift is INVISIBLE in the worst way: a renamed packet key doesn't error, it just
// makes the display ignore low-latency input and silently fall back to the relay
// (or, for the watchdog, tear down healthy peers). The protocol, i18n and room
// layers all have gates like this; the fastlane was the one hand-mirrored wire
// format that had none.
//
// The canonical shapes come from tests/helpers/fastlane-wire.js, which RUNS the
// real PartyFastlane rather than reading it. The Swift side is read with narrow
// regexes over the source text (the technique tests/protocol-swift-parity.test.js
// uses, and for the same reason: these are compile-time constants).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WIRE = require('./helpers/fastlane-wire.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const NETCODE = read('appletv/Sources/HexStackerKit/Net/Fastlane.swift');
const TRANSPORT = read('appletv/Sources/HexStackerTV/WebRTCFastlane.swift');

test('the signaling envelope key matches partyplug', () => {
  const m = NETCODE.match(/static let signalKey = "([^"]+)"/);
  assert.ok(m, 'Swift const signalKey not found');
  assert.equal(m[1], WIRE.RTC_KEY);
  // The transport emits the literal rather than the constant, so pin it too.
  for (const lit of TRANSPORT.matchAll(/\["(__\w+)":\s*"/g)) {
    assert.equal(lit[1], WIRE.RTC_KEY, 'WebRTCFastlane emits a non-canonical envelope key');
  }
});

test('the silence watchdog matches PartyFastlane WATCHDOG_MS', () => {
  const m = NETCODE.match(/static let watchdogMs: Double = ([0-9.]+)/);
  assert.ok(m, 'Swift const watchdogMs not found');
  assert.equal(Number(m[1]), WIRE.WATCHDOG_MS);
});

test('the receiver reads and writes exactly the packet keys PartyFastlane sends', () => {
  // Every string-literal packet subscript in the netcode: the keys it reads off an
  // inbound packet plus the ones it writes into an ack. A renamed key on either
  // side lands here as an unknown (or missing) member of this set.
  const keys = new Set();
  for (const m of NETCODE.matchAll(/(?:obj|packet|ack)\["(\w+)"\]/g)) keys.add(m[1]);
  for (const m of NETCODE.matchAll(/= \["(\w+)":/g)) keys.add(m[1]);
  assert.deepEqual([...keys].sort(), WIRE.PACKET_KEYS);
});

test('the signaling kinds it handles and emits are the ones the web speaks', () => {
  // The display is answer-only (controllers offer), so it handles/emits a SUBSET
  // of the web's bidirectional set — what must hold is that every kind it names
  // exists on the web side and carries the same payload key.
  const handled = [...TRANSPORT.matchAll(/case "(\w+)":\s*if let \w+ = data\["(\w+)"\]/g)];
  assert.ok(handled.length, 'no signaling cases found in WebRTCFastlane.swift');
  for (const [, kind, payload] of handled) {
    assert.equal(payload, WIRE.EMITTED_SIGNALS[kind],
      `handled '${kind}' reads data["${payload}"]; the web sends '${WIRE.EMITTED_SIGNALS[kind]}'`);
  }

  const emitted = [...TRANSPORT.matchAll(/\["__\w+":\s*"(\w+)",\s*"(\w+)":/g)];
  assert.ok(emitted.length, 'no signaling sends found in WebRTCFastlane.swift');
  for (const [, kind, payload] of emitted) {
    assert.ok(WIRE.HANDLED_SIGNALS.includes(kind), `emits '${kind}', which the web ignores`);
    assert.equal(payload, WIRE.EMITTED_SIGNALS[kind],
      `emits '${kind}' with "${payload}"; the web reads '${WIRE.EMITTED_SIGNALS[kind]}'`);
  }
});
