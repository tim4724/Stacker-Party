// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  joinController,
  waitForDisplayPlayers,
  waitForDisplayGame,
  waitForFont,
} = require('./helpers');

/**
 * Join a controller mid-game. Unlike joinController(), waits for either the
 * game screen OR lobby (late joiner waiting screen) to appear.
 */
async function joinMidGame(context, roomCode, name) {
  const page = await context.newPage();
  await page.addInitScript((rc) => {
    var key = '_stacker_cleared_' + rc;
    if (!sessionStorage.getItem(key)) {
      localStorage.removeItem('clientId_' + rc);
      sessionStorage.setItem(key, '1');
    }
  }, roomCode);
  await page.goto(`/${roomCode}?test=1`);
  await waitForFont(page);
  await page.fill('#name-input', name);
  await page.click('#name-join-btn');
  await page.waitForFunction(() => {
    const game = document.getElementById('game-screen');
    const lobby = document.getElementById('player-identity');
    const waiting = document.getElementById('waiting-action-text');
    return (game && !game.classList.contains('hidden')) ||
           (lobby && !lobby.classList.contains('hidden')) ||
           (waiting && waiting.textContent.length > 0);
  }, null, { timeout: 15000 });
  return page;
}

test.describe('Reconnection', () => {
  test.setTimeout(60000);

  test('display auto-pauses when controller disconnects during game', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);

    // Close controller (simulates disconnect)
    await controller.close();

    // Display should auto-pause
    await page.waitForFunction(() => {
      return typeof autoPaused !== 'undefined' && autoPaused === true;
    }, null, { timeout: 10000 });

    const isPaused = await page.evaluate(() => paused);
    expect(isPaused).toBe(true);
  });

  test('display reconnect overlay shows when relay connection drops', async ({ page, context }) => {
    // Intercept the relay WebSocket so we can force-close it
    let serverWs;
    await page.routeWebSocket(/ws\.hexstackerparty\.com/, (ws) => {
      const server = ws.connectToServer();
      serverWs = { client: ws, server };

      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);

    // Force close the display's relay connection from server side
    serverWs.server.close();

    // Reconnect overlay should appear
    await page.waitForSelector('#reconnect-overlay:not(.hidden)', { timeout: 15000 });
  });

  test('two-player game: one disconnect does not end game', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');

    await waitForDisplayPlayers(page, 2);
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    // Close one controller
    await c1.close();

    // Game should still be running (not ended) after a brief settle period
    const endedEarly = await page.waitForFunction(
      () => typeof roomState !== 'undefined' && roomState === 'results',
      null, { timeout: 2000 }
    ).then(() => true).catch(() => false);
    expect(endedEarly).toBe(false);
  });

  test('new controller joining mid-game is treated as late joiner', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);

    // A fresh page load creates a new clientId at the relay, so the display
    // correctly treats this as a new player (late joiner), not a reconnect.
    const lateComer = await joinMidGame(context, roomCode, 'Bob');

    // Late joiner should see "game in progress" waiting message
    await lateComer.waitForFunction(() => {
      const el = document.getElementById('waiting-action-text');
      return el && el.textContent.length > 0 && !el.classList.contains('hidden');
    }, null, { timeout: 10000 });
    const waitingMsg = await lateComer.evaluate(() => {
      return document.getElementById('waiting-action-text').textContent;
    });
    expect(waitingMsg.length).toBeGreaterThan(0);
  });

  test('display shows disconnected QR overlay for missing player', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');

    await waitForDisplayPlayers(page, 2);
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    // Close one controller
    await c1.close();

    // Display should have a disconnected QR for the lost player
    await page.waitForFunction(() => {
      return typeof disconnectedQRs !== 'undefined' && disconnectedQRs.size > 0;
    }, null, { timeout: 10000 });

    const disconnectedCount = await page.evaluate(() => disconnectedQRs.size);
    expect(disconnectedCount).toBe(1);
  });
});
