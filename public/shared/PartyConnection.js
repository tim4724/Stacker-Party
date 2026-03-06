'use strict';

/**
 * PartyConnection — WebSocket wrapper for Party-Server relay protocol.
 *
 * Party-Server protocol:
 *   Client → PS:  create { clientId, maxClients }
 *   Client → PS:  join   { clientId, room }
 *   Client → PS:  send   { data, to? }
 *   PS → Client:  created      { room }
 *   PS → Client:  joined       { room, clients[] }
 *   PS → Client:  peer_joined  { clientId }
 *   PS → Client:  peer_left    { clientId }
 *   PS → Client:  message      { from, data }
 *   PS → Client:  error        { message }
 */
class PartyConnection {
  constructor(relayUrl, options) {
    this.relayUrl = relayUrl;
    this.clientId = (options && options.clientId) || null;
    this.ws = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._shouldReconnect = true;

    // Callbacks
    this.onOpen = null;        // () => void
    this.onClose = null;       // () => void
    this.onError = null;       // () => void
    this.onMessage = null;     // (from: string, data: object) => void
    this.onProtocol = null;    // (type: string, msg: object) => void
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }

    this._shouldReconnect = true;
    this.ws = new WebSocket(this.relayUrl);

    this.ws.onopen = () => {
      this._reconnectDelay = 1000;
      if (this.onOpen) this.onOpen();
    };

    this.ws.onmessage = (event) => {
      var msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }

      if (msg.type === 'message') {
        if (this.onMessage) this.onMessage(msg.from, msg.data);
      } else {
        if (this.onProtocol) this.onProtocol(msg.type, msg);
      }
    };

    this.ws.onclose = () => {
      if (this.onClose) this.onClose();
      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      if (this.onError) this.onError();
    };
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(
      Math.round(this._reconnectDelay * 1.5),
      10000
    );
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  create(maxClients) {
    this._send({ type: 'create', clientId: this.clientId, maxClients: maxClients });
  }

  join(room) {
    this._send({ type: 'join', clientId: this.clientId, room: room });
  }

  sendTo(to, data) {
    this._send({ type: 'send', data: data, to: to });
  }

  broadcast(data) {
    this._send({ type: 'send', data: data });
  }

  close() {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }

  get connected() {
    return this.ws && this.ws.readyState === 1;
  }
}

// Export for both Node.js and browser
if (typeof window !== 'undefined') {
  window.PartyConnection = PartyConnection;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PartyConnection;
}
