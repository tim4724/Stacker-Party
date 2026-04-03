// @ts-check
// Visual test fixtures for hex (flat-top) mode

const { HEX_COLS, HEX_VISIBLE_ROWS } = require('../../server/HexConstants.js');
const { HexPiece } = require('../../server/HexPiece.js');

function createHexGrid() {
  return Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
}

function buildHexGameState(playerIds, options) {
  var players = [];
  for (var i = 0; i < playerIds.length; i++) {
    var pid = playerIds[i];
    var grid = createHexGrid();

    if (options.nearClear) {
      for (var r = HEX_VISIBLE_ROWS - 4; r < HEX_VISIBLE_ROWS; r++) {
        for (var c = 0; c < HEX_COLS; c++) {
          grid[r][c] = ((c + r) % 7) + 1;
        }
      }
      var clearRow = HEX_VISIBLE_ROWS - 4;
      grid[clearRow][3] = 0;
      grid[clearRow][4] = 0;
      grid[clearRow][5] = 0;
      grid[clearRow][6] = 0;
    } else if (!options.emptyGrid) {
      for (var r2 = HEX_VISIBLE_ROWS - 3; r2 < HEX_VISIBLE_ROWS; r2++) {
        for (var c2 = 0; c2 < HEX_COLS; c2++) {
          if (Math.abs((c2 + r2 + i) % 5) !== 0) {
            grid[r2][c2] = ((c2 + r2) % 7) + 1;
          }
        }
      }
    }

    var pieceTypes = ['L', 'S', 'T', 'F', 'Fm', 'I4', 'Tp'];
    var pieceType = pieceTypes[i % pieceTypes.length];
    var piece = new HexPiece(pieceType);
    piece.anchorCol = 5;
    piece.anchorRow = 2;

    var blocks = piece.getAbsoluteBlocks();
    var ghostPiece = piece.clone();
    ghostPiece.anchorRow = options.nearClear ? HEX_VISIBLE_ROWS - 4 : options.emptyGrid ? HEX_VISIBLE_ROWS - 2 : HEX_VISIBLE_ROWS - 5;
    var ghostBlocks = ghostPiece.getAbsoluteBlocks();

    players.push({
      id: pid,
      grid: grid,
      currentPiece: {
        type: pieceType,
        typeId: piece.typeId,
        anchorCol: piece.anchorCol,
        anchorRow: piece.anchorRow,
        cells: piece.cells,
        blocks: blocks
      },
      ghost: {
        anchorCol: ghostPiece.anchorCol,
        anchorRow: ghostPiece.anchorRow,
        blocks: ghostBlocks
      },
      holdPiece: pieceTypes[(i + 3) % pieceTypes.length],
      nextPieces: [
        pieceTypes[(i + 1) % pieceTypes.length],
        pieceTypes[(i + 2) % pieceTypes.length],
        pieceTypes[(i + 4) % pieceTypes.length],
      ],
      level: options.level || (i + 1),
      lines: options.lines || (i * 12),
      alive: true,
      pendingGarbage: i === 1 ? 4 : 0,
      clearingCells: null
    });
  }
  return { players: players, elapsed: 60000 };
}

// 3 players at levels 3, 8, 13 to show all style tiers
function buildHexStyleTierState(playerIds) {
  var levels = [3, 8, 13];
  return buildHexGameState(playerIds, { level: null }).players.length
    ? { players: playerIds.map(function(pid, i) {
        var s = buildHexGameState([pid], {});
        var p = s.players[0];
        p.level = levels[i % levels.length];
        p.lines = (levels[i % levels.length] - 1) * 10;
        return p;
      }), elapsed: 60000 }
    : buildHexGameState(playerIds, {});
}

function buildPlayerIds(count) {
  var ids = [];
  for (var i = 0; i < count; i++) ids.push('player' + (i + 1));
  return ids;
}

function buildPlayers(count) {
  var list = [];
  for (var i = 0; i < count; i++) {
    list.push({ id: 'player' + (i + 1), name: 'Player ' + (i + 1) });
  }
  return list;
}

module.exports = {
  buildHexGameState,
  buildHexStyleTierState,
  buildPlayerIds,
  buildPlayers,
  createHexGrid,
};
