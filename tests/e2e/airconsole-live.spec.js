// @ts-check
const { test, expect, chromium, firefox, devices } = require('@playwright/test');

/**
 * AirConsole Live E2E tests using the real AirConsole platform.
 *
 * Opens the screen via airconsole.com/#GAME_URL, extracts the pairing
 * code, connects a controller via deeplink, handles AirConsole's name
 * entry + confirmation flow, then tests the full game lifecycle.
 *
 * Supports two modes:
 * - Remote: AC_GAME_URL=https://deploy.example.com (uses Chrome)
 * - Local:  Uses localhost:4100 with Firefox (avoids Chrome Private Network Access)
 *
 * Run:
 *   npx playwright test --project=e2e-airconsole-live              # local (needs server on :4100)
 *   AC_GAME_URL=https://... npx playwright test --project=e2e-airconsole-live  # remote
 */

const GAME_URL = process.env.AC_GAME_URL;
// Local HTTP won't work — controller page is HTTPS and can't load HTTP iframes.
// A deployed HTTPS URL is required.
test.skip(!GAME_URL, 'AC_GAME_URL not set — skipping live AirConsole tests');
const IS_LOCAL = false;

/**
 * Wait for a frame matching a URL substring.
 */
async function waitForFrame(page, urlSubstring, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const frame = page.frames().find(f => f.url().includes(urlSubstring));
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error('Frame "' + urlSubstring + '" not found within ' + timeout + 'ms');
}

/**
 * Extract the pairing code from AirConsole's frontend frame.
 */
async function getPairingCode(screenPage) {
  const acFrame = await waitForFrame(screenPage, 'frontend', 15000);
  await acFrame.waitForFunction(() => {
    return /\d{3}\s+\d{3}/.test(document.body.innerText);
  }, null, { timeout: 30000 });

  return await acFrame.evaluate(() => {
    const match = document.body.innerText.match(/(\d{3}\s+\d{3}(?:\s+\d+)?)/);
    return match ? match[1].replace(/\s/g, '') : null;
  });
}

/**
 * Connect controller: navigate to deeplink, enter name, confirm ready.
 */
async function connectController(ctrlContext, code) {
  const ctrlPage = await ctrlContext.newPage();
  await ctrlPage.goto('http://aircn.sl/_' + code);
  await ctrlPage.waitForTimeout(5000);

  const ctrlFrontend = await waitForFrame(ctrlPage, 'airconsole-controller', 10000);

  // AirConsole name entry
  await ctrlFrontend.locator('input').fill('TestPlayer');
  await ctrlFrontend.locator('button', { hasText: /weiter|continue/i }).click();
  await ctrlPage.waitForTimeout(2000);

  // "Sind alle dabei?" / "Is everyone in?" confirmation
  await ctrlFrontend.locator('button', { hasText: /ja|yes|start|play/i }).click({ timeout: 10000 });

  return ctrlPage;
}

test.describe.serial('AirConsole Live', () => {
  test.setTimeout(180000);

  let browser;
  let screenCtx;
  let ctrlCtx;

  test.beforeAll(async () => {
    if (IS_LOCAL) {
      // Firefox doesn't enforce Private Network Access — can load localhost
      browser = await firefox.launch({ headless: false });
      screenCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      ctrlCtx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      });
    } else {
      browser = await chromium.launch({
        headless: false,
        channel: 'chrome',
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

  test('full lifecycle: pairing → lobby → game → results', async () => {
    // 1. Open screen on AirConsole
    const screenPage = await screenCtx.newPage();
    await screenPage.goto('https://www.airconsole.com/#' + GAME_URL + '/');
    await screenPage.waitForTimeout(10000);

    // 2. Get pairing code
    const code = await getPairingCode(screenPage);
    expect(code).toBeTruthy();

    // 3. Connect controller via deeplink
    const ctrlPage = await connectController(ctrlCtx, code);

    // 4. Wait for game frames to load
    const screenFrame = await waitForFrame(screenPage, 'screen.html', 30000);
    const ctrlFrame = await waitForFrame(ctrlPage, 'controller.html', 30000);

    // 5. Verify screen is in lobby with adapter
    await screenFrame.waitForFunction(() => {
      return typeof party !== 'undefined' && party && party._ready
        && typeof currentScreen !== 'undefined' && currentScreen === 'lobby';
    }, null, { timeout: 15000 });
    expect(await screenFrame.evaluate(() => party.constructor.name)).toBe('AirConsoleAdapter');

    // 6. Wait for player to appear
    await screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });

    // 7. Verify controller is in lobby (proves display→controller messaging works)
    await ctrlFrame.waitForFunction(() => {
      return typeof currentScreen !== 'undefined' && currentScreen === 'lobby'
        && typeof playerColor !== 'undefined' && playerColor !== null;
    }, null, { timeout: 15000 });
    expect(await ctrlFrame.evaluate(() => party.constructor.name)).toBe('AirConsoleAdapter');

    // 8. Set high level and start game
    await ctrlFrame.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await ctrlPage.waitForTimeout(300);
    await ctrlFrame.locator('#start-btn').click();

    // 9. Wait for game to start
    await screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });
    await ctrlFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });

    // 10. Wait for results (level 15 tops out quickly)
    await screenFrame.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });
    await ctrlFrame.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });
    expect(await screenFrame.evaluate(() => roomState)).toBe('results');

    await screenPage.close();
    await ctrlPage.close();
  });
});
