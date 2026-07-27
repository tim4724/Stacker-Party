import Foundation
import JavaScriptCore

/// Runs the canonical HexStacker game engine inside JavaScriptCore and exposes a
/// typed Swift API over it. The display is the sole authoritative simulator, so
/// this drives the whole game.
///
/// The engine ships as ONE esbuild bundle, `partycore.js` (built from
/// `server/core-entry.js` by `npm run build:core`; see `scripts/build.js`). It is
/// an iife exposing the global `HexCore` with `HexCore.PartyCore` and
/// `HexCore.RoomCore`, so there is no module load order to maintain and no
/// `window`/`require`/CommonJS shim to provide — esbuild inlined the graph
/// (`tests/core-bundle-runtime.test.js` proves it loads with none of those).
/// PartyCore is the blessed native integration surface (`server/PartyCore.d.ts`):
/// it wraps the stateful `Game`, inverts its onEvent/onGameEnd push into a drained
/// events array, and normalizes each frame's events + value-copy snapshot into a
/// serializable host-effect `commands` list. A small JS `Bridge` shim wraps
/// construction, input, and `frame()`/`JSON.stringify`-ed payloads for easy
/// decoding.
///
/// We deliberately do NOT inject a `console` shim: bare JavaScriptCore has none,
/// and the only engine call site (Game's board-tick error path) is guarded with
/// `typeof console !== 'undefined'`, so it safely no-ops (see PartyCore.d.ts
/// "LOADER CONTRACT").
public final class EngineBridge {

    public enum EngineError: Error, CustomStringConvertible {
        case contextUnavailable
        case missingScript(String)
        case evalFailed(String)
        case bridgeUnavailable
        case decode(String)

        public var description: String {
            switch self {
            case .contextUnavailable: return "Could not create JSContext"
            case .missingScript(let f): return "Missing engine script: \(f)"
            case .evalFailed(let m): return "Engine evaluation failed: \(m)"
            case .bridgeUnavailable: return "Bridge global not available after bootstrap"
            case .decode(let m): return "Failed to decode engine output: \(m)"
            }
        }
    }

    /// The single esbuild core bundle loaded into JavaScriptCore. Built from
    /// `server/core-entry.js` (-> `dist/partycore.js`) and copied into the
    /// `engine/` dir by the "Sync engine JS" pre-build phase (`sync-engine.sh`).
    public static let coreBundleFile = "partycore.js"

    /// Holds the most recent uncaught JS exception. A reference type so the
    /// JSContext exception handler can capture it before `self` is initialized.
    private final class ExceptionBox { var message: String? }

    private let context: JSContext
    private let bridge: JSValue
    private let decoder = JSONDecoder()
    private let exceptionBox: ExceptionBox

    /// Grid rows last received per player, keyed by id. The JS shim strips a
    /// player's `grid` from the 60 Hz frame()/snapshot() payloads while its
    /// `gridVersion` is unchanged (the grid dominates the serialized snapshot,
    /// and it only changes on a lock/clear/garbage insert); FrameParsing
    /// re-attaches these cached rows so consumers always see a full snapshot.
    private var gridCache: [Int: [[Int]]] = [:]

    /// Reports a JS exception raised by a fire-and-forget engine call (input,
    /// tick, pause). Without this such errors were dropped AND left in the shared
    /// exception box, where they were mis-attributed to the next frame()/snapshot().
    /// Now every call drains the box; this surfaces the ones that have no return
    /// value to throw from. Defaults to nil (no-op).
    public var onEngineError: ((String) -> Void)?

    /// - Parameter engineDirectory: a directory containing the `partycore.js`
    ///   core bundle (in production: the app bundle's `engine/` folder; in tests:
    ///   the repo's `dist/` folder, freshly built from the canonical source).
    public init(engineDirectory: URL) throws {
        guard let ctx = JSContext() else { throw EngineError.contextUnavailable }

        let box = ExceptionBox()
        ctx.exceptionHandler = { _, exc in
            box.message = exc?.toString() ?? "unknown JS exception"
        }
        func takeLocal() -> String? { defer { box.message = nil }; return box.message }

        // One self-contained bundle: no `window`/`require` shim needed (esbuild
        // inlined the module graph behind the global `HexCore`).
        let url = engineDirectory.appendingPathComponent(Self.coreBundleFile)
        guard let src = try? String(contentsOf: url, encoding: .utf8) else {
            throw EngineError.missingScript(url.path)
        }
        ctx.evaluateScript(src, withSourceURL: url)
        if let e = takeLocal() { throw EngineError.evalFailed("\(Self.coreBundleFile): \(e)") }

        ctx.evaluateScript(Self.bootstrapJS)
        if let e = takeLocal() { throw EngineError.evalFailed("bootstrap: \(e)") }

        guard let b = ctx.objectForKeyedSubscript("Bridge"), !b.isUndefined, !b.isNull else {
            throw EngineError.bridgeUnavailable
        }

        self.context = ctx
        self.bridge = b
        self.exceptionBox = box
    }

    // MARK: - Game control

    /// Construct and `init()` a new game. `players` order defines snapshot order.
    public func createGame(players: [(id: Int, startLevel: Int)], seed: UInt32) throws {
        let specs = players.map { [$0.id, $0.startLevel] }
        gridCache = [:]   // fresh match: the shim's sent-grid ledger resets too
        bridge.invokeMethod("create", withArguments: [specs, Int(seed)])
        if let e = takeException() { throw EngineError.evalFailed("create: \(e)") }
    }

    /// Discrete input. `action` must be one of: left, right, rotate_cw,
    /// hard_drop, hold. (hard_drop locks synchronously and emits events.)
    public func processInput(playerId: Int, action: String) {
        invoke("processInput", [playerId, action])
    }

    public func softDropStart(playerId: Int, speed: Int? = nil) {
        if let speed {
            invoke("softDropStart", [playerId, speed])
        } else {
            invoke("softDropStart", [playerId])
        }
    }

    public func softDropEnd(playerId: Int) {
        invoke("softDropEnd", [playerId])
    }

    /// Advance the simulation by real elapsed milliseconds. The granular path
    /// used by the frozen-game / demo capture; the live game loop uses
    /// `frame(nowMs:)` instead, which ticks, drains and normalizes in one pull.
    public func update(deltaMs: Double) {
        invoke("update", [deltaMs])
    }

    public func pause() { invoke("pause") }
    public func resume() { invoke("resume") }

    /// Cross-device mid-game rejoin: move a participant's board, garbage queue
    /// and cooldown from `oldId` to `newId` inside the engine, so the returning
    /// peer's input and snapshot land on the kept board. Mirrors the web's
    /// rekeyDisplayGamePlayer (game.boards / playerIds / garbageManager remap).
    /// Returns the engine's own result (false if `oldId` had no board, or the JS
    /// call failed) so the caller can keep roster and engine state in lockstep.
    @discardableResult
    public func rekeyPlayer(oldId: Int, newId: Int) -> Bool {
        let ok = invoke("rekeyPlayer", [oldId, newId])?.toBool() ?? false
        // Follow the engine's board move in the grid cache (the shim drops both
        // ids from its sent-grid ledger, so the next pull re-sends a full grid).
        if ok, let g = gridCache.removeValue(forKey: oldId) { gridCache[newId] = g }
        return ok
    }

    /// Forget the previous `frame()` timestamp so the next `frame()` re-primes
    /// with deltaMs=0 instead of a catch-up jump. The host MUST call this on
    /// leaving the active loop (pause, results), mirroring the web's
    /// `prevFrameTime = 0` reset. See PartyCore.d.ts.
    public func resetFrameClock() { invoke("resetFrameClock") }

    public var isEnded: Bool {
        invoke("isEnded")?.toBool() ?? false
    }

    // MARK: - Reading state

    /// Value-copy snapshot via the fast path: shim-stripped grids re-attached
    /// from `gridCache`, hand-rolled parsing instead of JSONDecoder (this and
    /// `frame(nowMs:)` run up to once per display frame).
    public func snapshot() throws -> GameSnapshot {
        let obj = try jsonObject(method: "snapshotJSON")
        do { return try FrameParsing.gameSnapshot(obj, gridCache: &gridCache) }
        catch { throw EngineError.decode("snapshotJSON: \(error)") }
    }

    // MARK: - Room core

    /// The room's single source of truth (`server/RoomCore.js`, the same module
    /// the web display and Android TV run): roster, auto-naming, colour slots,
    /// host election, and the retained snapshot controllers derive their whole UI
    /// from. Everything crosses as JSON, and the surface is deliberately generic
    /// rather than ~30 typed wrappers so the marshalling and exception-draining
    /// discipline lives in one place per direction on both platforms.
    ///
    /// Unlike the engine, the room core exists for the WHOLE session: it is created
    /// once at coordinator start and survives across matches, so `roomInit` must
    /// be called before any room event is handled.
    public func roomInit(optionsJSON: String = "{}") throws {
        bridge.invokeMethod("roomInit", withArguments: [optionsJSON])
        if let e = takeException() {
            onEngineError?("roomInit: \(e)")
            throw EngineError.evalFailed("roomInit: \(e)")
        }
    }

    /// Invoke a RoomCore method. `argsJSON` is a JSON array of its arguments;
    /// the JSON-encoded return value comes back (`"null"` for void methods).
    @discardableResult
    public func roomCallJSON(_ method: String, _ argsJSON: String = "[]") throws -> String {
        try roomString("roomCall", [method, argsJSON], label: "roomCall(\(method))")
    }

    /// Read a RoomCore property (the getters: `state`, `host`, `participants`,
    /// `results`, ...) as JSON.
    public func roomGetJSON(_ property: String) throws -> String {
        try roomString("roomGet", [property], label: "roomGet(\(property))")
    }

    /// The retained room snapshot, ready to hand straight to `set_state`.
    public func roomSnapshotJSON() throws -> String {
        try roomString("roomSnapshotJSON", [], label: "roomSnapshotJSON")
    }

    /// Typed convenience over `roomCallJSON`.
    public func roomCall<T: Decodable>(_ type: T.Type, _ method: String, _ argsJSON: String = "[]") throws -> T {
        try decodeRoom(type, json: try roomCallJSON(method, argsJSON), label: "roomCall(\(method))")
    }

    /// Typed convenience over `roomGetJSON`.
    public func roomGet<T: Decodable>(_ type: T.Type, _ property: String) throws -> T {
        try decodeRoom(type, json: try roomGetJSON(property), label: "roomGet(\(property))")
    }

    /// Shared call + drain for the three room entry points. Draining before
    /// inspecting the result is the same discipline `decode` documents: a JS
    /// throw yields no usable string, and bailing without draining would leave
    /// the message to be mis-attributed to the next frame().
    private func roomString(_ method: String, _ args: [Any], label: String) throws -> String {
        let result = bridge.invokeMethod(method, withArguments: args)
        if let e = takeException() {
            onEngineError?("\(label): \(e)")
            throw EngineError.evalFailed("\(label): \(e)")
        }
        guard let json = result?.toString() else {
            throw EngineError.decode("\(label): no string returned")
        }
        return json
    }

    private func decodeRoom<T: Decodable>(_ type: T.Type, json: String, label: String) throws -> T {
        guard let data = json.data(using: .utf8) else {
            throw EngineError.decode("\(label): not utf8")
        }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw EngineError.decode("\(label): \(error)") }
    }

    // MARK: - Gallery fixtures

    /// The canonical cross-platform screen-gallery fixtures (`HexCore.GalleryFixtures`,
    /// built from `server/GalleryFixtures.js`). The web harness, tvOS HEXSHOT states
    /// and the Android screenshot tests all read THIS data, so a visual difference
    /// between gallery columns is always a renderer difference, never a fixture one.

    /// `roster(count, longNames)` — lobby cards (id == slot == colorIndex, plus
    /// name + level); `longNames` swaps in the 16-char LONG_NAMES fixture.
    public func galleryRoster(count: Int, longNames: Bool = false) throws -> [GalleryRosterEntry] {
        try decode([GalleryRosterEntry].self, method: "galleryRosterJSON", args: [count, longNames])
    }

    /// `JOIN` — the join target (displayed host/code + separate QR text).
    public func galleryJoin() throws -> GalleryJoin {
        try decode(GalleryJoin.self, method: "galleryJoinJSON")
    }

    /// A mid-game snapshot for a named board variant (`lv1`/`lv8`/`lv12`/`2p`/`3p`/`4p`).
    public func gallerySnapshot(variant: String) throws -> GameSnapshot {
        try decode(GameSnapshot.self, method: "gallerySnapshotJSON", args: [variant, 0, 1])
    }

    /// A mid-game snapshot for an ad-hoc `{players, level}` spec (arbitrary board
    /// count, e.g. the frozen boards behind the results overlay).
    public func gallerySnapshot(players: Int, level: Int) throws -> GameSnapshot {
        try decode(GameSnapshot.self, method: "gallerySnapshotJSON", args: ["", players, level])
    }

    /// `results(count)` — the canonical finished-match ranking.
    public func galleryResults(count: Int) throws -> GalleryResults {
        try decode(GalleryResults.self, method: "galleryResultsJSON", args: [count])
    }

    /// `ambientPieces()` — the frozen lobby-background falling pieces.
    public func galleryAmbient() throws -> [AmbientPiece] {
        try decode([AmbientPiece].self, method: "galleryAmbientJSON")
    }

    /// Drains and returns events accumulated since the last call.
    public func drainEvents() throws -> [GameEvent] {
        try decode([GameEvent].self, method: "drainEventsJSON")
    }

    /// Pull one engine frame via PartyCore: converts the monotonic `nowMs` into a
    /// capped delta, ticks the engine (self-gating on paused/ended), and returns
    /// this frame's `events` (complete record), a value-copy `snapshot`, and the
    /// normalized host-effect `commands`. The blessed native integration surface.
    /// Decodes through the fast path (see `snapshot()`).
    ///
    /// The snapshot is nil when the frame is render-identical to the last one this
    /// bridge delivered (PartyCore's scene signature) — skip the repaint and keep
    /// the retained snapshot. `snapshot()` is unaffected: it always returns a copy.
    public func frame(nowMs: Double) throws -> FrameResult {
        let obj = try jsonObject(method: "frameJSON", args: [nowMs])
        do { return try FrameParsing.frameResult(obj, gridCache: &gridCache) }
        catch { throw EngineError.decode("frameJSON: \(error)") }
    }

    // MARK: - Internals

    /// Invoke a fire-and-forget engine method and DRAIN the shared exception box
    /// afterward. Draining is the point: a JS throw from input/tick/pause used to
    /// linger in the box and be mis-reported by the next frame()/snapshot(). The
    /// drained message (if any) is surfaced via onEngineError, never silently lost.
    @discardableResult
    private func invoke(_ method: String, _ args: [Any] = []) -> JSValue? {
        let result = bridge.invokeMethod(method, withArguments: args)
        if let e = takeException() { onEngineError?("\(method): \(e)") }
        return result
    }

    private func decode<T: Decodable>(_ type: T.Type, method: String, args: [Any] = []) throws -> T {
        let result = bridge.invokeMethod(method, withArguments: args)
        // Drain the box BEFORE inspecting the result: a JS throw yields no usable
        // string, and bailing on the guard below without draining would leave the
        // exception to be mis-attributed to the NEXT call (the exact class of bug
        // invoke()'s drain exists to prevent).
        if let e = takeException() { onEngineError?("\(method): \(e)"); throw EngineError.evalFailed("\(method): \(e)") }
        guard let json = result?.toString(), let data = json.data(using: .utf8) else {
            throw EngineError.decode("\(method): no string returned")
        }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw EngineError.decode("\(method): \(error)") }
    }

    /// The per-frame twin of `decode`: same call + exception-drain discipline,
    /// but returns the raw JSONSerialization tree for FrameParsing's hand-rolled
    /// mapping instead of running it through JSONDecoder.
    private func jsonObject(method: String, args: [Any] = []) throws -> Any {
        let result = bridge.invokeMethod(method, withArguments: args)
        if let e = takeException() { onEngineError?("\(method): \(e)"); throw EngineError.evalFailed("\(method): \(e)") }
        guard let json = result?.toString(), let data = json.data(using: .utf8) else {
            throw EngineError.decode("\(method): no string returned")
        }
        do { return try JSONSerialization.jsonObject(with: data) }
        catch { throw EngineError.decode("\(method): \(error)") }
    }

    private func takeException() -> String? {
        defer { exceptionBox.message = nil }
        return exceptionBox.message
    }

    /// JS shim wrapping PartyCore (the native integration surface) in a flat,
    /// JSON-friendly API. PartyCore inverts Game's onEvent/onGameEnd push into a
    /// drained events buffer and applies the delivery filter (grid stripping,
    /// render-identical frame skipping), so this is marshalling and nothing else.
    ///
    /// The marked blocks are kept TOKEN-IDENTICAL to the Android shim
    /// (android/.../EngineBootstrap.kt) by tests/room-bridge-shim-parity.test.js,
    /// which also runs both of them against the real bundle. Anything outside the
    /// markers is platform-only and listed in that gate.
    private static let bootstrapJS = """
    var Bridge = (function () {
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
        roomSnapshotJSON: function () { return roomOrThrow().snapshotJSON(); },
        // ROOM-API-END
        // tvOS-only below (declared in tests/room-bridge-shim-parity.test.js).
        //
        // Granular tick, for driving the engine deterministically without
        // frame()'s clock (EngineBridgeTests). Android has no caller and so no
        // entry — everything there goes through frameJSON.
        update: function (dt) { if (core) core.update(dt); },
        // Screen-gallery fixtures (HexCore.GalleryFixtures) — the single source
        // the web, tvOS and Android TV galleries all render. Android reads the
        // same fixtures through its own QuickJS context in the screenshot tests,
        // not through this Bridge.
        galleryRosterJSON: function (n, long) { return JSON.stringify(HexCore.GalleryFixtures.roster(n, !!long)); },
        galleryJoinJSON: function () { return JSON.stringify(HexCore.GalleryFixtures.JOIN); },
        gallerySnapshotJSON: function (variant, players, level) {
          var GF = HexCore.GalleryFixtures;
          var spec = (variant && variant.length) ? GF.gameVariant(variant) : { players: players, level: level };
          return JSON.stringify(GF.gameSnapshot(spec));
        },
        galleryResultsJSON: function (n) { return JSON.stringify(HexCore.GalleryFixtures.results(n)); },
        galleryAmbientJSON: function () { return JSON.stringify(HexCore.GalleryFixtures.ambientPieces()); }
      };
    })();
    """
}
