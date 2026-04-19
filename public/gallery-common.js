'use strict';

// =====================================================================
// Shared gallery helpers — card factory, URL builder, lazy loading,
// state persisted in localStorage so settings survive page nav.
// =====================================================================

var Gallery = (function() {
  var PLAYER_COLOR_NAMES = ['red', 'tangerine', 'honey', 'mint', 'teal', 'indigo', 'violet', 'magenta'];

  var DISPLAY_AR_DIMS = {
    '16x9': { w: 1920, h: 1080 },
    '21x9': { w: 2560, h: 1080 },
    '4x3':  { w: 1600, h: 1200 },
    '1x1':  { w: 1200, h: 1200 }
  };

  // Controller preview devices. Dimensions are CSS pixels in the device's
  // native portrait orientation. Orientation + browser-chrome toggles in the
  // UI derive the final iframe dims from these base values.
  var CONTROLLER_DEVICES = [
    { id: 'iphone15pm', label: 'iPhone 15 Pro Max', w: 430, h: 932 },
    { id: 'iphone14',   label: 'iPhone 14',         w: 390, h: 844 },
    { id: 'iphonese',   label: 'iPhone SE (3rd)',   w: 375, h: 667 },
    { id: 'pixel8',     label: 'Pixel 8',           w: 412, h: 915 },
    { id: 'galaxys23',  label: 'Galaxy S23',        w: 360, h: 780 },
    { id: 'zfoldcover', label: 'Galaxy Z Fold cover', w: 280, h: 653 }
  ];
  // Approximate visible browser chrome (address bar + system UI) that steals
  // viewport height when the page is not in fullscreen mode.
  var BROWSER_CHROME = { portrait: 120, landscape: 48 };

  function findDevice(id) {
    for (var i = 0; i < CONTROLLER_DEVICES.length; i++) {
      if (CONTROLLER_DEVICES[i].id === id) return CONTROLLER_DEVICES[i];
    }
    return CONTROLLER_DEVICES[1]; // iPhone 14 fallback
  }
  function computeControllerDims(state) {
    var dev = findDevice(state.controllerDevice);
    var w = dev.w, h = dev.h;
    if (state.controllerOrientation === 'landscape') { var t = w; w = h; h = t; }
    var chromePx = state.controllerBrowserChrome
      ? BROWSER_CHROME[state.controllerOrientation === 'landscape' ? 'landscape' : 'portrait']
      : 0;
    // iframeH is the page's visible viewport (device minus chrome). chromePx
    // renders as a gray bar above the iframe; the card's total aspect ratio
    // stays at the device's physical dims so devices are comparable on-screen.
    return { iframeW: w, iframeH: h - chromePx, chromePx: chromePx, label: dev.label };
  }

  var STATE_KEY = 'hex_gallery_state_v1';
  var defaults = {
    displayAR: '16x9',
    controllerDevice: 'iphone14',
    controllerOrientation: 'portrait',
    controllerBrowserChrome: false,
    players: 4,
    viewAs: 0,
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

  function displayURL(state, scenario, nonce, levelOverride, extra) {
    var p = {
      test: 1, bg: 1, lang: state.lang,
      scenario: scenario,
      players: state.players,
      level: levelOverride !== undefined ? levelOverride : state.level,
      _r: nonce || undefined
    };
    if (extra) for (var k in extra) p[k] = extra[k];
    return '/' + qs(p);
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
  // Paused while a header <select> popup is (or may be) open. Chrome closes
  // open <select> popups whenever an iframe load completes in the same
  // document, so we hold off starting new loads while the popup is visible.
  var paused = false;
  var pauseSafetyTimer = null;
  var PAUSE_SAFETY_MS = 3000;
  function setLoadingPaused(p) {
    if (paused === p) return;
    paused = p;
    clearTimeout(pauseSafetyTimer);
    pauseSafetyTimer = null;
    if (paused) {
      // Safety net: if a resume event is missed (focus stolen, devtools, etc.)
      // never stay paused longer than PAUSE_SAFETY_MS.
      pauseSafetyTimer = setTimeout(function() { setLoadingPaused(false); }, PAUSE_SAFETY_MS);
    } else {
      _drain();
    }
  }
  function _drain() {
    while (!paused && active < MAX_CONCURRENT && queue.length) {
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
  // Drop pending work but let in-flight loads finish naturally — zeroing
  // `active` here would push it negative as their `finish` callbacks fire.
  function resetQueue() { queue = []; }

  // Auto-pause loading while a header <select> popup is open. Only selects
  // need this — buttons and number inputs have no popup that an iframe load
  // can clobber, and pausing on them caused stuck-paused states (e.g. the
  // reload button's pointerdown flipped pause=true but no focusout followed
  // because buttons don't retain focus on click).
  //
  // pointerdown is wired because Chrome may open the popup before focus
  // events fire, and we want the queue paused before any new load starts.
  // change resumes immediately (spec: popup is closed by the time change
  // fires), so the just-selected scenario renders without waiting for the
  // user to click outside the header.
  function autoPauseOnHeaderFocus() {
    var hdr = document.querySelector('header');
    if (!hdr) return;
    var selects = hdr.querySelectorAll('select');
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      sel.addEventListener('pointerdown', function() { setLoadingPaused(true); });
      sel.addEventListener('focus', function() { setLoadingPaused(true); });
      sel.addEventListener('change', function() { setLoadingPaused(false); });
      sel.addEventListener('blur', function() { setLoadingPaused(false); });
    }
  }

  // --- Card factory ---
  function makeCard(opts) {
    // opts: { title, tag, frameClass, logical, url, loadNow }
    var card = document.createElement('div');
    card.className = 'card';

    var head = document.createElement('div');
    head.className = 'card-title';
    var title = document.createElement('span');
    var titleText = document.createTextNode(opts.title);
    title.appendChild(titleText);
    var tagEl = document.createElement('span');
    tagEl.className = 'tag';
    tagEl.textContent = opts.tag ? ' ' + opts.tag : '';
    title.appendChild(tagEl);
    head.appendChild(title);

    var actions = document.createElement('div'); actions.className = 'actions';
    // Replay button calls window.__TEST__.replay() inside the iframe so
    // animated scenarios (countdown, effects, entrance animations) can be
    // re-run without reloading the iframe. Scenarios that don't expose
    // __TEST__.replay silently no-op if the button is somehow clicked.
    if (opts.replayable) {
      var replayBtn = document.createElement('button');
      replayBtn.className = 'card-btn'; replayBtn.textContent = '▶';
      replayBtn.title = 'Replay animation';
      replayBtn.addEventListener('click', function() {
        try {
          var win = iframe.contentWindow;
          var fn = win && win.__TEST__ && win.__TEST__.replay;
          if (typeof fn === 'function') fn();
        } catch (_) { /* cross-origin or iframe not ready */ }
      });
      actions.appendChild(replayBtn);
    }
    var link = document.createElement('a');
    link.className = 'open-link'; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = 'open ↗'; link.href = opts.url;
    actions.appendChild(link);
    head.appendChild(actions);
    card.appendChild(head);

    var wrap = document.createElement('div');
    wrap.className = 'frame-wrap ' + opts.frameClass + ' pending';
    var chromeBar = document.createElement('div');
    chromeBar.className = 'chrome-bar';
    wrap.appendChild(chromeBar);
    var iframe = document.createElement('iframe');
    iframe.setAttribute('title', opts.title);
    wrap.appendChild(iframe);
    card.appendChild(wrap);

    // Mutable dim state — applyDims lets callers re-layout an existing card
    // (device swap, orientation flip, chrome toggle) without rebuilding the
    // iframe, preserving its loaded content.
    var curW = opts.logical.w, curH = opts.logical.h, curChrome = opts.chromePx || 0;

    function applyDims(logical, chromePx) {
      curW = logical.w; curH = logical.h; curChrome = chromePx || 0;
      var totalH = curH + curChrome;
      wrap.style.aspectRatio = curW + ' / ' + totalH;
      if (curChrome > 0) {
        var pct = (curChrome / totalH * 100) + '%';
        chromeBar.style.display = 'block';
        chromeBar.style.height = pct;
        iframe.style.top = pct;
      } else {
        chromeBar.style.display = 'none';
        iframe.style.top = '0';
      }
      iframe.style.width = curW + 'px';
      iframe.style.height = curH + 'px';
      rescale();
    }
    function rescale() {
      var rect = wrap.getBoundingClientRect();
      if (!rect.width) return;
      iframe.style.transform = 'scale(' + (rect.width / curW) + ')';
    }
    applyDims(opts.logical, opts.chromePx || 0);
    requestAnimationFrame(rescale);
    new ResizeObserver(rescale).observe(wrap);

    function loadUrl(url) {
      link.href = url;
      enqueueLoad(iframe, url, function() {
        wrap.classList.remove('pending');
        card._loaded = true;
      });
    }

    card._loadUrl = loadUrl;
    card._initialUrl = opts.url;
    card._applyDims = applyDims;
    card._setLabel = function(newTitle, newTag) {
      titleText.nodeValue = newTitle;
      tagEl.textContent = newTag ? ' ' + newTag : '';
      iframe.setAttribute('title', newTitle);
    };
    // Retarget the card to a new URL. For already-mounted cards this swaps
    // the iframe src in place (no DOM rebuild); for cards still awaiting
    // lazy-mount it just updates what lazyMount will load when they scroll in.
    card._setUrl = function(url) {
      card._initialUrl = url;
      if (card._loaded) {
        wrap.classList.add('pending');
        loadUrl(url);
      } else {
        link.href = url;
      }
    };
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

  // --- Mobile options toggle ---
  // Collapses the option groups behind a toggle on narrow screens. The button
  // is hidden at wider widths via CSS, so this handler is a no-op there.
  function initMobileOptionsToggle() {
    var toggle = document.getElementById('options-toggle');
    var hdr = document.querySelector('header');
    if (!toggle || !hdr) return;
    toggle.addEventListener('click', function() {
      var open = hdr.classList.toggle('options-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? '✕' : '⚙';
      toggle.setAttribute('aria-label', open ? 'Close options' : 'Options');
    });
  }

  // --- Shared control binders ---
  // state is mutated in place so all consumers observe the updated value
  // without an explicit get/set dance.
  function bindSelect(state, id, key, onChange, parse) {
    var el = document.getElementById(id);
    if (!el) return;
    if (state[key] !== undefined) el.value = String(state[key]);
    el.addEventListener('change', function(e) {
      state[key] = parse ? parse(e.target.value) : e.target.value;
      saveState(state); onChange();
    });
  }
  function bindNumber(state, id, key, min, max, onChange) {
    var el = document.getElementById(id);
    if (!el) return;
    el.value = String(state[key]);
    el.addEventListener('input', function(e) {
      var v = Math.max(min, Math.min(parseInt(e.target.value, 10) || min, max));
      state[key] = v; saveState(state); onChange();
    });
  }
  function bindCheckbox(state, id, key, onChange) {
    var el = document.getElementById(id);
    if (!el) return;
    el.checked = !!state[key];
    el.addEventListener('change', function(e) {
      state[key] = !!e.target.checked; saveState(state); onChange();
    });
  }

  return {
    PLAYER_COLOR_NAMES: PLAYER_COLOR_NAMES,
    DISPLAY_AR_DIMS: DISPLAY_AR_DIMS,
    CONTROLLER_DEVICES: CONTROLLER_DEVICES,
    BROWSER_CHROME: BROWSER_CHROME,
    computeControllerDims: computeControllerDims,
    loadState: loadState,
    saveState: saveState,
    displayURL: displayURL,
    controllerURL: controllerURL,
    staticURL: staticURL,
    makeCard: makeCard,
    lazyMount: lazyMount,
    resetQueue: resetQueue,
    setLoadingPaused: setLoadingPaused,
    autoPauseOnHeaderFocus: autoPauseOnHeaderFocus,
    initMobileOptionsToggle: initMobileOptionsToggle,
    bindSelect: bindSelect,
    bindNumber: bindNumber,
    bindCheckbox: bindCheckbox
  };
})();
