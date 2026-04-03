// @ts-check
const { test, expect } = require('@playwright/test');
const {
  gotoDisplayTest,
  stopDisplayBackground,
  waitForFont,
} = require('./helpers');
const { buildHexGameState, buildHexStyleTierState, buildPlayerIds, buildPlayers } = require('./hex-fixtures');

async function injectHexPlayers(page, count) {
  const playerList = buildPlayers(count);
  await page.evaluate((players) => {
    window.__TEST__.addPlayers(players);
  }, playerList);
}

async function injectHexGameState(page, playerCount, options) {
  const playerIds = buildPlayerIds(playerCount);
  const state = buildHexGameState(playerIds, options || {});
  await page.evaluate(({ s }) => {
    window.__TEST__.setGameMode('hex');
    window.__TEST__.injectGameState(s);
  }, { s: state });
}

test.describe('Hex Display', () => {
  test('hex mode - 1 player', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, {});
    await page.waitForTimeout(300);
    if (errors.length) console.log('JS errors:', errors);
    await expect(page).toHaveScreenshot('hex-01-1player.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - 1 player empty board', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, { emptyGrid: true });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('hex-02-1player-empty.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - 2 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 2);
    await injectHexGameState(page, 2, {});
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('hex-03-2players.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - 4 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 4);
    await injectHexGameState(page, 4, {});
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('hex-04-4players.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - tier 2 pillow (level 8)', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, { level: 8 });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('hex-05-tier-pillow.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - tier 3 neon (level 12)', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, { level: 12 });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('hex-06-tier-neon.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - row clear preview', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, { nearClear: true });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('hex-07-clear-preview.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - all style tiers (3 players)', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 3);
    const playerIds = buildPlayerIds(3);
    const state = buildHexStyleTierState(playerIds);
    await page.evaluate(({ s }) => {
      window.__TEST__.setGameMode('hex');
      window.__TEST__.injectGameState(s);
    }, { s: state });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('hex-08-style-tiers.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - KO overlay', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 2);
    // Build state with player2 dead
    const playerIds = buildPlayerIds(2);
    const state = buildHexGameState(playerIds, {});
    state.players[1].alive = false;
    await page.evaluate(({ s }) => {
      window.__TEST__.setGameMode('hex');
      window.__TEST__.injectGameState(s);
      window.__TEST__.injectKO('player2');
    }, { s: state });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('hex-09-ko-overlay.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('hex mode - disconnected overlay', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 2);
    await injectHexGameState(page, 2, {});
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      // Set a fake join URL so QR generates
      joinUrl = 'http://example.com/TESTROOM';
      showDisconnectQR('player2');
    });
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot('hex-10-disconnected.png', {
      maxDiffPixelRatio: 0.01,
    });
  });
});
