// @ts-check

const { buildPlayers, buildPlayerIds, buildGameState, buildResults } = require('./fixtures');

const TEST_BASE_URL = 'http://localhost:4100';

async function waitForFont(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
}

async function stopDisplayBackground(page) {
  await page.evaluate(() => {
    if (typeof welcomeBg !== 'undefined' && welcomeBg) {
      welcomeBg.stop();
    }
    const canvas = document.getElementById('bg-canvas');
    if (canvas) {
      canvas.style.display = 'none';
    }
  });
}

// --- Display test injection helpers ---
// These use window.__TEST__ API to inject state directly into the display,
// avoiding any dependency on Party-Server for visual snapshot tests.

async function injectPlayers(page, count) {
  const playerList = buildPlayers(count);
  await page.evaluate((players) => {
    window.__TEST__.addPlayers(players);
  }, playerList);
}

async function injectGameState(page, playerCount, options) {
  const playerIds = buildPlayerIds(playerCount);
  const state = buildGameState(playerIds, options || {});
  await page.evaluate((s) => {
    window.__TEST__.injectGameState(s);
  }, state);
}

async function injectResults(page, playerCount) {
  const playerIds = buildPlayerIds(playerCount);
  const results = buildResults(playerIds);
  await page.evaluate((r) => {
    window.__TEST__.injectResults(r);
  }, results);
}

async function injectPause(page) {
  await page.evaluate(() => {
    window.__TEST__.injectPause();
  });
}

async function injectKO(page, playerIndex) {
  const playerId = 'player' + (playerIndex + 1);
  await page.evaluate((id) => {
    window.__TEST__.injectKO(id);
  }, playerId);
}

async function injectGarbageSent(page, fromIndex, toIndex, lines) {
  await page.evaluate(({ senderId, toId, lineCount }) => {
    window.__TEST__.injectGarbageSent({ senderId, toId, lines: lineCount });
  }, { senderId: 'player' + (fromIndex + 1), toId: 'player' + (toIndex + 1), lineCount: lines });
}

// Navigate to display page in test mode
async function gotoDisplayTest(page) {
  await page.goto('/?test=1');
  await waitForFont(page);
}

// --- Integration test helpers (real Party-Server flows) ---

async function createRoom(page) {
  // Display page needs a desktop viewport even when running in the controller project
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await waitForFont(page);
  const continueAnyway = page.locator('#mobile-hint button');
  if (await continueAnyway.isVisible()) {
    await continueAnyway.click();
  }
  await page.click('#new-game-btn');
  await page.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
  await page.waitForFunction(() => {
    const joinUrl = document.getElementById('join-url');
    const qrCanvas = document.getElementById('qr-code');
    return joinUrl && joinUrl.textContent && joinUrl.textContent.length > 0
      && qrCanvas && qrCanvas.width > 0;
  }, null, { timeout: 10000 });

  const joinUrl = (await page.textContent('#join-url')).trim();
  const roomCode = joinUrl.split('/').pop();
  return { joinUrl, roomCode };
}

async function joinController(context, roomCode, name) {
  const page = await context.newPage();
  await page.goto(`/${roomCode}`);
  await waitForFont(page);
  await page.fill('#name-input', name);
  await page.click('#name-join-btn');
  await page.waitForSelector('#player-identity:not(.hidden)', { timeout: 10000 });
  return page;
}

async function waitForDisplayPlayers(page, count) {
  await page.waitForFunction((expected) => {
    return document.querySelectorAll('#player-list .player-card:not(.empty)').length >= expected;
  }, count);
}

async function waitForDisplayGame(page) {
  await page.waitForSelector('#game-screen:not(.hidden)');
  await page.waitForFunction(() => {
    return document.getElementById('countdown-overlay').classList.contains('hidden');
  });
  await page.waitForTimeout(150);
}

async function waitForDisplayResults(page) {
  await page.waitForSelector('#results-screen:not(.hidden)');
  await page.waitForTimeout(1100);
}

async function waitForControllerGame(page) {
  await page.waitForSelector('#game-screen:not(.hidden)');
  await page.waitForTimeout(150);
}

async function waitForControllerResults(page) {
  await page.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 30000 });
  await page.waitForTimeout(1100);
}

module.exports = {
  createRoom,
  gotoDisplayTest,
  injectGameState,
  injectGarbageSent,
  injectKO,
  injectPause,
  injectPlayers,
  injectResults,
  joinController,
  stopDisplayBackground,
  waitForControllerGame,
  waitForControllerResults,
  waitForDisplayGame,
  waitForDisplayPlayers,
  waitForDisplayResults,
  waitForFont,
};
