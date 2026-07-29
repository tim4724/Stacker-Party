// @ts-check
const { test, expect } = require('@playwright/test');
const {
  createRoom,
  joinController,
  waitForControllerGame,
  waitForControllerResults,
  waitForDisplayGame,
  waitForDisplayPlayers,
} = require('./helpers');

/**
 * The retained room snapshot is the controller's single source of truth: the
 * display publishes one object via party.setState() and the controller derives
 * its whole UI from it, screen routing included. These tests pin the three
 * properties that make that claim real — nothing else carries room state over
 * the wire, the +/- level and colour controls are throttled so a mashed
 * finger can't turn into a message storm, and the local state those two
 * controls own reconciles against the snapshot without losing a tap to an
 * echo the throttle has left stale.
 */

// Room-state message types the snapshot replaced (values from
// public/shared/protocol.js). If any of these appears on the wire again, the
// snapshot has stopped being the only source and the two paths can drift.
const RETIRED_TYPES = [
  'welcome',
  'lobby_update',
  'game_start',
  'countdown',
  'game_end',
  'game_over',
  'game_paused',
  'game_resumed',
  'return_to_lobby',
  'display_muted',
];

/** Record every message type the display puts on the wire, plus every publish. */
async function instrumentDisplay(page) {
  await page.evaluate(() => {
    window.__sentTypes = [];
    window.__publishes = [];
    const broadcast = party.broadcast.bind(party);
    const sendTo = party.sendTo.bind(party);
    const setState = party.setState.bind(party);
    party.broadcast = function (msg) {
      window.__sentTypes.push(msg && msg.type);
      return broadcast(msg);
    };
    party.sendTo = function (to, msg) {
      window.__sentTypes.push(msg && msg.type);
      return sendTo(to, msg);
    };
    party.setState = function (snap) {
      window.__publishes.push(snap);
      return setState(snap);
    };
  });
}

/**
 * A lobby snapshot for this controller carrying `level`, shaped like
 * RoomCore.snapshot(), including the omit-at-default encoding, which is what
 * makes level 1 indistinguishable from an absent field on the wire.
 */
async function lobbySnapshot(controller, level) {
  return controller.evaluate((lvl) => {
    const row = { name: playerName, color: playerColorIndex || 0 };
    if (lvl !== 1) row.startLevel = lvl;
    return {
      roomState: 'lobby',
      hostPeerIndex: peerIndex,
      paused: false,
      displayMuted: false,
      participants: [],
      players: { [peerIndex]: row },
    };
  }, level);
}

/** Crank the host's start level so a solo game tops out within seconds. */
async function setMaxStartLevel(controller) {
  await controller.evaluate(() => {
    const plus = document.getElementById('level-plus-btn');
    for (let i = 0; i < 14; i++) plus.click();
  });
  await expect(controller.locator('#level-display')).toHaveText('15');
}

test.describe('Room snapshot as the single source of truth', () => {
  test.setTimeout(90000);

  test('a full lobby → game → results → lobby cycle sends no room-state messages', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    await setMaxStartLevel(controller);

    await instrumentDisplay(page);

    // Lobby -> countdown -> playing. The controller reaches the game screen
    // and gets its touch pad armed with no GAME_START and no COUNTDOWN ticks:
    // both come from snapshot.roomState now.
    await controller.click('#start-btn');
    await waitForDisplayGame(page);
    await waitForControllerGame(controller);

    // Pause and resume: still snapshot-driven, no GAME_PAUSED / GAME_RESUMED.
    await controller.click('#pause-btn');
    await expect(controller.locator('#pause-overlay')).toBeVisible();
    await controller.click('#pause-continue-btn');
    await expect(controller.locator('#pause-overlay')).toBeHidden();

    // Display-side mute: the host's Game Music toggle mirrors it out of the
    // snapshot instead of a DISPLAY_MUTED broadcast.
    await page.evaluate(() => setDisplayMuted(true));
    await controller.waitForFunction(() => displayMuteIntent === true);

    // Level 15 tops the solo player out; results reach the controller with no
    // GAME_END of its own, and New Game takes it back to the lobby with no
    // RETURN_TO_LOBBY.
    await waitForControllerResults(controller);
    await controller.click('#new-game-btn');
    await expect(controller.locator('#lobby-screen')).toBeVisible();

    const sent = await page.evaluate(() => window.__sentTypes);
    const retired = sent.filter((t) => RETIRED_TYPES.includes(t));
    expect(retired, `display still sends retired room-state messages: ${retired.join(', ')}`).toEqual([]);
    // Sanity: the instrumentation was live — per-player telemetry and the
    // self-heartbeat still flow, so an empty log would mean a broken test.
    expect(sent.length).toBeGreaterThan(0);
  });

  test('rapid +/- level taps collapse into a throttled publish carrying the final level', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    await instrumentDisplay(page);
    // Let the join's own publish age out of the throttle window, so the burst
    // below starts on a leading edge rather than inheriting a pending trailing
    // timer — otherwise "2 publishes" and "1 publish" are both correct and the
    // assertion below would be flaky rather than meaningful.
    await page.waitForTimeout(600);

    // Eight taps as fast as the page will dispatch them.
    await controller.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 8; i++) plus.click();
    });
    // The controller's own readout is optimistic — it never waits for the echo.
    await expect(controller.locator('#level-display')).toHaveText('9');

    // Let the trailing publish fire (500ms window) plus slack.
    await page.waitForTimeout(900);

    const levels = await page.evaluate(() => window.__publishes.map((s) => {
      const ids = Object.keys(s.players);
      return ids.length ? s.players[ids[0]].startLevel : null;
    }));
    // Leading edge + one trailing publish. Anything near 8 means the throttle
    // is gone; 1 would mean the trailing publish never fired.
    expect(levels.length, `publishes: ${levels.join(',')}`).toBeGreaterThanOrEqual(2);
    expect(levels.length, `publishes: ${levels.join(',')}`).toBeLessThanOrEqual(4);
    // Latest wins: whatever the intermediate publishes said, the last one
    // carries the level the player actually settled on.
    expect(levels[levels.length - 1]).toBe(9);

    // ...and the display's own roster card agrees.
    await expect(page.locator('#player-list .player-card:not(.empty)').first()).toContainText('9');
  });

  test('a stale level echo never reverts an unacked tap, and the snapshot wins again once acked', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    await expect(controller.locator('#level-display')).toHaveText('1');

    // The leading-edge echo as it would land after a second tap: it describes
    // level 2, already stale, and the throttle holds the truth back for up to
    // 500ms more. Adopting it reverts the readout under the finger AND makes
    // the next tap count from 2, silently losing a step.
    const stale = await lobbySnapshot(controller, 2);

    // Tap, tap, and deliver the stale echo in ONE synchronous block. A real
    // network stages this whenever RTT outruns the tap interval, but localhost
    // is far too fast, and the live display keeps republishing the truth, so
    // any awaited assertion here just races a real snapshot into passing.
    // Single-threaded page, no awaits: nothing can be processed in between.
    const readouts = await controller.evaluate((snap) => {
      const plus = document.getElementById('level-plus-btn');
      const readout = () => document.getElementById('level-display').textContent;
      plus.click();
      plus.click();
      const optimistic = readout();
      onState(snap);
      return { optimistic, afterStale: readout() };
    }, stale);
    expect(readouts.optimistic).toBe('3');
    expect(readouts.afterStale).toBe('3');

    // Let the real trailing publish land and ack the tap for real.
    await expect(controller.locator('#level-display')).toHaveText('3');
    await page.waitForTimeout(700);

    // Acked, so the snapshot is authoritative again: a level the controller
    // never asked for IS adopted. The pending tap defers to the display, it
    // never overrides it. Level 1 also covers the omitted-at-default encoding,
    // which the ack has to survive when the stepper walks back down.
    const afterReset = await controller.evaluate((snap) => {
      onState(snap);
      return document.getElementById('level-display').textContent;
    }, await lobbySnapshot(controller, 1));
    expect(afterReset).toBe('1');
  });

  test('a colour pick closes the picker on the leading-edge publish, not the trailing one', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);

    await controller.click('#identity-trigger');
    // The rose is deliberately inert for 350ms after opening (anti-misclick,
    // see #color-picker-overlay:not(.hidden) in controller.css). Waiting it out
    // also puts the throttle window past the join's publish, so the pick lands
    // on a leading edge — which is the thing under test.
    await controller.waitForTimeout(600);

    const before = await controller.evaluate(() => playerColorIndex);
    const started = Date.now();
    await controller.click('#color-picker .rose-cell--center');
    // The picker closes when the display echoes the accepted colour back in the
    // snapshot. On the leading edge that is one relay round trip; if the pick
    // ever fell onto the trailing edge it would sit here for ~500ms. Asserted
    // on the class, not visibility: the overlay stays in the layout tree at
    // opacity 0 so it can fade out.
    await controller.waitForFunction(
      () => document.getElementById('color-picker-overlay').classList.contains('hidden'),
      null,
      { timeout: 2000 }
    );
    const elapsed = Date.now() - started;

    expect(await controller.evaluate(() => playerColorIndex)).not.toBe(before);
    expect(elapsed, 'colour pick echoed on the throttle trailing edge').toBeLessThan(450);
  });

  test('a rejected colour pick retires the pending flag instead of outliving the overlay', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const controller = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);

    // Tap a free cell, then deliver the winner's snapshot, in ONE synchronous
    // block. The collision only exists in the window before that snapshot
    // lands, and the display answers a rejected SET_COLOR with silence
    // (publish: 'none'), so there is nothing of its own to wait for. The real
    // display accepts this pick a round trip later, which is why every
    // assertion reads state captured inside the block.
    const state = await controller.evaluate((base) => {
      openColorPicker();
      const free = colorPickerEl.querySelector('.rose-cell:not(.taken)');
      const idx = parseInt(free.dataset.idx, 10);
      free.click();
      const afterTap = pendingColorPick;
      // Another player claimed the same slot a moment earlier: their pick was
      // accepted and published, ours was dropped on the floor.
      base.players[99] = { name: 'Bob', color: idx };
      onState(base);
      return {
        idx,
        afterTap,
        afterEcho: pendingColorPick,
        stillOpen: !colorPickerOverlay.classList.contains('hidden'),
      };
    }, await lobbySnapshot(controller, 1));

    expect(state.afterTap, 'the tap should arm pendingColorPick').toBe(state.idx);
    expect(state.afterEcho, 'a rejected pick must not stay pending').toBeNull();
    // Deliberate: the user picks again from the still-open rose, which now
    // paints that cell as taken.
    expect(state.stillOpen).toBe(true);
  });

  test('a late joiner is routed by the snapshot: lobby banner while playing, results when the round ends', async ({ page, context }) => {
    const { roomCode } = await createRoom(page);
    const alice = await joinController(context, roomCode, 'Alice');
    await waitForDisplayPlayers(page, 1);
    await setMaxStartLevel(alice);
    await alice.click('#start-btn');
    await waitForDisplayGame(page);

    const bob = await context.newPage();
    await bob.addInitScript((rc) => localStorage.removeItem('clientId_' + rc), roomCode);
    await bob.goto(`/${roomCode}?test=1`);
    await bob.fill('#name-input', 'Bob');
    await bob.click('#name-join-btn');

    // Absent from snapshot.participants -> lobby with the in-progress banner.
    await expect(bob.locator('#lobby-screen')).toBeVisible();
    await expect(bob.locator('#waiting-action-text')).toBeVisible();
    await expect(bob.locator('#start-btn')).toBeHidden();
    expect(await bob.evaluate(() => waitingForNextGame)).toBe(true);

    // Round ends: roomState flips to results and Bob follows, even though a
    // late joiner is never sent any per-player game traffic.
    await expect(bob.locator('#gameover-screen')).toBeVisible({ timeout: 60000 });
    expect(await bob.evaluate(() => waitingForNextGame)).toBe(false);
  });
});
