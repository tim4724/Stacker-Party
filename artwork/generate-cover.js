#!/usr/bin/env node
'use strict';

// Captures artwork/builder.html in headless mode using the `cover` STAGES
// entry and writes artwork/cover-art.png (1024×1024). Not served over
// HTTP, so no public/ copy is made.
// Usage: node artwork/generate-cover.js
// Note: builder.html also accepts ?w=N&h=N to override the stage's canvas
// dims for hi-res or non-canonical captures.

const { chromium } = require('playwright');
const path = require('path');

const COVER_WIDTH = 1024;
const COVER_HEIGHT = 1024;
const ARTWORK_DIR = __dirname;
const BUILDER = path.resolve(ARTWORK_DIR, 'builder.html');
const ARTWORK_OUT = path.resolve(ARTWORK_DIR, 'cover-art.png');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: COVER_WIDTH, height: COVER_HEIGHT },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`file://${BUILDER}?headless=cover`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const err = await page.evaluate(() => window.__BUILDER_ERROR__);
  if (err) {
    await browser.close();
    throw new Error(`builder.html reported: ${err}`);
  }
  await page.screenshot({ path: ARTWORK_OUT });
  await browser.close();

  console.log(`Wrote ${ARTWORK_OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
