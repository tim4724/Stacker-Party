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
    this.onError = null;
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
      if (this.onProtocol) this.onProtocol('joined', { room: code, clients: [] });
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
        // Self-echo for heartbeat compatibility
        if (this.onMessage) this.onMessage('display', data);
        return;
      }
      this.airconsole.message(AirConsole.SCREEN, data);
    } else {
      this.airconsole.message(parseInt(to, 10), data);
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
  }

  get connected() {
    return this._ready;
  }
}

if (typeof window !== 'undefined') {
  window.AirConsoleAdapter = AirConsoleAdapter;
}
