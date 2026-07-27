import Foundation

// The offline capture/demo harness: everything here renders frozen gallery
// fixtures or drives a synthetic local game (no relay, no controllers). Kept
// out of DisplayCoordinator.swift so the live-game brain stays readable; the
// shared stored properties (demo flags, galleryBridge) live on the class.
public extension DisplayCoordinator {

    // MARK: - Local demo

    /// Start a self-driving game with `playerCount` synthetic players and no
    /// relay/controllers. For rendering verification (screenshots) and visual
    /// parity checks. `seed` is fixed so the state matches the web harness.
    func startLocalDemo(playerCount: Int = 2, seed: UInt32 = 0xBADCAFE) {
        demoActive = true
        demoTick = 0
        for i in 1...max(1, playerCount) {
            seedPlayer(peerIndex: i, playerName: "Demo \(i)", colorSlot: max(0, nextColorSlot()))
        }
        demoSeedOverride = seed   // deterministic seed, applied inside beginCountdown
        beginCountdown()
    }

    /// Populate the lobby from the canonical roster + JOIN fixtures (no relay) so
    /// the lobby UI — filled player cards, colors, levels, host tint, join card —
    /// can be exercised/screenshotted. Shared by the HEXLOBBY dev mode and the
    /// gallery `lobby` shot.
    func startLobbyDemo(playerCount: Int = 3) {
        showGalleryLobby(players: max(1, min(playerCount, EngineConstants.maxPlayers)))
    }

    // MARK: - Transition tour (HEXTOUR)

    /// Arm the self-play driver for a match the tour starts through the
    /// production remoteStartMatch (startLocalDemo bundles this with its own
    /// beginCountdown, which would skip the lobby exit under review).
    func tourEnableSelfPlay() {
        demoActive = true
        demoTick = 0
    }

    /// Force the running match to its REAL end: hard-drop every player but the
    /// first until the engine reports game over, so the next tick dispatches
    /// the production gameEnd path (results screen, the room state = .results).
    /// Faking the results screen from fixtures instead would leave the room state
    /// mid-match and dead-end the tour's PLAY AGAIN. Bounded, and a no-op
    /// outside .playing (a call landing in the countdown would inject input
    /// into a not-yet-started game).
    func tourForceMatchEnd() {
        let order = participants
        guard state == .playing, let engine, order.count > 1 else { return }
        let victims = order.dropFirst()
        for _ in 0..<400 where !engine.isEnded {
            for id in victims { engine.processInput(playerId: id, action: "hard_drop") }
        }
    }

    /// Synthetic input for the self-playing demo, driven from tick().
    internal func driveDemoInput() {
        demoTick += 1
        let actions = ["left", "right", "rotate_cw", "right", "rotate_cw", "left"]
        for (i, id) in participants.enumerated() {
            let phase = demoTick + i * 5
            if phase % 7 == 0 { engine?.processInput(playerId: id, action: actions[(phase / 7) % actions.count]) }
            if phase % 24 == 0 { engine?.processInput(playerId: id, action: "hard_drop") }
        }
        if engine?.isEnded == true { /* will transition to results next tick */ }
    }

    // MARK: - Screenshot capture (gallery)

    /// Render one display state, frozen, from the canonical cross-platform
    /// GalleryFixtures data (the SAME roster / board snapshots / results the web
    /// and Android TV galleries render, so a difference between gallery columns is
    /// always a renderer difference). No relay, no live tick: the caller stops
    /// ticking the coordinator so the state holds still for a capture. HEXPLAYERS
    /// drives the roster-based states; the named board variants (game-2p/3p/4p/8p)
    /// fix their own player count.
    func renderShot(_ state: String, playerCount: Int = 4) {
        switch state {
        case "lobby":
            showGalleryLobby(players: max(1, min(playerCount, EngineConstants.maxPlayers)))
        case "lobby-long":
            showGalleryLobby(players: max(1, min(playerCount, EngineConstants.maxPlayers)), longNames: true)
        case "lobby-empty":
            showGalleryLobby(players: 0)
        case "countdown":
            showGalleryCountdown(players: max(1, min(playerCount, EngineConstants.maxPlayers)))
        case "game", "game-lv1":
            showGalleryGame(variant: "lv1")
        case "game-lv8":
            showGalleryGame(variant: "lv8")
        case "game-lv12":
            showGalleryGame(variant: "lv12")
        case "game-2p":
            showGalleryGame(variant: "2p")
        case "game-3p":
            showGalleryGame(variant: "3p")
        case "game-4p":
            showGalleryGame(variant: "4p")
        case "game-8p":
            showGalleryGame(variant: "8p")
        case "pause":
            showGalleryGame(variant: "lv1")
            output?.setPaused(true)
        case "disconnected", "disconnected-controller":
            showGalleryGame(variant: "lv1")
            // Per-board rejoin QR for slot 1 (== id 1), encoding JOIN.qrText plus
            // the production ?claim=<peerIndex> param (mirrors showDisconnectQR).
            if let join = try? galleryFixtures()?.galleryJoin() {
                output?.setDisconnected(playerId: 1, joinURL: galleryRejoinURL(join.qrText, claim: 1))
            }
        case "results":
            showGalleryResults(count: max(1, min(playerCount, EngineConstants.maxPlayers)))
        case "results-solo":
            showGalleryResults(count: 1)
        default:
            showGalleryLobby(players: max(1, min(playerCount, EngineConstants.maxPlayers)))
        }
    }

    // MARK: - Gallery fixture rendering

    private func galleryFixtures() -> EngineBridge? { fixtureBridge }

    /// Seed the room roster from `roster(count)` (id == slot == colorIndex) so
    /// board / card lookups resolve the canonical names, colors and levels. Returns
    /// the fixture entries (the levels feed the pre-game countdown boards).
    /// `longNames` swaps in the 16-char LONG_NAMES fixture (lobby-long shot).
    @discardableResult
    private func seedGalleryRoster(count: Int, longNames: Bool = false) -> [GalleryRosterEntry] {
        guard let roster = try? galleryFixtures()?.galleryRoster(count: count, longNames: longNames) else { return [] }
        for e in roster {
            seedPlayer(peerIndex: e.id, playerName: e.name, colorSlot: e.slot, startLevel: e.level)
        }
        return roster
    }

    /// Show the lobby with the JOIN fixture: displayed host/code from JOIN.host +
    /// JOIN.code, QR from the (separate) JOIN.qrText, `players` roster cards.
    private func showGalleryLobby(players: Int, longNames: Bool = false) {
        guard let join = try? galleryFixtures()?.galleryJoin() else { return }
        if players > 0 { seedGalleryRoster(count: players, longNames: longNames) }
        // Reconstruct a URL splitJoinURL parses back to (JOIN.host, JOIN.code) for
        // the displayed text; the QR encodes the distinct JOIN.qrText.
        output?.roomReady(room: join.code, joinURL: "https://\(join.host)\(join.code)", qrText: join.qrText)
        // Freeze the ambient background to the shared fixture (after roomReady's
        // buildLobby seeds the live pool) so the lobby columns match across platforms.
        if let ambient = try? galleryFixtures()?.galleryAmbient() {
            output?.setLobbyAmbient(ambient)
        }
        output?.showScreen(.lobby)
    }

    /// The pre-game 3-2-1 presentation: empty wells behind the countdown overlay,
    /// carrying the roster's names/colors/levels. Empty boards aren't fixture data
    /// (the fixture game snapshots hold dropped stacks), so build them here.
    private func showGalleryCountdown(players: Int) {
        let roster = seedGalleryRoster(count: players)
        let boards = roster.map { emptyBoard(id: $0.id, level: $0.level) }
        output?.showScreen(.game)
        output?.renderSnapshot(GameSnapshot(players: boards, elapsed: 0))
        // Freeze at "3" — the first number of the sequence, matching the web
        // harness's initial frame and the Android countdown shot.
        output?.showCountdown(.number(3))
    }

    /// Render a named board-variant snapshot, seating the roster names/colors first.
    private func showGalleryGame(variant: String) {
        guard let snap = try? galleryFixtures()?.gallerySnapshot(variant: variant) else { return }
        seedGalleryRoster(count: snap.players.count)
        output?.showScreen(.game)
        output?.renderSnapshot(snap)
    }

    /// The results overlay over the frozen (blurred) boards, exactly as a live
    /// end-of-match: `count` lv1-equivalent boards behind, ranked by results(count).
    private func showGalleryResults(count: Int) {
        guard let fx = galleryFixtures() else { return }
        if let snap = try? fx.gallerySnapshot(players: count, level: 1) {
            seedGalleryRoster(count: snap.players.count)
            output?.showScreen(.game)
            output?.renderSnapshot(snap)
        }
        guard let bundle = try? fx.galleryResults(count: count) else { return }
        let out = bundle.results.map { r in
            MatchResult(playerId: r.playerId, playerName: r.playerName, colorIndex: r.colorIndex,
                        rank: r.rank, lines: r.lines, level: r.level)
        }
        output?.showResults(out)
        output?.showScreen(.results)
    }

    private func emptyBoard(id: Int, level: Int) -> PlayerSnapshot {
        let grid = Array(repeating: Array(repeating: 0, count: EngineConstants.cols),
                         count: EngineConstants.visibleRows)
        return PlayerSnapshot(id: id, grid: grid, currentPiece: nil, ghost: nil, holdPiece: nil,
                              nextPieces: [], level: level, lines: 0, alive: true,
                              pendingGarbage: 0, clearingCells: nil, gridVersion: 1)
    }

    /// The cross-device rejoin URL a dropped board's QR encodes: `base` (JOIN.qrText)
    /// with the production `?claim=<peerIndex>` spliced in before any fragment
    /// (mirrors the web showDisconnectQR).
    private func galleryRejoinURL(_ base: String, claim: Int) -> String {
        let head: Substring, hash: Substring
        if let h = base.firstIndex(of: "#") { head = base[..<h]; hash = base[h...] }
        else { head = Substring(base); hash = "" }
        let sep = head.contains("?") ? "&" : "?"
        return "\(head)\(sep)claim=\(claim)\(hash)"
    }
}
