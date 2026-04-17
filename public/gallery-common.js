'use strict';

// =====================================================================
// Shared gallery helpers — card factory, URL builder, lazy loading,
// state persisted in localStorage so settings survive page nav.
// =====================================================================

var Gallery = (function() {
  var PLAYER_COLOR_NAMES = ['red', 'teal', 'yellow', 'purple', 'green', 'magenta', 'indigo', 'coral'];

  var DISPLAY_AR_DIMS = {
    '16x9': { w: 1920, h: 1080 },
    '21x9': { w: 2560, h: 1080 },
    '4x3':  { w: 1600, h: 1200 },
    '1x1':  { w: 1200, h: 1200 }
  };
  var CONTROLLER_AR_DIMS = {
    'default':   { w: 390, h: 844 },
    '9x16':      { w: 390, h: 693 },
    '3x4':       { w: 390, h: 520 },
    'landscape': { w: 844, h: 390 }
  };

  var STATE_KEY = 'hex_gallery_state_v1';
  var defaults = {
    displayAR: '16x9',
    controllerAR: 'default',
    players: 4,
    level: 1,
    lang: 'en',
    cardWidth: 440,
    rowCardWidth: 180
  };
  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (!raw) return Object.assign({}, defaults);
      return Object.assign({}, defaults, JSON.parse(raw));
    } catch (e) { return Object.assign({}, defaults); }
  }
  function saveState(state) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // --- URL helpers ---
  function qs(obj) {
    var parts = [];
    for (var k in obj) {
      if (obj[k] === undefined || obj[k] === null || obj[k] === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  function displayURL(state, scenario, nonce, levelOverride) {
    return '/' + qs({
      test: 1, bg: 1, lang: state.lang,
      scenario: scenario,
      players: state.players,
      level: levelOverride !== undefined ? levelOverride : state.level,
      _r: nonce || undefined
    });
  }

  // Static pages (privacy, imprint) accept only ?lang and a cache-bust.
  function staticURL(state, path, nonce) {
    return path + qs({ lang: state.lang, _r: nonce || undefined });
  }

  function controllerURL(state, scenario, colorIdx, extra, nonce) {
    var p = {
      test: 1, bg: 1, lang: state.lang,
      scenario: scenario,
      color: colorIdx,
      level: state.level,
      players: state.players,
      _r: nonce || undefined
    };
    if (extra) for (var k in extra) p[k] = extra[k];
    // First path segment is the controller's roomCode — any value works in test mode.
    return '/GALLERY' + qs(p);
  }

  // --- Lazy loading queue ---
  // Limits concurrent iframe loads so we don't blow past browser connection
  // limits (ERR_INSUFFICIENT_RESOURCES). Queue drains when iframes emit
  // 'load' events or after a timeout fallback.
  var MAX_CONCURRENT = 6;
  var active = 0;
  var queue = [];
  function _drain() {
    while (active < MAX_CONCURRENT && queue.length) {
      // Use `let` so each iteration closes over its own task/done/iframe.
      // With `var` (function-scoped), every concurrent `finish` would share
      // the same `done` and the first completion would silently no-op the rest.
      let task = queue.shift();
      let iframe = task.iframe;
      let url = task.url;
      let done = false;
      active++;
      let finish = function() {
        if (done) return; done = true;
        active--;
        task.onDone && task.onDone();
        _drain();
      };
      iframe.addEventListener('load', finish, { once: true });
      iframe.addEventListener('error', finish, { once: true });
      // Fallback: treat 8s without load event as done.
      setTimeout(finish, 8000);
      iframe.src = url;
    }
  }
  function enqueueLoad(iframe, url, onDone) {
    queue.push({ iframe: iframe, url: url, onDone: onDone });
    _drain();
  }
  function resetQueue() { queue = []; active = 0; }

  // --- Card factory ---
  function makeCard(opts) {
    // opts: { title, tag, frameClass, logical, url, loadNow }
    var card = document.createElement('div');
    card.className = 'card';

    var head = document.createElement('div');
    head.className = 'card-title';
    var title = document.createElement('span');
    title.textContent = opts.title;
    if (opts.tag) {
      var sp = document.createElement('span'); sp.className = 'tag'; sp.textContent = ' ' + opts.tag;
      title.appendChild(sp);
    }
    head.appendChild(title);

    var actions = document.createElement('div'); actions.className = 'actions';
    var reload = document.createElement('button');
    reload.className = 'card-btn'; reload.textContent = '↻'; reload.title = 'Reload this card';
    actions.appendChild(reload);
    var link = document.createElement('a');
    link.className = 'open-link'; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = 'open ↗'; link.href = opts.url;
    actions.appendChild(link);
    head.appendChild(actions);
    card.appendChild(head);

    var wrap = document.createElement('div');
    wrap.className = 'frame-wrap ' + opts.frameClass + ' pending';
    var iframe = document.createElement('iframe');
    iframe.setAttribute('title', opts.title);
    iframe.style.width = opts.logical.w + 'px';
    iframe.style.height = opts.logical.h + 'px';
    wrap.appendChild(iframe);
    card.appendChild(wrap);

    function rescale() {
      var rect = wrap.getBoundingClientRect();
      if (!rect.width) return;
      iframe.style.transform = 'scale(' + (rect.width / opts.logical.w) + ')';
    }
    requestAnimationFrame(rescale);
    new ResizeObserver(rescale).observe(wrap);

    function loadUrl(url) {
      link.href = url;
      enqueueLoad(iframe, url, function() { wrap.classList.remove('pending'); });
    }

    reload.addEventListener('click', function() {
      var u = new URL(iframe.src || opts.url, location.origin);
      u.searchParams.set('_r', Date.now());
      wrap.classList.add('pending');
      loadUrl(u.pathname + u.search);
    });

    card._loadUrl = loadUrl;
    card._initialUrl = opts.url;
    return card;
  }

  // --- Intersection-based lazy mount ---
  // Observes cards and calls loadUrl only when they approach viewport.
  // Avoids slamming the browser with 128 concurrent iframe loads on
  // initial render of the controller page.
  function lazyMount(cards) {
    if (!('IntersectionObserver' in window)) {
      // Graceful fallback: load all sequentially.
      for (var i = 0; i < cards.length; i++) cards[i]._loadUrl(cards[i]._initialUrl);
      return;
    }
    var io = new IntersectionObserver(function(entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          var c = entries[i].target;
          io.unobserve(c);
          c._loadUrl(c._initialUrl);
        }
      }
    }, { rootMargin: '400px 0px' });
    for (var j = 0; j < cards.length; j++) io.observe(cards[j]);
  }

  // --- Shared control binders ---
  // state is mutated in place so all consumers observe the updated value
  // without an explicit get/set dance.
  function bindSelect(state, id, key, onChange, parse) {
    var el = document.getElementById(id);
    if (el && state[key] !== undefined) el.value = String(state[key]);
    el.addEventListener('change', function(e) {
      state[key] = parse ? parse(e.target.value) : e.target.value;
      saveState(state); onChange();
    });
  }
  function bindNumber(state, id, key, min, max, onChange) {
    var el = document.getElementById(id);
    if (el) el.value = String(state[key]);
    el.addEventListener('input', function(e) {
      var v = Math.max(min, Math.min(parseInt(e.target.value, 10) || min, max));
      state[key] = v; saveState(state); onChange();
    });
  }

  return {
    PLAYER_COLOR_NAMES: PLAYER_COLOR_NAMES,
    DISPLAY_AR_DIMS: DISPLAY_AR_DIMS,
    CONTROLLER_AR_DIMS: CONTROLLER_AR_DIMS,
    loadState: loadState,
    saveState: saveState,
    displayURL: displayURL,
    controllerURL: controllerURL,
    staticURL: staticURL,
    makeCard: makeCard,
    lazyMount: lazyMount,
    resetQueue: resetQueue,
    bindSelect: bindSelect,
    bindNumber: bindNumber
  };
})();
