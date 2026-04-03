'use strict';

// UMD: works in Node.js (require) and browser (window.GameRandomizer)
(function(exports) {

var constants = (typeof require !== 'undefined') ? require('./constants') : window.GameConstants;
var PIECE_TYPES = constants.PIECE_TYPES;

// Mulberry32: simple, fast 32-bit seeded PRNG
function mulberry32(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Randomizer {
  constructor(seed, pieceTypes) {
    if (seed != null) {
      this.rng = mulberry32(seed);
    } else {
      this.rng = Math.random;
    }
    this.pieceTypes = pieceTypes || PIECE_TYPES;
    this.bag = [];
  }

  next() {
    if (this.bag.length === 0) {
      this.bag = [...this.pieceTypes];
      // Fisher-Yates shuffle
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }
}

exports.Randomizer = Randomizer;
exports.mulberry32 = mulberry32;

})(typeof module !== 'undefined' ? module.exports : (window.GameRandomizer = {}));
