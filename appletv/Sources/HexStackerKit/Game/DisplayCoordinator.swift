import Foundation

public enum DisplayScreen: Equatable { case lobby, game, results }
public enum CountdownValue: Equatable { case number(Int), go }

/// One display-ready results row: the engine's raw `PlayerResult` joined with the
/// roster's name/color, or a late joiner who sat the match out (rank/lines/level
/// nil, `newPlayer` true). Produced by the room core's `enrichResults`; `payload`
/// is the wire form that rides the RESULTS snapshot, omitting nil fields like the
/// web.
public struct MatchResult: Equatable, Decodable {
    public let playerId: Int
    public let playerName: String?
    public let colorIndex: Int?
    public let rank: Int?
    public let lines: Int?
    public let level: Int?
    public let alive: Bool?
    public let newPlayer: Bool

    public init(playerId: Int, playerName: String? = nil, colorIndex: Int? = nil,
                rank: Int? = nil, lines: Int? = nil, level: Int? = nil,
                alive: Bool? = nil, newPlayer: Bool = false) {
        self.playerId = playerId
        self.playerName = playerName
        self.colorIndex = colorIndex
        self.rank = rank
        self.lines = lines
        self.level = level
        self.alive = alive
        self.newPlayer = newPlayer
    }

    private enum CodingKeys: String, CodingKey {
        case playerId, playerName, colorIndex, rank, lines, level, alive, newPlayer
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        playerId = try c.decode(Int.self, forKey: .playerId)
        playerName = try c.decodeIfPresent(String.self, forKey: .playerName)
        colorIndex = try c.decodeIfPresent(Int.self, forKey: .colorIndex)
        rank = try c.decodeIfPresent(Int.self, forKey: .rank)
        lines = try c.decodeIfPresent(Int.self, forKey: .lines)
        level = try c.decodeIfPresent(Int.self, forKey: .level)
        alive = try c.decodeIfPresent(Bool.self, forKey: .alive)
        newPlayer = try c.decodeIfPresent(Bool.self, forKey: .newPlayer) ?? false
    }

    public var payload: [String: Any] {
        var e: [String: Any] = ["playerId": playerId]
        if let playerName { e["playerName"] = playerName }
        if let colorIndex { e["colorIndex"] = colorIndex }
        if let rank { e["rank"] = rank }
        if let lines { e["lines"] = lines }
        if let level { e["level"] = level }
        if let alive { e["alive"] = alive }
        if newPlayer { e["newPlayer"] = true }
        return e
    }
}

/// Side-effects the coordinator drives (rendering, audio, screen changes). The
/// tvOS app provides a concrete implementation (SpriteKit + AVFoundation);
/// tests provide a fake to assert behavior headlessly.
public protocol DisplayOutput: AnyObject {
    func showScreen(_ screen: DisplayScreen)
    /// The room is open: show the lobby with `joinURL` as the displayed host/code
    /// and `qrText` as the QR payload. In production the two are identical (the QR
    /// encodes the join URL); the screen gallery's JOIN fixture makes them differ.
    func roomReady(room: String, joinURL: String, qrText: String)
    func updateLobby(players: [PlayerRecord], hostPeerIndex: Int?)
    func showCountdown(_ value: CountdownValue)
    func renderSnapshot(_ snapshot: GameSnapshot)
    func handleGameEvent(_ event: GameEvent)
    func showResults(_ results: [MatchResult])
    /// Show (joinURL != nil) or clear (nil) a per-board disconnect/rejoin overlay.
    func setDisconnected(playerId: Int, joinURL: String?)
    /// Freeze the lobby's ambient falling-piece background to these fixture pieces
    /// (screen-gallery shots only); production keeps its live animation. Optional.
    func setLobbyAmbient(_ pieces: [AmbientPiece])
    /// Show/hide the paused overlay (driven by the remote or a controller).
    func setPaused(_ paused: Bool)
    /// The display mute changed (remote toggle or the host phone's Game Music
    /// switch) — keep any visible music switch in sync.
    func setDisplayMuted(_ muted: Bool)
    func playCountdownBeep(go: Bool)
    func startMusic()
    func stopMusic()
    func pauseMusic()
    func resumeMusic()
}

public extension DisplayOutput {
    // Visual-only hooks are optional.
    func handleGameEvent(_ event: GameEvent) {}
    func setDisconnected(playerId: Int, joinURL: String?) {}
    func setLobbyAmbient(_ pieces: [AmbientPiece]) {}
    func setPaused(_ paused: Bool) {}
    func setDisplayMuted(_ muted: Bool) {}
}

/// What a RoomCore mutator hands back — the fields THIS shell acts on. Every
/// mutator returns a small object whose only universal member is the `publish`
/// hint; the rest are per-method, so ONE all-optional struct decodes all of them
/// and each call site reads only what it asked for (unknown members are ignored,
/// and a void mutator returns JSON `null`, which becomes the all-nil value).
struct RoomResult: Decodable {
    var publish: String?         // 'now' | 'soon' | 'none'
    var added: Bool?             // peerJoined
    var accepted: Bool?          // hello
    var roomFull: Bool?          // hello
    var claimed: Bool?           // hello (a cross-device rejoin was honoured)
    var oldPeerIndex: Int?       // hello, the index the claim came from
    var known: Bool?             // peerLeft
    var action: String?          // peerLeft: 'disconnected' | 'removed' | 'none'
    var returnedToLobby: Bool?   // peerLeft, from the results screen
    var changed: Bool?           // transitionTo
}

/// One batched liveness pull (`RoomCore.tick`): who just went silent, and whether
/// the late-joiner grace window elapsed.
struct RoomTick: Decodable {
    let expired: [Int]
    let graceFired: Bool
}

/// The native display brain: owns the relay transport, the engine, and the display
/// half of the game lifecycle (lobby -> countdown -> playing -> results).
///
/// Room state is NOT owned here. Roster, auto-naming, name sanitizing, colour
/// slots, host election, pause/mute/results facts and the retained snapshot all
/// live in `server/RoomCore.js`, which runs inside the same JavaScriptCore
/// context as the engine and is reached through `EngineBridge`'s room API. The
/// web display and Android TV load that same module out of the same bundle, so
/// the three displays cannot drift; what is left here is transport, timers,
/// rendering and audio.
///
/// Single-threaded: call from the main thread; `tick(deltaMs:)` is driven once
/// per frame by the renderer. JavaScriptCore is synchronous, so every room call
/// below returns before the next line runs.
public final class DisplayCoordinator {

    private let transport: RelayTransport
    // Optional peer-to-peer input fast path (WebRTC DataChannels). Controller
    // input arrives over it when open and falls back to the relay otherwise; the
    // relay always carries SDP/ICE signaling and display -> controller messages.
    // nil in headless/tests and when the WebRTC framework isn't linked, leaving
    // the relay as the sole input path (the v1 behavior).
    private let fastlane: InputFastlane?
    // weak: the shell (tvOS DisplayModel) owns the coordinator and is its output
    // (a delegate-style back-reference). A strong ref here would form a
    // shell <-> coordinator cycle pinning the engine, relay and music forever.
    // (internal, not private: shared with the Gallery extension file.)
    weak var output: DisplayOutput?
    let engineDirectory: URL
    private let seedProvider: () -> UInt32

    /// The match-scoped engine handle the state machine gates on. Points at the
    /// same object as `runtime` while a match is live; nil'ed at match end.
    var engine: EngineBridge?
    /// The session-lived JavaScriptCore runtime. It holds BOTH the engine (rebuilt
    /// per match via Bridge.create, which is free on an existing context) and the
    /// room core (constructed once by `roomInit` and never torn down). Because the
    /// roomCore lives here, this handle is built once and then never dropped — see
    /// `roomCore()`.
    private var runtime: EngineBridge?
    /// Latched after a failed build so a missing/broken core bundle doesn't retry
    /// (and re-log) on every relay packet.
    private var runtimeFailed = false
    private var room: String?
    private var instance: String?

    // True while we are IN the room, not merely holding an open socket. While it's
    // false, controller traffic can't arrive, so the controller-liveness sweep must be
    // skipped (every lastSeen is stale through no fault of the controllers). Cleared
    // the moment the link drops (setRelayConnected), restored only by the relay's
    // `created`/`joined` reply — see roomLinkRestored().
    private var relayConnected = true

    // Monotonic clock fed to PartyCore.frame(); only deltas matter, so it never
    // needs resetting across games (a fresh engine re-primes on its first frame).
    private var frameClockMs = 0.0
    private var pendingSeed: UInt32 = 0
    var demoSeedOverride: UInt32?   // deterministic seed for HEXDEMO
    private let nowProvider: () -> Double    // wall-clock ms for liveness (injectable for tests)

    /// Peers heard from since the last frame. Batched deliberately: the room core's
    /// `tick(nowMs, seen)` exists so an 8-player input burst costs ONE bridge
    /// crossing per frame instead of one per packet.
    private var seenSinceTick: Set<Int> = []

    /// Which boards currently show a rejoin QR. Shell state, not room state: it is
    /// the set of overlays we have raised (the web's `disconnectedQRs`).
    /// INVARIANT: it moves in lockstep with the room core's presence set — every site
    /// that raises one calls markDisconnected, every site that clears one calls
    /// markReconnected. If they drift, host election (which reads the room core) skips
    /// a present player. It is also what makes the per-packet reconnect check free.
    private var rejoinQRs: Set<Int> = []

    // Retained-snapshot throttle. Leading + trailing, with the trailing edge pumped
    // from tick(): the room core decides WHICH calls take the throttled path (every
    // mutator returns a 'now' | 'soon' | 'none' hint), the shell only owns the
    // timer, because a timer needs a real clock and the room core has none.
    private var lastSnapshotAt = -1e12
    private var snapshotPending = false
    /// Non-nil only while a publishBatch block is running: the hint accumulated so
    /// far. Doubles as the "are we batching" flag.
    private var batchHint: String?

    /// RoomCore.snapshotThrottleMs, read out of the bundle once the room core is up
    /// (see `roomCore()`), so the window is not mirrored in Swift at all. The
    /// fallback only covers the window before the first successful roomInit, and
    /// on a runtime that failed to build there is no publishing to throttle.
    public private(set) var snapshotThrottleMs = 500.0

    // The single-threaded contract (class doc) is otherwise enforced by nothing:
    // a RelayClient built with a non-main callbackQueue would race the fields
    // here AND the JSContext against the render loop's tick(). Capture the
    // constructing thread and fail fast in debug at every entry point.
    private let owningThread = Thread.current
    private func assertOwningThread(_ function: String = #function) {
        assert(Thread.current === owningThread,
               "DisplayCoordinator.\(function) called off its owning thread; the transport callbackQueue and the render loop must share one thread")
    }

    // Local demo (no relay/controllers): drives a game with synthetic input so
    // the renderer can be exercised and screenshotted headlessly. The demo/gallery
    // methods live in DisplayCoordinator+Gallery.swift; extensions can't add
    // stored properties, so their state lives here.
    var demoActive = false
    var demoTick = 0

    // Render-on-input coalescing: true once handleInput has pulled a snapshot
    // since the last tick(), so message bursts cost at most one pull per frame.
    private var renderedInputSinceTick = false

    /// Inputs accepted but not yet handed to the engine. Every crossing costs, so a
    /// frame's worth goes over as ONE batch, carried by whatever read follows.
    /// Drained by `takeInputs()`, which MUST run before anything else touches the
    /// engine — it is one mutable board set, and a soft-drop or a frame that ran
    /// ahead of queued input would act on a board the controller already moved past.
    private var pendingInputs: [(playerId: Int, action: String)] = []

    /// The last snapshot handed to the output, so a per-seat pull can be merged into
    /// the room already on screen instead of pulling every board back out.
    private var lastSnapshot: GameSnapshot?

    // Countdown driven by accumulated frame time (deterministic, testable).
    private var countdownElapsed = 0.0
    private var countdownStep = -1   // last emitted step: 0->3,1->2,2->1,3->GO,4->start
    // Countdown beat. Pinned to server/constants.js by tests/protocol-swift-parity.test.js;
    // the sequencing itself is per-shell on purpose (see that test).
    private static let stepMs = 1000.0
    private static let goHoldMs = 500.0

    private static let maxFrameDeltaMs = 50.0   // matches the web frame clamp

    public init(transport: RelayTransport,
                engineDirectory: URL,
                output: DisplayOutput,
                fastlane: InputFastlane? = nil,
                seedProvider: @escaping () -> UInt32 = { UInt32.random(in: 0...UInt32.max) },
                nowProvider: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.transport = transport
        self.engineDirectory = engineDirectory
        self.output = output
        self.fastlane = fastlane
        self.seedProvider = seedProvider
        self.nowProvider = nowProvider
    }

    // MARK: - The room core

    /// Liveness policy handed to the room core at construction, mirroring
    /// server/constants.js (LIVENESS_TIMEOUT_MS / LATE_JOINER_GRACE_MS). Pinned to
    /// those values by tests/protocol-swift-parity.test.js.
    static let livenessTimeoutMs = 3000
    static let lateJoinerGraceMs = 5000

    /// The session's JavaScriptCore runtime, materialized on first use with the
    /// room core already constructed inside it.
    ///
    /// Room state exists before the first rendered frame — the relay's `created`
    /// and `peer_joined` land early — so this is called from `start()`,
    /// SYNCHRONOUSLY, before `transport.connect()`. That ordering is the whole
    /// answer to "the room core lives in a runtime that used to be built lazily": the
    /// runtime is now built once per session, up front, and the old off-main
    /// per-match prewarm is gone with it (there is nothing left to prewarm, and an
    /// async build would reintroduce exactly the race this closes). The offline
    /// harnesses (gallery shots, local demo) never call `start()` and reach it here
    /// through their first roster write instead.
    @discardableResult
    private func roomCore() -> EngineBridge? {
        if let runtime { return runtime }
        guard !runtimeFailed else { return nil }
        do {
            let e = try EngineBridge(engineDirectory: engineDirectory)
            // Surface fire-and-forget engine/room exceptions instead of dropping them.
            e.onEngineError = { message in
                FileHandle.standardError.write(Data("[engine] \(message)\n".utf8))
            }
            try e.roomInit(optionsJSON: Self.roomOptionsJSON)
            // The publish window comes from the module too: Android reads the
            // same property, so the number lives in exactly one place. Same for
            // how strong each hint is (publishRank) — the fold below is local,
            // but what "stronger" means is the room core's call.
            if let ms = try? e.roomGet(Double.self, "snapshotThrottleMs") { snapshotThrottleMs = ms }
            if let rank = try? e.roomGet([String: Int].self, "publishRank") { publishRank = rank }
            runtime = e
            return e
        } catch {
            runtimeFailed = true
            FileHandle.standardError.write(Data("[room] runtime unavailable: \(error)\n".utf8))
            return nil
        }
    }

    private static var roomOptionsJSON: String {
        "{\"maxPlayers\":\(EngineConstants.maxPlayers),"
        + "\"liveness\":{\"timeoutMs\":\(livenessTimeoutMs),\"graceMs\":\(lateJoinerGraceMs)}}"
    }

    /// Encode a room call's arguments as the JSON array the bridge expects. Values
    /// are the JSON-native types the room core takes (numbers, strings, bools, arrays,
    /// dictionaries — including a raw inbound HELLO, which arrived as JSON anyway).
    ///
    /// Returns nil rather than a fallback if the list won't encode, and the callers
    /// then DROP the call: a HELLO carrying something JSONSerialization refuses
    /// would otherwise reach the room core with zero arguments, and
    /// `hello(undefined, ...)` seats a roster row under the key `undefined`.
    private static func argsJSON(_ args: [Any]) -> String? {
        guard !args.isEmpty else { return "[]" }
        guard JSONSerialization.isValidJSONObject(args),
              let data = try? JSONSerialization.data(withJSONObject: args),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }

    /// JSON-safe optional. JSONSerialization rejects a wrapped `Optional`, so an
    /// absent field crosses as an explicit null — which the room core's parseInt /
    /// typeof checks reject exactly like a missing one.
    private static func opt<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }

    /// Call a room mutator and decode its result. Non-throwing on purpose: every
    /// caller is a void relay/remote entry point on a display that has to keep
    /// running, so a bridge failure is logged (by EngineBridge's exception drain)
    /// and degrades to "nothing happened" rather than propagating.
    @discardableResult
    private func roomDo(_ method: String, _ args: [Any] = []) -> RoomResult {
        roomValue(RoomResult.self, method, args) ?? RoomResult()
    }

    /// Call a room method and decode a typed return value (`nil` on a void return
    /// or a bridge failure).
    private func roomValue<T: Decodable>(_ type: T.Type, _ method: String, _ args: [Any] = []) -> T? {
        guard let bridge = roomCore(), let argsText = Self.argsJSON(args) else { return nil }
        return try? bridge.roomCall(T.self, method, argsText)
    }

    /// Read a room property (`state`, `host`, `participants`, `muted`, ...).
    private func roomProperty<T: Decodable>(_ type: T.Type, _ property: String) -> T? {
        guard let bridge = roomCore() else { return nil }
        return try? bridge.roomGet(T.self, property)
    }

    /// A scalar property, read as raw JSON. Scalars are the hot reads (`state` and
    /// the three pause flags are consulted on the input and frame paths), and a
    /// one-token JSON text is cheaper to match than to hand to JSONDecoder.
    private func roomScalar(_ property: String) -> String? {
        guard let bridge = roomCore() else { return nil }
        return try? bridge.roomGetJSON(property)
    }

    private func roomFlag(_ property: String) -> Bool { roomScalar(property) == "true" }

    /// A predicate call, matched on the raw JSON for the same reason as roomScalar.
    private func roomBool(_ method: String, _ args: [Any] = []) -> Bool {
        guard let bridge = roomCore(), let argsText = Self.argsJSON(args) else { return false }
        return (try? bridge.roomCallJSON(method, argsText)) == "true"
    }

    private func roomInt(_ method: String, _ args: [Any] = []) -> Int? {
        guard let bridge = roomCore(), let argsText = Self.argsJSON(args) else { return nil }
        return (try? bridge.roomCallJSON(method, argsText)).flatMap { Int($0) }
    }

    /// The same runtime the room core lives in, for the gallery's static
    /// GalleryFixtures reads. One JSContext per coordinator: the gallery used to
    /// build a second one, back when the first existed only per match.
    var fixtureBridge: EngineBridge? { roomCore() }

    // MARK: - Room reads (the shell's window onto the room core)

    public var state: RoomState {
        // JSON string literal: "lobby" with the quotes. The four room states are
        // fixed ASCII words, so there is nothing for a decoder to unescape.
        guard let json = roomScalar("state"), json.count > 2 else { return .lobby }
        return RoomState(rawValue: String(json.dropFirst().dropLast())) ?? .lobby
    }

    /// The effective host: platform master, else the sticky slot, else the
    /// oldest-joined eligible present player. All of it lives in the kit's RoomFlow
    /// inside the room core.
    public var hostPeerIndex: Int? {
        guard let json = roomScalar("host") else { return nil }
        return Int(json)   // "null" -> nil, which is exactly "no host"
    }

    /// The full roster, join-ordered. Carries `connected` and `joinedAt`, which the
    /// wire snapshot deliberately does not, so this is what the lobby UI reads.
    public func roster() -> [PlayerRecord] { roomValue([PlayerRecord].self, "list") ?? [] }

    /// One roster row, or nil. A missing peer answers JSON `null`, which simply
    /// fails to decode into a keyed container.
    public func player(_ peerIndex: Int) -> PlayerRecord? {
        roomValue(PlayerRecord.self, "get", [peerIndex])
    }

    public var playerCount: Int { roomScalar("size").flatMap { Int($0) } ?? 0 }

    /// Active participants in board-layout order. Not the same as the roster: in
    /// the lobby everyone is a participant, mid-game a late joiner is not.
    var participants: [Int] { roomProperty([Int].self, "participants") ?? [] }

    func isDisconnected(_ peerIndex: Int) -> Bool { roomBool("isDisconnected", [peerIndex]) }

    var allParticipantsDisconnected: Bool { roomBool("allParticipantsDisconnected") }

    // MARK: - Fixture roster (gallery shots + the local demo)

    /// Register a roster row verbatim, bypassing slot allocation and auto-naming.
    /// Gallery scenarios and the HEXLOBBY/HEXDEMO harnesses need a deterministic,
    /// possibly non-contiguous roster that a real join sequence would never produce;
    /// real joins go through peerJoined / hello, where the allocation policy lives.
    func seedPlayer(peerIndex: Int, playerName: String, colorSlot: Int, startLevel: Int = 1) {
        roomDo("addPlayer", [peerIndex, [
            "playerName": playerName,
            "playerIndex": colorSlot,
            "startLevel": startLevel,
            "helloSeen": true,
        ]])
    }

    /// Lowest free colour slot, for the fixture path above.
    func nextColorSlot() -> Int { roomInt("nextAvailableColorSlot") ?? 0 }

    // Pause is a union of independent reasons so they don't clobber each other (a
    // host Continue must not un-pause an all-disconnected freeze). The room core holds
    // all three and projects only the manual one into the snapshot: the auto-
    // (everyone disconnected) and connection (our own link down) pauses are
    // display-internal, self-clearing, and a controller shown either would get a
    // Continue that cannot work.
    /// WHY we are frozen, or nil. One field in the room core, not a composite plus
    /// two reason flags: the reasons are mutually exclusive and each call site
    /// already picks one. `paused` is derived, so the two can no longer disagree.
    private var pauseReason: PauseReason? {
        roomScalar("pauseReason").flatMap { PauseReason(json: $0) }
    }
    private var paused: Bool { roomFlag("paused") }

    public var isMuted: Bool { roomFlag("muted") }

    // MARK: - Lifecycle

    public func start() {
        assertOwningThread()
        // Build the runtime (and with it the room core) BEFORE the socket opens —
        // see roomCore(). Everything below can be answered by a relay callback.
        roomCore()

        transport.onCreated = { [weak self] room, instance, region in
            self?.onCreated(room: room, instance: instance)
        }
        transport.onJoined = { [weak self] room, peers in
            self?.onJoined(room: room, peers: peers)
        }
        transport.onPeerJoined = { [weak self] idx in self?.onPeerJoined(idx) }
        transport.onPeerLeft = { [weak self] idx in self?.onPeerLeft(idx) }
        transport.onMessage = { [weak self] from, data in self?.onMessage(from: from, data: data) }
        transport.onRelayError = { [weak self] message in self?.onRelayError(message) }
        // Controller input arriving over the fastlane routes through the SAME
        // handler as relay input, so dedup/liveness/game logic is single-sourced.
        fastlane?.onInput = { [weak self] from, data in self?.onMessage(from: from, data: data) }
        transport.connect()
    }

    private func onCreated(room: String, instance: String?) {
        assertOwningThread()
        self.room = room
        self.instance = instance
        // A fresh room has an empty roster, so there is nothing to re-stamp — but the
        // sweep must come back on, or the room-gone recovery path (onRelayError ->
        // recreateRoom) would leave liveness off for the rest of the session.
        roomLinkRestored()
        let url = joinURL(room: room, instance: instance)
        output?.roomReady(room: room, joinURL: url, qrText: url)   // production QR == join URL
        output?.showScreen(.lobby)
    }

    private func onJoined(room: String, peers: [Int]) {
        assertOwningThread()
        // Display relay-reconnect: reconcile present controllers, then republish.
        self.room = room
        // Re-confirm the lobby QR: the link was down (QR untrusted, rendered dimmed)
        // and this `joined` proves the room survived, so the same code + QR are valid
        // again. The room-gone path re-confirms via onCreated instead.
        let url = joinURL(room: room, instance: instance)
        output?.roomReady(room: room, joinURL: url, qrText: url)
        // Re-stamp the still-present peers and clear any rejoin overlay; collect the
        // ones the relay no longer lists, then route each through the SAME
        // state-aware onPeerLeft the web delegates to (lobby → remove the slot;
        // countdown/playing → keep the slot AND raise the per-board rejoin QR;
        // results → trim the order + maybe return to the lobby). Marking them
        // disconnected inline instead would strand the board with no rejoin QR and,
        // because expiredPeers skips already-disconnected peers, never self-heal.
        var goneIds: [Int] = []
        for p in roster() {
            guard peers.contains(p.peerIndex) else { goneIds.append(p.peerIndex); continue }
            seenSinceTick.insert(p.peerIndex)
            if !p.connected {
                roomDo("markReconnected", [p.peerIndex])
                clearRejoinQR(p.peerIndex)
            }
        }
        // The whole reconciliation is ONE change: however many peers went missing, plus
        // the resume, collapse into a single publish at the end. Per-departure publishes
        // would ship half-reconciled rosters, and — because the resume comes last — a
        // paused=true snapshot chased by a paused=false one, which is exactly how a
        // controller ends up stranded on a pause overlay whose Continue cannot help
        // (resumeGame is gated on the manual pause, and the display is no longer paused
        // at all). Floor "now": this publish has to reach controllers even when nothing
        // moved, because it also clears their reconnect overlay and display-gone bail
        // timer and tells them the game is running again. Web onDisplayRejoined and
        // Android handleJoined batch the same span.
        publishBatch(floor: Self.publishNow) {
            for id in goneIds { onPeerLeft(id) }
            // Inside the batch, so the resume lands before the one snapshot goes out.
            roomLinkRestored()
        }
    }

    /// A relay-level `error`. A fatal room error on (re)connect — the relay lost
    /// the room, or it filled — is recovered by tearing down and opening a fresh
    /// room, exactly as the web display's resetToWelcome does (the TV has no
    /// welcome screen, so it lands straight back on the lobby). Other errors are
    /// non-fatal and ignored (the app UI surfaces them if needed).
    private func onRelayError(_ message: String) {
        assertOwningThread()
        guard message == "Room not found" || message == "Room is full" else { return }
        engine = nil
        discardEngineState()
        output?.stopMusic()
        setPauseOverlay(false)
        rejoinQRs.removeAll()
        seenSinceTick.removeAll()
        // Clears the roster, participants, alive flags, results, the pause reason and
        // the room state back to lobby. Mute survives (a device preference, not room
        // state). This used to need a follow-up clear for the connection pause, which
        // reset() did not touch — one of the three ways the three flags diverged.
        roomDo("reset")
        output?.showScreen(.lobby)   // drop the frozen game immediately
        transport.recreateRoom()     // fresh room; onCreated re-shows the lobby with the new code
    }

    private func onPeerJoined(_ index: Int) {
        assertOwningThread()
        // The room core allocates the colour slot, invents the placeholder auto-name (with
        // the blocklist this platform used to be missing entirely) and decides whether
        // this joiner is a lobby member or a late joiner waiting out the round. It
        // refuses silently on a full room and on a duplicate — an in-session reconnect
        // lands on the SAME slot, and re-adding would clobber the kept colour/level.
        let res = roomDo("peerJoined", [index, nowProvider()])
        guard res.added == true else { return }
        publishAs(res.publish)
    }

    private func onPeerLeft(_ index: Int) {
        assertOwningThread()
        // Drop any peer-to-peer channel to the departed controller; a reconnecting
        // controller re-offers and a fresh fastlane peer is built (web parity).
        fastlane?.closePeer(index)
        // End any in-progress soft drop so the departed board doesn't keep falling
        // fast until the engine's own deadline fires (web cleanupPlayerInput).
        engine?.softDropEnd(playerId: index)
        // The room core owns the branch: mid-game an active participant keeps their row
        // (so the slot stays pinned for a reconnect via claimReconnect), while a late
        // joiner and anyone leaving in lobby/results is dropped outright, with the
        // sticky-host handoff and the empty-results return to lobby handled inside.
        let res = roomDo("peerLeft", [index])
        guard res.known == true else { return }
        if res.action == "disconnected" {
            raiseRejoinQR(index)
            checkAllParticipantsDisconnected()
        } else {
            // The row is gone, so its overlay flag must go too, or a later peer
            // landing on the same index would read as a returning disconnect.
            rejoinQRs.remove(index)
        }
        if res.returnedToLobby == true { returnToLobbyUI() }
        // The roster changed in every branch: someone is gone, the host may have moved
        // to a present player, and a mid-game departure flips that player's `alive` for
        // the remaining boards. Publishing unconditionally also covers the
        // last-player-leaves case, where the snapshot must stop naming a departed
        // player (and a stale host) to the next peer that joins.
        publishAs(res.publish)
    }

    /// Any active participant still present and connected.
    private func hasConnectedParticipant() -> Bool {
        let active = Set(participants)
        return roster().contains { active.contains($0.peerIndex) && $0.connected }
    }

    // MARK: - Inbound messages

    private func onMessage(from: Int, data: [String: Any]) {
        assertOwningThread()
        // Intercept WebRTC signaling envelopes for the fastlane before app
        // dispatch — handleSignal returns true iff it was an `__rtc` message.
        // (Fastlane-delivered input loops back here too, but as a plain controller
        // message, so it falls straight through to the parse below.)
        if let fastlane, fastlane.handleSignal(from: from, data: data) { return }
        guard let msg = ControllerMessage(data) else { return }

        // Any message proves the sender is alive. The stamp is batched into the next
        // frame's tick(); the reconnect edge is read off our OWN rejoin-QR set, so a
        // packet from a healthy controller costs nothing across the bridge.
        seenSinceTick.insert(from)
        let wasDisconnected = rejoinQRs.contains(from)
        if wasDisconnected {
            clearRejoinQR(from)
            roomDo("markReconnected", [from])
            roomDo("onSeen", [from, nowProvider()])
        }

        switch msg.type {
        case MSG.hello: handleHello(from: from, data: data)
        case MSG.input: handleInput(from: from, msg: msg)
        case MSG.softDrop:
            // Guard the Double->Int conversion: a malformed `speed` (e.g. 1e308)
            // would trap in Int.init and abort the display; ignore it instead.
            if state == .playing, !paused {
                flushInputs() // a soft-drop must not overtake queued left/right
                engine?.softDropStart(playerId: from, speed: msg.speed.flatMap { $0.isFinite && abs($0) < 9.0e15 ? Int($0) : nil })
            }
        case MSG.softDropEnd:
            if state == .playing { flushInputs(); engine?.softDropEnd(playerId: from) }
        case MSG.startGame:
            if state == .lobby, playerCount >= 1 { beginCountdown() }
        case MSG.playAgain:
            if state == .results, playerCount >= 1 { beginCountdown() }
        case MSG.returnToLobby: returnToLobby()
        case MSG.pauseGame: pauseGame()
        case MSG.resumeGame: resumeGame()
        case MSG.leave: onPeerLeft(from)
        case MSG.setLevel: handleSetLevel(from: from, msg: msg)
        case MSG.setColor: handleSetColor(from: from, msg: msg)
        case MSG.setName: handleSetName(from: from, msg: msg)
        case MSG.setDisplayMute: handleSetMute(from: from, msg: msg)
        case MSG.ping: transport.sendTo(from, OutboundMessage.pong(t: msg.t))
        default: break
        }

        // Auto-resume after processing the message, so the reconnecting controller
        // has already been sent a snapshot describing the paused game before the
        // resume publishes over the top of it.
        if wasDisconnected { autoResume() }   // no-ops unless the freeze was an auto-pause
    }

    /// `data` is the RAW hello, not the parsed `ControllerMessage`: the room core reads
    /// `name`/`autoName`/`colorIndex`/`rejoinToken`/`rejoinId` itself, and its
    /// lenient parsing (a rejoin token arrives as the string from `?claim=`) is
    /// exactly the parsing the web display does. Re-normalizing it here first would
    /// be a second implementation of the thing this refactor deleted.
    private func handleHello(from: Int, data: [String: Any]) {
        // Everything a HELLO decides lives in the room core: the name (sanitized, with
        // empty and legacy P1-P8 submissions resolving to room-unique HX names), the
        // preferred colour (honoured right away, so the snapshot below already names
        // the colour the controller will keep), whether a cross-device rejoin claim is
        // valid, and whether the room is full.
        let res = roomDo("hello", [from, data, nowProvider()])

        // The room half of a claim moved inside; the game half is ours.
        if res.claimed == true, let oldId = res.oldPeerIndex {
            applyReconnectClaim(oldId: oldId, from: from)
        }

        guard res.accepted == true else {
            if res.roomFull == true {
                transport.sendTo(from, OutboundMessage.error(message: "Room is full"))
            }
            return
        }

        // One publish settles everything a HELLO can move: this controller's own
        // identity (name, colour, level), the roster the others render, and the host,
        // since a reconnecting ex-host reclaims the role their pinned slot held through
        // the disconnect. A brand-new joiner needs it too: it is how they learn who
        // they are and which screen to show.
        publishAs(res.publish)
        if res.claimed == true { autoResume() }
    }

    /// Finish a cross-device rejoin the room core has already accepted: everything keyed
    /// by peer index that lives OUTSIDE the room (the engine's board, garbage queue
    /// and drop cooldown, and the rejoin overlays) moves from the old index to the
    /// new one. The room half (roster record, sticky host slot, participant order,
    /// alive flags, cached ranking) moved inside the room core's claimReconnect.
    ///
    /// The engine's own rekey refusal is unreachable by construction — the room core
    /// only accepts a claim whose old index IS a participant (so it owns a board)
    /// and whose new index is NOT (so it owns none) — but a refusal would desync
    /// roster and engine, so it is logged rather than swallowed.
    private func applyReconnectClaim(oldId: Int, from: Int) {
        engine?.softDropEnd(playerId: oldId)
        engine?.softDropEnd(playerId: from)
        flushInputs() // queued input belongs to the board as it stands BEFORE the rekey
        if let engine, !engine.rekeyPlayer(oldId: oldId, newId: from) {
            FileHandle.standardError.write(Data("[engine] rekeyPlayer \(oldId) -> \(from) refused\n".utf8))
        }
        clearRejoinQR(oldId)
        clearRejoinQR(from)
    }

    private func handleInput(from: Int, msg: ControllerMessage) {
        guard state == .playing, !paused, let action = msg.action,
              InputAction(rawValue: action) != nil else { return }
        guard engine != nil else { return }
        pendingInputs.append((playerId: from, action: action))
        // Render-on-input: reflect the applied input on the very next display frame
        // instead of waiting for the next tick(). The pull is a pure read (no time
        // advance), so it only front-runs the VISUAL; this frame's events/commands
        // (lock flash, garbage, sends) still flow on the next tick().
        // Coalesced to one pull per frame: an 8-player input burst can land several
        // messages inside one 16 ms window. Later inputs still show on the tick's own
        // snapshot — they are applied by then, because the drain below takes
        // everything pending, not just this message.
        guard !renderedInputSinceTick, let engine else { return }
        renderedInputSinceTick = true
        let batch = takeInputs()
        // ONE seat, merged into the room already on screen: an input can only have
        // moved this board, so deep-copying the other seven is waste. The batch rides
        // into the pull, so this is a single crossing.
        guard let prev = lastSnapshot else {
            // Nothing retained to merge into yet (first input of a match): apply the
            // batch and fall back to the full pull rather than skip the repaint.
            engine.processInputs(batch)
            if let snap = try? engine.snapshot() { render(snap) }
            return
        }
        guard let pulled = try? engine.snapshotPlayer(from, inputs: batch),
              let moved = pulled.players.first,
              prev.players.contains(where: { $0.id == moved.id }) else {
            // A seat the retained room predates (the input that follows a rekey names
            // the NEW id, which the last render still calls by the old one). Fall back
            // to the full pull rather than skip the repaint — the batch is already
            // applied by the pull above, so this only re-reads. Matches Android.
            if let snap = try? engine.snapshot() { render(snap) }
            return
        }
        render(GameSnapshot(
            players: prev.players.map { $0.id == moved.id ? moved : $0 },
            // elapsed comes from the pull: it drives the match timer, and keeping the
            // retained value would freeze the clock while a direction is held.
            elapsed: pulled.elapsed))
    }

    /// Drop the per-match engine-side state. Runs wherever the engine handle is
    /// released: input queued for a match that just ended has nothing to apply to,
    /// and a retained snapshot of it must not be merged into the NEXT match's boards.
    private func discardEngineState() {
        pendingInputs.removeAll(keepingCapacity: true)
        lastSnapshot = nil
    }

    /// Drain the queued inputs for a caller that is about to cross into the engine
    /// anyway and can carry them along.
    private func takeInputs() -> [(playerId: Int, action: String)] {
        defer { pendingInputs.removeAll(keepingCapacity: true) }
        return pendingInputs
    }

    /// Apply anything queued without a read to fuse it into.
    private func flushInputs() {
        let batch = takeInputs()
        guard !batch.isEmpty else { return }
        engine?.processInputs(batch)
    }

    /// The one place a snapshot reaches the output, so the retained copy the per-seat
    /// merge builds on can never fall out of step with what is drawn.
    private func render(_ snapshot: GameSnapshot) {
        lastSnapshot = snapshot
        output?.renderSnapshot(snapshot)
    }

    private func handleSetLevel(from: Int, msg: ControllerMessage) {
        // Held-finger control: the room core's 'soon' hint routes this through the
        // throttle, so a burst of +/- taps collapses to at most ~2 publishes per
        // second and the trailing one always carries the final level. Outside the
        // lobby the stepper is unreachable and the hint is 'none'.
        publishAs(roomDo("setLevel", [from, Self.opt(msg.level)]).publish)
    }

    /// Re-claim a palette slot. The room core silently rejects collisions so concurrent
    /// picks don't spam the sender with errors; the next snapshot carries the truth.
    private func handleSetColor(from: Int, msg: ControllerMessage) {
        publishAs(roomDo("setColor", [from, Self.opt(msg.colorIndex)]).publish)
    }

    /// Live rename from an already-registered controller (e.g. an AirConsole profile
    /// edit). Unlike SET_COLOR this is allowed in every state, including mid-game,
    /// because it only relabels the player and never touches game state.
    private func handleSetName(from: Int, msg: ControllerMessage) {
        publishAs(roomDo("setName", [from, Self.opt(msg.name)]).publish)
    }

    private func handleSetMute(from: Int, msg: ControllerMessage) {
        // Host-only: non-host controllers can't mute the shared display.
        guard from == hostPeerIndex else { return }
        setDisplayMuted(msg.muted == true)
    }

    /// Apply the display mute and publish it: `displayMuted` rides the snapshot,
    /// which is what the retired DISPLAY_MUTED broadcast used to do. Also applies to
    /// live audio immediately, so the flag doesn't only take effect at the next
    /// match start.
    private func setDisplayMuted(_ next: Bool) {
        let res = roomDo("setMuted", [next])
        if next { output?.pauseMusic() }
        else if state == .playing && !paused { output?.resumeMusic() }
        output?.setDisplayMuted(next)   // keep a visible pause-menu switch live
        publishAs(res.publish)
    }

    // MARK: - Countdown + game

    func beginCountdown() {
        assertOwningThread()
        guard state == .lobby || state == .results else { return }
        // Web startNewGame, in its order: lift any pause and clear the previous
        // match's ranking / KO flags, drop everyone who went missing (AirConsole flags
        // without expiring; relay mode can expire one before a QR flag was set), then
        // decide whether there is still a game to start.
        clearPause()
        roomDo("setResults", [NSNull()])
        roomDo("clearAlive")
        roomDo("pruneDisconnected", [nowProvider()])
        rejoinQRs.removeAll()
        roomDo("clearDisconnected", [nowProvider()])
        // Everyone who remained was disconnected — don't launch an empty game. From
        // RESULTS this returns to the lobby; from LOBBY returnToLobby no-ops and the
        // publish below refreshes the (now empty) lobby controls.
        guard playerCount >= 1 else {
            if state == .lobby { publishAs(Self.publishNow) } else { returnToLobby() }
            return
        }
        // Fold in the late joiners who sat out the previous round.
        roomDo("admitWaiting")
        guard roomDo("transitionTo", ["countdown"]).changed == true else { return }
        // Sort participants by join time so the leftmost board is the first joiner,
        // and pin the result as this round's active set (and host-eligibility set).
        let order = roomValue([Int].self, "freezeParticipantOrder") ?? []
        // Stamp everyone present so a controller that went briefly quiet in the lobby
        // isn't instantly expired once the COUNTDOWN liveness gate applies. tick() is
        // the room core's batched seen-list entry point; its expiry decisions are empty by
        // construction here, because it has just stamped every peer it could report.
        roomDo("tick", [nowProvider(), roster().map(\.peerIndex)])
        guard !order.isEmpty else { returnToLobby(); return }

        pendingSeed = demoSeedOverride ?? seedProvider()
        countdownElapsed = 0
        countdownStep = -1

        // Build the engine now and show the game screen so the boards are visible
        // behind the countdown overlay, matching the web's 3-2-1-GO over the game
        // board. Render the PRE-GAME projection (empty wells: no spawn piece,
        // ghost, hold, or next queue) — the web hides those until play begins.
        guard makeEngine(order: order) else { returnToLobby(); return }
        // Controllers route their screens purely off snapshot.roomState, so the
        // COUNTDOWN transition's publish is what dims their pad; the digits themselves
        // never cross the wire (that is what the retired COUNTDOWN broadcast did).
        publishAs(Self.publishNow)
        output?.showScreen(.game)
        if let engine, let snap = try? engine.snapshot() { output?.renderSnapshot(snap.preGame()) }
        // First countdown value in the SAME call as the screen change, so the
        // output can present boards + scrim as one unit (no bare-board frames
        // while waiting for the first tick).
        emitCountdownStep(0)
    }

    private func makeEngine(order: [Int]) -> Bool {
        guard let bridge = roomCore() else { return false }
        discardEngineState() // a fresh match starts from an empty batch and no retained boards
        var levels: [Int: Int] = [:]
        for rec in roster() { levels[rec.peerIndex] = rec.startLevel }
        let players: [(id: Int, startLevel: Int)] = order.map { (id: $0, startLevel: levels[$0] ?? 1) }
        do {
            try bridge.createGame(players: players, seed: pendingSeed)
            engine = bridge
            return true
        } catch {
            // Deliberately NOT dropping the runtime the way the old per-match build
            // did: the room core lives in this same context, so discarding it would
            // take the whole room with it. A JS throw inside Bridge.create leaves the
            // context itself intact.
            FileHandle.standardError.write(Data("[engine] createGame failed: \(error)\n".utf8))
            return false
        }
    }

    private func startPlaying() {
        // The engine and game screen are already set up in beginCountdown; go live so
        // tick() starts advancing the simulation. The transition publishes, which is
        // what arms the controllers' touch input (the retired GAME_START broadcast).
        publishAs(roomDo("transitionTo", ["playing"]).publish)
    }

    /// Drive one frame. The renderer calls this every display tick with the real
    /// elapsed milliseconds.
    public func tick(deltaMs rawDelta: Double) {
        assertOwningThread()
        renderedInputSinceTick = false   // new frame: re-arm render-on-input
        flushPendingSnapshot()           // trailing edge of the set_state throttle
        let deltaMs = min(max(rawDelta, 0), Self.maxFrameDeltaMs)
        let roomState = state
        // The local demo has no controllers sending heartbeats, so keep its
        // synthetic players "seen" — otherwise the liveness sweep flags them
        // disconnected after 3 s and auto-pauses the self-playing game, and
        // on RESULTS the presence sweep would auto-return a finished demo
        // match to the lobby (which cuts the HEXTOUR results dwell short).
        if demoActive, roomState != .lobby { seenSinceTick.formUnion(participants) }
        switch roomState {
        case .countdown:
            pollPresence(nowProvider(), roomState)
            guard state == .countdown else { return }
            advanceCountdown(deltaMs: deltaMs)
        case .playing:
            pollPresence(nowProvider(), roomState)
            // pollPresence can return to lobby (grace) — re-check before ticking.
            guard state == .playing, !paused, let engine else { return }
            if demoActive { driveDemoInput() }
            // Pull one engine frame through PartyCore (the native integration
            // surface): it ticks, drains events, value-copies the snapshot and
            // normalizes host effects in a single call. `frameClockMs` is the
            // monotonic clock PartyCore turns into a capped per-frame delta.
            frameClockMs += deltaMs
            let frame: FrameResult
            do { frame = try engine.frame(nowMs: frameClockMs, inputs: takeInputs()) }
            catch {
                // Dropping one frame is fine; a PERSISTENT failure freezes the game,
                // so it must at least be visible in the log (decode errors don't
                // pass through onEngineError).
                FileHandle.standardError.write(Data("[engine] frame failed: \(error)\n".utf8))
                return
            }
            // Events are the complete record — drive the native-only board
            // animations from them (line clears, lock flashes, KO, shakes).
            for event in frame.events { output?.handleGameEvent(event) }
            // nil = render-identical to the last delivered frame (PartyCore's
            // scene signature): the scene keeps drawing its retained state and
            // its own time-driven animations, so skipping the push saves the
            // decode AND the node updates. Events above still fire, since a
            // frame that changes nothing still has none.
            if let snapshot = frame.snapshot { output?.renderSnapshot(snapshot) }
            // Commands normalize the host effects (controller sends, match end),
            // single-sourced from PartyCore so they can't drift from the web.
            // One frame is one change: a tick that KOs several players at once (a
            // garbage cascade, a simultaneous top-out) would otherwise publish the
            // whole room once per KO before anyone sees the first. No floor, so a
            // frame that moved nothing publishes nothing — which is what keeps this
            // free at 60 Hz. Web batches displayGame.update() for the same reason.
            publishBatch { dispatchCommands(frame.commands) }
        case .results:
            // Run presence so the results screen returns to the lobby once every
            // controller has dropped (web RESULTS auto-return).
            pollPresence(nowProvider(), roomState)
        case .lobby:
            // Flush the batched liveness stamps anyway, so a lobby that sat idle
            // doesn't hand the first COUNTDOWN sweep a roster of stale timestamps.
            _ = drainSeen(nowProvider())
        }
    }

    private func advanceCountdown(deltaMs: Double) {
        guard !paused else { return }
        countdownElapsed += deltaMs
        let nextStep = countdownStep + 1
        let threshold = (nextStep <= 3) ? Double(nextStep) * Self.stepMs
                                        : 3 * Self.stepMs + Self.goHoldMs
        if countdownElapsed >= threshold { emitCountdownStep(nextStep) }
    }

    private func emitCountdownStep(_ step: Int) {
        countdownStep = step
        // The digits are display-only now: controllers learn they are counting down
        // from snapshot.roomState and learn the game is live from the COUNTDOWN ->
        // PLAYING transition, so nothing per-second crosses the wire (web parity).
        // Beeps are gated by `!muted` (like startMusic below), matching the web
        // where playCountdownBeep returns early when muted (DisplayAudio.js).
        let quiet = isMuted
        switch step {
        case 0: output?.showCountdown(.number(3)); if !quiet { output?.playCountdownBeep(go: false) }
        case 1: output?.showCountdown(.number(2)); if !quiet { output?.playCountdownBeep(go: false) }
        case 2: output?.showCountdown(.number(1)); if !quiet { output?.playCountdownBeep(go: false) }
        case 3:
            output?.showCountdown(.go)
            if !quiet { output?.playCountdownBeep(go: true); output?.startMusic() }
        default:
            startPlaying()
        }
    }

    /// Map PartyCore's normalized host-effect commands to controller sends and the
    /// match-end transition. Board animations are driven separately from the frame's
    /// `events`. Mirrors the web DisplayGame onEvent/onGameEnd handlers, now
    /// single-sourced through the command vocabulary (see server/PartyCore.d.ts).
    private func dispatchCommands(_ commands: [HostCommand]) {
        for c in commands {
            switch c.type {
            case "playerState":
                guard let pid = c.playerId else { break }
                if c.alive == false {
                    // Record the KO in the room: the snapshot's per-player `alive` is
                    // what a reconnecting eliminated phone reads, and it is what
                    // replaced the retired GAME_OVER send (which PartyCore still
                    // surfaces as a `playerEliminated` command we no longer need).
                    publishAs(roomDo("setAlive", [pid, false]).publish)
                }
                if let lines = c.lines, let alive = c.alive {
                    // Full form (after a line clear): the new line count, plus alive,
                    // which is false when the same frame's clear also topped this
                    // player out.
                    transport.sendTo(pid, OutboundMessage.playerState(lines: lines, alive: alive))
                } else if c.alive == false {
                    // Short form (after a KO): just alive:false. Kept alongside the
                    // snapshot because it is what fires the KO overlay the instant it
                    // happens, rather than on the next retained-state push.
                    transport.sendTo(pid, OutboundMessage.playerDead())
                }
            case "gameEnd":
                endGame(results: c.results ?? [], elapsed: c.elapsed ?? 0)
            default:
                // pieceLock / lineClear / playerKO / playerEliminated /
                // garbageCancelled / garbageSent are rendered from `events` or fully
                // covered by the snapshot.
                break
            }
        }
    }

    private func endGame(results: [PlayerResult], elapsed: Double) {
        // Label the ranking with the roster's names and colours and append the players
        // who sat this round out, flagged newPlayer so every screen renders them
        // rather than omitting them.
        let enriched = roomValue([MatchResult].self, "enrichResults", [results.map(\.payload)]) ?? []
        // Stash the ranking BEFORE the transition: the transition publishes, and the
        // RESULTS snapshot is what carries the ranking to controllers.
        roomDo("setResults", [enriched.map(\.payload)])
        let res = roomDo("transitionTo", ["results"])
        engine = nil
        discardEngineState()
        output?.stopMusic()
        // Clear any pause overlay/menu BEFORE building the results menu — setPaused
        // clears the focus menu, so it must run before showResults sets the
        // results buttons (otherwise the results menu is wiped → no Left/Right).
        setPauseOverlay(false)
        output?.showResults(enriched)
        output?.showScreen(.results)   // reveal the results layer (hide the frozen game)
        publishAs(res.publish)
    }

    private func returnToLobby() {
        guard state != .lobby else { return }
        clearPause()   // the LOBBY transition below publishes, so the lift rides it
        // Remove disconnected players, then fold in the late joiners who were waiting
        // out the round (web returnToLobby).
        roomDo("pruneDisconnected", [nowProvider()])
        roomDo("admitWaiting")
        roomDo("setResults", [NSNull()])
        roomDo("clearAlive")
        // Publishes: controllers see roomState back at LOBBY and route themselves
        // there, which is what the retired RETURN_TO_LOBBY broadcast used to do.
        let res = roomDo("transitionTo", ["lobby"])
        returnToLobbyUI()
        publishAs(res.publish)
    }

    /// The shell half of a lobby return. Split out because the room core can decide the
    /// room is back in the lobby on its own (the last results participant leaving),
    /// in which case `returnToLobby()`'s state guard would skip the UI entirely.
    private func returnToLobbyUI() {
        engine = nil
        discardEngineState()
        output?.stopMusic()
        setPauseOverlay(false)
        rejoinQRs.removeAll()
        roomDo("clearDisconnected", [nowProvider()])
        output?.showScreen(.lobby)
    }

    // MARK: - Pause

    /// Apply the room core's decision to the engine, music and countdown. Called by
    /// the two ops below, never directly: EVERY decision — whether a freeze takes at
    /// all, which reason wins, which trigger may lift which freeze — belongs to
    /// roomCore.pause/resume, which the web display and Android TV run too. Nothing
    /// here re-checks the room state or who is still connected.
    ///
    /// Re-primes the frame clock on freeze so the first frame after a resume starts
    /// with delta 0 instead of a catch-up jump.
    private func applyPauseEffects(_ res: RoomResult, wasPaused: Bool) {
        guard res.changed == true, paused != wasPaused else { return }
        if paused {
            flushInputs() // anything the players got in before the freeze still counts
            engine?.pause()
            engine?.resetFrameClock()
            output?.pauseMusic()
        } else {
            engine?.resume()
            if !isMuted { output?.resumeMusic() }
            rewindCountdownStep()
            // Every thaw takes the overlay down, including one the operator raised by
            // hand during an auto-pause: without this a reconnect resumes the match
            // underneath a stale pause menu. Web's thawGame does the same.
            setPauseOverlay(false)
        }
    }

    private func freezePause(_ reason: PauseReason) -> RoomResult {
        let wasPaused = paused
        let res = roomDo("pause", [reason.rawValue])
        applyPauseEffects(res, wasPaused: wasPaused)
        return res
    }

    /// `nil` is the room-lifecycle clear: it ends the freeze whatever it was.
    private func liftPause(_ reason: PauseReason?) -> RoomResult {
        let wasPaused = paused
        let res = roomDo("resume", [reason?.rawValue ?? NSNull()])
        applyPauseEffects(res, wasPaused: wasPaused)
        return res
    }

    /// Is the pause overlay on screen? Pure VIEW state, deliberately NOT `paused`:
    /// while auto-paused the overlay is the only route to New Game (every controller
    /// is gone, so no one can send RETURN_TO_LOBBY), and the operator can raise it
    /// without the freeze changing. Web's toolbar Pause / Continue pair does the same.
    private var pauseOverlayShown = false

    private func setPauseOverlay(_ shown: Bool) {
        pauseOverlayShown = shown
        output?.setPaused(shown)
    }

    /// The host pressed Pause (their controller or the TV remote). Refused outside a
    /// running game, and while already frozen for a display-internal reason.
    private func pauseGame() {
        let res = freezePause(.manual)
        guard res.changed == true else { return }
        setPauseOverlay(true)
        publishAs(res.publish)
    }

    /// The host pressed Continue. Refused unless the freeze is theirs to lift, and
    /// while every participant is gone (there would be nobody to play). In that second
    /// case the overlay deliberately stays up: it carries New Game, which is what an
    /// operator staring at an emptied room actually wants.
    private func resumeGame() {
        let res = liftPause(.manual)
        guard res.changed == true else { return }
        publishAs(res.publish)
    }

    /// Web checkAllPlayersDisconnected: once every participant is gone, honour a
    /// grace fire that lands between sweeps (a manually-paused host who then
    /// disconnects strands late joiners the same way an unpaused one does), else
    /// silently auto-pause.
    private func checkAllParticipantsDisconnected() {
        // Don't auto-pause during COUNTDOWN — let it finish so rejoin QRs become visible.
        guard state == .playing, allParticipantsDisconnected else { return }
        if roomBool("graceTick", [nowProvider()]) { returnToLobby(); return }
        autoPause()
    }

    /// Every participant dropped. Silent: controllers never see this reason, so the
    /// room core hints 'none' and nothing goes out — there is nobody left to tell.
    /// Refused if the host had already paused by hand (RoomCore rule 2), which is what
    /// keeps their pause and its Continue intact for whoever comes back.
    private func autoPause() {
        let res = freezePause(.auto)
        guard res.changed == true else { return }
        publishAs(res.publish)
    }

    /// A participant came back.
    private func autoResume() {
        let res = liftPause(.auto)
        guard res.changed == true else { return }
        publishAs(res.publish)
    }

    /// Our own relay link dropped: freeze the sim so it can't run blind behind the
    /// reconnect overlay. Publishing is best-effort by definition — the relay is
    /// exactly what we cannot reach. Driven by setRelayConnected.
    private func connectionPause() {
        let res = freezePause(.connection)
        guard res.changed == true else { return }
        publishAs(res.publish)
    }

    /// The relay answered created/joined. Lifts ONLY a link-drop freeze, so a blip
    /// that landed on top of a host's manual pause leaves that pause standing.
    private func connectionResume() {
        let res = liftPause(.connection)
        guard res.changed == true else { return }
        publishAs(res.publish)
    }

    /// Room-lifecycle clear (new match, return to lobby): the pause ends outright,
    /// whatever it was, and the state transition alongside it publishes.
    private func clearPause() {
        _ = liftPause(nil)
    }

    /// Web resume (startCountdown(callback, remaining)): the current number stays on
    /// screen without a re-broadcast/beep and gets its FULL second again; a shown GO
    /// re-arms the full 500ms hold. In the accumulator model that is a rewind to the
    /// current step's start. Android does the same; this platform used to resume
    /// mid-second instead.
    private func rewindCountdownStep() {
        guard state == .countdown, countdownStep >= 0 else { return }
        countdownElapsed = Double(countdownStep) * Self.stepMs
    }

    /// Observe the display's relay link. Only the DROP is actionable here: it freezes
    /// the sim so it can't run blind, and closes the presence gate. The RESTORE
    /// deliberately waits for the relay to answer our handshake — see
    /// roomLinkRestored() — because a socket that is merely open is not yet back in
    /// the room.
    public func setRelayConnected(_ connected: Bool) {
        assertOwningThread()
        guard !connected else { return }
        relayConnected = false
        connectionPause()
    }

    /// The relay answered our handshake: we are back IN the room, so it will route
    /// traffic to and from us again. Two things resume together here, both for the
    /// same reason — socket `.open` is too early:
    ///
    /// - The presence sweep. Until this reply the relay drops everything addressed to
    ///   us, so no controller can prove it is alive; re-stamping at `.open` instead
    ///   buys only `livenessTimeoutMs` while the handshake deadline is twice that, so
    ///   a slow `joined` expired the whole roster.
    /// - The link-drop pause. Resuming at `.open` publishes a resumed snapshot into a
    ///   socket the relay has not yet re-admitted to the room, so it can be dropped
    ///   server-side and controllers stay stuck behind their overlay.
    ///
    /// Web ties both to the same reply (onDisplayRejoined), as does the Android port
    /// (handleJoined). Callers re-stamp presence first where there is a roster to
    /// re-stamp: onJoined's reconcile does it per surviving peer, onCreated's room is
    /// empty. `connectionResume` no-ops unless a link drop actually paused us, so the
    /// first `created` of a session is unaffected.
    private func roomLinkRestored() {
        relayConnected = true
        connectionResume()
    }

    // MARK: - Presence / liveness

    /// Push the batched "heard from" set across and read back the room core's liveness
    /// decisions. One bridge crossing per frame however many packets landed.
    private func drainSeen(_ now: Double) -> RoomTick {
        let seen = Array(seenSinceTick)
        seenSinceTick.removeAll(keepingCapacity: true)
        return roomValue(RoomTick.self, "tick", [now, seen]) ?? RoomTick(expired: [], graceFired: false)
    }

    /// Once-per-frame presence sweep. Flags silently-dead controllers, returns to the
    /// lobby after the late-joiner grace, and silently auto-pauses / auto-resumes on
    /// the all-disconnected boundary. Mirrors the web DisplayLiveness loop +
    /// checkAllPlayersDisconnected.
    private func pollPresence(_ now: Double, _ roomState: RoomState) {
        // Skip the controller-liveness sweep while the display's OWN link is down:
        // no controller traffic can arrive, so every lastSeen is stale through no
        // fault of the controllers (web DisplayLiveness `displayDead` early-return).
        // Without this, a recoverable display outage would expire every controller
        // and (with a late joiner) grace-return the match to the lobby. The stamps
        // still drain, so nothing piles up while we are out of the room.
        guard relayConnected else { _ = drainSeen(now); return }
        let sweep = drainSeen(now)
        for id in sweep.expired {
            roomDo("markDisconnected", [id])
            // Track the flag in every state (host election reads it), but the
            // per-board rejoin QR only applies while boards are on screen.
            rejoinQRs.insert(id)
            if roomState == .countdown || roomState == .playing {
                output?.setDisconnected(playerId: id, joinURL: rejoinURL(id))
            }
        }
        // A silent expiry can take out the host, and every host-gated control — the
        // controllers' menus and the display's own host-tinted chrome — reads the host
        // from the snapshot, so republish as soon as the sweep flags anyone.
        if !sweep.expired.isEmpty { publishAs(Self.publishNow) }

        switch roomState {
        case .playing:
            if sweep.graceFired { returnToLobby(); return }
            if allParticipantsDisconnected { checkAllParticipantsDisconnected() }
            // No autoResume here, deliberately: allParticipantsDisconnected only turns
            // false again when a controller is HEARD from, and that path already calls
            // autoResume (onMessage / the reconnect claim). Polling for it cost a bridge
            // crossing every frame to catch a case that cannot arrive this way — and web
            // and Android never had it, so this is also what makes the sweep identical.
        case .results:
            // No connected controller left on the results screen → back to the
            // lobby (mirrors the web RESULTS peer-left path; controllers ping at
            // 1 Hz, so an idle-but-connected controller is never expired here).
            if !hasConnectedParticipant() { returnToLobby() }
        case .lobby, .countdown:
            break
        }
    }

    // MARK: - Rejoin QR overlays

    /// Raise a dropped participant's rejoin QR. INVARIANT (see `rejoinQRs`): the
    /// overlay set and the room core's presence set move together, so this is also the
    /// single place a mid-game disconnect is recorded.
    private func raiseRejoinQR(_ peerIndex: Int) {
        rejoinQRs.insert(peerIndex)
        roomDo("markDisconnected", [peerIndex])
        output?.setDisconnected(playerId: peerIndex, joinURL: rejoinURL(peerIndex))
    }

    private func clearRejoinQR(_ peerIndex: Int) {
        rejoinQRs.remove(peerIndex)
        output?.setDisconnected(playerId: peerIndex, joinURL: nil)
    }

    // MARK: - Apple TV remote (display-side controls)

    /// Start a match from the lobby (or play again from results).
    public func remoteStartMatch() {
        assertOwningThread()
        let s = state
        if (s == .lobby || s == .results) && playerCount >= 1 { beginCountdown() }
    }

    /// Return to the lobby (the "New Game" action on results / pause).
    public func remoteReturnToLobby() {
        assertOwningThread()
        if state != .lobby { returnToLobby() }
    }

    /// Pause/resume during a game or the 3-2-1 countdown (the web allows both). No state
    /// guard: the room core refuses a freeze outside a running game, and the `.auto`
    /// branch is reachable only while one is already in force, which implies running.
    public func remoteTogglePause() {
        assertOwningThread()
        switch pauseReason {
        case .manual: resumeGame()
        // Nothing left to pause — but the overlay carries New Game, and with every
        // controller gone it is the only way out of a frozen match. Toggling the VIEW
        // leaves the freeze alone; a returning player still auto-resumes. The web
        // display's toolbar Pause (raise) / Continue (dismiss) pair is the same thing
        // split across two buttons.
        case .auto: setPauseOverlay(!pauseOverlayShown)
        // .connection: the reconnect overlay owns the screen; .none: a fresh pause.
        default: pauseGame()
        }
    }

    /// The Play/Pause button: context toggle — start in the lobby, play again on
    /// results, pause/resume (Continue) during a game or countdown.
    public func remotePlayPause() {
        switch state {
        case .lobby, .results: remoteStartMatch()
        case .countdown, .playing: remoteTogglePause()
        }
    }

    /// The tvOS app is backgrounding. Deliberately NOT the web's pagehide
    /// close_room teardown: a page that hides is gone for good, but a
    /// backgrounded app can come straight back (Home and back), so the party
    /// survives. Controllers learn of the absence via the relay's peer_left
    /// (RelayClient.suspend), keep their seats, and bail on their own if the
    /// display stays gone. Tear down P2P channels; on foregrounding the
    /// controllers re-offer.
    public func displayDidEnterBackground() {
        fastlane?.closeAll()
    }

    /// Toggle the display's own music mute. Returns the new muted state so the
    /// UI can show a brief indicator.
    @discardableResult
    public func remoteToggleMute() -> Bool {
        assertOwningThread()
        let next = !isMuted
        setDisplayMuted(next)
        return next
    }

    // MARK: - Retained room snapshot

    /// The publish-hint vocabulary every room-core mutator returns (RoomCore.PUBLISH),
    /// pinned to the module by tests/protocol-swift-parity.test.js. The STRENGTH
    /// ordering is not mirrored here — it is read out of the room core itself, see
    /// `publishRank`.
    static let publishNone = "none"
    static let publishSoon = "soon"
    static let publishNow = "now"

    /// Apply a mutator's publish hint. Keeps the three-way decision in one place so
    /// call sites read as "do the thing, then honour the hint".
    ///
    /// The display's OWN lobby repaints on both publishing hints, immediately: it is
    /// a local value copy rather than a relay message, and the web repaints on
    /// exactly these edges too (updatePlayerList sits beside every publishAs call
    /// site there).
    private func publishAs(_ hint: String?) {
        if let batch = batchHint {
            // Inside a batch: fold instead of publishing. Strongest wins.
            if hintRank(hint) > hintRank(batch) { batchHint = hint ?? Self.publishNone }
            return
        }
        guard hint == Self.publishNow || hint == Self.publishSoon else { return }
        refreshDisplayLobby()
        if hint == Self.publishNow { publishRoomSnapshot() } else { publishRoomSnapshotSoon() }
    }

    /// RoomCore.publishRank, read out of the module at roomInit. The fallback
    /// only covers the window before the room core is up, when nothing publishes
    /// anyway. An unknown hint ranks 0, so it can never strengthen a batch.
    private var publishRank: [String: Int] = [publishNone: 0, publishSoon: 1, publishNow: 2]
    private func hintRank(_ hint: String?) -> Int {
        guard let hint else { return 0 }
        return publishRank[hint] ?? 0
    }

    /// Run a group of room changes as ONE change: everything inside publishes once,
    /// when the block returns. Without it a rejoin dropping four peers, or an engine
    /// frame that KOs three players at once, publishes the whole room once per
    /// mutation — and every one but the last describes a half-finished state no
    /// controller should ever render.
    ///
    /// Local rather than a RoomCore method because the block is a closure and the
    /// bridge is JSON-only: a room-core version would need begin/end as two extra
    /// bridge calls per batch, around a frame drain that runs every tick. The hints
    /// stay the room core's decision; only the folding is here, and publishAs is
    /// already the single point every publish goes through.
    ///
    /// `floor` is the weakest hint the group may end on: omit it and a group that
    /// changed nothing stays silent (what makes wrapping the frame drain free), pass
    /// "now" when the publish has to happen regardless. `defer` closes the fold, so a
    /// throw mid-block still ships what did change. Web and Android carry this verbatim.
    private func publishBatch(floor: String = DisplayCoordinator.publishNone, _ body: () -> Void) {
        batchHint = floor
        defer {
            let hint = batchHint
            batchHint = nil
            publishAs(hint)
        }
        body()
    }

    /// Publish now, superseding any pending throttled publish. This is the ONLY thing
    /// the display tells controllers about the room: the relay pushes the snapshot
    /// live to everyone connected AND replays it to a (re)joining peer right after
    /// `joined`, so the live-update path and the resync-after-a-blip path are the
    /// same code and cannot disagree with each other.
    private func publishRoomSnapshot() {
        snapshotPending = false
        lastSnapshotAt = nowProvider()
        guard let bridge = roomCore(),
              let json = try? bridge.roomSnapshotJSON(),
              let data = json.data(using: .utf8),
              let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        // Built by RoomCore, byte-identically on the web and Android TV, which is
        // the whole point of the module.
        transport.setState(dict)
    }

    /// Throttled, leading + trailing: a call after a quiet period publishes
    /// immediately; calls inside the window collapse into one trailing publish that
    /// reads live state at fire time (the frame loop drives the trailing edge).
    private func publishRoomSnapshotSoon() {
        guard !snapshotPending else { return }
        if nowProvider() - lastSnapshotAt >= snapshotThrottleMs { publishRoomSnapshot() }
        else { snapshotPending = true }
    }

    /// Fire a pending trailing snapshot once the throttle window has elapsed.
    private func flushPendingSnapshot() {
        guard snapshotPending, nowProvider() - lastSnapshotAt >= snapshotThrottleMs else { return }
        publishRoomSnapshot()
    }

    /// Rebuild the display's own lobby UI from the current roster. Reads the full
    /// records (not the wire snapshot): the lobby cards sort by `joinedAt`, which the
    /// snapshot deliberately doesn't carry.
    private func refreshDisplayLobby() {
        output?.updateLobby(players: roster(), hostPeerIndex: hostPeerIndex)
    }

    // MARK: - Helpers

    private func joinURL(room: String, instance: String?) -> String {
        var url = "\(Protocol.controllerBaseURL)/\(room)"
        if let instance, !instance.isEmpty { url += "#\(instance)" }
        return url
    }

    /// Cross-device rejoin URL for a dropped participant (carries ?claim=<idx>).
    private func rejoinURL(_ peerIndex: Int) -> String {
        guard let room else { return "" }
        var url = "\(Protocol.controllerBaseURL)/\(room)?claim=\(peerIndex)"
        if let instance, !instance.isEmpty { url += "#\(instance)" }
        return url
    }
}
