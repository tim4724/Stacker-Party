'use strict';

// =====================================================================
// Display Test Harness — window.__TEST__ API and debug state builders
// Depends on: DisplayState.js (globals: urlParams, debugCount), DisplayUI.js, DisplayGame.js
// Loaded before display.js; only active when ?test=1 or ?debug=N
// =====================================================================

if (urlParams.get('test') === '1' || debugCount > 0) {
  window.__TEST__ = {
    addPlayers: function(playerList) {
      for (var i = 0; i < playerList.length; i++) {
        var p = playerList[i];
        var index = nextAvailableSlot();
        var color = PLAYER_COLORS[index % PLAYER_COLORS.length];
        players.set(p.id, {
          playerName: sanitizePlayerName(p.name, index),
          playerColor: color,
          playerIndex: index
        });
        playerOrder.push(p.id);
      }
      updatePlayerList();
      updateStartButton();
    },

    injectGameState: function(state) {
      setRoomState(ROOM_STATE.COUNTDOWN);
      setRoomState(ROOM_STATE.PLAYING);
      gameState = state;
      countdownOverlay.classList.add('hidden');
      showScreen(SCREEN.GAME);
      calculateLayout();
    },

    injectResults: function(results) {
      if (roomState === ROOM_STATE.LOBBY) {
        setRoomState(ROOM_STATE.COUNTDOWN);
        setRoomState(ROOM_STATE.PLAYING);
      }
      setRoomState(ROOM_STATE.RESULTS);
      lastResults = results;
      onGameEnd(results);
    },

    injectPause: function() {
      onGamePaused();
    },

    injectKO: function(playerId) {
      onPlayerKO({ playerId: playerId });
    },

    injectGarbageSent: function(data) {
      onGarbageSent(data);
    },

    injectCountdownGo: function() {
      onCountdownDisplay('GO');
    },

    setExtraGhosts: function(extraGhostsPerPlayer) {
      // Store for renderFrame to draw after each board render.
      // extraGhostsPerPlayer: array of arrays, one per player index.
      // Each inner array: [{ typeId, x, ghostY, blocks }]
      window.__TEST__._extraGhosts = extraGhostsPerPlayer;
    }
  };
}

// =====================================================================
// Debug State Builder
// =====================================================================

function _buildHexDebugState(debugPlayers) {
  var HC = GameConstants.COLS;
  var HV = GameConstants.VISIBLE_ROWS;
  var GC = GameConstants.GARBAGE_CELL;
  var types = GameConstants.PIECE_TYPES;
  var emptyRow = function() { var r = []; for (var i = 0; i < HC; i++) r.push(0); return r; };
  var fullRow = function(gap) { var r = []; for (var i = 0; i < HC; i++) r.push(i === gap ? 0 : GC); return r; };
  var state = { players: [], elapsed: 75000 };
  for (var dj = 0; dj < debugPlayers.length; dj++) {
    var grid = []; for (var r = 0; r < HV; r++) grid.push(emptyRow());
    for (var br = HV - 3; br < HV; br++) {
      for (var bc = 0; bc < HC; bc++) {
        if ((bc + br + dj) % 4 !== 0) grid[br][bc] = ((bc + br) % types.length) + 1;
      }
    }
    grid[HV - 1] = fullRow((dj * 2 + 3) % HC);
    var pt = types[dj % types.length];
    var piece = new PieceModule.Piece(pt);
    piece.anchorCol = 5; piece.anchorRow = 2;
    var blocks = piece.getAbsoluteBlocks();
    var ghostPiece = piece.clone(); ghostPiece.anchorRow = HV - 5;
    state.players.push({
      id: debugPlayers[dj].id, playerName: debugPlayers[dj].name,
      grid: grid, lines: [24,16,10,5,20,12,8,3][dj % 8], level: [3,2,2,1,3,2,1,1][dj % 8],
      alive: true,
      currentPiece: { type: pt, typeId: piece.typeId, anchorCol: 5, anchorRow: 2, cells: piece.cells, blocks: blocks },
      ghost: { anchorCol: ghostPiece.anchorCol, anchorRow: ghostPiece.anchorRow, blocks: ghostPiece.getAbsoluteBlocks() },
      nextPieces: [types[(dj+1)%types.length], types[(dj+2)%types.length], types[(dj+3)%types.length]],
      holdPiece: types[(dj+4)%types.length],
      pendingGarbage: dj % 3 === 0 ? 3 : 0
    });
  }
  return state;
}

// =====================================================================
// Debug Mode Init — called from display.js when ?debug=N
// =====================================================================

function initDebugMode(debugCount) {
  var debugNames = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];
  var debugPlayers = [];
  for (var di = 0; di < Math.min(debugCount, 8); di++) {
    debugPlayers.push({ id: 'debug' + di, name: debugNames[di] || ('P' + (di + 1)) });
  }
  window.__TEST__.addPlayers(debugPlayers);

  var debugState = _buildHexDebugState(debugPlayers);
  window.__TEST__.injectGameState(debugState);
  startRenderLoop();
}
