// @ts-check
// Visual test fixture data — moved from server/visualTestScenarios.js

const PLAYER_COLORS = ['#e74856', '#4fc3f7', '#66bb6a', '#ffa726'];

const LIVE_SCORE = [12450, 8320, 5100, 2800];
const LIVE_LINES = [24, 16, 10, 5];
const LIVE_LEVELS = [3, 2, 2, 1];
const LIVE_GHOST_Y = [13, 14, 14, 14];
const LIVE_HOLD = ['O', 'S', 'T', 'I'];
const LIVE_NEXT = [
  ['I', 'T', 'Z', 'L', 'O'],
  ['T', 'J', 'O', 'S', 'Z'],
  ['Z', 'I', 'J', 'S', 'L'],
  ['L', 'O', 'T', 'I', 'S']
];
const LIVE_PIECES = [
  { typeId: 5, x: 4, y: 2, blocks: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  { typeId: 3, x: 3, y: 4, blocks: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  { typeId: 4, x: 5, y: 3, blocks: [[1, 0], [2, 0], [1, 1], [2, 1]] },
  { typeId: 7, x: 2, y: 5, blocks: [[0, 0], [1, 0], [1, 1], [2, 1]] }
];
const RESULT_SCORE = [24800, 18200, 12100, 5400];
const RESULT_LINES = [48, 36, 24, 10];
const RESULT_LEVELS = [5, 4, 3, 2];

function createPrimaryGrid() {
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[16] = [1, 7, 7, 3, 3, 3, 0, 2, 2, 2];
  grid[15] = [1, 0, 7, 3, 0, 0, 0, 0, 2, 0];
  grid[14] = [1, 0, 7, 0, 0, 0, 0, 0, 0, 0];
  grid[13] = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  grid[19] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  grid[18] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  grid[17] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  return grid;
}

function createSecondaryGrid() {
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[17] = [5, 5, 0, 0, 4, 4, 6, 6, 6, 0];
  grid[16] = [5, 5, 0, 0, 4, 4, 0, 6, 0, 0];
  grid[19] = [8, 8, 0, 8, 8, 8, 8, 8, 8, 8];
  grid[18] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  return grid;
}

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
      grid: cloneGrid(index === 0 ? createPrimaryGrid() : createSecondaryGrid()),
      currentPiece: {
        typeId: pieces[index]?.typeId || pieces[0].typeId,
        x: pieces[index]?.x || pieces[0].x,
        y: pieces[index]?.y || pieces[0].y,
        blocks: (pieces[index]?.blocks || pieces[0].blocks).map((block) => block.slice())
      },
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
