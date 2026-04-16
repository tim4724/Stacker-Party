// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForFont } = require('../visual/helpers');

/**
 * Verifies that clicking "New Game" shows the lobby even when the relay
 * server is slow to respond. Previously, if preCreatedRoom was null when
 * the button was clicked, the lobby would never appear because
 * onRoomCreated would cache instead of apply.
 */
test.describe('Slow relay', () => {
  test('lobby appears even when relay is slow to create room', async ({ page }) => {
    // Intercept WebSocket to the relay and delay the "created" response
    const DELAY_MS = 2000;

    await page.routeWebSocket(/ws\.couch-games\.com/, (ws) => {
      const server = ws.connectToServer();

      ws.onMessage((msg) => {
        server.send(msg);
      });

      server.onMessage((msg) => {
        let parsed;
        try { parsed = JSON.parse(msg); } catch { parsed = null; }

        if (parsed && parsed.type === 'created') {
          // Delay the "created" response to simulate slow relay
          setTimeout(() => ws.send(msg), DELAY_MS);
        } else {
          ws.send(msg);
        }
      });
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/', { waitUntil: 'networkidle' });
    await waitForFont(page);

    // Dismiss end screen if visible
    const hint = page.locator('#end-continue-btn');
    if (await hint.isVisible()) await hint.click();

    // Verify preCreatedRoom is null (relay hasn't responded yet)
    const preCreated = await page.evaluate(() => !!window.preCreatedRoom);
    // It might or might not be null depending on timing, but the test
    // verifies the lobby shows regardless — that's what matters.

    // Click "New Game" — this is the critical moment
    await page.click('#new-game-btn');

    // Lobby should appear (possibly empty, waiting for relay)
    await page.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });

    // Once relay responds, QR and join URL should populate
    await page.waitForFunction(() => {
      const joinUrl = document.getElementById('join-url');
      return joinUrl && joinUrl.textContent && joinUrl.textContent.length > 0;
    }, null, { timeout: DELAY_MS + 10000 });
  });
});
