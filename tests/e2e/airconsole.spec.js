// @ts-check
const { test, expect, chromium, firefox, devices } = require('@playwright/test');
const path = require('path');
const { waitForFont } = require('./helpers');

/**
 * AirConsole E2E tests — runs against the real AirConsole platform by default,
 * or with a mock SDK when AC_MOCK=1.
 *
 * Live mode (default):
 *   Uses Firefox + http://http.airconsole.com to load the game from localhost.
 *   Tests the real AirConsole SDK, messaging, and onboarding flow.
 *
 * Mock mode (AC_MOCK=1):
 *   Blocks the real SDK and injects a mock. Faster, works headless, no network.
 *
 * Remote mode (AC_GAME_URL=https://...):
 *   Uses Chrome + real AirConsole with a deployed HTTPS URL.
 *
 * Run:
 *   npx playwright test --project=e2e-airconsole           # live, localhost
 *   AC_MOCK=1 npx playwright test --project=e2e-airconsole # mock
 *   AC_GAME_URL=https://... npx playwright test --project=e2e-airconsole # remote
 */

const USE_MOCK = process.env.AC_MOCK === '1' || !!process.env.CI;
// Port matches playwright.config.js webServer.port (PW_PORT override).
const GAME_URL = process.env.AC_GAME_URL || `http://localhost:${process.env.PW_PORT || 4100}`;
const IS_LOCAL = GAME_URL.includes('localhost') || GAME_URL.includes('127.0.0.1');
const MOCK_SCRIPT = path.join(__dirname, 'airconsole-mock.js');

// ---------------------------------------------------------------------------
// Setup helpers — abstract the difference between live and mock modes
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AirConsoleSession
 * @property {import('@playwright/test').Frame} screenFrame
 * @property {import('@playwright/test').Frame} ctrlFrame
 * @property {import('@playwright/test').Page} screenPage
 * @property {import('@playwright/test').Page} ctrlPage
 */

// ---- Mock mode helpers ----

async function setupMockPage(page, opts = {}) {
  await page.route('**/airconsole-*.js', (route) => {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '// blocked' });
  });
  if (opts.nickname || opts.deviceId) {
    await page.addInitScript((o) => {
      if (o.nickname) window.__AC_NICKNAME = o.nickname;
      if (o.deviceId) window.__AC_DEVICE_ID = o.deviceId;
    }, opts);
  }
  // Kill CSS animations/transitions so Playwright's actionability "stable"
  // check never races a one-shot entrance animation (e.g. the lobby start
  // button's fadeUp) or the layout reflow when a player joins. Test-only —
  // production animations are untouched. Elements with fill-mode both/
  // forwards/backwards land on their end state instantly, so visibility and
  // layout are correct, just not animated.
  await page.addInitScript(() => {
    const apply = () => {
      const style = document.createElement('style');
      style.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;}';
      (document.head || document.documentElement).appendChild(style);
    };
    if (document.head) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
}

async function createMockSession(context, screenPage) {
  await setupMockPage(screenPage);
  await screenPage.setViewportSize({ width: 1280, height: 720 });
  await screenPage.goto('/screen.html');
  await waitForFont(screenPage);
  await screenPage.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });

  const ctrlPage = await context.newPage();
  await setupMockPage(ctrlPage, { nickname: 'TestPlayer', deviceId: 101 });
  await ctrlPage.setViewportSize({ width: 390, height: 844 });
  await ctrlPage.goto('/controller.html');
  await waitForFont(ctrlPage);

  await ctrlPage.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
  await ctrlPage.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });

  return {
    screenFrame: screenPage.mainFrame(),
    ctrlFrame: ctrlPage.mainFrame(),
    screenPage,
    ctrlPage,
  };
}

// ---- Live mode helpers ----

async function waitForFrame(page, urlSubstring, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const frame = page.frames().find(f => f.url().includes(urlSubstring));
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error('Frame "' + urlSubstring + '" not found within ' + timeout + 'ms');
}

// Find our HexStacker frame inside the AC simulator. The HTTP simulator
// hosts the game iframe at about:blank (injecting our HTML rather than
// navigating), so we can't match by URL — identify by `body.airconsole`,
// which is unique to the AC build of screen.html / controller.html.
async function waitForAppFrame(page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const f of page.frames()) {
      try {
        const isOurs = await f.evaluate(() =>
          document.body && document.body.classList && document.body.classList.contains('airconsole')
        );
        if (isOurs) return f;
      } catch (_) { /* cross-origin or detached frame */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('App frame (body.airconsole) not found within ' + timeout + 'ms');
}

async function getPairingCode(screenPage) {
  const acFrame = await waitForFrame(screenPage, 'frontend', 15000);
  // Match a digit/whitespace run anchored at digits on both ends. AC's
  // simulator has used "1393", "132 084", and "131 32" across versions —
  // the grouping isn't stable, so we accept any whitespace pattern and
  // rely on the post-strip 4–10 digit guard below to filter out short
  // page numbers (player counts, timers, etc.).
  const CODE_RE = /\b\d[\d\s]{2,18}\d\b/;
  await acFrame.waitForFunction((reSrc) => {
    const m = document.body.innerText.match(new RegExp(reSrc));
    if (!m) return false;
    const code = m[0].replace(/\s/g, '');
    return code.length >= 4 && code.length <= 10;
  }, CODE_RE.source, { timeout: 30000 });
  return await acFrame.evaluate((reSrc) => {
    const m = document.body.innerText.match(new RegExp(reSrc));
    if (!m) return null;
    const code = m[0].replace(/\s/g, '');
    return (code.length >= 4 && code.length <= 10) ? code : null;
  }, CODE_RE.source);
}

// AirConsole's HTTP simulator now prompts for a Game ID via a native
// dialog before it'll route the session. Auto-fill it on every page so
// the dialog doesn't sit open and re-fire.
const AC_GAME_ID = 'com.couchgames.stacker';
function autoAnswerAcGameId(page) {
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'prompt') dialog.accept(AC_GAME_ID).catch(() => {});
    else dialog.accept().catch(() => {});
  });
}

async function createLiveSession(screenCtx, ctrlCtx) {
  const screenURL = IS_LOCAL
    ? 'http://http.airconsole.com/?http=1&#' + GAME_URL + '/'
    : 'https://www.airconsole.com/#' + GAME_URL + '/';

  const screenPage = await screenCtx.newPage();
  autoAnswerAcGameId(screenPage);
  await screenPage.setViewportSize({ width: 1280, height: 720 });
  await screenPage.goto(screenURL, { waitUntil: 'domcontentloaded' });
  await screenPage.waitForTimeout(IS_LOCAL ? 20000 : 10000);

  const code = await getPairingCode(screenPage);
  if (!code) throw new Error('Failed to get pairing code');

  const ctrlPage = await ctrlCtx.newPage();
  autoAnswerAcGameId(ctrlPage);
  await ctrlPage.setViewportSize({ width: 390, height: 844 });

  if (IS_LOCAL) {
    await ctrlPage.goto('http://http.airconsole.com/?http=1&role=controller#!code=' + code);
    await ctrlPage.waitForTimeout(5000);
    const cf = await waitForFrame(ctrlPage, 'airconsole-controller', 10000);
    await cf.locator('button', { hasText: /ja|yes/i }).first().click({ timeout: 10000 });
  } else {
    await ctrlPage.goto('http://aircn.sl/_' + code);
    await ctrlPage.waitForTimeout(5000);
    const cf = await waitForFrame(ctrlPage, 'airconsole-controller', 10000);
    await cf.locator('input').fill('TestPlayer');
    await cf.locator('button', { hasText: /weiter|continue/i }).click();
    await ctrlPage.waitForTimeout(2000);
    await cf.locator('button', { hasText: /ja|yes/i }).click({ timeout: 10000 });
  }

  const screenFrame = await waitForAppFrame(screenPage, 30000);
  const ctrlFrame = await waitForAppFrame(ctrlPage, 30000);

  return { screenFrame, ctrlFrame, screenPage, ctrlPage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe.serial('AirConsole Integration', () => {
  test.setTimeout(USE_MOCK ? 90000 : 180000);

  let browser;
  let screenCtx;
  let ctrlCtx;

  test.beforeAll(async () => {
    if (USE_MOCK) return; // mock mode uses default Playwright browser
    if (IS_LOCAL) {
      browser = await firefox.launch({ headless: false });
      screenCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      ctrlCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    } else {
      browser = await chromium.launch({
        headless: false, channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      screenCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const iPhone = devices['iPhone 14'];
      ctrlCtx = await browser.newContext({ ...iPhone });
    }
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
  });

  /** @type {AirConsoleSession|null} */
  let _session = null;

  test.afterEach(async () => {
    if (_session) {
      await _session.screenPage.close().catch(() => {});
      await _session.ctrlPage.close().catch(() => {});
      _session = null;
    }
  });

  /** @returns {Promise<AirConsoleSession>} */
  async function createSession(context, page) {
    _session = USE_MOCK
      ? await createMockSession(context, page)
      : await createLiveSession(screenCtx, ctrlCtx);
    return _session;
  }

  // Mock-only: bring two controllers into a game, disconnect the second one
  // mid-game, and play through to the RESULTS screen with that player still
  // flagged as disconnected. The host (first joiner, device 101) never leaves,
  // so it keeps the host role and its Play Again / New Game buttons. The
  // leaver is device 102. Returns the session plus the leaver's page so the
  // caller can drive a restart and assert the leaver was dropped.
  // In AirConsole the players Map is keyed by deviceId (peerIndex === deviceId).
  async function reachResultsWithDisconnectedLeaver(context, page) {
    const s = await createSession(context, page);
    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });
    await s.ctrlFrame.waitForFunction(() => currentScreen === 'lobby' && playerColor !== null, null, { timeout: 15000 });

    // Second controller (the player who will disconnect mid-game)
    const leaverPage = await context.newPage();
    await setupMockPage(leaverPage, { deviceId: 102, nickname: 'Leaver' });
    await leaverPage.setViewportSize({ width: 390, height: 844 });
    await leaverPage.goto('/controller.html');
    await waitForFont(leaverPage);
    await leaverPage.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
    await s.screenFrame.waitForFunction(() => players.size === 2, null, { timeout: 15000 });

    // High start level on both boards so the game tops out quickly.
    for (const fr of [s.ctrlFrame, leaverPage.mainFrame()]) {
      await fr.evaluate(() => {
        const plus = document.getElementById('level-plus-btn');
        for (let i = 0; i < 14; i++) plus.click();
      });
    }
    await s.ctrlPage.waitForTimeout(300);

    // Host starts the game; leaver disconnects during the countdown.
    await s.ctrlFrame.locator('#start-btn').click();
    await s.screenFrame.waitForFunction(() => roomState === 'countdown', null, { timeout: 15000 });
    await leaverPage.evaluate(() => window.airconsole.triggerDisconnect());
    await s.screenFrame.waitForFunction(() => disconnectedQRs.has(102), null, { timeout: 10000 });

    // Game plays out with the host and reaches RESULTS.
    await s.screenFrame.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });
    await s.ctrlFrame.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });

    // Precondition for the bug: the disconnected player is still in the room.
    expect(await s.screenFrame.evaluate(() => players.has(102))).toBe(true);

    return { s, leaverPage };
  }

  test('screen shows lobby with AirConsoleAdapter', async ({ page, context }) => {
    const s = await createSession(context, page);

    await s.screenFrame.waitForFunction(() => {
      return typeof party !== 'undefined' && party && party._ready
        && typeof currentScreen !== 'undefined' && currentScreen === 'lobby';
    }, null, { timeout: 15000 });

    expect(await s.screenFrame.evaluate(() => party.constructor.name)).toBe('AirConsoleAdapter');
  });

  // Regression: the AirConsole simulator tears down the master controller's
  // iframe when the screen iframe calls history.back() (observed as the new-
  // host late-joiner navigating to about:blank on NEW GAME). The fix is to
  // neutralize pushState/replaceState/back on the screen in AC mode — lock it
  // in so future refactors can't reintroduce a history.pushState call.
  test('screen neutralizes history APIs in AirConsole mode', async ({ page, context }) => {
    const s = await createSession(context, page);
    await s.screenFrame.waitForFunction(
      () => typeof party !== 'undefined' && party && party._ready,
      null, { timeout: 15000 }
    );

    const result = await s.screenFrame.evaluate(() => {
      const beforeLen = history.length;
      const beforeState = history.state;
      history.pushState({ screen: 'game' }, '');
      history.replaceState({ screen: 'x' }, '');
      history.back();
      return {
        lenUnchanged: history.length === beforeLen,
        stateUnchanged: history.state === beforeState,
      };
    });

    expect(result.lenUnchanged).toBe(true);
    expect(result.stateUnchanged).toBe(true);
  });

  test('controller connects and reaches lobby', async ({ page, context }) => {
    const s = await createSession(context, page);

    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });

    await s.ctrlFrame.waitForFunction(() => {
      return typeof currentScreen !== 'undefined' && currentScreen === 'lobby'
        && typeof playerColor !== 'undefined' && playerColor !== null;
    }, null, { timeout: 15000 });

    expect(await s.ctrlFrame.evaluate(() => party.constructor.name)).toBe('AirConsoleAdapter');
  });

  test('two controllers join and host can start game', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Multi-controller test only in mock mode — AirConsole free tier limits to 2 players');
      return;
    }
    const s = await createSession(context, page);

    const c2 = await context.newPage();
    await setupMockPage(c2, { nickname: 'Bob', deviceId: 102 });
    await c2.setViewportSize({ width: 390, height: 844 });
    await c2.goto('/controller.html');
    await c2.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });

    await s.screenFrame.waitForFunction(() => players.size >= 2, null, { timeout: 10000 });

    // Wait for the host controller to reflect the 2nd join before clicking —
    // otherwise the click can land mid-re-render. The button is gated on both
    // visibility and the updated player count having propagated.
    await s.ctrlFrame.waitForFunction(() => {
      const btn = document.getElementById('start-btn');
      return btn && !btn.classList.contains('hidden') && playerCount >= 2;
    }, null, { timeout: 10000 });

    await s.ctrlFrame.locator('#start-btn').click();

    await s.screenFrame.waitForSelector('#game-screen:not(.hidden)', { timeout: 10000 });
    await s.screenFrame.waitForFunction(() => {
      return document.getElementById('countdown-overlay').classList.contains('hidden');
    }, null, { timeout: 10000 });
    await c2.close();
  });

  test('single player: lobby → game → results', async ({ page, context }) => {
    const s = await createSession(context, page);

    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });
    await s.ctrlFrame.waitForFunction(() => {
      return currentScreen === 'lobby' && playerColor !== null;
    }, null, { timeout: 15000 });

    // High level for fast game
    await s.ctrlFrame.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await s.ctrlPage.waitForTimeout(300);

    await s.ctrlFrame.locator('#start-btn').click();

    await s.screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });
    await s.ctrlFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });

    // Live mode: game physics run on rAF in the screen window; if it gets
    // occluded by the controller window, Firefox throttles rAF and game time
    // crawls (frame delta is capped at MAX_FRAME_DELTA_MS), so give the game
    // twice the headroom to finish.
    const resultsTimeout = USE_MOCK ? 60000 : 120000;
    await s.screenFrame.waitForSelector('#results-screen:not(.hidden)', { timeout: resultsTimeout });
    await s.ctrlFrame.waitForSelector('#gameover-screen:not(.hidden)', { timeout: resultsTimeout });
    expect(await s.screenFrame.evaluate(() => roomState)).toBe('results');
  });

  test('play again works after results', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Play again test only in mock mode — live AirConsole sessions may timeout');
      return;
    }
    const s = await createSession(context, page);

    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });
    await s.ctrlFrame.waitForFunction(() => currentScreen === 'lobby' && playerColor !== null, null, { timeout: 15000 });

    await s.ctrlFrame.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await s.ctrlPage.waitForTimeout(300);

    // First game
    await s.ctrlFrame.locator('#start-btn').click();
    await s.screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });
    await s.ctrlFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });
    await s.screenFrame.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });
    await s.ctrlFrame.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });

    await s.ctrlFrame.locator('#play-again-btn').click();
    await s.screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });
    await s.ctrlFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });

    expect(await s.screenFrame.evaluate(() => roomState)).toBe('playing');
  });

  test('Play Again drops a player who disconnected mid-game', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Disconnect restart test only in mock mode');
      return;
    }
    const { s, leaverPage } = await reachResultsWithDisconnectedLeaver(context, page);

    try {
      // Host clicks Play Again — the disconnected player must NOT carry over.
      await s.ctrlFrame.locator('#play-again-btn').click();
      await s.screenFrame.waitForFunction(
        () => roomState === 'countdown' || roomState === 'playing', null, { timeout: 15000 });

      expect(await s.screenFrame.evaluate(() => players.has(102))).toBe(false);
      expect(await s.screenFrame.evaluate(() => players.size)).toBe(1);
    } finally {
      await leaverPage.close();
    }
  });

  test('New Game drops a player who disconnected mid-game', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Disconnect restart test only in mock mode');
      return;
    }
    const { s, leaverPage } = await reachResultsWithDisconnectedLeaver(context, page);

    try {
      // Host clicks New Game — the disconnected player must NOT land in the lobby.
      await s.ctrlFrame.locator('#new-game-btn').click();
      await s.screenFrame.waitForFunction(() => roomState === 'lobby', null, { timeout: 15000 });

      expect(await s.screenFrame.evaluate(() => players.has(102))).toBe(false);
      expect(await s.screenFrame.evaluate(() => players.size)).toBe(1);
    } finally {
      await leaverPage.close();
    }
  });

  test('controller disconnect detected by display', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Disconnect test only in mock mode — live AirConsole handles disconnect differently');
      return;
    }
    const s = await createSession(context, page);

    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 10000 });

    await s.ctrlPage.evaluate(() => window.airconsole.triggerDisconnect());

    await s.screenFrame.waitForFunction(() => {
      return document.querySelectorAll('#player-list .player-card:not(.empty)').length === 0;
    }, null, { timeout: 10000 });
  });

  test('pause/resume via AirConsole SDK events', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Pause/resume test only in mock mode');
      return;
    }
    const s = await createSession(context, page);

    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });
    await s.ctrlFrame.waitForFunction(() => currentScreen === 'lobby' && playerColor !== null, null, { timeout: 15000 });

    // Max level for fast game
    await s.ctrlFrame.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await s.ctrlPage.waitForTimeout(300);

    // Start game — enters COUNTDOWN before PLAYING
    await s.ctrlFrame.locator('#start-btn').click();
    await s.screenFrame.waitForFunction(() => roomState === 'countdown', null, { timeout: 10000 });

    // Pause/resume during COUNTDOWN — verifies clearCountdownTimers() path
    await s.screenPage.evaluate(() => window.airconsole.triggerPause());
    await s.screenFrame.waitForFunction(() => paused === true, null, { timeout: 5000 });
    expect(await s.screenFrame.evaluate(() => countdown.timer == null)).toBe(true);
    await s.screenPage.evaluate(() => window.airconsole.triggerResume());
    await s.screenFrame.waitForFunction(() => paused === false, null, { timeout: 5000 });

    // Countdown resumes and game starts
    await s.screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });

    // Pause/resume during PLAYING
    await s.screenPage.evaluate(() => window.airconsole.triggerPause());
    await s.screenFrame.waitForFunction(() => paused === true, null, { timeout: 5000 });
    await s.screenPage.evaluate(() => window.airconsole.triggerResume());
    await s.screenFrame.waitForFunction(() => paused === false, null, { timeout: 5000 });

    expect(await s.screenFrame.evaluate(() => roomState)).toBe('playing');
  });

  // Regression: an AirConsole platform pause rides the display-internal AUTO
  // reason, and AUTO deliberately ABSORBS an existing freeze (a stranded
  // all-disconnected overlay has to come down). A host's manual pause must
  // survive it anyway — otherwise backgrounding the game and coming back
  // silently restarts a match the host stopped, with no one having pressed
  // Continue. Same rule for an ad break.
  test('a host pause survives an AirConsole platform pause and an ad', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Pause test only in mock mode');
      return;
    }
    const s = await createSession(context, page);

    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });
    await s.ctrlFrame.waitForFunction(() => currentScreen === 'lobby' && playerColor !== null, null, { timeout: 15000 });

    // Start level 1: the round has to outlive the whole sequence below.
    await s.ctrlFrame.locator('#start-btn').click();
    await s.screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 20000 });

    await s.screenFrame.evaluate(() => pauseGame());
    await s.screenFrame.waitForFunction(() => pauseReason === 'manual', null, { timeout: 5000 });

    for (const [freeze, thaw] of [['triggerPause', 'triggerResume'], ['triggerAdShow', 'triggerAdComplete']]) {
      await s.screenPage.evaluate((m) => window.airconsole[m](), freeze);
      await s.screenPage.evaluate((m) => window.airconsole[m](), thaw);
      // Still the host's freeze, still frozen, and the controller still sees a
      // pause it can act on.
      expect(await s.screenFrame.evaluate(() => pauseReason)).toBe('manual');
      expect(await s.screenFrame.evaluate(() => paused)).toBe(true);
    }
    await s.ctrlFrame.waitForFunction(
      () => !document.getElementById('pause-overlay').classList.contains('hidden'),
      null, { timeout: 5000 });

    // Continue still works: the pause was never handed to a reason that would
    // refuse it.
    await s.screenFrame.evaluate(() => resumeGame());
    await s.screenFrame.waitForFunction(() => paused === false, null, { timeout: 5000 });
    expect(await s.screenFrame.evaluate(() => roomState)).toBe('playing');
  });

  test('ad pause/resume during gameplay', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Ad test only in mock mode');
      return;
    }
    const s = await createSession(context, page);

    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });
    await s.ctrlFrame.waitForFunction(() => currentScreen === 'lobby' && playerColor !== null, null, { timeout: 15000 });

    await s.ctrlFrame.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await s.ctrlPage.waitForTimeout(300);

    // Start game — enters COUNTDOWN before PLAYING
    await s.ctrlFrame.locator('#start-btn').click();
    await s.screenFrame.waitForFunction(() => roomState === 'countdown', null, { timeout: 10000 });

    // Ad during COUNTDOWN — verifies clearCountdownTimers() path
    await s.screenPage.evaluate(() => window.airconsole.triggerAdShow());
    await s.screenFrame.waitForFunction(() => paused === true, null, { timeout: 5000 });
    expect(await s.screenFrame.evaluate(() => countdown.timer == null)).toBe(true);
    await s.screenPage.evaluate(() => window.airconsole.triggerAdComplete());
    await s.screenFrame.waitForFunction(() => paused === false, null, { timeout: 5000 });

    // Countdown resumes and game starts
    await s.screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });

    // Ad during PLAYING
    await s.screenPage.evaluate(() => window.airconsole.triggerAdShow());
    await s.screenFrame.waitForFunction(() => paused === true, null, { timeout: 5000 });
    await s.screenPage.evaluate(() => window.airconsole.triggerAdComplete());
    await s.screenFrame.waitForFunction(() => paused === false, null, { timeout: 5000 });

    expect(await s.screenFrame.evaluate(() => roomState)).toBe('playing');
  });

  // Regression: a host who changed their AirConsole nickname after joining (the
  // auto HX- name or an earlier nickname is already on other screens) must
  // propagate the new name to the other controllers' "Waiting for <host>"
  // banner. Before the fix, onHello updated the host record but never
  // re-broadcast, so the banner stayed stale.
  test('host nickname change propagates to other controllers\' waiting banner', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Multi-controller rename test only in mock mode');
      return;
    }
    const s = await createSession(context, page); // host = device 101, nickname 'TestPlayer'
    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });

    // Second controller (non-host) — its lobby shows "Waiting for <host>".
    const c2 = await context.newPage();
    await setupMockPage(c2, { nickname: 'Bob', deviceId: 102 });
    await c2.setViewportSize({ width: 390, height: 844 });
    await c2.goto('/controller.html');
    await c2.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
    await s.screenFrame.waitForFunction(() => players.size === 2, null, { timeout: 15000 });

    const c2Frame = c2.mainFrame();
    // Banner starts on the host's initial nickname.
    await c2Frame.waitForFunction(
      () => document.getElementById('waiting-action-text').textContent.indexOf('TestPlayer') !== -1,
      null, { timeout: 15000 });

    // Host edits their AirConsole nickname mid-lobby.
    await s.ctrlPage.evaluate(() => window.airconsole.triggerProfileChange('Captain'));

    // Display roster reflects the new host name (peerIndex === deviceId in AC)...
    await s.screenFrame.waitForFunction(
      () => players.get(101) && players.get(101).playerName === 'Captain', null, { timeout: 15000 });
    // ...and the non-host's waiting banner updates to match (the bug).
    await c2Frame.waitForFunction(
      () => document.getElementById('waiting-action-text').textContent.indexOf('Captain') !== -1,
      null, { timeout: 15000 });

    await c2.close();
  });

  // A nickname change DURING a running game must relabel the player without
  // disrupting play. SET_NAME is answered with no WELCOME, so the controller's
  // live touch handler is never torn down and rebuilt (initTouchInput) the way
  // a re-sent HELLO's restore reply would force.
  test('nickname change mid-game relabels without disrupting play', async ({ page, context }) => {
    if (!USE_MOCK) {
      test.skip(true, 'Mid-game rename test only in mock mode');
      return;
    }
    const s = await createSession(context, page); // host = device 101
    await s.screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });
    await s.ctrlFrame.waitForFunction(() => currentScreen === 'lobby' && playerColor !== null, null, { timeout: 15000 });

    // Default (slow) level so the game stays in play while we rename.
    await s.ctrlFrame.locator('#start-btn').click();
    await s.screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });
    await s.ctrlFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });

    // Snapshot the live touch handler — a restore WELCOME would replace it.
    await s.ctrlFrame.waitForFunction(() => typeof touchInput !== 'undefined' && touchInput !== null, null, { timeout: 15000 });
    await s.ctrlFrame.evaluate(() => { window.__tiBefore = touchInput; });

    await s.ctrlPage.evaluate(() => window.airconsole.triggerProfileChange('MidGame'));

    // Name propagates to the display roster...
    await s.screenFrame.waitForFunction(
      () => players.get(101) && players.get(101).playerName === 'MidGame', null, { timeout: 15000 });

    // ...the game keeps running and the touch handler was never rebuilt.
    expect(await s.screenFrame.evaluate(() => roomState)).toBe('playing');
    expect(await s.ctrlFrame.evaluate(() => currentScreen)).toBe('game');
    expect(await s.ctrlFrame.evaluate(() => touchInput === window.__tiBefore)).toBe(true);
  });
});
