// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const { waitForFont } = require('../visual/helpers');

const MOCK_SCRIPT = path.join(__dirname, 'airconsole-mock.js');

/**
 * Collect console errors from a page.
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

/**
 * Block the real AirConsole SDK and inject the mock before any page script runs.
 */
async function setupAirConsoleMock(page, opts = {}) {
  // Block the real AirConsole SDK
  await page.route('**/airconsole-1.10.0.js', (route) => {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '// blocked' });
  });

  // Set optional nickname and device ID before mock loads
  if (opts.nickname || opts.deviceId) {
    await page.addInitScript((o) => {
      if (o.nickname) window.__AC_NICKNAME = o.nickname;
      if (o.deviceId) window.__AC_DEVICE_ID = o.deviceId;
    }, opts);
  }

  // Inject mock SDK
  await page.addInitScript({ path: MOCK_SCRIPT });
}

/**
 * Open the AirConsole screen (display) page.
 */
async function openScreen(page) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/screen.html');
  await waitForFont(page);
  // Wait for lobby to appear (AirConsole mode skips welcome)
  await page.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
}

/**
 * Open an AirConsole controller page in a new tab.
 */
async function openController(context, opts = {}) {
  const page = await context.newPage();
  await setupAirConsoleMock(page, opts);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/controller.html');
  await waitForFont(page);
  return page;
}

/**
 * Wait for the display to show N players in the lobby.
 */
async function waitForPlayers(page, count) {
  await page.waitForFunction((n) => {
    return document.querySelectorAll('#player-list .player-card:not(.empty)').length >= n;
  }, count, { timeout: 10000 });
}

/**
 * Wait for the display game screen with countdown finished.
 */
async function waitForDisplayGame(page) {
  await page.waitForSelector('#game-screen:not(.hidden)', { timeout: 10000 });
  await page.waitForFunction(() => {
    return document.getElementById('countdown-overlay').classList.contains('hidden');
  }, null, { timeout: 10000 });
  await page.waitForTimeout(150);
}

/**
 * Wait for display results screen.
 */
async function waitForDisplayResults(page) {
  await page.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });
}

/**
 * Wait for controller to be on the lobby screen with identity visible.
 */
async function waitForControllerLobby(page) {
  await page.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
  await page.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });
}

/**
 * Wait for controller game screen (countdown finished).
 */
async function waitForControllerGame(page) {
  await page.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });
  await page.waitForTimeout(150);
}

/**
 * Wait for controller results screen.
 */
async function waitForControllerResults(page) {
  await page.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });
}

test.describe('AirConsole Integration', () => {
  test.setTimeout(90000);

  let screenPage;

  test.beforeEach(async ({ page }) => {
    screenPage = page;
    await setupAirConsoleMock(screenPage);
  });

  test('screen skips welcome and shows lobby directly', async () => {
    const errors = trackConsoleErrors(screenPage);
    await openScreen(screenPage);

    // Welcome screen should be hidden
    const welcomeVisible = await screenPage.evaluate(() => {
      const el = document.getElementById('welcome-screen');
      return el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
    });
    expect(welcomeVisible).toBeFalsy();

    // Lobby should be visible
    const lobbyVisible = await screenPage.evaluate(() => {
      const el = document.getElementById('lobby-screen');
      return el && !el.classList.contains('hidden');
    });
    expect(lobbyVisible).toBeTruthy();

    // QR container should be hidden (CSS)
    const qrHidden = await screenPage.evaluate(() => {
      const el = document.getElementById('qr-container');
      return el && getComputedStyle(el).display === 'none';
    });
    expect(qrHidden).toBeTruthy();

    expect(errors).toEqual([]);
  });

  test('controller connects and appears in lobby', async ({ context }) => {
    const screenErrors = trackConsoleErrors(screenPage);
    await openScreen(screenPage);

    const controller = await openController(context, {
      nickname: 'TestPlayer',
      deviceId: 101
    });
    const controllerErrors = trackConsoleErrors(controller);

    // Controller should reach lobby
    await waitForControllerLobby(controller);

    // Display should show the player
    await waitForPlayers(screenPage, 1);

    // Player card should exist on display
    const playerCount = await screenPage.evaluate(() => {
      return document.querySelectorAll('#player-list .player-card:not(.empty)').length;
    });
    expect(playerCount).toBeGreaterThanOrEqual(1);

    expect(screenErrors).toEqual([]);
    expect(controllerErrors).toEqual([]);
  });

  test('two controllers join and host can start game', async ({ context }) => {
    const screenErrors = trackConsoleErrors(screenPage);
    await openScreen(screenPage);

    const c1 = await openController(context, { nickname: 'Alice', deviceId: 101 });
    const c1Errors = trackConsoleErrors(c1);
    await waitForControllerLobby(c1);
    await waitForPlayers(screenPage, 1);

    const c2 = await openController(context, { nickname: 'Bob', deviceId: 102 });
    const c2Errors = trackConsoleErrors(c2);
    await waitForControllerLobby(c2);
    await waitForPlayers(screenPage, 2);

    // Host (first controller) should see start button
    const startVisible = await c1.evaluate(() => {
      const btn = document.getElementById('start-btn');
      return btn && !btn.classList.contains('hidden');
    });
    expect(startVisible).toBeTruthy();

    // Start the game
    await c1.click('#start-btn');

    // Display should show game
    await waitForDisplayGame(screenPage);

    // Both controllers should be in game
    await waitForControllerGame(c1);
    await waitForControllerGame(c2);

    expect(screenErrors).toEqual([]);
    expect(c1Errors).toEqual([]);
    expect(c2Errors).toEqual([]);
  });

  test('single player: full lifecycle lobby → game → results', async ({ context }) => {
    const screenErrors = trackConsoleErrors(screenPage);
    await openScreen(screenPage);

    const controller = await openController(context, {
      nickname: 'Alice',
      deviceId: 101
    });
    const controllerErrors = trackConsoleErrors(controller);

    await waitForControllerLobby(controller);
    await waitForPlayers(screenPage, 1);

    // Set high start level so game ends quickly
    await controller.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await controller.waitForTimeout(200);

    // Start game
    await controller.click('#start-btn');
    await waitForDisplayGame(screenPage);
    await waitForControllerGame(controller);

    // Wait for game to end (level 15 should top out within 60s)
    await waitForDisplayResults(screenPage);
    await waitForControllerResults(controller);

    expect(screenErrors).toEqual([]);
    expect(controllerErrors).toEqual([]);
  });

  test('adapter uses AirConsole messaging, not PartyConnection relay', async ({ context }) => {
    const screenErrors = trackConsoleErrors(screenPage);
    await openScreen(screenPage);

    // Verify the display is using AirConsoleAdapter, not PartyConnection
    const adapterType = await screenPage.evaluate(() => {
      return party && party.constructor && party.constructor.name;
    });
    expect(adapterType).toBe('AirConsoleAdapter');

    // Verify no WebSocket connections to relay (PartyConnection not used)
    const wsConnections = await screenPage.evaluate(() => {
      // Check if any WebSocket was opened to the relay
      return typeof party.ws === 'undefined' || party.ws === null;
    });
    expect(wsConnections).toBeTruthy();

    const controller = await openController(context, {
      nickname: 'Tester',
      deviceId: 101
    });

    await waitForControllerLobby(controller);
    await waitForPlayers(screenPage, 1);

    // Verify controller is also using adapter
    const controllerAdapterType = await controller.evaluate(() => {
      return party && party.constructor && party.constructor.name;
    });
    expect(controllerAdapterType).toBe('AirConsoleAdapter');

    expect(screenErrors).toEqual([]);
  });

  test('controller disconnect is detected by display', async ({ context }) => {
    const screenErrors = trackConsoleErrors(screenPage);
    await openScreen(screenPage);

    const controller = await openController(context, {
      nickname: 'LeavingPlayer',
      deviceId: 101
    });

    await waitForControllerLobby(controller);
    await waitForPlayers(screenPage, 1);

    // Close controller page — this triggers BroadcastChannel cleanup
    // and the mock fires disconnect via the 'beforeunload' path
    await controller.evaluate(() => {
      // Manually fire disconnect via the mock's BroadcastChannel
      var channel = new BroadcastChannel('__airconsole_mock__');
      channel.postMessage({ _ac_type: 'disconnect', deviceId: window.__AC_DEVICE_ID });
      channel.close();
    });

    // Wait for display to process the disconnect
    // In lobby, there's a 5s grace period before removal
    await screenPage.waitForTimeout(6000);

    const playerCount = await screenPage.evaluate(() => {
      return document.querySelectorAll('#player-list .player-card:not(.empty)').length;
    });
    expect(playerCount).toBe(0);

    expect(screenErrors).toEqual([]);
  });

  test('play again flow works after game ends', async ({ context }) => {
    const screenErrors = trackConsoleErrors(screenPage);
    await openScreen(screenPage);

    const controller = await openController(context, {
      nickname: 'Alice',
      deviceId: 101
    });
    const controllerErrors = trackConsoleErrors(controller);

    await waitForControllerLobby(controller);
    await waitForPlayers(screenPage, 1);

    // High level for fast game
    await controller.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await controller.waitForTimeout(200);

    // Play first game
    await controller.click('#start-btn');
    await waitForDisplayGame(screenPage);
    await waitForControllerGame(controller);
    await waitForDisplayResults(screenPage);
    await waitForControllerResults(controller);

    // Click "Play Again" on controller (host)
    await controller.click('#play-again-btn');

    // Should go through countdown and back into game
    await waitForDisplayGame(screenPage);
    await waitForControllerGame(controller);

    // Game is running again — success
    const gameVisible = await screenPage.evaluate(() => {
      const el = document.getElementById('game-screen');
      return el && !el.classList.contains('hidden');
    });
    expect(gameVisible).toBeTruthy();

    expect(screenErrors).toEqual([]);
    expect(controllerErrors).toEqual([]);
  });
});
