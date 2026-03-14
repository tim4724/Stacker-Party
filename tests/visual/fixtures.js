// @ts-check
// Visual test fixture data — moved from server/visualTestScenarios.js

const { PLAYER_COLORS } = require('../../public/shared/theme.js');

const LIVE_SCORE = [12450, 8320, 5100, 2800, 9700, 6200, 4300, 1500];
const LIVE_LINES = [24, 16, 10, 5, 20, 12, 8, 3];
const LIVE_LEVELS = [3, 2, 2, 1, 3, 2, 1, 1];
const LIVE_HOLD = ['O', 'S', 'T', 'I', 'J', 'Z', 'L', 'S'];
const LIVE_NEXT = [
  ['I', 'T', 'Z', 'L', 'O'],
  ['T', 'J', 'O', 'S', 'Z'],
  ['Z', 'I', 'J', 'S', 'L'],
  ['L', 'O', 'T', 'I', 'S'],
  ['S', 'Z', 'T', 'J', 'I'],
  ['J', 'L', 'I', 'O', 'T'],
  ['O', 'S', 'L', 'Z', 'J'],
  ['T', 'I', 'Z', 'L', 'O']
];

// Current pieces — positioned so ghosts land in open gaps with clear separation
// from existing stack blocks.
//
// Piece block coordinates are [col, row] offsets (rotation state 0).
// TypeIds: I=1, J=2, L=3, O=4, S=5, T=6, Z=7
const LIVE_PIECES = [
  // P1: T-piece at x=7, drops into open right side of grid1 (cols 7-9 clear above row 17)
  { typeId: 6, x: 7, y: 2, blocks: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  // P2: J-piece at x=6, drops into open right side of grid2 (cols 6-8 clear above row 16)
  { typeId: 2, x: 6, y: 3, blocks: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  // P3: L-piece at x=3, drops into open center of grid3 (cols 3-5 clear above row 18)
  { typeId: 3, x: 3, y: 2, blocks: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  // P4: T-piece at x=3, drops into open center of grid4 (cols 3-5 clear above row 18)
  { typeId: 6, x: 3, y: 3, blocks: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  // P5: I-piece at x=0, drops onto stack at row 17 in grid5 (cols 0-3 blocked at row 17)
  { typeId: 1, x: 0, y: 5, blocks: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  // P6: S-piece at x=4, drops into center of grid6 (cols 4-6 clear above row 17)
  { typeId: 5, x: 4, y: 3, blocks: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  // P7: Z-piece at x=1, drops into left side of grid7 (cols 1-3 clear above row 17)
  { typeId: 7, x: 1, y: 2, blocks: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  // P8: O-piece at x=7, drops into right side of grid8 (cols 7-8 clear above row 18)
  { typeId: 4, x: 7, y: 3, blocks: [[0, 0], [1, 0], [0, 1], [1, 1]] },
];

// Ghost Y — computed to be the lowest valid row for each piece/grid combination.
// Verified: no ghost block overlaps any occupied grid cell.
const LIVE_GHOST_Y = [14, 14, 15, 16, 15, 16, 15, 16];

const RESULT_SCORE = [24800, 18200, 12100, 5400, 20500, 14300, 9800, 3200];
const RESULT_LINES = [48, 36, 24, 10, 40, 28, 18, 6];
const RESULT_LEVELS = [5, 4, 3, 2, 5, 3, 2, 1];

// All grids keep piece blocks strictly above garbage rows (no colored blocks in garbage).
// Each board uses a unique combination of pieces and layout for visual variety.

function createGrid1() {
  // Player 1 — tallest stack (highest score)
  //   J(2) cols 0-2  |  Z(7) cols 1-3  |  I(1) vertical col 5  |  L(3) cols 7-9
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[14] = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  grid[15] = [0, 7, 7, 0, 0, 1, 0, 0, 0, 0];
  grid[16] = [2, 0, 7, 7, 0, 1, 0, 0, 0, 3];
  grid[17] = [2, 2, 2, 0, 0, 1, 0, 3, 3, 3];
  grid[18] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  grid[19] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  return grid;
}

function createGrid2() {
  // Player 2 — medium stack
  //   S(5) cols 0-2  |  O(4) cols 4-5  |  T(6) cols 6-8
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[16] = [0, 5, 5, 0, 4, 4, 6, 6, 6, 0];
  grid[17] = [5, 5, 0, 0, 4, 4, 0, 6, 0, 0];
  grid[18] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  grid[19] = [8, 8, 0, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid3() {
  // Player 3 — lighter stack
  //   I(1) horizontal cols 0-3  |  Z(7) cols 7-8
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[15] = [0, 0, 0, 0, 0, 0, 0, 0, 7, 0];
  grid[16] = [0, 0, 0, 0, 0, 0, 0, 7, 7, 0];
  grid[17] = [1, 1, 1, 1, 0, 0, 0, 7, 0, 0];
  grid[18] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  grid[19] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid4() {
  // Player 4 — sparsest stack (lowest score)
  //   S(5) cols 1-2  |  L(3) cols 6-7
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[15] = [0, 5, 0, 0, 0, 0, 3, 3, 0, 0];
  grid[16] = [0, 5, 5, 0, 0, 0, 0, 3, 0, 0];
  grid[17] = [0, 0, 5, 0, 0, 0, 0, 3, 0, 0];
  grid[18] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  grid[19] = [8, 0, 8, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid5() {
  // Player 5 — medium-tall stack
  //   S(5) cols 0-1  |  L(3) cols 2-3  |  T(6) cols 5-7  |  J(2) cols 8-9
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[15] = [0, 0, 0, 0, 0, 0, 0, 0, 2, 0];
  grid[16] = [0, 0, 0, 0, 0, 6, 6, 6, 2, 0];
  grid[17] = [5, 5, 3, 3, 0, 0, 6, 0, 2, 2];
  grid[18] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  grid[19] = [8, 8, 0, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid6() {
  // Player 6 — medium stack
  //   O(4) cols 0-1  |  S(5) cols 7-9
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[16] = [4, 4, 0, 0, 0, 0, 0, 5, 5, 0];
  grid[17] = [4, 4, 0, 0, 0, 0, 5, 5, 0, 0];
  grid[18] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  grid[19] = [8, 0, 8, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid7() {
  // Player 7 — light stack
  //   L(3) cols 5-7  |  I(1) cols 0-3
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[16] = [0, 0, 0, 0, 0, 0, 0, 3, 0, 0];
  grid[17] = [1, 1, 1, 1, 0, 3, 3, 3, 0, 0];
  grid[18] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  grid[19] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid8() {
  // Player 8 — sparsest stack
  //   Z(7) cols 2-4
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[17] = [0, 0, 7, 7, 0, 0, 0, 0, 0, 0];
  grid[18] = [8, 8, 0, 7, 7, 8, 8, 8, 0, 8];
  grid[19] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  return grid;
}

const GRIDS = [createGrid1, createGrid2, createGrid3, createGrid4, createGrid5, createGrid6, createGrid7, createGrid8];

function cloneGrid(grid) {
  return grid.map((row) => row.slice());
}

function buildPlayerIds(count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push('player' + (i + 1));
  }
  return ids;
}

function buildPlayers(count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push({ id: 'player' + (i + 1), name: 'Player ' + (i + 1) });
  }
  return list;
}

function buildGameState(playerIds, options) {
  const deadIds = new Set(options.deadPlayerIds || []);
  const allDead = !!options.allDead;
  const pieces = options.pieces || LIVE_PIECES;
  const ghostYs = options.ghostYs || LIVE_GHOST_Y;

  return {
    players: playerIds.map((id, index) => ({
      id: id,
      alive: allDead ? false : !deadIds.has(id),
      score: LIVE_SCORE[index] || LIVE_SCORE[LIVE_SCORE.length - 1],
      lines: LIVE_LINES[index] || LIVE_LINES[LIVE_LINES.length - 1],
      level: LIVE_LEVELS[index] || LIVE_LEVELS[LIVE_LEVELS.length - 1],
      grid: cloneGrid((GRIDS[index] || GRIDS[GRIDS.length - 1])()),
      currentPiece: (() => {
        const p = pieces[index] || pieces[0];
        return { typeId: p.typeId, x: p.x, y: p.y, blocks: p.blocks.map((block) => block.slice()) };
      })(),
      ghostY: ghostYs[index] != null ? ghostYs[index] : ghostYs[ghostYs.length - 1],
      holdPiece: LIVE_HOLD[index] || LIVE_HOLD[LIVE_HOLD.length - 1],
      nextPieces: (LIVE_NEXT[index] || LIVE_NEXT[LIVE_NEXT.length - 1]).slice(),
      pendingGarbage: index === 0 ? 3 : index === 2 ? 2 : 0,
      playerName: 'Player ' + (index + 1),
      playerColor: PLAYER_COLORS[index % PLAYER_COLORS.length]
    })),
    elapsed: options.elapsed || 65000
  };
}

function buildResults(playerIds) {
  return {
    elapsed: 185000,
    results: playerIds.map((id, index) => ({
      rank: index + 1,
      playerId: id,
      playerName: 'Player ' + (index + 1),
      playerColor: PLAYER_COLORS[index % PLAYER_COLORS.length],
      score: RESULT_SCORE[index] || RESULT_SCORE[RESULT_SCORE.length - 1],
      lines: RESULT_LINES[index] || RESULT_LINES[RESULT_LINES.length - 1],
      level: RESULT_LEVELS[index] || RESULT_LEVELS[RESULT_LEVELS.length - 1]
    }))
  };
}

module.exports = {
  PLAYER_COLORS,
  buildPlayers,
  buildPlayerIds,
  buildGameState,
  buildResults,
};
