package com.hexstacker.core.engine

/**
 * The JS shim installed AFTER evaluating `dist/partycore.js` (which defines
 * `globalThis.HexCore`). Mirrors `EngineBridge.swift`'s `bootstrapJS`, but
 * installs `Bridge` on `globalThis` (JavaScriptCore takes the bare `var`).
 *
 * Marshalling only: PartyCore inverts the engine's callbacks into a drained
 * events buffer and owns the delivery filter (grid stripping, render-identical
 * frame skipping). The marked blocks are kept TOKEN-IDENTICAL to the tvOS shim
 * by tests/room-bridge-shim-parity.test.js, which also runs both against the
 * real bundle; anything outside the markers is platform-only and listed there.
 *
 * `create` reassigns `core`, so ONE bridge is reusable across matches: call
 * `createGame(...)` again to start a new game without re-parsing the bundle.
 */
internal object EngineBootstrap {
    val SHIM: String = """
    globalThis.Bridge = (function () {
      // ENGINE-SHIM-BEGIN
      var PartyCore = HexCore.PartyCore;
      var core = null;
      // The room core: roster, naming, colour slots, host election and the
      // retained snapshot, shared verbatim with the web display and Android TV.
      // Deliberately generic (one call/get pair rather than ~30 wrappers): the
      // Android shim has to build every call as an interpolated source string,
      // so one marshalling path per direction is one place to get escaping and
      // exception draining right.
      var room = null;
      function roomOrThrow() {
        if (!room) throw new Error('room: roomInit() not called');
        return room;
      }
      function gameOrThrow() {
        if (!core) throw new Error('no game: create() not called');
        return core;
      }
      // ENGINE-SHIM-END
      return {
        // ENGINE-API-BEGIN
        create: function (specs, seed) {
          var map = new Map();
          for (var i = 0; i < specs.length; i++) {
            map.set(specs[i][0], { startLevel: specs[i][1] });
          }
          core = new PartyCore(map, seed >>> 0);
          core.init();
        },
        processInput: function (pid, action) { if (core) core.processInput(pid, action); },
        softDropStart: function (pid, speed) {
          if (core) core.handleSoftDropStart(pid, (speed === undefined ? null : speed));
        },
        softDropEnd: function (pid) { if (core) core.handleSoftDropEnd(pid); },
        pause: function () { if (core) core.pause(); },
        resume: function () { if (core) core.resume(); },
        resetFrameClock: function () { if (core) core.resetFrameClock(); },
        rekeyPlayer: function (oldId, newId) { return !!(core && core.rekeyPlayer(oldId, newId)); },
        // Reads can't no-op like the writes above (they must return JSON), so a
        // read-before-create fails loud with a message that names the ordering
        // bug instead of an opaque TypeError on `core.snapshot`.
        //
        // deliverSnapshot/deliverFrame are frame() and snapshot() filtered for
        // this boundary: unchanged grids stripped, and a render-identical frame
        // delivered without its snapshot at all. Both ledgers live in PartyCore
        // (server/PartyCore.js), so the two platforms cannot drift on them.
        snapshotJSON: function () { return JSON.stringify(gameOrThrow().deliverSnapshot()); },
        drainEventsJSON: function () { return JSON.stringify(gameOrThrow().drainEvents()); },
        frameJSON: function (now) { return JSON.stringify(gameOrThrow().deliverFrame(now)); },
        isEnded: function () { return !!(core && core.game && core.game.ended); },
        // ENGINE-API-END
        // ROOM-API-BEGIN
        roomInit: function (optsJson) {
          room = new HexCore.RoomCore(optsJson ? JSON.parse(optsJson) : {});
        },
        roomCall: function (method, argsJson) {
          var r = roomOrThrow();
          var fn = r[method];
          if (typeof fn !== 'function') throw new Error('room: no method ' + method);
          var out = fn.apply(r, argsJson ? JSON.parse(argsJson) : []);
          return JSON.stringify(out === undefined ? null : out);
        },
        roomGet: function (prop) {
          var v = roomOrThrow()[prop];
          return JSON.stringify(v === undefined ? null : v);
        },
        roomSnapshotJSON: function () { return roomOrThrow().snapshotJSON(); }
        // ROOM-API-END
      };
    })();
    """.trimIndent()
}
