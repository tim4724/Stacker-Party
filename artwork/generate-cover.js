#!/usr/bin/env node
'use strict';

// Standalone cover-art generator — captures artwork/cover-art.html at
// 1024×1024 and writes both:
//   - artwork/cover-art.png            (source-of-truth copy in /artwork)
//   - public/artwork/cover-art.png     (HTTP-served copy used by HTML)
// No server required.
// Usage: node artwork/generate-cover.js

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const COVER_WIDTH = 1024;
const COVER_HEIGHT = 1024;
const ARTWORK_DIR = __dirname;
const ARTWORK_OUT = path.resolve(ARTWORK_DIR, 'cover-art.png');
const PUBLIC_OUT = path.resolve(ARTWORK_DIR, '..', 'public', 'artwork', 'cover-art.png');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: COVER_WIDTH, height: COVER_HEIGHT },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`file://${path.resolve(ARTWORK_DIR, 'cover-art.html')}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: ARTWORK_OUT });
  await browser.close();

  fs.mkdirSync(path.dirname(PUBLIC_OUT), { recursive: true });
  fs.copyFileSync(ARTWORK_OUT, PUBLIC_OUT);

  console.log(`Wrote ${ARTWORK_OUT}`);
  console.log(`Copied to ${PUBLIC_OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
