'use strict';

// Every display screen in one flat grid, ordered by the player's journey
// through a real session. Cards-per-row is set by the header control.
//
// Card shape:
//   { key, title, hostVariant?, level?, animated?, staticPath?, minPlayers? }
// hostVariant cards swap their `host` URL param when the view-as selector
// changes (no iframe rebuild). staticPath cards render /privacy or /imprint.
// minPlayers gates cards that need ≥N players (game effects need 4 boards).
var DISPLAY_CARDS = [
  { key: 'welcome',          title: 'Welcome' },
  { key: 'lobby',            title: 'Lobby (Standard)',   hostVariant: true },
  { key: 'airconsole-lobby', title: 'Lobby (AirConsole)', hostVariant: true },
  { key: 'countdown',        title: 'Countdown', replayable: true },
  { key: 'effects-combo',    title: 'Game (Normal · Lv 1)',  level: 1,  animated: true, minPlayers: 4, replayable: true },
  { key: 'effects-combo',    title: 'Game (Pillow · Lv 8)',  level: 8,  animated: true, minPlayers: 4, replayable: true },
  { key: 'effects-combo',    title: 'Game (Neon · Lv 12)',   level: 12, animated: true, minPlayers: 4, replayable: true },
  { key: 'reconnecting',     title: 'Reconnecting' },
  { key: 'pause',            title: 'Paused',       hostVariant: true },
  { key: 'disconnected',     title: 'Disconnected', hostVariant: true },
  { key: 'results',          title: 'Results',      hostVariant: true },
  { key: 'privacy',          title: 'Privacy', staticPath: '/privacy' },
  { key: 'imprint',          title: 'Imprint', staticPath: '/imprint' }
];

var state = Gallery.loadState();

// Display uses its own cards-per-row and players keys so switching between
// display and controller pages doesn't clobber each other's preference.
var DISPLAY_MAX_COLS = 5;
var DISPLAY_DEFAULT_COLS = 4;
var DISPLAY_DEFAULT_PLAYERS = 4;
var stored = parseInt(state.displayCardsPerRow, 10);
state.displayCardsPerRow = Math.max(1, Math.min(stored || DISPLAY_DEFAULT_COLS, DISPLAY_MAX_COLS));
state.displayPlayers = parseInt(state.displayPlayers, 10) || DISPLAY_DEFAULT_PLAYERS;
state.players = state.displayPlayers;
state.level = parseInt(state.level, 10) || 1;

// viewAs picks any of the 8 player slots — DisplayTestHarness resolves the
// host by stubbed clientId, so host tint works for slots beyond the active
// player count too.
function clampViewAs(v) {
  return Math.max(0, Math.min(v || 0, 7));
}

state.viewAs = clampViewAs(parseInt(state.viewAs, 10) || 0);

function dims() { return Gallery.DISPLAY_AR_DIMS[state.displayAR] || Gallery.DISPLAY_AR_DIMS['16x9']; }

var allCards = [];
// Host-variant cards paired with their scenario def, so viewAs changes can
// retarget each iframe with a new `host` param instead of re-rendering.
var hostVariantCards = [];

function cardURL(c) {
  if (c.staticPath) return Gallery.staticURL(state, c.staticPath);
  if (c.hostVariant) return Gallery.displayURL(state, c.key, undefined, { host: state.viewAs });
  return Gallery.displayURL(state, c.key, c.level);
}

function cardTag(c) {
  if (c.hostVariant) return Gallery.PLAYER_COLOR_NAMES[state.viewAs];
  if (c.animated) return 'anim';
  if (c.staticPath) return 'static';
  return '';
}

function render() {
  Gallery.resetQueue();
  var host = document.getElementById('display-rows');
  host.innerHTML = '';

  var strip = document.createElement('div');
  strip.className = 'scenario-strip';
  strip.style.setProperty('--row-cols', state.displayCardsPerRow);

  allCards = [];
  hostVariantCards = [];
  var d = dims();
  for (var i = 0; i < DISPLAY_CARDS.length; i++) {
    var c = DISPLAY_CARDS[i];
    if (c.minPlayers && state.players < c.minPlayers) continue;
    var card = Gallery.makeCard({
      title: c.title,
      tag: cardTag(c),
      frameClass: 'display',
      logical: d,
      url: cardURL(c),
      replayable: !!c.replayable
    });
    strip.appendChild(card);
    allCards.push(card);
    if (c.hostVariant) hostVariantCards.push({ card: card, scenario: c });
  }
  host.appendChild(strip);
  Gallery.lazyMount(allCards);
}

// viewAs swaps the `host` param on each host-variant card's iframe in place.
// Non-host-variant cards are left alone.
function updateViewAs() {
  var c = state.viewAs;
  var tag = Gallery.PLAYER_COLOR_NAMES[c];
  // If bindSelect's parse fn clamped the picked value, the <select> still
  // shows the raw pick; keep it in sync with state.viewAs so the dropdown
  // snaps back to the clamped option.
  var viewAsEl = document.getElementById('view-as-player');
  if (viewAsEl && viewAsEl.value !== String(c)) viewAsEl.value = String(c);
  for (var i = 0; i < hostVariantCards.length; i++) {
    var item = hostVariantCards[i];
    item.card._setUrl(cardURL(item.scenario));
    item.card._setLabel(item.scenario.title, tag);
  }
}

// AR change only affects frame geometry — re-layout existing cards.
function updateDims() {
  var d = dims();
  for (var i = 0; i < allCards.length; i++) {
    if (allCards[i]._applyDims) allCards[i]._applyDims(d, 0);
  }
}
function updateLayout() {
  var strips = document.querySelectorAll('.scenario-strip');
  for (var i = 0; i < strips.length; i++) {
    strips[i].style.setProperty('--row-cols', state.displayCardsPerRow);
  }
}

Gallery.bindSelect(state, 'display-ar', 'displayAR', updateDims);
Gallery.bindSelect(state, 'player-count', 'displayPlayers', function() {
  state.players = state.displayPlayers;
  render();
}, function(v) { return Math.max(1, Math.min(parseInt(v, 10) || DISPLAY_DEFAULT_PLAYERS, 8)); });
Gallery.bindSelect(state, 'view-as-player', 'viewAs', updateViewAs, function(v) {
  return clampViewAs(parseInt(v, 10) || 0);
});
Gallery.bindSelect(state, 'language', 'lang', render);
Gallery.bindSelect(state, 'cards-per-row', 'displayCardsPerRow', updateLayout, function(v) {
  return Math.max(1, Math.min(parseInt(v, 10) || DISPLAY_DEFAULT_COLS, DISPLAY_MAX_COLS));
});

Gallery.autoPauseOnHeaderFocus();
Gallery.initMobileOptionsToggle();
render();
