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
function copyPlayer(s) {
  return {
    id: s.id,
    grid: s.grid.map(function(row) { return row.slice(); }),
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
    players: snap.players.map(copyPlayer),
    elapsed: snap.elapsed
  };
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
