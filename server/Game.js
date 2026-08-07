'use strict';

// UMD: works in Node.js (require) and browser (window.Game)
(function(exports) {

var PlayerBoard = ((typeof require !== 'undefined') ? require('./PlayerBoard.js') : window.PlayerBoardModule).PlayerBoard;
var GarbageManager = ((typeof require !== 'undefined') ? require('./GarbageManager.js') : window.GameGarbageManager).GarbageManager;
var mulberry32 = ((typeof require !== 'undefined') ? require('./Randomizer.js') : window.GameRandomizer).mulberry32;
var GameConstants = (typeof require !== 'undefined') ? require('./constants.js') : window.GameConstants;
var HARD_DROP_MIN_INTERVAL_MS = GameConstants.HARD_DROP_MIN_INTERVAL_MS;

class Game {
  constructor(players, callbacks, seed) {
    this.callbacks = callbacks; // { onEvent, onGameEnd }
    this.boards = new Map();
    this.playerIds = [];
    this.ended = false;
    this.paused = false;
    this._hardDropCooldownMs = new Map();   // per-player floor between hard drops (silent throttle)

    // Shared seed so all players get the same piece sequence
    if (seed == null) seed = (Math.random() * 0xFFFFFFFF) >>> 0;
    this.seed = seed;

    for (const [id, opts] of players) {
      const board = new PlayerBoard(id, seed, (opts && opts.startLevel) || 1);
      this.boards.set(id, board);
      this.playerIds.push(id);
    }

    this._aliveCount = this.playerIds.length;

    this.garbageManager = new GarbageManager(mulberry32(seed ^ 0x47617262));
    for (const id of this.playerIds) {
      this.garbageManager.addPlayer(id);
    }
  }

  init() {
    this.elapsed = 0;

    for (const [id, board] of this.boards) {
      board.spawnPiece();
    }
  }

  pause() {
    if (this.ended) return;
    this.paused = true;
  }

  resume() {
    if (this.ended) return;
    this.paused = false;
  }

  // Cross-device mid-game rejoin: move a player's board, id ordering, hard-drop
  // cooldown and garbage queues from oldId to newId, preserving board insertion
  // order so snapshot/layout positions don't shuffle. The returning peer reclaims
  // the dropped slot's exact game state. No-op if oldId is absent or unchanged,
  // and refused if newId already owns a board — the Map rebuild would silently
  // drop one of the two boards and duplicate newId in playerIds.
  rekeyPlayer(oldId, newId) {
    if (oldId === newId) return false;
    if (this.boards.has(newId)) return false;
    const board = this.boards.get(oldId);
    if (!board) return false;
    // Rebuild the Map preserving order (a plain delete+set would move it last).
    const moved = new Map();
    for (const [id, b] of this.boards) moved.set(id === oldId ? newId : id, b);
    this.boards = moved;
    board.playerId = newId;
    this.playerIds = this.playerIds.map((id) => (id === oldId ? newId : id));
    if (this._hardDropCooldownMs.has(oldId)) {
      this._hardDropCooldownMs.set(newId, this._hardDropCooldownMs.get(oldId));
      this._hardDropCooldownMs.delete(oldId);
    }
    this.garbageManager.rekeyPlayer(oldId, newId);
    return true;
  }

  processInput(playerId, action) {
    const board = this.boards.get(playerId);
    if (!board || !board.alive || this.ended) return;

    switch (action) {
      case 'left':
        board.moveLeft();
        break;
      case 'right':
        board.moveRight();
        break;
      case 'rotate_cw':
        board.rotateCW();
        break;
      case 'rotate_ccw':
        board.rotateCCW();
        break;
      case 'hard_drop': {
        // Silently throttle rapid repeats (e.g. queued messages after a
        // reconnect) so one intent can't rapid-fire multiple drops.
        if ((this._hardDropCooldownMs.get(playerId) || 0) > 0) return;
        this._hardDropCooldownMs.set(playerId, HARD_DROP_MIN_INTERVAL_MS);
        const result = board.hardDrop();
        if (result) {
          this.callbacks.onEvent({
            type: 'piece_lock',
            playerId,
            blocks: result.lockedBlocks,
            typeId: result.lockedTypeId
          });
          if (result.linesCleared > 0) {
            this.handleLineClear(playerId, result);
          }
          this._drainGarbageApplied(playerId, board);
        }
        break;
      }
      case 'hold':
        board.hold();
        break;
    }
  }

  handleSoftDropStart(playerId, speed) {
    const board = this.boards.get(playerId);
    if (!board || !board.alive || this.ended) return;
    board.softDropStart(speed);
  }

  handleSoftDropEnd(playerId) {
    const board = this.boards.get(playerId);
    if (!board || !board.alive || this.ended) return;
    board.softDropEnd();
  }

  update(deltaMs) {
    if (this.ended || this.paused) return;
    this.elapsed += deltaMs;

    // Decrement per-player hard-drop cooldowns. Frozen while paused (early
    // return above), same as the soft-drop deadline.
    for (const [id, ms] of this._hardDropCooldownMs) {
      this._hardDropCooldownMs.set(id, Math.max(0, ms - deltaMs));
    }

    for (const [id, board] of this.boards) {
      if (!board.alive) {
        // Emit KO for players that died outside tick (e.g. processInput hard_drop)
        if (!board._koEmitted) {
          board._koEmitted = true;
          this._aliveCount--;
          this.callbacks.onEvent({ type: 'player_ko', playerId: id });
        }
        continue;
      }

      try {
        const result = board.tick(deltaMs);

        if (result) {
          this.callbacks.onEvent({
            type: 'piece_lock',
            playerId: id,
            blocks: result.lockedBlocks,
            typeId: result.lockedTypeId
          });
          if (result.linesCleared > 0) {
            this.handleLineClear(id, result);
          }
        }
        this._drainGarbageApplied(id, board);
      } catch (err) {
        if (typeof console !== 'undefined' && console.error) console.error('[game] Board tick error for', id, ':', err);
        board.alive = false;
      }

      // Check if player just died during tick
      if (!board.alive) {
        board._koEmitted = true;
        this._aliveCount--;
        this.callbacks.onEvent({ type: 'player_ko', playerId: id });
      }
    }

    // Tick garbage delay timers and apply any that are ready
    const readyGarbage = this.garbageManager.tick(deltaMs);
    for (const g of readyGarbage) {
      const board = this.boards.get(g.playerId);
      if (board && board.alive) {
        board.addPendingGarbage(g.lines, g.gapColumn);
      }
    }

    this.checkWinCondition();
  }

  getSnapshot() {
    const playerArr = [];
    for (const id of this.boards.keys()) playerArr.push(this.getPlayerState(id));

    return {
      players: playerArr,
      elapsed: this.elapsed
    };
  }

  // One seat's live state, the per-board half of getSnapshot(). Split out for the
  // render-on-input pull, which needs a single board: getState() is real work per
  // board (ghost solve, visible-grid slice, block arrays), so building all eight and
  // discarding seven cost ~0.3ms of every input at a full party. Null when the id
  // owns no board. Live refs, exactly like getSnapshot — callers that retain it
  // across frames must copy (PartyCore.copyPlayer).
  getPlayerState(id) {
    const board = this.boards.get(id);
    if (!board) return null;
    const state = board.getState();
    state.id = id;
    state.pendingGarbage += this.garbageManager.getPendingLines(id);
    return state;
  }

  // Garbage rows actually went into a board. Distinct from `garbage_sent`, which
  // fires when the attack is QUEUED: between the two the defender can still cancel
  // it, so they are different moments with different consequences, and only this
  // one means the stack just moved up.
  //
  // Emitted here rather than derived by each display from a drop in the pending
  // count. That derivation is possible (the web did it) but it needs a second
  // subtraction to discount cancelled lines, and it can only exist where a shell
  // can watch every frame's snapshot — the two TVs read packed frames and cannot.
  // One event replaces three implementations of the same guess.
  _drainGarbageApplied(playerId, board) {
    const lines = board.garbageAppliedSinceDrain;
    if (lines <= 0) return;
    board.garbageAppliedSinceDrain = 0;
    this.callbacks.onEvent({ type: 'garbage_applied', playerId, lines });
  }

  handleLineClear(playerId, clearResult) {
    const board = this.boards.get(playerId);
    const lines = clearResult.linesCleared;

    this.callbacks.onEvent({
      type: 'line_clear',
      playerId,
      lines,
      rows: clearResult.fullRows || [],
      clearCells: clearResult.clearCells || null
    });

    // Cancel board-pending garbage first (already delivered, most urgent)
    let boardCancelled = 0;
    let defenseRemaining = lines;
    while (defenseRemaining > 0 && board.pendingGarbage.length > 0) {
      const front = board.pendingGarbage[0];
      if (front.lines <= defenseRemaining) {
        defenseRemaining -= front.lines;
        boardCancelled += front.lines;
        board.pendingGarbage.shift();
      } else {
        front.lines -= defenseRemaining;
        boardCancelled += defenseRemaining;
        defenseRemaining = 0;
      }
    }

    // Then cancel from delayed garbage queue (GarbageManager) with remaining defense
    const getStackHeight = (id) => {
      const b = this.boards.get(id);
      return b && b.alive ? b.getStackHeight() : -1;
    };
    const result = this.garbageManager.processLineClear(playerId, lines, getStackHeight, defenseRemaining);

    const totalCancelled = boardCancelled + result.cancelled;
    if (totalCancelled > 0) {
      this.callbacks.onEvent({
        type: 'garbage_cancelled',
        playerId,
        lines: totalCancelled
      });
    }
    for (const d of result.deliveries) {
      this.callbacks.onEvent({
        type: 'garbage_sent',
        senderId: d.fromId,
        toId: d.toId,
        lines: d.lines
      });
    }
  }

  checkWinCondition() {
    if (this.ended) return;

    // Multiplayer: last-man-standing
    if (this.playerIds.length >= 2 && this._aliveCount <= 1) {
      this.ended = true;
      this.callbacks.onGameEnd(this.getResults());
    }

    // Single player: end when they die
    if (this.playerIds.length === 1 && this._aliveCount === 0) {
      this.ended = true;
      this.callbacks.onGameEnd(this.getResults());
    }
  }

  getResults() {
    const results = [];

    for (const id of this.playerIds) {
      const board = this.boards.get(id);
      results.push({
        playerId: id,
        alive: board.alive,
        lines: board.lines || 0,
        level: board.getLevel()
      });
    }

    // Sort: alive first, then by lines descending
    results.sort((a, b) => {
      if (a.alive !== b.alive) return b.alive ? 1 : -1;
      return b.lines - a.lines;
    });

    results.forEach((r, i) => { r.rank = i + 1; });

    return {
      elapsed: this.elapsed,
      results
    };
  }
}

exports.Game = Game;

})(typeof module !== 'undefined' ? module.exports : (window.GameEngine = {}));
