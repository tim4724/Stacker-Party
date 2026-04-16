// @ts-check
const { test, expect, chromium, firefox, devices } = require('@playwright/test');
const path = require('path');
const { waitForFont } = require('../visual/helpers');

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
// Port matches playwright.config.js webServer.port
const GAME_URL = process.env.AC_GAME_URL || 'http://localhost:4100';
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

async function getPairingCode(screenPage) {
  const acFrame = await waitForFrame(screenPage, 'frontend', 15000);
  await acFrame.waitForFunction(() => /\d{3}\s+\d{3}/.test(document.body.innerText), null, { timeout: 30000 });
  return await acFrame.evaluate(() => {
    const match = document.body.innerText.match(/(\d{3}\s+\d{3}(?:\s+\d+)?)/);
    return match ? match[1].replace(/\s/g, '') : null;
  });
}

async function createLiveSession(screenCtx, ctrlCtx) {
  const screenURL = IS_LOCAL
    ? 'http://http.airconsole.com/?http=1&#' + GAME_URL + '/'
    : 'https://www.airconsole.com/#' + GAME_URL + '/';

  const screenPage = await screenCtx.newPage();
  await screenPage.setViewportSize({ width: 1280, height: 720 });
  await screenPage.goto(screenURL, { waitUntil: 'domcontentloaded' });
  await screenPage.waitForTimeout(IS_LOCAL ? 20000 : 10000);

  const code = await getPairingCode(screenPage);
  if (!code) throw new Error('Failed to get pairing code');

  const ctrlPage = await ctrlCtx.newPage();
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

  const screenFrame = await waitForFrame(screenPage, 'screen.html', 30000);
  const ctrlFrame = await waitForFrame(ctrlPage, 'controller.html', 30000);

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

    const startVisible = await s.ctrlFrame.evaluate(() => {
      const btn = document.getElementById('start-btn');
      return btn && !btn.classList.contains('hidden');
    });
    expect(startVisible).toBeTruthy();

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

    await s.screenFrame.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });
    await s.ctrlFrame.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });
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

    // Play again
    await s.ctrlFrame.locator('#play-again-btn').click();
    await s.screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });
    await s.ctrlFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });

    expect(await s.screenFrame.evaluate(() => roomState)).toBe('playing');
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
});
