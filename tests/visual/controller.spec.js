// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  joinController,
  waitForControllerGame,
  waitForControllerResults,
  waitForDisplayPlayers,
  waitForFont,
} = require('./helpers');

async function setupJoinedRoom(displayPage, context, names) {
  const { roomCode } = await createRoom(displayPage);
  const controllers = [];

  for (const name of names) {
    controllers.push(await joinController(context, roomCode, name));
  }

  return { roomCode, controllers };
}

test.describe('Controller', () => {
  test('name entry screen', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await context.newPage();
    await controller.goto(`/${roomCode}`);
    await waitForFont(controller);
    await expect(controller).toHaveScreenshot('01a-name-entry.png');
  });

  test('name entry - keyboard open', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await context.newPage();
    await controller.goto(`/${roomCode}`);
    await waitForFont(controller);
    await controller.fill('#name-input', 'Player 1');
    await controller.focus('#name-input');
    await controller.evaluate(() => {
      document.body.classList.add('keyboard-open');
      document.documentElement.style.setProperty('--app-height', '544px');
    });
    await expect(controller).toHaveScreenshot('01b-name-keyboard.png');
  });

  test('lobby - host view', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    await host.waitForFunction(() => document.getElementById('start-btn').textContent.includes('2 players'));
    await expect(host).toHaveScreenshot('03-lobby-host.png');
  });

  test('lobby - non-host view', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const nonHost = controllers[1];
    await nonHost.waitForFunction(() => document.getElementById('waiting-action-text').textContent.includes('Waiting for host'));
    await expect(nonHost).toHaveScreenshot('04-lobby-nonhost.png');
  });

  test('game screen - host', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    // Start game via host
    await host.click('#start-btn');
    await waitForControllerGame(host);
    await expect(host).toHaveScreenshot('05-game-host.png');
  });

  test('game screen - non-host', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const nonHost = controllers[1];
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(nonHost);
    await expect(nonHost).toHaveScreenshot('06-game-nonhost.png');
  });

  test('game screen - paused (host)', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(host);
    await host.click('#pause-btn');
    await host.waitForSelector('#pause-overlay:not(.hidden)');
    await host.waitForTimeout(150);
    await expect(host).toHaveScreenshot('07-pause-host.png');
  });

  test('game screen - paused (non-host)', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    const nonHost = controllers[1];
    await host.click('#start-btn');
    await waitForControllerGame(nonHost);
    await host.click('#pause-btn');
    await nonHost.waitForSelector('#pause-overlay:not(.hidden)');
    await nonHost.waitForTimeout(150);
    await expect(nonHost).toHaveScreenshot('08-pause-nonhost.png');
  });

  test('results - host view', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1']);
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(host);
    // Speed up game end by sending hard drops via display's game engine
    const dropInterval = setInterval(async () => {
      try {
        await page.evaluate(() => {
          if (displayGame && typeof displayGame.processInput === 'function') {
            var ids = Array.from(playerOrder || []);
            for (var i = 0; i < ids.length; i++) {
              displayGame.processInput(ids[i], 'hard_drop');
            }
          }
        });
      } catch (_) {}
    }, 100);
    await waitForControllerResults(host);
    clearInterval(dropInterval);
    await expect(host).toHaveScreenshot('10-results-host.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('reconnect overlay - attempt', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1']);
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(host);
    await host.evaluate(() => {
      document.getElementById('reconnect-overlay').classList.remove('hidden');
      document.getElementById('reconnect-heading').textContent = 'RECONNECTING';
      document.getElementById('reconnect-status').textContent = 'Attempt 2 of 5';
      document.getElementById('reconnect-rejoin-btn').classList.add('hidden');
    });
    await host.waitForTimeout(150);
    await expect(host).toHaveScreenshot('09a-reconnect-attempt.png');
  });

  test('reconnect overlay - display disconnected', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1']);
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(host);
    await host.evaluate(() => {
      document.getElementById('reconnect-overlay').classList.remove('hidden');
      document.getElementById('reconnect-heading').textContent = 'RECONNECTING';
      document.getElementById('reconnect-status').textContent = 'Display reconnecting...';
      document.getElementById('reconnect-rejoin-btn').classList.add('hidden');
    });
    await host.waitForTimeout(150);
    await expect(host).toHaveScreenshot('09b-reconnect-display.png');
  });

  test('reconnect overlay - failed with rejoin', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1']);
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(host);
    await host.evaluate(() => {
      document.getElementById('reconnect-overlay').classList.remove('hidden');
      document.getElementById('reconnect-heading').textContent = 'RECONNECTING';
      document.getElementById('reconnect-status').textContent = 'Attempt 5 of 5';
      document.getElementById('reconnect-rejoin-btn').classList.remove('hidden');
    });
    await host.waitForTimeout(150);
    await expect(host).toHaveScreenshot('09c-reconnect-rejoin.png');
  });

  test('error - room not found', async ({ page }) => {
    // Navigate to a room code that doesn't exist on Party-Server
    await page.goto('/ZZZZ');
    await waitForFont(page);
    await page.fill('#name-input', 'Player 1');
    await page.click('#name-join-btn');
    await page.waitForFunction(() => {
      return document.getElementById('room-gone-heading').textContent === 'Room Not Found'
        && !document.getElementById('room-gone-message').classList.contains('hidden');
    });
    await expect(page).toHaveScreenshot('12-error-room-notfound.png');
  });

  test('error - host disconnected', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    const nonHost = controllers[1];
    await host.click('#lobby-back-btn');
    await nonHost.waitForFunction(() => {
      const btn = document.getElementById('name-join-btn');
      return document.getElementById('name-status-detail').textContent === 'Host disconnected'
        && !btn.disabled;
    });
    await expect(nonHost).toHaveScreenshot('13-error-host-disconnected.png');
  });
});
