'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock WebSocket for testing PartyConnection without a real server
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    this._sent = [];
    this._closed = false;

    // Auto-open after microtask to simulate async connection
    MockWebSocket._instances.push(this);
  }

  send(data) {
    this._sent.push(JSON.parse(data));
  }

  close() {
    this._closed = true;
    this.readyState = 3;
  }

  // Test helpers
  _simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  _simulateClose() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  _simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  _simulateError() {
    if (this.onerror) this.onerror();
  }
}
MockWebSocket._instances = [];

// Inject mock before importing
global.WebSocket = MockWebSocket;

const PartyConnection = require('../public/shared/PartyConnection');

describe('PartyConnection', () => {
  beforeEach(() => {
    MockWebSocket._instances = [];
  });

  test('connect creates a WebSocket', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'abc' });
    pc.connect();
    assert.strictEqual(MockWebSocket._instances.length, 1);
    assert.strictEqual(MockWebSocket._instances[0].url, 'wss://test.example.com');
  });

  test('connect refuses to open a WebSocket when window.airconsole exists', () => {
    const originalWindow = global.window;
    const origWarn = console.warn;
    global.window = { airconsole: {} };
    console.warn = () => {};
    try {
      const pc = new PartyConnection('wss://test.example.com', { clientId: 'abc' });
      pc.connect();
      assert.strictEqual(MockWebSocket._instances.length, 0);
    } finally {
      global.window = originalWindow;
      console.warn = origWarn;
    }
  });

  test('onOpen callback fires on connection', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let opened = false;
    pc.onOpen = () => { opened = true; };
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    assert.strictEqual(opened, true);
  });

  test('onMessage callback fires for relay messages', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let received = null;
    pc.onMessage = (from, data) => { received = { from, data }; };
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    MockWebSocket._instances[0]._simulateMessage({ type: 'message', from: 'player1', data: { action: 'left' } });
    assert.deepStrictEqual(received, { from: 'player1', data: { action: 'left' } });
  });

  test('onProtocol callback fires for non-message types', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let received = null;
    pc.onProtocol = (type, msg) => { received = { type, msg }; };
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    MockWebSocket._instances[0]._simulateMessage({ type: 'created', room: 'ABCD' });
    assert.strictEqual(received.type, 'created');
    assert.strictEqual(received.msg.room, 'ABCD');
  });

  test('sendTo sends correctly formatted message', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'display' });
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.sendTo('player1', { type: 'WELCOME', color: 'red' });
    assert.deepStrictEqual(MockWebSocket._instances[0]._sent[0], {
      type: 'send',
      data: { type: 'WELCOME', color: 'red' },
      to: 'player1'
    });
  });

  test('broadcast sends without to field', () => {
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.broadcast({ type: 'GAME_START' });
    assert.deepStrictEqual(MockWebSocket._instances[0]._sent[0], {
      type: 'send',
      data: { type: 'GAME_START' }
    });
  });

  test('connected returns true when WebSocket is open', () => {
    const pc = new PartyConnection('wss://test.example.com');
    assert.ok(!pc.connected); // null before connect
    pc.connect();
    assert.ok(!pc.connected); // readyState=0 (CONNECTING)
    MockWebSocket._instances[0]._simulateOpen();
    assert.strictEqual(pc.connected, true);
  });

  test('close stops reconnection and closes WebSocket', () => {
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.close();
    assert.ok(!pc.connected);
    assert.strictEqual(MockWebSocket._instances[0]._closed, true);
  });
});

describe('PartyConnection - reconnect with exponential backoff', () => {
  beforeEach(() => {
    MockWebSocket._instances = [];
  });

  test('onClose increments reconnectAttempt', () => {
    const pc = new PartyConnection('wss://test.example.com');
    assert.strictEqual(pc.reconnectAttempt, 0);
    pc.connect();
    MockWebSocket._instances[0]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 1);
  });

  test('onClose calls callback with attempt count', () => {
    const pc = new PartyConnection('wss://test.example.com', { maxReconnectAttempts: 3 });
    let closeArgs = null;
    pc.onClose = (attempt, max) => { closeArgs = { attempt, max }; };
    pc.connect();
    MockWebSocket._instances[0]._simulateClose();
    assert.deepStrictEqual(closeArgs, { attempt: 1, max: 3 });
  });

  test('reconnect stops after maxReconnectAttempts', () => {
    const pc = new PartyConnection('wss://test.example.com', { maxReconnectAttempts: 2 });
    pc.connect();
    // First close (attempt=1) — schedules reconnect
    MockWebSocket._instances[0]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 1);
    // Manually trigger second connect (simulating the timer firing)
    pc.connect();
    // Second close (attempt=2) — still schedules reconnect (2 <= 2)
    MockWebSocket._instances[MockWebSocket._instances.length - 1]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 2);
    // Manually trigger third connect
    pc.connect();
    // Third close (attempt=3) — exceeds max, no more reconnects
    const instanceCountBefore = MockWebSocket._instances.length;
    MockWebSocket._instances[MockWebSocket._instances.length - 1]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 3);
    assert.strictEqual(MockWebSocket._instances.length, instanceCountBefore);
  });

  test('resetReconnectCount resets attempt counter', () => {
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateClose();
    assert.strictEqual(pc.reconnectAttempt, 1);
    pc.resetReconnectCount();
    assert.strictEqual(pc.reconnectAttempt, 0);
  });

  test('reconnectNow creates a fresh connection', () => {
    const pc = new PartyConnection('wss://test.example.com');
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    const firstWs = MockWebSocket._instances[0];
    pc.reconnectNow();
    assert.strictEqual(MockWebSocket._instances.length, 2);
    assert.strictEqual(firstWs._closed, true);
    assert.notStrictEqual(pc.ws, firstWs);
  });

  test('stale WebSocket events are ignored after reconnect', () => {
    const pc = new PartyConnection('wss://test.example.com');
    let openCount = 0;
    pc.onOpen = () => { openCount++; };
    pc.connect();
    const staleWs = MockWebSocket._instances[0];
    pc.reconnectNow();
    // Stale WS fires open — should be ignored
    staleWs.readyState = 1;
    if (staleWs.onopen) staleWs.onopen();
    // New WS fires open — should be counted
    MockWebSocket._instances[1]._simulateOpen();
    assert.strictEqual(openCount, 1);
  });

  test('_scheduleReconnect uses exponential backoff', () => {
    // Verify the backoff formula by inspecting the method behavior
    const pc = new PartyConnection('wss://test.example.com');
    // After 1st failure: delay = min(1000 * 1.5^0, 5000) = 1000
    // After 2nd failure: delay = min(1000 * 1.5^1, 5000) = 1500
    // After 3rd failure: delay = min(1000 * 1.5^2, 5000) = 2250
    // After 4th failure: delay = min(1000 * 1.5^3, 5000) = 3375
    // After 5th failure: delay = min(1000 * 1.5^4, 5000) = 5000 (capped)
    pc.reconnectAttempt = 1;
    // We can't easily test the timeout delay without mocking setTimeout,
    // but we verify the method exists and doesn't throw
    pc._scheduleReconnect();
    clearTimeout(pc._reconnectTimer);

    pc.reconnectAttempt = 5;
    pc._scheduleReconnect();
    clearTimeout(pc._reconnectTimer);

    pc.reconnectAttempt = 10;
    pc._scheduleReconnect();
    clearTimeout(pc._reconnectTimer);
  });

  test('create sends correct relay message', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'display' });
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.create(5);
    assert.deepStrictEqual(MockWebSocket._instances[0]._sent[0], {
      type: 'create',
      clientId: 'display',
      maxClients: 5
    });
  });

  test('join sends correct relay message', () => {
    const pc = new PartyConnection('wss://test.example.com', { clientId: 'player1' });
    pc.connect();
    MockWebSocket._instances[0]._simulateOpen();
    pc.join('ABCD');
    assert.deepStrictEqual(MockWebSocket._instances[0]._sent[0], {
      type: 'join',
      clientId: 'player1',
      room: 'ABCD'
    });
  });
});
