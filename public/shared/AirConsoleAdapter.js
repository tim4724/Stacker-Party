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

  // Neutralize window.localStorage — AirConsole manages identity and resets
  // audio state per session, so persisting anything is dead weight and could
  // pick up stale values from previous sessions in the AC iframe storage
  // partition.
  static neutralizeLocalStorage() {
    var noop = {
      getItem: function() { return null; },
      setItem: function() {},
      removeItem: function() {},
      clear: function() {},
      key: function() { return null; },
      length: 0
    };
    try {
      Object.defineProperty(window, 'localStorage', { value: noop, configurable: true });
    } catch (e) { /* read-only */ }
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
