// @ts-check

/**
 * Mock AirConsole SDK for E2E testing.
 *
 * Simulates the AirConsole messaging layer using a shared BroadcastChannel
 * so that separate browser pages (screen + controllers) can communicate
 * without the real AirConsole iframe infrastructure.
 *
 * Injected via page.addInitScript() BEFORE the real AirConsole SDK loads.
 * The <script src="airconsole-1.10.0.js"> in screen.html / controller.html
 * is intercepted (blocked) so this mock takes its place.
 */

// @ts-ignore - this runs in the browser context
(function() {
  'use strict';

  var CHANNEL_NAME = '__airconsole_mock__';

  /**
   * @param {object} [opts]
   */
  function AirConsole(opts) {
    this._opts = opts || {};
    this._deviceId = null;
    this._ready = false;
    this._channel = new BroadcastChannel(CHANNEL_NAME);
    this._nicknames = {};
    this._connectedDevices = new Set();

    // Callbacks
    this.onReady = null;
    this.onConnect = null;
    this.onDisconnect = null;
    this.onMessage = null;
    this.onPause = null;
    this.onResume = null;

    var self = this;

    // Determine role from URL or opts
    // screen.html → device 0, controller.html → random device ID > 0
    var isScreen = window.location.pathname.indexOf('screen') !== -1;
    this._deviceId = isScreen ? 0 : (window.__AC_DEVICE_ID || (100 + Math.floor(Math.random() * 900)));
    window.__AC_DEVICE_ID = this._deviceId;

    this._channel.onmessage = function(event) {
      var msg = event.data;
      if (!msg || !msg._ac_type) return;

      switch (msg._ac_type) {
        case 'connect':
          if (msg.deviceId !== self._deviceId) {
            if (msg.nickname) self._nicknames[msg.deviceId] = msg.nickname;
            if (msg.deviceId !== 0) self._connectedDevices.add(msg.deviceId);
            if (self.onConnect) self.onConnect(msg.deviceId);
          }
          break;
        case 'disconnect':
          if (msg.deviceId !== self._deviceId) {
            self._connectedDevices.delete(msg.deviceId);
            if (self.onDisconnect) self.onDisconnect(msg.deviceId);
          }
          break;
        case 'message':
          if (msg.to === self._deviceId || msg.to === undefined) {
            if (msg.from !== self._deviceId) {
              if (self.onMessage) self.onMessage(msg.from, msg.data);
            }
          }
          break;
      }
    };

    // Fire onReady asynchronously
    setTimeout(function() {
      if (isScreen) {
        self._ready = true;
        if (self.onReady) self.onReady('MOCK');
      }
      // Announce presence
      self._channel.postMessage({
        _ac_type: 'connect',
        deviceId: self._deviceId,
        nickname: window.__AC_NICKNAME || null
      });
      // For controllers: screen sends ready_ack when it sees the connect
      if (!isScreen) {
        // If screen is already ready, it will send ready_ack via its onConnect handler.
        // Give it a moment, then self-ready if not already acknowledged.
        setTimeout(function() {
          if (!self._ready) {
            self._ready = true;
            if (self.onReady) self.onReady('MOCK');
          }
        }, 200);
      }
    }, 50);
  }

  AirConsole.SCREEN = 0;
  AirConsole.ORIENTATION_PORTRAIT = 'portrait';
  AirConsole.ORIENTATION_LANDSCAPE = 'landscape';

  AirConsole.prototype.getDeviceId = function() {
    return this._deviceId;
  };

  AirConsole.prototype.getNickname = function(deviceId) {
    if (deviceId === this._deviceId) return window.__AC_NICKNAME || 'Player';
    return this._nicknames[deviceId] || 'Player';
  };

  AirConsole.prototype.getControllerDeviceIds = function() {
    return Array.from(this._connectedDevices);
  };

  AirConsole.prototype.getMasterControllerDeviceId = function() {
    return undefined;
  };

  AirConsole.prototype.message = function(deviceId, data) {
    this._channel.postMessage({
      _ac_type: 'message',
      from: this._deviceId,
      to: deviceId,
      data: data
    });
  };

  AirConsole.prototype.broadcast = function(data) {
    this._channel.postMessage({
      _ac_type: 'message',
      from: this._deviceId,
      to: undefined,
      data: data
    });
  };

  AirConsole.prototype.setCustomDeviceState = function() {};
  AirConsole.prototype.getCustomDeviceState = function() { return undefined; };
  AirConsole.prototype.setOrientation = function() {};
  AirConsole.prototype.vibrate = function() {};

  window.AirConsole = AirConsole;
})();
