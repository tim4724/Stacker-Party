// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  joinController,
  stabilizeControllerUI,
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
    await stabilizeControllerUI(controller);
    await expect(controller).toHaveScreenshot('01a-name-entry.png');
  });

  test('name entry - keyboard open', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await context.newPage();
    await controller.goto(`/${roomCode}`);
    await waitForFont(controller);
    await controller.fill('#name-input', 'Player 1');
    await controller.focus('#name-input');
    // Simulate reduced viewport height when soft keyboard is open
    await controller.evaluate(() => {
      document.documentElement.style.setProperty('--app-height', '544px');
    });
    await stabilizeControllerUI(controller);
    await expect(controller).toHaveScreenshot('01b-name-keyboard.png');
  });

  test('lobby view', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const player = controllers[0];
    await player.waitForFunction(() => document.getElementById('start-btn').textContent.includes('2 players'));
    await stabilizeControllerUI(player);
    await expect(player).toHaveScreenshot('03-lobby.png');
  });

  test('lobby - late joiner waiting', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1']);
    const player1 = controllers[0];
    // Start the game
    await player1.click('#start-btn');
    await waitForControllerGame(player1);
    // Late joiner connects mid-game
    const { roomCode } = await page.evaluate(() => ({ roomCode }));
    const lateJoiner = await joinController(context, roomCode, 'Late Joiner');
    await lateJoiner.waitForFunction(() =>
      document.getElementById('waiting-action-text').textContent.includes('Game in progress')
    );
    await stabilizeControllerUI(lateJoiner);
    await expect(lateJoiner).toHaveScreenshot('03b-lobby-late-joiner.png');
  });

  test('game screen - all player colors', async ({ page, context }) => {
    const names = ['Red', 'Teal', 'Yellow', 'Purple', 'Green', 'Magenta', 'Indigo', 'Coral'];
    const { controllers } = await setupJoinedRoom(page, context, names);
    const host = controllers[0];
    await host.click('#start-btn');
    for (let i = 0; i < controllers.length; i++) {
      await waitForControllerGame(controllers[i]);
      // Hide ping display for consistent screenshots
      await controllers[i].evaluate(() => {
        var ping = document.getElementById('ping-display');
        if (ping) ping.style.display = 'none';
      });
    }
    for (let i = 0; i < controllers.length; i++) {
      await expect(controllers[i]).toHaveScreenshot('06b-game-color-' + (i + 1) + '-' + names[i].toLowerCase() + '.png');
    }
  });

  test('game screen - KO state', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(host);
    await host.evaluate(() => {
      // Disconnect so server updates don't clear the injected KO state
      if (typeof party !== 'undefined' && party) party.close();
      var ping = document.getElementById('ping-display');
      if (ping) ping.style.display = 'none';
      // Hide reconnect overlay triggered by disconnect
      var ro = document.getElementById('reconnect-overlay');
      if (ro) ro.classList.add('hidden');
      document.getElementById('game-screen').classList.add('dead');
      var ko = document.createElement('div');
      ko.id = 'ko-overlay';
      ko.textContent = 'KO';
      document.getElementById('touch-area').appendChild(ko);
    });
    await host.waitForTimeout(150);
    await expect(host).toHaveScreenshot('06c-game-ko.png');
  });

  test('game screen - KO state after reconnect', async ({ page, context }) => {
    test.setTimeout(60000);
    const { roomCode, controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2', 'Player 3']);
    const host = controllers[0];
    const player2 = controllers[1];
    await host.click('#start-btn');
    await waitForControllerGame(player2);
    // Wait for display countdown to finish so hard drops are accepted
    await page.waitForFunction(() => {
      return typeof displayGame !== 'undefined' && displayGame !== null
        && document.getElementById('countdown-overlay').classList.contains('hidden');
    }, null, { timeout: 15000 });
    // Hard drop only player 2 until KO (game continues with 3 players)
    const dropInterval = setInterval(async () => {
      try {
        await page.evaluate(() => {
          if (displayGame && typeof displayGame.processInput === 'function') {
            var ids = Array.from(playerOrder || []);
            if (ids.length >= 2) {
              displayGame.processInput(ids[1], 'hard_drop');
              // Ensure game physics tick runs (RAF may be throttled in background tab)
              displayGame.update(16);
            }
          }
        });
      } catch (_) {}
    }, 100);
    try {
      await player2.waitForFunction(() => document.getElementById('game-screen').classList.contains('dead'), null, { timeout: 30000 });
    } finally {
      clearInterval(dropInterval);
    }
    // Reload the KO'd player's controller (auto-reconnects via sessionStorage)
    await player2.goto(`/${roomCode}`);
    // Should restore KO state after reconnect
    await player2.waitForFunction(() => document.getElementById('game-screen').classList.contains('dead'), null, { timeout: 10000 });
    await player2.evaluate(() => {
      var ping = document.getElementById('ping-display');
      if (ping) ping.style.display = 'none';
    });
    await player2.waitForTimeout(150);
    await expect(player2).toHaveScreenshot('06d-game-ko-reconnect.png');
  });

  test('game screen - paused', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const player = controllers[0];
    await player.click('#start-btn');
    await waitForControllerGame(player);
    await player.click('#pause-btn');
    await player.waitForSelector('#pause-overlay:not(.hidden)');
    await player.waitForTimeout(150);
    await expect(player).toHaveScreenshot('07-pause.png');
  });

  test('results - 1 player', async ({ page, context }) => {
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
    try {
      await waitForControllerResults(host);
    } finally {
      clearInterval(dropInterval);
    }
    await expect(host).toHaveScreenshot('10a-results-1p.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('results - winner (rank 1)', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(host);
    // Hard drop only player 2 to make them lose first
    const dropInterval = setInterval(async () => {
      try {
        await page.evaluate(() => {
          if (displayGame && typeof displayGame.processInput === 'function') {
            var ids = Array.from(playerOrder || []);
            if (ids.length >= 2) displayGame.processInput(ids[1], 'hard_drop');
          }
        });
      } catch (_) {}
    }, 100);
    try {
      await waitForControllerResults(host);
    } finally {
      clearInterval(dropInterval);
    }
    await expect(host).toHaveScreenshot('10b-results-winner.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('results - loser (rank 2)', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1', 'Player 2']);
    const host = controllers[0];
    const loser = controllers[1];
    await host.click('#start-btn');
    await waitForControllerGame(loser);
    // Hard drop only player 2 to make them lose first
    const dropInterval = setInterval(async () => {
      try {
        await page.evaluate(() => {
          if (displayGame && typeof displayGame.processInput === 'function') {
            var ids = Array.from(playerOrder || []);
            if (ids.length >= 2) displayGame.processInput(ids[1], 'hard_drop');
          }
        });
      } catch (_) {}
    }, 100);
    try {
      await waitForControllerResults(loser);
    } finally {
      clearInterval(dropInterval);
    }
    await expect(loser).toHaveScreenshot('10c-results-loser.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('reconnect overlay - attempt', async ({ page, context }) => {
    const { controllers } = await setupJoinedRoom(page, context, ['Player 1']);
    const host = controllers[0];
    await host.click('#start-btn');
    await waitForControllerGame(host);
    await host.evaluate(() => {
      var overlay = document.getElementById('reconnect-overlay');
      overlay.classList.remove('hidden');
      // Prevent pong messages from re-hiding the overlay
      overlay.classList.add = function() {};
      overlay.style.animation = 'none';
      overlay.style.opacity = '1';
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
      var overlay = document.getElementById('reconnect-overlay');
      overlay.classList.remove('hidden');
      // Prevent pong messages from re-hiding the overlay
      overlay.classList.add = function() {};
      overlay.style.animation = 'none';
      overlay.style.opacity = '1';
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
      var overlay = document.getElementById('reconnect-overlay');
      overlay.classList.remove('hidden');
      // Prevent pong messages from re-hiding the overlay
      overlay.classList.add = function() {};
      overlay.style.animation = 'none';
      overlay.style.opacity = '1';
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
    await stabilizeControllerUI(page);
    await expect(page).toHaveScreenshot('12-error-room-notfound.png');
  });

});
