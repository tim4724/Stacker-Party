import SpriteKit
import HexStackerKit

/// The SpriteKit remainder after the SwiftUI chrome migration: the per-player
/// game boards + match timer, and the lobby's ambient falling-piece background.
/// Everything else (lobby content, results, overlays, focus) lives in the
/// SwiftUI tree above this scene (DisplayChromeView). The scene stays the
/// per-frame pump for the coordinator via `update(_:)` → `onTick`.
final class BoardScene: SKScene {

    /// Coordinator tick pump (nil while the model is in a frozen shot mode).
    var onTick: ((Double) -> Void)?
    /// Roster lookup for board building / garbage tinting (reads the published lobby).
    var rosterLookup: ((Int) -> (colorSlot: Int, name: String)?)?

    // Lobby ambient = the animated falling pieces (web lobby background). The
    // accent vignette above them is SwiftUI (LobbyView), not a scene node.
    // Shown in LOBBY; hidden behind the boards otherwise.
    private let lobbyBg = LobbyBackgroundNode()

    private let gameLayer = SKNode()
    private let timerNode = SKNode()          // container for the fixed-advance timer glyphs
    // Change-gate for the once-a-second timer text. A value struct, not an
    // interpolated string: the gate runs every frame.
    private struct TimerKey: Equatable { let seconds: Int; let fontSize: CGFloat; let playerCount: Int }
    private var lastTimerKey: TimerKey?
    private var timerGlyphs: [SKLabelNode] = []

    private var boardNodes: [Int: BoardNode] = [:]
    private var currentPlayerCount = -1
    private var currentGridRows = 1           // board-grid rows, for the timer size (web cachedGridRows)
    private var lastBoardIds: [Int] = []      // the player-id set the boards were built for
    private var lastTime: TimeInterval = 0
    private var requestedScreen: DisplayScreen = .lobby  // last showScreen(), may predate didMove
    // The last rendered snapshot, replayed after a size/inset change. A frozen
    // gallery shot renders exactly once, and the tvOS safe-area insets can land
    // an instant AFTER that render; without the replay the boards would keep
    // the inset-less layout forever (live games self-heal on the next frame).
    private var lastSnapshot: GameSnapshot?

    // tvOS overscan / title-safe area. Content lays out inside playRect while
    // full-bleed backgrounds still fill `size`.
    private var safe = UIEdgeInsets.zero
    private var playRect: CGRect {
        return CGRect(x: safe.left, y: safe.bottom,
                      width: max(1, size.width - safe.left - safe.right),
                      height: max(1, size.height - safe.top - safe.bottom))
    }

    /// Sized + scale-moded at init: SpriteView captures the scene's scaleMode
    /// when it presents, which can happen BEFORE didMove runs. A default-init
    /// scene arrived there as 1x1 with .fill and was stretched to the screen
    /// (one random ambient piece rendered as a full-screen pastel wash).
    override init(size: CGSize) {
        super.init(size: size)
        scaleMode = .resizeFill
        // In init, not (only) didMove: the SKView's first presented frame
        // clears to SpriteKit's default grey before didMove runs, which
        // flashed a grey frame between the launch screen and the lobby.
        backgroundColor = SKTheme.bgPrimary
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func didMove(to view: SKView) {
        backgroundColor = SKTheme.bgPrimary
        view.ignoresSiblingOrder = true
        safe = view.safeAreaInsets

        addChild(lobbyBg)

        addChild(gameLayer)
        // Boot in the mode showScreen last asked for, NOT unconditionally LOBBY.
        // Booting LOBBY is right when nothing has asked yet: isHidden defaults to
        // false, and the app's first showScreen(.lobby) is swallowed by the
        // same-screen guard (UiModel also boots on .lobby), so this layer stayed
        // visible from birth and the pre-game snapshot flashed bare boards behind
        // the lobby chrome the instant a match started. But showScreen can also
        // land BEFORE the scene is presented (HEXSHOT renders a frozen game state
        // during start-up), and then it saw the defaults, decided the layer was
        // already visible, and scheduled no fadeIn, so forcing hidden here
        // stranded it hidden forever and every game shot came out empty.
        // Alpha follows: fadeIn animates from the current alpha.
        let lobbyMode = requestedScreen == .lobby
        gameLayer.isHidden = lobbyMode
        gameLayer.alpha = lobbyMode ? 0 : 1
        timerNode.zPosition = 20
        timerNode.isHidden = true
        gameLayer.addChild(timerNode)

        applySize()
    }

    /// resizeFill lands the view's real size only after presentation (the init
    /// size is just the pre-presentation placeholder), so every size-derived
    /// setup hangs off the size change, not didMove. Racing this cost a lobby
    /// with no falling pieces whenever didMove ran before the first layout pass.
    override func didChangeSize(_ oldSize: CGSize) {
        super.didChangeSize(oldSize)
        applySize()
    }

    private func applySize() {
        guard size.width > 0, size.height > 0 else { return }
        lobbyBg.configure(size: size)   // no-op when unchanged; a freeze survives
        relayout()
        if let snap = lastSnapshot { renderSnapshot(snap) }
    }

    override func update(_ currentTime: TimeInterval) {
        let deltaMs = lastTime == 0 ? 0 : (currentTime - lastTime) * 1000.0
        lastTime = currentTime
        if let insets = view?.safeAreaInsets, insets != safe { safe = insets; applySize() }
        // Reduce Motion parks the ambient drift: the pool stays seeded across
        // the screen (buildRandomPool), so the lobby keeps its scattered piece
        // backdrop as a still, like the frozen gallery fixture.
        if !lobbyBg.isHidden && !UIAccessibility.isReduceMotionEnabled {
            lobbyBg.tick(dt: CGFloat(min(deltaMs, 50.0) / 1000.0))
        }
        onTick?(deltaMs)
    }

    /// Screen change: LOBBY shows the ambient background, GAME/RESULTS the
    /// boards. The scene cross-fades its OWN layers (web parity: the game
    /// screen fades in WITH its boards over 0.3s, and the ambient drift sinks
    /// under the cross-fade instead of popping off) — as plain SKActions the
    /// swap is never a one-frame pop, regardless of how the SwiftUI chrome
    /// transaction above lands against the SKView's render loop.
    /// Entering GAME starts a fresh match, so force a board rebuild even if
    /// the new roster happens to match the previous one's id set.
    func showScreen(_ screen: DisplayScreen) {
        requestedScreen = screen
        lobbyBg.removeAllActions()
        gameLayer.removeAllActions()
        let d = DisplayModel.fadeDuration
        if screen == .lobby {
            if lobbyBg.isHidden { lobbyBg.alpha = 0; lobbyBg.isHidden = false }
            lobbyBg.run(.fadeIn(withDuration: d))
            gameLayer.run(.sequence([.fadeOut(withDuration: d), .hide()]))
        } else {
            if gameLayer.isHidden { gameLayer.alpha = 0; gameLayer.isHidden = false }
            if gameLayer.alpha < 1 { gameLayer.run(.fadeIn(withDuration: d)) }
            lobbyBg.run(.sequence([.fadeOut(withDuration: d), .hide()]))
        }
        if screen == .game { lastBoardIds = []; timerNode.isHidden = true }
    }

    // MARK: - Board rendering (DisplayOutput forwards)

    func renderSnapshot(_ snapshot: GameSnapshot) {
        lastSnapshot = snapshot
        ensureBoards(for: snapshot)
        for p in snapshot.players {
            boardNodes[p.id]?.update(with: p)
        }
        updateTimer(elapsedMs: snapshot.elapsed)
    }

    func handleGameEvent(_ event: GameEvent) {
        switch event.type {
        case "piece_lock":
            if let id = event.playerId { boardNodes[id]?.flashLock(event.blocks ?? [], typeId: event.typeId ?? 0) }
        case "line_clear":
            if let id = event.playerId { boardNodes[id]?.lineClearEffect(event.clearCells ?? [], lines: event.lines ?? 1) }
        case "garbage_sent":
            if let id = event.toId {
                boardNodes[id]?.shake()
                // Telegraph incoming garbage in the attacker's player color.
                let color = event.senderId
                    .flatMap { rosterLookup?($0)?.colorSlot }
                    .map { SKTheme.player(slot: $0) } ?? SKTheme.accentPrimary
                boardNodes[id]?.flashGarbageIncoming(lines: event.lines ?? 1, color: color)
            }
        case "garbage_cancelled":
            if let id = event.playerId { boardNodes[id]?.flashGarbageDefence(lines: event.lines ?? 1) }
        case "player_ko":
            if let id = event.playerId { boardNodes[id]?.flashKO() }
        default:
            break
        }
    }

    func setDisconnected(playerId: Int, joinURL: String?) {
        boardNodes[playerId]?.setDisconnected(joinURL)
    }

    func setLobbyAmbient(_ pieces: [AmbientPiece]) {
        lobbyBg.freeze(pieces)   // gallery lobby shots: freeze the falling-piece background
    }

    /// Gallery carousel: hard-reset the boards between frozen states. The
    /// fixtures reuse the same player ids across states, so ensureBoards'
    /// id-set gate would otherwise keep a previous state's boards (including
    /// a lingering per-board disconnect QR) alive into the next capture.
    func resetBoards() {
        gameLayer.removeChildren(in: boardNodes.values.map { $0 })
        boardNodes.removeAll()
        lastBoardIds = []
        currentPlayerCount = -1
        timerNode.isHidden = true
        lastTimerKey = nil
        lastSnapshot = nil
    }

    /// Render the shared visual-parity fixture (one board, top-left, cellSize 40)
    /// so the native pixels can be compared to the web canvas render (HEXSNAP).
    func renderStaticFixture() {
        let geo = HexGeometry(cellSize: VisualParityFixture.cellSize)
        let node = BoardNode(geometry: geo, colorSlot: 0, name: "", hudless: true)
        node.position = CGPoint(x: 0, y: size.height - CGFloat(geo.boardHeight))
        gameLayer.addChild(node)
        node.update(with: VisualParityFixture.snapshot())
        showScreen(.game)
    }

    // MARK: - Board layout

    private func ensureBoards(for snapshot: GameSnapshot) {
        // Rebuild when the actual set of player ids changes, not just the count: a
        // new match with the same player count but a different roster (or a
        // mid-game rekey) must rebuild, or renderSnapshot's boardNodes[p.id] lookups
        // miss the new ids and the previous game's boards stay frozen on screen.
        let ids = snapshot.players.map { $0.id }
        guard ids != lastBoardIds else { return }
        lastBoardIds = ids
        currentPlayerCount = snapshot.players.count
        gameLayer.removeChildren(in: boardNodes.values.map { $0 })
        boardNodes.removeAll()

        let layout = LayoutEngine.layout(playerCount: snapshot.players.count,
                                         viewportW: playRect.width, viewportH: playRect.height)
        currentGridRows = layout.gridRows
        for (i, placement) in layout.placements.enumerated() where i < snapshot.players.count {
            let player = snapshot.players[i]
            let rec = rosterLookup?(player.id)
            let node = BoardNode(geometry: layout.geometry,
                                 colorSlot: rec?.colorSlot ?? i,
                                 name: rec?.name ?? "P\(player.id)")
            // Place within the title-safe rect. Convert the Y-down top-left
            // placement origin to a Y-up scene position inset by the safe area.
            node.position = CGPoint(x: playRect.minX + placement.originX,
                                    y: playRect.maxY - placement.originY - layout.geometry.boardHeight)
            gameLayer.addChild(node)
            boardNodes[player.id] = node
        }
    }

    /// Invalidate the board layout (scene size or safe-area insets moved); the
    /// next snapshot re-lays-out against the new playRect. The timer key resets
    /// too, or its change-gate would skip the reposition.
    private func relayout() {
        currentPlayerCount = -1
        lastBoardIds = []
        lastTimerKey = nil
    }

    // MARK: - Match timer

    private func updateTimer(elapsedMs: Double) {
        let total = Int(elapsedMs / 1000)
        // Fixed size relative to scene height, not cell size, so the clock reads
        // the same regardless of board count and matches the web/Android renderers.
        // Two board rows (7-8 players) leave no free band above the top boards, so
        // shrink the clock to sit inside the name-label band instead of overlapping
        // the board frames (web drawTimer applies the same factor).
        var fs = max(24, min(size.height * 0.04, 60))
        if currentGridRows > 1 { fs *= 0.6 }
        // The text changes once a second; skip the per-frame glyph
        // re-rasterization (setStyledText re-runs layout + texture upload)
        // unless something that feeds the render actually changed.
        let key = TimerKey(seconds: total, fontSize: fs, playerCount: currentPlayerCount)
        if key == lastTimerKey && !timerNode.isHidden { return }
        lastTimerKey = key
        let chars = Array(String(format: "%02d:%02d", total / 60, total % 60))
        // Fixed per-glyph advances (web drawTimer): digits share a width, the colon
        // is narrower, so nothing shifts as the seconds tick.
        let digitAdvance = fs * 0.92, colonAdvance = fs * 0.52
        while timerGlyphs.count < chars.count {
            let l = SKLabelNode()
            l.verticalAlignmentMode = .top
            l.horizontalAlignmentMode = .center
            timerNode.addChild(l)
            timerGlyphs.append(l)
        }
        for (i, l) in timerGlyphs.enumerated() { l.isHidden = i >= chars.count }
        var advances: [CGFloat] = []
        var totalW: CGFloat = 0
        for c in chars { let a = (c == ":") ? colonAdvance : digitAdvance; advances.append(a); totalW += a }
        var cursor: CGFloat = 0
        for (i, c) in chars.enumerated() {
            let l = timerGlyphs[i]
            l.setStyledText(String(c), font: AppFont.name, size: fs, color: SKTheme.textPrimary(0.6), tracking: 0)
            l.position = CGPoint(x: cursor + advances[i] / 2, y: 0)   // web charX = cursor + advance/2
            cursor += advances[i]
        }
        timerNode.isHidden = false
        let topY = playRect.maxY - fs * 0.6
        // Odd board counts: a centered timer overlaps the middle board's stats, so
        // anchor it to the left edge instead (matches the web).
        if currentPlayerCount % 2 == 1 {
            timerNode.position = CGPoint(x: playRect.minX + fs * 0.3, y: topY)
        } else {
            timerNode.position = CGPoint(x: playRect.midX - totalW / 2, y: topY)
        }
    }

}

