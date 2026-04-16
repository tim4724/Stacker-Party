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
    this._shouldReconnect = true;
    this.maxReconnectAttempts = (options && options.maxReconnectAttempts) || 5;
    this.reconnectAttempt = 0;

    // Callbacks
    this.onOpen = null;        // () => void
    this.onClose = null;       // (attempt: number, maxAttempts: number, meta?: {replaced: boolean}) => void
    this.onError = null;       // () => void
    this.onMessage = null;     // (from: string, data: object) => void
    this.onProtocol = null;    // (type: string, msg: object) => void
  }

  connect() {
    this._discardOldWs();

    this._shouldReconnect = true;
    var ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // stale
      if (this.onOpen) this.onOpen();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return; // stale
      var msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }

      if (msg.type === 'message') {
        if (this.onMessage) this.onMessage(msg.from, msg.data);
      } else {
        if (this.onProtocol) this.onProtocol(msg.type, msg);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return; // stale — already replaced by reconnectNow
      if (event && event.code === 4000) {
        // Relay evicted us because another client joined with the same clientId
        this._shouldReconnect = false;
        if (this.onClose) this.onClose(0, 0, { replaced: true });
        return;
      }
      this.reconnectAttempt++;
      if (this.onClose) this.onClose(this.reconnectAttempt, this.maxReconnectAttempts);
      if (this._shouldReconnect && this.reconnectAttempt <= this.maxReconnectAttempts) {
        this._scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return; // stale
      if (this.onError) this.onError();
    };
  }

  _discardOldWs() {
    if (this.ws) {
      var old = this.ws;
      this.ws = null;
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch (_) {}
    }
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    // Gentle backoff: 1s, 1.5s, 2.25s, 3.375s, capped at 5s
    var delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempt - 1), 5000);
    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
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

  reconnectNow() {
    clearTimeout(this._reconnectTimer);
    this.connect();
  }

  resetReconnectCount() {
    this.reconnectAttempt = 0;
  }

  close() {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    this._discardOldWs();
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
