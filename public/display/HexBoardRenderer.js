'use strict';

// HexBoardRenderer: renders a flat-top hex grid board on canvas.
// Same interface as BoardRenderer but with flat-top hex orientation.
// Columns are vertically aligned (no zigzag on horizontal movement).

var HEX_VIS_ROWS = HexConstants.HEX_VISIBLE_ROWS;
var HEX_COLS_N = HexConstants.HEX_COLS;


class HexBoardRenderer {
  constructor(ctx, x, y, cellSize, playerIndex) {
    this.ctx = ctx;
    this.x = x;
    this.y = y;
    this.cellSize = cellSize;
    this.playerIndex = playerIndex;
    this.accentColor = PLAYER_COLORS[playerIndex] || PLAYER_COLORS[0];
    this._accentRgb = hexToRgb(this.accentColor);
    this._styleTier = STYLE_TIERS.NORMAL;

    // Flat-top: width = 2*hexSize, height = sqrt(3)*hexSize
    // colSpacing = 1.5*hexSize, rowSpacing = sqrt(3)*hexSize
    // Match the hexSize the layout (DisplayUI) computes so board fills allocated space
    var boardCols = HEX_COLS_N;
    var boardRows = Math.sqrt(3) * (HEX_VIS_ROWS + 0.5) * boardCols / (1.5 * boardCols + 0.5);
    var hexSw = boardCols * cellSize / (1.5 * boardCols + 0.5);
    var hexSh = boardRows * cellSize / (Math.sqrt(3) * (HEX_VIS_ROWS + 0.5));
    this.hexSize = Math.min(hexSw, hexSh);
    this.hexH = Math.sqrt(3) * this.hexSize;
    this.colW = 1.5 * this.hexSize;
    this.boardWidth = this.colW * (boardCols - 1) + 2 * this.hexSize;
    this.boardHeight = this.hexH * (HEX_VIS_ROWS - 1) + this.hexH + this.hexH * 0.5;
  }

  get styleTier() { return this._styleTier; }
  get hexW() { return 2 * this.hexSize; }

  // Pixel center of hex at (col, row) in visible coordinates
  _hexCenter(col, row) {
    return {
      x: this.x + this.colW * col + this.hexSize,
      y: this.y + this.hexH * (row + 0.5 * (col & 1)) + this.hexH / 2
    };
  }

  _hexPath(cx, cy, size) {
    var ctx = this.ctx;
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 3 * i;
      var hx = cx + size * Math.cos(a);
      var hy = cy + size * Math.sin(a);
      i === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy);
    }
    ctx.closePath();
  }

  _drawHex(cx, cy, size, fill, stroke, alpha) {
    var ctx = this.ctx;
    this._hexPath(cx, cy, size);
    if (fill) {
      if (alpha != null) ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fill();
      if (alpha != null) ctx.globalAlpha = 1;
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  _drawFilledHex(cx, cy, size, color) {
    var ctx = this.ctx;
    var tier = this._styleTier;

    if (tier === STYLE_TIERS.NEON_FLAT) {
      // Neon: dark fill with colored border
      var rgb = hexToRgb(color);
      if (!rgb) return;
      var darkFill = 'rgba(' + (rgb.r * 0.2 | 0) + ',' + (rgb.g * 0.2 | 0) + ',' + (rgb.b * 0.2 | 0) + ',0.92)';
      this._drawHex(cx, cy, size, darkFill, null);
      var bw = Math.max(1, size * 0.12);
      ctx.strokeStyle = color;
      ctx.lineWidth = bw;
      this._hexPath(cx, cy, size);
      ctx.stroke();
      // Top highlight line (vertices 4→5, the top-right edge)
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      var a4 = Math.PI / 3 * 4, a5 = Math.PI / 3 * 5;
      ctx.moveTo(cx + size * 0.85 * Math.cos(a4), cy + size * 0.85 * Math.sin(a4));
      ctx.lineTo(cx + size * 0.85 * Math.cos(a5), cy + size * 0.85 * Math.sin(a5));
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(0.5, size * 0.04);
      ctx.stroke();
      ctx.restore();
    } else if (tier === STYLE_TIERS.PILLOW) {
      // Pillow: flat fill + radial gradient highlight
      this._drawHex(cx, cy, size, color, null);
      var rgb2 = hexToRgb(color);
      var lum = rgb2 ? (rgb2.r * 0.299 + rgb2.g * 0.587 + rgb2.b * 0.114) / 255 : 0.5;
      var hiAlpha = 0.14 + lum * 0.46;
      ctx.save();
      ctx.beginPath();
      for (var ci = 0; ci < 6; ci++) {
        var ca = Math.PI / 3 * ci;
        var chx = cx + size * Math.cos(ca), chy = cy + size * Math.sin(ca);
        ci === 0 ? ctx.moveTo(chx, chy) : ctx.lineTo(chx, chy);
      }
      ctx.closePath();
      ctx.clip();
      var g = ctx.createRadialGradient(cx - size * 0.1, cy - size * 0.2, 0, cx, cy, size * 0.9);
      g.addColorStop(0, 'rgba(255,255,255,' + hiAlpha.toFixed(2) + ')');
      g.addColorStop(0.6, 'rgba(255,255,255,0.03)');
      g.addColorStop(1, 'rgba(0,0,0,0.2)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
      // Top edge highlight
      ctx.save();
      var edgeAlpha = 0.12 + lum * 0.38;
      ctx.strokeStyle = 'rgba(255,255,255,' + edgeAlpha.toFixed(2) + ')';
      ctx.lineWidth = Math.max(0.5, size * 0.05);
      ctx.beginPath();
      var ta4 = Math.PI / 3 * 4, ta5 = Math.PI / 3 * 5;
      ctx.moveTo(cx + size * Math.cos(ta4), cy + size * Math.sin(ta4));
      ctx.lineTo(cx + size * Math.cos(ta5), cy + size * Math.sin(ta5));
      ctx.stroke();
      // Bottom edge shadow
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      var ba1 = Math.PI / 3 * 1, ba2 = Math.PI / 3 * 2;
      ctx.moveTo(cx + size * Math.cos(ba1), cy + size * Math.sin(ba1));
      ctx.lineTo(cx + size * Math.cos(ba2), cy + size * Math.sin(ba2));
      ctx.stroke();
      ctx.restore();
    } else {
      // Normal: gradient fill with highlights and shadows
      ctx.save();
      ctx.beginPath();
      for (var ni = 0; ni < 6; ni++) {
        var na = Math.PI / 3 * ni;
        var nhx = cx + size * Math.cos(na), nhy = cy + size * Math.sin(na);
        ni === 0 ? ctx.moveTo(nhx, nhy) : ctx.lineTo(nhx, nhy);
      }
      ctx.closePath();
      ctx.clip();
      var ng = ctx.createLinearGradient(cx, cy - size, cx, cy + size);
      ng.addColorStop(0, lightenColor(color, 15));
      ng.addColorStop(1, darkenColor(color, 10));
      ctx.fillStyle = ng;
      ctx.fill();
      // Top highlight
      ctx.fillStyle = 'rgba(255,255,255,' + THEME.opacity.highlight + ')';
      ctx.fillRect(cx - size * 0.5, cy - size * 0.88, size, size * 0.12);
      // Left highlight
      ctx.fillStyle = 'rgba(255,255,255,' + THEME.opacity.muted + ')';
      ctx.fillRect(cx - size * 0.9, cy - size * 0.5, size * 0.1, size);
      // Bottom shadow
      ctx.fillStyle = 'rgba(0,0,0,' + THEME.opacity.shadow + ')';
      ctx.fillRect(cx - size * 0.5, cy + size * 0.76, size, size * 0.12);
      // Inner shine
      ctx.fillStyle = 'rgba(255,255,255,' + THEME.opacity.subtle + ')';
      var sh = size * 0.3;
      ctx.fillRect(cx - size * 0.3, cy - size * 0.4, sh, sh * 0.5);
      ctx.restore();
      // Border
      this._drawHex(cx, cy, size, null, 'rgba(255,255,255,0.15)');
    }
  }

  render(playerState, timestamp) {
    var ctx = this.ctx;
    var hs = this.hexSize;
    var newTier = getStyleTier(playerState.level || 1);
    this._styleTier = newTier;
    var isNeon = newTier === STYLE_TIERS.NEON_FLAT;
    var colors = isNeon ? NEON_PIECE_COLORS : PIECE_COLORS;
    var ghostColors = isNeon ? NEON_GHOST_COLORS : GHOST_COLORS;
    var rgb = this._accentRgb;

    var sCell = hs * (1 - THEME.size.blockGap * 2);  // proportional gap matching square mode

    // Grid cells
    if (playerState.grid) {
      for (var r = 0; r < playerState.grid.length; r++) {
        for (var c = 0; c < playerState.grid[r].length; c++) {
          var pos = this._hexCenter(c, r);
          var cellVal = playerState.grid[r][c];
          if (cellVal > 0) {
            this._drawFilledHex(pos.x, pos.y, sCell, colors[cellVal] || '#808080');
          } else {
            this._drawHex(pos.x, pos.y, sCell, THEME.color.bg.board, null);
            if (rgb) this._drawHex(pos.x, pos.y, sCell, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.tint + ')', null);
            this._drawHex(pos.x, pos.y, sCell, null, rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.muted + ')' : 'rgba(255,255,255,0.06)');
          }
        }
      }
    }

    // Ghost piece
    if (playerState.ghost && playerState.alive !== false) {
      var ghost = playerState.ghost;
      var gc = ghostColors[playerState.currentPiece.typeId] || { outline: 'rgba(255,255,255,0.12)', fill: 'rgba(255,255,255,0.06)' };
      if (ghost.blocks) {
        for (var gi = 0; gi < ghost.blocks.length; gi++) {
          var gb = ghost.blocks[gi];
          if (gb[1] >= 0 && gb[1] < HEX_VIS_ROWS) {
            var gp = this._hexCenter(gb[0], gb[1]);
            this._drawHex(gp.x, gp.y, sCell, gc.fill, gc.outline, 0.4);
          }
        }
      }
    }

    // Zigzag clear preview: uses shared findClearableZigzags from HexConstants
    if (playerState.ghost && playerState.grid && playerState.alive !== false) {
      var ghostBlocks = playerState.ghost.blocks;
      if (ghostBlocks) {
        var ghostSet = {};
        for (var gi2 = 0; gi2 < ghostBlocks.length; gi2++) {
          ghostSet[ghostBlocks[gi2][0] + ',' + ghostBlocks[gi2][1]] = true;
        }

        var gridRows = playerState.grid.length;
        var grid = playerState.grid;
        var result = HexConstants.findClearableZigzags(
          HEX_COLS_N, gridRows,
          function(col, row) { return grid[row][col] > 0 || ghostSet[col + ',' + row]; },
          function(col, row) { return grid[row][col] === 0 && ghostSet[col + ',' + row]; }
        );
        var previewCells = result.clearCells;

        // Draw preview highlights
        for (var key in previewCells) {
          var parts = key.split(',');
          var hc = parseInt(parts[0]), hr = parseInt(parts[1]);
          if (hr >= 0 && hr < HEX_VIS_ROWS) {
            var hp = this._hexCenter(hc, hr);
            this._drawHex(hp.x, hp.y, hs - 0.5, 'rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0.4)');
          }
        }
      }
    }

    // Current piece
    if (playerState.currentPiece && playerState.alive !== false) {
      var piece = playerState.currentPiece;
      var pieceColor = colors[piece.typeId] || '#ffffff';
      if (piece.blocks) {
        for (var pi = 0; pi < piece.blocks.length; pi++) {
          var pb = piece.blocks[pi];
          if (pb[1] >= 0 && pb[1] < HEX_VIS_ROWS) {
            var pp = this._hexCenter(pb[0], pb[1]);
            this._drawFilledHex(pp.x, pp.y, sCell, pieceColor);
          }
        }
      }
    }

    // Clearing cells glow (cell-based, not row-based)
    if (playerState.clearingCells && playerState.clearingCells.length > 0) {
      var t = (timestamp || performance.now()) / 150;
      var alpha = 0.3 + 0.2 * Math.sin(t * Math.PI);
      for (var ci = 0; ci < playerState.clearingCells.length; ci++) {
        var cc = playerState.clearingCells[ci];
        if (cc[1] >= 0 && cc[1] < HEX_VIS_ROWS) {
          var cp = this._hexCenter(cc[0], cc[1]);
          this._drawHex(cp.x, cp.y, sCell, '#ffffff', null, alpha);
        }
      }
    }

    this._drawWalls();
  }

  _drawWalls() {
    var ctx = this.ctx;
    var hs = this.hexSize;
    var rgb = this._accentRgb;
    ctx.strokeStyle = rgb
      ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.strong + ')'
      : 'rgba(255,255,255,' + THEME.opacity.soft + ')';
    ctx.lineWidth = this.cellSize * THEME.stroke.border;

    var self = this;
    function hv(cx, cy, i) {
      var a = Math.PI / 3 * i;
      return { x: cx + hs * Math.cos(a), y: cy + hs * Math.sin(a) };
    }

    var lastRow = HEX_VIS_ROWS - 1;
    var lastCol = HEX_COLS_N - 1;

    // Left wall: v4→v3→v2 per row of col 0 (v2 of row r = v4 of row r+1)
    ctx.beginPath();
    var fl = self._hexCenter(0, 0);
    ctx.moveTo(hv(fl.x, fl.y, 4).x, hv(fl.x, fl.y, 4).y);
    for (var row = 0; row <= lastRow; row++) {
      var p = self._hexCenter(0, row);
      ctx.lineTo(hv(p.x, p.y, 3).x, hv(p.x, p.y, 3).y);
      ctx.lineTo(hv(p.x, p.y, 2).x, hv(p.x, p.y, 2).y);
    }
    ctx.stroke();

    // Right wall: v5→v0→v1 per row of last col (v1 of row r = v5 of row r+1)
    ctx.beginPath();
    var fr = self._hexCenter(lastCol, 0);
    ctx.moveTo(hv(fr.x, fr.y, 5).x, hv(fr.x, fr.y, 5).y);
    for (var r2 = 0; r2 <= lastRow; r2++) {
      var p2 = self._hexCenter(lastCol, r2);
      ctx.lineTo(hv(p2.x, p2.y, 0).x, hv(p2.x, p2.y, 0).y);
      ctx.lineTo(hv(p2.x, p2.y, 1).x, hv(p2.x, p2.y, 1).y);
    }
    ctx.stroke();

    // Top border: zigzag across row 0 following outer hex contour
    // Even cols sit higher, odd cols shifted down by hexH/2
    // Path: v4(0)→v5(0)→[v0(0)=v4(1)]→v5(1)→[v3(2)→v4(2)]→v5(2)→...
    ctx.beginPath();
    var pt0 = self._hexCenter(0, 0);
    ctx.moveTo(hv(pt0.x, pt0.y, 4).x, hv(pt0.x, pt0.y, 4).y);
    for (var c = 0; c < HEX_COLS_N; c++) {
      var pt = self._hexCenter(c, 0);
      ctx.lineTo(hv(pt.x, pt.y, 5).x, hv(pt.x, pt.y, 5).y);
      if (c < lastCol) {
        if (c % 2 === 0) {
          // Even→odd: go down-right. v0 of even c = v4 of odd c+1
          ctx.lineTo(hv(pt.x, pt.y, 0).x, hv(pt.x, pt.y, 0).y);
        } else {
          // Odd→even: go up-right. v5 of odd = v3 of even c+1, then up to v4
          var pn = self._hexCenter(c + 1, 0);
          ctx.lineTo(hv(pn.x, pn.y, 4).x, hv(pn.x, pn.y, 4).y);
        }
      }
    }
    ctx.stroke();

    // Bottom border: zigzag across last row following outer hex contour
    // Path: v2(0)→v1(0)→[v3(1)→v2(1)]→v1(1)→[v0(1)=v2(2)]→v1(2)→...
    ctx.beginPath();
    var pb0 = self._hexCenter(0, lastRow);
    ctx.moveTo(hv(pb0.x, pb0.y, 2).x, hv(pb0.x, pb0.y, 2).y);
    for (var c2 = 0; c2 < HEX_COLS_N; c2++) {
      var pb = self._hexCenter(c2, lastRow);
      ctx.lineTo(hv(pb.x, pb.y, 1).x, hv(pb.x, pb.y, 1).y);
      if (c2 < lastCol) {
        if (c2 % 2 === 0) {
          // Even→odd: go down-right. v1 of even = v3 of odd, then down to v2
          var pbn = self._hexCenter(c2 + 1, lastRow);
          ctx.lineTo(hv(pbn.x, pbn.y, 2).x, hv(pbn.x, pbn.y, 2).y);
        } else {
          // Odd→even: go up-right. v0 of odd c = v2 of even c+1
          ctx.lineTo(hv(pb.x, pb.y, 0).x, hv(pb.x, pb.y, 0).y);
        }
      }
    }
    ctx.stroke();
  }
}
