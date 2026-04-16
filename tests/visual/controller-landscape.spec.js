// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForFont } = require('./helpers');

// Fast controller landscape tests — no relay needed.
// Navigate to a fake room path and manipulate DOM directly.

async function gotoController(page) {
  await page.goto('/FAKE?test=1');
  await waitForFont(page);
}

async function showScreen(page, name) {
  await page.evaluate((screenName) => {
    document.getElementById('name-screen').classList.toggle('hidden', screenName !== 'name');
    document.getElementById('lobby-screen').classList.toggle('hidden', screenName !== 'lobby');
    document.getElementById('game-screen').classList.toggle('hidden', screenName !== 'game');
    document.getElementById('gameover-screen').classList.toggle('hidden', screenName !== 'gameover');
    document.getElementById('end-screen').classList.toggle('hidden', screenName !== 'end');
    var bg = document.getElementById('bg-canvas');
    if (bg) bg.classList.add('hidden');
  }, name);
}

test.describe('Controller Landscape', () => {

  test('name entry screen', async ({ page }) => {
    await gotoController(page);
    await expect(page).toHaveScreenshot('01-name-entry.png');
  });

  test('name entry - keyboard open', async ({ page }) => {
    await gotoController(page);
    // Simulate keyboard by shrinking viewport below 220px threshold
    await page.setViewportSize({ width: 844, height: 180 });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('01b-name-entry-keyboard.png');
  });

  test('lobby screen', async ({ page }) => {
    await gotoController(page);
    await showScreen(page, 'lobby');
    await page.evaluate(() => {
      document.getElementById('player-identity-name').textContent = 'Player 1';
      document.getElementById('player-identity-card').style.setProperty('--player-color', '#FF6B6B');
      document.getElementById('lobby-title').textContent = 'STACKER PARTY';
      var startBtn = document.getElementById('start-btn');
      startBtn.classList.remove('hidden');
      startBtn.disabled = false;
      startBtn.textContent = 'START (2 players)';
      document.getElementById('waiting-action-text').classList.add('hidden');
    });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('02-lobby.png');
  });

  test('lobby - late joiner waiting', async ({ page }) => {
    await gotoController(page);
    await showScreen(page, 'lobby');
    await page.evaluate(() => {
      document.getElementById('player-identity-name').textContent = 'Late Joiner';
      document.getElementById('player-identity-card').style.setProperty('--player-color', '#4ECDC4');
      document.getElementById('lobby-title').textContent = 'STACKER PARTY';
      var startBtn = document.getElementById('start-btn');
      startBtn.classList.add('hidden');
      var waitText = document.getElementById('waiting-action-text');
      waitText.classList.remove('hidden');
      waitText.textContent = 'Game in progress — you will join next round';
    });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('02b-lobby-late-joiner.png');
  });

  test('game screen', async ({ page }) => {
    await gotoController(page);
    await showScreen(page, 'game');
    await page.evaluate(() => {
      var gs = document.getElementById('game-screen');
      gs.classList.remove('countdown', 'paused', 'dead');
      gs.style.setProperty('--player-color', '#FF6B6B');
      document.getElementById('player-name').textContent = 'Player 1';
      document.getElementById('touch-area').setAttribute('data-player-name', 'Player 1');
      document.getElementById('pause-btn').classList.remove('hidden');
      var ping = document.getElementById('ping-display');
      if (ping) {
        ping.textContent = '24 ms';
        ping.className = 'ping-display ping-good';
      }
    });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('03-game.png');
  });

  test('game screen - paused', async ({ page }) => {
    await gotoController(page);
    await showScreen(page, 'game');
    await page.evaluate(() => {
      var gs = document.getElementById('game-screen');
      gs.classList.remove('countdown', 'dead');
      gs.classList.add('paused');
      gs.style.setProperty('--player-color', '#4ECDC4');
      document.getElementById('player-name').textContent = 'Player 2';
      document.getElementById('touch-area').setAttribute('data-player-name', 'Player 2');
      document.getElementById('pause-btn').classList.remove('hidden');
      var ping = document.getElementById('ping-display');
      if (ping) ping.style.display = 'none';
      var overlay = document.getElementById('pause-overlay');
      overlay.classList.remove('hidden');
      overlay.style.animation = 'none';
      overlay.style.opacity = '1';
    });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('04-game-paused.png');
  });

  test('game screen - KO', async ({ page }) => {
    await gotoController(page);
    await showScreen(page, 'game');
    await page.evaluate(() => {
      var gs = document.getElementById('game-screen');
      gs.classList.remove('countdown', 'paused');
      gs.classList.add('dead');
      gs.style.setProperty('--player-color', '#FFE66D');
      document.getElementById('player-name').textContent = 'Player 3';
      document.getElementById('touch-area').setAttribute('data-player-name', 'Player 3');
      document.getElementById('pause-btn').classList.remove('hidden');
      var ping = document.getElementById('ping-display');
      if (ping) ping.style.display = 'none';
      var ko = document.createElement('div');
      ko.id = 'ko-overlay';
      ko.textContent = 'KO';
      document.getElementById('touch-area').appendChild(ko);
    });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('05-game-ko.png');
  });

  test('results - 2 players', async ({ page }) => {
    await gotoController(page);
    await showScreen(page, 'gameover');
    await page.evaluate(() => {
      var list = document.getElementById('results-list');
      var players = [
        { rank: 1, name: 'Player 1', lines: 48, level: 5 },
        { rank: 2, name: 'Player 2', lines: 36, level: 4 },
      ];
      list.innerHTML = players.map(function(p) {
        return '<div class="result-row rank-' + p.rank + '" style="--row-delay:0s">'
          + '<span class="result-rank">' + p.rank + '.</span>'
          + '<div class="result-info">'
          + '<div class="result-name">' + p.name + '</div>'
          + '<div class="result-stats">'
          + '<span>' + p.lines + ' lines</span>'
          + '<span>Lv ' + p.level + '</span>'
          + '</div></div></div>';
      }).join('');
      list.querySelector('.result-row').classList.add('is-me');
      list.querySelector('.result-row').style.setProperty('--me-color', '#FF6B6B');
      var btns = document.getElementById('gameover-buttons');
      btns.classList.remove('hidden');
      btns.style.opacity = '1';
    });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('06a-results-2p.png');
  });

  test('results - 8 players', async ({ page }) => {
    await gotoController(page);
    await showScreen(page, 'gameover');
    await page.evaluate(() => {
      var list = document.getElementById('results-list');
      var players = [
        { rank: 1, name: 'Red', lines: 48, level: 5 },
        { rank: 2, name: 'Teal', lines: 36, level: 4 },
        { rank: 3, name: 'Yellow', lines: 24, level: 3 },
        { rank: 4, name: 'Purple', lines: 18, level: 2 },
        { rank: 5, name: 'Green', lines: 14, level: 2 },
        { rank: 6, name: 'Magenta', lines: 10, level: 1 },
        { rank: 7, name: 'Indigo', lines: 6, level: 1 },
        { rank: 8, name: 'Coral', lines: 3, level: 1 },
      ];
      list.innerHTML = players.map(function(p) {
        return '<div class="result-row rank-' + p.rank + '" style="--row-delay:0s">'
          + '<span class="result-rank">' + p.rank + '.</span>'
          + '<div class="result-info">'
          + '<div class="result-name">' + p.name + '</div>'
          + '<div class="result-stats">'
          + '<span>' + p.lines + ' lines</span>'
          + '<span>Lv ' + p.level + '</span>'
          + '</div></div></div>';
      }).join('');
      list.querySelector('.result-row').classList.add('is-me');
      list.querySelector('.result-row').style.setProperty('--me-color', '#FF6B6B');
      var btns = document.getElementById('gameover-buttons');
      btns.classList.remove('hidden');
      btns.style.opacity = '1';
    });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('06b-results-8p.png');
  });

  test('end screen', async ({ page }) => {
    await gotoController(page);
    await showScreen(page, 'end');
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('07-end-screen.png');
  });

});
