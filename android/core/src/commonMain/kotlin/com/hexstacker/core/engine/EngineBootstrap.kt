package com.hexstacker.core.engine

/**
 * The JS shim installed AFTER evaluating `dist/partycore.js` (which defines
 * `globalThis.HexCore`). Mirrors `EngineBridge.swift`'s `bootstrapJS`, but
 * references `HexCore.PartyCore` (the esbuild iife) instead of
 * `window.GameEngine.PartyCore`, and installs `Bridge` on `globalThis`.
 *
 * `create` reassigns `core`, so ONE bridge is reusable across matches: call
 * `createGame(...)` again to start a new game without re-parsing the bundle.
 */
internal object EngineBootstrap {
    val SHIM: String = """
    globalThis.Bridge = (function () {
      var PartyCore = HexCore.PartyCore;
      var core = null;
      // ROOM-SHIM-BEGIN
      // The room core: roster, naming, colour slots, host election and the
      // retained snapshot, shared verbatim with the web display and Android TV.
      // Deliberately generic (one call/get pair rather than ~30 wrappers): the
      // Android shim has to build every call as an interpolated source string,
      // so one marshalling path per direction is one place to get escaping and
      // exception draining right. Kept token-identical to the Android copy by
      // tests/room-bridge-shim-parity.test.js.
      var room = null;
      function roomOrThrow() {
        if (!room) throw new Error('room: roomInit() not called');
        return room;
      }
      // ROOM-SHIM-END
      // playerId -> gridVersion last serialized WITH its grid. The grid is the
      // dominant payload of the 60 Hz frame()/snapshot() pulls and only changes
      // on a lock/clear/garbage insert, so strip it while the version is
      // unchanged; EngineBridge re-attaches its cached rows Kotlin-side. Safe
      // to delete off the snapshot: PartyCore.snapshot() is a value copy.
      var sentGridVersions = {};
      function stripUnchangedGrids(snap) {
        for (var i = 0; i < snap.players.length; i++) {
          var p = snap.players[i];
          if (sentGridVersions[p.id] === p.gridVersion) delete p.grid;
          else sentGridVersions[p.id] = p.gridVersion;
        }
        return snap;
      }
      // Scene signature of the last snapshot DELIVERED by frameJSON (port of the
      // web computeRenderSig). Pieces move in discrete grid cells, so most 60 Hz
      // frames are render-identical to the previous one: when the signature
      // matches, frameJSON omits the snapshot entirely — the host skips the
      // decode AND the repaint (its render loop keeps the retained snapshot).
      // Everything the renderer draws from a snapshot must be reflected here:
      // ghost/nextPieces are derived (piece + gridVersion covers them), and
      // clearingCells only change alongside a gridVersion bump. Time-driven
      // visuals (near-clear pulse, clearing glow, effects) are excluded on
      // purpose — the host render loop treats those as "must animate" and keeps
      // drawing without new snapshots. The elapsed term repaints the match
      // timer once per second. null = unknown (always deliver next frame).
      var lastSceneSig = null;
      function sceneSig(snap) {
        var sig = '' + Math.floor(snap.elapsed / 1000);
        for (var i = 0; i < snap.players.length; i++) {
          var p = snap.players[i];
          sig += '|' + p.id + ':' + (p.alive ? 1 : 0) + ':' + p.lines + ':' + p.level
            + ':' + p.pendingGarbage + ':' + p.gridVersion + ':' + (p.holdPiece || '');
          var cp = p.currentPiece;
          // cells[0] uniquely identifies rotation for every hex piece type (same
          // invariant the web clear-preview cache relies on).
          if (cp) sig += ':' + cp.typeId + ':' + cp.anchorCol + ':' + cp.anchorRow
            + ':' + cp.cells[0].q + ':' + cp.cells[0].r;
        }
        return sig;
      }
      return {
        create: function (specs, seed) {
          var map = new Map();
          for (var i = 0; i < specs.length; i++) {
            map.set(specs[i][0], { startLevel: specs[i][1] });
          }
          core = new PartyCore(map, seed >>> 0);
          core.init();
          sentGridVersions = {};
          lastSceneSig = null;
        },
        processInput: function (pid, action) { if (core) core.processInput(pid, action); },
        softDropStart: function (pid, speed) {
          if (core) core.handleSoftDropStart(pid, (speed === undefined ? null : speed));
        },
        softDropEnd: function (pid) { if (core) core.handleSoftDropEnd(pid); },
        pause: function () { if (core) core.pause(); },
        resume: function () { if (core) core.resume(); },
        resetFrameClock: function () { if (core) core.resetFrameClock(); },
        rekey: function (oldId, newId) {
          var ok = !!(core && core.rekeyPlayer(oldId, newId));
          // The board moved ids: forget both ledger entries so the next pull
          // re-sends the full grid under the new id (host cache follows suit),
          // and void the scene signature (it keys on player ids).
          if (ok) { delete sentGridVersions[oldId]; delete sentGridVersions[newId]; lastSceneSig = null; }
          return ok;
        },
        // Reads can't no-op like the writes above (they must return JSON), so a
        // read-before-create fails loud with a message that names the ordering bug
        // instead of an opaque TypeError on `core.snapshot`.
        snapshotJSON: function () { if (!core) throw new Error('no game: create() not called'); return JSON.stringify(stripUnchangedGrids(core.snapshot())); },
        drainEventsJSON: function () { if (!core) throw new Error('no game: create() not called'); return JSON.stringify(core.drainEvents()); },
        frameJSON: function (now) {
          if (!core) throw new Error('no game: create() not called');
          var f = core.frame(now);
          var sig = sceneSig(f.snapshot);
          if (sig === lastSceneSig) {
            // Render-identical to the last delivered snapshot: omit it (grid
            // ledger untouched — the next delivered snapshot strips as usual).
            delete f.snapshot;
          } else {
            lastSceneSig = sig;
            stripUnchangedGrids(f.snapshot);
          }
          return JSON.stringify(f);
        },
        isEnded: function () { return !!(core && core.game && core.game.ended); },
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
