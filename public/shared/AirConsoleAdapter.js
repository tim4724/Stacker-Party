'use strict';

/**
 * AirConsoleAdapter — wraps the AirConsole API behind the PartyConnection interface.
 *
 * This allows existing game code (DisplayConnection, ControllerConnection, etc.)
 * to work without modification when running inside AirConsole.
 *
 * Usage:
 *   var airconsole = new AirConsole({ orientation: ... });
 *   party = new AirConsoleAdapter(airconsole, { role: 'display' });
 *   party.onProtocol = function(...) { ... };
 *   party.onMessage = function(...) { ... };
 *   party.connect();  // triggers onReady synthesis
 */
class AirConsoleAdapter {
  constructor(airconsole, options) {
    this.airconsole = airconsole;
    this.role = (options && options.role) || 'display';
    this._ready = false;
    this._acReady = false;
    this._acReadyCode = null;
    this._connectCalled = false;
    this.reconnectAttempt = 0;
    this.maxReconnectAttempts = 5;

    // Callbacks (same signature as PartyConnection)
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;     // no-op — AirConsole SDK has no error callback equivalent
    this.onMessage = null;
    this.onProtocol = null;

    this._wireAirConsole();
  }

  _wireAirConsole() {
    var self = this;
    var ac = this.airconsole;

    ac.onReady = function(code) {
      // Apply the AC-profile locale before firing 'created'/'joined' so the
      // lobby renders with the right strings on first paint. Per the AC
      // checklist, the screen and controllers may have different languages
      // — each device picks its own.
      AirConsoleAdapter.applyLocale(ac);
      self._acReady = true;
      self._acReadyCode = code;
      // If connect() was already called, fire the protocol synthesis now.
      // Otherwise, connect() will fire it when called.
      if (self._connectCalled) {
        self._fireReady();
      }
    };

    ac.onConnect = function(device_id) {
      if (device_id === AirConsole.SCREEN) return;
      if (self.role === 'display') {
        if (self.onProtocol) self.onProtocol('peer_joined', { clientId: String(device_id) });
      }
    };

    ac.onDisconnect = function(device_id) {
      if (device_id === AirConsole.SCREEN) {
        if (self.role === 'controller') {
          if (self.onProtocol) self.onProtocol('peer_left', { clientId: 'display' });
        }
        return;
      }
      if (self.role === 'display') {
        if (self.onProtocol) self.onProtocol('peer_left', { clientId: String(device_id) });
      }
    };

    ac.onMessage = function(device_id, data) {
      if (self.role === 'display') {
        if (device_id === AirConsole.SCREEN) return; // ignore own broadcasts echoed back
        if (self.onMessage) self.onMessage(String(device_id), data);
      } else {
        if (device_id === AirConsole.SCREEN) {
          if (self.onMessage) self.onMessage('display', data);
        }
      }
    };

    // A premium upgrade can change which controller AirConsole considers the
    // master (premium devices get priority). Signal the display so it can
    // re-broadcast host info. onConnect / onDisconnect already do this via
    // peer_joined / peer_left.
    ac.onPremium = function() {
      if (self.role === 'display' && self.onProtocol) {
        self.onProtocol('master_changed', {});
      }
    };
  }

  /**
   * Display-only: returns the AirConsole master controller device id as a
   * string clientId, or null when no controller is connected or we're not in
   * AirConsole mode. Premium devices are prioritized by AirConsole itself.
   */
  getMasterClientId() {
    if (this.role !== 'display') return null;
    var id = this.airconsole.getMasterControllerDeviceId();
    return (id === undefined || id === null) ? null : String(id);
  }

  _fireReady() {
    if (this._ready) return;
    this._ready = true;
    var code = this._acReadyCode || 'airconsole';
    if (this.onOpen) this.onOpen();

    if (this.role === 'display') {
      if (this.onProtocol) this.onProtocol('created', { room: code });
      // Re-synthesize peer_joined for already-connected controllers.
      // When Play Again / New Game recreates the adapter, AirConsole won't
      // re-fire onConnect for controllers that are already connected.
      var self = this;
      var ids = this.airconsole.getControllerDeviceIds();
      for (var i = 0; i < ids.length; i++) {
        if (self.onProtocol) self.onProtocol('peer_joined', { clientId: String(ids[i]) });
      }
    } else {
      if (this.onProtocol) this.onProtocol('joined', { room: code, clients: [] }); // peers delivered via peer_joined from display
    }
  }

  // --- PartyConnection-compatible interface ---

  /**
   * connect() is called by DisplayConnection / ControllerConnection after
   * setting up all the callbacks. This triggers the onReady synthesis.
   */
  connect() {
    this._connectCalled = true;
    // If AirConsole already fired onReady, synthesize protocol events now
    if (this._acReady) {
      this._fireReady();
    }
  }

  sendTo(to, data) {
    if (to === 'display') {
      if (this.role === 'display') {
        // Async self-echo for heartbeat compatibility.
        var self = this;
        setTimeout(function() { if (self.onMessage) self.onMessage('display', data); }, 0);
        return;
      }
      this.airconsole.message(AirConsole.SCREEN, data);
    } else {
      var id = parseInt(to, 10);
      if (isNaN(id)) { console.warn('[AirConsoleAdapter] sendTo: invalid device ID "' + to + '"'); return; }
      this.airconsole.message(id, data);
    }
  }

  broadcast(data) {
    this.airconsole.broadcast(data);
  }

  // No-ops — AirConsole handles connection lifecycle.
  // reconnectAttempt stays 0 and is never incremented because the heartbeat
  // self-echo always succeeds in AirConsole mode (displayDead is always false).
  create() {}
  join() {}
  reconnectNow() {}
  resetReconnectCount() { this.reconnectAttempt = 0; }

  close() {
    this._ready = false;
    // Clear adapter callbacks (prevents stale setTimeout self-echo from firing)
    this.onOpen = this.onClose = this.onError = this.onMessage = this.onProtocol = null;
    // Neutralize SDK callbacks without nulling them — the AirConsole SDK
    // invokes these on its own schedule (e.g. queued postMessage events that
    // arrive between our close() and the next adapter's _wireAirConsole), and
    // nulling `ac.onMessage` crashes the SDK with
    // "TypeError: me.onMessage is not a function". No-op functions keep the
    // SDK safe while still preventing this adapter's stale state from
    // receiving events; the next adapter will overwrite them in turn.
    var ac = this.airconsole;
    var noop = function() {};
    ac.onReady = ac.onConnect = ac.onDisconnect = ac.onMessage = ac.onPremium = noop;
  }

  get connected() {
    return this._ready;
  }

  // Replace window.localStorage with a shim backed by AirConsole's per-UID
  // persistent-data API. Only an allowlist of keys actually round-trips —
  // display-music mute, player name, and clientId are deliberately excluded
  // so that music defaults on every session and AC owns identity. The shim
  // is synchronous from the caller's perspective: reads return cached values
  // populated by onPersistentDataLoaded, writes go through immediately
  // (no debounce). Subscribers can wait for first hydration via onLoad().
  static installAirConsoleStorage(airconsole) {
    var ALLOWLIST = {
      stacker_haptic_strength: 1,
      stacker_touch_sensitivity: 1,
      stacker_touch_sounds: 1,
      stacker_color_index: 1
    };
    var cache = {};
    var loaded = false;
    var loadCallbacks = [];

    function getUid() {
      try {
        var id = airconsole.getDeviceId();
        return airconsole.getUID(id) || null;
      } catch (e) { return null; }
    }

    var prevOnLoaded = airconsole.onPersistentDataLoaded;
    airconsole.onPersistentDataLoaded = function(data) {
      var uid = getUid();
      var entry = (uid && data && data[uid]) || {};
      // Merge — don't replace. A user-side setItem between requestLoad and
      // the server response shouldn't be silently clobbered: the request
      // reflects state at request time, so its response can be stale
      // relative to what the user just wrote. Any key already in cache is
      // therefore the local source of truth; only fill empties from server.
      for (var k in entry) {
        if (ALLOWLIST[k] && entry[k] !== null && entry[k] !== undefined && !(k in cache)) {
          cache[k] = String(entry[k]);
        }
      }
      loaded = true;
      var cbs = loadCallbacks.slice();
      loadCallbacks.length = 0;
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](); } catch (e) { console.error('[storage] onLoad', e); }
      }
      if (prevOnLoaded) prevOnLoaded.call(airconsole, data);
    };

    var shim = {
      getItem: function(key) {
        return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
      },
      setItem: function(key, value) {
        if (!ALLOWLIST[key]) return;
        var v = String(value);
        // Skip the SDK round-trip when the value hasn't changed. Settings.js
        // already short-circuits at its setters, but this keeps a tight
        // boundary at the storage layer in case a future caller bypasses it.
        if (cache[key] === v) return;
        cache[key] = v;
        try { airconsole.storePersistentData(key, v); } catch (e) { /* ignore */ }
      },
      removeItem: function(key) {
        if (!ALLOWLIST[key]) return;
        delete cache[key];
        try { airconsole.storePersistentData(key, null); } catch (e) { /* ignore */ }
      },
      clear: function() {
        for (var k in cache) {
          if (ALLOWLIST[k]) {
            try { airconsole.storePersistentData(k, null); } catch (e) { /* ignore */ }
          }
        }
        cache = {};
      },
      key: function(i) {
        var keys = Object.keys(cache);
        return keys[i] || null;
      },
      get length() { return Object.keys(cache).length; },
      // Register a callback to fire once persistent data has hydrated.
      // Fires immediately if already loaded. Used by Settings to re-apply
      // user values after the async AC fetch lands (Settings.init() runs
      // synchronously at page load with an empty cache).
      onLoad: function(cb) {
        if (typeof cb !== 'function') return;
        if (loaded) { cb(); return; }
        loadCallbacks.push(cb);
      },
      // Trigger the AC fetch. Caller is responsible for ensuring getDeviceId()
      // is valid (i.e. onReady has fired). Safe to call repeatedly.
      requestLoad: function() {
        var uid = getUid();
        if (!uid) return;
        try { airconsole.requestPersistentData([uid]); } catch (e) { /* ignore */ }
      }
    };

    try {
      Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
    } catch (e) { /* read-only */ }
    return shim;
  }

  // Populate the given element with the current build version. The build
  // script substitutes __AC_VERSION__ at HTML-generation time; in local dev
  // the placeholder survives unsubstituted, so fall back to /api/version.
  // (In real AC mode that fetch fails cross-origin and we silently leave
  // the label empty — the placeholder branch covers production.)
  static injectVersionLabel(elementId) {
    var el = document.getElementById(elementId);
    if (!el) return;
    var v = '__AC_VERSION__';
    if (v.indexOf('__') !== 0) { el.textContent = v; return; }
    fetch('/api/version').then(function(r) { return r.json(); }).then(function(d) {
      el.textContent = d.version || '';
    }).catch(function() {});
  }

  // Capture an early onReady callback from the SDK so we can replay it once
  // the adapter has wired up its own onReady. The SDK fires onReady at most
  // once per session; bootstraps that construct the adapter lazily (e.g. in
  // response to controller.js init) miss the live fire and rely on this
  // replay. Returns a `replay()` function — call it after wrapping
  // airconsole.onReady to bring a fresh adapter to ready.
  static captureEarlyReady(airconsole) {
    var capturedCode;
    airconsole.onReady = function(code) { capturedCode = code; };
    return function replay() {
      if (capturedCode !== undefined) airconsole.onReady(capturedCode);
    };
  }

  // Prefer the user's AirConsole-profile language over navigator.language.
  // Only override the initial detectLocale result when AC's language is
  // actually supported; otherwise setLocale would silently coerce to 'en' and
  // discard a valid navigator.language fallback. Relies on i18n globals
  // (LOCALES, setLocale, translatePage) being loaded by call time.
  static applyLocale(airconsole) {
    if (typeof airconsole.getLanguage !== 'function') return;
    if (typeof LOCALES === 'undefined' || typeof setLocale !== 'function' || typeof translatePage !== 'function') return;
    var acLang = airconsole.getLanguage();
    var acCode = acLang && acLang.toLowerCase().split('-')[0];
    if (acCode && LOCALES[acCode]) {
      setLocale(acLang);
      translatePage();
    }
  }
}

if (typeof window !== 'undefined') {
  window.AirConsoleAdapter = AirConsoleAdapter;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AirConsoleAdapter;
}
