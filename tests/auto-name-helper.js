'use strict';

// Test-side adapter over the REAL naming logic.
//
// This file used to be a fourth hand-written copy of the auto-name algorithm,
// carrying "Keep in sync with DisplayState.js" and a deliberate divergence
// ("Deterministic test helper: production picks randomly from this pool"). So
// four implementations existed (web, tvOS, Android, here) and the one the tests
// asserted against was knowingly not the one that shipped.
//
// It now delegates to server/RoomBrain.js, the single implementation, seeded so
// the random pick stays reproducible. The old signatures are kept because
// several test files build their rosters through them.

const { RoomBrain } = require('../server/RoomBrain.js');

// Any fixed seed will do; it only has to be stable across runs so a test that
// asserts an exact fallback name stays reproducible.
const SEED = 20260727;

/** A throwaway brain seeded with `players` (a Map of peerIndex -> {playerName}). */
function brainWith(players) {
  const brain = new RoomBrain({ rngSeed: SEED });
  if (players) {
    for (const entry of players) brain.addPlayer(entry[0], Object.assign({}, entry[1]));
  }
  return brain;
}

function generateAutoPlayerName(players, exceptPeerIndex, preferredName) {
  return brainWith(players).generateAutoName(exceptPeerIndex, preferredName);
}

function getAutoPlayerNameNumber(name) {
  const match = typeof name === 'string' ? /^HX-([1-9][0-9]?)$/i.exec(name) : null;
  return match ? parseInt(match[1], 10) : null;
}

function sanitizePlayerName(name, players = new Map(), peerIndex, requestedAutoName) {
  return brainWith(players).resolveName(name, peerIndex, requestedAutoName);
}

module.exports = {
  AUTO_PLAYER_NAME_BLOCKLIST: RoomBrain.AUTO_NAME_BLOCKLIST,
  generateAutoPlayerName,
  getAutoPlayerNameNumber,
  sanitizePlayerName
};
