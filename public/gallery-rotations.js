'use strict';

// Rotation debug: for each piece, render every step in the engine's
// deduplicated rotation cycle on a small hex grid. The visualization
// mirrors PlayerBoard._tryRotate: rotateCW() → _adjustAnchorRow(), no
// wall kicks. anchorCol is held at the grid center so any change in
// anchorRow is the on-board drift you'd actually see.

(function() {
  var Piece = PieceModule.Piece;
  var PIECE_ROTATIONS = PieceModule.PIECE_ROTATIONS;
  var offsetToAxial = PieceModule.offsetToAxial;
  var axialToOffset = PieceModule.axialToOffset;
  var PIECE_TYPES = GameConstants.PIECE_TYPES;
  var PIECE_TYPE_TO_ID = GameConstants.PIECE_TYPE_TO_ID;

  // Local mini-grid sized to fit a 4-cell piece in any rotation with a 1-cell
  // border of context around the anchor. Pieces span at most ±1 cell from the
  // anchor in axial coords, which in offset is roughly ±1 col / ±2 row.
  // Anchor sits at the grid's center so _adjustAnchorRow never has to push the
  // piece downward — what you see is the pure cell transform.
  var GRID_COLS = 5;
  var GRID_ROWS = 5;
  var ANCHOR_COL = 2;              // center column (even → "high" parity)
  var ANCHOR_ROW = 2;              // center row — leaves ±2 offset rows of slack
  // Bitmap is drawn at this base unit times DPR. CSS scales the canvas to fill
  // the card; a generous base unit keeps it crisp when the card stretches to
  // fill a wide column.
  var CELL_SIZE = 56;
  var DPR = Math.min(window.devicePixelRatio || 1, 2);

  var geo = GameConstants.computeHexGeometry(GRID_COLS, GRID_ROWS, CELL_SIZE);

  function hexCenter(col, row) {
    return {
      x: geo.colW * col + geo.hexSize,
      y: geo.hexH * (row + 0.5 * (col & 1)) + geo.hexH / 2
    };
  }

  function tracePath(ctx, cx, cy, size) {
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 3 * i;
      var x = cx + size * Math.cos(a);
      var y = cy + size * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function makeCanvas() {
    var canvas = document.createElement('canvas');
    var pad = 4;
    var logicalW = geo.boardWidth + pad * 2;
    var logicalH = geo.boardHeight + pad * 2;
    // Bitmap dimensions stay fixed at base * DPR; CSS scales the element to
    // fit the card's column width. Browsers preserve aspect ratio from the
    // width/height attributes when CSS sets width:100% height:auto.
    canvas.width = Math.ceil(logicalW * DPR);
    canvas.height = Math.ceil(logicalH * DPR);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.translate(pad, pad);
    return { canvas: canvas, ctx: ctx };
  }

  function renderPiece(piece, color) {
    var made = makeCanvas();
    var ctx = made.ctx;

    // Faint background hex grid for spatial context.
    ctx.strokeStyle = 'rgba(247, 241, 232, 0.10)';
    ctx.lineWidth = 1;
    for (var c = 0; c < GRID_COLS; c++) {
      for (var r = 0; r < GRID_ROWS; r++) {
        var pos = hexCenter(c, r);
        tracePath(ctx, pos.x, pos.y, geo.hexSize - 1.5);
        ctx.stroke();
      }
    }

    // Mark the visual center column with a column highlight so vertical drift
    // reads at a glance.
    var centerTop = hexCenter(ANCHOR_COL, 0);
    var centerBottom = hexCenter(ANCHOR_COL, GRID_ROWS - 1);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerTop.x, 0);
    ctx.lineTo(centerBottom.x, geo.boardHeight);
    ctx.stroke();

    var blocks = piece.getAbsoluteBlocks();
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 1.2;
    for (var bi = 0; bi < blocks.length; bi++) {
      var col = blocks[bi][0], row = blocks[bi][1];
      if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) continue;
      var bp = hexCenter(col, row);
      tracePath(ctx, bp.x, bp.y, geo.hexSize - 2.5);
      ctx.fill();
      ctx.stroke();
    }

    // Anchor cell dot (white filled circle on the anchor block).
    if (piece.anchorCol >= 0 && piece.anchorCol < GRID_COLS &&
        piece.anchorRow >= 0 && piece.anchorRow < GRID_ROWS) {
      var ap = hexCenter(piece.anchorCol, piece.anchorRow);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ap.x, ap.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // cells[0] marker (white ring) — this is the "rotation-keyed" cell that
    // must be a non-anchor cell per Piece.js, since cells[0] (q,r) doubles as
    // the ghost-cache rotation key.
    var ax = offsetToAxial(piece.anchorCol, piece.anchorRow);
    var c0 = piece.cells[0];
    var c0o = axialToOffset(ax.q + c0.q, ax.r + c0.r);
    if (c0o.col >= 0 && c0o.col < GRID_COLS && c0o.row >= 0 && c0o.row < GRID_ROWS) {
      var p0 = hexCenter(c0o.col, c0o.row);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, geo.hexSize * 0.28, 0, Math.PI * 2);
      ctx.stroke();
    }

    return made.canvas;
  }

  function fmtCells(cells) {
    var parts = [];
    for (var i = 0; i < cells.length; i++) {
      parts.push('(' + cells[i].q + ',' + cells[i].r + ')');
    }
    return parts.join(' ');
  }

  // Build one card for the piece's current orientation. Caller is responsible
  // for setting piece._rotIndex/cells via _setCells before calling.
  function renderCard(piece, color, label) {
    var card = document.createElement('div');
    card.className = 'rot-card';
    var head = document.createElement('div');
    head.className = 'rot-card-head';
    head.textContent = label;
    card.appendChild(head);
    card.appendChild(renderPiece(piece, color));
    var blocks = piece.getAbsoluteBlocks();
    var blocksStr = blocks.map(function(b) { return '(' + b[0] + ',' + b[1] + ')'; }).join(' ');
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'anchor (' + piece.anchorCol + ',' + piece.anchorRow + ')\n'
      + 'cells:  ' + fmtCells(piece.cells) + '\n'
      + 'blocks: ' + blocksStr;
    card.appendChild(meta);
    return card;
  }

  function buildPieceSection(type) {
    var section = document.createElement('div');
    section.className = 'rot-piece';

    var typeId = PIECE_TYPE_TO_ID[type];
    var color = PIECE_COLORS[typeId];

    var head = document.createElement('div');
    head.className = 'rot-piece-head';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = type;
    name.style.color = color;
    head.appendChild(name);
    var typeIdEl = document.createElement('span');
    typeIdEl.className = 'type-id';
    typeIdEl.textContent = 'typeId=' + typeId;
    head.appendChild(typeIdEl);
    var seed = document.createElement('span');
    seed.className = 'seed';
    seed.textContent = 'cycleLength = ' + PIECE_ROTATIONS[type].length
      + '  ·  anchor = (' + ANCHOR_COL + ',' + ANCHOR_ROW + ')';
    head.appendChild(seed);
    section.appendChild(head);

    // Anchor pinned to grid center, ±2 rows of slack so _adjustAnchorRow's
    // downward clamp never fires — what's left is the cell-level transform.
    var piece = new Piece(type);
    piece.anchorCol = ANCHOR_COL;
    piece.anchorRow = ANCHOR_ROW;

    var grid = document.createElement('div');
    grid.className = 'rot-grid';
    var cycle = PIECE_ROTATIONS[type];
    for (var ci = 0; ci < cycle.length; ci++) {
      // _setCells keeps piece.cells, piece._rotIndex, and piece._rotId in
      // sync — manually mutating piece.cells would leave _rotIndex stale,
      // which silently breaks anything that later calls piece.rotateCW().
      piece._setCells(ci);
      grid.appendChild(renderCard(piece, color, 'step ' + ci));
    }
    section.appendChild(grid);

    return section;
  }

  function init() {
    var rail = document.getElementById('rot-rail');
    for (var i = 0; i < PIECE_TYPES.length; i++) {
      rail.appendChild(buildPieceSection(PIECE_TYPES[i]));
    }
  }

  init();
})();
