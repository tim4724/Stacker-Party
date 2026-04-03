'use strict';

// =====================================================================
// Display Entry Point — init, event listeners, test API
// Depends on: DisplayState.js, DisplayUI.js, DisplayConnection.js,
//             DisplayGame.js, DisplayInput.js, DisplayRender.js
// Loaded last; wires up event listeners and initializes
// =====================================================================

// =====================================================================
// Welcome / UI Buttons
// =====================================================================

function resetToWelcome() {
  releaseWakeLock();
  if (party) {
    party.close();
    party = null;
  }
  stopLivenessCheck();
  lastRoomCode = null;
  roomCode = null;
  joinUrl = null;
  paused = false;
  setRoomState(ROOM_STATE.LOBBY);
  players.clear();
  playerOrder = [];
  gameState = null;
  boardRenderers = [];
  uiRenderers = [];
  disconnectedQRs.clear();
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  lastAliveState = {};
  lastResults = null;
  preCreatedRoom = null;
  showScreen(SCREEN.WELCOME);
  connectAndCreateRoom();
}

// =====================================================================
// Cursor Auto-Hide
// =====================================================================

var cursorTimer = null;
function showCursor() {
  document.body.classList.remove('cursor-hidden');
  gameToolbar.classList.remove('toolbar-autohide');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(function() {
    document.body.classList.add('cursor-hidden');
    if (currentScreen === SCREEN.GAME) {
      gameToolbar.classList.add('toolbar-autohide');
    }
  }, 3000);
}
document.addEventListener('mousemove', showCursor);
showCursor();

// =====================================================================
// Test Mode API (window.__TEST__)
// =====================================================================

var urlParams = new URLSearchParams(window.location.search);
var debugCount = parseInt(urlParams.get('debug'), 10);
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

    setGameMode: function(mode) {
      gameMode = mode;
      updateModeUI(mode);
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
// Initialize
// =====================================================================

// --- Window Resize ---
window.addEventListener('resize', function() {
  resizeCanvas();
  if (welcomeBg) welcomeBg.resize(window.innerWidth, window.innerHeight);
  if (currentScreen === SCREEN.LOBBY) updatePlayerList();
});

// --- Re-acquire Wake Lock on tab focus (browser releases it on visibility change) ---
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && !wakeLock &&
      (roomState === ROOM_STATE.PLAYING || roomState === ROOM_STATE.COUNTDOWN)) {
    acquireWakeLock();
  }
});

// --- Mobile Hint ---
var mobileHintBtn = document.getElementById('mobile-hint-btn');
if (mobileHintBtn) {
  mobileHintBtn.addEventListener('click', function() {
    var hint = document.getElementById('mobile-hint');
    if (hint) hint.remove();
  });
}

// --- Button Event Listeners ---
newGameBtn.addEventListener('click', function() {
  initMusic();
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  }

  if (preCreatedRoom) {
    var pre = preCreatedRoom;
    preCreatedRoom = null;
    applyRoomCreated(pre.roomCode, pre.joinUrl);
    if (pre.qrMatrix) {
      requestAnimationFrame(function() { renderQR(qrCode, pre.qrMatrix); });
    }
  } else {
    // Relay hasn't responded yet — show lobby so onRoomCreated
    // applies the room immediately instead of pre-caching it.
    showScreen(SCREEN.LOBBY);
    connectAndCreateRoom();
  }

  history.pushState({ screen: SCREEN.LOBBY }, '');
});

window.addEventListener('popstate', function(e) {
  if (suppressPopstate) {
    suppressPopstate = false;
    return;
  }
  var target = e.state && e.state.screen;
  if (currentScreen === SCREEN.WELCOME && target === SCREEN.LOBBY) {
    suppressPopstate = true;
    history.back();
  } else if (currentScreen === SCREEN.LOBBY) {
    if (target === SCREEN.GAME) {
      suppressPopstate = true;
      history.back();
    } else {
      resetToWelcome();
    }
  } else if (currentScreen === SCREEN.GAME || currentScreen === SCREEN.RESULTS) {
    popstateNavigating = true;
    if (music) music.stop();
    showScreen(SCREEN.LOBBY);
    returnToLobby();
  }
});

startBtn.addEventListener('click', function() {
  if (startBtn.disabled) return;
  initMusic();
  startGame();
});

// --- Game mode selector ---
var modeCards = document.querySelectorAll('#mode-selector .mode-option');

function updateModeUI(mode) {
  for (var i = 0; i < modeCards.length; i++) {
    modeCards[i].classList.toggle('selected', modeCards[i].getAttribute('data-mode') === mode);
  }
}

// Restore from localStorage
var savedMode = localStorage.getItem('stacker_game_mode');
if (savedMode === 'hex' || savedMode === 'classic') {
  gameMode = savedMode;
  updateModeUI(gameMode);
  if (welcomeBg) welcomeBg.setMode(gameMode);
}

function setGameMode(mode) {
  if (mode !== 'classic' && mode !== 'hex') return;
  gameMode = mode;
  updateModeUI(mode);
  if (welcomeBg) welcomeBg.setMode(mode);
  localStorage.setItem('stacker_game_mode', mode);
  if (party && roomState === ROOM_STATE.LOBBY) broadcastLobbyUpdate();
}

for (var mi = 0; mi < modeCards.length; mi++) {
  modeCards[mi].addEventListener('click', function() {
    setGameMode(this.getAttribute('data-mode'));
  });
}

playAgainBtn.addEventListener('click', function() {
  initMusic();
  playAgain();
});

newGameResultsBtn.addEventListener('click', function() {
  returnToLobby();
});

// --- Mute ---
if (muted) muteBtn.querySelector('.sound-waves').style.display = 'none';
muteBtn.addEventListener('click', function() {
  muted = !muted;
  localStorage.setItem('stacker_muted', muted ? '1' : '0');
  muteBtn.querySelector('.sound-waves').style.display = muted ? 'none' : '';
  if (music) {
    music.muted = muted;
    if (music.masterGain) {
      music.masterGain.gain.cancelScheduledValues(music.ctx.currentTime);
      music.masterGain.gain.setValueAtTime(music.masterGain.gain.value, music.ctx.currentTime);
      music.masterGain.gain.linearRampToValueAtTime(muted ? 0 : Music.MASTER_VOLUME, music.ctx.currentTime + 0.05);
    }
  }
});

// --- Fullscreen ---
fullscreenBtn.addEventListener('click', function() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  } else {
    document.exitFullscreen().catch(function() {});
  }
});

// --- Pause (display-side buttons) ---
pauseBtn.addEventListener('click', function() {
  pauseGame();
});

pauseContinueBtn.addEventListener('click', function() {
  resumeGame();
});

pauseNewGameBtn.addEventListener('click', function() {
  returnToLobby();
});

reconnectBtn.addEventListener('click', function() {
  clearTimeout(disconnectedTimer);
  party.resetReconnectCount();
  reconnectBtn.classList.add('hidden');
  reconnectHeading.textContent = 'RECONNECTING';
  reconnectStatus.textContent = 'Connecting...';
  party.reconnectNow();
});

// --- Version + Background ---
fetch('/api/version').then(function(r) { return r.json(); }).then(function(data) {
  var label = data.version;
  if (!data.isProduction && data.commit) {
    label += ' (#' + data.commit + ')';
  }
  document.getElementById('version-label').textContent = label;
}).catch(function() {});

var bgCanvas = document.getElementById('bg-canvas');
if (bgCanvas) {
  welcomeBg = new WelcomeBackground(bgCanvas);
  if (gameMode !== 'classic') welcomeBg.setMode(gameMode);
  welcomeBg.resize(window.innerWidth, window.innerHeight);
  welcomeBg.start();
}

// --- Debug state builders ---
function _buildClassicDebugState(debugPlayers) {
  var VH = GameConstants.VISIBLE_HEIGHT;
  var debugGrids = [
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-6]=[0,0,0,0,0,1,0,0,0,0]; g[VH-5]=[0,7,7,0,0,1,0,0,0,0];
      g[VH-4]=[2,0,7,7,0,1,0,0,0,3]; g[VH-3]=[2,2,2,0,0,1,0,3,3,3];
      g[VH-2]=[8,8,8,8,0,8,8,8,8,8]; g[VH-1]=[8,8,8,8,8,0,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-4]=[0,5,5,0,4,4,6,6,6,0]; g[VH-3]=[5,5,0,0,4,4,0,6,0,0];
      g[VH-2]=[8,8,8,0,8,8,8,8,8,8]; g[VH-1]=[8,8,0,8,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-5]=[0,0,0,0,0,0,0,0,7,0]; g[VH-4]=[0,0,0,0,0,0,0,7,7,0];
      g[VH-3]=[1,1,1,1,0,0,0,7,0,0]; g[VH-2]=[8,8,8,8,8,0,8,8,8,8]; g[VH-1]=[8,8,8,0,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-5]=[0,5,0,0,0,0,3,3,0,0]; g[VH-4]=[0,5,5,0,0,0,0,3,0,0]; g[VH-3]=[0,0,5,0,0,0,0,3,0,0];
      g[VH-2]=[8,8,8,0,8,8,8,8,8,8]; g[VH-1]=[8,0,8,8,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-4]=[0,0,0,0,0,6,6,6,2,0]; g[VH-3]=[5,5,3,3,0,0,6,0,2,2];
      g[VH-2]=[8,8,8,8,0,8,8,8,8,8]; g[VH-1]=[8,8,0,8,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-4]=[4,4,0,0,0,0,0,5,5,0]; g[VH-3]=[4,4,0,0,0,0,5,5,0,0];
      g[VH-2]=[8,8,8,8,8,0,8,8,8,8]; g[VH-1]=[8,0,8,8,8,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-4]=[0,0,0,0,0,0,0,3,0,0]; g[VH-3]=[1,1,1,1,0,3,3,3,0,0];
      g[VH-2]=[8,8,8,0,8,8,8,8,8,8]; g[VH-1]=[8,8,8,8,0,8,8,8,8,8]; return g; },
    function() { var g = []; for (var r = 0; r < VH; r++) g.push([0,0,0,0,0,0,0,0,0,0]);
      g[VH-3]=[0,0,7,7,0,0,0,0,0,0]; g[VH-2]=[8,8,0,7,7,8,8,8,0,8]; g[VH-1]=[8,8,8,8,0,8,8,8,8,8]; return g; }
  ];
  var debugPieces = [
    { typeId: 6, x: 7, y: 2, blocks: [[1,0],[0,1],[1,1],[2,1]] },
    { typeId: 2, x: 6, y: 3, blocks: [[0,0],[0,1],[1,1],[2,1]] },
    { typeId: 3, x: 3, y: 2, blocks: [[2,0],[0,1],[1,1],[2,1]] },
    { typeId: 6, x: 3, y: 3, blocks: [[1,0],[0,1],[1,1],[2,1]] },
    { typeId: 1, x: 0, y: 5, blocks: [[0,1],[1,1],[2,1],[3,1]] },
    { typeId: 5, x: 4, y: 3, blocks: [[1,0],[2,0],[0,1],[1,1]] },
    { typeId: 7, x: 1, y: 2, blocks: [[0,0],[1,0],[1,1],[2,1]] },
    { typeId: 4, x: 7, y: 3, blocks: [[0,0],[1,0],[0,1],[1,1]] }
  ];
  var debugGhostY = [14, 14, 15, 16, 15, 16, 15, 16];
  var debugHold = ['O', 'S', 'T', 'I', 'J', 'Z', 'L', 'S'];
  var debugNext = [
    ['I','T','Z','L','O'], ['T','J','O','S','Z'], ['Z','I','J','S','L'], ['L','O','T','I','S'],
    ['S','Z','T','J','I'], ['J','L','I','O','T'], ['O','S','L','Z','J'], ['T','I','Z','L','O']
  ];
  var debugLines = [24, 16, 10, 5, 20, 12, 8, 3];
  var debugLevels = [3, 2, 2, 1, 3, 2, 1, 1];
  var state = { players: [], elapsed: 75000 };
  for (var dj = 0; dj < debugPlayers.length; dj++) {
    state.players.push({
      id: debugPlayers[dj].id, playerName: debugPlayers[dj].name,
      grid: debugGrids[dj % debugGrids.length](),
      lines: debugLines[dj % debugLines.length], level: debugLevels[dj % debugLevels.length],
      alive: true, currentPiece: debugPieces[dj % debugPieces.length],
      ghostY: debugGhostY[dj % debugGhostY.length],
      nextPieces: debugNext[dj % debugNext.length], holdPiece: debugHold[dj % debugHold.length],
      pendingGarbage: dj % 3 === 0 ? 3 : 0
    });
  }
  return state;
}

function _buildHexDebugState(debugPlayers) {
  var HC = HexConstants.HEX_COLS;
  var HV = HexConstants.HEX_VISIBLE_ROWS;
  var GC = HexConstants.HEX_GARBAGE_CELL;
  var types = HexConstants.HEX_PIECE_TYPES;
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
    var piece = new HexPieceModule.HexPiece(pt);
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

// --- Debug mode: ?debug=N auto-injects N players with game boards ---
if (debugCount > 0 && window.__TEST__) {
  var debugNames = ['Emma', 'Jake', 'Sofia', 'Liam', 'Mia', 'Noah', 'Ava', 'Leo'];
  var debugPlayers = [];
  for (var di = 0; di < Math.min(debugCount, 8); di++) {
    debugPlayers.push({ id: 'debug' + di, name: debugNames[di] || ('P' + (di + 1)) });
  }
  window.__TEST__.addPlayers(debugPlayers);

  // Build game state — branch on game mode
  var debugState;
  if (gameMode === 'hex') {
    debugState = _buildHexDebugState(debugPlayers);
  } else {
    debugState = _buildClassicDebugState(debugPlayers);
  }
  window.__TEST__.injectGameState(debugState);
  startRenderLoop();
} else {
  fetchBaseUrl();
  connectAndCreateRoom();
}
