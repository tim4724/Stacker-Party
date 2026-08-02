import SwiftUI
import SpriteKit
import AVFoundation
import HexStackerKit

/// The display "shell": owns the relay client, the DisplayCoordinator, the
/// music player and the SpriteKit board scene; implements DisplayOutput by
/// folding chrome callbacks into the published `state` (rendered by
/// DisplayChromeView) and forwarding board/audio callbacks directly. Mirrors
/// the Android TvDisplayOutput + MainActivity wiring.
final class DisplayModel: ObservableObject {

    @Published private(set) var state = UiModel()
    // Gallery carousel marker (HEXGALLERY): the currently-rendered state's
    // name, read by the UI test through the accessibility bridge. "pending"
    // is a sentinel the test waits past for the first real state.
    @Published private(set) var galleryMarker = "pending"
    // Idle frame pacing engaged: DisplayRootView drops the SpriteView to
    // idleFramesPerSecond while this is set (see updateFramePacing).
    @Published private(set) var idleThrottled = false

    // Sized from the screen up front; resizeFill tracks the view thereafter.
    let boardScene = BoardScene(size: UIScreen.main.bounds.size)
    private var relay: RelayClient?
    private var coordinator: DisplayCoordinator?
    private let music = MusicPlayer()

    private(set) var galleryMode = ProcessInfo.processInfo.environment["HEXGALLERY"] != nil
    private var galleryIndex = 0
    // Frozen-capture harness modes (HEXGALLERY carousel, HEXSHOT single state):
    // render one settled state, no live tick — and no animations at all:
    // DisplayRootView zeroes every transaction's animation in this mode, so
    // captures always show end frames and no future animation can reintroduce
    // mid-flight gallery shots.
    private(set) var shotMode = ProcessInfo.processInfo.environment["HEXGALLERY"] != nil
        || ProcessInfo.processInfo.environment["HEXSHOT"] != nil
    private var relayStarted = false   // false in the offline harness modes

    // Lobby identity (fed by roomReady, joined with the roster by updateLobby).
    private var room: String?
    private var joinURL: String?
    private var qrText: String?

    // Last relay link state, so appDidBecomeActive can tell a healthy socket
    // from an in-flight reconnect.
    private var linkState: RelayClient.ConnectionState = .idle
    // Whether the resign-active actually backgrounded the app (Home press) rather
    // than a transient overlay (app switcher peek, Siri) that returns to active.
    private var backgroundedSinceResign = false

    // The one transition token: every screen/overlay change cross-fades with
    // this. Views declare plain .transition(.opacity); the model wraps its
    // state mutations in withAnimation(Self.fade). BoardScene's SKAction
    // layer fades share the duration so scene and chrome move as one.
    static let fadeDuration: TimeInterval = 0.3
    static let fade = Animation.easeInOut(duration: fadeDuration)

    // MARK: - Boot

    func start() {
        PerfProbe.shared?.logEnvironment(sceneSize: boardScene.size)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        // Hold the screensaver off for the whole session, lobby included, not just
        // during a match. A lobby that screensavers over hides the QR and the room
        // code, and it is not merely cosmetic: the screensaver stops the app
        // rendering, our engine tick is pumped by the scene's update, and the
        // countdown is a frame accumulator, so a match started from a phone behind
        // it never advances (input stays gated, no sound) until someone presses the
        // remote. Prevention is the only lever: tvOS has no API to dismiss a
        // screensaver that is already up (measured on device), so there is no state
        // in which letting one start is recoverable from the phone side. The cost is
        // an idle TV staying awake while the app is open. Mirrors Android's
        // FLAG_KEEP_SCREEN_ON and the web wake lock, which hold for the same span.
        UIApplication.shared.isIdleTimerDisabled = true

        // Debug-only QR retarget, for testing a branch preview of the controller:
        // set HEXHOST=preview-<branch>.hexstacker.com in the Run scheme. Applied
        // before the relay connects (the origin also rides `create` as the
        // controller-URL template). Unset => production; env vars can't be set on
        // a TestFlight/App Store launch, so a shipped build always is.
        Protocol.setControllerBase(ProcessInfo.processInfo.environment["HEXHOST"])
        // Capture hook (mirrors HEXSHOT / HEXSNAP): open the licenses page straight
        // away so it can be screenshotted deterministically — the tvOS simulator has
        // no Siri-Remote CLI to navigate to it. Inert without the env var.
        if ProcessInfo.processInfo.environment["HEXLICENSES"] != nil {
            state.aboutPath = [.about, .licenses]
        }

        // Visual-parity capture: render the fixed fixture board and stop.
        if ProcessInfo.processInfo.environment["HEXSNAP"] != nil {
            state.screen = .game
            boardScene.renderStaticFixture()
            return
        }

        if galleryMode {
            presentGalleryState()
            return
        }
        if let shot = ProcessInfo.processInfo.environment["HEXSHOT"] {
            let pc = ProcessInfo.processInfo.environment["HEXPLAYERS"].flatMap { Int($0) } ?? 4
            makeCoordinator(relayBacked: false)
            applyShot(shot, playerCount: pc)
            return
        }

        // Lobby UI verification: populate fake players (no relay) so filled
        // player cards / host tint can be exercised without controllers.
        if ProcessInfo.processInfo.environment["HEXLOBBY"] != nil {
            makeCoordinator(relayBacked: false)
            startTickPump()
            coordinator?.startLobbyDemo(playerCount: 3)
            return
        }

        // Self-playing local game (no relay), for rendering verification. Must
        // NOT call start() — the relay's async onCreated would flip the screen
        // back to the lobby mid-demo.
        if ProcessInfo.processInfo.environment["HEXDEMO"] != nil {
            makeCoordinator(relayBacked: false)
            startTickPump()
            showScreen(.lobby)
            // HEXPLAYERS as everywhere else (HEXSHOT, the gallery): render
            // profiling needs the 8-board worst case, which is where the
            // per-frame snapshot sync and the draw-call count actually bite.
            let pc = ProcessInfo.processInfo.environment["HEXPLAYERS"].flatMap { Int($0) } ?? 2
            coordinator?.startLocalDemo(playerCount: max(1, min(pc, 8)))
            return
        }

        // Scripted transition tour for motion review (no relay): every screen
        // edge driven through the production triggers on a wall-clock timer.
        // Recorded by scripts/record-transitions-tvos.sh — the tvOS mirror of
        // the web gallery's "Transitions (full journey)" card.
        if ProcessInfo.processInfo.environment["HEXTOUR"] != nil {
            makeCoordinator(relayBacked: false)
            startTickPump()
            runTransitionTour()
            return
        }

        makeCoordinator(relayBacked: true)
        startTickPump()
        coordinator?.start()
        relayStarted = true
        showScreen(.lobby)
        // The waiting-lobby scaffold renders immediately so the create-failure
        // overlay sits on top of the lobby (not a bare background) and there's
        // no empty-screen flash before the room arrives.
        state.lobby = LobbyData()
    }

    private func makeCoordinator(relayBacked: Bool) {
        let relay = RelayClient()
        self.relay = relay
        // Optional WebRTC input fastlane: controller input rides peer-to-peer
        // DataChannels when open, with the relay as signaling + fallback. Built
        // only when the WebRTC framework is linked (canImport); otherwise nil and
        // all input flows over the relay (the v1 behavior).
        let fastlane: InputFastlane?
        #if canImport(LiveKitWebRTC)
        let rtc = WebRTCFastlane.make(stunURL: HexStackerKit.Protocol.stunURL,
                                      sendSignal: { [weak self] idx, data in self?.relay?.sendTo(idx, data) })
        PerfProbe.shared?.fastlaneSummary = { [weak rtc] in rtc?.perfSummary() ?? "none" }
        fastlane = rtc
        #else
        fastlane = nil
        #endif
        let coordinator = DisplayCoordinator(transport: relay,
                                             engineDirectory: AssetLocator.engineDirectory,
                                             output: self,
                                             fastlane: fastlane)
        self.coordinator = coordinator
        // Boards read the roster off the published lobby state, not the room: the
        // seats are already snapshot-derived (updateLobby), and a lookup on the
        // render path has no business crossing into the JS runtime.
        boardScene.rosterLookup = { [weak self] id in
            self?.state.lobby?.players.first { $0.peerIndex == id }.map { ($0.colorSlot, $0.name) }
        }
        guard relayBacked else { return }

        // The display's own relay link dropping shows a full-screen overlay
        // (distinct from a single controller dropping = per-board QR), AND freezes
        // the simulation so it can't run blind (KO'ing players who can't send
        // input) behind the overlay; reconnecting resumes it.
        relay.onConnectionState = { [weak self] connState in
            guard let self else { return }
            self.linkState = connState
            self.coordinator?.setRelayConnected(connState == .open)
            withAnimation(Self.fade) {
                self.state.connection = connState
                if connState == .open { self.state.replaced = false }
            }
            // Any state but .open means the link is (still) down, so the shown lobby
            // QR may be stale (a rejoin can bounce off "Room not found" into a fresh
            // room). Notably .connecting shows no overlay (a foreground rejoin after
            // suspend() must not flash the full DISCONNECTED cover), so the dim is
            // what marks the QR untrusted. .open does NOT clear it — the socket
            // opens before the relay answers the join; only roomReady re-confirms.
            if connState != .open {
                withAnimation(Self.fade) { self.state.qrPending = true }
            }
        }
        // Evicted because another client claimed the "display" slot: reconnecting
        // would start a takeover war, so show a terminal disconnect with no button.
        relay.onReplaced = { [weak self] in
            guard let self else { return }
            self.coordinator?.setRelayConnected(false)
            withAnimation(Self.fade) {
                self.state.replaced = true
                self.state.connection = .closed
            }
        }
        // Live "Attempt N of M" on the reconnect overlay (web parity;
        // 0 = the heartbeat path's unnumbered immediate retry, status hidden).
        relay.onReconnecting = { [weak self] attempt, max in
            self?.state.reconnectAttempt = attempt
            self?.state.reconnectMax = max
        }
    }

    private func startTickPump() {
        boardScene.onTick = { [weak self] deltaMs in
            self?.coordinator?.tick(deltaMs: deltaMs)
        }
    }

    // MARK: - Idle frame pacing

    /// The throttled rate while idle (web parity: DisplayRender drops to ~4fps
    /// on the pause overlay / results screen; SpriteKit otherwise re-composites
    /// every vsync). 10fps keeps the paused sim's tick cadence comfortable.
    static let idleFramesPerSecond = 10

    private var idlePacingWork: DispatchWorkItem?

    /// Recompute the pacing flag on every paused/screen edge. The scene's
    /// update() is also the engine tick pump, so the low rate slows the
    /// simulation too, acceptable in exactly the states the web throttles
    /// (paused sims are frozen, results runs none). Engaging waits out the
    /// 0.3s cross-fade so the scene's SKAction layer fades stay smooth;
    /// restoring is immediate so the first interaction (resume, play again)
    /// isn't laggy. Harness modes stay at full rate (relayStarted is false
    /// there, and HEXTOUR records transition video that must not drop frames).
    private func updateFramePacing() {
        idlePacingWork?.cancel()
        idlePacingWork = nil
        if relayStarted && (state.paused || state.screen == .results) {
            let work = DispatchWorkItem { [weak self] in self?.idleThrottled = true }
            idlePacingWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.fadeDuration, execute: work)
        } else {
            idleThrottled = false
        }
    }

    // MARK: - Intents (remote / focus-engine driven)

    func startMatch() { coordinator?.remoteStartMatch() }
    func newGame() { coordinator?.remoteReturnToLobby() }
    func togglePause() { coordinator?.remoteTogglePause() }
    func toggleMusic() { _ = coordinator?.remoteToggleMute() }

    /// Play/Pause context action (Start / Pause / Continue / Play Again).
    /// Inert while About/Licenses cover the lobby (the button can't start a
    /// match under a legal page) or while the connection overlay is up (it
    /// can't start a match under a frozen, relay-less simulation).
    func playPause() {
        guard state.aboutPath.isEmpty, !state.connectionOverlayUp else { return }
        coordinator?.remotePlayPause()
    }
    func reconnectNow() { relay?.reconnectNow() }
    /// The About stack path, bound into the lobby's NavigationStack.
    func setAboutPath(_ path: [AboutRoute]) { state.aboutPath = path }

    /// Menu button: pause during gameplay; return false at the top level so
    /// tvOS exits the app normally (the caller falls through to the default).
    /// Also declines under the connection overlay: exiting to the home screen
    /// there is safe (backgrounding suspends the socket; the party resumes
    /// gracefully).
    ///
    /// While About/Licenses are up, the NavigationStack is the ONLY owner of
    /// Menu: it pops one level itself (on press-ENDED). This handler must
    /// consume the press WITHOUT touching aboutPath. Popping here too (this
    /// fires on press-BEGAN) double-popped on a real remote press: the stack's
    /// ENDED pop landed after the root's pop transition settled, and Licenses
    /// fell straight through to the lobby. Fast synthetic test presses masked
    /// it (a UINavigationController declines a pop while one is in flight).
    /// The consume keeps a bubbled press off super's default app-exit.
    func handleMenu() -> Bool {
        guard !state.connectionOverlayUp else { return false }
        if !state.aboutPath.isEmpty { return true }
        if state.screen == .game { coordinator?.remoteTogglePause(); return true }
        return false
    }

    // MARK: - App lifecycle

    /// App is backgrounding. Don't end the party (backgrounding is recoverable,
    /// unlike the web's pagehide): close the P2P channels and suspend the relay
    /// socket, giving the relay an immediate peer_left(0) so controllers show
    /// their reconnect overlay right away.
    func appDidEnterBackground() {
        backgroundedSinceResign = true
        coordinator?.displayDidEnterBackground()
        guard relayStarted else { return }   // HEXSHOT/HEXLOBBY/HEXDEMO never connect
        relay?.suspend()
        // Graceful resume exists for rooms with PLAYERS. An empty lobby's
        // room dies with our socket at the relay (rooms live on members),
        // so reopening would rejoin a dead room, bounce off "Room not
        // found", and visibly swap the QR mid-lobby. Forget the room and
        // reset to the waiting scaffold instead: the next foreground
        // presents like a fresh open — blank card, then the new room's QR.
        if state.lobby?.players.isEmpty ?? true {
            relay?.unpinRoom()
            room = nil
            joinURL = nil
            qrText = nil
            state.lobby = LobbyData()
            state.qrPending = false   // blank card, not a dimmed stale one
        }
    }

    /// App returned to the foreground: rejoin explicitly. If the room survived,
    /// `joined` replays the roster; if the relay retired it, the join answers
    /// "Room not found" and onRelayError opens a fresh room.
    func appWillEnterForeground() {
        guard relayStarted else { return }
        // suspend() parks the link on .closed, and reconnectNow's .connecting
        // lands asynchronously — without this, the first foreground frames
        // paint the full DISCONNECTED overlay over the resuming lobby (a
        // ~100ms flash during the system app-switch). Present the resume as
        // a quiet rejoin instead: no overlay, the QR pending dim marks the
        // unconfirmed room, and a genuinely failed rejoin re-raises the
        // overlay through the normal state flow. `replaced` stays terminal.
        if state.connection == .closed && !state.replaced {
            state.connection = .connecting
        }
        relay?.reconnectNow()
    }

    /// Frames rendered up to resign-active feed the system snapshot — the image
    /// the return transition shows. Dim the QR now so a possibly-stale room code
    /// never presents as live on resume; the happy-path rejoin clears the dim
    /// (roomReady) before the first live frame, making it invisible.
    func appWillResignActive() {
        guard relayStarted else { return }   // gallery/demo harnesses have no room
        state.qrPending = true
    }

    /// Transient resign (no backgrounding): the socket never suspended and the
    /// room is unchanged, so lift the precautionary dim — unless the link is
    /// genuinely down, where roomReady clears it after the reconnect instead.
    func appDidBecomeActive() {
        if !backgroundedSinceResign, linkState == .open {
            withAnimation(Self.fade) { state.qrPending = false }
        }
        backgroundedSinceResign = false
    }

    // MARK: - Transition tour (HEXTOUR)

    /// Walk every screen edge through the real production triggers, with
    /// fixture players and self-playing matches: lobby entrance, three join
    /// pops, match start (lobby exit), a real game end into results, PLAY
    /// AGAIN (results → countdown), a second results, NEW GAME (results →
    /// lobby), then a third match for the pause overlay and NEW GAME from
    /// pause (game → lobby). Dwells are wall-clock, sized so the countdown
    /// (~3.5s) and each fade have settle time on film.
    private func runTransitionTour() {
        guard let c = coordinator else { return }
        let steps: [(at: Double, run: () -> Void)] = [
            // Room ready BEFORE the lobby's first frame (the web tour's own
            // sequence), so the QR pattern rides the entrance slide from
            // frame 0. Don't try to schedule a mid-entrance confirm here:
            // launch jitter shifts the timer against the entrance window, and
            // a late-landing pattern pops onto the settled card — which reads
            // exactly like the detached-QR bug this tour exists to disprove.
            // The mid-entrance arrival is a production-timing case; verify it
            // against the live relay app.
            (0.0,  { c.renderShot("lobby-empty") }),
            (2.5,  { c.startLobbyDemo(playerCount: 1) }),
            (3.4,  { c.startLobbyDemo(playerCount: 2) }),
            (4.3,  { c.startLobbyDemo(playerCount: 3) }),
            (7.0,  { c.tourEnableSelfPlay(); c.remoteStartMatch() }),
            (15.0, { c.tourForceMatchEnd() }),
            (19.0, { c.tourEnableSelfPlay(); c.remoteStartMatch() }),
            (27.0, { c.tourForceMatchEnd() }),
            (31.0, { c.remoteReturnToLobby() }),
            (34.0, { c.tourEnableSelfPlay(); c.remoteStartMatch() }),
            (40.0, { c.remoteTogglePause() }),
            (43.0, { c.remoteReturnToLobby() }),
        ]
        for step in steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + step.at, execute: step.run)
        }
    }

    // MARK: - Gallery (HEXSHOT / HEXGALLERY)

    // Single source of truth for the gallery order (mirrors the `tvos` entries
    // in scripts/gallery/scenarios.json); the UI test reads each state's name
    // back through the accessibility marker.
    static let galleryStates: [(name: String, shot: String, players: Int)] = [
        ("lobby", "lobby", 4),
        ("lobby-2p", "lobby", 2),
        ("lobby-8p", "lobby", 8),
        ("lobby-long-names", "lobby-long", 4),
        ("lobby-empty", "lobby-empty", 0),
        ("countdown", "countdown", 4),
        ("game", "game", 4),
        ("game-lv8", "game-lv8", 4),
        ("game-lv12", "game-lv12", 4),
        ("game-2p", "game-2p", 2),
        ("game-3p", "game-3p", 3),
        ("game-4p", "game-4p", 4),
        ("game-8p", "game-8p", 8),
        ("pause", "pause", 4),
        ("pause-music", "pause-music", 4),
        ("disconnected-controller", "disconnected-controller", 4),
        ("create-error-retry", "create-error-retry", 0),
        ("create-error", "create-error", 0),
        ("reconnecting", "reconnecting", 4),
        ("disconnected-display", "disconnected-display", 4),
        ("results", "results", 4),
        ("results-solo", "results-solo", 1),
        ("about", "about", 0),
        ("licenses", "licenses", 0),
    ]

    /// Advance to the next gallery state (Play/Pause in gallery mode). The marker
    /// keeps reporting the PREVIOUS name until the new state signals ready, so
    /// the UI test reliably waits for a changed value before capturing.
    func advanceGallery() {
        guard galleryMode, galleryIndex + 1 < Self.galleryStates.count else { return }
        galleryIndex += 1
        presentGalleryState()
    }

    /// Render the current carousel state from a clean slate. State + coordinator
    /// are rebuilt per state (the equivalent of the old fresh-scene-per-state) so no
    /// overlay/roster state can leak between captures — including the room identity,
    /// or an earlier lobby state's QR would leak into the room-less create-error
    /// shots through applyShot's buildLobby fold-in.
    private func presentGalleryState() {
        let entry = Self.galleryStates[galleryIndex]
        state = UiModel()
        room = nil
        joinURL = nil
        qrText = nil
        boardScene.resetBoards()
        // Sync the scene to the fresh model's .lobby: showScreen's same-screen
        // guard would otherwise skip the scene flip for lobby-family states
        // captured right after a game/results state, leaving the previous
        // scene layer up instead of the lobby's ambient falling pieces.
        boardScene.showScreen(state.screen)
        makeCoordinator(relayBacked: false)
        applyShot(entry.shot, playerCount: entry.players)
        // Report ready once labels / QR / board textures have rasterized. No
        // animation tail to sit out: shotMode zeroes every animation at the
        // root, so this only covers the SwiftUI commit + texture upload of the
        // settled frame. Runs on the main queue, so a slow CI runner still
        // busy rasterizing pushes the marker flip out with it. The process is
        // warm, so this still beats per-state cold launches.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.galleryMarker = entry.name
        }
    }

    /// Render a single frozen gallery state. Base states delegate to the
    /// coordinator's fixture renderer; special cases layer overlay/focus state
    /// on top of a base shot.
    private func applyShot(_ shot: String, playerCount pc: Int) {
        switch shot {
        case "pause-music":   // pause overlay with the MUSIC switch focused
            coordinator?.renderShot("pause", playerCount: pc)
            state.focusMusicForShot = true
        case "reconnecting":  // full-screen display-disconnect overlay over a game
            coordinator?.renderShot("game", playerCount: pc)
            // Gallery parity with web (DisplayTestHarness shows "Attempt 2 of 5"):
            // the live retry tick that would set this never fires in a static shot.
            state.connection = .reconnecting
            state.reconnectAttempt = 2
            state.reconnectMax = 5
        case "disconnected-display":
            coordinator?.renderShot("game", playerCount: pc)
            state.connection = .closed
        case "create-error-retry":  // first-launch create failed, auto-retrying
            // Reconnect overlay over the empty, room-less waiting lobby (matching
            // web): a failed create now reads exactly like a lost room.
            state.screen = .lobby
            state.lobby = LobbyData()
            state.connection = .reconnecting
            state.reconnectAttempt = 1
            state.reconnectMax = 5
        case "create-error":        // create attempts exhausted → DISCONNECTED + RECONNECT
            state.screen = .lobby
            state.lobby = LobbyData()
            state.connection = .closed
        case "about":         // full-screen About page (Privacy / Imprint QR + Licenses drill-in)
            coordinator?.renderShot("lobby-empty", playerCount: pc)
            seedAboutPath([.about])
        case "licenses":      // full-screen Licenses page (scrolled to top)
            coordinator?.renderShot("lobby-empty", playerCount: pc)
            seedAboutPath([.about, .licenses])
        default:
            coordinator?.renderShot(shot, playerCount: pc)
        }
        // The fixtures seed the room roster directly (no publish), so fold the
        // seeded roster into the published lobby here or host-tinted chrome
        // (pause CONTINUE, music switch, results PLAY AGAIN) would render its
        // accent fallback in every shot.
        if state.lobby == nil || state.lobby?.players.isEmpty == true {
            state.lobby = buildLobby()
        }
    }

    /// Seed the About/Licenses path one runloop late: a NavigationStack that is
    /// INSERTED with a non-empty path (carousel "about" right after the results
    /// state swaps the screen back to .lobby) resets the path to [] as it
    /// attaches, and the gallery captured the bare lobby. Pushing on the next
    /// tick targets the now-live stack, which is the same (working) order the
    /// HEXSHOT/HEXLICENSES single-state paths get from onAppear. Well inside
    /// the 0.35s marker delay, so the capture still sees the settled page.
    private func seedAboutPath(_ path: [AboutRoute]) {
        DispatchQueue.main.async { [weak self] in
            self?.state.aboutPath = path
        }
    }
}

// MARK: - DisplayOutput

extension DisplayModel: DisplayOutput {

    func showScreen(_ screen: DisplayScreen) {
        guard screen != state.screen else { return }
        // The scene cross-fades its own layers (boards/ambient) in step with
        // the chrome fade. On match start the coordinator sends the first
        // countdown value in the same call stack, so the scrim and the boards
        // arrive in one transaction (no bare-board frames).
        boardScene.showScreen(screen)
        withAnimation(Self.fade) {
            state.screen = screen
            state.countdown = nil
            // About/Licenses are lobby-only; a match starting (from a controller
            // while one is open) must not leave them stranded over the game.
            if screen != .lobby { state.aboutPath = [] }
        }
        updateFramePacing()
    }

    func roomReady(room: String, joinURL: String, qrText: String) {
        // The relay confirmed the room (`created`, or `joined` after a rejoin), so
        // the QR is trustworthy again — the ONLY place the pending dim clears.
        // The QR pattern and join line derive from this state inside the
        // still-animating lobby view, so a mid-entrance confirm can't pop a
        // second card over the fading one (the old rebuild double-fade).
        self.room = room
        self.joinURL = joinURL
        self.qrText = qrText
        PerfProbe.shared?.logRoom(joinURL)
        // One transaction for the room-confirm reveal: the QR pattern and
        // join line fade in (their opacities key on the new lobby data) and
        // the pending dim lifts. Scoped .animation(value:) modifiers in the
        // lobby are banned for this: one firing mid-entrance snapped the
        // band's in-flight slide (~10px single-frame jump, measured).
        withAnimation(Self.fade) {
            state.qrPending = false
            state.lobby = buildLobby()
        }
    }

    func updateLobby(players: [PlayerRecord], hostPeerIndex: Int?) {
        // Unguarded (Android parity): results/pause CTAs read the live host
        // color from this state, so a mid-game host handoff retints them via
        // plain recomposition — no imperative retint plumbing.
        state.lobby = buildLobby(players: players, hostPeerIndex: hostPeerIndex)
    }

    private func buildLobby(players: [PlayerRecord]? = nil, hostPeerIndex: Int? = nil) -> LobbyData {
        // The fold-in paths (roomReady, the gallery shots) have no roster in hand and
        // read it back through the room API, which is the one place `connected` and
        // `joinedAt` are available at all — the wire snapshot carries neither.
        let roster = players ?? coordinator?.roster() ?? []
        let host = hostPeerIndex ?? coordinator?.hostPeerIndex
        return LobbyData(
            room: room ?? "",
            joinURL: joinURL ?? "",
            qrText: qrText ?? "",
            players: roster.map {
                LobbySeat(peerIndex: $0.peerIndex, name: $0.playerName,
                          colorSlot: $0.colorSlot, level: $0.startLevel, joinedAt: $0.joinedAt)
            },
            hostColorSlot: host.flatMap { h in roster.first { $0.peerIndex == h }?.colorSlot }
        )
    }

    func showCountdown(_ value: CountdownValue) {
        withAnimation(Self.fade) { state.countdown = value }
        if case .go = value { armGoDismissal() }
    }

    /// GO holds 0.4s, then the scrim fades off (web overlayTimer). Declines
    /// while paused (the web clears its countdown timers on pause for the
    /// same reason), and setPaused(false) re-arms the full hold, so a pause
    /// landing inside the GO window can't strand the resumed game behind (or
    /// without) the scrim.
    private func armGoDismissal() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, self.state.countdown == .go, !self.state.paused else { return }
            withAnimation(Self.fade) { self.state.countdown = nil }
        }
    }

    func renderSnapshot(_ snapshot: GameSnapshot) {
        boardScene.renderSnapshot(snapshot)
    }

    func handleGameEvent(_ event: GameEvent) {
        boardScene.handleGameEvent(event)
    }

    func showResults(_ results: [MatchResult]) {
        state.results = results
    }

    func setDisconnected(playerId: Int, joinURL: String?) {
        boardScene.setDisconnected(playerId: playerId, joinURL: joinURL)
    }

    func setLobbyAmbient(_ pieces: [AmbientPiece]) {
        boardScene.setLobbyAmbient(pieces)
    }

    func setPaused(_ paused: Bool) {
        withAnimation(Self.fade) { state.paused = paused }
        if !paused, state.countdown == .go { armGoDismissal() }
        updateFramePacing()
    }

    func setDisplayMuted(_ muted: Bool) {
        state.muted = muted
    }

    func playCountdownBeep(go: Bool) { music.playBeep(go: go) }
    func startMusic() { music.start() }
    func stopMusic() { music.stop() }
    func pauseMusic() { music.pause() }
    func resumeMusic() { music.resume() }
}
