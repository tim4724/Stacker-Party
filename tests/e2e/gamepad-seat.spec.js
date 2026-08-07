// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForDisplayGame } = require('./helpers');

// A gamepad plugged into the display machine takes a seat of its own
// (public/display/GamepadInput.js). Driven against the REAL bundle with a
// synthetic pad: the display is opened WITHOUT ?test=1, because GamepadInput
// deliberately refuses to start under the test harness (a pad must never join
// a fixture roster) — which also means this spec exercises the exact path a
// player gets, bundle script order included.

// A minimal Gamepad object, close enough for GamepadInput's poll loop: it
// reads .connected, .id, .buttons[i].pressed, .axes and .vibrationActuator.
function installPad(page) {
  return page.addInitScript(() => {
    const pad = {
      index: 0,
      connected: true,
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
      mapping: 'standard',
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
      vibrationActuator: { playEffect: () => Promise.resolve('complete') },
    };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  });
}

async function press(page, index) {
  await page.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, index);
  await page.waitForTimeout(100);
  await page.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, index);
  await page.waitForTimeout(100);
}

test.describe('Gamepad seats', () => {
  test.setTimeout(60000);

  test('a pad joins, steps its level, starts the round and drives the pause overlay', async ({ page }) => {
    await installPad(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/', { waitUntil: 'networkidle' });
    const continueBtn = page.locator('#device-choice-continue');
    if (await continueBtn.isVisible()) await continueBtn.click();
    await page.click('#new-game-btn');
    await page.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 30000 });

    // ANY button joins (a named one would leave other presses unanswered);
    // a shoulder proves it is not special-cased. The seat is named after the
    // pad's vendor, trimmed to the room core's cap.
    await press(page, 5);
    await expect(page.locator('.player-card:not(.empty) .identity-name')).toHaveText('Xbox');

    // In the lobby the D-pad is this seat's level stepper (the ring has
    // nothing to do there: Start is the lobby's one action).
    await press(page, 15);
    await expect(page.locator('.player-card:not(.empty) .card-level__value')).toHaveText('2');

    // The bottom face button starts the round — this seat is the first joiner,
    // so it holds host.
    await press(page, 0);
    await waitForDisplayGame(page);

    // Start pauses mid-game…
    await press(page, 9);
    await expect(page.locator('#pause-overlay')).not.toHaveClass(/hidden/);

    // …where the overlay belongs to the focus ring: the primary button
    // (Continue) is focused, and the bottom face button clicks it.
    await expect(page.locator('#pause-continue-btn')).toHaveClass(/pad-focus/);
    await press(page, 0);
    await expect(page.locator('#pause-overlay')).toHaveClass(/hidden/);

    // Unplugging mid-game holds the seat (same path as a phone closing its
    // tab): the roster keeps the row so replugging resumes it.
    await page.evaluate(() => { window.__pad.connected = false; });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__pad.connected = true; });
    await press(page, 0);
    // Still one seat, not two: the replug reclaimed the same one.
    await page.waitForSelector('#game-screen:not(.hidden)');
  });
});
