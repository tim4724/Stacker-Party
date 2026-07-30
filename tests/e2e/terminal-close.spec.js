// @ts-check
const { test, expect } = require('@playwright/test');
const { createRoom, waitForFont } = require('./helpers');

/**
 * The two relay closes PartyConnection treats as terminal (it clears
 * _shouldReconnect and stops retrying), and which therefore cannot be handed to
 * the reconnect overlay: it gets attempt 0 of 0, so it paints a counter that
 * counts nothing and never reaches the escalation that reveals its RECONNECT
 * button. Before DisplayConnection#onClose split them out, either one left the
 * display wedged on that overlay with no way out.
 *
 *   4001 room closed — the room is gone, so recover into a fresh one.
 *   4000 replaced    — another client took our slot; terminal by design, no
 *                      button, because rejoining would start a takeover war.
 *
 * Both are driven by intercepting the relay socket and closing the page side
 * with the code, while still proxying to the real relay so the room is created
 * for real first.
 */

/** Proxy the relay socket, exposing the live route so a test can close it. */
function interceptRelay(page, state) {
  return page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
    state.route = ws;
    state.sockets++;
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
  });
}

test.describe('Terminal relay closes', () => {
  test('4001 room-closed recovers into a fresh room', async ({ page }) => {
    const state = { route: null, sockets: 0 };
    await interceptRelay(page, state);

    const { roomCode } = await createRoom(page);
    expect(state.sockets).toBe(1);

    // The relay tore the room down under us.
    await state.route.close({ code: 4001, reason: 'room closed' });

    // resetToWelcome: back to the welcome screen, with a brand-new socket
    // opened for the replacement room rather than a dead pinned one.
    await page.waitForSelector('#welcome-screen:not(.hidden)', { timeout: 10000 });
    await expect.poll(() => state.sockets, { timeout: 10000 }).toBeGreaterThan(1);

    // And the display is genuinely usable again, on a different room. Waiting
    // for the code to CHANGE rather than to be non-empty: the element keeps the
    // dead room's text until the replacement `created` lands, so a non-empty
    // check passes instantly on the stale value and asserts nothing.
    await page.click('#new-game-btn');
    await page.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
    await page.waitForFunction((old) => {
      const el = document.querySelector('#join-url .join-url__code');
      const code = el && el.textContent.trim();
      return !!code && code !== old;
    }, roomCode, { timeout: 15000 });
  });

  test('4000 replaced shows a terminal disconnect with no retry button', async ({ page }) => {
    const state = { route: null, sockets: 0 };
    await interceptRelay(page, state);

    await createRoom(page);

    // Another client claimed slot 0.
    await state.route.close({ code: 4000, reason: 'replaced' });

    await page.waitForSelector('#reconnect-overlay:not(.hidden)', { timeout: 10000 });
    // The regression: attempt 0 of 0 used to render here, above a button that
    // was hidden and could never be revealed. A terminal close has no count.
    await expect(page.locator('#reconnect-status')).toHaveText('');
    await expect(page.locator('#reconnect-btn')).toBeHidden();
    // Heading is the same DISCONNECTED copy the exhausted-backoff path ends on,
    // so this asserts it is set rather than left blank or stale.
    await expect(page.locator('#reconnect-heading')).not.toHaveText('');

    // Terminal means terminal: no silent reconnect behind the overlay.
    await page.waitForTimeout(2000);
    expect(state.sockets).toBe(1);
  });
});
