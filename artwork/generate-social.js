#!/usr/bin/env node
'use strict';

// Standalone social-preview generator — captures cover-builder.html in
// headless mode at 1280×640 and writes public/artwork/social-preview.png.
// No server required.
// Usage: node artwork/generate-social.js

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SOCIAL_WIDTH = 1280;
const SOCIAL_HEIGHT = 640;
const BANNER_DIR = __dirname;
const OUTPUT = path.resolve(BANNER_DIR, '..', 'public', 'artwork', 'social-preview.png');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`file://${path.resolve(BANNER_DIR, 'cover-builder.html')}?headless=social`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  await page.screenshot({ path: OUTPUT });
  await browser.close();
  console.log(`Wrote ${OUTPUT} (${SOCIAL_WIDTH}x${SOCIAL_HEIGHT} @2x)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
