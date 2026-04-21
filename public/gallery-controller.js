'use strict';

// Every controller screen in one flat grid, ordered by the player's journey
// through a real session (name entry -> lobby -> play -> end). perColor cards
// swap the `color` URL param when the view-as selector changes; staticPath
// cards render /privacy or /imprint.
//
// Card shape:
//   { key, title, perColor?, staticPath?, extra? }
// `extra` is merged into the URL (e.g. host=1 flags the host variant of a
// screen that otherwise looks the same for host/non-host).
var CONTROLLER_CARDS = [
  { key: 'name',             title: 'Name input' },
  { key: 'name-connecting',  title: 'Connecting…', extra: { name: 'Tim' } },
  { key: 'lobby-host',       title: 'Lobby (host)',        perColor: true },
  { key: 'lobby-waiting',    title: 'Lobby (waiting)',     perColor: true },
  { key: 'lobby-latejoiner', title: 'Lobby (late joiner)', perColor: true },
  { key: 'countdown',        title: 'Countdown',           perColor: true },
  { key: 'playing',          title: 'Playing',             perColor: true },
  { key: 'ko',               title: 'KO',                  perColor: true },
  { key: 'playing-settings', title: 'Settings (host)',     perColor: true, extra: { host: '1' } },
  { key: 'playing-settings', title: 'Settings (non-host)', perColor: true, extra: { host: '' } },
  { key: 'paused',           title: 'Paused (host)',       perColor: true, extra: { host: '1' }, replayable: true },
  { key: 'paused',           title: 'Paused (non-host)',   perColor: true, extra: { host: '' }, replayable: true },
  { key: 'reconnecting',     title: 'Reconnecting',        perColor: true },
  { key: 'disconnected',     title: 'Disconnected',        perColor: true },
  { key: 'results-winner',   title: 'Results (host)',      perColor: true, replayable: true },
  { key: 'results-loser',    title: 'Results (non-host)',  perColor: true },
  { key: 'end',              title: 'Game ended', replayable: true },
  { key: 'end-full',         title: 'Room full',  replayable: true },
  { key: 'privacy',          title: 'Privacy', staticPath: '/privacy' },
  { key: 'imprint',          title: 'Imprint', staticPath: '/imprint' }
];

var state = Gallery.loadState();

// Controller uses its own cards-per-row and players keys so switching pages
// doesn't clobber the display page's preference (display caps at 5, controller
// at 8; controller defaults to 8 players so every color tint is available
// in the view-as selector).
var CTRL_MAX_COLS = 8;
var CTRL_DEFAULT_PLAYERS = 8;
var stored = parseInt(state.controllerCardsPerRow, 10);
state.controllerCardsPerRow = Math.max(1, Math.min(stored || CTRL_MAX_COLS, CTRL_MAX_COLS));
state.controllerPlayers = parseInt(state.controllerPlayers, 10) || CTRL_DEFAULT_PLAYERS;
state.players = state.controllerPlayers;
state.level = parseInt(state.level, 10) || 1;

// viewAs is independent of player count: the scenario harness fakes player 7
// in the 4-player roster when needed so "View as Player 7 · Players: 4" is
// a valid combo (shows 3 random players + player 7).
function clampViewAs(v) {
  return Math.max(0, Math.min(v || 0, 7));
}

state.viewAs = clampViewAs(parseInt(state.viewAs, 10) || 0);

function dims() {
  var d = Gallery.computeControllerDims(state);
  return { logical: { w: d.iframeW, h: d.iframeH }, chromePx: d.chromePx };
}

var allCards = [];
// Per-color cards paired with their scenario def, so viewAs changes can
// retarget each iframe with a new `color` param instead of re-rendering.
var perColorCards = [];

function cardURL(c) {
  if (c.staticPath) return Gallery.staticURL(state, c.staticPath);
  var colorIdx = c.perColor ? state.viewAs : 0;
  return Gallery.controllerURL(state, c.key, colorIdx, c.extra || null);
}

function cardTag(c) {
  if (c.perColor) return Gallery.PLAYER_COLOR_NAMES[state.viewAs];
  if (c.staticPath) return 'static';
  return '';
}

function render() {
  Gallery.resetQueue();
  var host = document.getElementById('controller-rows');
  host.innerHTML = '';

  var strip = document.createElement('div');
  strip.className = 'scenario-strip';
  strip.style.setProperty('--row-cols', state.controllerCardsPerRow);

  allCards = [];
  perColorCards = [];
  var d = dims();
  for (var i = 0; i < CONTROLLER_CARDS.length; i++) {
    var c = CONTROLLER_CARDS[i];
    var card = Gallery.makeCard({
      title: c.title,
      tag: cardTag(c),
      frameClass: 'controller',
      logical: d.logical,
      chromePx: d.chromePx,
      url: cardURL(c),
      replayable: !!c.replayable
    });
    strip.appendChild(card);
    allCards.push(card);
    if (c.perColor) perColorCards.push({ card: card, scenario: c });
  }
  host.appendChild(strip);
  Gallery.lazyMount(allCards);
}

// viewAs swaps the `color` param on each per-color card's iframe in place —
// non-per-color cards (name input, legal, end screens) are left alone.
function updateViewAs() {
  var c = state.viewAs;
  var tag = Gallery.PLAYER_COLOR_NAMES[c];
  // If bindSelect's parse fn clamped the picked value, the <select> still
  // shows the raw pick; keep it in sync with state.viewAs so the dropdown
  // snaps back to the clamped option.
  var viewAsEl = document.getElementById('view-as-player');
  if (viewAsEl && viewAsEl.value !== String(c)) viewAsEl.value = String(c);
  for (var i = 0; i < perColorCards.length; i++) {
    var item = perColorCards[i];
    item.card._setUrl(cardURL(item.scenario));
    item.card._setLabel(item.scenario.title, tag);
  }
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
Gallery.bindSelect(state, 'player-count', 'controllerPlayers', function() {
  state.players = state.controllerPlayers;
  render();
}, function(v) { return Math.max(1, Math.min(parseInt(v, 10) || CTRL_DEFAULT_PLAYERS, 8)); });
Gallery.bindSelect(state, 'view-as-player', 'viewAs', updateViewAs, function(v) {
  return clampViewAs(parseInt(v, 10) || 0);
});
Gallery.bindSelect(state, 'language', 'lang', render);
Gallery.bindSelect(state, 'cards-per-row', 'controllerCardsPerRow', updateLayout, function(v) {
  return Math.max(1, Math.min(parseInt(v, 10) || CTRL_MAX_COLS, CTRL_MAX_COLS));
});

Gallery.autoPauseOnHeaderFocus();
Gallery.initMobileOptionsToggle();
render();
