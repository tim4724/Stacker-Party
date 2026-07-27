import Foundation

public enum DisplayScreen: Equatable { case lobby, game, results }
public enum CountdownValue: Equatable { case number(Int), go }

/// One display-ready results row: the engine's raw `PlayerResult` joined with the
/// roster's name/color, or a late joiner who sat the match out (rank/lines/level
/// nil, `newPlayer` true). Typed end-to-end inside the kit; `payload` is the wire
/// form (game_end broadcast, WELCOME replay), omitting nil fields like the web.
public struct MatchResult: Equatable {
    public var playerId: Int        // var: remapped onto the new index by a ?claim= rejoin
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

/// The native display brain: owns the relay transport, the RoomFlow roster, and
/// the engine; implements the display-side protocol handling and game lifecycle
/// (lobby -> countdown -> playing -> results). Ported from DisplayGame.js /
/// DisplayInput.js / DisplayConnection.js. Single-threaded: call from the main
/// thread; `tick(deltaMs:)` is driven once per frame by the renderer.
public final class DisplayCoordinator {

    public let flow = RoomFlow()
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

    var engine: EngineBridge?
    // The reusable JS runtime behind `engine`. Evaluating the bundle in a fresh
    // JSContext is the expensive part of a match start (in-process JSC has no JIT),
    // while Bridge.create re-inits a game on an existing runtime for free — so the
    // runtime is built ONCE (prewarmed off-main when the first controller says
    // hello, or synchronously at the first START) and reused for every match.
    // `engine` stays the match-scoped handle the state machine gates on.
    private var runtime: EngineBridge?
    private var runtimePrewarmInFlight = false
    private var room: String?
    private var instance: String?

    // Pause is a union of independent reasons so they don't clobber each other
    // (a host Continue must not un-pause an all-disconnected freeze, etc.). The
    // engine/music follow the effective `paused` via reconcilePause.
    private var pausedManual = false        // host / remote pressed Pause
    private var pausedAuto = false          // every participant disconnected (silent)
    private var pausedConnection = false    // the display's OWN relay link is down
    private var paused: Bool { pausedManual || pausedAuto || pausedConnection }
    /// The only pause a controller can act on. The auto- (everyone disconnected)
    /// and connection (our own link down) pauses are display-internal: never
    /// broadcast, self-clearing, and a controller shown either gets a Continue
    /// that cannot work — resumeGame() ignores it because the display isn't
    /// manually paused, so no GAME_RESUMED follows and the overlay never clears.
    private var userVisiblePaused: Bool { pausedManual }
    // True while we are IN the room, not merely holding an open socket. While it's
    // false, controller traffic can't arrive, so the controller-liveness sweep must be
    // skipped (every lastSeen is stale through no fault of the controllers). Cleared
    // the moment the link drops (setRelayConnected), restored only by the relay's
    // `created`/`joined` reply — see roomLinkRestored().
    private var relayConnected = true

    // Monotonic clock fed to PartyCore.frame(); only deltas matter, so it never
    // needs resetting across games (a fresh engine re-primes on its first frame).
    private var frameClockMs = 0.0
    var playerOrder: [Int] = []
    // Per-participant KO state, so a WELCOME sent to a reconnecting (or
    // display-blip re-welcomed) controller reports alive:false for a player who
    // was already KO'd — without this the eliminated phone flips back to the live
    // playing UI (mirrors the web's lastAliveState). Only ever records false; a
    // player defaults alive until KO'd.
    private var aliveState: [Int: Bool] = [:]
    // The enriched results of the just-finished match, replayed in the WELCOME to
    // a controller that joins/reconnects on the RESULTS screen so its phone shows
    // the ranking instead of a blank results view (mirrors the web's lastResults).
    private var lastResults: [MatchResult]?
    private var pendingSeed: UInt32 = 0
    var demoSeedOverride: UInt32?   // deterministic seed for HEXDEMO
    private var muted = false
    private let nowProvider: () -> Double    // wall-clock ms for liveness (injectable for tests)

    // Retained-snapshot throttle (web _lastLobbyBroadcastAt / _lobbyBroadcastTimer).
    private var lastSnapshotAt = -1e12
    private var snapshotPending = false
    /// Coalesce bursty republishes (join storms, colour picks, host churn) into at
    /// most one leading + one trailing set_state per window. Web's value.
    private static let lobbyBroadcastMinIntervalMs = 400.0

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
    /// A JavaScriptCore bridge used only to read the static GalleryFixtures data
    /// (built lazily, reused across a shot). nil if the core bundle fails to load.
    var galleryBridge: EngineBridge?

    // Render-on-input coalescing: true once handleInput has pulled a snapshot
    // since the last tick(), so message bursts cost at most one pull per frame.
    private var renderedInputSinceTick = false

    // Countdown driven by accumulated frame time (deterministic, testable).
    private var countdownElapsed = 0.0
    private var countdownStep = -1   // last emitted step: 0->3,1->2,2->1,3->GO,4->start
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

    public var state: RoomState { flow.state }
    public var isMuted: Bool { muted }

    // MARK: - Lifecycle

    public func start() {
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
        flow.onRosterChange = { [weak self] players in
            self?.output?.updateLobby(players: players, hostPeerIndex: self?.flow.host)
        }
        // A silent disconnect mid-game can reshuffle the effective host; the new
        // host's controller must learn it gained the menu controls. LOBBY/RESULTS
        // already rebroadcast on roster changes, so only cover the in-game states.
        flow.onHostChange = { [weak self] _ in
            guard let self else { return }
            if self.flow.state == .countdown || self.flow.state == .playing {
                self.maybeBroadcastHostChange()
            }
        }
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
        // Display relay-reconnect: reconcile present controllers and re-welcome
        // everyone. Re-stamp + un-flag the still-present peers (mirrors the web's
        // onDisplayRejoined) so they don't instantly expire on the next liveness
        // sweep, and clear any rejoin overlay that was raised during the blip.
        self.room = room
        let now = nowProvider()
        // We re-push WELCOME to everyone below, so a later host change must
        // broadcast regardless of the pre-disconnect sentinel (web parity).
        lastBroadcastedHostId = nil
        // Re-stamp the still-present peers and clear any rejoin overlay; collect the
        // ones the relay no longer lists, then route each through the SAME
        // state-aware onPeerLeft the web delegates to (lobby → remove the slot;
        // countdown/playing → keep the slot AND raise the per-board rejoin QR;
        // results → trim the order + maybe return to the lobby). Marking them
        // disconnected inline instead would strand the board with no rejoin QR and,
        // because expiredPeers skips already-disconnected peers, never self-heal.
        // Re-confirm the lobby QR: the link was down (QR untrusted, rendered dimmed)
        // and this `joined` proves the room survived, so the same code + QR are valid
        // again. The room-gone path re-confirms via onCreated instead.
        let url = joinURL(room: room, instance: instance)
        output?.roomReady(room: room, joinURL: url, qrText: url)
        var goneIds: [Int] = []
        for p in flow.list() {
            if peers.contains(p.peerIndex) {
                flow.onSeen(p.peerIndex, now)
                if flow.isDisconnected(p.peerIndex) {
                    flow.markReconnected(p.peerIndex)
                    output?.setDisconnected(playerId: p.peerIndex, joinURL: nil)
                }
            } else {
                goneIds.append(p.peerIndex)
            }
        }
        for id in goneIds { onPeerLeft(id) }
        // BEFORE the WELCOMEs, not after: the roster is reconciled (so the
        // all-disconnected guard sees post-reconcile truth) but sendWelcome reports
        // `paused`, and that field is the controller's authority. Resuming afterwards
        // makes every rejoin WELCOME say paused=true and then chase it with a
        // GAME_RESUMED — and if a controller latches the first and misses the second
        // it is stranded on a pause overlay whose Continue cannot help, because
        // resumeGame() is gated on `pausedManual` and the display is no longer paused
        // at all. Web onDisplayRejoined resumes before its WELCOME loop for the same
        // reason. The GAME_RESUMED that connectionResume broadcasts is then merely
        // redundant, which is the harmless direction.
        roomLinkRestored()
        for p in flow.list() { sendWelcome(to: p.peerIndex, isLateJoiner: isLateJoiner(p.peerIndex)) }
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
        output?.stopMusic()
        output?.setPaused(false)
        pausedManual = false; pausedAuto = false; pausedConnection = false
        aliveState = [:]
        lastResults = nil
        playerOrder = []
        lastBroadcastedHostId = nil
        flow.reset()                 // clear the roster + return to the lobby state
        output?.showScreen(.lobby)   // drop the frozen game immediately
        transport.recreateRoom()     // fresh room; onCreated re-shows the lobby with the new code
    }

    private func onPeerJoined(_ index: Int) {
        assertOwningThread()
        // An in-session reconnect lands on the SAME slot, so the relay re-emits
        // peer_joined for a peer we already know. Defer to the controller's HELLO
        // (onMessage clears its disconnect + restores the QR) rather than calling
        // addPlayer again, which would overwrite the kept color/level and strand
        // the rejoin overlay (mirrors the web's `if (players.has(i)) return`).
        guard !flow.contains(index) else { return }
        let slot = flow.lowestFreeSlot()
        guard slot >= 0 else {
            transport.sendTo(index, OutboundMessage.error(message: "Room is full"))
            return
        }
        flow.addPlayer(peerIndex: index, playerName: autoName(slot: slot), colorSlot: slot)
        if flow.state == .lobby { broadcastLobby() }
    }

    private func onPeerLeft(_ index: Int) {
        assertOwningThread()
        // Drop any peer-to-peer channel to the departed controller; a reconnecting
        // controller re-offers and a fresh fastlane peer is built (web parity).
        fastlane?.closePeer(index)
        switch flow.state {
        case .lobby:
            flow.removePlayer(index)
            // Unconditional now that this is one retained set_state rather than a
            // per-player fanout: when the LAST lobby player leaves there is nobody to
            // fan out to, but the retained snapshot must stop naming a departed player
            // (and a stale host) to the next (re)joiner. Web removeLobbyPlayer's
            // else-branch publishes the empty roster for the same reason.
            broadcastLobby()
        case .results:
            // Drop the leaver and return to the lobby once no connected participant
            // remains (late joiners don't count), mirroring the web RESULTS path.
            flow.removePlayer(index)
            playerOrder.removeAll { $0 == index }
            flow.setActiveOrder(playerOrder)
            if hasConnectedParticipant() {
                if flow.size > 0 { broadcastLobby() }
            } else {
                returnToLobby()
            }
        case .countdown, .playing:
            // End any in-progress soft drop so the departed board doesn't keep
            // falling fast until the engine's own deadline fires (web cleanupPlayerInput).
            engine?.softDropEnd(playerId: index)
            if playerOrder.contains(index) {
                flow.markDisconnected(index)   // keep slot
                output?.setDisconnected(playerId: index, joinURL: rejoinURL(index))
            } else {
                flow.removePlayer(index)
            }
        }
    }

    /// A peer that is part of the current round (the active order). Used to gate
    /// the welcome's alive/paused payload and the RESULTS return-to-lobby.
    private func isLateJoiner(_ id: Int) -> Bool {
        (flow.state == .playing || flow.state == .countdown) && !playerOrder.contains(id)
    }

    /// Any active participant still present and connected.
    private func hasConnectedParticipant() -> Bool {
        playerOrder.contains { flow.contains($0) && !flow.isDisconnected($0) }
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
        flow.onSeen(from, nowProvider())
        if flow.isDisconnected(from) {
            flow.markReconnected(from)
            output?.setDisconnected(playerId: from, joinURL: nil)   // clear rejoin overlay
            if pausedAuto { autoResume() }                          // a participant returned
        }

        switch msg.type {
        case MSG.hello: handleHello(from: from, msg: msg)
        case MSG.input: handleInput(from: from, msg: msg)
        case MSG.softDrop:
            // Guard the Double->Int conversion: a malformed `speed` (e.g. 1e308)
            // would trap in Int.init and abort the display; ignore it instead.
            if flow.state == .playing, !paused {
                engine?.softDropStart(playerId: from, speed: msg.speed.flatMap { $0.isFinite && abs($0) < 9.0e15 ? Int($0) : nil })
            }
        case MSG.softDropEnd:
            if flow.state == .playing { engine?.softDropEnd(playerId: from) }
        case MSG.startGame:
            if flow.state == .lobby, flow.size >= 1 { beginCountdown() }
        case MSG.playAgain:
            if flow.state == .results, flow.size >= 1 { beginCountdown() }
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
    }

    private func handleHello(from: Int, msg: ControllerMessage) {
        // Cross-device mid-game rejoin: a returning participant arrives under a NEW
        // peer index carrying ?claim=<oldIdx> (sent as rejoinToken/rejoinId). Re-key
        // the kept record + engine state onto the new index instead of seating them
        // as a fresh late joiner. Mirrors the web's claimReconnectPeer.
        if claimReconnect(from: from, msg: msg) { return }

        if flow.player(from) == nil {
            let slot = flow.lowestFreeSlot()
            guard slot >= 0 else {
                transport.sendTo(from, OutboundMessage.error(message: "Room is full"))
                return
            }
            let name = sanitizeName(msg.name) ?? autoName(slot: slot)
            flow.addPlayer(peerIndex: from, playerName: name, colorSlot: slot)
            flow.onSeen(from, nowProvider())
        } else if let name = sanitizeName(msg.name), msg.autoName != true {
            flow.player(from)?.playerName = name
        }
        sendWelcome(to: from, isLateJoiner: isLateJoiner(from))
        if flow.state == .lobby || flow.state == .results { broadcastLobby() }
        // Someone is in the lobby, so a START may follow: get the runtime ready.
        if flow.state == .lobby { prewarmRuntime() }
    }

    /// Honor a `?claim=<oldIdx>` rejoin: move the dropped participant's slot, board
    /// and garbage state from `oldId` to the returning peer `from`. Returns true if
    /// the claim was applied (caller is done). Only valid for a disconnected
    /// participant of the current round.
    private func claimReconnect(from: Int, msg: ControllerMessage) -> Bool {
        // `!playerOrder.contains(from)`: an active participant can't claim
        // another board — rekeying onto an id that already owns a board would
        // silently drop one of the two in the engine's Map rebuild (a forged
        // rejoinToken in a re-sent HELLO could otherwise corrupt the match).
        // A genuine cross-device rejoin always arrives under a FRESH index.
        guard let oldId = msg.rejoinToken ?? msg.rejoinId, oldId != from,
              flow.isDisconnected(oldId), playerOrder.contains(oldId),
              !playerOrder.contains(from) else { return false }
        // Engine-first: re-key the engine board (input + snapshot map to the kept
        // board) BEFORE moving the roster, so a failed engine rekey can't leave the
        // roster pointing at a board the engine never moved. engine is non-nil here
        // (built in beginCountdown); guard defensively, and with no engine there is
        // no board to desync from a roster-only move.
        if let engine, !engine.rekeyPlayer(oldId: oldId, newId: from) { return false }
        guard flow.rekey(oldId: oldId, newId: from) else { return false }
        playerOrder = playerOrder.map { $0 == oldId ? from : $0 }
        flow.setActiveOrder(playerOrder)
        flow.onSeen(from, nowProvider())
        // Carry the KO state onto the new peer index so a claim-rejoin after a KO
        // still reports alive:false in its welcome (web parity).
        if let wasAlive = aliveState.removeValue(forKey: oldId) { aliveState[from] = wasAlive }
        // Remap the cached ranking too: a claim on the RESULTS screen (player
        // dropped mid-game, match ended before they returned) replays
        // lastResults in the WELCOME, and the controller matches its own row
        // by playerId (web parity: claimReconnectPeer does the same).
        lastResults = lastResults?.map { entry in
            var e = entry
            if e.playerId == oldId { e.playerId = from }
            return e
        }
        output?.setDisconnected(playerId: oldId, joinURL: nil)   // clear the dropped board's rejoin QR
        if pausedAuto { autoResume() }                          // a participant returned
        sendWelcome(to: from, isLateJoiner: false)
        if flow.state == .lobby || flow.state == .results { broadcastLobby() }
        return true
    }

    private func handleInput(from: Int, msg: ControllerMessage) {
        guard flow.state == .playing, !paused, let action = msg.action,
              InputAction(rawValue: action) != nil else { return }
        engine?.processInput(playerId: from, action: action)
        // Render-on-input: reflect the applied input on the very next display frame
        // instead of waiting for the next tick(). snapshot() is a pure read (value-copy,
        // no time advance), so it only front-runs the VISUAL; this frame's events/commands
        // (lock flash, garbage, sends) still flow on the next tick(). Mirrors the Android path.
        // Coalesced to one pull per frame: each snapshot() is a full serialize + decode,
        // and an 8-player input burst can land several messages inside one 16 ms window.
        // Later inputs still show on the tick's own snapshot, at most one frame later.
        guard !renderedInputSinceTick, let engine, let snap = try? engine.snapshot() else { return }
        renderedInputSinceTick = true
        output?.renderSnapshot(snap)
    }

    private func handleSetLevel(from: Int, msg: ControllerMessage) {
        guard let level = msg.level, (1...15).contains(level), let rec = flow.player(from) else { return }
        rec.startLevel = level
        // startLevel rides the retained roster snapshot like every other roster field,
        // which is what let LOBBY_UPDATE go entirely. Cheaper than the targeted echo it
        // replaces, too: the snapshot's 400ms leading+trailing throttle collapses a
        // burst of +/- taps into ~2.5 publishes/sec however fast they come.
        if flow.state == .lobby { broadcastLobby() }
    }

    private func handleSetColor(from: Int, msg: ControllerMessage) {
        guard let slot = msg.colorIndex, (0..<EngineConstants.maxPlayers).contains(slot),
              let rec = flow.player(from) else { return }
        // Reject if taken by another player.
        if flow.list().contains(where: { $0.peerIndex != from && $0.colorSlot == slot }) { return }
        rec.colorSlot = slot
        broadcastLobby()
    }

    private func handleSetName(from: Int, msg: ControllerMessage) {
        guard let name = sanitizeName(msg.name), let rec = flow.player(from) else { return }
        rec.playerName = name
        if from == flow.host { broadcastLobby() }
        else if flow.state == .lobby || flow.state == .results { refreshDisplayLobby() }
    }

    private func handleSetMute(from: Int, msg: ControllerMessage) {
        guard from == flow.host else { return }
        muted = (msg.muted == true)
        transport.broadcast(OutboundMessage.displayMuted(muted))
        // Apply to live audio immediately (mirrors remoteToggleMute); without this
        // the flag only took effect at the next match start.
        if muted { output?.pauseMusic() }
        else if flow.state == .playing && !paused { output?.resumeMusic() }
        output?.setDisplayMuted(muted)   // keep a visible pause-menu switch live
    }

    // MARK: - Countdown + game

    func beginCountdown() {
        guard flow.transition(to: .countdown) else { return }
        pruneDisconnected()
        // Late joiners enter the participant order, sorted by join time so the
        // leftmost board is the first joiner.
        for id in flow.list().map({ $0.peerIndex }) where !playerOrder.contains(id) { playerOrder.append(id) }
        playerOrder = playerOrder.filter { flow.contains($0) }
        playerOrder.sort { (flow.player($0)?.joinedAt ?? .max) < (flow.player($1)?.joinedAt ?? .max) }
        // Pruning may have emptied the round (e.g. a Play-Again that races the
        // presence sweep with every participant already gone). Don't launch a
        // zero-player engine — bounce back to the lobby (web parity).
        guard !playerOrder.isEmpty else { returnToLobby(); return }
        flow.setActiveOrder(playerOrder)
        // Stamp everyone present so a controller that went briefly quiet in the
        // lobby isn't instantly expired once the COUNTDOWN liveness gate applies.
        flow.primeLiveness(nowProvider())
        pendingSeed = demoSeedOverride ?? seedProvider()
        pausedManual = false; pausedAuto = false; pausedConnection = false
        aliveState = [:]      // fresh match: everyone alive, last ranking is stale
        lastResults = nil
        countdownElapsed = 0

        // Build the engine now and show the game screen so the boards are visible
        // behind the countdown overlay, matching the web's 3-2-1-GO over the game
        // board. Render the PRE-GAME projection (empty wells: no spawn piece,
        // ghost, hold, or next queue) — the web hides those until play begins.
        guard makeEngine() else { returnToLobby(); return }
        output?.showScreen(.game)
        if let engine, let snap = try? engine.snapshot() { output?.renderSnapshot(snap.preGame()) }
        // First countdown value in the SAME call as the screen change, so the
        // output can present boards + scrim as one unit (no bare-board frames
        // while waiting for the first tick).
        emitCountdownStep(0)
    }

    private func makeEngine() -> Bool {
        let players: [(id: Int, startLevel: Int)] = playerOrder.map {
            (id: $0, startLevel: flow.player($0)?.startLevel ?? 1)
        }
        do {
            let e = try runtime ?? EngineBridge(engineDirectory: engineDirectory)
            // Surface fire-and-forget engine exceptions instead of dropping them.
            e.onEngineError = { message in
                FileHandle.standardError.write(Data("[engine] \(message)\n".utf8))
            }
            try e.createGame(players: players, seed: pendingSeed)
            runtime = e
            engine = e
            return true
        } catch {
            runtime = nil // don't reuse a runtime that failed mid-create
            FileHandle.standardError.write(Data("[engine] createGame failed: \(error)\n".utf8))
            return false
        }
    }

    /// Build the JS runtime ahead of the first match, off the main thread, so the
    /// START press doesn't pay the bundle evaluation. Triggered when a controller
    /// joins the lobby — always seconds before any START. JSC serializes context
    /// access via the virtual machine's lock, so constructing on a background
    /// queue and using on main afterwards is safe. If a START wins the race,
    /// makeEngine builds its own runtime and the late prewarm result is discarded.
    private func prewarmRuntime() {
        guard runtime == nil, !runtimePrewarmInFlight else { return }
        runtimePrewarmInFlight = true
        let dir = engineDirectory
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let e = try? EngineBridge(engineDirectory: dir)
            DispatchQueue.main.async {
                guard let self else { return }
                self.runtimePrewarmInFlight = false
                if self.runtime == nil { self.runtime = e }
            }
        }
    }

    private func startPlaying() {
        // The engine and game screen are already set up in beginCountdown; go
        // live so tick() starts advancing the simulation.
        flow.transition(to: .playing)
        transport.broadcast(OutboundMessage.gameStart())
    }

    /// Drive one frame. The renderer calls this every display tick with the real
    /// elapsed milliseconds.
    public func tick(deltaMs rawDelta: Double) {
        assertOwningThread()
        renderedInputSinceTick = false   // new frame: re-arm render-on-input
        flushPendingSnapshot()           // trailing edge of the set_state throttle
        let deltaMs = min(max(rawDelta, 0), Self.maxFrameDeltaMs)
        // The local demo has no controllers sending heartbeats, so keep its
        // synthetic players "seen" — otherwise the liveness sweep flags them
        // disconnected after 3 s and auto-pauses the self-playing game, and
        // on RESULTS the presence sweep would auto-return a finished demo
        // match to the lobby (which cuts the HEXTOUR results dwell short).
        if demoActive, flow.state != .lobby {
            flow.primeLiveness(nowProvider())
        }
        switch flow.state {
        case .countdown:
            pollPresence(nowProvider())
            guard flow.state == .countdown else { return }
            advanceCountdown(deltaMs: deltaMs)
        case .playing:
            pollPresence(nowProvider())
            // pollPresence can return to lobby (grace) — re-check before ticking.
            guard flow.state == .playing, !paused, let engine else { return }
            if demoActive { driveDemoInput() }
            // Pull one engine frame through PartyCore (the native integration
            // surface): it ticks, drains events, value-copies the snapshot and
            // normalizes host effects in a single call. `frameClockMs` is the
            // monotonic clock PartyCore turns into a capped per-frame delta.
            frameClockMs += deltaMs
            let frame: FrameResult
            do { frame = try engine.frame(nowMs: frameClockMs) }
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
            output?.renderSnapshot(frame.snapshot)
            // Commands normalize the host effects (controller sends, match end),
            // single-sourced from PartyCore so they can't drift from the web.
            dispatchCommands(frame.commands)
        case .results:
            // Run presence so the results screen returns to the lobby once every
            // controller has dropped (web RESULTS auto-return).
            pollPresence(nowProvider())
        case .lobby:
            break
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
        switch step {
        // Beeps are gated by `!muted` (like startMusic below), matching the web
        // where playCountdownBeep returns early when muted (DisplayAudio.js).
        case 0: transport.broadcast(OutboundMessage.countdown(value: 3)); output?.showCountdown(.number(3)); if !muted { output?.playCountdownBeep(go: false) }
        case 1: transport.broadcast(OutboundMessage.countdown(value: 2)); output?.showCountdown(.number(2)); if !muted { output?.playCountdownBeep(go: false) }
        case 2: transport.broadcast(OutboundMessage.countdown(value: 1)); output?.showCountdown(.number(1)); if !muted { output?.playCountdownBeep(go: false) }
        case 3:
            transport.broadcast(OutboundMessage.countdown(value: "GO"))
            output?.showCountdown(.go)
            if !muted { output?.playCountdownBeep(go: true); output?.startMusic() }
        default:
            startPlaying()
        }
    }

    /// Map PartyCore's normalized host-effect commands to controller sends and
    /// the match-end transition. Board animations are driven separately from the
    /// frame's `events`. Mirrors the
    /// web DisplayGame onEvent/onGameEnd handlers, now single-sourced through the
    /// command vocabulary (see server/PartyCore.d.ts).
    private func dispatchCommands(_ commands: [HostCommand]) {
        for c in commands {
            switch c.type {
            case "playerState":
                guard let pid = c.playerId else { break }
                if c.alive == false { aliveState[pid] = false }   // remember the KO for reconnect resync
                if let level = c.level, let lines = c.lines, let alive = c.alive {
                    // Full form (after a line clear): level/lines/alive + pre-resolved
                    // incoming garbage.
                    transport.sendTo(pid, OutboundMessage.playerState(
                        level: level, lines: lines, alive: alive,
                        garbageIncoming: c.garbageIncoming ?? 0))
                } else if c.alive == false {
                    // Short form (after a KO): just alive:false.
                    transport.sendTo(pid, OutboundMessage.playerDead())
                }
            case "playerEliminated":
                if let pid = c.playerId {
                    aliveState[pid] = false
                    transport.sendTo(pid, OutboundMessage.gameOver())
                }
            case "gameEnd":
                endGame(results: c.results ?? [], elapsed: c.elapsed ?? 0)
            default:
                // pieceLock / lineClear / playerKO / garbageCancelled / garbageSent
                // are rendered from `events`.
                break
            }
        }
    }

    private func endGame(results: [PlayerResult], elapsed: Double) {
        let enriched = enrichResults(results)
        lastResults = enriched   // replayed in the WELCOME to controllers joining on RESULTS
        flow.transition(to: .results)
        output?.stopMusic()
        // Clear any pause overlay/menu BEFORE building the results menu — setPaused
        // clears the focus menu, so it must run before showResults sets the
        // results buttons (otherwise the results menu is wiped → no Left/Right).
        output?.setPaused(false)
        transport.broadcast(OutboundMessage.gameEnd(elapsed: elapsed, results: enriched.map { $0.payload }))
        output?.showResults(enriched)
        output?.showScreen(.results)   // reveal the results layer (hide the frozen game)
        engine = nil
    }

    private func returnToLobby() {
        guard flow.state != .lobby else { return }
        pausedManual = false; pausedAuto = false; pausedConnection = false
        aliveState = [:]
        lastResults = nil
        engine = nil
        output?.stopMusic()
        output?.setPaused(false)
        pruneDisconnected()
        playerOrder = []
        flow.clearDisconnected()
        flow.transition(to: .lobby)
        broadcastLobby()
        transport.broadcast(OutboundMessage.returnToLobby(playerCount: flow.size))
        output?.showScreen(.lobby)
    }

    /// Drive the engine + music to match the effective `paused` after a reason flag
    /// changed. Idempotent; re-primes the frame clock on freeze so the first frame
    /// after resume re-primes with delta 0 instead of a catch-up jump.
    private func reconcilePause(wasPaused: Bool) {
        guard paused != wasPaused else { return }
        if paused {
            engine?.pause()
            engine?.resetFrameClock()
            output?.pauseMusic()
        } else {
            engine?.resume()
            if !muted { output?.resumeMusic() }
        }
    }

    private var isPausableState: Bool { flow.state == .playing || flow.state == .countdown }

    private func pauseGame() {   // host / remote (Pause)
        guard isPausableState, !pausedManual else { return }
        let was = paused; pausedManual = true; reconcilePause(wasPaused: was)
        output?.setPaused(true)
        transport.broadcast(OutboundMessage.gamePaused())
    }

    private func resumeGame() {  // host / remote (Continue)
        guard isPausableState, pausedManual, !flow.allParticipantsDisconnected else { return }
        let was = paused; pausedManual = false; reconcilePause(wasPaused: was)
        output?.setPaused(false)
        transport.broadcast(OutboundMessage.gameResumed())
    }

    /// Silent auto-pause when every participant has disconnected: no overlay, no
    /// broadcast (all controllers are gone). Absorbs an in-progress manual pause
    /// (converting it and hiding its overlay) so the overlay isn't stranded.
    private func autoPauseAllDisconnected() {
        guard flow.state == .playing, !pausedAuto else { return }
        let was = paused
        // If the host had already manually paused, convert that into the auto-pause
        // and hide the stranded overlay: resumeGame is gated shut while everyone is
        // gone, so a manual pause left showing could never be dismissed via Continue.
        // A reconnect auto-resumes. Web DisplayGame.js dismissAutoPausedOverlay.
        if pausedManual { pausedManual = false; output?.setPaused(false) }
        pausedAuto = true
        reconcilePause(wasPaused: was)
    }

    /// A participant returned — lift the all-disconnected auto-pause.
    private func autoResume() {
        guard pausedAuto, !flow.allParticipantsDisconnected else { return }
        let was = paused; pausedAuto = false; reconcilePause(wasPaused: was)
        if !paused { transport.broadcast(OutboundMessage.gameResumed()) }
    }

    /// The display's OWN relay link dropped: freeze the sim so it doesn't run blind
    /// behind the reconnect overlay. No broadcast (the relay is down). Driven by
    /// the connection-state observer (setRelayConnected).
    private func connectionPause() {
        guard flow.state == .playing || flow.state == .countdown, !pausedConnection else { return }
        let was = paused; pausedConnection = true; reconcilePause(wasPaused: was)
    }

    private func connectionResume() {
        guard pausedConnection else { return }
        let was = paused; pausedConnection = false; reconcilePause(wasPaused: was)
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
    /// - The link-drop pause. Resuming at `.open` broadcasts GAME_RESUMED into a
    ///   socket the relay has not yet re-admitted to the room, so the message can be
    ///   dropped server-side and controllers stay stuck behind their overlay.
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

    /// Once-per-frame presence sweep (countdown + playing). Flags silently-dead
    /// controllers, returns to the lobby after the late-joiner grace, and silently
    /// auto-pauses / auto-resumes on the all-disconnected boundary. Mirrors the web
    /// DisplayLiveness loop + checkAllPlayersDisconnected.
    private func pollPresence(_ now: Double) {
        // Skip the controller-liveness sweep while the display's OWN link is down:
        // no controller traffic can arrive, so every lastSeen is stale through no
        // fault of the controllers (web DisplayLiveness `displayDead` early-return).
        // Without this, a recoverable display outage would expire every controller
        // and (with a late joiner) grace-return the match to the lobby.
        guard relayConnected else { return }
        for id in flow.expiredPeers(now) {
            flow.markDisconnected(id)
            // The per-board rejoin QR only applies while boards are on screen.
            if flow.state == .countdown || flow.state == .playing {
                output?.setDisconnected(playerId: id, joinURL: rejoinURL(id))
            }
        }
        switch flow.state {
        case .playing:
            if flow.graceTick(now) { returnToLobby(); return }
            if flow.allParticipantsDisconnected {
                autoPauseAllDisconnected()
            } else if pausedAuto {
                autoResume()
            }
        case .results:
            // No connected controller left on the results screen → back to the
            // lobby (mirrors the web RESULTS peer-left path; controllers ping at
            // 1 Hz, so an idle-but-connected controller is never expired here).
            if !hasConnectedParticipant() { returnToLobby() }
        case .lobby, .countdown:
            break
        }
    }

    /// Re-publish the room state iff the effective host changed since the last
    /// broadcast (mirror of web maybeBroadcastHostChange). Skips when nobody is
    /// left to notify.
    private var lastBroadcastedHostId: Int?
    private func maybeBroadcastHostChange() {
        guard flow.size > 0, flow.host != lastBroadcastedHostId else { return }
        broadcastLobby()
    }

    // MARK: - Apple TV remote (display-side controls)

    /// Start a match from the lobby (or play again from results).
    public func remoteStartMatch() {
        if (flow.state == .lobby || flow.state == .results) && flow.size >= 1 { beginCountdown() }
    }

    /// Return to the lobby (the "New Game" action on results / pause).
    public func remoteReturnToLobby() {
        if flow.state != .lobby { returnToLobby() }
    }

    /// Pause/resume during a game or the 3-2-1 countdown (the web allows both).
    public func remoteTogglePause() {
        guard isPausableState else { return }
        if pausedManual { resumeGame() } else { pauseGame() }
    }

    /// The Play/Pause button: context toggle — start in the lobby, play again on
    /// results, pause/resume (Continue) during a game or countdown.
    public func remotePlayPause() {
        switch flow.state {
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
        muted.toggle()
        transport.broadcast(OutboundMessage.displayMuted(muted))
        if muted { output?.pauseMusic() }
        else if flow.state == .playing && !paused { output?.resumeMusic() }
        output?.setDisplayMuted(muted)
        return muted
    }

    // MARK: - Outbound builders

    /// Publish ONE retained room snapshot via `set_state` instead of fanning out a
    /// per-recipient LOBBY_UPDATE (web doBroadcastLobbyUpdate, PR #170): the relay
    /// pushes it live to connected controllers and replays it to any (re)joining peer
    /// right after `joined`, so N messages collapse to one set_state and a briefly
    /// dropped controller catches up for free. Controllers derive playerCount, taken
    /// colours, host name/colour and their own colour from the roster (controller
    /// onState); per-recipient startLevel still goes out targeted (sendLobbyUpdate on
    /// SET_LEVEL) and WELCOME stays authoritative for identity.
    private func broadcastLobby() {
        lastBroadcastedHostId = flow.host   // so maybeBroadcastHostChange won't re-fire
        publishRoomSnapshot()
        refreshDisplayLobby()
    }

    /// Throttled, leading + trailing: a call after a quiet period publishes
    /// immediately; calls inside the window collapse into one trailing publish that
    /// reads live state at fire time (the frame loop drives the trailing edge).
    private func publishRoomSnapshot() {
        let now = nowProvider()
        guard now - lastSnapshotAt >= Self.lobbyBroadcastMinIntervalMs else {
            snapshotPending = true
            return
        }
        snapshotPending = false
        lastSnapshotAt = now
        transport.setState(buildRoomSnapshot())
    }

    /// Fire a pending trailing snapshot once the throttle window has elapsed.
    private func flushPendingSnapshot() {
        guard snapshotPending else { return }
        let now = nowProvider()
        guard now - lastSnapshotAt >= Self.lobbyBroadcastMinIntervalMs else { return }
        snapshotPending = false
        lastSnapshotAt = now
        transport.setState(buildRoomSnapshot())
    }

    /// Web buildRoomSnapshot: roster keyed by peerIndex (display-facing name + colour
    /// slot) plus the effective host. Globally-shared state only — per-recipient
    /// fields (startLevel, alive, results, paused) stay on WELCOME / LOBBY_UPDATE.
    /// Tiny (<1 KiB for a full room), well under the relay's 16 KiB cap.
    private func buildRoomSnapshot() -> [String: Any] {
        var roster: [String: Any] = [:]
        for p in flow.list() {
            roster[String(p.peerIndex)] = ["name": p.playerName, "color": p.colorSlot, "startLevel": p.startLevel]
        }
        // NSNull, not nil: JSONSerialization drops an `Any?` and the controller reads
        // `hostPeerIndex == null` as "no host" (web sends an explicit null).
        return ["hostPeerIndex": flow.host.map { $0 as Any } ?? NSNull(), "players": roster]
    }

    /// Rebuild the display's own lobby UI from the current roster. Needed because
    /// name/color/level changes mutate records in place and don't fire
    /// onRosterChange, which is what the display lobby otherwise listens to.
    private func refreshDisplayLobby() {
        output?.updateLobby(players: flow.list(), hostPeerIndex: flow.host)
    }


    private func sendWelcome(to id: Int, isLateJoiner: Bool) {
        guard let rec = flow.player(id) else { return }
        let host = flow.host
        var welcome: [String: Any] = [
            "type": MSG.welcome,
            "playerName": rec.playerName,
            "colorIndex": rec.colorSlot,
            "playerCount": flow.size,
            "roomState": flow.state.rawValue,
            "startLevel": rec.startLevel,
            "isHost": id == host,
            "takenColorIndices": flow.takenColorSlots(),
            "displayMuted": muted,
        ]
        // Omit nil host fields rather than `as Any`-coercing them (see sendLobbyUpdate).
        if let hostName = host.flatMap({ flow.player($0)?.playerName }) { welcome["hostName"] = hostName }
        if let hostColor = host.flatMap({ flow.player($0)?.colorSlot }) { welcome["hostColorIndex"] = hostColor }
        // Report the participant's real alive state (false once KO'd) so a
        // reconnecting eliminated phone stays on its game-over screen instead of
        // flipping back to the live playing UI (web parity: lastAliveState).
        if !isLateJoiner { welcome["alive"] = aliveState[id] ?? true; welcome["paused"] = userVisiblePaused }
        // Replay the finished ranking to a controller landing on RESULTS.
        if flow.state == .results, let lastResults { welcome["results"] = lastResults.map { $0.payload } }
        transport.sendTo(id, welcome)
    }

    private func enrichResults(_ results: [PlayerResult]) -> [MatchResult] {
        var out: [MatchResult] = []
        var rankedIds = Set<Int>()
        for r in results {
            rankedIds.insert(r.playerId)
            let rec = flow.player(r.playerId)
            out.append(MatchResult(playerId: r.playerId,
                                   playerName: rec?.playerName, colorIndex: rec?.colorSlot,
                                   rank: r.rank, lines: r.lines, level: r.level, alive: r.alive))
        }
        // Late joiners who sat out.
        for rec in flow.list() where !rankedIds.contains(rec.peerIndex) {
            out.append(MatchResult(playerId: rec.peerIndex, playerName: rec.playerName,
                                   colorIndex: rec.colorSlot, newPlayer: true))
        }
        return out
    }

    // MARK: - Helpers

    private func pruneDisconnected() {
        for rec in flow.list() where flow.isDisconnected(rec.peerIndex) {
            flow.removePlayer(rec.peerIndex)
            playerOrder.removeAll { $0 == rec.peerIndex }
        }
    }

    private func autoName(slot: Int) -> String { "HX-\(slot + 1)" }

    private func sanitizeName(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let stripped = raw.unicodeScalars.filter { !$0.properties.isDefaultIgnorableCodePoint && $0 >= " " }
        var s = String(String.UnicodeScalarView(stripped)).trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if s.count > 16 { s = String(s.prefix(16)) }
        return s
    }

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
