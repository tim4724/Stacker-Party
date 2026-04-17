// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  joinController,
  waitForDisplayPlayers,
  waitForDisplayGame,
  waitForControllerGame,
} = require('./helpers');

// Longer timeout — we're waiting for a real game to finish
const GAME_TIMEOUT = 60000;

async function waitForDisplayResults(page) {
  await page.waitForSelector('#results-screen:not(.hidden)', { timeout: GAME_TIMEOUT });
}

async function waitForControllerResults(page) {
  await page.waitForSelector('#gameover-screen:not(.hidden)', { timeout: GAME_TIMEOUT });
}

/**
 * Collect console errors from a page.
 * Returns an array that accumulates errors throughout the test.
 */
function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });
  return errors;
}

test.describe('Game Lifecycle', () => {
  test.setTimeout(90000);

  test('single player: lobby → game → results with no errors', async ({ page, context }) => {
    const displayErrors = trackConsoleErrors(page);

    // Create room and join with one controller at high level
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    const controllerErrors = trackConsoleErrors(controller);

    await waitForDisplayPlayers(page, 1);

    // Set start level to 15 via controller so the game ends quickly
    await controller.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await controller.waitForTimeout(200);

    // Host starts the game
    await controller.click('#start-btn');
    await waitForDisplayGame(page);
    await waitForControllerGame(controller);

    // Wait for game to end (high level should top out within 60s)
    await waitForDisplayResults(page);
    await waitForControllerResults(controller);

    expect(displayErrors).toEqual([]);
    expect(controllerErrors).toEqual([]);
  });

  test('single player: controller reload during results causes no errors', async ({ page, context }) => {
    const displayErrors = trackConsoleErrors(page);

    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Bob');
    trackConsoleErrors(controller);

    await waitForDisplayPlayers(page, 1);

    // Set high level
    await controller.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await controller.waitForTimeout(200);

    await controller.click('#start-btn');
    await waitForDisplayGame(page);
    await waitForControllerGame(controller);

    await waitForDisplayResults(page);
    await waitForControllerResults(controller);

    // Reload controller during results — this used to crash the display render loop
    await controller.reload();
    await page.waitForTimeout(2000);

    expect(displayErrors).toEqual([]);
  });

  test('two players: full game lifecycle with no errors', async ({ page, context }) => {
    const displayErrors = trackConsoleErrors(page);

    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');
    const c1Errors = trackConsoleErrors(c1);
    const c2Errors = trackConsoleErrors(c2);

    await waitForDisplayPlayers(page, 2);

    // Set high level on both
    for (const c of [c1, c2]) {
      await c.evaluate(() => {
        const plus = document.getElementById('level-plus-btn');
        for (let i = 0; i < 14; i++) plus.click();
      });
    }
    await c1.waitForTimeout(200);

    // Host starts
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    // Wait for results
    await waitForDisplayResults(page);

    expect(displayErrors).toEqual([]);
    expect(c1Errors).toEqual([]);
    expect(c2Errors).toEqual([]);
  });
});
