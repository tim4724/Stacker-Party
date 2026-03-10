'use strict';

// UMD: works in Node.js (require) and browser (window.Game)
(function(exports) {

var PlayerBoard = ((typeof require !== 'undefined') ? require('./PlayerBoard.js') : window.GamePlayerBoard).PlayerBoard;
var GarbageManager = ((typeof require !== 'undefined') ? require('./GarbageManager.js') : window.GameGarbageManager).GarbageManager;
var LOGIC_TICK_MS = ((typeof require !== 'undefined') ? require('./constants.js') : window.GameConstants).LOGIC_TICK_MS;
var mulberry32 = ((typeof require !== 'undefined') ? require('./Randomizer.js') : window.GameRandomizer).mulberry32;

class Game {
  constructor(players, callbacks, seed) {
    this.callbacks = callbacks; // { onGameState, onEvent, onGameEnd }
    this.boards = new Map();
    this.playerIds = [];
    this.startTime = null;
    this.logicInterval = null;
    this.ended = false;
    this.paused = false;
    this.pausedAt = null;

    // Shared seed so all players get the same piece sequence
    if (seed == null) seed = (Math.random() * 0xFFFFFFFF) >>> 0;
    this.seed = seed;

    for (const [id] of players) {
      const board = new PlayerBoard(id, seed);
      this.boards.set(id, board);
      this.playerIds.push(id);
    }

    this.garbageManager = new GarbageManager(mulberry32(seed ^ 0x47617262));
    for (const id of this.playerIds) {
      this.garbageManager.addPlayer(id);
    }
  }

  init() {
    this.startTime = Date.now();

    for (const [id, board] of this.boards) {
      board.spawnPiece();
    }
  }

  start() {
    this.init();
    // Flag so resume() knows to restart the interval (not needed for RAF-driven path via init())
    this._usesInterval = true;
    this.logicInterval = setInterval(() => this._safeTick(), LOGIC_TICK_MS);
  }

  stop() {
    if (this.logicInterval) {
      clearInterval(this.logicInterval);
      this.logicInterval = null;
    }
  }

  pause() {
    if (this.paused || this.ended) return;
    this.paused = true;
    this.pausedAt = Date.now();
    // Stop interval if running (start()-based path)
    if (this.logicInterval) this.stop();
  }

  resume() {
    if (!this.paused || this.ended) return;
    // Adjust startTime so elapsed doesn't include paused duration
    const pausedDuration = Date.now() - this.pausedAt;
    this.startTime += pausedDuration;
    this.paused = false;
    this.pausedAt = null;
    // Restart interval only if start() was used (not init()-based path)
    if (!this.logicInterval && this._usesInterval) {
      this.logicInterval = setInterval(() => this._safeTick(), LOGIC_TICK_MS);
    }
  }

  _safeTick() {
    try {
      this.logicTick();
    } catch (err) {
      console.error('Game engine error:', err);
      this.ended = true;
      this.stop();
      try {
        this.callbacks.onGameEnd(this.getResults());
      } catch (recoveryErr) {
        console.error('Failed to send game-end after engine error:', recoveryErr);
      }
    }
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
      case 'hard_drop': {
        const result = board.hardDrop();
        if (result && result.linesCleared > 0) {
          this.handleLineClear(playerId, result);
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

    for (const [id, board] of this.boards) {
      if (!board.alive) continue;

      try {
        const result = board.tick(deltaMs);

        if (result && result.linesCleared > 0) {
          this.handleLineClear(id, result);
        }
      } catch (err) {
        console.error('[game] Board tick error for', id, ':', err);
        board.alive = false;
      }

      // Check if player just died
      if (!board.alive) {
        this.callbacks.onEvent({
          type: 'player_ko',
          playerId: id
        });
      }
    }

    // Tick garbage delay timers and apply any that are ready
    const readyGarbage = this.garbageManager.tick(deltaMs);
    for (const g of readyGarbage) {
      const board = this.boards.get(g.playerId);
      if (board && board.alive) {
        if (board.clearingRows) {
          const queue = this.garbageManager.queues.get(g.playerId);
          if (queue) {
            queue.push({ lines: g.lines, gapColumn: g.gapColumn, senderId: g.senderId, msLeft: deltaMs });
          }
        } else {
          board.addPendingGarbage(g.lines, g.gapColumn);
        }
      }
    }

    this.checkWinCondition();
  }

  getSnapshot() {
    const playerArr = [];
    for (const [id, board] of this.boards) {
      const state = board.getState();
      state.id = id;
      state.pendingGarbage += this.garbageManager.getPendingLines(id);
      playerArr.push(state);
    }

    return {
      players: playerArr,
      elapsed: Date.now() - this.startTime
    };
  }

  logicTick() {
    if (this.ended) return;
    this.update(LOGIC_TICK_MS);
    this.broadcastTick();
  }

  broadcastTick() {
    if (this.ended) return;
    if (this.callbacks.onGameState) {
      this.callbacks.onGameState(this.getSnapshot());
    }
  }

  handleLineClear(playerId, clearResult) {
    const board = this.boards.get(playerId);
    const lines = clearResult.linesCleared;
    const isTSpin = clearResult.isTSpin || false;
    const combo = (clearResult.scoreResult && clearResult.scoreResult.combo) || 0;
    const backToBack = (clearResult.scoreResult && clearResult.scoreResult.backToBack) || false;

    this.callbacks.onEvent({
      type: 'line_clear',
      playerId,
      lines,
      rows: clearResult.fullRows || [],
      isTSpin,
      combo
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
    const result = this.garbageManager.processLineClear(playerId, lines, isTSpin, combo, backToBack, getStackHeight, defenseRemaining);

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

    const alive = this.playerIds.filter(id => this.boards.get(id).alive);

    // Multiplayer: last-man-standing
    if (this.playerIds.length >= 2 && alive.length <= 1) {
      this.ended = true;
      this.stop();
      this.callbacks.onGameEnd(this.getResults());
    }

    // Single player: end when they die
    if (this.playerIds.length === 1 && alive.length === 0) {
      this.ended = true;
      this.stop();
      this.callbacks.onGameEnd(this.getResults());
    }
  }

  getResults() {
    const results = [];

    for (const id of this.playerIds) {
      const board = this.boards.get(id);
      const state = board.scoring ? board.scoring.getState() : {};
      results.push({
        playerId: id,
        alive: board.alive,
        score: state.score || 0,
        lines: state.lines || 0,
        level: state.level || 0
      });
    }

    // Sort: alive first, then by score descending
    results.sort((a, b) => {
      if (a.alive !== b.alive) return b.alive ? 1 : -1;
      return b.score - a.score;
    });

    results.forEach((r, i) => { r.rank = i + 1; });

    return {
      elapsed: Date.now() - this.startTime,
      results
    };
  }
}

exports.Game = Game;

})(typeof module !== 'undefined' ? module.exports : (window.GameEngine = {}));
