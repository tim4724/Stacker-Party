'use strict';

// UMD: works in Node.js (require), the browser (window.GameEngine.PartyCore),
// and JavaScriptCore/QuickJS on native (tvOS / Android TV). Pure: no wall clock,
// no timers, no DOM, no I/O — time is injected via nowMs.
//
// PartyCore WRAPS a stateful Game and exposes the PULL-ONLY native integration
// surface. It inverts Game's host-callback push (onEvent/onGameEnd) into a
// drained, ordered, plain-serializable events array; returns a VALUE-COPY
// snapshot (deep-cloning the live mutable refs Game.getSnapshot hands back so a
// host can RETAIN it across frames); and normalizes this frame's events +
// snapshot into a host-effect commands list (no protocol.js coupling — the host
// maps type -> MSG/sendTo/animation).
//
// frame(nowMs) wraps the ENGINE per-frame work only. RoomFlow liveness is a
// separate 1Hz pull and is deliberately NOT folded in here (folding a 1Hz
// decision into the 60Hz frame would change its cadence and force a
// server/->partyplug/ dependency). update()/snapshot()/drainEvents() stay
// individually callable for the native granular path.
(function(exports) {

var Game = ((typeof require !== 'undefined') ? require('./Game.js') : window.GameEngine).Game;
var GameConstants = ((typeof require !== 'undefined') ? require('./constants.js') : window.GameConstants);

// Cap frame delta to ~3 frames at 60Hz — prevents huge catch-up jumps after a
// tab unfreeze / native app resume. Sourced from the shared constants module so
// the web rAF loop and this native frame() cap can't drift; re-exported below as
// PartyCore.MAX_FRAME_DELTA_MS for the native contract.
var MAX_FRAME_DELTA_MS = GameConstants.MAX_FRAME_DELTA_MS;

// JSON round-trip clone. Engine events are plain serializable data, so this both
// de-aliases the live refs Game hands to onEvent and guarantees a host-portable
// payload.
function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// Deep value-copy of one Game.getSnapshot() player state. getSnapshot returns
// LIVE MUTABLE references — grid rows aliased to the board, currentPiece.blocks /
// ghost.blocks reuse per-call scratch arrays, clearingCells a board cache — so a
// host that retains a snapshot across frames MUST copy every such ref. Scalars
// are copied by value. cells {q,r} objects are deep-copied (like blocks) so a host
// writing into a retained snapshot can never reach the engine's live Piece.
// [skipGrid] omits the grid entirely rather than copying it — for a delivery caller that
// already knows this seat's gridVersion is unchanged and would strip it straight back off.
// The field is ABSENT, not empty, which is exactly what _stripUnchangedGrids leaves behind,
// so both paths produce the same shape on the wire.
function copyPlayer(s, skipGrid) {
  var out = {
    id: s.id,
    // Built in place, then removed when unwanted, rather than appended at the end:
    // the frame golden hashes JSON.stringify(player), so moving `grid` would drift the
    // fixture for a change that alters no value. `delete` is what _stripUnchangedGrids
    // does to the same field anyway.
    grid: skipGrid ? null : s.grid.map(function(row) { return row.slice(); }),
    currentPiece: s.currentPiece ? {
      type: s.currentPiece.type,
      typeId: s.currentPiece.typeId,
      anchorCol: s.currentPiece.anchorCol,
      anchorRow: s.currentPiece.anchorRow,
      cells: s.currentPiece.cells.map(function(c) { return { q: c.q, r: c.r }; }),
      blocks: s.currentPiece.blocks.map(function(b) { return [b[0], b[1]]; })
    } : null,
    ghost: s.ghost ? {
      // The ghost's type always equals the current piece's; surfaced on the
      // snapshot so a native renderer can color the ghost without reaching into
      // currentPiece (the frame() snapshot is the native contract).
      typeId: s.currentPiece ? s.currentPiece.typeId : null,
      anchorCol: s.ghost.anchorCol,
      anchorRow: s.ghost.anchorRow,
      blocks: s.ghost.blocks.map(function(b) { return [b[0], b[1]]; })
    } : null,
    holdPiece: s.holdPiece,
    nextPieces: s.nextPieces.slice(),
    level: s.level,
    lines: s.lines,
    alive: s.alive,
    pendingGarbage: s.pendingGarbage,
    clearingCells: s.clearingCells
      ? s.clearingCells.map(function(c) { return [c[0], c[1]]; })
      : null,
    gridVersion: s.gridVersion
  };
  if (skipGrid) delete out.grid;
  return out;
}

function PartyCore(players, seed) {
  var self = this;
  this._buf = [];
  this._prevNowMs = null;
  // Delivery ledgers — see deliverFrame/deliverSnapshot. Per-instance, so a new
  // match starts with both cleared and neither can leak across games.
  this._sentGridVersions = {};
  this._lastSceneSig = null;
  // Game pushes synchronously into our buffer; we surface it on the next drain.
  // This inverts the host-callback push into a PULL-ONLY drained array, folding
  // the SEPARATE onGameEnd terminal callback into the same ordered buffer.
  this.game = new Game(players, {
    onEvent: function(e) { self._buf.push(clone(e)); },
    onGameEnd: function(r) {
      self._buf.push(clone({ type: 'game_end', elapsed: r.elapsed, results: r.results }));
    }
  }, seed);
}

PartyCore.MAX_FRAME_DELTA_MS = MAX_FRAME_DELTA_MS;

PartyCore.prototype.init = function() {
  return this.game.init();
};

// Input passthroughs. Their synchronous engine events accumulate in _buf and
// surface at the next drainEvents()/frame() — matching the web's between-frame
// processInput accumulation.
PartyCore.prototype.processInput = function(playerId, action) {
  return this.game.processInput(playerId, action);
};
PartyCore.prototype.handleSoftDropStart = function(playerId, speed) {
  return this.game.handleSoftDropStart(playerId, speed);
};
PartyCore.prototype.handleSoftDropEnd = function(playerId) {
  return this.game.handleSoftDropEnd(playerId);
};
PartyCore.prototype.pause = function() {
  return this.game.pause();
};
PartyCore.prototype.resume = function() {
  return this.game.resume();
};
// Cross-device mid-game rejoin: re-key a participant's engine state (board,
// garbage, cooldown) from oldId to newId. The host (display) calls this when a
// dropped player reclaims their slot under a new peer index.
PartyCore.prototype.rekeyPlayer = function(oldId, newId) {
  var ok = this.game.rekeyPlayer(oldId, newId);
  if (ok) {
    // The board moved ids, so both delivery ledgers are stale: forget the sent
    // grid versions (the next delivery re-sends full rows under the new id) and
    // void the scene signature (it keys on player ids).
    delete this._sentGridVersions[oldId];
    delete this._sentGridVersions[newId];
    this._lastSceneSig = null;
  }
  return ok;
};

// Individually callable; native ticks the engine at vsync. Game.update
// self-gates on paused/ended.
PartyCore.prototype.update = function(deltaMs) {
  return this.game.update(deltaMs);
};

// Returns the accumulated events in emission order and resets the buffer.
PartyCore.prototype.drainEvents = function() {
  var buf = this._buf;
  this._buf = [];
  return buf;
};

// VALUE-COPY snapshot (deep-clones the live refs getSnapshot returns) so a host
// can retain it across frames. Native calls this only on gridVersion change; web
// keeps the zero-copy live-ref getSnapshot path for its within-frame render.
PartyCore.prototype.snapshot = function() {
  var snap = this.game.getSnapshot();
  return {
    // NOT `.map(copyPlayer)`: map passes (element, index, array), and the index would
    // land on copyPlayer's skipGrid parameter — dropping the grid for every seat but
    // the first.
    players: snap.players.map(function(p) { return copyPlayer(p); }),
    elapsed: snap.elapsed
  };
};

// Value-copy snapshot of ONE seat, same shape as snapshot() with `players`
// narrowed to that player. A controller input moves exactly one board, so a host
// reflecting it does not need the whole room deep-copied: on an 8-player TV that
// pull is ~9ms (copy + stringify + native decode) against ~2.7ms for one seat,
// which at 60Hz is the difference between fitting in the frame and not.
// Returns null when the id owns no board (a spectator, or a stale peer index).
//
// [sentGridVersions] is optional and is the delivery caller's grid ledger: when given, a
// seat whose gridVersion it already holds is copied WITHOUT its grid, so the 135 cells are
// never duplicated only for _stripUnchangedGrids to delete them a moment later. Callers
// that want a complete value-copy (a host retaining a snapshot) pass nothing and get one.
PartyCore.prototype.snapshotPlayer = function(playerId, sentGridVersions) {
  var snap = this.game.getSnapshot();
  for (var i = 0; i < snap.players.length; i++) {
    var live = snap.players[i];
    if (live.id !== playerId) continue;
    var skipGrid = !!sentGridVersions && sentGridVersions[live.id] === live.gridVersion;
    return { players: [copyPlayer(live, skipGrid)], elapsed: snap.elapsed };
  }
  return null;
};

// =====================================================================
// Packed snapshot wire format — the JS<->native boundary only.
//
// The boundary, not the simulation, is what costs a frame: at eight boards the
// physics is ~0.5ms while JSON.stringify plus the native decode is ~11ms, and
// ~8ms of that is the decode rebuilding grids and per-cell objects the renderer
// immediately flattens again. Every field in a snapshot is a small integer, so
// the boundary can carry one integer per UTF-16 code unit instead. Measured on a
// Google TV Streamer, eight boards: decode 8.4ms -> 0.06ms, payload 5490 -> 1211.
//
// Web never uses this and must not: it has no boundary at all — its renderer
// reads the live getSnapshot() refs out of the same heap — so packing there would
// be pure added work.
//
// Three invariants the format depends on:
//   * EVERY value is biased +1 on the way out. Both native bridges hand JS
//     strings over as C strings, so a NUL code unit TRUNCATES the payload — and 0
//     is the most common value here (every empty grid cell).
//   * That bias is also why the wire range STOPS at MAX_WIRE (0xd7fe), well
//     short of 0xffff. Two cliffs sit above it. String.fromCharCode takes its
//     argument mod 0x10000, so a raw 0xffff biases to 0x10000 and comes back out
//     as the very NUL the bias exists to avoid. And biased values 0xd800..0xdfff
//     are lone UTF-16 surrogates, which the JS-to-native string marshalling is
//     not guaranteed to preserve (JSC's C-string conversion substitutes U+FFFD).
//     Values wider than one code unit are therefore split into FIFTEEN-bit
//     halves, not sixteen: a 16-bit half is exactly the one that can land on
//     0xffff. `elapsed` reached it 65.5s into every match (and every 65.5s after),
//     which truncated the frame on both TVs. encodeInts asserts the range so a
//     future field that outgrows it fails here rather than on a TV.
//   * Coordinates go negative while a piece is still in the spawn buffer, so they
//     are biased by COORD_BIAS before that.
//
// Lossy in exactly one place, on purpose: `elapsed` is delivered at whole-ms
// precision. Its only consumers floor it to seconds (the match timer, and
// sceneSig), so the fraction has no reader — and spending two more code units per
// frame to carry it would be pure overhead.
//
// Layout (values shown pre-bias):
//   [0] PACK_VERSION
//   [1] 1 if a snapshot follows, else 0
//   when present: [2] count>>15, [3] count & 0x7fff, then `count` values
//   then the JSON tail, {events, commands}, as plain ASCII
//
// unpackFrame below is the REFERENCE decoder: the Kotlin and Swift readers are
// ports of it, and tests/partycore-packed.test.js gates pack->unpack round trips
// over the whole frame-golden corpus.
// =====================================================================

var PACK_VERSION = 2;
var COORD_BIAS = 256;
// Widest RAW value one code unit can carry: 0xd7fe biases to 0xd7ff, the last
// code unit below the UTF-16 surrogate block (0xd800..0xdfff). A lone surrogate
// is not guaranteed to survive the JS-to-native string marshalling (JSC's
// C-string conversion substitutes U+FFFD), and past the block the +1 bias turns
// a raw 0xffff into a NUL (see above), so the range stops under the block. No
// real field gets close: split halves max out at 0x7fff and everything else is
// small. This exists so a future field that outgrows the range fails in the
// packer instead of corrupting a frame on a TV.
var MAX_WIRE = 0xd7fe;
// Values too wide for one code unit ride as two 15-bit halves — 30 bits, which is
// 12 days of `elapsed` in ms and far past any reachable lines/gridVersion count.
var SPLIT_SHIFT = 15;
var SPLIT_MASK = 0x7fff;
var PIECE_TYPES = GameConstants.PIECE_TYPES;
var PIECE_TYPE_TO_ID = GameConstants.PIECE_TYPE_TO_ID;

// Push a value too wide for one code unit as two 15-bit halves, high first.
// Checked here rather than left to encodeInts: the masks below would fold an
// oversized value into two perfectly legal-looking halves, so it would sail past
// the range guard and come back out as a different number.
var MAX_SPLIT = (1 << (SPLIT_SHIFT * 2)) - 1;
function packSplit(out, v) {
  if (!(v >= 0 && v <= MAX_SPLIT)) {
    throw new RangeError('packFrame: value ' + v + ' outside split range 0..' + MAX_SPLIT);
  }
  out.push((v >> SPLIT_SHIFT) & SPLIT_MASK, v & SPLIT_MASK);
}

function packCells(out, cells) {
  out.push(cells.length);
  for (var i = 0; i < cells.length; i++) {
    out.push(cells[i][0] + COORD_BIAS, cells[i][1] + COORD_BIAS);
  }
}

function packPlayer(out, p) {
  out.push(p.id, p.level);
  packSplit(out, p.lines);
  out.push(p.alive ? 1 : 0, p.pendingGarbage);
  packSplit(out, p.gridVersion);
  // Absent whenever _stripUnchangedGrids dropped it; dimensions ride along so a
  // reader never has to assume the board size.
  if (p.grid) {
    out.push(1, p.grid.length, p.grid.length ? p.grid[0].length : 0);
    for (var r = 0; r < p.grid.length; r++) {
      var row = p.grid[r];
      for (var c = 0; c < row.length; c++) out.push(row[c]);
    }
  } else {
    out.push(0);
  }
  var cp = p.currentPiece;
  if (cp) {
    out.push(1, cp.typeId, cp.anchorCol + COORD_BIAS, cp.anchorRow + COORD_BIAS);
    out.push(cp.cells.length);
    for (var i = 0; i < cp.cells.length; i++) {
      out.push(cp.cells[i].q + COORD_BIAS, cp.cells[i].r + COORD_BIAS);
    }
    packCells(out, cp.blocks);
  } else {
    out.push(0);
  }
  var g = p.ghost;
  if (g) {
    out.push(1, g.typeId == null ? 0 : g.typeId,
             g.anchorCol + COORD_BIAS, g.anchorRow + COORD_BIAS);
    packCells(out, g.blocks);
  } else {
    out.push(0);
  }
  out.push(p.holdPiece ? PIECE_TYPE_TO_ID[p.holdPiece] : 0);
  out.push(p.nextPieces.length);
  for (var n = 0; n < p.nextPieces.length; n++) out.push(PIECE_TYPE_TO_ID[p.nextPieces[n]]);
  if (p.clearingCells) {
    out.push(1);
    packCells(out, p.clearingCells);
  } else {
    out.push(0);
  }
}

function snapshotInts(snapshot) {
  var out = [];
  packSplit(out, Math.max(0, Math.floor(snapshot.elapsed)));
  out.push(snapshot.players.length);
  for (var i = 0; i < snapshot.players.length; i++) packPlayer(out, snapshot.players[i]);
  return out;
}

// Chunked: String.fromCharCode.apply blows its argument limit on a full frame.
function encodeInts(ints) {
  var parts = [];
  for (var i = 0; i < ints.length; i += 4096) {
    var chunk = ints.slice(i, i + 4096);
    for (var j = 0; j < chunk.length; j++) {
      var v = chunk[j];
      // The whole format rests on every code unit being non-NUL and lossless.
      // fromCharCode silently takes its argument mod 0x10000, so an out-of-range
      // value does not throw — it corrupts the frame on a TV, hours from here.
      if (!(v >= 0 && v <= MAX_WIRE)) {
        throw new RangeError('packFrame: value ' + v + ' outside wire range 0..' + MAX_WIRE);
      }
      chunk[j] = v + 1;
    }
    parts.push(String.fromCharCode.apply(null, chunk));
  }
  return parts.join('');
}

/**
 * Pack a `{ events, snapshot, commands }` frame for the native boundary.
 * `snapshot` may be absent (render-identical frame): then only the tail rides.
 */
PartyCore.packFrame = function(frame) {
  var head = [PACK_VERSION, frame.snapshot ? 1 : 0];
  var body = frame.snapshot ? snapshotInts(frame.snapshot) : null;
  if (body) packSplit(head, body.length);
  var tail = JSON.stringify({ events: frame.events, commands: frame.commands });
  return encodeInts(body ? head.concat(body) : head) + tail;
};

/** Reference decoder — the contract the Kotlin and Swift readers reproduce. */
PartyCore.unpackFrame = function(packed) {
  var at = 0;
  function next() { return packed.charCodeAt(at++) - 1; }
  var version = next();
  if (version !== PACK_VERSION) throw new Error('unpackFrame: version ' + version);
  var snapshot = null;
  if (next() === 1) {
    var count = readSplit(next);
    var bodyStart = at;
    snapshot = unpackSnapshot(next);
    // The reader must land exactly on the tail; anything else is a layout bug,
    // and silently trusting `count` would hide it behind a JSON parse error.
    if (at !== bodyStart + count) {
      throw new Error('unpackFrame: read ' + (at - bodyStart) + ' of ' + count);
    }
  }
  var tail = JSON.parse(packed.slice(at));
  return { events: tail.events, snapshot: snapshot, commands: tail.commands };
};

/** Reassemble a value the packer split into two 15-bit halves, high first. */
function readSplit(next) {
  var hi = next();
  return (hi << SPLIT_SHIFT) | next();
}

function unpackCells(next) {
  var out = [];
  for (var i = next(); i > 0; i--) out.push([next() - COORD_BIAS, next() - COORD_BIAS]);
  return out;
}

function unpackSnapshot(next) {
  var elapsed = readSplit(next);
  var players = [];
  for (var i = next(); i > 0; i--) players.push(unpackPlayer(next));
  return { players: players, elapsed: elapsed };
}

function unpackPlayer(next) {
  var p = {
    id: next(),
    level: next(),
    lines: readSplit(next),
    alive: next() === 1,
    pendingGarbage: next(),
    gridVersion: readSplit(next)
  };
  if (next() === 1) {
    var rows = next(), cols = next(), grid = [];
    for (var r = 0; r < rows; r++) {
      var row = [];
      for (var c = 0; c < cols; c++) row.push(next());
      grid.push(row);
    }
    p.grid = grid;
  }
  if (next() === 1) {
    var typeId = next();
    var cp = {
      type: PIECE_TYPES[typeId - 1],
      typeId: typeId,
      anchorCol: next() - COORD_BIAS,
      anchorRow: next() - COORD_BIAS,
      cells: []
    };
    for (var ci = next(); ci > 0; ci--) cp.cells.push({ q: next() - COORD_BIAS, r: next() - COORD_BIAS });
    cp.blocks = unpackCells(next);
    p.currentPiece = cp;
  } else {
    p.currentPiece = null;
  }
  if (next() === 1) {
    var gt = next();
    p.ghost = {
      typeId: gt === 0 ? null : gt,
      anchorCol: next() - COORD_BIAS,
      anchorRow: next() - COORD_BIAS,
      blocks: unpackCells(next)
    };
  } else {
    p.ghost = null;
  }
  var hold = next();
  p.holdPiece = hold === 0 ? null : PIECE_TYPES[hold - 1];
  p.nextPieces = [];
  for (var ni = next(); ni > 0; ni--) p.nextPieces.push(PIECE_TYPES[next() - 1]);
  p.clearingCells = next() === 1 ? unpackCells(next) : null;
  return p;
}

/** deliverFrame, packed. Identical filtering; only the boundary payload differs. */
PartyCore.prototype.deliverFramePacked = function(nowMs) {
  return PartyCore.packFrame(this.deliverFrame(nowMs));
};

/** deliverSnapshot, packed (the out-of-band full pull). */
PartyCore.prototype.deliverSnapshotPacked = function() {
  return PartyCore.packFrame({ events: [], snapshot: this.deliverSnapshot(), commands: [] });
};

/** One seat, packed — the render-on-input path. null when the id owns no board. */
// Consults the grid ledger BEFORE copying rather than after. A render-on-input pull
// happens between locks, so the seat's gridVersion has almost always not moved and
// _stripUnchangedGrids would delete the grid again immediately — the old order
// deep-copied 135 cells per input to throw them straight away. Measured on a Google TV
// Streamer: ~0.13ms of every pull at two seats, ~0.08ms at eight.
PartyCore.prototype.deliverSnapshotPlayerPacked = function(playerId) {
  var snap = this.snapshotPlayer(playerId, this._sentGridVersions);
  if (!snap) return null;
  var p = snap.players[0];
  if (p.grid) this._sentGridVersions[p.id] = p.gridVersion;
  return PartyCore.packFrame({ events: [], snapshot: snap, commands: [] });
};

// Mirror DisplayRender prevFrameTime=0 on pause/results entry: the next frame()
// re-establishes the clock with a 0 delta instead of a huge resume jump.
PartyCore.prototype.resetFrameClock = function() {
  this._prevNowMs = null;
};

// Per-frame engine work. Caps nowMs -> deltaMs, ticks the engine (which
// self-gates on paused/ended), drains both onEvent and onGameEnd into one
// ordered events array, returns a value-copy snapshot and a normalized
// host-effect commands list. The host decides WHETHER to call frame() (only
// while playing && !paused, matching the web rAF loop) and calls
// resetFrameClock() when leaving the active loop.
PartyCore.prototype.frame = function(nowMs) {
  // Clamp to [0, cap]: Math.max guards a backward nowMs (a native clock reset or
  // app-resume hiccup) so a glitch can't produce a negative or oversized step.
  var deltaMs = this._prevNowMs == null
    ? 0
    : Math.min(Math.max(0, nowMs - this._prevNowMs), MAX_FRAME_DELTA_MS);
  this._prevNowMs = nowMs;
  if (deltaMs > 0) this.game.update(deltaMs);
  var events = this.drainEvents();
  var snapshot = this.snapshot();
  var commands = PartyCore.toCommands(events, snapshot);
  return { events: events, snapshot: snapshot, commands: commands };
};

// =====================================================================
// Delivery filter — what a native host actually receives per frame.
//
// frame()/snapshot() above are the complete truth. Handing all of it across the
// JS<->native boundary 60 times a second is mostly waste: the grid dominates the
// serialized payload but only changes on a lock/clear/garbage insert, and most
// frames are render-identical to the one before (pieces move in discrete cells).
// deliverFrame/deliverSnapshot apply both filters and carry the small ledgers
// that make them work.
//
// This lives HERE, not in each host's bootstrap shim, because it is the same
// decision on every platform and it drifted once already: the Android shim grew
// the scene-signature skip while the tvOS one kept re-serializing every frame,
// and nothing caught it (each platform only tested its own copy). The shims are
// now thin marshalling, gated token-identical by
// tests/room-bridge-shim-parity.test.js.
// =====================================================================

// Signature of everything a renderer draws FROM A SNAPSHOT. Two frames with the
// same signature paint the same picture, so the second needn't be delivered.
// PURE (no instance state), so a host can call it on any snapshot.
//
// Derived values are covered by their sources: ghost and nextPieces follow the
// current piece and gridVersion, and clearingCells only change alongside a
// gridVersion bump. cells[0] uniquely identifies rotation for every hex piece
// type (the same invariant the web clear-preview cache relies on). Time-driven
// visuals (near-clear pulse, clearing glow, effects) are deliberately EXCLUDED:
// hosts treat those as "must animate" and keep drawing without new snapshots.
// The elapsed term repaints the match timer once per second.
PartyCore.sceneSig = function(snapshot) {
  var sig = '' + Math.floor(snapshot.elapsed / 1000);
  for (var i = 0; i < snapshot.players.length; i++) {
    var p = snapshot.players[i];
    sig += '|' + p.id + ':' + (p.alive ? 1 : 0) + ':' + p.lines + ':' + p.level
      + ':' + p.pendingGarbage + ':' + p.gridVersion + ':' + (p.holdPiece || '');
    var cp = p.currentPiece;
    if (cp) sig += ':' + cp.typeId + ':' + cp.anchorCol + ':' + cp.anchorRow
      + ':' + cp.cells[0].q + ':' + cp.cells[0].r;
  }
  return sig;
};

// Drop each player's `grid` while its gridVersion is unchanged since the last
// delivery, and remember what was delivered. Hosts re-attach the rows they
// cached (EngineBridge on both native platforms). Safe to delete: the snapshot
// is already a value copy, so nothing engine-side is aliased.
PartyCore.prototype._stripUnchangedGrids = function(snapshot) {
  for (var i = 0; i < snapshot.players.length; i++) {
    var p = snapshot.players[i];
    if (this._sentGridVersions[p.id] === p.gridVersion) delete p.grid;
    else this._sentGridVersions[p.id] = p.gridVersion;
  }
  return snapshot;
};

// snapshot() for delivery: grid-stripped, ledger updated. Does NOT touch the
// scene signature — an out-of-band pull is not a delivered frame, and the next
// frame must still be judged against the last one the host actually rendered.
PartyCore.prototype.deliverSnapshot = function() {
  return this._stripUnchangedGrids(this.snapshot());
};

// frame() for delivery. Events and commands always ride in full; the snapshot is
// OMITTED (the key is absent) when this frame is render-identical to the last
// delivered one, and grid-stripped otherwise. On omission both ledgers are left
// untouched: the host never saw this snapshot, so the next delivered one must
// still strip against what it did see.
PartyCore.prototype.deliverFrame = function(nowMs) {
  var f = this.frame(nowMs);
  var sig = PartyCore.sceneSig(f.snapshot);
  if (sig === this._lastSceneSig) {
    delete f.snapshot;
  } else {
    this._lastSceneSig = sig;
    this._stripUnchangedGrids(f.snapshot);
  }
  return f;
};

// Normalize a frame's events + snapshot into a serializable host-effect list:
// what each engine event MEANS for the room and the controllers, decided once
// for every display. All three call it — the TVs through frame(), the web
// directly from its rAF step (DisplayGame.stepEngine) — so a host that replays
// commands in array order reproduces the same effects everywhere. Only the
// effects themselves (which socket, which animation) stay per-shell.
//
// PURE: depends only on its args (no instance, no cross-frame state), so the web
// can hand it the live zero-copy getSnapshot() it already renders from. The
// snapshot is read for the post-update per-player figures a line clear reports;
// it is sampled once by the caller rather than mid-event by each host.
PartyCore.toCommands = function(events, snapshot) {
  var commands = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    // Unmapped event types intentionally produce no command. They still appear in
    // the returned events array (the complete record), which native can also read.
    switch (e.type) {
      case 'piece_lock':
        // Clone blocks (and clearCells below): frame() returns events and commands
        // from the same buffer, so a host transforming commands[].blocks must not
        // alias-corrupt the parallel events entry. Same contract as the snapshot.
        commands.push({ type: 'pieceLock', playerId: e.playerId,
          blocks: e.blocks.map(function(b) { return [b[0], b[1]]; }), typeId: e.typeId });
        break;
      case 'line_clear':
        commands.push({ type: 'lineClear', playerId: e.playerId,
          clearCells: e.clearCells.map(function(c) { return [c[0], c[1]]; }), lines: e.lines });
        // p is always present: the engine emits line_clear only for a board that
        // is in this frame's snapshot. The guard is belt-and-suspenders.
        var p = null;
        for (var j = 0; j < snapshot.players.length; j++) {
          if (snapshot.players[j].id === e.playerId) { p = snapshot.players[j]; break; }
        }
        if (p) {
          // Read post-update (the caller samples the snapshot once, after the
          // engine tick), so a clear that also tops the player out reports
          // alive:false here rather than a frame late.
          commands.push({
            type: 'playerState',
            playerId: e.playerId,
            lines: p.lines,
            alive: p.alive
          });
        }
        break;
      case 'player_ko':
        // playerEliminated == "this player is out"; distinct from the match-end
        // 'gameEnd' command below. Nothing extra goes to their controller for it:
        // the playerState command above carries alive:false, and the room
        // snapshot's own `alive` flag is what survives a reconnect.
        commands.push({ type: 'playerKO', playerId: e.playerId });
        commands.push({ type: 'playerState', playerId: e.playerId, alive: false });
        commands.push({ type: 'playerEliminated', playerId: e.playerId });
        break;
      case 'garbage_cancelled':
        commands.push({ type: 'garbageCancelled', playerId: e.playerId, lines: e.lines });
        break;
      case 'garbage_sent':
        commands.push({ type: 'garbageSent', senderId: e.senderId, toId: e.toId, lines: e.lines });
        break;
      case 'game_end':
        // RAW — the host keeps roster enrichment (playerName/colorIndex/
        // newPlayer) and the actual broadcast; frame() has no roster. clone() so a
        // host enriching commands[].results can't alias-corrupt the events entry
        // (frame() returns both events and commands from the same buffer).
        commands.push({ type: 'gameEnd', elapsed: e.elapsed, results: clone(e.results) });
        break;
    }
  }

  return commands;
};

exports.PartyCore = PartyCore;

})(typeof module !== 'undefined' ? module.exports : (window.GameEngine = window.GameEngine || {}));
