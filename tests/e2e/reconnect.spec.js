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

async function scanReconnectClaim(context, roomCode, claim) {
  const page = await context.newPage();
  await page.goto(`/${roomCode}?test=1&claim=${encodeURIComponent(claim)}`);
  await waitForFont(page);
  await page.waitForSelector('#game-screen:not(.hidden)', { timeout: 15000 });
  await page.waitForFunction(() => typeof waitingForNextGame !== 'undefined' && waitingForNextGame === false);
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
      return typeof pauseReason !== 'undefined' && pauseReason === 'auto';
    }, null, { timeout: 10000 });

    const isPaused = await page.evaluate(() => paused);
    expect(isPaused).toBe(true);

    await expect(page.locator('#pause-btn')).toBeEnabled();
    await expect(page.locator('#game-toolbar')).not.toHaveClass(/toolbar-autohide/);
    await page.click('#pause-btn');
    await expect(page.locator('#pause-overlay')).toBeVisible();
    await expect(page.locator('#pause-continue-btn')).toBeEnabled();
    await expect(page.locator('#pause-newgame-btn')).toBeVisible();

    // Raising it published nothing: an auto-pause is never actionable, and the
    // overlay is a pure view toggle here (tvOS/Android do the same off the remote's
    // pause key — see pauseKeyRaisesTheOverlayWhileAutoPausedWithoutTouchingTheFreeze).
    expect(await page.evaluate(() => pauseReason)).toBe('auto');

    await page.click('#pause-continue-btn');
    await expect(page.locator('#pause-overlay')).toBeHidden();
    await expect(page.locator('#game-toolbar')).toBeVisible();
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => pauseReason)).toBe('auto');
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(1);
  });

  test('manual pause then all players disconnect hides the stranded overlay', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);

    // Host manually pauses WHILE the player is still connected: overlay up,
    // manual (not auto) pause. Nudge the cursor first so the toolbar isn't
    // auto-hidden behind the game canvas.
    await page.mouse.move(10, 10);
    await page.click('#pause-btn');
    await expect(page.locator('#pause-overlay')).toBeVisible();
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => pauseReason)).not.toBe('auto');

    // Now the sole player disconnects. The manual pause must convert into a
    // silent auto-pause and the stranded overlay must hide again (Continue is
    // gated shut while everyone is gone, so it could otherwise never be
    // dismissed — the reported bug).
    await controller.close();

    await expect(page.locator('#pause-overlay')).toBeHidden();
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => pauseReason)).toBe('auto');
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(1);
  });

  test('single player: controller disconnecting during countdown shows disconnect overlay', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');

    // Wait until the display is mid-countdown, then drop the sole controller.
    // This lands the game in PLAYING already auto-paused (no live controllers).
    await page.waitForFunction(() => typeof roomState !== 'undefined' && roomState === ROOM_STATE.COUNTDOWN);
    await controller.close();

    // The game silently auto-pauses the instant PLAYING begins.
    await page.waitForFunction(() => {
      return typeof pauseReason !== 'undefined' && pauseReason === 'auto';
    }, null, { timeout: 10000 });

    // Regression: the render loop must still capture a snapshot so the boards
    // (and the disconnect QR overlay) render, instead of staying on the empty
    // pre-game boards because gameState was never populated.
    await page.waitForFunction(() => typeof gameState !== 'undefined' && gameState !== null, null, { timeout: 5000 });
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(1);
  });

  test('two players: both disconnecting during countdown shows disconnect overlays', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');

    await waitForDisplayPlayers(page, 2);
    await c1.click('#start-btn');

    // Drop BOTH controllers mid-countdown. Once every participant is gone (and
    // there are no late joiners), PLAYING begins already auto-paused: the same
    // all-disconnected path as single player, just needing two drops.
    await page.waitForFunction(() => typeof roomState !== 'undefined' && roomState === ROOM_STATE.COUNTDOWN);
    await Promise.all([c1.close(), c2.close()]);

    await page.waitForFunction(() => {
      return typeof pauseReason !== 'undefined' && pauseReason === 'auto';
    }, null, { timeout: 10000 });

    // Regression: gameState must be primed so both boards render their
    // disconnect QR overlays instead of empty pre-game boards.
    await page.waitForFunction(() => typeof gameState !== 'undefined' && gameState !== null, null, { timeout: 5000 });
    expect(await page.evaluate(() => paused)).toBe(true);
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(2);
  });

  test('display reconnect overlay shows when relay connection drops', async ({ page, context }) => {
    // Intercept the relay WebSocket so we can force-close it
    let serverWs;
    await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
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

  // A display-side relay blip must not strand the CONTROLLER on a pause overlay.
  // The display freezes while its link is down, but by the time it re-welcomes it
  // has resumed, so the WELCOME must report paused=false. Getting that ordering
  // wrong (resume AFTER the welcome loop) makes the WELCOME say paused=true and
  // chase it with a GAME_RESUMED; a controller that latches the first and misses
  // the second is stuck, because its Continue asks a display that is no longer
  // paused, whose resume path is gated on a MANUAL pause and so silently drops the
  // request — no GAME_RESUMED is ever sent and the overlay never clears.
  // Reported on tvOS from a live Wi-Fi drop; Android had the same ordering. The web
  // resumes before its welcome loop and is correct, but nothing guarded it.
  test('display relay blip mid-game does not strand the controller on a pause overlay', async ({ page, context }) => {
    const links = [];
    await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
      links.push(server);
    });

    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);
    await expect(controller.locator('#pause-overlay')).toBeHidden();

    // Sever the display's link; it reconnects on its own through the route.
    links[links.length - 1].close();
    await page.waitForSelector('#reconnect-overlay:not(.hidden)', { timeout: 15000 });
    await expect(page.locator('#reconnect-overlay')).toBeHidden({ timeout: 15000 });

    // Display is running again...
    await page.waitForFunction(() => paused === false, null, { timeout: 15000 });
    // ...so the controller must not be sitting behind a pause overlay it cannot
    // dismiss. Settle first: the WELCOME lands right after the rejoin.
    await controller.waitForTimeout(1500);
    await expect(controller.locator('#pause-overlay')).toBeHidden();
  });

  // Regression guard for the `joinedRoom` gate, covering the gap between the
  // display's socket re-OPENING and the relay answering `joined`. Until that
  // reply the relay routes nothing to us, so no controller can prove it is alive
  // and flagging them blames them for our outage. displayDead alone was not
  // cover: it needs SELF_HEARTBEAT_DEAD_MS (6s) of self-echo silence while a
  // controller expires after LIVENESS_TIMEOUT_MS (3s), so an outage flagged the
  // whole roster for the ~3s before the gate engaged, and the flag persisted
  // until the rejoin landed and each controller pinged again (measured: 3.8s of
  // wrong flagging at a 2s `joined` delay, 6.8s at 5s). It also fired
  // checkAllPlayersDisconnected, which auto-pauses and, with a late joiner
  // waiting, could grace-return a live match to the lobby.
  //
  // The other drop tests never reach this window because a healthy relay answers
  // in milliseconds; delaying `joined` opens it deterministically. Same contract
  // as tvOS roomLinkRestored and Android handleJoined.
  test('rejoin in flight: display keeps its roster and stays paused until joined lands', async ({ page, context }) => {
    const JOINED_DELAY_MS = 5000;   // > LIVENESS_TIMEOUT_MS so the sweep can bite
    let delayJoined = false;
    const links = [];
    await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => {
        let parsed;
        try { parsed = JSON.parse(msg); } catch { parsed = null; }
        if (delayJoined && parsed && parsed.type === 'joined') {
          setTimeout(() => ws.send(msg), JOINED_DELAY_MS);
          return;
        }
        ws.send(msg);
      });
      links.push(server);
    });

    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    await controller.click('#start-btn');
    await waitForDisplayGame(page);
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(0);

    // Sever the link; the reconnect's `joined` is withheld for JOINED_DELAY_MS.
    delayJoined = true;
    links[links.length - 1].close();
    await page.waitForSelector('#reconnect-overlay:not(.hidden)', { timeout: 15000 });

    // Mid-window: socket is back but we are not in the room yet. The controller
    // has been silent only because WE were unreachable, so it must not be
    // flagged, and the sim must stay frozen.
    await page.waitForTimeout(JOINED_DELAY_MS - 1000);
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(0);
    expect(await page.evaluate(() => paused)).toBe(true);

    // `joined` lands: roster reconciled, overlay clears, sim resumes.
    await expect(page.locator('#reconnect-overlay')).toBeHidden({ timeout: 15000 });
    await page.waitForFunction(() => paused === false, null, { timeout: 15000 });
    expect(await page.evaluate(() => disconnectedQRs.size)).toBe(0);
  });

  test('controller in lobby: display vanishing shows reconnect overlay then bails home', async ({ page, context }) => {
    // Bridge the display's relay WS once; refuse reconnect attempts so the
    // display stays gone (a crash or a backgrounded tvOS app): no room
    // teardown, only the relay's peer_left(0).
    let link = null;
    await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
      if (link) return;   // reconnect attempts never reach the relay
      const server = ws.connectToServer();
      link = { server };
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);

    // Shorten the display-gone grace so the bail is observable in test time.
    await controller.evaluate(() => { DISPLAY_GONE_BAIL_MS = 2000; });

    // Sever the display's relay link server-side while the controller sits
    // in the LOBBY.
    link.server.close();

    // The lobby reacts instead of silently hosting a ghost...
    await controller.waitForSelector('#reconnect-overlay:not(.hidden)', { timeout: 10000 });
    // ...and once the display stays gone, bails with the party-over reason
    // (the Couch Games shell maps this to returning home).
    await controller.waitForURL(/bail=game_ended/, { timeout: 10000 });
  });

  test('display navigating away tears the room down on the relay', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);

    // The room resolves while the party is live (this is what feeds the
    // Couch Games launcher's rejoin card).
    const probe = 'https://ws.hexstacker.com/room/' + encodeURIComponent(roomCode);
    expect((await fetch(probe)).status).toBe(200);

    // Display navigates away: pagehide sends close_room, so the relay drops
    // the room immediately (stale rejoin links die) instead of waiting for
    // every member socket to disconnect.
    await page.goto('about:blank');
    await expect.poll(async () => (await fetch(probe)).status, { timeout: 10000 }).toBe(404);

    // The controller ends at the party-over bail via its own 4001 "room
    // closed" close frame.
    // The bail may already have happened (and the welcome page strips its
    // ?bail= param on consuming the toast), so assert the settled URL.
    await expect.poll(() => new URL(controller.url()).pathname, { timeout: 10000 }).toBe('/');
  });

  test('controller in lobby survives a display relay blip without bailing', async ({ page, context }) => {
    // Same interception, but reconnect attempts ARE bridged: the display
    // comes back on its own (tvOS Home-and-back, relay blip) and re-welcomes.
    const links = [];
    await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
      links.push(server);
    });

    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);

    // Sever the current link; the display auto-reconnects through the route.
    // The controller's in-flight PING may bounce off the empty slot in the
    // gap; that must NOT bail it out of the room.
    links[links.length - 1].close();

    // Controller notices the absence...
    await controller.waitForSelector('#reconnect-overlay:not(.hidden)', { timeout: 10000 });
    // ...and the display's rejoin re-welcomes it: overlay clears, same room,
    // still in the lobby.
    await expect(controller.locator('#reconnect-overlay')).toBeHidden({ timeout: 15000 });
    expect(controller.url()).toContain(roomCode);
    await expect(controller.locator('#player-identity')).toBeVisible();
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

  test('host handoff: new host is promoted when original host disconnects mid-game', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');
    const c2 = await joinController(context, roomCode, 'Bob');

    await waitForDisplayPlayers(page, 2);

    // Sanity: Alice is host (lowest-slot controller), Bob is not.
    await c1.waitForFunction(() => typeof isHost !== 'undefined' && isHost === true, null, { timeout: 5000 });
    await c2.waitForFunction(() => typeof isHost !== 'undefined' && isHost === false, null, { timeout: 5000 });

    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    // Alice (host) drops out mid-game.
    const aliceId = await c1.evaluate(() => peerIndex);
    await c1.close();

    // Display should flag Alice as disconnected, and getHostPeerIndex() should
    // hand off to Bob (lowest-slot among connected playerOrder members).
    await page.waitForFunction((id) => {
      return typeof disconnectedQRs !== 'undefined'
          && disconnectedQRs.has(id)
          && typeof getHostPeerIndex === 'function'
          && getHostPeerIndex() !== id;
    }, aliceId, { timeout: 10000 });

    // Bob's controller should receive the LOBBY_UPDATE and flip isHost.
    await c2.waitForFunction(() => typeof isHost !== 'undefined' && isHost === true, null, { timeout: 5000 });
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

  test('same phone scanning reconnect QR keeps stored relay client id', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    const aliceId = await c1.evaluate(() => peerIndex);
    const storedClientId = await c1.evaluate((rc) => localStorage.getItem('clientId_' + rc), roomCode);
    await c1.close();

    await page.waitForFunction((id) => {
      return typeof disconnectedQRs !== 'undefined'
          && disconnectedQRs.has(id);
    }, aliceId, { timeout: 10000 });
    const claim = String(aliceId);

    const reconnected = await scanReconnectClaim(context, roomCode, claim);
    await reconnected.waitForFunction((expected) => peerIndex === expected, aliceId, { timeout: 5000 });
    const reconnectedClientId = await reconnected.evaluate(() => clientId);

    expect(reconnectedClientId).toBe(storedClientId);
    expect(await reconnected.evaluate(() => waitingForNextGame)).toBe(false);
    await page.waitForFunction((id) => {
      return typeof disconnectedQRs !== 'undefined' && !disconnectedQRs.has(id);
    }, aliceId, { timeout: 5000 });
  });

  test('different phone scanning reconnect QR claims disconnected player without old client id', async ({ page, context, browser }) => {
    const { roomCode } = await createRoom(page);
    const c1 = await joinController(context, roomCode, 'Alice');

    await waitForDisplayPlayers(page, 1);
    await c1.click('#start-btn');
    await waitForDisplayGame(page);

    const aliceId = await c1.evaluate(() => peerIndex);
    const oldClientId = await c1.evaluate(() => clientId);
    await c1.close();

    await page.waitForFunction((id) => {
      return typeof disconnectedQRs !== 'undefined'
          && disconnectedQRs.has(id);
    }, aliceId, { timeout: 10000 });
    const claim = String(aliceId);

    const freshContext = await browser.newContext();
    try {
      const replacement = await scanReconnectClaim(freshContext, roomCode, claim);
      const replacementId = await replacement.evaluate(() => peerIndex);
      const replacementClientId = await replacement.evaluate(() => clientId);

      expect(replacementId).not.toBe(aliceId);
      expect(replacementClientId).not.toBe(oldClientId);
      expect(await replacement.evaluate(() => playerName)).toBe('Alice');
      expect(await replacement.evaluate(() => waitingForNextGame)).toBe(false);

      await page.waitForFunction(({ oldId, newId }) => {
        return typeof disconnectedQRs !== 'undefined'
            && !disconnectedQRs.has(oldId)
            && typeof playerOrder !== 'undefined'
            && playerOrder.indexOf(oldId) < 0
            && playerOrder.indexOf(newId) >= 0
            && typeof displayGame !== 'undefined'
            && displayGame
            && displayGame.playerIds.indexOf(newId) >= 0
            && displayGame.playerIds.indexOf(oldId) < 0;
      }, { oldId: aliceId, newId: replacementId }, { timeout: 5000 });
    } finally {
      await freshContext.close();
    }
  });
});
