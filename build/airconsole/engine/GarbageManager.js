'use strict';

// UMD: works in Node.js (require) and browser (window.GameGarbageManager)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var BOARD_WIDTH = constants.BOARD_WIDTH;
var GARBAGE_TABLE = constants.GARBAGE_TABLE;
var GARBAGE_DELAY_MS = constants.GARBAGE_DELAY_MS;

class GarbageManager {
  constructor(rng) {
    this.queues = new Map(); // playerId -> array of { lines, gapColumn, senderId, msLeft }
    this.rng = rng || Math.random;
  }

  addPlayer(playerId) {
    this.queues.set(playerId, []);
  }

  removePlayer(playerId) {
    this.queues.delete(playerId);
  }

  /**
   * Called each game tick to count down garbage delays.
   * Returns an array of { playerId, lines, gapColumn, senderId } for garbage that is ready.
   */
  tick(deltaMs) {
    const ready = [];
    for (const [playerId, queue] of this.queues) {
      let writeIdx = 0;
      for (let i = 0; i < queue.length; i++) {
        queue[i].msLeft -= deltaMs;
        if (queue[i].msLeft <= 0) {
          ready.push({ playerId, lines: queue[i].lines, gapColumn: queue[i].gapColumn, senderId: queue[i].senderId });
        } else {
          queue[writeIdx++] = queue[i];
        }
      }
      queue.length = writeIdx;
    }
    return ready;
  }

  processLineClear(senderId, linesCleared, getStackHeight, defenseLines) {
    if (linesCleared === 0) return { sent: 0, cancelled: 0, deliveries: [] };

    const garbageLines = GARBAGE_TABLE[linesCleared] || 0;

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
    const queue = this.queues.get(playerId);
    if (!queue) return 0;
    return queue.reduce((sum, g) => sum + g.lines, 0);
  }

  generateGapColumn() {
    return Math.floor(this.rng() * BOARD_WIDTH);
  }
}

exports.GarbageManager = GarbageManager;

})(typeof module !== 'undefined' ? module.exports : (window.GameGarbageManager = {}));
