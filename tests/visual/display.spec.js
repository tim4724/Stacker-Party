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
  stopDisplayBackground,
  waitForFont,
} = require('./helpers');

test.describe('Display', () => {
  test('mobile hint screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await waitForFont(page);
    await stopDisplayBackground(page);
    await expect(page).toHaveScreenshot('01-mobile-hint.png');
  });

  test('welcome screen', async ({ page }) => {
    await page.goto('/');
    await waitForFont(page);
    await stopDisplayBackground(page);
    await expect(page).toHaveScreenshot('02-welcome.png');
  });

  test('lobby screen - empty', async ({ page }) => {
    await gotoDisplayTest(page);
    // Simulate room created by showing lobby
    await page.evaluate(() => {
      document.getElementById('join-url').textContent = 'http://localhost:4100/TEST';
      document.getElementById('lobby-screen').classList.remove('hidden');
      document.getElementById('welcome-screen').classList.add('hidden');
    });
    await page.waitForTimeout(200);
    await stopDisplayBackground(page);
    await expect(page).toHaveScreenshot('03-lobby-empty.png', {
      mask: [page.locator('#qr-container')],
      maxDiffPixelRatio: 0.02,
    });
  });

  test('lobby screen - with players', async ({ page }) => {
    await gotoDisplayTest(page);
    await page.evaluate(() => {
      document.getElementById('join-url').textContent = 'http://localhost:4100/TEST';
      document.getElementById('lobby-screen').classList.remove('hidden');
      document.getElementById('welcome-screen').classList.add('hidden');
    });
    await injectPlayers(page, 2);
    await page.waitForTimeout(200);
    await stopDisplayBackground(page);
    await expect(page).toHaveScreenshot('04-lobby-players.png', {
      mask: [page.locator('#qr-container')],
      maxDiffPixelRatio: 0.02,
    });
  });

  test('game screen - 1 player', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 1);
    await injectGameState(page, 1, {
      pieces: [
        { typeId: 1, x: 3, y: 2, blocks: [[0, 1], [1, 1], [2, 1], [3, 1]] }
      ],
      ghostYs: [13]
    });
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot('05-game-1p.png');
  });

  test('game screen - 2 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 2);
    await injectGameState(page, 2, {
      pieces: [
        { typeId: 6, x: 4, y: 2, blocks: [[1, 0], [0, 1], [1, 1], [2, 1]] },
        { typeId: 2, x: 3, y: 3, blocks: [[0, 0], [0, 1], [1, 1], [2, 1]] }
      ],
      ghostYs: [14, 14]
    });
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot('06-game-2p.png');
  });

  test('game screen - 4 players', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 4);
    await injectGameState(page, 4, {
      pieces: [
        { typeId: 5, x: 4, y: 2, blocks: [[1, 0], [2, 0], [0, 1], [1, 1]] },
        { typeId: 7, x: 3, y: 3, blocks: [[0, 0], [1, 0], [1, 1], [2, 1]] },
        { typeId: 3, x: 3, y: 4, blocks: [[2, 0], [0, 1], [1, 1], [2, 1]] },
        { typeId: 4, x: 5, y: 3, blocks: [[1, 0], [2, 0], [1, 1], [2, 1]] }
      ],
      ghostYs: [14, 14, 14, 14]
    });
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot('07-game-4p.png');
  });

  test('game screen - with KO', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 2);
    await injectGameState(page, 2, { deadPlayerIds: ['player2'] });
    await page.evaluate(() => {
      window.__TEST__.injectKO('player2');
    });
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot('08-game-ko.png');
  });

  test('pause overlay', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 1);
    await injectGameState(page, 1, {});
    await injectPause(page);
    await page.waitForSelector('#pause-overlay:not(.hidden)');
    await page.waitForTimeout(150);
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
    await page.waitForTimeout(150);
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
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot('09b-disconnected.png');
  });

  test('results screen', async ({ page }) => {
    await gotoDisplayTest(page);
    await injectPlayers(page, 4);
    await injectResults(page, 4);
    await page.waitForSelector('#results-screen:not(.hidden)');
    await page.waitForTimeout(1100);
    await expect(page).toHaveScreenshot('10-results.png');
  });
});
