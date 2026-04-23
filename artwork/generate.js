// Banner generator — captures real display + controllers via Party-Server
// Usage: node artwork/generate.js
// Requires: server running on port 4100, Party-Server reachable

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { PLAYER_COLORS } = require('../public/shared/theme.js');
const { Piece } = require('../server/Piece.js');
const { COLS: HEX_COLS, VISIBLE_ROWS: HEX_VISIBLE_ROWS } = require('../server/constants.js');

// 3-player landscape scene — natural content aspect (~2:1) matches the
// 2:1/16:9 frames better than 4 boards did, and cells render larger.
const NAMES = ['Emma', 'Jake', 'Sofia'];
const BANNER_DIR = __dirname;
const BASE_URL = 'http://localhost:4100';

// --- Hex banner state ---
// Hex cell IDs follow the v2 game mapping (server/constants.js):
//   1=I, 2=O, 3=S, 4=Z, 5=q, 6=p, 7=L, 8=J, 9=garbage.
function hexBannerGrid1() {
  // Emma — Neon (level 13), busier board. Height ~9
  const grid = Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
  grid[12] = [0,0,0,0,3,0,0,0,0,0,0];
  grid[13] = [0,0,0,3,3,0,0,0,4,0,0];
  grid[14] = [0,0,5,5,3,0,0,4,4,0,0];
  grid[15] = [0,0,5,2,2,0,0,4,7,7,0];
  grid[16] = [0,5,1,2,2,0,7,7,6,6,0];
  grid[17] = [0,1,1,1,6,6,7,5,5,6,0];
  grid[18] = [0,3,3,4,4,6,2,2,5,5,0];
  grid[19] = [0,3,4,4,1,1,1,2,7,7,0];
  grid[20] = [0,2,2,5,5,1,6,6,7,3,3];
  return grid;
}

function hexBannerGrid2() {
  // Jake — Pillow (level 8), moderate board. Height ~7
  const grid = Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
  grid[14] = [0,0,0,0,0,0,0,5,5,0,0];
  grid[15] = [0,0,0,0,0,0,5,5,4,0,0];
  grid[16] = [0,0,0,0,3,3,7,7,4,4,0];
  grid[17] = [0,0,0,3,3,1,1,7,4,2,0];
  grid[18] = [0,0,6,6,2,2,1,1,6,2,2];
  grid[19] = [0,4,4,6,2,2,5,5,6,6,7];
  grid[20] = [0,4,3,3,1,1,5,7,7,3,7];
  return grid;
}

function hexBannerGrid3() {
  // Sofia — Pillow (level 6), lighter board. Height ~5
  const grid = Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
  grid[16] = [0,0,0,0,0,2,2,0,0,0,0];
  grid[17] = [0,0,0,7,7,2,4,4,0,0,0];
  grid[18] = [0,0,6,6,7,7,5,4,4,0,0];
  grid[19] = [0,3,3,6,1,1,5,5,2,2,0];
  grid[20] = [0,3,5,5,4,1,1,7,7,2,0];
  return grid;
}

const HEX_BANNER_GRIDS = [hexBannerGrid1, hexBannerGrid2, hexBannerGrid3];
const HEX_BANNER_LEVELS = [13, 8, 6];
const HEX_BANNER_LINES = [115, 60, 35];
const HEX_BANNER_PIECE_TYPES = ['J', 'I', 'O'];
const HEX_BANNER_HOLD = ['Z', 'L', 'q'];
const HEX_BANNER_NEXT = [
  ['L', 'Z', 'I', 'p', 'O'],
  ['J', 'S', 'O', 'L', 'Z'],
  ['I', 'q', 'S', 'J', 'L'],
];

function buildHexBannerGameState(playerCount = NAMES.length) {
  const count = Math.max(1, Math.min(NAMES.length, playerCount));
  return {
    players: NAMES.slice(0, count).map((name, i) => {
      const pieceType = HEX_BANNER_PIECE_TYPES[i];
      const piece = new Piece(pieceType);
      piece.anchorCol = 5;
      piece.anchorRow = 2;
      const blocks = piece.getAbsoluteBlocks();

      const ghostPiece = piece.clone();
      // Drop ghost to just above the pile
      const grid = HEX_BANNER_GRIDS[i]();
      let ghostRow = piece.anchorRow;
      ghostPiece.anchorRow = ghostRow;
      // Simple drop: increment until a block collides
      outer: for (let r = piece.anchorRow; r < HEX_VISIBLE_ROWS; r++) {
        ghostPiece.anchorRow = r;
        const gb = ghostPiece.getAbsoluteBlocks();
        for (const [c, rr] of gb) {
          if (rr >= HEX_VISIBLE_ROWS || (rr >= 0 && c >= 0 && c < HEX_COLS && grid[rr][c] !== 0)) {
            ghostPiece.anchorRow = r - 1;
            break outer;
          }
        }
      }
      const ghostBlocks = ghostPiece.getAbsoluteBlocks();

      return {
        id: `player${i + 1}`,
        alive: true,
        lines: HEX_BANNER_LINES[i],
        level: HEX_BANNER_LEVELS[i],
        grid: grid,
        currentPiece: {
          type: pieceType,
          typeId: piece.typeId,
          anchorCol: piece.anchorCol,
          anchorRow: piece.anchorRow,
          cells: piece.cells,
          blocks: blocks,
        },
        ghost: {
          anchorCol: ghostPiece.anchorCol,
          anchorRow: ghostPiece.anchorRow,
          blocks: ghostBlocks,
        },
        holdPiece: HEX_BANNER_HOLD[i],
        nextPieces: HEX_BANNER_NEXT[i].slice(),
        pendingGarbage: i === 2 ? 3 : i === 1 ? 2 : 0,
        playerName: name,
        playerColor: PLAYER_COLORS[i % PLAYER_COLORS.length],
        clearingCells: null,
      };
    }),
    // `elapsed: null` suppresses the timer overlay.
    elapsed: null,
  };
}

// Gameplay banner variants — same scene, different aspect ratios.
// gameplay-2x1.png is GitHub's social preview (configured in repo Settings).
//
// Phone frame 120 × 245 (aspect 1:2.04). Controller capture viewport
// below (300 × 600) is tuned to the inner phone-screen area (114 × 228
// after the 3px frame + 14px notch padding) so `object-fit: cover`
// fills the screen without side-bars or bottom clipping.
//
// Each variant captures its own display at a viewport aspect matching
// the frame's rendered display area (3 boards ≈ 17*3 × 25 cells, natural
// ~2:1). Per-variant capture avoids horizontal dead-space or cropped
// boards when the single-source capture is stretched into mismatched
// frame aspects.
const GAMEPLAY_VARIANTS = [
  {
    name: 'gameplay-2x1.png',
    width: 1280, height: 640,
    displayViewport: { width: 1224, height: 608 }, // ~2:1, matches frame
    phoneHeight: '245px',
  },
  {
    name: 'gameplay-21x9.png',
    width: 1280, height: 640,
    displayViewport: { width: 1440, height: 608 }, // ~2.37:1, matches 21:9 clip
    phoneHeight: '245px',
    // Frame is clipped to 540px of a 640 viewport, so a plain `bottom: 2%`
    // would put the phones below the visible area. 17% lifts them so
    // their bottom sits ~2% above the clipped frame's bottom.
    phoneBottom: '17%',
    clipHeight: 540,
  },
  {
    name: 'gameplay-16x9.png',
    width: 1280, height: 720,
    displayViewport: { width: 1080, height: 608 }, // ~1.78:1, matches 16:9
    phoneHeight: '245px',
    pillTop: '30px',
  },
];

// Portrait 2-player variant — used as the device-choice hero image on
// phone-width viewports, where 16:9 is too squat. 3:4 (720×960) balances
// display-on-top + 2 phones-at-bottom without cramping either.
const PORTRAIT_VARIANT = {
  name: 'gameplay-2p-1x1.png',
  width: 900,
  height: 900,
  players: 2,
  // Viewport tuned so the captured display — once rendered at
  // width:100% of the 900px frame — fills the top portion, leaving
  // room for phones to overlap the bottom edge.
  displayViewport: { width: 1100, height: 980 },
};

async function waitForFont(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
}

async function generate() {
  const browser = await chromium.launch();

  // Captures the display at a specific viewport with N players injected.
  // Per-variant viewport lets each banner frame fill without dead space
  // or cropped boards when the image is stretched to 100% width.
  async function captureDisplay(viewport, playerCount) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 4 });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}/?test=1`, { timeout: 5000 });
    } catch {
      console.error(`Could not connect to ${BASE_URL}`);
      console.error('Start it with: PORT=4100 node server/index.js');
      await browser.close();
      process.exit(1);
    }
    await waitForFont(page);

    const injectPlayers = NAMES.slice(0, playerCount).map((name, i) => ({ id: `player${i + 1}`, name }));
    await page.evaluate((p) => window.__TEST__.addPlayers(p), injectPlayers);

    const gameState = buildHexBannerGameState(playerCount);
    await page.evaluate((s) => {
      window.__TEST__.injectGameState(s);
      startRenderLoop();
    }, gameState);

    await page.evaluate(() => {
      document.getElementById('game-toolbar').style.display = 'none';
    });
    await page.waitForTimeout(300);
    const base64 = (await page.screenshot()).toString('base64');
    await ctx.close();
    return base64;
  }

  // --- Phase 1: Capture hex display per variant ---
  console.log('Capturing hex displays...');
  for (const v of GAMEPLAY_VARIANTS) {
    v._displayBase64 = await captureDisplay(v.displayViewport, NAMES.length);
    console.log(`  Display captured for ${v.name} (${v.displayViewport.width}x${v.displayViewport.height}, ${NAMES.length} players)`);
  }

  // Portrait variant — 2 players, dedicated viewport.
  const hex2DisplayBase64 = await captureDisplay(PORTRAIT_VARIANT.displayViewport, PORTRAIT_VARIANT.players);
  console.log(`  Display captured for ${PORTRAIT_VARIANT.name} (${PORTRAIT_VARIANT.players} players)`);

  // --- Phase 2: Capture real controllers via Party-Server ---
  console.log('Capturing controllers...');

  // Create a room on the display
  const roomContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const roomPage = await roomContext.newPage();
  await roomPage.goto(BASE_URL);
  await waitForFont(roomPage);

  const continueBtn = roomPage.locator('#device-choice-continue');
  if (await continueBtn.isVisible()) await continueBtn.click();

  await roomPage.click('#new-game-btn');
  await roomPage.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
  await roomPage.waitForFunction(() => {
    const el = document.getElementById('join-url');
    return el && el.textContent && el.textContent.length > 0;
  }, null, { timeout: 10000 });

  const joinUrl = (await roomPage.textContent('#join-url')).trim();
  const roomCode = joinUrl.split('/').pop();
  console.log(`  Room created: ${roomCode}`);

  // Viewport aspect 300 × 600 (1:2) matches the inner phone-screen area
  // in banner.html (114 × 228 after the 3px frame + 14px notch padding).
  // Matching aspects means `object-fit: cover` on the inner <img>
  // produces no side-bars and no bottom clipping.
  const controllers = [];
  for (let i = 0; i < NAMES.length; i++) {
    const ctrlContext = await browser.newContext({
      viewport: { width: 300, height: 600 },
      deviceScaleFactor: 2,
    });
    const page = await ctrlContext.newPage();
    await page.goto(`${BASE_URL}/${roomCode}`);
    await waitForFont(page);
    await page.fill('#name-input', NAMES[i]);
    await page.click('#name-join-btn');
    await page.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });
    controllers.push(page);
    console.log(`  Joined: ${NAMES[i]}`);
  }

  // Host starts the game
  const host = controllers[0];
  await host.waitForFunction(() => {
    const btn = document.getElementById('start-btn');
    return btn && !btn.disabled;
  });
  await host.click('#start-btn');

  // Wait for all controllers to show game screen (after countdown)
  for (const ctrl of controllers) {
    await ctrl.waitForSelector('#game-screen:not(.hidden)', { timeout: 15000 });
  }
  // Wait for countdown to finish so the touch pad is active
  await host.waitForFunction(() => {
    return !document.getElementById('game-screen').classList.contains('countdown');
  }, null, { timeout: 10000 });
  await host.waitForTimeout(300);

  // Hide pause/settings/ping so they don't distract in the banner.
  // Guarded — controller UI evolves over time, missing IDs shouldn't
  // break artwork generation.
  for (const ctrl of controllers) {
    await ctrl.evaluate(() => {
      ['pause-btn', 'settings-btn', 'ping-display'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
    });
  }

  // Screenshot each controller
  const controllerBase64s = [];
  for (let i = 0; i < controllers.length; i++) {
    const buf = await controllers[i].screenshot();
    controllerBase64s.push(buf.toString('base64'));
    console.log(`  Controller captured: ${NAMES[i]}`);
  }

  // --- Phase 3: Generate banners ---
  console.log('Generating banners...');

  async function renderBanner(width, height, outputName, options = {}) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`file://${path.resolve(BANNER_DIR, 'banner.html')}`);
    await page.waitForTimeout(200);

    // Inject hex display screenshot
    await page.evaluate((hex) => {
      document.getElementById('display-hex-img').src = `data:image/png;base64,${hex}`;
    }, options._displayBase64);

    // Inject controller screenshots
    await page.evaluate((ctrls) => {
      ctrls.forEach((b64, i) => {
        document.getElementById(`ctrl-${i}`).src = `data:image/png;base64,${b64}`;
      });
    }, controllerBase64s);

    if (typeof options.phoneHeight === 'string') {
      await page.evaluate((phoneHeight) => {
        document.documentElement.style.setProperty('--phone-height', phoneHeight);
      }, options.phoneHeight);
    }
    if (typeof options.phoneBottom === 'string') {
      await page.evaluate((phoneBottom) => {
        document.documentElement.style.setProperty('--phone-bottom', phoneBottom);
      }, options.phoneBottom);
    }
    if (typeof options.pillTop === 'string') {
      await page.evaluate((pillTop) => {
        document.documentElement.style.setProperty('--pill-top', pillTop);
      }, options.pillTop);
    }
    await page.waitForTimeout(500);

    const outPath = path.resolve(BANNER_DIR, outputName);
    const screenshotOpts = { path: outPath };
    if (typeof options.clipHeight === 'number') {
      screenshotOpts.clip = { x: 0, y: 0, width, height: options.clipHeight };
    }
    await page.screenshot(screenshotOpts);
    console.log(`  ${outPath} (${width}x${height} @2x)`);
  }

  for (const v of GAMEPLAY_VARIANTS) {
    await renderBanner(v.width, v.height, v.name, v);
  }

  // --- Portrait 2-player banner — dedicated template, 2 phones, 3:4 ---
  // Writes directly to a tmp PNG since the portrait source isn't committed
  // to artwork/ — it only exists to feed the webp/jpg conversion below.
  async function renderPortraitBanner(outPath) {
    const v = PORTRAIT_VARIANT;
    const ctx = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`file://${path.resolve(BANNER_DIR, 'banner-portrait.html')}`);
    await page.waitForTimeout(200);

    await page.evaluate((hex) => {
      document.getElementById('display-hex-img').src = `data:image/png;base64,${hex}`;
    }, hex2DisplayBase64);

    await page.evaluate((ctrls) => {
      ctrls.forEach((b64, i) => {
        document.getElementById(`ctrl-${i}`).src = `data:image/png;base64,${b64}`;
      });
    }, controllerBase64s.slice(0, v.players));

    await page.waitForTimeout(500);
    await page.screenshot({ path: outPath });
    console.log(`  ${outPath} (${v.width}x${v.height} @2x)`);
  }
  const portraitPngTmp = path.join(os.tmpdir(), `hexstacker-${PORTRAIT_VARIANT.name}`);
  await renderPortraitBanner(portraitPngTmp);

  // Produce device-choice hero images in public/artwork/ as WebP (primary)
  // and JPEG (fallback for browsers without WebP). JPEG is ~6-10x smaller
  // at q=85 and visually identical for these screenshots.
  const publicDir = path.resolve(BANNER_DIR, '..', 'public', 'artwork');
  fs.mkdirSync(publicDir, { recursive: true });
  // 16x9 is the social-preview / OG image. 2x1 is the device-choice
  // hero. 2p-1x1 is the portrait overlay. The 21x9 PNG is used by the
  // README only, so it's generated above but not shipped as webp/jpg.
  const heroSources = [
    { srcPng: path.resolve(BANNER_DIR, 'gameplay-16x9.png'), base: 'gameplay-16x9' },
    { srcPng: path.resolve(BANNER_DIR, 'gameplay-2x1.png'), base: 'gameplay-2x1' },
    { srcPng: portraitPngTmp, base: PORTRAIT_VARIANT.name.replace(/\.png$/, '') },
  ];
  for (const { srcPng, base } of heroSources) {
    const webpPath = path.resolve(publicDir, `${base}.webp`);
    const jpgPath = path.resolve(publicDir, `${base}.jpg`);
    const srcKB = (fs.statSync(srcPng).size / 1024).toFixed(0);

    try {
      execFileSync('cwebp', ['-q', '82', '-m', '6', '-quiet', srcPng, '-o', webpPath]);
      console.log(`  ${webpPath} (${(fs.statSync(webpPath).size / 1024).toFixed(0)}KB, src ${srcKB}KB png)`);
    } catch (err) {
      console.warn(`  cwebp failed for ${base} — ${err.message}. Install libwebp.`);
    }

    try {
      execFileSync('magick', [srcPng, '-quality', '85', '-strip', '-interlace', 'Plane', jpgPath]);
      console.log(`  ${jpgPath} (${(fs.statSync(jpgPath).size / 1024).toFixed(0)}KB)`);
    } catch (err) {
      console.warn(`  magick failed for ${base} — ${err.message}. Install ImageMagick.`);
    }
  }
  try { fs.unlinkSync(portraitPngTmp); } catch {}

  // Note: social-preview.png is now generated by `node artwork/generate-social.js`
  // (which captures cover-builder.html?headless=social). Cover-art.png is
  // generated by `node artwork/generate-cover.js`.

  await browser.close();
  console.log('Done!');
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
