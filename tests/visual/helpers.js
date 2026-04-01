// @ts-check

const { buildPlayers, buildPlayerIds, buildGameState, buildStyleTierGameState, buildAllPiecesGhostState, buildResults } = require('./fixtures');


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

async function injectStyleTierGameState(page, playerCount) {
  const playerIds = buildPlayerIds(playerCount);
  const state = buildStyleTierGameState(playerIds);
  await page.evaluate((s) => {
    window.__TEST__.injectGameState(s);
  }, state);
}

async function injectAllPiecesGhostState(page, playerCount, tierLevel) {
  const playerIds = buildPlayerIds(playerCount);
  const result = buildAllPiecesGhostState(playerIds, tierLevel);
  await page.evaluate(({ s, extraGhosts }) => {
    window.__TEST__.setExtraGhosts(extraGhosts);
    window.__TEST__.injectGameState(s);
  }, { s: result.state, extraGhosts: result.extraGhostsPerPlayer });
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
  await page.goto('/', { waitUntil: 'networkidle' });
  await waitForFont(page);
  const continueAnyway = page.locator('#mobile-hint button');
  if (await continueAnyway.isVisible()) {
    await continueAnyway.click();
  }
  await page.click('#new-game-btn');
  await page.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 30000 });
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

async function stabilizeControllerUI(page) {
  await page.evaluate((url) => {
    // Freeze ping display to default text
    var ping = document.getElementById('ping-display');
    if (ping) {
      ping.textContent = '- ms';
      ping.className = 'ping-display';
    }
    // Null out the module-level reference so future pings are no-ops
    if (typeof pingDisplay !== 'undefined') pingDisplay = null;
    // Standardize join URL hints
    var nameUrl = document.getElementById('name-join-url');
    var lobbyUrl = document.getElementById('lobby-join-url');
    if (nameUrl) nameUrl.textContent = url;
    if (lobbyUrl) lobbyUrl.textContent = url;
  }, STABLE_URL);
}

const STABLE_URL = 'https://couch-games.com/ABCD';

async function stabilizeDisplayLobby(page) {
  var response = await page.request.get('/api/qr?text=' + encodeURIComponent(STABLE_URL));
  var qrMatrix = await response.json();
  await page.evaluate(({ url, matrix }) => {
    document.getElementById('join-url').textContent = url;
    renderQR(document.getElementById('qr-code'), matrix);
  }, { url: STABLE_URL, matrix: qrMatrix });
  await page.waitForTimeout(50);
}

async function waitForControllerGame(page) {
  await page.waitForSelector('#game-screen:not(.hidden):not(.countdown)');
  await stabilizeControllerUI(page);
  await page.waitForTimeout(150);
}

async function waitForControllerResults(page) {
  await page.waitForSelector('#gameover-screen:not(.hidden)', { timeout: 30000 });
  // Buttons fade in after a 2s delay via opacity 0 → 1
  await page.waitForFunction(
    () => document.getElementById('gameover-buttons').style.opacity !== '0',
    { timeout: 5000 }
  );
  await page.waitForTimeout(200);
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
  injectAllPiecesGhostState,
  injectStyleTierGameState,
  joinController,
  stabilizeControllerUI,
  stabilizeDisplayLobby,
  stopDisplayBackground,
  waitForControllerGame,
  waitForControllerResults,
  waitForDisplayGame,
  waitForDisplayPlayers,
  waitForDisplayResults,
  waitForFont,
};
