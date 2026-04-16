'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/Game');

function makeGame(playerIds, seed) {
  const players = new Map();
  for (const id of playerIds) {
    players.set(id, { startLevel: 1 });
  }
  const events = [];
  const gameEndCalls = [];
  const game = new Game(players, {
    onEvent: (e) => events.push(e),
    onGameEnd: (r) => gameEndCalls.push(r)
  }, seed || 42);
  game.init();
  return { game, events, gameEndCalls };
}

describe('Game - win condition', () => {

  test('onGameEnd fires once when last player dies (2-player)', () => {
    const { game, gameEndCalls } = makeGame(['p1', 'p2']);

    game.boards.get('p1').alive = false;
    game.update(16);

    assert.strictEqual(gameEndCalls.length, 1, 'onGameEnd called exactly once');
    assert.strictEqual(game.ended, true);
  });

  test('winner is alive player in results', () => {
    const { game, gameEndCalls } = makeGame(['p1', 'p2']);

    game.boards.get('p1').alive = false;
    game.update(16);

    const { results } = gameEndCalls[0];
    const p2 = results.find(r => r.playerId === 'p2');
    const p1 = results.find(r => r.playerId === 'p1');
    assert.strictEqual(p2.alive, true, 'p2 should be alive (winner)');
    assert.strictEqual(p1.alive, false, 'p1 should be dead');
    assert.strictEqual(p2.rank, 1, 'winner ranked 1st');
  });

  test('KO event is emitted for the dying player and precedes onGameEnd', () => {
    const { game, events, gameEndCalls } = makeGame(['p1', 'p2']);

    game.boards.get('p1').alive = false;
    game.update(16);

    const koEvents = events.filter(e => e.type === 'player_ko');
    assert.strictEqual(koEvents.length, 1, 'one KO event emitted');
    assert.strictEqual(koEvents[0].playerId, 'p1');
    // KO event must precede onGameEnd (events array captured in order)
    assert.strictEqual(gameEndCalls.length, 1);
  });

  test('simultaneous death: both players die in same update(), onGameEnd fires once', () => {
    const { game, events, gameEndCalls } = makeGame(['p1', 'p2']);

    // Kill both before the update loop runs (simulates two hard_drops in same tick)
    game.boards.get('p1').alive = false;
    game.boards.get('p2').alive = false;
    game.update(16);

    assert.strictEqual(gameEndCalls.length, 1, 'onGameEnd called exactly once');
    assert.strictEqual(game.ended, true);

    const koEvents = events.filter(e => e.type === 'player_ko');
    assert.strictEqual(koEvents.length, 2, 'KO emitted for both players');

    const { results } = gameEndCalls[0];
    assert.strictEqual(results.length, 2);
    assert.ok(results.every(r => r.alive === false), 'both players dead in results');
  });

  test('simultaneous death: both players dead in results (not partially alive)', () => {
    const { game, gameEndCalls } = makeGame(['p1', 'p2']);

    game.boards.get('p1').alive = false;
    game.boards.get('p2').alive = false;
    game.update(16);

    const { results } = gameEndCalls[0];
    for (const r of results) {
      assert.strictEqual(r.alive, false, `${r.playerId} should be dead in results`);
    }
  });

  test('update() is a no-op after game ends', () => {
    const { game, gameEndCalls } = makeGame(['p1', 'p2']);

    game.boards.get('p1').alive = false;
    game.update(16);
    assert.strictEqual(gameEndCalls.length, 1);

    // Further updates should not fire onGameEnd again
    game.update(16);
    game.update(16);
    assert.strictEqual(gameEndCalls.length, 1, 'onGameEnd not called again after game ended');
  });

  test('single player: onGameEnd fires when the only player dies', () => {
    const { game, gameEndCalls } = makeGame(['p1']);

    game.boards.get('p1').alive = false;
    game.update(16);

    assert.strictEqual(gameEndCalls.length, 1);
    const { results } = gameEndCalls[0];
    assert.strictEqual(results[0].playerId, 'p1');
    assert.strictEqual(results[0].alive, false);
  });

  test('3-player: game continues until only one remains', () => {
    const { game, gameEndCalls } = makeGame(['p1', 'p2', 'p3']);

    // p1 dies — game should continue (p2 and p3 still alive)
    game.boards.get('p1').alive = false;
    game.update(16);
    assert.strictEqual(gameEndCalls.length, 0, 'game should not end with 2 players alive');

    // p2 dies — now only p3 alive, game ends
    game.boards.get('p2').alive = false;
    game.update(16);
    assert.strictEqual(gameEndCalls.length, 1, 'game ends when one player remains');

    const { results } = gameEndCalls[0];
    const p3 = results.find(r => r.playerId === 'p3');
    assert.strictEqual(p3.alive, true, 'p3 is the winner');
    assert.strictEqual(p3.rank, 1);
  });

  test('elapsed time is included in results', () => {
    const { game, gameEndCalls } = makeGame(['p1', 'p2']);

    game.update(100);
    game.update(100);
    game.boards.get('p1').alive = false;
    game.update(16);

    assert.ok(gameEndCalls[0].elapsed >= 200, 'elapsed should reflect game time');
  });

});
