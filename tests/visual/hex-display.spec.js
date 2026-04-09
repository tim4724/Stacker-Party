// @ts-check
const { test, expect } = require('@playwright/test');
const {
  gotoDisplayTest,
  stopDisplayBackground,
  waitForFont,
  waitForGameRender,
} = require('./helpers');
const { buildHexGameState, buildHexStyleTierState, buildHexAllPiecesGhostState, buildPlayerIds, buildPlayers } = require('./hex-fixtures');

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
  await waitForGameRender(page);
}

test.describe('Hex Display', () => {
  test('hex mode - 1 player', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, {});
    if (errors.length) console.log('JS errors:', errors);
    await expect(page).toHaveScreenshot('hex-01-1player.png');
  });

  test('hex mode - 1 player empty board', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, { emptyGrid: true });
    await expect(page).toHaveScreenshot('hex-02-1player-empty.png');
  });

  test('hex mode - 2 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 2);
    await injectHexGameState(page, 2, {});
    await expect(page).toHaveScreenshot('hex-03-2players.png');
  });

  test('hex mode - 4 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 4);
    await injectHexGameState(page, 4, {});
    await expect(page).toHaveScreenshot('hex-04-4players.png');
  });

  test('hex mode - tier 2 pillow (level 8)', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, { level: 8 });
    await expect(page).toHaveScreenshot('hex-05-tier-pillow.png');
  });

  test('hex mode - tier 3 neon (level 12)', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, { level: 12 });
    await expect(page).toHaveScreenshot('hex-06-tier-neon.png');
  });

  test('hex mode - row clear preview', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 1);
    await injectHexGameState(page, 1, { nearClear: true });
    await expect(page).toHaveScreenshot('hex-07-clear-preview.png');
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
    await waitForGameRender(page);
    await expect(page).toHaveScreenshot('hex-08-style-tiers.png');
  });

  for (const [tierName, tierLevel] of [['normal', 3], ['pillow', 8], ['neon', 13]]) {
    test(`hex mode - all pieces + ghosts ${tierName}`, async ({ page }) => {
      await page.setViewportSize({ width: 2560, height: 1440 });
      await gotoDisplayTest(page);
      await injectHexPlayers(page, 8);
      const playerIds = buildPlayerIds(8);
      const result = buildHexAllPiecesGhostState(playerIds, tierLevel);
      await page.evaluate(({ s, extraGhosts }) => {
        window.__TEST__.setGameMode('hex');
        window.__TEST__.setExtraGhosts(extraGhosts);
        window.__TEST__.injectGameState(s);
      }, { s: result.state, extraGhosts: result.extraGhostsPerPlayer });
      await waitForGameRender(page);
      await expect(page).toHaveScreenshot(`hex-08b-pieces-${tierName}.png`);
    });
  }

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
    await waitForGameRender(page);
    await expect(page).toHaveScreenshot('hex-09-ko-overlay.png');
  });

  test('hex mode - disconnected overlay', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectHexPlayers(page, 2);
    await injectHexGameState(page, 2, {});
    await page.evaluate(() => {
      // Set a fake join URL so QR generates
      joinUrl = 'http://example.com/TESTROOM';
      showDisconnectQR('player2');
    });
    await waitForGameRender(page);
    await expect(page).toHaveScreenshot('hex-10-disconnected.png');
  });
});
