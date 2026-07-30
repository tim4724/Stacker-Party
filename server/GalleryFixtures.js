'use strict';

// UMD: works in Node.js (require), the browser (window.GameEngine.GalleryFixtures),
// and JavaScriptCore/QuickJS on native (tvOS / Android TV). Pure: no wall clock,
// no timers, no DOM, no I/O.
//
// Canonical fixture data for the cross-platform screen gallery
// (scripts/gallery/). Every platform that renders the display — the web test
// harness, tvOS HEXSHOT states, and the Android Roborazzi screenshot tests —
// draws THIS data, so a visual difference between gallery columns is always a
// renderer difference, never a fixture difference.
//
// Game boards are built by depositing a realistic mid-game stack (dense rows,
// each kept un-clearable by construction) and then driving the real engine
// (PartyCore) with a fixed seed and a scripted drop sequence on top. All three
// platforms execute this same module inside their JS engine (byte-exact per
// the frame-golden conformance tests), so the boards are identical by
// construction.
(function(exports) {

var PartyCore = ((typeof require !== 'undefined') ? require('./PartyCore.js') : window.GameEngine).PartyCore;
var GameConstants = ((typeof require !== 'undefined') ? require('./constants.js') : window.GameConstants);
var PieceModule = (typeof require !== 'undefined') ? require('./Piece.js') : window.PieceModule;

var COLS = GameConstants.COLS;
var TOTAL_ROWS = GameConstants.TOTAL_ROWS;

var SEED = 4207;

// Deterministic PRNG (mulberry32) for fixture placement data — Math.random is
// reserved for the engine's default-seed path and would break reproducibility.
function _rng(seed) {
  var s = seed >>> 0;
  return function() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Join-target data for the lobby shots: a clean CTA with no fake room code
// (the pill reads the bare host, the QR encodes qrText), matching the ad-clip
// lobby. qrText also seeds the per-board rejoin QR (+ ?claim=<peerIndex>).
var JOIN = {
  host: 'hexstacker.com',
  code: '',
  qrText: 'https://hexstacker.com'
};

// Slot order == color index order. Levels are the lobby-badge variety; game
// board levels come from the variant spec instead.
var NAMES = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];
// CouchPad-style auto names at/near the 16-char cap (the controller
// input's maxlength), for the long-names gallery rows: every platform
// renders its shrink-to-fit name path against the same worst case.
var LONG_NAMES = ['Fabulous Chicken', 'Grumpy Flamingo', 'Majestic Warthog', 'Sneaky Capybara',
                  'Bouncy Axolotl', 'Mighty Pigeon', 'Wobbly Ostrich', 'Zesty Armadillo'];
var LOBBY_LEVELS = [3, 1, 5, 2, 4, 6, 2, 1];

// Per-slot lines-counter salt: displayed lines = (level-1)*10 + salt, which
// keeps getLevel() = floor(lines/10) + startLevel pinned to the variant level
// while giving each board a distinct, plausible LINES readout.
var LINES_SALT = [4, 7, 2, 9, 6, 3, 8, 5];

function roster(count, longNames) {
  var names = longNames ? LONG_NAMES : NAMES;
  var n = Math.max(0, Math.min(count, names.length));
  var list = [];
  for (var i = 0; i < n; i++) {
    list.push({ id: i, slot: i, name: names[i], level: LOBBY_LEVELS[i] });
  }
  return list;
}

// Named board-state variants — the single source for every gallery game row.
// levels: per-board displayed level (drives the NORMAL/PILLOW/NEON tier).
// ko: slots topped out after the scripted drops. garbage: pending-meter lines.
var VARIANTS = {
  'solo': { players: 1, levels: [1],              elapsed: 75000 },
  'lv1':  { players: 4, levels: [1, 1, 1, 1],     elapsed: 75000 },
  'lv8':  { players: 4, levels: [8, 8, 8, 8],     elapsed: 75000 },
  'lv12': { players: 4, levels: [12, 12, 12, 12], elapsed: 75000 },
  '2p':   { players: 2, levels: [3, 5],           garbage: { 1: 3 }, elapsed: 83000 },
  '3p':   { players: 3, levels: [1, 8, 4],        elapsed: 47000 },
  '4p':   { players: 4, levels: [3, 9, 1, 7],     elapsed: 132000 },
  '8p':   { players: 8, levels: [3, 9, 12, 1, 5, 8, 2, 12], ko: [5], garbage: { 1: 3, 6: 2 }, elapsed: 154000 }
};

function gameVariant(name) {
  var v = VARIANTS[name];
  return v ? JSON.parse(JSON.stringify(v)) : null;
}

// Advance the frame clock in cap-sized steps so line clears resolve between
// drop rounds (LINE_CLEAR_DELAY_MS < 400) without tripping MAX_FRAME_DELTA_MS.
function step(pc, clock, ms) {
  var stepMs = PartyCore.MAX_FRAME_DELTA_MS;
  for (var t = 0; t < ms; t += stepMs) {
    clock.now += stepMs;
    pc.frame(clock.now);
  }
}

// Deposit a realistic mid-game stack straight into a board's grid. Players
// race to complete rows, so a live stack is dense at the bottom with only a
// hole or two per row and a ragged crest — and it never contains a completed
// line (the engine would have cleared it). Every deposited row keeps at least
// one gap in an EVEN column, which breaks both zigzag orientations through
// that row (a down-zigzag needs every column filled at row r, an up-zigzag
// needs the even columns at row r), so no deposited row is clearable by
// construction. Cell colors run in short same-color streaks so the fill reads
// as locked pieces rather than confetti.
function _depositStack(grid, rnd, rows) {
  var numTypes = GameConstants.PIECE_TYPES.length;
  var evenCols = (COLS + 1) >> 1;
  var top = TOTAL_ROWS - rows;
  var color = 1 + Math.floor(rnd() * numTypes);
  for (var r = TOTAL_ROWS - 1; r >= top; r--) {
    var fromCrest = r - top;
    for (var c = 0; c < COLS; c++) {
      if (rnd() < 0.45) color = 1 + Math.floor(rnd() * numTypes);
      grid[r][c] = color;
    }
    grid[r][2 * Math.floor(rnd() * evenCols)] = 0;
    // Extra holes: near-solid at depth, ragged toward the crest.
    var extras = fromCrest === 0 ? 2 + Math.floor(rnd() * 3)
               : fromCrest === 1 ? 1 + Math.floor(rnd() * 2)
               : fromCrest < 4 ? Math.floor(rnd() * 2)
               : (rnd() < 0.35 ? 1 : 0);
    for (var e = 0; e < extras; e++) {
      grid[r][Math.floor(rnd() * COLS)] = 0;
    }
  }
  // The hole punching can strand a cell with nothing underneath — possible in
  // play but it reads as a glitch in a still image. A hex rests on the cell
  // directly below plus its two lower diagonal neighbours; odd columns sit
  // half a hex lower, so an even column's lower diagonals are the SAME-row
  // odd cells while an odd column's are in the row below. Sweep bottom-up,
  // odd columns before even ones (their rests are already final), dropping
  // anything unsupported so removals cascade to cells that rested on them.
  for (var sr = TOTAL_ROWS - 2; sr >= top; sr--) {
    for (var parity = 1; parity >= 0; parity--) {
      for (var sc = parity; sc < COLS; sc += 2) {
        if (grid[sr][sc] === 0) continue;
        var below = sr + parity; // odd cols rest on the row below, even on their own row
        var supported = grid[sr + 1][sc] !== 0 ||
          (sc > 0 && grid[below][sc - 1] !== 0) ||
          (sc < COLS - 1 && grid[below][sc + 1] !== 0);
        if (!supported) grid[sr][sc] = 0;
      }
    }
  }
}

// Build one deterministic mid-game snapshot for a variant spec:
//   { players, levels?|level?, ko?, garbage?, elapsed? }
// Each board gets a deposited stack (see _depositStack), then a few real
// engine drops settle on top so the crest, hold slot and piece queues come
// from actual play. All boards run at startLevel 1 (identical gravity) and
// the stack seed depends only on the slot, so the tier variants share the
// same board shapes and differ only in level styling — mirroring how the web
// gallery's tier cards have always compared.
function gameSnapshot(spec) {
  var count = spec.players;
  var levels = [];
  for (var li = 0; li < count; li++) {
    levels.push(spec.levels ? spec.levels[li] : (spec.level || 1));
  }
  var ko = spec.ko || [];

  var rosterMap = new Map();
  for (var ri = 0; ri < count; ri++) rosterMap.set(ri, { startLevel: 1 });
  var pc = new PartyCore(rosterMap, SEED);
  pc.init();
  var clock = { now: 0 };
  pc.frame(0); // prime the frame clock

  for (var di = 0; di < count; di++) {
    var dBoard = pc.game.boards.get(di);
    var rnd = _rng((SEED + 77) ^ Math.imul(di + 1, 2654435761));
    // KO boards fill nearly to the top so the top-out below reads as a real
    // death; live boards vary between a modest and a threatening stack.
    var rows = ko.indexOf(di) >= 0 ? 12 : 5 + Math.floor(rnd() * 4);
    _depositStack(dBoard.grid, rnd, rows);
    dBoard.gridVersion++;
  }

  for (var k = 0; k < 3; k++) {
    for (var i = 0; i < count; i++) {
      if (ko.indexOf(i) >= 0) continue; // KO boards top out separately below
      var rot = (k + i) % 3;
      for (var r = 0; r < rot; r++) pc.processInput(i, 'rotate_cw');
      var shift = ((k * 5 + i * 3) % 9) - 4;
      for (var s = 0; s < Math.abs(shift); s++) {
        pc.processInput(i, shift < 0 ? 'left' : 'right');
      }
      if (k === 1 && i % 2 === 0) pc.processInput(i, 'hold');
      pc.processInput(i, 'hard_drop');
    }
    step(pc, clock, 400);
  }

  // Top out KO'd boards: hard-drop onto the near-full deposited stack until
  // the spawn area is blocked.
  for (var kj = 0; kj < ko.length; kj++) {
    var koBoard = pc.game.boards.get(ko[kj]);
    var guard = 0;
    while (koBoard && koBoard.alive && guard++ < 60) {
      pc.processInput(ko[kj], 'hard_drop');
      step(pc, clock, 50);
    }
  }

  // Pending-garbage meters.
  if (spec.garbage) {
    for (var gSlot in spec.garbage) {
      var b = pc.game.boards.get(parseInt(gSlot, 10));
      if (b && b.alive) {
        b.addPendingGarbage(spec.garbage[gSlot], (parseInt(gSlot, 10) * 3 + 5) % GameConstants.COLS);
      }
    }
  }

  // Pin each board's displayed level/lines to the variant spec (level is
  // derived as floor(lines/10) + startLevel with startLevel 1).
  for (var pi = 0; pi < count; pi++) {
    var board = pc.game.boards.get(pi);
    if (board) board.lines = (levels[pi] - 1) * 10 + LINES_SALT[pi];
  }

  var snap = pc.snapshot();
  snap.elapsed = (spec.elapsed != null) ? spec.elapsed : 75000;
  return snap;
}

// Frozen placements for the falling-piece welcome/lobby background, shared by
// every platform's gallery shots. The live animation differs per platform in
// WHEN pieces are on screen (web spawns its pool above the viewport, tvOS
// pre-seeds across it), so a timed capture freezes each at a different moment;
// rendering this fixed steady-state frame instead makes the lobby columns
// comparable. Reference space is 1920x1080, y-down; consumers scale to their
// viewport. cells are engine-rotated axial [q, r] offsets; typeId indexes the
// shared piece palette; size is the hex circumradius; opacity matches the live
// animation's 0.14-0.22 band.
function ambientPieces() {
  var rnd = _rng(9151);
  var keys = Object.keys(PieceModule.PIECES);
  var SIZES = [12, 16, 20, 24, 28, 32];
  var COLS = 4, ROWS = 4;
  var W = 1920;
  var Y_TOP = -60, Y_SPAN = 1200; // spill past both edges so the frame reads mid-fall
  var cellW = W / COLS;
  var cellH = Y_SPAN / ROWS;
  var list = [];
  for (var r = 0; r < ROWS; r++) {
    for (var c = 0; c < COLS; c++) {
      var key = keys[Math.floor(rnd() * keys.length)];
      var rot = Math.floor(rnd() * 6);
      var cells = PieceModule.PIECES[key];
      for (var k = 0; k < rot; k++) {
        var next = [];
        for (var i = 0; i < cells.length; i++) {
          // rotateCW in axial: (q, r) -> (-r, q + r), matching the engine.
          next.push([-cells[i][1], cells[i][0] + cells[i][1]]);
        }
        cells = next;
      }
      var copy = [];
      for (var j = 0; j < cells.length; j++) copy.push([cells[j][0], cells[j][1]]);
      list.push({
        typeId: GameConstants.PIECE_TYPE_TO_ID[key],
        cells: copy,
        x: cellW * (c + 0.1 + rnd() * 0.8),
        y: Y_TOP + cellH * (r + 0.1 + rnd() * 0.8),
        size: SIZES[Math.floor(rnd() * SIZES.length)],
        opacity: 0.14 + rnd() * 0.08
      });
    }
  }
  return list;
}

// Canonical results roster — the exact ranking the web harness has always
// rendered (rank i+1, lines 30-3i, level counting down to 1).
function results(count, longNames) {
  var names = longNames ? LONG_NAMES : NAMES;
  var n = Math.max(1, Math.min(count, names.length));
  var list = [];
  for (var i = 0; i < n; i++) {
    list.push({
      playerId: i,
      playerName: names[i],
      colorIndex: i,
      rank: i + 1,
      lines: 30 - i * 3,
      level: 1 + (n - 1 - i)
    });
  }
  return { elapsed: 123456, results: list };
}

exports.GalleryFixtures = {
  SEED: SEED,
  JOIN: JOIN,
  NAMES: NAMES,
  LONG_NAMES: LONG_NAMES,
  roster: roster,
  gameVariant: gameVariant,
  gameSnapshot: gameSnapshot,
  ambientPieces: ambientPieces,
  results: results
};

})(typeof module !== 'undefined' ? module.exports : (window.GameEngine = window.GameEngine || {}));
