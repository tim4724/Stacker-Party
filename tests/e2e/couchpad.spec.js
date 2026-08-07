// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  waitForControllerGame,
  waitForControllerResults,
  waitForDisplayGame,
  waitForDisplayPlayers,
  waitForFont,
} = require('./helpers');

/**
 * CouchPad Controller Contract (?cpName is the shell gate) against a stubbed launcher
 * bridge: the join URL injects the player name, the shell drives live
 * renames via window.CouchPad.setName(), and terminal session ends
 * surface through window.CouchPadHost.gameEnded(reason) instead of a
 * navigation to the display root.
 */

async function joinCouchPadController(context, roomCode, name) {
  const page = await context.newPage();
  await page.addInitScript((rc) => {
    localStorage.removeItem('clientId_' + rc);
    window.__cpEnded = [];
    window.__cpBack = [];
    window.CouchPadHost = {
      gameEnded: (reason) => window.__cpEnded.push(reason),
      enableSystemBack: (on) => window.__cpBack.push(on),
    };
  }, roomCode);
  await page.goto(`/${roomCode}?test=1&cpName=${encodeURIComponent(name)}`);
  await waitForFont(page);
  return page;
}

// Fabricate the relay's answer for a room that must not exist, so the test
// doesn't depend on production-relay state for the negative path.
async function fakeRoomNotFound(page) {
  await page.routeWebSocket(/ws\.hexstacker\.com/, (ws) => {
    ws.onMessage(() => {
      ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    });
  });
}

test.describe('CouchPad shell contract', () => {
  test('join with cpName, live rename, and display close → gameEnded', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchPadController(context, roomCode, 'Zoë');

    // Name screen skipped: the injected name lands in the lobby directly.
    await controller.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });
    await expect(controller.locator('#player-identity-name')).toHaveText('Zoë');
    await expect(controller.locator('#name-screen')).toBeHidden();
    await expect(controller.locator('#lobby-back-btn')).toBeHidden();
    await waitForDisplayPlayers(page, 1);
    await expect(page.locator('#player-list')).toContainText('Zoë');

    // The launcher is the identity authority — the injected name must not be
    // persisted as the user's own typed name.
    expect(await controller.evaluate(() => localStorage.getItem('stacker_player_name'))).toBeNull();

    // History stays untouched (pushState neutralized), so the settings
    // modal's Done button must close it directly instead of via history.back.
    expect(await controller.evaluate(() => history.state)).toBeNull();
    await controller.click('#lobby-settings-btn');
    await expect(controller.locator('#settings-overlay')).toBeVisible();
    await controller.click('#settings-close');
    await expect(controller.locator('#settings-overlay')).toBeHidden();

    // Live rename from the shell propagates to controller UI and display.
    await controller.evaluate(() => window.CouchPad.setName('Maxi'));
    await expect(controller.locator('#player-identity-name')).toHaveText('Maxi');
    await expect(page.locator('#player-list')).toContainText('Maxi');

    // Display navigating away tears the room down (close_room): the 4001
    // close is the controller's terminal end and goes to the launcher
    // bridge, with no navigation off the controller page.
    await page.goto('about:blank');
    await controller.waitForFunction(() => window.__cpEnded.length > 0, null, { timeout: 10000 });
    expect(await controller.evaluate(() => window.__cpEnded)).toEqual(['game_ended']);
    expect(controller.url()).toContain(`/${roomCode}`);
  });

  test('system back arms per screen and consumes dialog dismissals (CONTRACT §9)', async ({ page, context }) => {
    test.setTimeout(90000);
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchPadController(context, roomCode, 'Nils');
    await controller.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });

    const armed = () => controller.evaluate(() => window.__cpBack[window.__cpBack.length - 1]);
    const back = () => controller.evaluate(() => window.CouchPad.back());

    // Lobby: armed with nothing to close, so the gesture falls through to the
    // launcher and leaves the game, the same exit as the LEAVE bar.
    await expect.poll(armed).toBe(true);
    expect(await back()).toBe(false);

    // Dialogs answer the gesture themselves and the player stays in the room.
    await controller.click('#lobby-settings-btn');
    await expect(controller.locator('#settings-overlay')).toBeVisible();
    expect(await back()).toBe(true);
    await expect(controller.locator('#settings-overlay')).toBeHidden();

    // The colour picker fades out rather than unmounting (it keeps
    // `display: flex` while hidden), so its class is what "closed" means.
    await controller.click('#identity-trigger');
    await controller.waitForSelector('#color-picker-overlay:not(.hidden)');
    expect(await back()).toBe(true);
    await controller.waitForSelector('#color-picker-overlay.hidden');

    // Live game: disarmed, so the screen edges stay drag input. Level 15 tops
    // the solo player out quickly, which carries us to the results screen.
    await controller.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await expect(controller.locator('#level-display')).toHaveText('15');
    await controller.click('#start-btn');
    await waitForDisplayGame(page);
    await waitForControllerGame(controller);
    await expect.poll(armed).toBe(false);

    // Pause overlay: armed again, and back resumes the game like Continue.
    await controller.click('#pause-btn');
    await expect(controller.locator('#pause-overlay')).toBeVisible();
    await expect.poll(armed).toBe(true);
    expect(await back()).toBe(true);
    await expect(controller.locator('#pause-overlay')).toBeHidden();
    await expect.poll(armed).toBe(false);

    // Results: armed with nothing to close, like the lobby.
    await waitForControllerResults(controller);
    await expect.poll(armed).toBe(true);
    expect(await back()).toBe(false);

    // Arming costs the game its screen edges, so the launcher hears about it
    // only when the state actually flips, not on every snapshot that repaints
    // a screen. Consecutive duplicates would mean the sync is chattering.
    const calls = await controller.evaluate(() => window.__cpBack);
    expect(calls.filter((on, i) => i > 0 && on === calls[i - 1])).toEqual([]);
  });

  test('cp-accent-color meta tracks the player color (CONTRACT §4)', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchPadController(context, roomCode, 'Iris');
    await controller.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });

    const accentMeta = () => controller.evaluate(() =>
      document.querySelector('meta[name="cp-accent-color"]').getAttribute('content'));
    // The meta and the body's --player-color read from the same PLAYER_COLORS
    // entry, so a confirmed color always leaves them exactly equal.
    const metaMatchesPlayerColor = () => controller.evaluate(() => {
      const meta = document.querySelector('meta[name="cp-accent-color"]').getAttribute('content');
      const playerColor = getComputedStyle(document.body).getPropertyValue('--player-color').trim();
      return !!playerColor && meta === playerColor;
    });

    // After WELCOME assigns a color, the accent hint reflects it.
    await expect.poll(metaMatchesPlayerColor).toBe(true);
    const before = await accentMeta();

    // Picking a different swatch round-trips through the display (SET_COLOR →
    // LOBBY_UPDATE) and the meta follows the new color.
    await controller.click('#identity-trigger');
    await controller.waitForSelector('#color-picker-overlay:not(.hidden)');
    await controller.click('.rose-cell--center');

    await expect.poll(accentMeta).not.toBe(before);
    await expect.poll(metaMatchesPlayerColor).toBe(true);
  });

  test('safe zone honors the launcher --cp-safe-* vars (CONTRACT §5)', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchPadController(context, roomCode, 'Uma');
    await controller.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });

    // The lobby's top chrome (#lobby-top-bar) folds the authoritative launcher
    // vars with env() safe-area: max(var(--safe-top), 12px). Headless has no
    // notch, so with no launcher vars set it rests on the 12px floor.
    const barPadTop = () => controller.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('#lobby-top-bar')).paddingTop));
    expect(await barPadTop()).toBeLessThan(60);

    // The launcher publishes the safe zone on documentElement; the controller
    // chrome must expand to clear it (covers the split-screen case where the
    // synthetic display cutout bails and only the vars carry the extent).
    await controller.evaluate(() =>
      document.documentElement.style.setProperty('--cp-safe-top', '60px'));
    await expect.poll(barPadTop).toBeGreaterThanOrEqual(60);

    // Same for the horizontal edges: launcher chrome can float on the right
    // (e.g. a vertical LEAVE bar), so the bar's right padding must expand to
    // clear it rather than resting on the 12px floor. The lobby bar's flush-
    // right settings button is the reachable case here; the same idiom guards
    // the game bar's pause icon (both pushed right via margin-left:auto).
    const barPadRight = () => controller.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('#lobby-top-bar')).paddingRight));
    expect(await barPadRight()).toBeLessThan(60);
    await controller.evaluate(() =>
      document.documentElement.style.setProperty('--cp-safe-right', '60px'));
    await expect.poll(barPadRight).toBeGreaterThanOrEqual(60);

    // The bottom edge is the exception: arming system back brings Android's
    // navigation bar back and disarming takes it away again, so the shell
    // reserves the bar's height rather than reflowing under it. The general
    // floor is the gesture pill. Elements are un-hidden before measuring
    // because a display:none subtree reports max() unresolved.
    const padBottom = (sel) => controller.evaluate((s) =>
      parseFloat(getComputedStyle(document.querySelector(s)).paddingBottom), sel);
    const setInset = (v) => controller.evaluate((b) =>
      document.documentElement.style.setProperty('--cp-safe-bottom', b), v);
    await controller.evaluate(() => ['game-screen', 'pause-overlay']
      .forEach((id) => document.getElementById(id).classList.remove('hidden')));

    await setInset('0px');
    const shellAtRest = await padBottom('#lobby-screen');
    const gameAtRest = await padBottom('#game-screen');
    await setInset('24px');
    expect(await padBottom('#lobby-screen'), 'shell moved under the pill').toBe(shellAtRest);
    expect(await padBottom('#game-screen'), 'game moved under the pill').toBe(gameAtRest);
    // Past the pill they expand: the shell is armed for its whole life, so its
    // inset never changes while it is on screen and needs no deeper reserve.
    await setInset('48px');
    expect(await padBottom('#lobby-screen')).toBeGreaterThan(shellAtRest);
    expect(await padBottom('#game-screen')).toBeGreaterThan(gameAtRest);

    // The pause overlay is one of the two surfaces on screen at the moment the
    // arm state flips, so it reserves the taller three-button bar and holds
    // still across the whole range a flip can cover.
    await setInset('0px');
    const pauseAtRest = await padBottom('#pause-overlay');
    for (const inset of ['24px', '48px']) {
      await setInset(inset);
      expect(await padBottom('#pause-overlay'), `pause moved at ${inset}`).toBe(pauseAtRest);
    }
  });

  test('in-game player name is hidden (the launcher renders it)', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinCouchPadController(context, roomCode, 'Ada');
    await controller.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });

    // The launcher owns the name in its own chrome, so both in-game surfaces
    // must stay blank: the portrait top-bar label and the landscape overlay.
    await controller.evaluate(() =>
      document.getElementById('touch-area').setAttribute('data-player-name', 'Ada'));

    // Portrait: the top-bar label is suppressed.
    await controller.setViewportSize({ width: 390, height: 780 });
    expect(await controller.evaluate(() =>
      getComputedStyle(document.getElementById('player-name')).display)).toBe('none');

    // Landscape: the center-top touch-area overlay has no rendered content.
    await controller.setViewportSize({ width: 780, height: 390 });
    expect(await controller.evaluate(() =>
      getComputedStyle(document.getElementById('touch-area'), '::after').content)).toBe('none');
  });

  test('unknown room surfaces room_not_found through gameEnded', async ({ context }) => {
    const controller = await context.newPage();
    await controller.addInitScript(() => {
      window.__cpEnded = [];
      window.CouchPadHost = {
        gameEnded: (reason) => window.__cpEnded.push(reason),
      };
    });
    await fakeRoomNotFound(controller);
    await controller.goto('/ZZZZ?test=1&cpName=Ada');
    await controller.waitForFunction(() => window.__cpEnded.length > 0, null, { timeout: 10000 });
    expect(await controller.evaluate(() => window.__cpEnded)).toEqual(['room_not_found']);
    expect(controller.url()).toContain('/ZZZZ');
  });

  test('without the host bridge, ?cpName falls back to the normal web bail', async ({ context }) => {
    const controller = await context.newPage();
    await fakeRoomNotFound(controller);
    await controller.goto('/ZZZZ?test=1&cpName=Ada');
    await controller.waitForURL(/\?bail=room_not_found/, { timeout: 10000 });
  });
});
