// @ts-check
const { test, expect } = require('@playwright/test');
const {
  applyScenario,
  createRoom,
  delayNextJoin,
  joinController,
  resetTestServer,
  waitForControllerGame,
  waitForControllerResults,
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

test.beforeEach(async ({ request }) => {
  await resetTestServer(request);
});

test.afterEach(async ({ request }) => {
  await resetTestServer(request);
});

test.describe('Controller', () => {
  test('connecting screen', async ({ page, request }) => {
    const displayPage = page;
    const { roomCode } = await createRoom(displayPage);

    await delayNextJoin(request, 1500);

    const controller = await displayPage.context().newPage();
    await controller.goto(`/${roomCode}`);
    await waitForFont(controller);
    await controller.fill('#name-input', 'Player 1');
    await controller.click('#name-join-btn');
    await controller.waitForFunction(() => {
      return document.getElementById('name-form').classList.contains('hidden')
        && document.getElementById('status-text').textContent === 'Connecting...';
    });
    await expect(controller).toHaveScreenshot('controller-connecting.png');
    await controller.waitForSelector('#player-identity:not(.hidden)');
  });

  test('lobby - host view', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    await host.waitForFunction(() => document.getElementById('start-btn').textContent.includes('2 players'));
    await expect(host).toHaveScreenshot('controller-lobby-host.png');
  });

  test('lobby - non-host view', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const nonHost = controllers[1];
    await nonHost.waitForFunction(() => document.getElementById('status-text').textContent.includes('Waiting for host'));
    await expect(nonHost).toHaveScreenshot('controller-lobby-nonhost.png');
  });

  test('game screen - host', async ({ page, context, request }) => {
    const { roomCode, controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    await applyScenario(request, roomCode, 'game');
    await waitForControllerGame(host);
    await expect(host).toHaveScreenshot('controller-game-host.png');
  });

  test('game screen - non-host', async ({ page, context, request }) => {
    const { roomCode, controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const nonHost = controllers[1];
    await applyScenario(request, roomCode, 'game');
    await waitForControllerGame(nonHost);
    await expect(nonHost).toHaveScreenshot('controller-game-nonhost.png');
  });

  test('game screen - paused (host)', async ({ page, context, request }) => {
    const { roomCode, controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    await applyScenario(request, roomCode, 'pause');
    await host.waitForSelector('#pause-overlay:not(.hidden)');
    await host.waitForTimeout(150);
    await expect(host).toHaveScreenshot('controller-pause-host.png');
  });

  test('game screen - paused (non-host)', async ({ page, context, request }) => {
    const { roomCode, controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const nonHost = controllers[1];
    await applyScenario(request, roomCode, 'pause');
    await nonHost.waitForSelector('#pause-overlay:not(.hidden)');
    await nonHost.waitForTimeout(150);
    await expect(nonHost).toHaveScreenshot('controller-pause-nonhost.png');
  });

  test('game screen - KO', async ({ page, context, request }) => {
    const { roomCode, controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const knockedOut = controllers[1];
    await applyScenario(request, roomCode, 'ko', { deadPlayerId: 2 });
    await knockedOut.waitForFunction(() => document.getElementById('game-screen').classList.contains('dead'));
    await knockedOut.waitForSelector('#ko-overlay');
    await expect(knockedOut).toHaveScreenshot('controller-ko.png');
  });

  test('results - host view', async ({ page, context, request }) => {
    const { roomCode, controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2', 'Player 3', 'Player 4']);
    const host = controllers[0];
    await applyScenario(request, roomCode, 'results');
    await waitForControllerResults(host);
    await expect(host).toHaveScreenshot('controller-results-host.png');
  });

  test('results - non-host view', async ({ page, context, request }) => {
    const { roomCode, controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2', 'Player 3', 'Player 4']);
    const nonHost = controllers[1];
    await applyScenario(request, roomCode, 'results');
    await waitForControllerResults(nonHost);
    await expect(nonHost).toHaveScreenshot('controller-results-nonhost.png');
  });

  test('error - room not found', async ({ page }) => {
    await page.goto('/ZZZZ');
    await waitForFont(page);
    await page.fill('#name-input', 'Player 1');
    await page.click('#name-join-btn');
    await page.waitForFunction(() => {
      return document.getElementById('status-text').textContent === 'Game Over'
        && document.getElementById('status-detail').textContent === 'Room not found.';
    });
    await expect(page).toHaveScreenshot('controller-error-room-notfound.png');
  });

  test('error - host disconnected', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    const nonHost = controllers[1];
    await host.click('#disconnect-btn');
    await nonHost.waitForFunction(() => {
      return document.getElementById('status-text').textContent === 'Game Cancelled'
        && document.getElementById('status-detail').textContent === 'Host disconnected.'
        && !document.getElementById('rejoin-btn').classList.contains('hidden');
    });
    await expect(nonHost).toHaveScreenshot('controller-error-host-disconnected.png');
  });

  test('error - room reset', async ({ page, context, request }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1']);
    const controller = controllers[0];
    await resetTestServer(request);
    await controller.waitForFunction(() => {
      return document.getElementById('status-text').textContent === 'Game Over'
        && document.getElementById('status-detail').textContent === '';
    });
    await expect(controller).toHaveScreenshot('controller-error-room-reset.png');
  });

  test('error - reconnection failed', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await context.newPage();
    await controller.addInitScript(([key, value]) => {
      sessionStorage.setItem(key, value);
    }, [`reconnectToken_${roomCode}`, 'invalid-token']);
    await controller.goto(`/${roomCode}`);
    await waitForFont(controller);
    await controller.waitForFunction(() => {
      return document.getElementById('status-text').textContent === 'Error'
        && document.getElementById('status-detail').textContent === 'Reconnection failed'
        && !document.getElementById('rejoin-btn').classList.contains('hidden');
    });
    await expect(controller).toHaveScreenshot('controller-error-reconnection-failed.png');
  });
});
