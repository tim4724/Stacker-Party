'use strict';

// The canonical fastlane wire contract, for the two native lockstep gates
// (tests/fastlane-{swift,android}-parity.test.js).
//
// The packet shapes are DERIVED BY RUNNING partyplug/PartyFastlane.js — a real
// fastlane with a fake DataChannel is driven through its send, heartbeat and ack
// paths, and the keys it actually writes are what the natives must speak. That is
// stronger than reading the source: a renamed key changes these fixtures even if
// the surrounding text still looks right.
//
// The netcode timings and the signaling envelope are module-private consts and
// call-site literals, so those ARE read as source text (the same technique the
// protocol parity gates use on the Swift/Kotlin side).

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'partyplug', 'PartyFastlane.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');
const PartyFastlane = require(SOURCE_PATH);

/** A synthetic open peer, the shape `_ensurePeer` builds (see partyplug/tests). */
function fakePeer(channel) {
  return {
    pc: { close() {}, signalingState: 'stable', connectionState: 'connected' },
    channel: channel,
    pendingCandidates: [],
    polite: false,
    makingOffer: false,
    ignoreOffer: false,
    _waitResolvers: [],
    eventSeq: 0,
    ring: [],
    sendTimer: null,
    idleTimer: null,
    watchdogTimer: null,
    lastAckedEs: 0,
    lastAppliedEs: 0,
    srtt: 0,
  };
}

// Drive the three packet kinds out of the real implementation. Order matters:
// the idle heartbeat only fires while the ring is empty, so it goes first.
function capturePackets() {
  const sent = [];
  const channel = {
    readyState: 'open',
    send(data) { sent.push(JSON.parse(data)); },
    close() { this.readyState = 'closed'; },
  };
  const peerIdx = 1;
  const fastlane = new PartyFastlane({ selfIndex: 0, emitIdleHeartbeat: true });
  const peer = fakePeer(channel);
  fastlane.peers.set(peerIdx, peer);

  fastlane._sendIdleHeartbeat(peer, peerIdx);
  const heartbeat = sent.pop();

  fastlane.enqueue(peerIdx, { type: 'input', action: 'left' });
  const data = sent.pop();

  fastlane._handleDataPacket(peer, peerIdx, { ps: 1, t: 1234, h: [{ type: 'input', action: 'left' }] });
  const ack = sent.pop();

  // Clears the resend / idle / watchdog timers this left armed, so the test
  // process exits immediately instead of idling for TICK_MS.
  fastlane._teardownPeer(peerIdx);
  return { data, heartbeat, ack };
}

/** `var NAME = <number>;` from the netcode-parameter block. */
function timing(name) {
  const m = SOURCE.match(new RegExp('var ' + name + ' = ([0-9.]+);'));
  if (!m) throw new Error('PartyFastlane.js: netcode constant ' + name + ' not found');
  return Number(m[1]);
}

const PACKETS = capturePackets();

// `{ [RTC_KEY]: 'kind', payloadKey: ... }` at every send site -> { kind: payloadKey }.
const EMITTED_SIGNALS = {};
for (const m of SOURCE.matchAll(/\{ \[RTC_KEY\]: '(\w+)', (\w+):/g)) EMITTED_SIGNALS[m[1]] = m[2];

// `kind === 'offer'` etc. in _handleRtcSignal.
const HANDLED_SIGNALS = [...SOURCE.matchAll(/kind === '(\w+)'/g)].map((m) => m[1]);

module.exports = {
  RTC_KEY: SOURCE.match(/var RTC_KEY = '([^']+)';/)[1],
  /** Every key that appears in any direction of the DataChannel protocol. */
  PACKET_KEYS: [...new Set([].concat(
    Object.keys(PACKETS.data), Object.keys(PACKETS.heartbeat), Object.keys(PACKETS.ack)))].sort(),
  PACKETS: PACKETS,
  TICK_MS: timing('TICK_MS'),
  TTL_MS: timing('TTL_MS'),
  IDLE_MS: timing('IDLE_MS'),
  WATCHDOG_MS: timing('WATCHDOG_MS'),
  EMITTED_SIGNALS: EMITTED_SIGNALS,
  HANDLED_SIGNALS: [...new Set(HANDLED_SIGNALS)].sort(),
};
