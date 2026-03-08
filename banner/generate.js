// Banner generator — captures real display + controllers via Party-Server
// Usage: node banner/generate.js
// Requires: server running on port 4100, Party-Server reachable

const { chromium } = require('playwright');
const path = require('path');
const { buildPlayerIds, buildGameState } = require('../tests/visual/fixtures');
const { PLAYER_COLORS } = require('../public/shared/theme.js');

const NAMES = ['Emma', 'Jake', 'Sofia', 'Liam'];
const BANNER_DIR = __dirname;
const BASE_URL = 'http://localhost:4100';

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
    viewport: { width: 1920, height: 810 },
    deviceScaleFactor: 2,
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

  // Build game state with exciting boards and override names
  const playerIds = buildPlayerIds(4);
  const gameState = buildGameState(playerIds, {});
  gameState.players.forEach((p, i) => { p.playerName = NAMES[i]; });

  await displayPage.evaluate((s) => window.__TEST__.injectGameState(s), gameState);

  // Hide toolbar and boost text sizes for banner readability
  // THEME is const + Object.freeze so we monkey-patch UIRenderer methods
  await displayPage.evaluate(() => {
    document.getElementById('game-toolbar').style.display = 'none';

    const origDrawName = UIRenderer.prototype.drawPlayerName;
    UIRenderer.prototype.drawPlayerName = function(ps) {
      const saved = this.cellSize;
      this.cellSize = saved * 1.6;
      origDrawName.call(this, ps);
      this.cellSize = saved;
    };

    const origDrawScore = UIRenderer.prototype.drawScorePanel;
    UIRenderer.prototype.drawScorePanel = function(ps) {
      const saved = this.cellSize;
      this.cellSize = saved * 1.4;
      origDrawScore.call(this, ps);
      this.cellSize = saved;
    };
  });
  await displayPage.waitForTimeout(300);

  const displayBase64 = (await displayPage.screenshot()).toString('base64');
  console.log('  Display captured');

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

    // Inject display screenshot
    await page.evaluate((b64) => {
      document.getElementById('display-img').src = `data:image/png;base64,${b64}`;
    }, displayBase64);

    // Inject controller screenshots
    await page.evaluate((ctrls) => {
      ctrls.forEach((b64, i) => {
        document.getElementById(`ctrl-${i}`).src = `data:image/png;base64,${b64}`;
      });
    }, controllerBase64s);

    // Inject player colors from theme.js
    await page.evaluate((colors) => {
      colors.forEach((color, i) => {
        document.getElementById(`phone-${i}`).style.setProperty('--color', color);
      });
    }, PLAYER_COLORS);

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

  await browser.close();
  console.log('Done!');
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
