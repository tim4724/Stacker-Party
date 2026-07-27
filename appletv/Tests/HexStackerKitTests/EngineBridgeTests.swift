import Testing
import Foundation
@testable import HexStackerKit

/// These tests run the REAL canonical engine (../../server/*.js) through the
/// Swift/JavaScriptCore bridge. They prove the port's central assumption: the
/// existing JS engine drives correctly from Swift and is deterministic, so the
/// tvOS display can reuse it verbatim instead of reimplementing game rules.
///
/// Uses swift-testing (`import Testing`) so it runs under `swift test` with only
/// Command Line Tools installed (no full Xcode / XCTest required).
@Suite struct EngineBridgeTests {

    private func makeBridge() throws -> EngineBridge {
        // EngineFixture builds the canonical bundle once per run (see TestSupport).
        let dir = EngineFixture.coreBundleDir
        let bundle = dir.appendingPathComponent(EngineBridge.coreBundleFile)
        #expect(FileManager.default.fileExists(atPath: bundle.path),
                "core bundle not found at \(bundle.path)")
        return try EngineBridge(engineDirectory: dir)
    }

    @Test func engineLoadsAndSpawnsPieces() throws {
        let engine = try makeBridge()
        try engine.createGame(players: [(id: 0, startLevel: 1), (id: 1, startLevel: 1)], seed: 0xC0FFEE)
        let snap = try engine.snapshot()

        #expect(snap.players.count == 2)
        #expect(snap.players.map { $0.id } == [0, 1])
        for p in snap.players {
            #expect(p.grid.count == EngineConstants.visibleRows)   // 15 rows
            #expect(p.grid[0].count == EngineConstants.cols)       // 9 cols
            #expect(p.alive)
            #expect(p.level == 1)
            #expect(p.lines == 0)
            #expect(p.currentPiece != nil)   // init() spawns a piece
            #expect(p.ghost != nil)
            #expect(p.nextPieces.count == 3)
            #expect(p.holdPiece == nil)
        }
    }

    @Test func pieceTypesAndBlocksAreValid() throws {
        let engine = try makeBridge()
        try engine.createGame(players: [(id: 0, startLevel: 1)], seed: 42)
        let p = try engine.snapshot().players[0]

        let piece = try #require(p.currentPiece)
        #expect(EngineConstants.pieceTypes.contains(piece.type))
        #expect(EngineConstants.pieceTypeToId[piece.type] == piece.typeId)
        #expect((3...4).contains(piece.blocks.count))   // tromino or tetromino
        #expect(piece.blocks.count == piece.cells.count)
        for next in p.nextPieces {
            #expect(EngineConstants.pieceTypes.contains(next))
        }
    }

    @Test func hardDropEmitsLockAndMutatesGrid() throws {
        let engine = try makeBridge()
        try engine.createGame(players: [(id: 0, startLevel: 1)], seed: 7)
        _ = try engine.drainEvents()   // clear spawn-time events

        engine.processInput(playerId: 0, action: "hard_drop")
        let events = try engine.drainEvents()

        let lock = try #require(events.first { $0.type == "piece_lock" })
        #expect(lock.playerId == 0)
        #expect((1...6).contains(lock.typeId ?? -1))
        #expect(!(lock.blocks ?? []).isEmpty)

        let filled = try engine.snapshot().players[0].grid.flatMap { $0 }.filter { $0 != 0 }
        #expect(!filled.isEmpty)   // locked piece left cells on the board
        for v in filled {
            #expect((1...6).contains(v) || v == EngineConstants.garbageCell)
        }
    }

    /// The native integration surface: `frame(nowMs)` ticks the engine on a
    /// capped delta, returns this frame's raw events + value-copy snapshot, and
    /// normalizes the host effects into a `commands` list. Mirrors the contract
    /// in server/PartyCore.d.ts.
    @Test func frameDrivesEngineAndNormalizesCommands() throws {
        let engine = try makeBridge()
        try engine.createGame(players: [(id: 0, startLevel: 1)], seed: 7)

        // First frame primes the clock (deltaMs = 0): the engine does not advance.
        let primed = try #require(try engine.frame(nowMs: 1000).snapshot)
        #expect(primed.players.count == 1)
        #expect(primed.elapsed == 0)

        // A hard drop then a frame surfaces both the raw piece_lock event and the
        // normalized pieceLock command from the same pull, carrying equal data.
        engine.processInput(playerId: 0, action: "hard_drop")
        let f = try engine.frame(nowMs: 1016)
        let moved = try #require(f.snapshot)
        #expect(moved.elapsed > 0)   // the capped delta advanced the clock

        let lockEvent = try #require(f.events.first { $0.type == "piece_lock" })
        let lockCmd = try #require(f.commands.first { $0.type == "pieceLock" })
        #expect(lockCmd.playerId == lockEvent.playerId)
        #expect(lockCmd.typeId == lockEvent.typeId)
        #expect(lockCmd.blocks == lockEvent.blocks)

        // resetFrameClock re-primes: a large nowMs jump is absorbed as a 0-delta
        // priming frame instead of a catch-up tick. Nothing advanced, so that
        // frame is render-identical and arrives without a snapshot — the clock is
        // read back through the out-of-band pull, which always returns one.
        let elapsedBefore = moved.elapsed
        engine.resetFrameClock()
        #expect(try engine.frame(nowMs: 5000).snapshot == nil)
        #expect(try engine.snapshot().elapsed == elapsedBefore)
    }

    /// PartyCore delivers a snapshot only when the frame would look different
    /// (`deliverFrame` / `sceneSig`), so an idle 60 Hz tick costs no serialize,
    /// no decode and no repaint. Events and commands are never filtered.
    @Test func renderIdenticalFrameArrivesWithoutASnapshot() throws {
        let engine = try makeBridge()
        try engine.createGame(players: [(id: 0, startLevel: 1)], seed: 7)

        #expect(try engine.frame(nowMs: 0).snapshot != nil)   // opening scene
        #expect(try engine.frame(nowMs: 1).snapshot == nil)   // 1ms later: nothing moved

        engine.processInput(playerId: 0, action: "hard_drop")
        #expect(try engine.frame(nowMs: 17).snapshot != nil)  // the board changed
    }

    /// PartyCore strips a player's `grid` from the delivered frame()/snapshot()
    /// payloads while its gridVersion is unchanged, and the bridge re-attaches the
    /// cached rows: consumers must see a full, CURRENT grid on every pull
    /// regardless of how the strip/resend cycle interleaves.
    @Test func gridSurvivesStripAndResendCycle() throws {
        let engine = try makeBridge()
        try engine.createGame(players: [(id: 0, startLevel: 1)], seed: 7)

        let first = try engine.snapshot().players[0]        // fresh ledger: full grid
        let second = try engine.snapshot().players[0]       // unchanged version: stripped + rehydrated
        #expect(second.gridVersion == first.gridVersion)
        #expect(second.grid == first.grid)

        engine.processInput(playerId: 0, action: "hard_drop")
        // Version bumped, so this frame is delivered and re-sends the grid.
        let locked = try #require(try engine.frame(nowMs: 16).snapshot).players[0]
        #expect(locked.gridVersion != first.gridVersion)
        #expect(locked.grid != first.grid, "the locked piece must land in the re-sent grid")
        #expect(!locked.grid.flatMap { $0 }.filter { $0 != 0 }.isEmpty)

        let after = try engine.snapshot().players[0]    // stripped again: cache is current
        #expect(after.grid == locked.grid)
    }

    @Test func holdStoresPiece() throws {
        let engine = try makeBridge()
        try engine.createGame(players: [(id: 0, startLevel: 1)], seed: 99)
        let before = try #require(try engine.snapshot().players[0].currentPiece)

        engine.processInput(playerId: 0, action: "hold")
        let held = try engine.snapshot().players[0].holdPiece
        #expect(held == before.type)   // hold stashes the active piece type
    }

    /// The crux: identical seed + identical input/timestep schedule on two
    /// independent engines must yield byte-identical state, end to end.
    @Test func determinismAcrossTwoEngines() throws {
        func run() throws -> (GameSnapshot, [GameEvent]) {
            let engine = try makeBridge()
            try engine.createGame(players: [(id: 0, startLevel: 1), (id: 1, startLevel: 1)], seed: 0xBADCAFE)
            var collected: [GameEvent] = []
            let dt = 1000.0 / 60.0
            for i in 0..<1500 {
                // Deterministic, frame-indexed input schedule (no wall clock).
                if i % 7 == 0 { engine.processInput(playerId: 0, action: "rotate_cw") }
                if i % 11 == 0 { engine.processInput(playerId: 0, action: "left") }
                if i % 13 == 0 { engine.processInput(playerId: 1, action: "right") }
                if i % 17 == 0 { engine.processInput(playerId: 1, action: "rotate_cw") }
                if i % 23 == 0 { engine.processInput(playerId: 0, action: "hard_drop") }
                if i % 29 == 0 { engine.processInput(playerId: 1, action: "hard_drop") }
                if i % 19 == 0 { engine.processInput(playerId: 0, action: "hold") }
                engine.update(deltaMs: dt)
                collected.append(contentsOf: try engine.drainEvents())
                if engine.isEnded { break }
            }
            return (try engine.snapshot(), collected)
        }

        let (snapA, eventsA) = try run()
        let (snapB, eventsB) = try run()

        #expect(snapA == snapB)       // snapshots identical for same seed+inputs
        #expect(eventsA == eventsB)   // event streams identical too
        #expect(!eventsA.isEmpty)     // the scripted run produced events
    }

    @Test func differentSeedsDiverge() throws {
        func finalSnapshot(seed: UInt32) throws -> GameSnapshot {
            let engine = try makeBridge()
            try engine.createGame(players: [(id: 0, startLevel: 1)], seed: seed)
            for _ in 0..<300 { engine.update(deltaMs: 1000.0 / 60.0) }
            return try engine.snapshot()
        }
        let a = try finalSnapshot(seed: 1)
        let b = try finalSnapshot(seed: 2)
        #expect(a.players[0].nextPieces != b.players[0].nextPieces)
    }

    /// The pre-game projection used during the 3-2-1 countdown: empty wells, no
    /// spawn piece / ghost / hold / next queue, but level + lines still shown
    /// (matches the web, which draws empty boards until play begins).
    @Test func preGameProjectionStripsPiecesButKeepsStats() throws {
        let engine = try makeBridge()
        try engine.createGame(players: [(id: 0, startLevel: 3), (id: 1, startLevel: 3)], seed: 0xC0FFEE)
        let live = try engine.snapshot()
        // Sanity: a freshly-spawned board HAS a piece, a ghost, and a next queue.
        #expect(live.players[0].currentPiece != nil)
        #expect(live.players[0].ghost != nil)
        #expect(!live.players[0].nextPieces.isEmpty)

        let pre = live.preGame()
        #expect(pre.players.count == live.players.count)
        for (i, p) in pre.players.enumerated() {
            #expect(p.currentPiece == nil, "pre-game hides the spawn piece")
            #expect(p.ghost == nil, "pre-game hides the ghost")
            #expect(p.holdPiece == nil)
            #expect(p.nextPieces.isEmpty, "pre-game hides the next queue")
            #expect(p.pendingGarbage == 0)
            // Identity + stats are preserved (level/lines still show during countdown).
            #expect(p.id == live.players[i].id)
            #expect(p.level == live.players[i].level)
            #expect(p.lines == live.players[i].lines)
        }
    }
}
