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
  return this.game.rekeyPlayer(oldId, newId);
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
  var commands = PartyCore._toCommands(events, snapshot);
  return { events: events, snapshot: snapshot, commands: commands };
};

// Normalize this frame's events + value-copy snapshot into a serializable
// host-effect list. PURE: depends only on its args (no instance, no cross-frame
// state). Ordering within an event mirrors the web DisplayGame handler so a host
// replaying commands in array order reproduces today's effects. garbageIncoming is pre-resolved from the
// snapshot (board-pending + delayed GarbageManager queue), removing the host's
// mid-event getSnapshot.
PartyCore._toCommands = function(events, snapshot) {
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
          commands.push({
            type: 'playerState',
            playerId: e.playerId,
            level: p.level,
            lines: p.lines,
            alive: p.alive,
            // KNOWN DIVERGENCE from the web (accepted, not a bug): garbageIncoming
            // here reads from `snapshot`, which frame() captured AFTER
            // game.update() returned, i.e. after Game.handleLineClear() applied
            // this clear's defense and cancelled incoming garbage. The web
            // (DisplayGame.js) instead samples getSnapshot() synchronously inside
            // the line_clear onEvent, which fires at the TOP of handleLineClear
            // (Game.js) BEFORE defense runs. So for a clear that cancels incoming
            // garbage, native reports the reduced POST-cancellation amount while
            // the web reports the PRE-cancellation amount. Native's value is the
            // more accurate one; changing it would need an engine-integration hook
            // and would break the partycore-commands golden fixture.
            garbageIncoming: p.pendingGarbage
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
