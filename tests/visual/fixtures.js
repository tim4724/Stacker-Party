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

// Level overrides per style tier (for visual tests)
const TIER_LEVELS = {
  normal:   [3, 3],
  pillow:   [8, 8],
  neon:     [13, 13],
};

// Grid with all 7 piece types + garbage, realistically stacked (no floating pieces)
// Every non-zero cell either sits on the bottom row or on another non-zero cell below it.
function createAllColorsGrid() {
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  // Fully supported: every non-zero cell at row R either is at row 19 or has
  // a non-zero cell directly below at row R+1.
  // Garbage gap at col 7 — no pieces placed above col 7.
  // col:       0  1  2  3  4  5  6  7  8  9
  grid[19] = [ 8, 8, 8, 8, 8, 8, 8, 0, 8, 8]; // garbage
  grid[18] = [ 8, 8, 8, 8, 8, 8, 8, 0, 8, 8]; // garbage
  grid[17] = [ 1, 1, 1, 1, 6, 5, 5, 0, 7, 7]; // I, T top, S bot, Z top
  grid[16] = [ 4, 4, 2, 3, 6, 6, 5, 0, 0, 7]; // O bot, J top, L top, T base, S top, Z bot
  grid[15] = [ 4, 4, 2, 2, 2, 3, 3, 0, 0, 0]; // O top, J base, L bot
  grid[14] = [ 0, 0, 0, 0, 0, 0, 3, 0, 0, 0]; // L top
  return grid;
}

// Build a game state with all 4 style tiers visible (4 players, one per tier)
// Each board shows all 7 piece colors + garbage
function buildStyleTierGameState(playerIds) {
  const tierLevels = [3, 8, 13]; // Normal, Square, Neon
  const tierLines  = [20, 70, 120]; // lines matching those levels
  const tierNames  = ['Normal', 'Square', 'Neon'];
  const allColorsGrid = createAllColorsGrid();

  return {
    players: playerIds.map((id, index) => ({
      id: id,
      alive: true,
      score: LIVE_SCORE[index] || LIVE_SCORE[0],
      lines: tierLines[index] || tierLines[0],
      level: tierLevels[index] || tierLevels[0],
      grid: cloneGrid(allColorsGrid),
      currentPiece: {
        typeId: 6, x: 4, y: 3,
        blocks: [[1, 0], [0, 1], [1, 1], [2, 1]]
      },
      ghostY: 11,
      holdPiece: 'I',
      nextPieces: ['J', 'L', 'O', 'S', 'Z'],
      pendingGarbage: 2,
      playerName: tierNames[index] || ('Player ' + (index + 1)),
      playerColor: PLAYER_COLORS[index % PLAYER_COLORS.length]
    })),
    elapsed: 65000
  };
}

// Build a state showing all 7 piece types with ghosts in each style tier.
// 4 players (one per tier), each board has 7 active pieces at top + 7 ghosts below.
// Uses a fake multi-piece layout (unrealistic but shows every ghost clearly).
// Build a state where every player board shows all 7 pieces as solid blocks at the top
// AND all 7 ghost outlines at the bottom, all at the same style tier.
// Uses extraGhosts (rendered by BoardRenderer) for the 6 non-active ghost pieces.
function buildAllPiecesGhostState(playerIds, tierLevel) {
  const tierLevelMap = { 3: 'Normal', 8: 'Square', 13: 'Neon' };
  const tierName = tierLevelMap[tierLevel] || 'Normal';

  // All 7 pieces as solid blocks in rows 2-6
  function createShowcaseGrid() {
    const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
    // I(1) horizontal
    grid[2] = [0, 0, 0, 1, 1, 1, 1, 0, 0, 0];
    // J(2) + O(4) + L(3)
    grid[3] = [2, 0, 0, 4, 4, 0, 0, 0, 0, 3];
    grid[4] = [2, 2, 2, 4, 4, 5, 5, 0, 3, 3];
    // S(5) + T(6) + Z(7)
    grid[5] = [0, 0, 6, 0, 5, 5, 7, 7, 3, 0];
    grid[6] = [0, 6, 6, 6, 0, 0, 0, 7, 7, 0];
    return grid;
  }

  // All 7 piece definitions for active + ghost placement
  const allPieces = [
    { typeId: 1, blocks: [[0,0],[1,0],[2,0],[3,0]] },  // I
    { typeId: 2, blocks: [[0,0],[0,1],[1,1],[2,1]] },  // J
    { typeId: 3, blocks: [[2,0],[0,1],[1,1],[2,1]] },  // L
    { typeId: 4, blocks: [[0,0],[1,0],[0,1],[1,1]] },  // O
    { typeId: 5, blocks: [[1,0],[2,0],[0,1],[1,1]] },  // S
    { typeId: 6, blocks: [[1,0],[0,1],[1,1],[2,1]] },  // T
    { typeId: 7, blocks: [[0,0],[1,0],[1,1],[2,1]] },  // Z
  ];

  // Ghost row positions — spread across rows 10-18, spaced by 2 rows per piece
  // Active piece ghost at row 10, extra ghosts at rows 12, 14, 16, 18 etc.
  // Place them at different x positions so they don't overlap
  const ghostPositions = [
    { x: 0, ghostY: 10 },  // I at cols 0-3
    { x: 0, ghostY: 13 },  // J at cols 0-2
    { x: 4, ghostY: 13 },  // L at cols 4-6
    { x: 8, ghostY: 13 },  // O at cols 8-9
    { x: 0, ghostY: 16 },  // S at cols 0-2
    { x: 4, ghostY: 16 },  // T at cols 4-6
    { x: 7, ghostY: 16 },  // Z at cols 7-9
  ];

  const pieceLabels = ['I', 'J', 'L', 'O', 'S', 'T', 'Z', 'I'];

  const extraGhostsPerPlayer = [];

  const players = playerIds.map((id, index) => {
    const activeIdx = index % 7;
    const activePos = ghostPositions[activeIdx];
    const activeDef = allPieces[activeIdx];

    // Build extra ghosts for the other 6 piece types
    const extras = [];
    for (let i = 0; i < 7; i++) {
      if (i === activeIdx) continue;
      extras.push({
        typeId: allPieces[i].typeId,
        x: ghostPositions[i].x,
        ghostY: ghostPositions[i].ghostY,
        blocks: allPieces[i].blocks.map(b => b.slice()),
      });
    }
    extraGhostsPerPlayer.push(extras);

    return {
      id: id,
      alive: true,
      score: 0,
      lines: (tierLevel - 1) * 10,
      level: tierLevel,
      grid: createShowcaseGrid(),
      currentPiece: {
        typeId: activeDef.typeId,
        x: activePos.x,
        y: 8,
        blocks: activeDef.blocks.map(b => b.slice()),
      },
      ghostY: activePos.ghostY,
      holdPiece: null,
      nextPieces: [],
      pendingGarbage: 0,
      playerName: tierName + ' ' + pieceLabels[index % 8],
      playerColor: PLAYER_COLORS[index % PLAYER_COLORS.length],
    };
  });

  return {
    state: { players, elapsed: 65000 },
    extraGhostsPerPlayer,
  };
}

module.exports = {
  PLAYER_COLORS,
  TIER_LEVELS,
  buildPlayers,
  buildPlayerIds,
  buildGameState,
  buildStyleTierGameState,
  buildAllPiecesGhostState,
  buildResults,
};
