// Banner generator — captures real display + controllers via Party-Server
// Usage: node artwork/generate.js
// Requires: server running on port 4100, Party-Server reachable

const { chromium } = require('playwright');
const path = require('path');
// fixtures no longer needed — banner uses its own buildBannerGameState()
const { PLAYER_COLORS } = require('../public/shared/theme.js');
const { HexPiece } = require('../server/HexPiece.js');
const { HEX_COLS, HEX_VISIBLE_ROWS } = require('../server/HexConstants.js');

const NAMES = ['Emma', 'Jake', 'Sofia', 'Liam'];
const BANNER_DIR = __dirname;
const BASE_URL = 'http://localhost:4100';

// --- Banner-specific game state: busier boards spanning all 3 style tiers ---
// Each grid is built bottom-up so every non-zero cell is supported by a non-zero
// cell directly below it (or sits on the bottom row). Wells are 1-column gaps
// kept clear for the active piece's ghost.
//
// Top rows use intact piece shapes (recognizable pieces recently placed).
// Lower rows are fragmented (realistic result of line clears).

function bannerGrid1() {
  // Emma — Neon (level 13), 3 garbage (gap col 7), AI-placed with line clears. Height: 10
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[12] = [0,0,0,4,4,0,0,0,0,0];
  grid[13] = [0,0,0,4,4,0,0,0,0,0];
  grid[14] = [0,7,0,3,3,0,0,0,0,0];
  grid[15] = [7,7,5,5,3,0,0,7,0,0];
  grid[16] = [7,5,5,6,3,0,7,7,0,0];
  grid[17] = [3,3,6,6,6,0,7,5,5,0];
  grid[18] = [1,3,2,2,2,0,5,5,0,0];
  grid[19] = [1,3,4,4,2,0,6,6,6,0];
  grid[20] = [1,5,4,4,2,2,2,6,3,0];
  grid[21] = [1,5,5,4,4,1,2,7,3,0];
  return grid;
}

function bannerGrid2() {
  // Jake — Pillow (level 8), 1 garbage (gap col 3), AI-placed with line clears. Height: 8
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[14] = [0,0,0,0,0,4,4,0,0,0];
  grid[15] = [0,0,0,0,0,4,4,3,3,0];
  grid[16] = [0,0,0,5,0,3,3,3,3,0];
  grid[17] = [0,0,6,5,5,3,7,7,3,0];
  grid[18] = [0,6,6,6,5,2,2,7,7,0];
  grid[19] = [0,4,4,4,4,2,1,1,1,1];
  grid[20] = [0,4,4,4,4,2,3,2,2,2];
  grid[21] = [0,5,5,6,3,3,3,7,7,2];
  return grid;
}

function bannerGrid3() {
  // Sofia — Pillow (level 6), 0 garbage, AI-placed. Height: 5
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[17] = [4,4,0,0,5,0,2,2,2,0];
  grid[18] = [4,4,0,0,5,5,7,7,2,0];
  grid[19] = [2,2,7,4,4,5,6,7,7,0];
  grid[20] = [2,7,7,4,4,6,6,6,3,0];
  grid[21] = [2,7,1,1,1,1,3,3,3,0];
  return grid;
}

function bannerGrid4() {
  // Liam — Normal (level 4), 2 garbage (gap col 0), AI-placed with line clears. Height: 8
  const grid = Array.from({ length: 22 }, () => Array(10).fill(0));
  grid[14] = [0,0,0,0,0,7,0,0,0,0];
  grid[15] = [0,0,2,0,7,7,0,4,4,0];
  grid[16] = [0,0,2,0,7,7,5,4,4,6];
  grid[17] = [0,2,2,3,7,7,5,5,6,6];
  grid[18] = [0,3,3,3,7,4,4,5,6,6];
  grid[19] = [0,1,1,1,1,4,4,6,6,6];
  grid[20] = [0,8,8,8,8,8,8,8,8,8];
  grid[21] = [0,8,8,8,8,8,8,8,8,8];
  return grid;
}

const BANNER_GRIDS = [bannerGrid1, bannerGrid2, bannerGrid3, bannerGrid4];
const BANNER_LEVELS = [13, 8, 6, 4];
const BANNER_LINES = [120, 65, 38, 22];
const BANNER_HOLD = ['S', 'I', 'T', 'J'];
const BANNER_NEXT = [
  ['Z', 'O', 'J', 'L', 'I'],
  ['T', 'O', 'J', 'I', 'L'],
  ['L', 'Z', 'O', 'I', 'J'],
  ['S', 'I', 'T', 'Z', 'O'],
];
const BANNER_PIECES = [
  // Emma: T-piece ·T·/TTT at x=5, ghostY=13
  { typeId: 6, x: 5, y: 2, blocks: [[1,0],[0,1],[1,1],[2,1]] },
  // Jake: Z-piece ZZ·/·ZZ at x=2, ghostY=14
  { typeId: 7, x: 2, y: 2, blocks: [[0,0],[1,0],[1,1],[2,1]] },
  // Sofia: S-piece ·SS/SS· at x=2, ghostY=16
  { typeId: 5, x: 2, y: 2, blocks: [[1,0],[2,0],[0,1],[1,1]] },
  // Liam: L-piece ··L/LLL at x=6, ghostY=13
  { typeId: 3, x: 6, y: 2, blocks: [[2,0],[0,1],[1,1],[2,1]] },
];
const BANNER_GHOST_Y = [13, 14, 16, 13];

function buildBannerGameState() {
  return {
    players: NAMES.map((name, i) => ({
      id: `player${i + 1}`,
      alive: true,

      lines: BANNER_LINES[i],
      level: BANNER_LEVELS[i],
      grid: BANNER_GRIDS[i](),
      currentPiece: {
        typeId: BANNER_PIECES[i].typeId,
        x: BANNER_PIECES[i].x,
        y: BANNER_PIECES[i].y,
        blocks: BANNER_PIECES[i].blocks.map(b => b.slice()),
      },
      ghostY: BANNER_GHOST_Y[i],
      holdPiece: BANNER_HOLD[i],
      nextPieces: BANNER_NEXT[i].slice(),
      pendingGarbage: i === 2 ? 4 : i === 1 ? 2 : 0,
      playerName: name,
      playerColor: PLAYER_COLORS[i % PLAYER_COLORS.length],
    })),
    elapsed: 185000,
  };
}

// --- Hex banner state ---
function hexBannerGrid1() {
  // Emma — Neon (level 13), busier board. Height ~9
  const grid = Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
  grid[12] = [0,0,0,0,5,0,0,0,0,0,0];
  grid[13] = [0,0,0,5,5,0,0,0,7,0,0];
  grid[14] = [0,0,3,3,5,0,0,7,7,0,0];
  grid[15] = [0,0,3,4,4,0,0,7,6,6,0];
  grid[16] = [0,3,1,4,4,0,6,6,2,2,0];
  grid[17] = [0,1,1,1,2,2,6,3,3,2,0];
  grid[18] = [0,5,5,7,7,2,4,4,3,3,0];
  grid[19] = [0,5,7,7,1,1,1,4,6,6,0];
  grid[20] = [0,4,4,3,3,1,2,2,6,5,5];
  return grid;
}

function hexBannerGrid2() {
  // Jake — Pillow (level 8), moderate board. Height ~7
  const grid = Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
  grid[14] = [0,0,0,0,0,0,0,3,3,0,0];
  grid[15] = [0,0,0,0,0,0,3,3,7,0,0];
  grid[16] = [0,0,0,0,5,5,6,6,7,7,0];
  grid[17] = [0,0,0,5,5,1,1,6,7,4,0];
  grid[18] = [0,0,2,2,4,4,1,1,2,4,4];
  grid[19] = [0,7,7,2,4,4,3,3,2,2,6];
  grid[20] = [0,7,5,5,1,1,3,6,6,5,6];
  return grid;
}

function hexBannerGrid3() {
  // Sofia — Pillow (level 6), lighter board. Height ~5
  const grid = Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
  grid[16] = [0,0,0,0,0,4,4,0,0,0,0];
  grid[17] = [0,0,0,6,6,4,7,7,0,0,0];
  grid[18] = [0,0,2,2,6,6,3,7,7,0,0];
  grid[19] = [0,5,5,2,1,1,3,3,4,4,0];
  grid[20] = [0,5,3,3,7,1,1,6,6,4,0];
  return grid;
}

function hexBannerGrid4() {
  // Liam — Normal (level 4), with garbage. Height ~7
  const grid = Array.from({ length: HEX_VISIBLE_ROWS }, () => Array(HEX_COLS).fill(0));
  grid[14] = [0,0,0,0,0,0,2,0,0,0,0];
  grid[15] = [0,0,0,0,0,2,2,0,0,0,0];
  grid[16] = [0,0,0,0,7,7,2,5,0,0,0];
  grid[17] = [0,0,4,4,7,3,3,5,5,0,0];
  grid[18] = [0,6,6,4,3,3,1,1,5,0,0];
  grid[19] = [9,9,6,9,9,9,9,1,1,9,9];
  grid[20] = [9,9,9,9,9,9,9,9,9,0,9];
  return grid;
}

const HEX_BANNER_GRIDS = [hexBannerGrid1, hexBannerGrid2, hexBannerGrid3, hexBannerGrid4];
const HEX_BANNER_LEVELS = [13, 8, 6, 4];
const HEX_BANNER_LINES = [115, 60, 35, 18];
const HEX_BANNER_PIECE_TYPES = ['J', 'I', 'O', 'S'];
const HEX_BANNER_HOLD = ['Z', 'L', 'T', 'O'];
const HEX_BANNER_NEXT = [
  ['L', 'Z', 'I', 'T', 'O'],
  ['J', 'S', 'O', 'L', 'Z'],
  ['I', 'T', 'S', 'J', 'L'],
  ['Z', 'J', 'L', 'I', 'T'],
];

function buildHexBannerGameState() {
  return {
    players: NAMES.map((name, i) => {
      const pieceType = HEX_BANNER_PIECE_TYPES[i];
      const piece = new HexPiece(pieceType);
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
    elapsed: 185000,
  };
}

const SOCIAL_WIDTH = 1280;
const SOCIAL_HEIGHT = 640;
const HEADER_WIDTH = 1280;
const HEADER_HEIGHT = 540;

async function waitForFont(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
}

async function generate() {
  const browser = await chromium.launch();

  // --- Phase 1: Capture display with injected game state (exciting boards) ---
  console.log('Capturing display...');
  const displayContext = await browser.newContext({
    viewport: { width: 1440, height: 608 },
    deviceScaleFactor: 4,
  });
  const displayPage = await displayContext.newPage();

  try {
    await displayPage.goto(`${BASE_URL}/?test=1`, { timeout: 5000 });
  } catch {
    console.error(`Could not connect to ${BASE_URL}`);
    console.error('Start it with: PORT=4100 node server/index.js');
    await browser.close();
    process.exit(1);
  }

  await waitForFont(displayPage);

  // Inject players with custom names
  const players = NAMES.map((name, i) => ({ id: `player${i + 1}`, name }));
  await displayPage.evaluate((p) => window.__TEST__.addPlayers(p), players);

  // Build exciting banner state with busier boards spanning all style tiers
  const gameState = buildBannerGameState();

  await displayPage.evaluate((s) => {
    window.__TEST__.injectGameState(s);
    startRenderLoop();
  }, gameState);

  // Hide toolbar
  await displayPage.evaluate(() => {
    document.getElementById('game-toolbar').style.display = 'none';
  });
  await displayPage.waitForTimeout(300);

  const displayBase64 = (await displayPage.screenshot()).toString('base64');
  console.log('  Display captured (square)');

  // --- Phase 1b: Capture hex display ---
  console.log('Capturing hex display...');
  const hexContext = await browser.newContext({
    viewport: { width: 1440, height: 608 },
    deviceScaleFactor: 4,
  });
  const hexPage = await hexContext.newPage();
  await hexPage.goto(`${BASE_URL}/?test=1`, { timeout: 5000 });
  await waitForFont(hexPage);

  // Inject players
  const hexPlayers = NAMES.map((name, i) => ({ id: `player${i + 1}`, name }));
  await hexPage.evaluate((p) => window.__TEST__.addPlayers(p), hexPlayers);

  // Build hex state and inject
  const hexGameState = buildHexBannerGameState();
  await hexPage.evaluate((s) => {
    window.__TEST__.setGameMode('hex');
    window.__TEST__.injectGameState(s);
    startRenderLoop();
  }, hexGameState);

  // Hide toolbar
  await hexPage.evaluate(() => {
    document.getElementById('game-toolbar').style.display = 'none';
  });
  await hexPage.waitForTimeout(300);

  const hexDisplayBase64 = (await hexPage.screenshot()).toString('base64');
  console.log('  Display captured (hex)');

  // --- Phase 2: Capture real controllers via Party-Server ---
  console.log('Capturing controllers...');

  // Create a room on the display
  const roomContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const roomPage = await roomContext.newPage();
  await roomPage.goto(BASE_URL);
  await waitForFont(roomPage);

  const mobileHint = roomPage.locator('#mobile-hint button');
  if (await mobileHint.isVisible()) await mobileHint.click();

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

    // Inject display screenshots (square + hex)
    await page.evaluate(({ square, hex }) => {
      document.getElementById('display-img').src = `data:image/png;base64,${square}`;
      document.getElementById('display-hex-img').src = `data:image/png;base64,${hex}`;
    }, { square: displayBase64, hex: hexDisplayBase64 });

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

  await renderBanner(SOCIAL_WIDTH, SOCIAL_HEIGHT, 'github-preview.png', {
    phoneBottom: '18px',
    phoneHeight: '255px'
  });
  await renderBanner(SOCIAL_WIDTH, SOCIAL_HEIGHT, 'readme-header.png', {
    phoneBottom: '18px',
    phoneHeight: '255px',
    clipHeight: HEADER_HEIGHT
  });
  await renderBanner(1280, 720, 'airconsole-screenshot.png', {
    phoneBottom: '18px',
    phoneHeight: '255px',
    displayTop: '40px',
    pillTop: '30px'
  });

  // --- Phase 4: Name banner (title + falling pieces, no screenshots needed) ---
  console.log('Generating name banner...');
  const nameBannerCtx = await browser.newContext({
    viewport: { width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT },
    deviceScaleFactor: 2,
  });
  const nameBannerPage = await nameBannerCtx.newPage();
  await nameBannerPage.goto(`file://${path.resolve(BANNER_DIR, 'name-banner.html')}`);
  await waitForFont(nameBannerPage);
  await nameBannerPage.waitForTimeout(300);
  const nameBannerPath = path.resolve(BANNER_DIR, '..', 'public', 'social-preview.png');
  await nameBannerPage.screenshot({ path: nameBannerPath });
  console.log(`  ${nameBannerPath} (${SOCIAL_WIDTH}x${SOCIAL_HEIGHT} @2x)`);

  await browser.close();
  console.log('Done!');
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
