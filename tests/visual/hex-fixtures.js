// @ts-check
// Visual test fixtures for hex (flat-top) mode

const { HEX_COLS, HEX_VISIBLE_ROWS } = require('../../server/HexConstants.js');
const { HexPiece } = require('../../server/HexPiece.js');
const { PLAYER_COLORS } = require('../../public/shared/theme.js');

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

    var pieceTypes = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
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
  return { players: playerIds.map(function(pid, i) {
    var s = buildHexGameState([pid], {});
    var p = s.players[0];
    p.level = levels[i % levels.length];
    p.lines = (levels[i % levels.length] - 1) * 10;
    return p;
  }), elapsed: 60000 };
}

// Build a state showing all 7 hex piece types with ghosts at a given style tier.
// Each player board has all 7 pieces as solid blocks at top + all 7 ghost outlines below.
function buildHexAllPiecesGhostState(playerIds, tierLevel) {
  var tierLevelMap = { 3: 'Normal', 8: 'Pillow', 13: 'Neon' };
  var tierName = tierLevelMap[tierLevel] || 'Normal';
  var pieceTypes = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

  // 6 pieces as solid blocks in rows 2-6 (T is the active piece, shown separately)
  function createShowcaseGrid() {
    var grid = createHexGrid();
    var placements = [
      { type: 'L',  col: 2, row: 2 },
      { type: 'O',  col: 6, row: 2 },
      { type: 'S',  col: 2, row: 4 },
      { type: 'Z',  col: 5, row: 4 },
      { type: 'I',  col: 5, row: 6 },
      { type: 'J',  col: 9, row: 4 },
    ];
    for (var pi = 0; pi < placements.length; pi++) {
      var pl = placements[pi];
      var piece = new HexPiece(pl.type);
      piece.anchorCol = pl.col;
      piece.anchorRow = pl.row;
      var blocks = piece.getAbsoluteBlocks();
      for (var bi = 0; bi < blocks.length; bi++) {
        var bc = blocks[bi][0], br = blocks[bi][1];
        if (br >= 0 && br < HEX_VISIBLE_ROWS && bc >= 0 && bc < HEX_COLS) {
          grid[br][bc] = piece.typeId;
        }
      }
    }
    return grid;
  }

  // Ghost positions: 6 extra ghosts + T as the active ghost
  var ghostPlacements = [
    { type: 'L',  col: 2, row: 10 },
    { type: 'O',  col: 6, row: 10 },
    { type: 'S',  col: 2, row: 13 },
    { type: 'Z',  col: 5, row: 13 },
    { type: 'I',  col: 5, row: 16 },
    { type: 'J',  col: 9, row: 13 },
  ];

  // Active piece (same on all boards): T-piece falling, ghost at row 10
  var activePiece = new HexPiece('T');
  activePiece.anchorCol = 9;
  activePiece.anchorRow = 8;
  var activeBlocks = activePiece.getAbsoluteBlocks();
  var ghostPiece = new HexPiece('T');
  ghostPiece.anchorCol = 9;
  ghostPiece.anchorRow = 10;
  var ghostBlocks = ghostPiece.getAbsoluteBlocks();

  // Extra ghosts: the other 6 piece types (same on all boards)
  var extraGhosts = [];
  for (var gi = 0; gi < ghostPlacements.length; gi++) {
    var gpl = ghostPlacements[gi];
    var gp = new HexPiece(gpl.type);
    gp.anchorCol = gpl.col;
    gp.anchorRow = gpl.row;
    var gBlocks = gp.getAbsoluteBlocks();
    // blocks are absolute coords from getAbsoluteBlocks(); x:0/ghostY:0 = no-op offset
    extraGhosts.push({
      typeId: gp.typeId,
      x: 0,
      ghostY: 0,
      blocks: gBlocks.map(function(b) { return [b[0], b[1]]; }),
    });
  }

  var extraGhostsPerPlayer = [];
  var players = playerIds.map(function(id, index) {
    extraGhostsPerPlayer.push(extraGhosts);
    return {
      id: id,
      alive: true,
      lines: (tierLevel - 1) * 10,
      level: tierLevel,
      grid: createShowcaseGrid(),
      currentPiece: {
        type: activePiece.type,
        typeId: activePiece.typeId,
        anchorCol: activePiece.anchorCol,
        anchorRow: activePiece.anchorRow,
        cells: activePiece.cells,
        blocks: activeBlocks.map(function(b) { return [b[0], b[1]]; }),
      },
      ghost: {
        anchorCol: ghostPiece.anchorCol,
        anchorRow: ghostPiece.anchorRow,
        blocks: ghostBlocks.map(function(b) { return [b[0], b[1]]; }),
      },
      holdPiece: null,
      nextPieces: [],
      pendingGarbage: 0,
      playerName: tierName + ' ' + (index + 1),
      playerColor: PLAYER_COLORS[index % PLAYER_COLORS.length],
      clearingCells: null,
    };
  });

  return {
    state: { players: players, elapsed: 65000 },
    extraGhostsPerPlayer: extraGhostsPerPlayer,
  };
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
  buildHexAllPiecesGhostState,
  buildPlayerIds,
  buildPlayers,
  createHexGrid,
};
