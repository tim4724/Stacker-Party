'use strict';

// "Shared" row: screens that have no per-player variant — shown once at top.
var SHARED_SCENARIOS = [
  { key: 'name',            title: 'Name input' },
  { key: 'name-connecting', title: 'Connecting…' },
  { key: 'end',             title: 'End — game ended' },
  { key: 'end-full',        title: 'End — room full' },
  { key: 'privacy',         title: 'Privacy',  staticPath: '/privacy' },
  { key: 'imprint',         title: 'Imprint',  staticPath: '/imprint' }
];

// Per-color rows: one row per scenario with 8 color variants.
var PER_COLOR_SCENARIOS = [
  { key: 'lobby-host',       title: 'Lobby (host)' },
  { key: 'lobby-waiting',    title: 'Lobby (non-host waiting)' },
  { key: 'lobby-latejoiner', title: 'Lobby (late joiner)' },
  { key: 'countdown',        title: 'Countdown' },
  { key: 'playing',          title: 'Playing' },
  { key: 'paused',           title: 'Paused (non-host)',  extra: { host: '' } },
  { key: 'paused',           title: 'Paused (host)',      extra: { host: '1' } },
  { key: 'ko',               title: 'KO' },
  { key: 'reconnecting',     title: 'Reconnecting' },
  { key: 'disconnected',     title: 'Disconnected' },
  { key: 'results-winner',   title: 'Results (winner)' },
  { key: 'results-loser',    title: 'Results (loser)' }
];

var state = Gallery.loadState();
var nonce = 0;

// Controller accepts 1..8 cards per row. Same clamp pattern as display.
var CTRL_MAX_COLS = 8;
var storedCols = parseInt(state.cardsPerRow, 10);
var clampedCols = Math.max(1, Math.min(storedCols || CTRL_MAX_COLS, CTRL_MAX_COLS));
if (clampedCols !== storedCols) {
  state.cardsPerRow = clampedCols;
  Gallery.saveState(state);
} else {
  state.cardsPerRow = clampedCols;
}

function frameClass() {
  return ({ 'default': 'controller', '9x16': 'controller ar-9x16', '3x4': 'controller ar-3x4', 'landscape': 'controller landscape' })[state.controllerAR] || 'controller';
}
function dims() { return Gallery.CONTROLLER_AR_DIMS[state.controllerAR] || Gallery.CONTROLLER_AR_DIMS['default']; }

function sharedURL(s) {
  return s.staticPath
    ? Gallery.staticURL(state, s.staticPath, nonce || undefined)
    : Gallery.controllerURL(state, s.key, 0, null, nonce || undefined);
}

function buildSharedRow() {
  var row = document.createElement('div');
  row.className = 'scenario-row';

  var h = document.createElement('h3');
  var title = document.createElement('span'); title.textContent = 'Shared screens';
  var meta = document.createElement('span'); meta.className = 'row-meta';
  meta.textContent = 'no per-player variant';
  h.appendChild(title); h.appendChild(meta);
  row.appendChild(h);

  var strip = document.createElement('div');
  strip.className = 'scenario-strip wrap';
  strip.style.setProperty('--row-cols', state.cardsPerRow);

  var cards = [];
  for (var i = 0; i < SHARED_SCENARIOS.length; i++) {
    var s = SHARED_SCENARIOS[i];
    var card = Gallery.makeCard({
      title: s.title,
      tag: s.staticPath ? 'static' : '',
      frameClass: frameClass(),
      logical: dims(),
      url: sharedURL(s)
    });
    strip.appendChild(card);
    cards.push(card);
  }
  row.appendChild(strip);
  return { row: row, cards: cards };
}

function buildPerColorRow(s) {
  var row = document.createElement('div');
  row.className = 'scenario-row';

  var h = document.createElement('h3');
  var title = document.createElement('span'); title.textContent = s.title;
  var meta = document.createElement('span'); meta.className = 'row-meta';
  meta.textContent = '8 player colors';
  h.appendChild(title); h.appendChild(meta);
  row.appendChild(h);

  var strip = document.createElement('div');
  strip.className = 'scenario-strip wrap';
  strip.style.setProperty('--row-cols', state.cardsPerRow);

  var cards = [];
  for (var c = 0; c < 8; c++) {
    var card = Gallery.makeCard({
      title: 'P' + (c + 1),
      tag: Gallery.PLAYER_COLOR_NAMES[c],
      frameClass: frameClass(),
      logical: dims(),
      url: Gallery.controllerURL(state, s.key, c, s.extra, nonce || undefined)
    });
    strip.appendChild(card);
    cards.push(card);
  }
  row.appendChild(strip);
  return { row: row, cards: cards };
}

function render() {
  Gallery.resetQueue();
  var host = document.getElementById('controller-rows');
  host.innerHTML = '';

  var allCards = [];
  var shared = buildSharedRow();
  host.appendChild(shared.row);
  allCards = allCards.concat(shared.cards);

  for (var i = 0; i < PER_COLOR_SCENARIOS.length; i++) {
    var built = buildPerColorRow(PER_COLOR_SCENARIOS[i]);
    host.appendChild(built.row);
    allCards = allCards.concat(built.cards);
  }

  Gallery.lazyMount(allCards);
}

Gallery.bindSelect(state, 'controller-ar', 'controllerAR', render);
Gallery.bindNumber(state, 'player-count', 'players', 1, 8, render);
Gallery.bindNumber(state, 'level', 'level', 1, 15, render);
Gallery.bindSelect(state, 'language', 'lang', render);
Gallery.bindSelect(state, 'cards-per-row', 'cardsPerRow', render, function(v) { return parseInt(v, 10) || 8; });
document.getElementById('reload-all').addEventListener('click', function() {
  nonce = Date.now(); render();
});

state.players = parseInt(state.players, 10) || 4;
state.level = parseInt(state.level, 10) || 1;
state.cardsPerRow = parseInt(state.cardsPerRow, 10) || 8;

render();
