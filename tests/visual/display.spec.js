// @ts-check
const { test, expect } = require('@playwright/test');
const {
  gotoDisplayTest,
  injectGameState,
  injectGarbageSent,
  injectKO,
  injectPause,
  injectPlayers,
  injectResults,
  injectAllPiecesGhostState,
  injectStyleTierGameState,
  stabilizeDisplayLobby,
  stopDisplayBackground,
  waitForFont,
} = require('./helpers');

test.describe('Display', () => {
  test('end screen on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?test=1');
    await waitForFont(page);
    await expect(page).toHaveScreenshot('01-end-screen-mobile.png');
  });

  test('welcome screen', async ({ page }) => {
    await page.goto('/?test=1');
    await waitForFont(page);
    await page.locator('#version-label').evaluate(el => el.textContent = 'X.Y.Z');
    await expect(page).toHaveScreenshot('02-welcome.png');
  });

  test('lobby screen - empty', async ({ page }) => {
    await gotoDisplayTest(page);
    await page.evaluate(() => {
      document.getElementById('lobby-screen').classList.remove('hidden');
      document.getElementById('welcome-screen').classList.add('hidden');
      updatePlayerList();
      updateStartButton();
    });
    await stabilizeDisplayLobby(page);

    await expect(page).toHaveScreenshot('03-lobby-empty.png');
  });

  test('lobby screen - with players', async ({ page }) => {
    await gotoDisplayTest(page);
    await page.evaluate(() => {
      document.getElementById('lobby-screen').classList.remove('hidden');
      document.getElementById('welcome-screen').classList.add('hidden');
    });
    await injectPlayers(page, 2);
    await stabilizeDisplayLobby(page);

    await expect(page).toHaveScreenshot('04-lobby-players.png');
  });

  test('lobby screen - full (8 players)', async ({ page }) => {
    await gotoDisplayTest(page);
    await page.evaluate(() => {
      document.getElementById('lobby-screen').classList.remove('hidden');
      document.getElementById('welcome-screen').classList.add('hidden');
    });
    await injectPlayers(page, 8);
    await stabilizeDisplayLobby(page);

    await expect(page).toHaveScreenshot('04a-lobby-full.png');
  });

  test('lobby screen - wide (8 slots)', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await gotoDisplayTest(page);
    await page.evaluate(() => {
      document.getElementById('lobby-screen').classList.remove('hidden');
      document.getElementById('welcome-screen').classList.add('hidden');
    });
    await injectPlayers(page, 3);
    await stabilizeDisplayLobby(page);

    await expect(page).toHaveScreenshot('04b-lobby-wide.png');
  });

  test('game screen - 1 player', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 1);
    await injectGameState(page, 1, {
      pieces: [
        { typeId: 1, x: 6, y: 2, blocks: [[0, 1], [1, 1], [2, 1], [3, 1]] }
      ]
    });
    await expect(page).toHaveScreenshot('05-game-1p.png');
  });

  test('game screen - 2 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 2);
    await injectGameState(page, 2, {
      pieces: [
        { typeId: 6, x: 7, y: 2, blocks: [[1, 0], [0, 1], [1, 1], [2, 1]] },
        { typeId: 2, x: 7, y: 3, blocks: [[0, 0], [0, 1], [1, 1], [2, 1]] }
      ]
    });
    await expect(page).toHaveScreenshot('06-game-2p.png');
  });

  test('game screen - 4 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 4);
    await injectGameState(page, 4, {
      pieces: [
        { typeId: 6, x: 7, y: 2, blocks: [[1, 0], [0, 1], [1, 1], [2, 1]] },
        { typeId: 7, x: 7, y: 3, blocks: [[0, 0], [1, 0], [1, 1], [2, 1]] },
        { typeId: 3, x: 3, y: 2, blocks: [[2, 0], [0, 1], [1, 1], [2, 1]] },
        { typeId: 6, x: 3, y: 3, blocks: [[1, 0], [0, 1], [1, 1], [2, 1]] }
      ]
    });
    await expect(page).toHaveScreenshot('07-game-4p.png');
  });

  test('game screen - 8 players', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await gotoDisplayTest(page);
    await injectPlayers(page, 8);
    await injectGameState(page, 8, {});
    await expect(page).toHaveScreenshot('07b-game-8p.png');
  });

  test('game screen - with KO', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 2);
    await injectGameState(page, 2, { deadPlayerIds: ['player2'] });
    await page.evaluate(() => {
      window.__TEST__.injectKO('player2');
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page).toHaveScreenshot('08-game-ko.png');
  });

  test('pause overlay', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 1);
    await injectGameState(page, 1, {});
    await injectPause(page);
    await page.waitForSelector('#pause-overlay:not(.hidden)');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page).toHaveScreenshot('09-pause.png');
  });

  test('reconnect overlay', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 2);
    await injectGameState(page, 2, {});
    await page.evaluate(() => {
      document.getElementById('reconnect-overlay').classList.remove('hidden');
      document.getElementById('reconnect-heading').textContent = 'RECONNECTING';
      document.getElementById('reconnect-status').textContent = 'Attempt 1 of 5';
      document.getElementById('reconnect-btn').classList.add('hidden');
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page).toHaveScreenshot('09a-reconnect.png');
  });

  test('disconnected overlay - reconnect button', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 2);
    await injectGameState(page, 2, {});
    await page.evaluate(() => {
      document.getElementById('reconnect-overlay').classList.remove('hidden');
      document.getElementById('reconnect-heading').textContent = 'DISCONNECTED';
      document.getElementById('reconnect-status').textContent = '';
      document.getElementById('reconnect-btn').classList.remove('hidden');
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page).toHaveScreenshot('09b-disconnected.png');
  });

  test('game screen - all style tiers (3 players)', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 3);
    await injectStyleTierGameState(page, 3);
    await expect(page).toHaveScreenshot('07c-game-style-tiers.png');
  });

  for (const [tierName, tierLevel] of [['normal', 3], ['pillow', 8], ['neon', 13]]) {
    test(`game screen - all pieces + ghosts ${tierName}`, async ({ page }) => {
      await page.setViewportSize({ width: 2560, height: 1440 });
      await gotoDisplayTest(page);
      await injectPlayers(page, 8);
      await injectAllPiecesGhostState(page, 8, tierLevel);
      await expect(page).toHaveScreenshot(`07d-pieces-${tierName}.png`);
    });
  }

  test('results screen - 1 player', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 1);
    await injectResults(page, 1);
    await page.waitForSelector('#results-screen:not(.hidden)');
    await page.waitForTimeout(1100);
    await expect(page).toHaveScreenshot('10a-results-1p.png');
  });

  test('results screen - 2 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 2);
    await injectResults(page, 2);
    await page.waitForSelector('#results-screen:not(.hidden)');
    await page.waitForTimeout(1100);
    await expect(page).toHaveScreenshot('10b-results-2p.png');
  });

  test('results screen - 4 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 4);
    await injectResults(page, 4);
    await page.waitForSelector('#results-screen:not(.hidden)');
    await page.waitForTimeout(1100);
    await expect(page).toHaveScreenshot('10c-results-4p.png');
  });

  test('results screen - 8 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 8);
    await injectResults(page, 8);
    await page.waitForSelector('#results-screen:not(.hidden)');
    await page.waitForTimeout(1100);
    await expect(page).toHaveScreenshot('10d-results-8p.png');
  });
});
