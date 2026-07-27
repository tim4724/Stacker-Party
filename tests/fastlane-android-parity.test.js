'use strict';

// Android TV <-> web fastlane lockstep guard. The Kotlin twin of
// tests/fastlane-swift-parity.test.js — see that file's header for why this
// wire format needs a gate at all (a drifted key is silent: the display just
// stops hearing low-latency input and falls back to the relay).
//
// Canonical shapes: tests/helpers/fastlane-wire.js, derived by RUNNING
// partyplug/PartyFastlane.js. Kotlin is read with narrow regexes over the
// source, like tests/protocol-android-parity.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WIRE = require('./helpers/fastlane-wire.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const IFACE = read('android/core/src/commonMain/kotlin/com/hexstacker/core/net/Fastlane.kt');
const NETCODE = read('android/core/src/commonMain/kotlin/com/hexstacker/core/net/FastlaneReceiver.kt');
const TRANSPORT = read('android/tv/src/main/java/com/hexstacker/tv/net/WebRtcFastlane.kt');

test('the signaling envelope key matches partyplug', () => {
  const m = IFACE.match(/const val RTC_KEY = "([^"]+)"/);
  assert.ok(m, 'Kotlin const RTC_KEY not found');
  assert.equal(m[1], WIRE.RTC_KEY);
});

test('the silence watchdog matches PartyFastlane WATCHDOG_MS', () => {
  const m = TRANSPORT.match(/const val WATCHDOG_MS = ([0-9.]+)L?/);
  assert.ok(m, 'Kotlin const WATCHDOG_MS not found');
  assert.equal(Number(m[1]), WIRE.WATCHDOG_MS);
});

test('the receiver reads and writes exactly the packet keys PartyFastlane sends', () => {
  // Inbound reads (`packet["ps"]`, `"h" in packet`) plus the ack it builds
  // (`put("pa", ...)`). Same role as the Swift gate's key-set assertion.
  const keys = new Set();
  for (const m of NETCODE.matchAll(/packet\["(\w+)"\]/g)) keys.add(m[1]);
  for (const m of NETCODE.matchAll(/"(\w+)" in packet/g)) keys.add(m[1]);
  for (const m of NETCODE.matchAll(/put\("(\w+)",/g)) keys.add(m[1]);
  assert.deepEqual([...keys].sort(), WIRE.PACKET_KEYS);
});

test('the signaling kinds it handles and emits are the ones the web speaks', () => {
  // Answer-only display, so a SUBSET of the web's kinds; each one it does name
  // must carry the web's payload key. (`when` branch -> first payload read.)
  const handled = [...TRANSPORT.matchAll(/"(\w+)" -> \{[\s\S]*?data\["(\w+)"\]/g)];
  assert.ok(handled.length, 'no signaling branches found in WebRtcFastlane.kt');
  for (const [, kind, payload] of handled) {
    assert.equal(payload, WIRE.EMITTED_SIGNALS[kind],
      `handled '${kind}' reads data["${payload}"]; the web sends '${WIRE.EMITTED_SIGNALS[kind]}'`);
  }

  const emitted = [...TRANSPORT.matchAll(/put\(Fastlane\.RTC_KEY, "(\w+)"\)\s*\n\s*putJsonObject\("(\w+)"\)/g)];
  assert.ok(emitted.length, 'no signaling sends found in WebRtcFastlane.kt');
  for (const [, kind, payload] of emitted) {
    assert.ok(WIRE.HANDLED_SIGNALS.includes(kind), `emits '${kind}', which the web ignores`);
    assert.equal(payload, WIRE.EMITTED_SIGNALS[kind],
      `emits '${kind}' with "${payload}"; the web reads '${WIRE.EMITTED_SIGNALS[kind]}'`);
  }
});
