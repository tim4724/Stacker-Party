'use strict';

// UMD: works in Node.js (require) and browser (window.GameScoring)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var LINE_CLEAR_SCORES = constants.LINE_CLEAR_SCORES;
var TSPIN_SCORES = constants.TSPIN_SCORES;
var TSPIN_MINI_SCORES = constants.TSPIN_MINI_SCORES;
var COMBO_TABLE = constants.COMBO_TABLE;
var BACK_TO_BACK_MULTIPLIER = constants.BACK_TO_BACK_MULTIPLIER;

class Scoring {
  constructor() {
    this.score = 0;
    this.lines = 0;
    this.combo = -1;
    this.backToBack = false;
  }

  addLineClear(linesCleared, isTSpin, isTSpinMini) {
    if (linesCleared === 0 && !isTSpin && !isTSpinMini) return null;

    this.combo++;

    const isTetris = linesCleared === 4;
    const isDifficult = isTetris || isTSpin;

    // Base score
    let points = 0;
    if (isTSpinMini) {
      points = TSPIN_MINI_SCORES[linesCleared] || 0;
    } else if (isTSpin) {
      points = TSPIN_SCORES[linesCleared] || 0;
    } else {
      points = LINE_CLEAR_SCORES[linesCleared] || 0;
    }

    // Level multiplier
    points *= this.getLevel();

    // Back-to-back bonus
    if (isDifficult) {
      if (this.backToBack) {
        points = Math.floor(points * BACK_TO_BACK_MULTIPLIER);
      }
      this.backToBack = true;
    } else if (linesCleared > 0) {
      this.backToBack = false;
    }

    // Combo bonus
    const comboIndex = Math.min(this.combo, COMBO_TABLE.length - 1);
    const comboBonus = COMBO_TABLE[comboIndex] * this.getLevel();
    points += comboBonus;

    this.score += points;
    this.lines += linesCleared;

    return {
      score: points,
      linesAdded: linesCleared,
      combo: this.combo,
      backToBack: this.backToBack,
      isTetris,
      isTSpin
    };
  }

  resetCombo() {
    this.combo = -1;
  }

  addSoftDrop(cells) {
    this.score += cells;
  }

  addHardDrop(cells) {
    this.score += cells * 2;
  }

  getLevel() {
    return Math.floor(this.lines / 10) + 1;
  }

  getState() {
    return {
      score: this.score,
      level: this.getLevel(),
      lines: this.lines,
      combo: this.combo,
      backToBack: this.backToBack
    };
  }
}

exports.Scoring = Scoring;

})(typeof module !== 'undefined' ? module.exports : (window.GameScoring = {}));
