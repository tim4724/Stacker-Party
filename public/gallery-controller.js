'use strict';

// "Shared" row: screens that have no per-player variant — shown once at top.
var SHARED_SCENARIOS = [
  { key: 'name',            title: 'Name input' },
  { key: 'name-connecting', title: 'Connecting…', extra: { name: 'Tim' } },
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
  { key: 'playing-settings', title: 'Playing + Settings (non-host)', extra: { host: '' } },
  { key: 'playing-settings', title: 'Playing + Settings (host)',     extra: { host: '1' } },
  { key: 'paused',           title: 'Paused (non-host)',  extra: { host: '' } },
  { key: 'paused',           title: 'Paused (host)',      extra: { host: '1' } },
  { key: 'ko',               title: 'KO' },
  { key: 'reconnecting',     title: 'Reconnecting' },
  { key: 'disconnected',     title: 'Disconnected' },
  { key: 'results-winner',   title: 'Results (host)' },
  { key: 'results-loser',    title: 'Results (non-host)' }
];

var state = Gallery.loadState();
var nonce = 0;

// Controller uses its own cards-per-row and players keys so switching pages
// doesn't clobber the display page's preference (display caps at 5, controller
// at 8; controller defaults to 8 players so every color tint is on screen).
var CTRL_MAX_COLS = 8;
var CTRL_DEFAULT_PLAYERS = 8;
var stored = parseInt(state.controllerCardsPerRow, 10);
state.controllerCardsPerRow = Math.max(1, Math.min(stored || CTRL_MAX_COLS, CTRL_MAX_COLS));
state.controllerPlayers = parseInt(state.controllerPlayers, 10) || CTRL_DEFAULT_PLAYERS;
state.players = state.controllerPlayers;

function frameClass() { return 'controller'; }
function dims() {
  var d = Gallery.computeControllerDims(state);
  return { logical: { w: d.iframeW, h: d.iframeH }, chromePx: d.chromePx };
}

// Cards from the last render(); updateDims()/updateLayout() mutate these
// in place so URL-independent controls don't thrash the iframes.
var allCards = [];

function sharedURL(s) {
  return s.staticPath
    ? Gallery.staticURL(state, s.staticPath, nonce || undefined)
    : Gallery.controllerURL(state, s.key, 0, s.extra || null, nonce || undefined);
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
  strip.style.setProperty('--row-cols', state.controllerCardsPerRow);

  var cards = [];
  var d = dims();
  for (var i = 0; i < SHARED_SCENARIOS.length; i++) {
    var s = SHARED_SCENARIOS[i];
    var card = Gallery.makeCard({
      title: s.title,
      tag: s.staticPath ? 'static' : '',
      frameClass: frameClass(),
      logical: d.logical,
      chromePx: d.chromePx,
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

  var count = Math.max(1, Math.min(parseInt(state.players, 10) || 8, 8));

  var h = document.createElement('h3');
  var title = document.createElement('span'); title.textContent = s.title;
  var meta = document.createElement('span'); meta.className = 'row-meta';
  meta.textContent = count + ' player color' + (count === 1 ? '' : 's');
  h.appendChild(title); h.appendChild(meta);
  row.appendChild(h);

  var strip = document.createElement('div');
  strip.className = 'scenario-strip wrap';
  strip.style.setProperty('--row-cols', state.controllerCardsPerRow);

  var cards = [];
  var d = dims();
  for (var c = 0; c < count; c++) {
    var extra = s.extra ? Object.assign({}, s.extra) : {};
    if (typeof s.extraPerColor === 'function') {
      var perColor = s.extraPerColor(c) || {};
      Object.assign(extra, perColor);
    }
    var card = Gallery.makeCard({
      title: 'P' + (c + 1),
      tag: Gallery.PLAYER_COLOR_NAMES[c],
      frameClass: frameClass(),
      logical: d.logical,
      chromePx: d.chromePx,
      url: Gallery.controllerURL(state, s.key, c, extra, nonce || undefined)
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

  allCards = [];
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

// Device / orientation / chrome don't change iframe URLs — just re-layout
// the existing cards so the loaded content is preserved.
function updateDims() {
  var d = dims();
  for (var i = 0; i < allCards.length; i++) {
    if (allCards[i]._applyDims) allCards[i]._applyDims(d.logical, d.chromePx);
  }
}
// Cards-per-row only changes the grid column count on each strip.
function updateLayout() {
  var strips = document.querySelectorAll('.scenario-strip');
  for (var i = 0; i < strips.length; i++) {
    strips[i].style.setProperty('--row-cols', state.controllerCardsPerRow);
  }
}

Gallery.bindSelect(state, 'controller-device', 'controllerDevice', updateDims);
Gallery.bindSelect(state, 'controller-orientation', 'controllerOrientation', updateDims);
Gallery.bindCheckbox(state, 'controller-chrome', 'controllerBrowserChrome', updateDims);
Gallery.bindNumber(state, 'player-count', 'controllerPlayers', 1, 8, function() {
  state.players = state.controllerPlayers;
  render();
});
Gallery.bindSelect(state, 'language', 'lang', render);
Gallery.bindSelect(state, 'cards-per-row', 'controllerCardsPerRow', updateLayout, function(v) { return parseInt(v, 10) || 8; });
document.getElementById('reload-all').addEventListener('click', function() {
  nonce = Date.now(); render();
});

state.level = parseInt(state.level, 10) || 1;
state.controllerCardsPerRow = parseInt(state.controllerCardsPerRow, 10) || 8;

Gallery.autoPauseOnHeaderFocus();
render();
