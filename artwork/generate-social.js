#!/usr/bin/env node
'use strict';

// Captures artwork/builder.html in headless mode using the `social` STAGES
// entry and writes public/artwork/social-preview.png (1280×640).
// Usage: node artwork/generate-social.js
// Note: builder.html also accepts ?w=N&h=N to override the stage's canvas
// dims for hi-res or non-canonical captures.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SOCIAL_WIDTH = 1280;
const SOCIAL_HEIGHT = 640;
const ARTWORK_DIR = __dirname;
const BUILDER = path.resolve(ARTWORK_DIR, 'builder.html');
const OUTPUT = path.resolve(ARTWORK_DIR, '..', 'public', 'artwork', 'social-preview.png');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`file://${BUILDER}?headless=social`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const err = await page.evaluate(() => window.__BUILDER_ERROR__);
  if (err) {
    await browser.close();
    throw new Error(`builder.html reported: ${err}`);
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  await page.screenshot({ path: OUTPUT });
  await browser.close();
  console.log(`Wrote ${OUTPUT} (${SOCIAL_WIDTH}x${SOCIAL_HEIGHT} @2x)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
