// @ts-check
const { test, expect } = require('@playwright/test');
const {
  applyScenario,
  createRoom,
  joinController,
  resetTestServer,
  stopDisplayBackground,
  waitForDisplayGame,
  waitForDisplayPlayers,
  waitForDisplayResults,
  waitForFont,
} = require('./helpers');

test.beforeEach(async ({ request }) => {
  await resetTestServer(request);
});

test.afterEach(async ({ request }) => {
  await resetTestServer(request);
});

test.describe('Display', () => {
  test('welcome screen', async ({ page }) => {
    await page.goto('/');
    await waitForFont(page);
    await stopDisplayBackground(page);
    await expect(page).toHaveScreenshot('display-welcome.png');
  });

  test('lobby screen - empty', async ({ page }) => {
    await createRoom(page);
    await page.waitForTimeout(200);
    await stopDisplayBackground(page);
    await expect(page).toHaveScreenshot('display-lobby-empty.png', {
      mask: [page.locator('#qr-container')],
      maxDiffPixelRatio: 0.02,
    });
  });

  test('lobby screen - with players', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    await joinController(context, roomCode, 'Player 1');
    await joinController(context, roomCode, 'Player 2');
    await waitForDisplayPlayers(page, 2);
    await page.waitForTimeout(200);
    await stopDisplayBackground(page);
    await expect(page).toHaveScreenshot('display-lobby-players.png', {
      mask: [page.locator('#qr-container')],
      maxDiffPixelRatio: 0.02,
    });
  });

  test('game screen - 1 player', async ({ page, context, request }) => {
    const { roomCode } = await createRoom(page);
    await joinController(context, roomCode, 'Player 1');
    await waitForDisplayPlayers(page, 1);
    await applyScenario(request, roomCode, 'game');
    await waitForDisplayGame(page);
    await expect(page).toHaveScreenshot('display-game-1p.png');
  });

  test('game screen - 2 players', async ({ page, context, request }) => {
    const { roomCode } = await createRoom(page);
    await joinController(context, roomCode, 'Player 1');
    await joinController(context, roomCode, 'Player 2');
    await waitForDisplayPlayers(page, 2);
    await applyScenario(request, roomCode, 'game');
    await waitForDisplayGame(page);
    await expect(page).toHaveScreenshot('display-game-2p.png');
  });

  test('game screen - 4 players', async ({ page, context, request }) => {
    const { roomCode } = await createRoom(page);
    await joinController(context, roomCode, 'Player 1');
    await joinController(context, roomCode, 'Player 2');
    await joinController(context, roomCode, 'Player 3');
    await joinController(context, roomCode, 'Player 4');
    await waitForDisplayPlayers(page, 4);
    await applyScenario(request, roomCode, 'game');
    await waitForDisplayGame(page);
    await expect(page).toHaveScreenshot('display-game-4p.png');
  });

  test('game screen - with KO', async ({ page, context, request }) => {
    const { roomCode } = await createRoom(page);
    await joinController(context, roomCode, 'Player 1');
    await joinController(context, roomCode, 'Player 2');
    await waitForDisplayPlayers(page, 2);
    await applyScenario(request, roomCode, 'ko');
    await waitForDisplayGame(page);
    await expect(page).toHaveScreenshot('display-game-ko.png');
  });

  test('pause overlay', async ({ page, context, request }) => {
    const { roomCode } = await createRoom(page);
    await joinController(context, roomCode, 'Player 1');
    await waitForDisplayPlayers(page, 1);
    await applyScenario(request, roomCode, 'pause');
    await page.waitForSelector('#pause-overlay:not(.hidden)');
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot('display-pause.png');
  });

  test('results screen', async ({ page, context, request }) => {
    const { roomCode } = await createRoom(page);
    await joinController(context, roomCode, 'Player 1');
    await joinController(context, roomCode, 'Player 2');
    await joinController(context, roomCode, 'Player 3');
    await joinController(context, roomCode, 'Player 4');
    await waitForDisplayPlayers(page, 4);
    await applyScenario(request, roomCode, 'results');
    await waitForDisplayResults(page);
    await expect(page).toHaveScreenshot('display-results.png');
  });
});
