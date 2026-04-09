// @ts-check
// Visual test fixture data — moved from server/visualTestScenarios.js

const { PLAYER_COLORS } = require('../../public/shared/theme.js');

// Compute ghost Y by dropping a piece down a grid until it collides.
// Grid is 22 visible rows; piece blocks are [col, row] offsets.
function computeGhostY(grid, piece) {
  const rows = grid.length;
  const cols = grid[0].length;
  let y = piece.y;
  while (true) {
    y += 1;
    var blocked = piece.blocks.some(function(b) {
      var gx = piece.x + b[0];
      var gy = y + b[1];
      return gy >= rows || gx < 0 || gx >= cols || grid[gy][gx] !== 0;
    });
    if (blocked) return y - 1;
  }
}

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


const RESULT_LINES = [48, 36, 24, 10, 40, 28, 18, 6];
const RESULT_LEVELS = [5, 4, 3, 2, 5, 3, 2, 1];

// All grids keep piece blocks strictly above garbage rows (no colored blocks in garbage).
// Each board uses a unique combination of pieces and layout for visual variety.

function createGrid1() {
  // Player 1 — tallest stack
  //   J(2) cols 0-2  |  Z(7) cols 1-3  |  I(1) vertical col 5  |  L(3) cols 7-9
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[16] = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  grid[17] = [0, 7, 7, 0, 0, 1, 0, 0, 0, 0];
  grid[18] = [2, 0, 7, 7, 0, 1, 0, 0, 0, 3];
  grid[19] = [2, 2, 2, 0, 0, 1, 0, 3, 3, 3];
  grid[20] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  grid[21] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  return grid;
}

function createGrid2() {
  // Player 2 — medium stack
  //   S(5) cols 0-2  |  O(4) cols 4-5  |  T(6) cols 6-8
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[18] = [0, 5, 5, 0, 4, 4, 6, 6, 6, 0];
  grid[19] = [5, 5, 0, 0, 4, 4, 0, 6, 0, 0];
  grid[20] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  grid[21] = [8, 8, 0, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid3() {
  // Player 3 — lighter stack
  //   I(1) horizontal cols 0-3  |  Z(7) cols 7-8
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[17] = [0, 0, 0, 0, 0, 0, 0, 0, 7, 0];
  grid[18] = [0, 0, 0, 0, 0, 0, 0, 7, 7, 0];
  grid[19] = [1, 1, 1, 1, 0, 0, 0, 7, 0, 0];
  grid[20] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  grid[21] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid4() {
  // Player 4 — sparsest stack
  //   S(5) cols 1-2  |  L(3) cols 6-7
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[17] = [0, 5, 0, 0, 0, 0, 3, 3, 0, 0];
  grid[18] = [0, 5, 5, 0, 0, 0, 0, 3, 0, 0];
  grid[19] = [0, 0, 5, 0, 0, 0, 0, 3, 0, 0];
  grid[20] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  grid[21] = [8, 0, 8, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid5() {
  // Player 5 — medium-tall stack
  //   S(5) cols 0-1  |  L(3) cols 2-3  |  T(6) cols 5-7  |  J(2) cols 8-9
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[17] = [0, 0, 0, 0, 0, 0, 0, 0, 2, 0];
  grid[18] = [0, 0, 0, 0, 0, 6, 6, 6, 2, 0];
  grid[19] = [5, 5, 3, 3, 0, 0, 6, 0, 2, 2];
  grid[20] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  grid[21] = [8, 8, 0, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid6() {
  // Player 6 — medium stack
  //   O(4) cols 0-1  |  S(5) cols 7-9
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[18] = [4, 4, 0, 0, 0, 0, 0, 5, 5, 0];
  grid[19] = [4, 4, 0, 0, 0, 0, 5, 5, 0, 0];
  grid[20] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  grid[21] = [8, 0, 8, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid7() {
  // Player 7 — light stack
  //   L(3) cols 5-7  |  I(1) cols 0-3
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[18] = [0, 0, 0, 0, 0, 0, 0, 3, 0, 0];
  grid[19] = [1, 1, 1, 1, 0, 3, 3, 3, 0, 0];
  grid[20] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  grid[21] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  return grid;
}

function createGrid8() {
  // Player 8 — sparsest stack
  //   Z(7) cols 2-4
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[19] = [0, 0, 7, 7, 0, 0, 0, 0, 0, 0];
  grid[20] = [8, 8, 0, 7, 7, 8, 8, 8, 0, 8];
  grid[21] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
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

  return {
    players: playerIds.map((id, index) => {
      const grid = cloneGrid((GRIDS[index] || GRIDS[GRIDS.length - 1])());
      const p = pieces[index] || pieces[0];
      const piece = { typeId: p.typeId, x: p.x, y: p.y, blocks: p.blocks.map((block) => block.slice()) };
      return {
        id: id,
        alive: allDead ? false : !deadIds.has(id),

        lines: LIVE_LINES[index] || LIVE_LINES[LIVE_LINES.length - 1],
        level: LIVE_LEVELS[index] || LIVE_LEVELS[LIVE_LEVELS.length - 1],
        grid: grid,
        currentPiece: piece,
        ghostY: computeGhostY(grid, piece),
        holdPiece: LIVE_HOLD[index] || LIVE_HOLD[LIVE_HOLD.length - 1],
        nextPieces: (LIVE_NEXT[index] || LIVE_NEXT[LIVE_NEXT.length - 1]).slice(),
        pendingGarbage: index === 0 ? 3 : index === 2 ? 2 : 0,
        playerName: 'Player ' + (index + 1),
        playerColor: PLAYER_COLORS[index % PLAYER_COLORS.length]
      };
    }),
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
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  // Fully supported: every non-zero cell at row R either is at row 21 or has
  // a non-zero cell directly below at row R+1.
  // Garbage gap at col 7 — no pieces placed above col 7.
  // col:       0  1  2  3  4  5  6  7  8  9
  grid[21] = [ 8, 8, 8, 8, 8, 8, 8, 0, 8, 8]; // garbage
  grid[20] = [ 8, 8, 8, 8, 8, 8, 8, 0, 8, 8]; // garbage
  grid[19] = [ 1, 1, 1, 1, 6, 5, 5, 0, 7, 7]; // I, T top, S bot, Z top
  grid[18] = [ 4, 4, 2, 3, 6, 6, 5, 0, 0, 7]; // O bot, J top, L top, T base, S top, Z bot
  grid[17] = [ 4, 4, 2, 2, 2, 3, 3, 0, 0, 0]; // O top, J base, L bot
  grid[16] = [ 0, 0, 0, 0, 0, 0, 3, 0, 0, 0]; // L top
  return grid;
}

// Build a game state with all 3 style tiers visible (3 players, one per tier)
// Each board shows all 7 piece colors + garbage
function buildStyleTierGameState(playerIds) {
  const tierLevels = [3, 8, 13]; // Normal, Pillow, Neon
  const tierLines  = [20, 70, 120]; // lines matching those levels
  const tierNames  = ['Normal', 'Pillow', 'Neon'];
  const allColorsGrid = createAllColorsGrid();

  const tierPiece = { typeId: 6, x: 4, y: 3, blocks: [[1, 0], [0, 1], [1, 1], [2, 1]] };

  return {
    players: playerIds.map((id, index) => {
      const grid = cloneGrid(allColorsGrid);
      return {
      id: id,
      alive: true,

      lines: tierLines[index] || tierLines[0],
      level: tierLevels[index] || tierLevels[0],
      grid: grid,
      currentPiece: {
        typeId: tierPiece.typeId, x: tierPiece.x, y: tierPiece.y,
        blocks: tierPiece.blocks.map(function(b) { return b.slice(); })
      },
      ghostY: computeGhostY(grid, tierPiece),
      holdPiece: 'I',
      nextPieces: ['J', 'L', 'O', 'S', 'Z'],
      pendingGarbage: 2,
      playerName: tierNames[index] || ('Player ' + (index + 1)),
      playerColor: PLAYER_COLORS[index % PLAYER_COLORS.length]
      };
    }),
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
  const tierLevelMap = { 3: 'Normal', 8: 'Pillow', 13: 'Neon' };
  const tierName = tierLevelMap[tierLevel] || 'Normal';

  // All 7 piece definitions (blocks are [col, row] offsets from position)
  const allPieces = [
    { typeId: 1, blocks: [[0,0],[1,0],[2,0],[3,0]] },  // I
    { typeId: 2, blocks: [[0,0],[0,1],[1,1],[2,1]] },  // J
    { typeId: 3, blocks: [[2,0],[0,1],[1,1],[2,1]] },  // L
    { typeId: 4, blocks: [[0,0],[1,0],[0,1],[1,1]] },  // O
    { typeId: 5, blocks: [[1,0],[2,0],[0,1],[1,1]] },  // S
    { typeId: 6, blocks: [[1,0],[0,1],[1,1],[2,1]] },  // T
    { typeId: 7, blocks: [[0,0],[1,0],[1,1],[2,1]] },  // Z
  ];

  // Solid pieces in rows 2-6, ghosts in rows 12-18 (same positions)
  const piecePositions = [
    { x: 0, y: 2 },   // I at cols 0-3
    { x: 0, y: 5 },   // J at cols 0-2
    { x: 4, y: 5 },   // L at cols 4-6
    { x: 8, y: 5 },   // O at cols 8-9
    { x: 0, y: 8 },   // S at cols 0-2
    { x: 4, y: 8 },   // T at cols 4-6
    { x: 7, y: 8 },   // Z at cols 7-9
  ];

  const ghostPositions = piecePositions.map(p => ({ x: p.x, ghostY: p.y + 10 }));

  // 6 pieces as solid blocks (T is the active piece, shown separately)
  function createShowcaseGrid() {
    const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
    for (let i = 0; i < allPieces.length; i++) {
      if (allPieces[i].typeId === 6) continue; // T is the active piece
      const pos = piecePositions[i];
      for (const [bx, by] of allPieces[i].blocks) {
        grid[pos.y + by][pos.x + bx] = allPieces[i].typeId;
      }
    }
    return grid;
  }

  // 6 extra ghost definitions (T excluded — it's the active ghost)
  const extraPieces = allPieces.filter(p => p.typeId !== 6);

  // Active piece: T, same on all boards
  const tIdx = allPieces.findIndex(p => p.typeId === 6);
  const activeDef = allPieces[tIdx];
  const activeX = piecePositions[tIdx].x;
  const activeGhostY = ghostPositions[tIdx].ghostY;

  // Extra ghosts: all pieces except T (same on all boards)
  const extras = [];
  for (let i = 0; i < allPieces.length; i++) {
    if (i === tIdx) continue;
    extras.push({
      typeId: allPieces[i].typeId,
      x: ghostPositions[i].x,
      ghostY: ghostPositions[i].ghostY,
      blocks: allPieces[i].blocks.map(b => b.slice()),
    });
  }

  const extraGhostsPerPlayer = [];

  const players = playerIds.map((id, index) => {
    extraGhostsPerPlayer.push(extras);

    return {
      id: id,
      alive: true,

      lines: (tierLevel - 1) * 10,
      level: tierLevel,
      grid: createShowcaseGrid(),
      currentPiece: {
        typeId: activeDef.typeId,
        x: activeX,
        y: 8,
        blocks: activeDef.blocks.map(b => b.slice()),
      },
      ghostY: activeGhostY,
      holdPiece: null,
      nextPieces: [],
      pendingGarbage: 0,
      playerName: tierName + ' ' + (index + 1),
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
