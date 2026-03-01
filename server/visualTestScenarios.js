'use strict';

const { MSG, ROOM_STATE } = require('../public/shared/protocol.js');

const LIVE_SCORE = [12450, 8320, 5100, 2800];
const LIVE_LINES = [24, 16, 10, 5];
const LIVE_LEVELS = [3, 2, 2, 1];
const LIVE_GHOST_Y = [12, 14, 13, 15];
const LIVE_HOLD = ['I', 'T', 'Z', 'O'];
const LIVE_NEXT = [
  ['L', 'S', 'Z', 'O', 'J'],
  ['T', 'I', 'L', 'S', 'Z'],
  ['O', 'J', 'T', 'I', 'L'],
  ['S', 'Z', 'O', 'J', 'T']
];
const LIVE_PIECES = [
  { typeId: 6, x: 4, y: 2, blocks: [[0, 0], [1, 0], [2, 0], [1, 1]] },
  { typeId: 1, x: 3, y: 4, blocks: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { typeId: 3, x: 5, y: 6, blocks: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  { typeId: 5, x: 1, y: 8, blocks: [[0, 0], [1, 0], [0, 1], [1, 1]] }
];
const RESULT_SCORE = [24800, 18200, 12100, 5400];
const RESULT_LINES = [48, 36, 24, 10];
const RESULT_LEVELS = [5, 4, 3, 2];

function createPrimaryGrid() {
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[19] = [1, 7, 7, 3, 3, 3, 0, 2, 2, 2];
  grid[18] = [1, 0, 7, 3, 0, 0, 0, 0, 2, 0];
  grid[17] = [1, 0, 7, 0, 0, 0, 0, 0, 0, 0];
  grid[16] = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  grid[15] = [8, 8, 8, 0, 8, 8, 8, 8, 8, 8];
  grid[14] = [8, 8, 8, 8, 8, 0, 8, 8, 8, 8];
  return grid;
}

function createSecondaryGrid() {
  const grid = Array.from({ length: 20 }, () => Array(10).fill(0));
  grid[19] = [5, 5, 0, 0, 4, 4, 6, 6, 6, 0];
  grid[18] = [5, 5, 0, 0, 4, 4, 0, 6, 0, 0];
  grid[17] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  grid[16] = [8, 8, 0, 8, 8, 8, 8, 8, 8, 8];
  return grid;
}

function cloneGrid(grid) {
  return grid.map((row) => row.slice());
}

function getPlayers(room) {
  return [...room.players.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, player], index) => ({
      id,
      index,
      name: player.name,
      color: player.color
    }));
}

function clearRoomRuntime(room) {
  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
  }
  if (room._goTimeout) {
    clearTimeout(room._goTimeout);
    room._goTimeout = null;
  }
  if (room.game) {
    room.game.stop();
    room.game = null;
  }
  room._countdownCallback = null;
  room._countdownRemaining = 0;
}

function buildGameState(room, options) {
  const players = getPlayers(room);
  const deadIds = new Set(options.deadPlayerIds || []);
  const allDead = !!options.allDead;

  return {
    players: players.map((player, index) => ({
      id: player.id,
      alive: allDead ? false : !deadIds.has(player.id),
      score: LIVE_SCORE[index] || LIVE_SCORE[LIVE_SCORE.length - 1],
      lines: LIVE_LINES[index] || LIVE_LINES[LIVE_LINES.length - 1],
      level: LIVE_LEVELS[index] || LIVE_LEVELS[LIVE_LEVELS.length - 1],
      grid: cloneGrid(index === 0 ? createPrimaryGrid() : createSecondaryGrid()),
      currentPiece: {
        typeId: LIVE_PIECES[index]?.typeId || LIVE_PIECES[0].typeId,
        x: LIVE_PIECES[index]?.x || LIVE_PIECES[0].x,
        y: LIVE_PIECES[index]?.y || LIVE_PIECES[0].y,
        blocks: (LIVE_PIECES[index]?.blocks || LIVE_PIECES[0].blocks).map((block) => block.slice())
      },
      ghostY: LIVE_GHOST_Y[index] || LIVE_GHOST_Y[LIVE_GHOST_Y.length - 1],
      holdPiece: LIVE_HOLD[index] || LIVE_HOLD[LIVE_HOLD.length - 1],
      nextPieces: (LIVE_NEXT[index] || LIVE_NEXT[LIVE_NEXT.length - 1]).slice(),
      pendingGarbage: index === 0 ? 3 : index === 2 ? 2 : 0,
      playerName: player.name,
      playerColor: player.color
    })),
    elapsed: options.elapsed || 65000
  };
}

function buildResults(room) {
  return {
    elapsed: 185000,
    results: getPlayers(room).map((player, index) => ({
      rank: index + 1,
      playerId: player.id,
      playerName: player.name,
      score: RESULT_SCORE[index] || RESULT_SCORE[RESULT_SCORE.length - 1],
      lines: RESULT_LINES[index] || RESULT_LINES[RESULT_LINES.length - 1],
      level: RESULT_LEVELS[index] || RESULT_LEVELS[RESULT_LEVELS.length - 1]
    }))
  };
}

function broadcastPlayerStates(room, gameState) {
  for (const playerState of gameState.players) {
    room.sendToPlayer(playerState.id, MSG.PLAYER_STATE, {
      score: playerState.score,
      level: playerState.level,
      lines: playerState.lines,
      alive: playerState.alive,
      garbageIncoming: playerState.pendingGarbage || 0
    });
  }
}

function enterPlayingSnapshot(room, options) {
  clearRoomRuntime(room);
  room.state = ROOM_STATE.PLAYING;
  room.paused = false;
  room._lastResults = null;

  const gameState = buildGameState(room, options || {});
  room.sendToDisplay(MSG.COUNTDOWN, { value: 'GO' });
  room.broadcastToControllers(MSG.GAME_START, {});
  room.sendToDisplay(MSG.GAME_STATE, gameState);
  broadcastPlayerStates(room, gameState);

  return gameState;
}

function applyVisualScenario(room, scenarioName, scenarioOptions) {
  const players = getPlayers(room);
  if (players.length === 0) {
    throw new Error('Room has no joined players');
  }

  switch (scenarioName) {
    case 'game': {
      enterPlayingSnapshot(room, scenarioOptions || {});
      return;
    }

    case 'pause': {
      enterPlayingSnapshot(room, scenarioOptions || {});
      room.paused = true;
      room.broadcast(MSG.GAME_PAUSED, {});
      return;
    }

    case 'ko': {
      const deadPlayerId = scenarioOptions && scenarioOptions.deadPlayerId
        ? scenarioOptions.deadPlayerId
        : players[Math.min(1, players.length - 1)].id;
      enterPlayingSnapshot(room, { deadPlayerIds: [deadPlayerId] });
      room.sendToDisplay(MSG.PLAYER_KO, { playerId: deadPlayerId });
      room.sendToPlayer(deadPlayerId, MSG.GAME_OVER, { playerId: deadPlayerId });
      return;
    }

    case 'results': {
      enterPlayingSnapshot(room, { allDead: true, elapsed: 185000 });
      room.state = ROOM_STATE.RESULTS;
      room.paused = false;
      room._lastResults = buildResults(room);
      room.broadcast(MSG.GAME_END, room._lastResults);
      return;
    }

    default:
      throw new Error(`Unknown visual scenario: ${scenarioName}`);
  }
}

module.exports = {
  applyVisualScenario
};
