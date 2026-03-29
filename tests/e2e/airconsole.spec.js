// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForFont } = require('../visual/helpers');

/**
 * AirConsole E2E tests using the real AirConsole platform.
 *
 * These tests open https://www.airconsole.com/#GAME_URL which loads
 * screen.html and controller.html inside AirConsole's iframes with the
 * real AirConsole SDK and messaging infrastructure.
 */

// The game URL — use deployed preview or local server via env var
const GAME_URL = process.env.AC_GAME_URL || 'http://localhost:4100';
const AC_URL = 'https://www.airconsole.com/#' + GAME_URL + '/';

function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore known AirConsole warnings
      if (text.includes('outside of the AirConsole')) return;
      if (text.includes('Posting message to parent')) return;
      errors.push(text);
    }
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });
  return errors;
}

/**
 * Find the screen iframe (loads screen.html from our game URL)
 */
async function getScreenFrame(page) {
  await page.waitForTimeout(3000);
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes('screen.html')) return frame;
  }
  return null;
}

/**
 * Find controller iframes
 */
function getControllerFrames(page) {
  return page.frames().filter(f => f.url().includes('controller.html'));
}

/**
 * Wait for the screen frame to show lobby
 */
async function waitForScreenLobby(screenFrame) {
  await screenFrame.waitForFunction(() => {
    return typeof currentScreen !== 'undefined' && currentScreen === 'lobby'
      && typeof party !== 'undefined' && party && party._ready;
  }, null, { timeout: 15000 });
}

/**
 * Wait for a controller frame to reach lobby
 */
async function waitForControllerLobby(controllerFrame) {
  await controllerFrame.waitForFunction(() => {
    return typeof currentScreen !== 'undefined' && currentScreen === 'lobby';
  }, null, { timeout: 15000 });
}

/**
 * Wait for the screen to show the game (countdown finished)
 */
async function waitForScreenGame(screenFrame) {
  await screenFrame.waitForSelector('#game-screen:not(.hidden)', { timeout: 15000 });
  await screenFrame.waitForFunction(() => {
    return document.getElementById('countdown-overlay').classList.contains('hidden');
  }, null, { timeout: 15000 });
  await screenFrame.page().waitForTimeout(200);
}

/**
 * Wait for controller to show game screen
 */
async function waitForControllerGame(controllerFrame) {
  await controllerFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });
}

/**
 * Wait for screen results
 */
async function waitForScreenResults(screenFrame) {
  await screenFrame.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });
}

/**
 * Wait for controller results
 */
async function waitForControllerResults(controllerFrame) {
  await controllerFrame.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });
}

test.describe('AirConsole Integration', () => {
  test.setTimeout(120000);

  test('screen loads and reaches lobby inside AirConsole', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto(AC_URL, { waitUntil: 'domcontentloaded' });

    const screenFrame = await getScreenFrame(page);
    expect(screenFrame).not.toBeNull();

    await waitForScreenLobby(screenFrame);

    const state = await screenFrame.evaluate(() => ({
      currentScreen,
      partyType: party?.constructor?.name,
      partyReady: party?._ready,
    }));

    expect(state.currentScreen).toBe('lobby');
    expect(state.partyType).toBe('AirConsoleAdapter');
    expect(state.partyReady).toBe(true);
  });

  test('controller connects and joins lobby', async ({ page }) => {
    await page.goto(AC_URL, { waitUntil: 'domcontentloaded' });

    const screenFrame = await getScreenFrame(page);
    expect(screenFrame).not.toBeNull();
    await waitForScreenLobby(screenFrame);

    // Wait for controller frames to appear (AirConsole adds them)
    await page.waitForTimeout(5000);
    const controllers = getControllerFrames(page);

    if (controllers.length === 0) {
      test.skip(true, 'No controller iframes found — AirConsole may not provide controllers in this mode');
      return;
    }

    const ctrl = controllers[0];
    await waitForControllerLobby(ctrl);

    const ctrlState = await ctrl.evaluate(() => ({
      currentScreen,
      partyType: party?.constructor?.name,
      connected: party?.connected,
    }));

    expect(ctrlState.currentScreen).toBe('lobby');
    expect(ctrlState.partyType).toBe('AirConsoleAdapter');
    expect(ctrlState.connected).toBe(true);

    // Display should see the player
    const playerCount = await screenFrame.evaluate(() => players.size);
    expect(playerCount).toBeGreaterThanOrEqual(1);
  });

  test('full game lifecycle: lobby → game → results', async ({ page }) => {
    await page.goto(AC_URL, { waitUntil: 'domcontentloaded' });

    const screenFrame = await getScreenFrame(page);
    expect(screenFrame).not.toBeNull();
    await waitForScreenLobby(screenFrame);

    await page.waitForTimeout(5000);
    const controllers = getControllerFrames(page);

    if (controllers.length === 0) {
      test.skip(true, 'No controller iframes found');
      return;
    }

    const ctrl = controllers[0];
    await waitForControllerLobby(ctrl);

    // Set high level for fast game
    await ctrl.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await page.waitForTimeout(300);

    // Start game
    await ctrl.locator('#start-btn').click();
    await waitForScreenGame(screenFrame);
    await waitForControllerGame(ctrl);

    // Wait for game to end
    await waitForScreenResults(screenFrame);
    await waitForControllerResults(ctrl);
  });
});
