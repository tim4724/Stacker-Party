'use strict';

// UMD: works in Node.js (require) and browser (window.GameGarbageManager)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var GARBAGE_TABLE = constants.GARBAGE_TABLE;
var GARBAGE_DELAY_MS = constants.GARBAGE_DELAY_MS;
var DEFAULT_BOARD_WIDTH = constants.BOARD_WIDTH;

class GarbageManager {
  constructor(rng, boardWidth) {
    this.queues = new Map(); // playerId -> array of { lines, gapColumn, senderId, msLeft }
    this._pendingTotals = new Map(); // playerId -> total pending lines
    this._readyGarbage = [];
    this.rng = rng || Math.random;
    this.boardWidth = boardWidth || DEFAULT_BOARD_WIDTH;
  }

  addPlayer(playerId) {
    this.queues.set(playerId, []);
    this._pendingTotals.set(playerId, 0);
  }

  removePlayer(playerId) {
    this.queues.delete(playerId);
    this._pendingTotals.delete(playerId);
  }

  /**
   * Called each game tick to count down garbage delays.
   * Returns an array of { playerId, lines, gapColumn, senderId } for garbage that is ready.
   * WARNING: returns a reused array that is cleared at the start of the next tick().
   * Callers MUST consume the contents synchronously — do not cache or store the reference.
   */
  tick(deltaMs) {
    this._readyGarbage.length = 0;
    for (const [playerId, queue] of this.queues) {
      let writeIdx = 0;
      for (let i = 0; i < queue.length; i++) {
        queue[i].msLeft -= deltaMs;
        if (queue[i].msLeft <= 0) {
          this._pendingTotals.set(playerId, (this._pendingTotals.get(playerId) || 0) - queue[i].lines);
          this._readyGarbage.push({ playerId, lines: queue[i].lines, gapColumn: queue[i].gapColumn, senderId: queue[i].senderId });
        } else {
          queue[writeIdx++] = queue[i];
        }
      }
      queue.length = writeIdx;
    }
    return this._readyGarbage;
  }

  processLineClear(senderId, linesCleared, getStackHeight, defenseLines, garbageOverride) {
    if (linesCleared === 0) return { sent: 0, cancelled: 0, deliveries: [] };

    const garbageLines = garbageOverride != null ? garbageOverride : (GARBAGE_TABLE[linesCleared] != null ? GARBAGE_TABLE[linesCleared] : linesCleared);

    // Cancel sender's incoming garbage
    const senderQueue = this.queues.get(senderId) || [];
    let defenseRemaining = defenseLines != null ? defenseLines : linesCleared;
    let cancelled = 0;

    while (defenseRemaining > 0 && senderQueue.length > 0) {
      const front = senderQueue[0];
      if (front.lines <= defenseRemaining) {
        defenseRemaining -= front.lines;
        cancelled += front.lines;
        senderQueue.shift();
      } else {
        front.lines -= defenseRemaining;
        cancelled += defenseRemaining;
        defenseRemaining = 0;
      }
    }
    if (cancelled > 0) {
      this._pendingTotals.set(senderId, Math.max(0, (this._pendingTotals.get(senderId) || 0) - cancelled));
    }

    // Send net attack to opponent with the lowest stack
    const netAttack = Math.max(0, garbageLines - cancelled);
    let sent = 0;
    const deliveries = [];
    if (netAttack > 0) {
      const targetId = this._pickTarget(senderId, getStackHeight);
      if (targetId) {
        const gapColumn = this.generateGapColumn();
        const queue = this.queues.get(targetId);
        queue.push({ lines: netAttack, gapColumn, senderId, msLeft: GARBAGE_DELAY_MS });
        this._pendingTotals.set(targetId, (this._pendingTotals.get(targetId) || 0) + netAttack);
        deliveries.push({ fromId: senderId, toId: targetId, lines: netAttack, gapColumn });
        sent = netAttack;
      }
    }

    return { sent, cancelled, deliveries };
  }

  _pickTarget(senderId, getStackHeight) {
    let bestId = null;
    let bestHeight = Infinity;

    for (const [playerId] of this.queues) {
      if (playerId === senderId) continue;
      const height = getStackHeight ? getStackHeight(playerId) : 0;
      if (height < 0) continue; // dead player
      if (height < bestHeight) {
        bestHeight = height;
        bestId = playerId;
      }
    }

    return bestId;
  }

  getPendingLines(playerId) {
    return this._pendingTotals.get(playerId) || 0;
  }

  generateGapColumn() {
    return Math.floor(this.rng() * this.boardWidth);
  }
}

exports.GarbageManager = GarbageManager;

})(typeof module !== 'undefined' ? module.exports : (window.GameGarbageManager = {}));
