// @ts-check
// Regression: the sensitivity slider must be draggable when the AC-built
// controller is hosted inside an iframe (how AirConsole loads it).
//
// Chromium's native <input type="range"> doesn't update its value on
// touch-drag inside an iframe — pointermove/touchmove fire but no 'input'
// follows. controller-airconsole.js ships a custom pointer handler that
// patches this. This test iframes /controller.html, simulates a real CDP
// touch-drag on the slider, and asserts the value moves.
//
// Run:
//   AC_MOCK=1 npx playwright test --project=e2e-airconsole --grep "slider drag"

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const MOCK_SCRIPT = path.join(__dirname, 'airconsole-mock.js');

test('sensitivity slider drag updates value in iframe', async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.route('**/airconsole-*.js', (route) => {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '// blocked' });
  });
  // Strip server CSP/X-Frame-Options so we can iframe /controller.html from
  // a localhost parent (the shipped headers only allow airconsole.com).
  await page.route('**/*', async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    delete headers['content-security-policy'];
    delete headers['x-frame-options'];
    route.fulfill({ response: res, headers });
  });
  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.setContent(`<!doctype html><html><body style="margin:0;padding:0">
    <iframe id="ac" src="http://localhost:4100/controller.html"
            style="border:0;width:100%;height:100vh"></iframe>
  </body></html>`);
  const handle = await page.waitForSelector('#ac');
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('controller frame missing');

  await frame.waitForFunction(
    () => document.querySelectorAll('.screen:not(.hidden)').length > 0,
    null, { timeout: 10000 }
  );

  // Force the settings overlay open — we bypass lobby/pairing for isolation.
  await frame.evaluate(() => {
    document.getElementById('settings-overlay').classList.remove('hidden');
  });
  await frame.waitForSelector('#sensitivity-slider', { state: 'visible' });

  const rect = await frame.evaluate(() => {
    const r = document.getElementById('sensitivity-slider').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  const startValue = await frame.evaluate(
    () => document.getElementById('sensitivity-slider').value
  );

  const startX = rect.x + rect.w * 0.5;
  const endX = rect.x + rect.w * 0.95;
  const y = rect.y + rect.h * 0.5;

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y, id: 1 }],
  });
  for (let i = 1; i <= 10; i++) {
    const x = startX + (endX - startX) * (i / 10);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  // Poll for the value to change instead of a fixed delay — more robust in CI.
  await frame.waitForFunction(
    (start) => parseFloat(document.getElementById('sensitivity-slider').value)
      !== parseFloat(start),
    startValue,
    { timeout: 2000 }
  );
  const endValue = await frame.evaluate(
    () => document.getElementById('sensitivity-slider').value
  );

  // Drag from midpoint to 95% should land near the slider max.
  expect(parseFloat(endValue)).toBeGreaterThan(parseFloat(startValue) + 0.2);

  await browser.close();
});
