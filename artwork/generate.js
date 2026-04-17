// Banner generator — captures real display + controllers via Party-Server
// Usage: node artwork/generate.js
// Requires: server running on port 4100, Party-Server reachable

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { PLAYER_COLORS } = require('../public/shared/theme.js');
const { Piece } = require('../server/Piece.js');
const { COLS: HEX_COLS, VISIBLE_ROWS: HEX_VISIBLE_ROWS } = require('../server/constants.js');

const NAMES = ['Emma', 'Jake', 'Sofia', 'Liam'];
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

function hexBannerGrid4() {
  // Liam — Normal (level 4), with garbage. Height ~7
  const grid = Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
  grid[14] = [0,0,0,0,0,0,6,0,0,0,0];
  grid[15] = [0,0,0,0,0,6,6,0,0,0,0];
  grid[16] = [0,0,0,0,4,4,6,3,0,0,0];
  grid[17] = [0,0,2,2,4,5,5,3,3,0,0];
  grid[18] = [0,7,7,2,5,5,1,1,3,0,0];
  grid[19] = [9,9,7,9,9,9,9,1,1,9,9];
  grid[20] = [9,9,9,9,9,9,9,9,9,0,9];
  return grid;
}

const HEX_BANNER_GRIDS = [hexBannerGrid1, hexBannerGrid2, hexBannerGrid3, hexBannerGrid4];
const HEX_BANNER_LEVELS = [13, 8, 6, 4];
const HEX_BANNER_LINES = [115, 60, 35, 18];
const HEX_BANNER_PIECE_TYPES = ['J', 'I', 'O', 'S'];
const HEX_BANNER_HOLD = ['Z', 'L', 'q', 'O'];
const HEX_BANNER_NEXT = [
  ['L', 'Z', 'I', 'p', 'O'],
  ['J', 'S', 'O', 'L', 'Z'],
  ['I', 'q', 'S', 'J', 'L'],
  ['Z', 'J', 'L', 'I', 'p'],
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
const GAMEPLAY_VARIANTS = [
  { name: 'gameplay-2x1.png',  width: 1280, height: 640, phoneBottom: '18px', phoneHeight: '255px' },
  { name: 'gameplay-21x9.png', width: 1280, height: 640, phoneBottom: '18px', phoneHeight: '255px', clipHeight: 540 },
  { name: 'gameplay-16x9.png', width: 1280, height: 720, phoneBottom: '18px', phoneHeight: '255px', displayTop: '40px', pillTop: '30px' },
];

// Portrait 2-player variant — used as the end-screen hero image on
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

  // --- Phase 1: Capture hex display with injected game state ---
  console.log('Capturing hex display...');
  const hexContext = await browser.newContext({
    viewport: { width: 1440, height: 608 },
    deviceScaleFactor: 4,
  });
  const hexPage = await hexContext.newPage();

  try {
    await hexPage.goto(`${BASE_URL}/?test=1`, { timeout: 5000 });
  } catch {
    console.error(`Could not connect to ${BASE_URL}`);
    console.error('Start it with: PORT=4100 node server/index.js');
    await browser.close();
    process.exit(1);
  }

  await waitForFont(hexPage);

  const hexPlayers = NAMES.map((name, i) => ({ id: `player${i + 1}`, name }));
  await hexPage.evaluate((p) => window.__TEST__.addPlayers(p), hexPlayers);

  const hexGameState = buildHexBannerGameState();
  await hexPage.evaluate((s) => {
    window.__TEST__.injectGameState(s);
    startRenderLoop();
  }, hexGameState);

  await hexPage.evaluate(() => {
    document.getElementById('game-toolbar').style.display = 'none';
  });
  await hexPage.waitForTimeout(300);

  const hexDisplayBase64 = (await hexPage.screenshot()).toString('base64');
  console.log('  Display captured (4 players)');

  // --- Phase 1b: Capture hex display with 2 players for the portrait variant ---
  // A separate context so the auto-layout re-runs with count=2 and the two
  // boards fill the width. Viewport tuned to suit the portrait banner crop.
  console.log('Capturing hex display (2 players, portrait)...');
  const hex2Context = await browser.newContext({
    viewport: PORTRAIT_VARIANT.displayViewport,
    deviceScaleFactor: 4,
  });
  const hex2Page = await hex2Context.newPage();
  await hex2Page.goto(`${BASE_URL}/?test=1`, { timeout: 5000 });
  await waitForFont(hex2Page);

  const hex2Players = NAMES.slice(0, PORTRAIT_VARIANT.players).map((name, i) => ({ id: `player${i + 1}`, name }));
  await hex2Page.evaluate((p) => window.__TEST__.addPlayers(p), hex2Players);

  const hex2GameState = buildHexBannerGameState(PORTRAIT_VARIANT.players);
  await hex2Page.evaluate((s) => {
    window.__TEST__.injectGameState(s);
    startRenderLoop();
  }, hex2GameState);

  await hex2Page.evaluate(() => {
    document.getElementById('game-toolbar').style.display = 'none';
  });
  await hex2Page.waitForTimeout(300);
  const hex2DisplayBase64 = (await hex2Page.screenshot()).toString('base64');
  console.log('  Display captured (2 players)');

  // --- Phase 2: Capture real controllers via Party-Server ---
  console.log('Capturing controllers...');

  // Create a room on the display
  const roomContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const roomPage = await roomContext.newPage();
  await roomPage.goto(BASE_URL);
  await waitForFont(roomPage);

  const continueAnyway = roomPage.locator('#end-continue-btn');
  if (await continueAnyway.isVisible()) await continueAnyway.click();

  await roomPage.click('#new-game-btn');
  await roomPage.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
  await roomPage.waitForFunction(() => {
    const el = document.getElementById('join-url');
    return el && el.textContent && el.textContent.length > 0;
  }, null, { timeout: 10000 });

  const joinUrl = (await roomPage.textContent('#join-url')).trim();
  const roomCode = joinUrl.split('/').pop();
  console.log(`  Room created: ${roomCode}`);

  // Join 4 controllers
  const controllers = [];
  for (let i = 0; i < NAMES.length; i++) {
    const ctrlContext = await browser.newContext({
      viewport: { width: 300, height: 650 },
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

  // Hide pause/mute buttons so they don't distract in the banner
  for (const ctrl of controllers) {
    await ctrl.evaluate(() => {
      document.getElementById('mute-btn').style.display = 'none';
      document.getElementById('pause-btn').style.display = 'none';
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
    }, hexDisplayBase64);

    // Inject controller screenshots
    await page.evaluate((ctrls) => {
      ctrls.forEach((b64, i) => {
        document.getElementById(`ctrl-${i}`).src = `data:image/png;base64,${b64}`;
      });
    }, controllerBase64s);

    // Inject player colors from theme.js (only first 4 for the 4 phones)
    await page.evaluate((colors) => {
      colors.forEach((color, i) => {
        document.getElementById(`phone-${i}`).style.setProperty('--color', color);
      });
    }, PLAYER_COLORS.slice(0, NAMES.length));

    if (typeof options.phoneBottom === 'string') {
      await page.evaluate((phoneBottom) => {
        document.documentElement.style.setProperty('--phone-bottom', phoneBottom);
      }, options.phoneBottom);
    }
    if (typeof options.phoneHeight === 'string') {
      await page.evaluate((phoneHeight) => {
        document.documentElement.style.setProperty('--phone-height', phoneHeight);
      }, options.phoneHeight);
    }
    if (typeof options.displayTop === 'string') {
      await page.evaluate((displayTop) => {
        document.documentElement.style.setProperty('--display-top', displayTop);
      }, options.displayTop);
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
  async function renderPortraitBanner() {
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

    await page.evaluate((colors) => {
      colors.forEach((color, i) => {
        document.getElementById(`phone-${i}`).style.setProperty('--color', color);
      });
    }, PLAYER_COLORS.slice(0, v.players));

    await page.waitForTimeout(500);
    const outPath = path.resolve(BANNER_DIR, v.name);
    await page.screenshot({ path: outPath });
    console.log(`  ${outPath} (${v.width}x${v.height} @2x)`);
  }
  await renderPortraitBanner();

  // Produce end-screen hero images in public/artwork/ as WebP (primary)
  // and JPEG (fallback for browsers without WebP). PNG source stays in
  // artwork/ but is not copied — JPEG is ~6-10x smaller at q=85 and
  // visually identical for these screenshots.
  const publicDir = path.resolve(BANNER_DIR, '..', 'public', 'artwork');
  fs.mkdirSync(publicDir, { recursive: true });
  for (const pngName of ['gameplay-16x9.png', PORTRAIT_VARIANT.name]) {
    const srcPng = path.resolve(BANNER_DIR, pngName);
    const webpPath = path.resolve(publicDir, pngName.replace(/\.png$/, '.webp'));
    const jpgPath = path.resolve(publicDir, pngName.replace(/\.png$/, '.jpg'));
    const srcKB = (fs.statSync(srcPng).size / 1024).toFixed(0);

    try {
      execFileSync('cwebp', ['-q', '82', '-m', '6', '-quiet', srcPng, '-o', webpPath]);
      console.log(`  ${webpPath} (${(fs.statSync(webpPath).size / 1024).toFixed(0)}KB, src ${srcKB}KB png)`);
    } catch (err) {
      console.warn(`  cwebp failed for ${pngName} — ${err.message}. Install libwebp.`);
    }

    try {
      execFileSync('magick', [srcPng, '-quality', '85', '-strip', '-interlace', 'Plane', jpgPath]);
      console.log(`  ${jpgPath} (${(fs.statSync(jpgPath).size / 1024).toFixed(0)}KB)`);
    } catch (err) {
      console.warn(`  magick failed for ${pngName} — ${err.message}. Install ImageMagick.`);
    }
  }

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
