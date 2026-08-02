'use strict';

// tvOS <-> Android TV room-advertisement lockstep guard (CouchPad contract §8).
//
// Both native displays publish the open room over DNS-SD for the CouchPad
// launcher to find. Nothing else in the system reads these two strings, so a
// drift is invisible everywhere a test normally looks: the app still builds, the
// room still works, discovery just silently stops finding that platform. It has
// already happened once (a TXT key renamed in the contract, updated on one side
// only), which is what this gate is for.
//
// The contract lives in the launcher repo and is not a dependency here, so the
// expected values are literals: the point is that the two shells agree with each
// other and that changing either one is a deliberate edit to this file too.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SWIFT = read('appletv/Sources/HexStackerTV/RoomAdvertiser.swift');
const KOTLIN = read('android/tv/src/main/java/com/hexstacker/tv/RoomAdvertiser.kt');

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

test('both native displays advertise the same DNS-SD service type', () => {
  // NsdManager's convention carries the trailing dot, Network.framework's does
  // not; the wire protocol is identical either way.
  assert.match(SWIFT, /serviceType = "_couchpad\._tcp"/, 'tvOS service type drifted');
  assert.match(KOTLIN, /SERVICE_TYPE = "_couchpad\._tcp\."/, 'Android TV service type drifted');
});

test('both native displays put the room code in TXT `c`', () => {
  assert.match(SWIFT, /codeKey = "c"/, 'tvOS TXT key drifted');
  assert.match(KOTLIN, /CODE_KEY = "c"/, 'Android TV TXT key drifted');
});

test('the advertisement carries nothing but the room code', () => {
  // §8: the code is the whole payload. Everything else (join URL, platform,
  // liveness, occupancy) comes from resolving that code against the relay, so
  // an advertisement can name a room but never propose an origin. Re-adding a
  // URL or a platform key here would hand the LAN a say in where a phone
  // navigates, which is precisely what the contract removed.
  assert.doesNotMatch(SWIFT, /NWTXTRecord\(\[[^\]]*(?:"u"|"cpv"|"cpp")/, 'tvOS TXT record grew a key beyond the code');
  assert.doesNotMatch(KOTLIN, /setAttribute\("(?:u|cpv|cpp)"/, 'Android TV TXT record grew a key beyond the code');
});
