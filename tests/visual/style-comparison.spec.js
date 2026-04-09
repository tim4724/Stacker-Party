// @ts-check
const { test, expect } = require('@playwright/test');
const {
  gotoDisplayTest,
  injectPlayers,
  injectStyleTierGameState,
  waitForGameRender,
} = require('./helpers');
const { buildHexStyleTierState, buildPlayerIds, buildPlayers } = require('./hex-fixtures');

test.describe('Style Comparison', () => {
  test('square vs hex - all 3 style tiers', async ({ page }) => {
    // Use 2x DPR for high-res capture
    const W = 1920;
    const H = 1080;
    const DPR = 2;

    await gotoDisplayTest(page);

    // --- Square: 3 players at Normal / Pillow / Neon ---
    await injectPlayers(page, 3);
    await injectStyleTierGameState(page, 3);
    // Ensure all square players show pending garbage for visual comparison
    await page.evaluate(() => {
      for (const p of gameState.players) p.pendingGarbage = 4;
    });

    const squareData = await page.evaluate(() => {
      const c = document.getElementById('game-canvas');
      return c.toDataURL('image/png');
    });

    // --- Hex: 3 players at Normal / Pillow / Neon ---
    const hexPlayerIds = buildPlayerIds(3);
    const hexState = buildHexStyleTierState(hexPlayerIds);
    // Ensure all hex players show pending garbage for visual comparison
    for (const p of hexState.players) p.pendingGarbage = 4;
    await page.evaluate(({ s }) => {
      window.__TEST__.setGameMode('hex');
      window.__TEST__.injectGameState(s);
    }, { s: hexState });
    await waitForGameRender(page);

    // Wait until the render loop has actually drawn hex content to the canvas.
    // The render loop runs via RAF; we need several frames to ensure renderFrame()
    // has executed with the new hex renderers (not just our own RAF callbacks).
    await page.waitForTimeout(200);

    const hexData = await page.evaluate(() => {
      const c = document.getElementById('game-canvas');
      return c.toDataURL('image/png');
    });

    // --- Composite: square on top, hex on bottom at 2x resolution ---
    const compW = W * DPR;
    const compH = H * 2 * DPR;
    const labelH = 50 * DPR;
    const halfH = H * DPR;

    await page.setViewportSize({ width: compW, height: compH });
    await page.evaluate(async ({ sq, hx, cw, ch, lh, hh }) => {
      const loadImg = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
      const sqImg = await loadImg(sq);
      const hxImg = await loadImg(hx);

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
      canvas.style.display = 'block';
      const ctx = canvas.getContext('2d');

      // Dark background
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, cw, ch);

      // Labels
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 48px Orbitron, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SQUARE', cw / 2, lh - 10);
      ctx.fillText('HEX', cw / 2, hh + lh - 10);

      // Draw each half (source is 1x, stretch to 2x)
      ctx.drawImage(sqImg, 0, lh, cw, hh - lh);
      ctx.drawImage(hxImg, 0, hh + lh, cw, hh - lh);

      document.body.innerHTML = '';
      document.body.style.margin = '0';
      document.body.style.overflow = 'hidden';
      document.body.appendChild(canvas);
    }, { sq: squareData, hx: hexData, cw: compW, ch: compH, lh: labelH, hh: halfH });

    await expect(page).toHaveScreenshot('style-comparison-square-vs-hex.png');
  });
});
