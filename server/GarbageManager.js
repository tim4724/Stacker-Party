'use strict';

// UMD: works in Node.js (require) and browser (window.GameGarbageManager)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var GARBAGE_TABLE = constants.GARBAGE_TABLE;
var TSPIN_GARBAGE_MULTIPLIER = constants.TSPIN_GARBAGE_MULTIPLIER;
var COMBO_GARBAGE = constants.COMBO_GARBAGE;
var GARBAGE_DELAY_TICKS = constants.GARBAGE_DELAY_TICKS;

class GarbageManager {
  constructor(rng) {
    this.queues = new Map(); // playerId -> array of { lines, gapColumn, senderId, ticksLeft }
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
  tick() {
    const ready = [];
    for (const [playerId, queue] of this.queues) {
      for (let i = queue.length - 1; i >= 0; i--) {
        queue[i].ticksLeft--;
        if (queue[i].ticksLeft <= 0) {
          const g = queue.splice(i, 1)[0];
          ready.push({ playerId, lines: g.lines, gapColumn: g.gapColumn, senderId: g.senderId });
        }
      }
    }
    return ready;
  }

  processLineClear(senderId, linesCleared, isTSpin, combo, backToBack, getStackHeight, defenseLines) {
    if (linesCleared === 0) return { sent: 0, cancelled: 0, deliveries: [] };

    // Calculate garbage lines to send (always based on original lines cleared)
    let garbageLines = GARBAGE_TABLE[linesCleared] || 0;

    // T-spin doubles garbage
    if (isTSpin) {
      garbageLines *= TSPIN_GARBAGE_MULTIPLIER;
    }

    // Combo bonus
    if (combo >= 0) {
      const comboIndex = Math.min(combo, COMBO_GARBAGE.length - 1);
      garbageLines += COMBO_GARBAGE[comboIndex];
    }

    // Back-to-back bonus for tetris or t-spin
    if (backToBack && (linesCleared === 4 || isTSpin)) {
      garbageLines += 1;
    }

    // Cancel sender's incoming garbage (defenseLines may be reduced by board-pending cancellation)
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

    // Remaining attack after cancellation absorbs some offensive power
    const netAttack = Math.max(0, garbageLines - cancelled);

    // Send net attack to opponent with the highest stack (most vulnerable)
    let sent = 0;
    const deliveries = [];
    if (netAttack > 0) {
      const targetId = this._pickTarget(senderId, getStackHeight);
      if (targetId) {
        const gapColumn = this.generateGapColumn();
        const queue = this.queues.get(targetId);
        queue.push({ lines: netAttack, gapColumn, senderId, ticksLeft: GARBAGE_DELAY_TICKS });
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
    return Math.floor(this.rng() * 10);
  }
}

exports.GarbageManager = GarbageManager;

})(typeof module !== 'undefined' ? module.exports : (window.GameGarbageManager = {}));
