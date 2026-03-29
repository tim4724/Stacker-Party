// @ts-check
const { test, expect, chromium, firefox, devices } = require('@playwright/test');

/**
 * AirConsole Live E2E tests using the real AirConsole platform.
 *
 * Opens the screen via airconsole.com, extracts the pairing code,
 * connects a controller via deeplink, clicks through AirConsole's
 * onboarding dialogs, then tests the full game lifecycle.
 *
 * Supports:
 * - Local:  http://localhost with Chrome flags to disable Private Network Access
 * - Remote: AC_GAME_URL=https://... deployed HTTPS URL
 *
 * Run:
 *   npx playwright test --project=e2e-airconsole-live              # local (:4100)
 *   AC_GAME_URL=https://... npx playwright test --project=e2e-airconsole-live
 */

const GAME_URL = process.env.AC_GAME_URL || 'http://localhost:4100';
const IS_LOCAL = GAME_URL.includes('localhost') || GAME_URL.includes('127.0.0.1');

function getScreenURL() {
  if (IS_LOCAL) {
    return 'http://http.airconsole.com/?http=1&#' + GAME_URL + '/';
  }
  return 'https://www.airconsole.com/#' + GAME_URL + '/';
}

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
  await acFrame.waitForFunction(() => {
    return /\d{3}\s+\d{3}/.test(document.body.innerText);
  }, null, { timeout: 30000 });

  return await acFrame.evaluate(() => {
    const match = document.body.innerText.match(/(\d{3}\s+\d{3}(?:\s+\d+)?)/);
    return match ? match[1].replace(/\s/g, '') : null;
  });
}

/**
 * Click through AirConsole's onboarding flow on the controller.
 * Handles: name input, "Weiter", "Ja", privacy, app install prompt, etc.
 * Stops when controller.html appears or we run out of dialogs.
 */
async function completeControllerOnboarding(ctrlPage, ctrlFrontend) {
  // Enter name if input exists
  try {
    const input = ctrlFrontend.locator('input').first();
    await input.waitFor({ timeout: 3000 });
    await input.fill('TestPlayer');
  } catch { /* no input */ }

  // Click through up to 10 dialogs
  for (let step = 0; step < 10; step++) {
    await ctrlPage.waitForTimeout(1500);

    // Check if game loaded
    if (ctrlPage.frames().some(f => f.url().includes('controller.html'))) return;

    try {
      const buttons = await ctrlFrontend.locator('button').all();
      if (buttons.length === 0) continue;

      const texts = await Promise.all(buttons.map(b => b.textContent().catch(() => '')));
      const trimmed = texts.map(t => t.trim());

      // Priority order: dismiss/skip > continue > confirm
      const patterns = [
        /vielleicht|maybe|later|skip|später|nicht jetzt/i,
        /weiter|continue/i,
        /ja|yes/i,
        /ich stimme zu|i agree/i,
        /ok/i,
      ];

      let clicked = false;
      for (const pattern of patterns) {
        for (let j = 0; j < trimmed.length; j++) {
          if (pattern.test(trimmed[j])) {
            await buttons[j].click({ timeout: 3000 }).catch(() => {});
            clicked = true;
            break;
          }
        }
        if (clicked) break;
      }

      // Fallback: click last button
      if (!clicked && buttons.length > 0) {
        await buttons[buttons.length - 1].click({ timeout: 3000 }).catch(() => {});
      }
    } catch {
      // Frame detached or navigated — game might be loading
      break;
    }
  }
}

test.describe.serial('AirConsole Live', () => {
  test.setTimeout(180000);

  let browser;
  let screenCtx;
  let ctrlCtx;

  test.beforeAll(async () => {
    const chromeArgs = [
      '--disable-blink-features=AutomationControlled',
    ];
    if (IS_LOCAL) {
      chromeArgs.push(
        '--disable-features=PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
        '--allow-running-insecure-content',
      );
    }

    browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: chromeArgs,
      ignoreDefaultArgs: ['--enable-automation'],
    });

    screenCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    if (IS_LOCAL) {
      ctrlCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    } else {
      const iPhone = devices['iPhone 14'];
      ctrlCtx = await browser.newContext({ ...iPhone });
    }
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
  });

  test('full lifecycle: pairing → lobby → game → results', async () => {
    // 1. Open screen
    const screenPage = await screenCtx.newPage();
    await screenPage.goto(getScreenURL(), { waitUntil: 'domcontentloaded' });
    await screenPage.waitForTimeout(10000);

    // 2. Get pairing code
    const code = await getPairingCode(screenPage);
    expect(code).toBeTruthy();

    // 3. Connect controller via deeplink
    const ctrlPage = await ctrlCtx.newPage();
    await ctrlPage.goto('http://aircn.sl/_' + code);
    await ctrlPage.waitForTimeout(5000);

    // 4. Click through AirConsole onboarding
    const ctrlFrontend = await waitForFrame(ctrlPage, 'airconsole-controller', 10000);
    await completeControllerOnboarding(ctrlPage, ctrlFrontend);

    // 5. Wait for game frames
    const screenFrame = await waitForFrame(screenPage, 'screen.html', 30000);
    const ctrlFrame = await waitForFrame(ctrlPage, 'controller.html', 30000);

    // 6. Verify screen lobby
    await screenFrame.waitForFunction(() => {
      return typeof party !== 'undefined' && party && party._ready
        && typeof currentScreen !== 'undefined' && currentScreen === 'lobby';
    }, null, { timeout: 15000 });
    expect(await screenFrame.evaluate(() => party.constructor.name)).toBe('AirConsoleAdapter');
    await screenFrame.waitForFunction(() => players.size >= 1, null, { timeout: 15000 });

    // 7. Verify controller lobby
    await ctrlFrame.waitForFunction(() => {
      return typeof currentScreen !== 'undefined' && currentScreen === 'lobby'
        && typeof playerColor !== 'undefined' && playerColor !== null;
    }, null, { timeout: 15000 });

    // 8. Start game at high level
    await ctrlFrame.evaluate(() => {
      const plus = document.getElementById('level-plus-btn');
      for (let i = 0; i < 14; i++) plus.click();
    });
    await ctrlPage.waitForTimeout(300);
    await ctrlFrame.locator('#start-btn').click();

    // 9. Verify game
    await screenFrame.waitForFunction(() => roomState === 'playing', null, { timeout: 15000 });
    await ctrlFrame.waitForSelector('#game-screen:not(.hidden):not(.countdown)', { timeout: 15000 });

    // 10. Wait for results
    await screenFrame.waitForSelector('#results-screen:not(.hidden)', { timeout: 60000 });
    await ctrlFrame.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 60000 });
    expect(await screenFrame.evaluate(() => roomState)).toBe('results');

    await screenPage.close();
    await ctrlPage.close();
  });
});
