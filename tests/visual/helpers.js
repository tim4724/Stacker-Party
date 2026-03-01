// @ts-check

const TEST_BASE_URL = 'http://localhost:4100';

async function waitForFont(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
}

async function postJson(request, path, payload) {
  const response = await request.post(`${TEST_BASE_URL}${path}`, {
    data: payload,
  });

  if (!response.ok()) {
    throw new Error(`POST ${path} failed with ${response.status()}`);
  }

  return response.json();
}

async function resetTestServer(request) {
  await postJson(request, '/api/test/reset', {});
}

async function delayNextJoin(request, ms) {
  await postJson(request, '/api/test/delay-next-join', { ms });
}

async function applyScenario(request, roomCode, scenario, options) {
  await postJson(request, `/api/test/room/${roomCode}/scenario`, {
    scenario,
    options: options || {},
  });
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

async function createRoom(page) {
  await page.goto('/');
  await waitForFont(page);
  const continueAnyway = page.locator('#mobile-hint button');
  if (await continueAnyway.isVisible()) {
    await continueAnyway.click();
  }
  await page.click('#new-game-btn');
  await page.waitForSelector('#lobby-screen:not(.hidden)');
  await page.waitForFunction(() => {
    const joinUrl = document.getElementById('join-url');
    const qrCanvas = document.getElementById('qr-code');
    return joinUrl && joinUrl.textContent && joinUrl.textContent.length > 0
      && qrCanvas && qrCanvas.width > 0;
  });

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
  await page.waitForSelector('#player-identity:not(.hidden)');
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
  await page.waitForSelector('#gameover-screen:not(.hidden)');
  await page.waitForTimeout(1100);
}

module.exports = {
  applyScenario,
  createRoom,
  delayNextJoin,
  joinController,
  resetTestServer,
  stopDisplayBackground,
  waitForControllerGame,
  waitForControllerResults,
  waitForDisplayGame,
  waitForDisplayPlayers,
  waitForDisplayResults,
  waitForFont,
};
