'use strict';

// BaseUIRenderer: shared rendering for hold/next panels, level/lines,
// player name, and panel backgrounds. Mode-specific subclasses override
// drawMiniPiece() and the garbage/KO/overlay methods.

class BaseUIRenderer {
  constructor(ctx, boardX, boardY, cellSize, boardWidthPx, boardHeightPx, playerIndex) {
    this.ctx = ctx;
    this.boardX = boardX;
    this.boardY = boardY;
    this.cellSize = cellSize;
    this.boardWidth = boardWidthPx;
    this.boardHeight = boardHeightPx;
    this.playerIndex = playerIndex;
    this.accentColor = PLAYER_COLORS[playerIndex] || PLAYER_COLORS[0];
    this._accentRgb = hexToRgb(this.accentColor);
    this.panelWidth = cellSize * THEME.size.panelWidth;
    this.miniSize = cellSize * THEME.font.cellScale.mini;
    this.panelGap = cellSize * THEME.size.panelGap;
    this._styleTier = STYLE_TIERS.NORMAL;

    // Cached rgba strings for panel drawing
    var rgb = this._accentRgb;
    this._panelTintFill = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.tint + ')' : null;
    this._panelStroke = rgb ? 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + THEME.opacity.soft + ')' : 'rgba(255, 255, 255, ' + THEME.opacity.tint + ')';

    // Cached font strings
    this._updateCachedFonts();
  }

  _updateCachedFonts() {
    var font = getDisplayFont();
    var labelSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label);
    var valueSize = Math.max(THEME.font.minPx.label, this.cellSize * THEME.font.cellScale.label * 1.3);
    this._labelSize = labelSize;
    this._valueSize = valueSize;
    this._rowHeight = labelSize + valueSize + this.cellSize * 0.4;
    this._fontName = '700 ' + Math.max(THEME.font.minPx.name, this.cellSize * THEME.font.cellScale.name) + 'px ' + font;
    this._fontLabel = '700 ' + labelSize + 'px ' + font;
    this._fontValue = '700 ' + valueSize + 'px ' + font;
    this._fontKO = '900 ' + Math.max(20, this.cellSize * 2) + 'px ' + font;
    this._fontDisconnect = '600 ' + Math.max(10, this.cellSize * THEME.font.cellScale.name) + 'px ' + font;
    this._cachedFontFamily = font;
  }

  render(playerState, timestamp) {
    this._styleTier = getStyleTier(playerState.level || 1);
    if (getDisplayFont() !== this._cachedFontFamily) this._updateCachedFonts();
    var nextLayout = this._nextPanelLayout(playerState);
    this.drawPlayerName(playerState);
    this.drawHoldPanel(playerState);
    this.drawNextPanel(playerState, nextLayout);
    this.drawLevelLines(playerState, nextLayout);
    if (playerState.pendingGarbage > 0) {
      this.drawGarbageMeter(playerState.pendingGarbage);
    }
    if (playerState.garbageIndicatorEffects && playerState.garbageIndicatorEffects.length > 0) {
      this.drawGarbageIndicatorEffects(playerState.garbageIndicatorEffects, timestamp);
    }
    if (playerState.garbageDefenceEffects && playerState.garbageDefenceEffects.length > 0) {
      this.drawGarbageDefenceEffects(playerState.garbageDefenceEffects, timestamp);
    }
    if (playerState.alive === false) {
      this.drawKOOverlay();
    }
  }

  drawPlayerName(playerState) {
    var ctx = this.ctx;
    var name = playerState.playerName || PLAYER_NAMES[this.playerIndex] || ('Player ' + (this.playerIndex + 1));
    var nameY = this.boardY - this.cellSize * 0.13;
    ctx.fillStyle = playerState.playerColor || THEME.color.text.white;
    ctx.font = this._fontName;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(name, this.boardX + this.cellSize * 0.07, nameY - this.cellSize * 0.07);
  }

  drawHoldPanel(playerState) {
    var ctx = this.ctx;
    var panelY = this.boardY;
    var boxSize = this.miniSize * THEME.size.panelWidth;
    var panelX = this.boardX - this.panelGap - boxSize;

    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.font = this._fontLabel;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText(t('hold'), panelX + boxSize / 2, panelY, boxSize);
    ctx.letterSpacing = '0px';

    var boxY = panelY + this._labelSize + this.cellSize * 0.2;
    this._drawPanel(panelX, boxY, boxSize, boxSize);

    if (playerState.holdPiece) {
      this.drawMiniPiece(panelX + boxSize / 2, boxY + boxSize / 2, playerState.holdPiece, this.miniSize);
    }
  }

  _nextPanelLayout(playerState) {
    var nextCount = playerState.nextPieces ? Math.min(playerState.nextPieces.length, 3) : 0;
    if (this._cachedNextLayout && this._cachedNextCount === nextCount) return this._cachedNextLayout;
    var pieceSpacing = this.miniSize * 3;
    var startY = this.boardY + this._labelSize + this.cellSize * 0.2;
    var boxHeight = pieceSpacing * Math.max(nextCount, 3);
    this._cachedNextCount = nextCount;
    this._cachedNextLayout = { startY: startY, boxHeight: boxHeight, pieceSpacing: pieceSpacing };
    return this._cachedNextLayout;
  }

  drawNextPanel(playerState, layout) {
    var ctx = this.ctx;
    var panelX = this.boardX + this.boardWidth + this.panelGap;
    var panelY = this.boardY;
    var boxWidth = this.miniSize * THEME.size.panelWidth;

    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.font = this._fontLabel;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '0.15em';
    ctx.fillText(t('next'), panelX + boxWidth / 2, panelY, boxWidth);
    ctx.letterSpacing = '0px';

    this._drawPanel(panelX, layout.startY, boxWidth, layout.boxHeight);

    if (playerState.nextPieces) {
      for (var i = 0; i < Math.min(playerState.nextPieces.length, 3); i++) {
        var py = layout.startY + i * layout.pieceSpacing + layout.pieceSpacing / 2;
        var alpha = i === 0 ? 1.0 : 0.7 - i * 0.06;
        ctx.globalAlpha = alpha;
        this.drawMiniPiece(panelX + boxWidth / 2, py, playerState.nextPieces[i], this.miniSize);
        ctx.globalAlpha = 1.0;
      }
    }
  }

  drawLevelLines(playerState, layout) {
    var ctx = this.ctx;
    var panelX = this.boardX + this.boardWidth + this.panelGap;
    var belowNextY = layout.startY + layout.boxHeight + this.cellSize * 0.5;

    var lines = playerState.lines || 0;
    var level = playerState.level || 1;
    var lvlSize = this._labelSize;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // Level row
    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.letterSpacing = '0.15em';
    ctx.font = this._fontLabel;
    ctx.fillText(t('level'), panelX, belowNextY);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = THEME.color.text.white;
    ctx.font = this._fontValue;
    ctx.fillText('' + level, panelX, belowNextY + lvlSize + this.cellSize * 0.1);

    // Lines row
    var linesY = belowNextY + this._rowHeight;
    ctx.fillStyle = 'rgba(255, 255, 255, ' + THEME.opacity.label + ')';
    ctx.letterSpacing = '0.15em';
    ctx.font = this._fontLabel;
    ctx.fillText(t('lines'), panelX, linesY);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = THEME.color.text.white;
    ctx.font = this._fontValue;
    ctx.fillText('' + lines, panelX, linesY + lvlSize + this.cellSize * 0.1);
  }

  drawKOOverlay() {
    var ctx = this.ctx;
    ctx.save();
    this._clipBoardArea();
    this._fillBoardArea('rgba(30, 0, 0, 0.6)');
    ctx.fillStyle = '#cc2222';
    ctx.font = this._fontKO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('ko'), this.boardX + this.boardWidth / 2, this.boardY + this.boardHeight / 2);
    ctx.restore();
  }

  _clipBoardArea() {
    // Default: no clipping needed for rectangular boards
  }

  _fillBoardArea(color) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(this.boardX, this.boardY, this.boardWidth, this.boardHeight);
  }

  drawDisconnectedOverlay(qrImg, playerColor) {
    var ctx = this.ctx;
    var bx = this.boardX, by = this.boardY, bw = this.boardWidth, bh = this.boardHeight;

    this._fillBoardArea('rgba(0, 0, 0, ' + THEME.opacity.overlay + ')');

    ctx.fillStyle = playerColor || 'rgba(0, 200, 255, 0.7)';
    ctx.font = this._fontDisconnect;
    ctx.textAlign = 'center';
    ctx.letterSpacing = '0.1em';

    if (!qrImg) {
      ctx.textBaseline = 'middle';
      ctx.fillText(t('disconnected'), bx + bw / 2, by + bh / 2, bw * 0.9);
      ctx.letterSpacing = '0px';
      return;
    }

    var labelSize = Math.max(10, this.cellSize * THEME.font.cellScale.name);
    var labelGap = labelSize * 1.2;
    var qrSize = Math.min(bw, bh) * 0.5;
    var qrRadius = qrSize * 0.08;
    var pad = qrSize * 0.06;
    var outerSize = qrSize + pad * 2;
    var totalH = outerSize + labelGap + labelSize;
    var groupY = by + (bh - totalH) / 2;
    var outerX = bx + (bw - outerSize) / 2;

    ctx.fillStyle = THEME.color.text.white;
    ctx.beginPath();
    ctx.roundRect(outerX, groupY, outerSize, outerSize, qrRadius);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0, 200, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(outerX + pad, groupY + pad, qrSize, qrSize, Math.max(1, qrRadius - pad));
    ctx.clip();
    ctx.drawImage(qrImg, outerX + pad, groupY + pad, qrSize, qrSize);
    ctx.restore();

    ctx.fillStyle = playerColor || 'rgba(0, 200, 255, 0.7)';
    ctx.font = this._fontDisconnect;
    ctx.textBaseline = 'top';
    ctx.fillText(t('scan_to_rejoin'), bx + bw / 2, groupY + outerSize + labelGap, bw * 0.9);
    ctx.letterSpacing = '0px';
  }

  _drawPanel(x, y, w, h) {
    var ctx = this.ctx;
    var r = THEME.radius.panel(this.cellSize);

    ctx.beginPath();
    _addRoundRectSubPath(ctx, x, y, w, h, r);

    ctx.fillStyle = THEME.color.bg.board;
    ctx.fill();

    if (this._panelTintFill) {
      ctx.fillStyle = this._panelTintFill;
      ctx.fill();
    }

    ctx.strokeStyle = this._panelStroke;
    ctx.lineWidth = this.cellSize * THEME.stroke.border;
    ctx.stroke();
  }
}

window.BaseUIRenderer = BaseUIRenderer;
