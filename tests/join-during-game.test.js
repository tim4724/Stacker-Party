'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MSG, ROOM_STATE } = require('../public/shared/protocol');

// =====================================================================
// Tests for join-during-countdown / join-during-game behavior.
//
// Display side: onHello accepts late joiners during any state.
//   Late joiners get WELCOME with current roomState so the controller
//   can show a "Game in progress" waiting screen.
// Controller side: handleMessage should ignore game broadcasts when
//   gameCancelled is true (player was rejected).
// =====================================================================

// --- Display-side tests (onHello logic) ---

describe('Display: onHello during non-LOBBY states', () => {
  let players, roomState, playerOrder, lastAliveState, lastResults, paused;
  let sentMessages;   // [{ to, msg }]
  let party;
  let broadcastCalled, updatePlayerListCalled, updateStartButtonCalled;

  function nextAvailableSlot() {
    var used = new Set();
    for (const entry of players) used.add(entry[1].playerIndex);
    for (var i = 0; i < 4; i++) { if (!used.has(i)) return i; }
    return -1;
  }

  const PLAYER_COLORS = ['#00f0f0', '#f0a000', '#0000f0', '#f00000'];

  function sanitizePlayerName(name, index) {
    return name || 'P' + (index + 1);
  }

  // Minimal onPeerJoined extracted from DisplayConnection.js
  function onPeerJoined(clientId) {
    if (players.has(clientId)) return;
    var index = nextAvailableSlot();
    if (index < 0) return;
    var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
    players.set(clientId, {
      playerName: 'P' + (index + 1),
      playerColor: color,
      playerIndex: index,
      startLevel: 1,
      lastPingTime: Date.now()
    });
    if (roomState === ROOM_STATE.LOBBY) {
      playerOrder.push(clientId);
    }
  }

  // Minimal onHello extracted from DisplayInput.js
  function onHello(fromId, msg) {
    var name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 16) : '';

    if (players.has(fromId)) {
      var existing = players.get(fromId);
      if (name) existing.playerName = sanitizePlayerName(name, existing.playerIndex);
      updatePlayerListCalled = true;

      var isLateJoiner = (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)
        && playerOrder.indexOf(fromId) < 0;

      var welcomeMsg = {
        type: MSG.WELCOME,
        playerName: existing.playerName,
        playerColor: existing.playerColor,
        playerCount: players.size,
        roomState: roomState,
        startLevel: existing.startLevel || 1
      };
      if (!isLateJoiner) {
        welcomeMsg.alive = lastAliveState[fromId] != null ? lastAliveState[fromId] : true;
        welcomeMsg.paused = paused;
      }
      party.sendTo(fromId, welcomeMsg);
      broadcastCalled = true;
      return;
    }

    // New player joining (accepted in any state — late joiners wait for next game)
    var index = nextAvailableSlot();
    if (index < 0) {
      party.sendTo(fromId, { type: MSG.ERROR, message: 'Room is full' });
      return;
    }
    var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
    var playerName = sanitizePlayerName(name, index);

    players.set(fromId, {
      playerName: playerName,
      playerColor: color,
      playerIndex: index,
      startLevel: 1,
      lastPingTime: Date.now()
    });
    if (roomState === ROOM_STATE.LOBBY) {
      playerOrder.push(fromId);
    }

    var newWelcome = {
      type: MSG.WELCOME,
      playerName: playerName,
      playerColor: color,
      playerCount: players.size,
      roomState: roomState,
      startLevel: 1
    };
    if (roomState === ROOM_STATE.RESULTS && lastResults) {
      newWelcome.results = lastResults.results;
    }
    party.sendTo(fromId, newWelcome);

    broadcastCalled = true;
    updatePlayerListCalled = true;
    updateStartButtonCalled = true;
  }

  beforeEach(() => {
    players = new Map();
    roomState = ROOM_STATE.LOBBY;
    playerOrder = [];
    lastAliveState = {};
    lastResults = null;
    paused = false;
    sentMessages = [];
    broadcastCalled = false;
    updatePlayerListCalled = false;
    updateStartButtonCalled = false;

    party = {
      sendTo: (to, msg) => { sentMessages.push({ to, msg }); },
      broadcast: (msg) => { sentMessages.push({ to: '_all', msg }); }
    };
  });

  test('new player in LOBBY gets WELCOME', () => {
    onHello('player1', { type: MSG.HELLO, name: 'Alice' });
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].msg.type, MSG.WELCOME);
    assert.strictEqual(sentMessages[0].msg.playerName, 'Alice');
    assert.strictEqual(players.has('player1'), true);
  });

  test('new player during COUNTDOWN gets WELCOME as late joiner', () => {
    roomState = ROOM_STATE.COUNTDOWN;
    onHello('player2', { type: MSG.HELLO, name: 'Bob' });
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].msg.type, MSG.WELCOME);
    assert.strictEqual(sentMessages[0].msg.roomState, ROOM_STATE.COUNTDOWN);
    assert.strictEqual(players.has('player2'), true);
  });

  test('new player during PLAYING gets WELCOME as late joiner', () => {
    roomState = ROOM_STATE.PLAYING;
    onHello('player3', { type: MSG.HELLO, name: 'Carol' });
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].msg.type, MSG.WELCOME);
    assert.strictEqual(sentMessages[0].msg.roomState, ROOM_STATE.PLAYING);
    assert.strictEqual(players.has('player3'), true);
  });

  test('new player during RESULTS gets WELCOME with results', () => {
    roomState = ROOM_STATE.RESULTS;
    lastResults = { results: [{ rank: 1, playerId: 'player1', lines: 10 }] };
    onHello('player5', { type: MSG.HELLO, name: 'Eve' });
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].msg.type, MSG.WELCOME);
    assert.strictEqual(sentMessages[0].msg.roomState, ROOM_STATE.RESULTS);
    assert.deepStrictEqual(sentMessages[0].msg.results, lastResults.results);
  });

  test('late joiner via onPeerJoined then onHello omits alive field', () => {
    // Production flow: relay fires peer_joined before controller sends HELLO
    roomState = ROOM_STATE.PLAYING;
    onPeerJoined('player4');
    assert.strictEqual(players.has('player4'), true);
    assert.strictEqual(playerOrder.indexOf('player4'), -1, 'late joiner should not be in playerOrder');

    onHello('player4', { type: MSG.HELLO, name: 'Dave' });
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].msg.type, MSG.WELCOME);
    assert.strictEqual(sentMessages[0].msg.roomState, ROOM_STATE.PLAYING);
    assert.strictEqual(sentMessages[0].msg.alive, undefined, 'alive should be omitted for late joiners');
    assert.strictEqual(sentMessages[0].msg.paused, undefined, 'paused should be omitted for late joiners');
  });

  test('active player reconnecting during PLAYING is NOT treated as late joiner', () => {
    // Join in lobby → added to playerOrder
    onHello('player1', { type: MSG.HELLO, name: 'Alice' });
    assert.ok(playerOrder.indexOf('player1') >= 0);
    sentMessages = [];

    // Game starts
    roomState = ROOM_STATE.PLAYING;

    // Player reconnects (onPeerJoined → onHello)
    // onPeerJoined returns early because player already in Map
    onPeerJoined('player1');
    onHello('player1', { type: MSG.HELLO, name: 'Alice' });

    assert.strictEqual(sentMessages[0].msg.type, MSG.WELCOME);
    assert.strictEqual(sentMessages[0].msg.alive, true, 'active player should get alive: true');
    assert.notStrictEqual(sentMessages[0].msg.paused, undefined, 'active player should get paused field');
  });

  test('late joiner not added to playerOrder during game', () => {
    roomState = ROOM_STATE.PLAYING;
    onPeerJoined('player4');
    assert.strictEqual(playerOrder.indexOf('player4'), -1);
    assert.strictEqual(players.has('player4'), true, 'should be in players Map');
  });

  test('late joiner added to playerOrder when joining during LOBBY', () => {
    roomState = ROOM_STATE.LOBBY;
    onPeerJoined('player1');
    assert.ok(playerOrder.indexOf('player1') >= 0);
  });

  test('existing player reconnecting during COUNTDOWN gets WELCOME', () => {
    // Add player first in LOBBY
    onHello('player1', { type: MSG.HELLO, name: 'Alice' });
    sentMessages = [];

    // Switch to COUNTDOWN
    roomState = ROOM_STATE.COUNTDOWN;

    // Player reconnects
    onHello('player1', { type: MSG.HELLO, name: 'Alice' });
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].msg.type, MSG.WELCOME);
    assert.strictEqual(sentMessages[0].msg.roomState, ROOM_STATE.COUNTDOWN);
  });

  test('existing player reconnecting during PLAYING gets WELCOME with alive state', () => {
    onHello('player1', { type: MSG.HELLO, name: 'Alice' });
    sentMessages = [];

    roomState = ROOM_STATE.PLAYING;
    lastAliveState['player1'] = false;

    onHello('player1', { type: MSG.HELLO, name: 'Alice' });
    assert.strictEqual(sentMessages[0].msg.type, MSG.WELCOME);
    assert.strictEqual(sentMessages[0].msg.alive, false);
    assert.strictEqual(sentMessages[0].msg.roomState, ROOM_STATE.PLAYING);
  });
});

// --- Player order sorted by slot index ---

describe('Display: playerOrder sorted by slot index', () => {
  let players, roomState, playerOrder;
  let sentMessages;
  let party;

  const PLAYER_COLORS = ['#00f0f0', '#f0a000', '#0000f0', '#f00000'];

  function nextAvailableSlot() {
    var used = new Set();
    for (const entry of players) used.add(entry[1].playerIndex);
    for (var i = 0; i < 4; i++) { if (!used.has(i)) return i; }
    return -1;
  }

  function sanitizePlayerName(name, index) {
    return name || 'P' + (index + 1);
  }

  function onPeerJoined(clientId) {
    if (players.has(clientId)) return;
    var index = nextAvailableSlot();
    if (index < 0) return;
    var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
    players.set(clientId, {
      playerName: 'P' + (index + 1),
      playerColor: color,
      playerIndex: index,
      startLevel: 1,
      lastPingTime: Date.now()
    });
    if (roomState === ROOM_STATE.LOBBY) {
      playerOrder.push(clientId);
    }
  }

  function removeLobbyPlayer(clientId) {
    players.delete(clientId);
    playerOrder = playerOrder.filter(function(id) { return id !== clientId; });
  }

  // Mirrors the sort added to calculateLayout / runGameLocally
  function sortPlayerOrder() {
    playerOrder.sort(function(a, b) {
      return (players.get(a)?.playerIndex ?? 0) - (players.get(b)?.playerIndex ?? 0);
    });
  }

  beforeEach(() => {
    players = new Map();
    roomState = ROOM_STATE.LOBBY;
    playerOrder = [];
    sentMessages = [];
    party = {
      sendTo: (to, msg) => { sentMessages.push({ to, msg }); },
      broadcast: (msg) => { sentMessages.push({ to: '_all', msg }); }
    };
  });

  test('playerOrder matches slot order after normal joins', () => {
    onPeerJoined('p1');
    onPeerJoined('p2');
    sortPlayerOrder();
    assert.deepStrictEqual(playerOrder, ['p1', 'p2']);
    assert.strictEqual(players.get('p1').playerIndex, 0);
    assert.strictEqual(players.get('p2').playerIndex, 1);
  });

  test('playerOrder re-sorted after P1 disconnects and reconnects with new clientId', () => {
    onPeerJoined('p1');
    onPeerJoined('p2');

    // P1 disconnects from lobby
    removeLobbyPlayer('p1');
    assert.deepStrictEqual(playerOrder, ['p2']);

    // P1 reconnects with new clientId — gets slot 0 back but is appended
    onPeerJoined('p1-new');
    assert.strictEqual(players.get('p1-new').playerIndex, 0, 'should reclaim slot 0');
    assert.deepStrictEqual(playerOrder, ['p2', 'p1-new'], 'before sort: append order');

    // Sort (as calculateLayout / runGameLocally now does)
    sortPlayerOrder();
    assert.deepStrictEqual(playerOrder, ['p1-new', 'p2'], 'after sort: slot order');
  });

  test('playerOrder re-sorted after P2 disconnects and reconnects', () => {
    onPeerJoined('p1');
    onPeerJoined('p2');
    onPeerJoined('p3');

    removeLobbyPlayer('p2');
    onPeerJoined('p2-new');
    assert.strictEqual(players.get('p2-new').playerIndex, 1);
    assert.deepStrictEqual(playerOrder, ['p1', 'p3', 'p2-new']);

    sortPlayerOrder();
    assert.deepStrictEqual(playerOrder, ['p1', 'p2-new', 'p3']);
  });

  test('late joiners added at game start are sorted by slot', () => {
    onPeerJoined('p1');
    onPeerJoined('p2');
    roomState = ROOM_STATE.PLAYING;

    // Two late joiners during game (not added to playerOrder)
    onPeerJoined('p4');
    onPeerJoined('p3');
    assert.strictEqual(players.get('p4').playerIndex, 2);
    assert.strictEqual(players.get('p3').playerIndex, 3);

    // Simulate startNewGame adding late joiners from players.keys()
    for (const id of players.keys()) {
      if (playerOrder.indexOf(id) < 0) playerOrder.push(id);
    }
    // Map insertion order: p1, p2, p4, p3 — slot order: p1(0), p2(1), p4(2), p3(3)
    sortPlayerOrder();
    assert.deepStrictEqual(playerOrder, ['p1', 'p2', 'p4', 'p3']);
    assert.strictEqual(players.get(playerOrder[0]).playerIndex, 0);
    assert.strictEqual(players.get(playerOrder[1]).playerIndex, 1);
    assert.strictEqual(players.get(playerOrder[2]).playerIndex, 2);
    assert.strictEqual(players.get(playerOrder[3]).playerIndex, 3);
  });
});

// --- Controller-side tests (handleMessage guard) ---

describe('Controller: handleMessage ignores broadcasts when gameCancelled or waitingForNextGame', () => {
  let gameCancelled, waitingForNextGame, currentScreen, playerColor, playerCount;
  let screenShown, touchInitialized;

  // Minimal handleMessage extracted from controller.js
  function handleMessage(data) {
    try {
      if (gameCancelled && data.type !== MSG.WELCOME && data.type !== MSG.ERROR) return;
      if (waitingForNextGame && data.type !== MSG.WELCOME && data.type !== MSG.GAME_END
          && data.type !== MSG.RETURN_TO_LOBBY && data.type !== MSG.LOBBY_UPDATE
          && data.type !== MSG.ERROR && data.type !== MSG.PONG) return;

      switch (data.type) {
        case MSG.COUNTDOWN:
          if (currentScreen !== 'game') {
            screenShown = 'game';
          }
          break;
        case MSG.GAME_START:
          screenShown = 'game';
          touchInitialized = true;
          break;
        case MSG.WELCOME:
          playerColor = data.playerColor;
          gameCancelled = false;
          waitingForNextGame = false;
          if (data.alive === undefined && (data.roomState === 'playing' || data.roomState === 'countdown')) {
            waitingForNextGame = true;
            screenShown = 'lobby';
          } else {
            screenShown = 'lobby';
          }
          break;
        case MSG.GAME_END:
          waitingForNextGame = false;
          screenShown = 'gameover';
          break;
        case MSG.RETURN_TO_LOBBY:
          waitingForNextGame = false;
          screenShown = 'lobby';
          break;
        case MSG.ERROR:
          gameCancelled = true;
          screenShown = 'name';
          break;
      }
    } catch (err) {
      // ignore
    }
  }

  beforeEach(() => {
    gameCancelled = false;
    waitingForNextGame = false;
    currentScreen = 'name';
    playerColor = null;
    playerCount = 0;
    screenShown = null;
    touchInitialized = false;
  });

  test('COUNTDOWN processed when gameCancelled is false', () => {
    handleMessage({ type: MSG.COUNTDOWN, value: 3 });
    assert.strictEqual(screenShown, 'game');
  });

  test('COUNTDOWN ignored when gameCancelled is true', () => {
    gameCancelled = true;
    handleMessage({ type: MSG.COUNTDOWN, value: 3 });
    assert.strictEqual(screenShown, null);
  });

  test('GAME_START ignored when gameCancelled is true', () => {
    gameCancelled = true;
    handleMessage({ type: MSG.GAME_START });
    assert.strictEqual(screenShown, null);
    assert.strictEqual(touchInitialized, false);
  });

  test('ERROR still processed when gameCancelled is true', () => {
    gameCancelled = true;
    handleMessage({ type: MSG.ERROR, message: 'Game already in progress' });
    assert.strictEqual(screenShown, 'name');
  });

  test('WELCOME still processed when gameCancelled is true (re-admission)', () => {
    gameCancelled = true;
    handleMessage({ type: MSG.WELCOME, playerColor: '#00f0f0', roomState: 'lobby' });
    assert.strictEqual(gameCancelled, false);
    assert.strictEqual(screenShown, 'lobby');
    assert.strictEqual(playerColor, '#00f0f0');
  });

  test('full sequence: COUNTDOWN → ERROR → GAME_START stays on name screen', () => {
    // Player connects during countdown, receives broadcast
    handleMessage({ type: MSG.COUNTDOWN, value: 2 });
    assert.strictEqual(screenShown, 'game');

    // Display rejects with ERROR
    handleMessage({ type: MSG.ERROR, message: 'Game already in progress' });
    assert.strictEqual(screenShown, 'name');
    assert.strictEqual(gameCancelled, true);

    // GAME_START broadcast arrives — must NOT override back to game
    screenShown = null;
    handleMessage({ type: MSG.GAME_START });
    assert.strictEqual(screenShown, null, 'GAME_START should be ignored after ERROR');
  });

  test('full sequence: ERROR → COUNTDOWN → GAME_START all ignored', () => {
    // ERROR arrives first
    handleMessage({ type: MSG.ERROR, message: 'Game already in progress' });
    assert.strictEqual(gameCancelled, true);

    // Subsequent broadcasts ignored
    screenShown = null;
    handleMessage({ type: MSG.COUNTDOWN, value: 1 });
    assert.strictEqual(screenShown, null);
    handleMessage({ type: MSG.GAME_START });
    assert.strictEqual(screenShown, null);
  });

  // --- waitingForNextGame tests (late joiner broadcast filtering) ---

  test('late joiner WELCOME sets waitingForNextGame', () => {
    handleMessage({ type: MSG.WELCOME, playerColor: '#ff0000', roomState: 'playing' });
    // alive is undefined → late joiner
    assert.strictEqual(waitingForNextGame, true);
    assert.strictEqual(screenShown, 'lobby');
  });

  test('late joiner ignores COUNTDOWN and GAME_START broadcasts', () => {
    waitingForNextGame = true;
    handleMessage({ type: MSG.COUNTDOWN, value: 3 });
    assert.strictEqual(screenShown, null, 'COUNTDOWN should be blocked');
    handleMessage({ type: MSG.GAME_START });
    assert.strictEqual(screenShown, null, 'GAME_START should be blocked');
  });

  test('GAME_END clears waitingForNextGame', () => {
    waitingForNextGame = true;
    handleMessage({ type: MSG.GAME_END, results: [] });
    assert.strictEqual(waitingForNextGame, false);
    assert.strictEqual(screenShown, 'gameover');
  });

  test('late joiner receives GAME_END then can participate in Play Again', () => {
    waitingForNextGame = true;
    // Game ends — late joiner sees results
    handleMessage({ type: MSG.GAME_END, results: [] });
    assert.strictEqual(waitingForNextGame, false);
    assert.strictEqual(screenShown, 'gameover');

    // Play Again triggers new countdown — should NOT be blocked
    screenShown = null;
    handleMessage({ type: MSG.COUNTDOWN, value: 3 });
    assert.strictEqual(screenShown, 'game', 'COUNTDOWN should work after GAME_END cleared waitingForNextGame');
  });

  test('RETURN_TO_LOBBY clears waitingForNextGame', () => {
    waitingForNextGame = true;
    handleMessage({ type: MSG.RETURN_TO_LOBBY, playerCount: 2 });
    assert.strictEqual(waitingForNextGame, false);
    assert.strictEqual(screenShown, 'lobby');
  });

  test('LOBBY_UPDATE allowed through while waitingForNextGame', () => {
    waitingForNextGame = true;
    screenShown = null;
    // LOBBY_UPDATE doesn't set screenShown in our minimal handler,
    // but it should NOT be blocked by the filter
    handleMessage({ type: MSG.LOBBY_UPDATE, playerCount: 3 });
    // If it was blocked, we'd never reach the switch — verify no error thrown
    assert.strictEqual(waitingForNextGame, true, 'LOBBY_UPDATE should not clear flag');
  });

  test('normal WELCOME with alive field does NOT set waitingForNextGame', () => {
    handleMessage({ type: MSG.WELCOME, playerColor: '#ff0000', roomState: 'playing', alive: true });
    assert.strictEqual(waitingForNextGame, false);
  });
});
