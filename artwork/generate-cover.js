#!/usr/bin/env node
'use strict';

// Standalone cover-art generator — captures cover-builder.html in headless
// mode at 1024×1024 and writes artwork/cover-art.png. Not served over HTTP
// (no consumer in public/), so no copy is made.
// Usage: node artwork/generate-cover.js

const { chromium } = require('playwright');
const path = require('path');

const COVER_WIDTH = 1024;
const COVER_HEIGHT = 1024;
const ARTWORK_DIR = __dirname;
const ARTWORK_OUT = path.resolve(ARTWORK_DIR, 'cover-art.png');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: COVER_WIDTH, height: COVER_HEIGHT },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`file://${path.resolve(ARTWORK_DIR, 'cover-builder.html')}?headless=cover`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: ARTWORK_OUT });
  await browser.close();

  console.log(`Wrote ${ARTWORK_OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
