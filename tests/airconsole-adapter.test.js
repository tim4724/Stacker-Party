'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// AirConsole is referenced at constructor time for the SCREEN constant; expose
// a minimal global before requiring the adapter.
global.AirConsole = { SCREEN: 0 };

const AirConsoleAdapter = require('../public/shared/AirConsoleAdapter');

function makeFakeAirConsole(overrides) {
  return Object.assign({
    _master: undefined,
    getMasterControllerDeviceId() { return this._master; },
    getControllerDeviceIds() { return []; },
    message() {},
    broadcast() {},
  }, overrides || {});
}

describe('AirConsoleAdapter.getMasterClientId', () => {
  it('returns null when no controller is connected', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    assert.equal(adapter.getMasterClientId(), null);
  });

  it('returns String(master device id) when present', () => {
    const ac = makeFakeAirConsole({ _master: 7 });
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    assert.equal(adapter.getMasterClientId(), '7');
  });

  it('returns null from the controller role', () => {
    const ac = makeFakeAirConsole({ _master: 7 });
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    assert.equal(adapter.getMasterClientId(), null);
  });
});

describe('AirConsoleAdapter onPremium', () => {
  it('fires master_changed protocol event on display', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'display' });
    const seen = [];
    adapter.onProtocol = function(type, msg) { seen.push({ type, msg }); };
    ac.onPremium();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'master_changed');
  });

  it('does not fire master_changed from the controller role', () => {
    const ac = makeFakeAirConsole();
    const adapter = new AirConsoleAdapter(ac, { role: 'controller' });
    const seen = [];
    adapter.onProtocol = function(type) { seen.push(type); };
    ac.onPremium();
    assert.deepEqual(seen, []);
  });
});

describe('AirConsoleAdapter.installAirConsoleStorage', () => {
  // The shim writes to window.localStorage via Object.defineProperty, so
  // each test installs a fresh window object and lets the shim populate it.
  // afterEach restores the absent global so a later test that asserts
  // typeof window === 'undefined' still works.
  let _prevWindow;
  beforeEach(() => { _prevWindow = global.window; });
  afterEach(() => {
    if (_prevWindow === undefined) delete global.window;
    else global.window = _prevWindow;
  });

  function installShim(persistentDataByUid) {
    const writes = [];
    const ac = {
      _deviceId: 1,
      getDeviceId() { return this._deviceId; },
      getUID(id) { return 'uid_' + id; },
      storePersistentData(key, value) { writes.push({ key, value }); },
      requestPersistentData(uids) {
        const data = {};
        for (const u of uids) data[u] = persistentDataByUid[u] || {};
        // Async per the real SDK contract.
        setTimeout(() => {
          if (this.onPersistentDataLoaded) this.onPersistentDataLoaded(data);
        }, 0);
      },
    };
    global.window = { localStorage: undefined };
    const shim = AirConsoleAdapter.installAirConsoleStorage(ac);
    return { ac, shim, writes };
  }

  it('drops non-allowlisted keys on read and write', () => {
    const { shim, writes } = installShim({ uid_1: { stacker_player_name: 'Alice', clientId_ABC: 'x' } });
    shim.setItem('stacker_player_name', 'Bob');
    shim.setItem('clientId_ABC', 'y');
    shim.setItem('stacker_muted', '1');
    assert.deepEqual(writes, []);
    assert.equal(shim.getItem('stacker_player_name'), null);
    assert.equal(shim.getItem('clientId_ABC'), null);
    // stacker_muted is the *display's* music key — explicitly out so music
    // defaults on every session. Controller audio uses stacker_touch_sounds.
    assert.equal(shim.getItem('stacker_muted'), null);
  });

  it('round-trips allowlisted keys via cache + storePersistentData', () => {
    const { shim, writes } = installShim({});
    shim.setItem('stacker_haptic_strength', 'strong');
    shim.setItem('stacker_touch_sensitivity', '60');
    shim.setItem('stacker_touch_sounds', '1');
    shim.setItem('stacker_color_index', '5');
    assert.deepEqual(writes, [
      { key: 'stacker_haptic_strength', value: 'strong' },
      { key: 'stacker_touch_sensitivity', value: '60' },
      { key: 'stacker_touch_sounds', value: '1' },
      { key: 'stacker_color_index', value: '5' },
    ]);
    assert.equal(shim.getItem('stacker_haptic_strength'), 'strong');
    assert.equal(shim.getItem('stacker_touch_sensitivity'), '60');
    assert.equal(shim.getItem('stacker_touch_sounds'), '1');
    assert.equal(shim.getItem('stacker_color_index'), '5');
  });

  it('writes immediately (no debounce) — every changed setItem triggers storePersistentData', () => {
    const { shim, writes } = installShim({});
    for (let i = 0; i < 5; i++) shim.setItem('stacker_touch_sensitivity', String(50 + i));
    assert.equal(writes.length, 5);
    assert.equal(writes[4].value, '54');
  });

  it('skips redundant writes when the value is unchanged', () => {
    const { shim, writes } = installShim({});
    shim.setItem('stacker_touch_sensitivity', '60');
    shim.setItem('stacker_touch_sensitivity', '60');
    shim.setItem('stacker_touch_sensitivity', '60');
    assert.equal(writes.length, 1);
  });

  it('hydrates cache from onPersistentDataLoaded, allowlist-filtered', async () => {
    const { ac, shim } = installShim({});
    ac.onPersistentDataLoaded({
      uid_1: {
        stacker_haptic_strength: 'light',
        stacker_touch_sensitivity: '72',
        // Should be dropped — not in allowlist.
        stacker_player_name: 'Alice',
      },
    });
    assert.equal(shim.getItem('stacker_haptic_strength'), 'light');
    assert.equal(shim.getItem('stacker_touch_sensitivity'), '72');
    assert.equal(shim.getItem('stacker_player_name'), null);
  });

  it('onLoad fires after first hydration; immediately when already loaded', async () => {
    const { ac, shim } = installShim({});
    let calls = 0;
    shim.onLoad(() => { calls++; });
    assert.equal(calls, 0);
    ac.onPersistentDataLoaded({ uid_1: { stacker_haptic_strength: 'medium' } });
    assert.equal(calls, 1);
    // Subsequent registrations fire immediately.
    shim.onLoad(() => { calls++; });
    assert.equal(calls, 2);
  });

  it('removeItem clears cache and writes null through to AC', () => {
    const { shim, writes } = installShim({});
    shim.setItem('stacker_haptic_strength', 'strong');
    shim.removeItem('stacker_haptic_strength');
    assert.equal(shim.getItem('stacker_haptic_strength'), null);
    assert.deepEqual(writes[1], { key: 'stacker_haptic_strength', value: null });
  });

  it('clear() nulls every stored allowlisted key and empties the cache', () => {
    const { shim, writes } = installShim({});
    shim.setItem('stacker_haptic_strength', 'strong');
    shim.setItem('stacker_touch_sensitivity', '60');
    shim.setItem('stacker_touch_sounds', '1');
    shim.clear();
    assert.equal(shim.length, 0);
    assert.equal(shim.getItem('stacker_haptic_strength'), null);
    assert.equal(shim.getItem('stacker_touch_sensitivity'), null);
    assert.equal(shim.getItem('stacker_touch_sounds'), null);
    // 3 setItem writes + 3 storePersistentData(_, null) calls from clear()
    assert.equal(writes.length, 6);
    const nullWrites = writes.slice(3).map((w) => w.value);
    assert.deepEqual(nullWrites, [null, null, null]);
  });

  it('hydration does not clobber a local setItem made before the load resolves', () => {
    const { ac, shim } = installShim({ uid_1: { stacker_haptic_strength: 'light' } });
    // User writes locally before hydration fires (mirrors the requestLoad
    // → user-toggle → onPersistentDataLoaded race).
    shim.setItem('stacker_haptic_strength', 'strong');
    ac.onPersistentDataLoaded({ uid_1: { stacker_haptic_strength: 'light' } });
    assert.equal(shim.getItem('stacker_haptic_strength'), 'strong');
  });

  it('requestLoad triggers AC fetch and chains existing onPersistentDataLoaded', async () => {
    const { ac, shim } = installShim({ uid_1: { stacker_touch_sensitivity: '88' } });
    let prevHandlerCalled = false;
    ac.onPersistentDataLoaded = (function(prev) {
      return function(data) {
        prevHandlerCalled = true;
        if (prev) prev.call(ac, data);
      };
    })(ac.onPersistentDataLoaded);
    let loaded = false;
    shim.onLoad(() => { loaded = true; });
    shim.requestLoad();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(loaded, true);
    assert.equal(shim.getItem('stacker_touch_sensitivity'), '88');
    assert.equal(prevHandlerCalled, true);
  });
});
