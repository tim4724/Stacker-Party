'use strict';

// Portable-purity gate.
//
// These modules are the platform-agnostic shared surface native hosts load into
// JavaScriptCore (tvOS) and QuickJS (Android TV): the deterministic engine, the
// PartyCore frame() facade, and the RoomFlow reducer. They must stay clock-free
// and side-effect-free — no wall clock, no timers, no I/O, no DOM; time is
// injected as deltaMs/nowMs. This is the single gate guarding that invariant
// across both source dirs (server/ and partyplug/).
//
// NOT covered (correctly): server/index.js (the Node HTTP host) and the partyplug
// transport modules (PartyConnection/PartyFastlane/AirConsoleAdapter), which
// legitimately use sockets/timers and never run inside the JS engine.
//
// Math.random is ALLOWED — it seeds the default RNG (Game constructor,
// Randomizer/GarbageManager fallback), never per-tick logic — so it is
// deliberately not in the forbidden set.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The portable shared modules native loads into JSC/QuickJS. An explicit
// allowlist (not a directory glob) so adding a module is a deliberate, reviewed
// act and a non-portable file can't drift into the scan.
const PORTABLE_MODULES = [
  'server/constants.js',
  'server/Game.js',
  'server/GarbageManager.js',
  'server/Randomizer.js',
  'server/Piece.js',
  'server/PlayerBoard.js',
  'server/PartyCore.js',
  'server/GalleryFixtures.js',
  'partyplug/RoomFlow.js',
  'server/RoomCore.js',
  'server/PadMapper.js',
];

// Forbidden host APIs. Anchored-ish regexes so substrings in unrelated
// identifiers (e.g. "prefetch(", "documented") don't false-positive.
const FORBIDDEN = [
  { name: 'Date.now', re: /\bDate\.now\b/ },
  { name: 'setTimeout', re: /\bsetTimeout\b/ },
  { name: 'setInterval', re: /\bsetInterval\b/ },
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'WebSocket', re: /\bWebSocket\b/ },          // covers `new WebSocket` and `WebSocket(`
  { name: 'document.', re: /\bdocument\s*\./ },
  { name: 'ctx.', re: /\bctx\s*\./ },                  // no canvas context in a portable module
];

// Returns the forbidden-API names a single source line trips. Pulled out as a
// pure predicate so the gate's own logic can be unit-tested against string
// fixtures (the teeth tests below) without touching real files.
//
// console.* is a special case: it's allowed ONLY when guarded inline on the same
// line (a `typeof console` token), so a console-less JSC/QuickJS host can't throw
// a ReferenceError. A bare `console.x(...)` trips; a single-line
// `if (typeof console !== 'undefined' && console.x) console.x(...)` passes.
function lineViolations(line) {
  const hits = [];
  for (const { name, re } of FORBIDDEN) {
    if (re.test(line)) hits.push(name);
  }
  if (/\bconsole\./.test(line) && !/typeof console/.test(line)) {
    hits.push('unguarded console');
  }
  return hits;
}

test("every portable module exists (coverage lock — a rename can't silently drop one)", () => {
  for (const mod of PORTABLE_MODULES) {
    assert.ok(fs.existsSync(path.join(ROOT, mod)),
      mod + ' is in the portable-purity allowlist but does not exist — update PORTABLE_MODULES');
  }
});

test('portable modules contain no clock/timer/IO/DOM/canvas host APIs or unguarded console', () => {
  const violations = [];
  for (const mod of PORTABLE_MODULES) {
    const lines = fs.readFileSync(path.join(ROOT, mod), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const name of lineViolations(lines[i])) {
        violations.push(mod + ':' + (i + 1) + ' references ' + name + ' -> ' + lines[i].trim());
      }
    }
  }
  assert.deepStrictEqual(violations, [],
    'impurity detected — portable shared modules must stay clock-free and deterministic:\n' +
    violations.join('\n'));
});

test('gate teeth: flags canvas ctx and bare console, but not a guarded console', () => {
  assert.deepStrictEqual(lineViolations('ctx.fillRect(0, 0, 10, 10);'), ['ctx.'],
    'a canvas ctx.* line must trip the gate');
  assert.deepStrictEqual(lineViolations('console.log("hi");'), ['unguarded console'],
    'a bare console.* line must trip the gate');
  assert.deepStrictEqual(
    lineViolations("if (typeof console !== 'undefined' && console.log) console.log('hi');"), [],
    'a single-line guarded console call must pass the gate');
});

test('Math.random remains allowed (only as a default-seed source)', () => {
  // Math.random IS present (default seed). If a future edit wrongly adds it to
  // FORBIDDEN this fails, proving the allowance is deliberate, not accidental.
  const present = PORTABLE_MODULES.some((mod) =>
    /\bMath\.random\b/.test(fs.readFileSync(path.join(ROOT, mod), 'utf8')));
  assert.ok(present, 'expected Math.random to exist in a portable module (default seed)');
  assert.ok(!FORBIDDEN.some((p) => p.name.includes('Math.random')),
    'Math.random must not be in the forbidden set');
});
