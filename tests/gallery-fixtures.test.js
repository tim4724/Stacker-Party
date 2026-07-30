'use strict';

// GalleryFixtures is the single fixture source for the cross-platform screen
// gallery (scripts/gallery/): every platform renders these snapshots, so they
// must be deterministic (same output on every call — the cross-engine
// byte-exactness itself is covered by the frame-golden conformance tests) and
// hold the invariants the variant specs promise (levels, KO, garbage meters).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GalleryFixtures } = require('../server/GalleryFixtures');
const GameConstants = require('../server/constants');

const VARIANT_NAMES = ['solo', 'lv1', 'lv8', 'lv12', '2p', '3p', '4p', '8p'];

test('roster is stable and slot == colorIndex == id', () => {
  const r = GalleryFixtures.roster(8);
  assert.equal(r.length, 8);
  assert.deepEqual(r.map((p) => p.name), GalleryFixtures.NAMES);
  for (let i = 0; i < r.length; i++) {
    assert.equal(r[i].id, i);
    assert.equal(r[i].slot, i);
  }
});

test('long-name roster stresses the 16-char cap without exceeding it', () => {
  const r = GalleryFixtures.roster(8, true);
  assert.deepEqual(r.map((p) => p.name), GalleryFixtures.LONG_NAMES);
  // 16 is the platform-wide cap (controller input maxlength / CouchPad
  // sanitizer); the fixture must hit it to exercise shrink-to-fit, never pass it.
  for (const name of GalleryFixtures.LONG_NAMES) {
    assert.ok(name.length <= 16, `${name} exceeds the 16-char cap`);
  }
  assert.ok(GalleryFixtures.LONG_NAMES.some((n) => n.length === 16),
    'at least one fixture name must sit exactly at the 16-char cap');
  // Same levels as the short roster; only the names differ.
  assert.deepEqual(r.map((p) => p.level), GalleryFixtures.roster(8).map((p) => p.level));
});

test('every variant snapshot is deterministic and JSON-serializable', () => {
  for (const name of VARIANT_NAMES) {
    const spec = GalleryFixtures.gameVariant(name);
    assert.ok(spec, `unknown variant ${name}`);
    const a = GalleryFixtures.gameSnapshot(spec);
    const b = GalleryFixtures.gameSnapshot(GalleryFixtures.gameVariant(name));
    assert.deepEqual(a, JSON.parse(JSON.stringify(a)), `${name}: must be plain data`);
    assert.deepEqual(a, b, `${name}: two builds must be identical`);
  }
});

test('variant snapshots honour their spec (players, levels, ko, garbage, elapsed)', () => {
  for (const name of VARIANT_NAMES) {
    const spec = GalleryFixtures.gameVariant(name);
    const snap = GalleryFixtures.gameSnapshot(spec);
    assert.equal(snap.players.length, spec.players, `${name}: player count`);
    assert.equal(snap.elapsed, spec.elapsed, `${name}: elapsed`);
    for (let i = 0; i < spec.players; i++) {
      const p = snap.players[i];
      assert.equal(p.id, i, `${name}: ids are slot ints`);
      assert.equal(p.level, spec.levels[i], `${name}: board ${i} level`);
      const shouldBeKO = (spec.ko || []).includes(i);
      assert.equal(p.alive, !shouldBeKO, `${name}: board ${i} alive`);
      const wantGarbage = (spec.garbage || {})[i] || 0;
      if (wantGarbage) {
        assert.ok(p.pendingGarbage >= wantGarbage, `${name}: board ${i} garbage meter`);
      }
      const filled = p.grid.flat().filter((c) => c !== 0).length;
      assert.ok(filled > 10, `${name}: board ${i} has a visible stack (${filled} cells)`);
    }
  }
});

test('variant boards read as realistic play (dense, no clearable or full rows)', () => {
  const COLS = GameConstants.COLS;
  for (const name of VARIANT_NAMES) {
    const spec = GalleryFixtures.gameVariant(name);
    const snap = GalleryFixtures.gameSnapshot(spec);
    for (let i = 0; i < snap.players.length; i++) {
      const grid = snap.players[i].grid;
      // A completed line would have been cleared in a real game, so a
      // snapshot must never contain one — neither a full flat row nor any
      // clearable zigzag.
      for (let r = 0; r < grid.length; r++) {
        assert.ok(grid[r].some((c) => c === 0), `${name}: board ${i} row ${r} is completely filled`);
      }
      const res = GameConstants.findClearableZigzags(
        COLS, grid.length, (col, row) => grid[row][col] !== 0, null, 0);
      assert.equal(res.linesCleared, 0, `${name}: board ${i} has ${res.linesCleared} clearable lines`);
      // Players fill from the bottom: the lowest rows carry only a few holes.
      const filled = grid.flat().filter((c) => c !== 0).length;
      assert.ok(filled >= 40, `${name}: board ${i} stack too sparse (${filled} cells)`);
      for (let r = grid.length - 3; r < grid.length; r++) {
        const rowFilled = grid[r].filter((c) => c !== 0).length;
        assert.ok(rowFilled >= COLS - 3, `${name}: board ${i} bottom row ${r} too sparse (${rowFilled}/${COLS})`);
      }
      // No lone hex floating in the air: every filled cell above the floor
      // touches at least one other filled cell (odd columns sit half a hex
      // lower, so the diagonal neighbours' row depends on column parity).
      const at = (col, row) =>
        col >= 0 && col < COLS && row >= 0 && row < grid.length && grid[row][col] !== 0;
      for (let r = 0; r < grid.length - 1; r++) {
        for (let c = 0; c < COLS; c++) {
          if (grid[r][c] === 0) continue;
          const dr = (c & 1) ? 1 : 0;
          const touching = at(c, r - 1) || at(c, r + 1) ||
            at(c - 1, r - 1 + dr) || at(c + 1, r - 1 + dr) ||
            at(c - 1, r + dr) || at(c + 1, r + dr);
          assert.ok(touching, `${name}: board ${i} has an isolated cell at [${c}, ${r}]`);
        }
      }
    }
  }
});

test('ambient pieces are deterministic and inside the 1920x1080 reference band', () => {
  const a = GalleryFixtures.ambientPieces();
  const b = GalleryFixtures.ambientPieces();
  assert.deepEqual(a, b, 'two calls must be identical');
  assert.equal(a.length, 16);
  for (const p of a) {
    assert.ok(Number.isInteger(p.typeId) && p.typeId >= 1, 'typeId is a palette index');
    assert.ok(Array.isArray(p.cells) && p.cells.length >= 3, 'cells carry a piece shape');
    assert.ok(p.x >= 0 && p.x <= 1920, `x in range (${p.x})`);
    assert.ok(p.y >= -80 && p.y <= 1160, `y in the spill band (${p.y})`);
    assert.ok([12, 16, 20, 24, 28, 32].includes(p.size), 'size from the discrete set');
    assert.ok(p.opacity >= 0.14 && p.opacity <= 0.22, 'opacity in the live band');
  }
});

test('results mirror the historic web ranking formula', () => {
  const r = GalleryFixtures.results(4);
  assert.equal(r.results.length, 4);
  assert.deepEqual(r.results.map((x) => x.rank), [1, 2, 3, 4]);
  assert.deepEqual(r.results.map((x) => x.lines), [30, 27, 24, 21]);
  assert.deepEqual(r.results.map((x) => x.level), [4, 3, 2, 1]);
  const solo = GalleryFixtures.results(1);
  assert.equal(solo.results.length, 1);
  assert.equal(solo.results[0].playerName, 'Emma');
});

test('long-name results swap only the names', () => {
  const short = GalleryFixtures.results(4);
  const long = GalleryFixtures.results(4, true);
  assert.deepEqual(long.results.map((x) => x.playerName), GalleryFixtures.LONG_NAMES.slice(0, 4));
  assert.deepEqual(
    long.results.map(({ playerName, ...rest }) => rest),
    short.results.map(({ playerName, ...rest }) => rest));
});
