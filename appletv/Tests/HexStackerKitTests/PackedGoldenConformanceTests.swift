import Testing
import Foundation
@testable import HexStackerKit

/// Gates `PackedFrame` against the fixture recorded by the JS reference decoder
/// (`tests/partycore-packed.test.js` -> `tests/fixtures/partycore-packed-golden.json`),
/// which is the same fixture Android's `PackedFrameTest` replays.
///
/// Both readers being gated on ONE fixture is the whole point: a layout change that
/// lands in `PartyCore.js` and only one of the two ports fails a build instead of
/// silently mis-rendering a board on a TV. Without this file that guarantee only
/// held for Android.
struct PackedGoldenConformanceTests {

    /// The fixture's `frame.snapshot.players[]` shape. Deliberately NOT
    /// `PlayerSnapshot`: the fixture omits `grid` on a stripped player, which the
    /// non-optional `grid` on the real model cannot represent.
    private struct GoldenPlayer: Decodable {
        let id: Int
        let grid: [[Int]]?
        let currentPiece: PieceSnapshot?
        let ghost: GoldenGhost?
        let holdPiece: String?
        let nextPieces: [String]
        let level: Int
        let lines: Int
        let alive: Bool
        let pendingGarbage: Int
        let clearingCells: [Cell]?
        let gridVersion: Int
    }

    /// The wire carries the ghost's typeId; this kit's `GhostSnapshot` deliberately
    /// does not store it (it always equals the current piece's), so read past it.
    private struct GoldenGhost: Decodable {
        let anchorCol: Int
        let anchorRow: Int
        let blocks: [Cell]
    }

    private struct GoldenFrame: Decodable {
        let events: [GameEvent]
        let commands: [HostCommand]
        let snapshot: GoldenSnapshot?
    }

    private struct GoldenSnapshot: Decodable {
        let players: [GoldenPlayer]
        let elapsed: Double
    }

    private struct GoldenStep: Decodable {
        let packed: String
        let frame: GoldenFrame
    }

    private struct Golden: Decodable {
        let version: Int
        let steps: [GoldenStep]
    }

    private func loadGolden() throws -> Golden {
        let url = EngineFixture.packedGolden
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw PackedGoldenError("Missing \(url.path) — record it with `npm test` (partycore-packed.test.js)")
        }
        return try JSONDecoder().decode(Golden.self, from: try Data(contentsOf: url))
    }

    private struct PackedGoldenError: Error, CustomStringConvertible {
        let description: String
        init(_ d: String) { description = d }
    }

    @Test func decodesEveryGoldenStepExactly() throws {
        let golden = try loadGolden()
        #expect(golden.version == PackedFrame.packVersion,
                "fixture was recorded for layout v\(golden.version), reader is v\(PackedFrame.packVersion)")
        #expect(golden.steps.count > 10, "fixture is too small to be meaningful: \(golden.steps.count) steps")

        // The reader substitutes cached rows for stripped grids as it reads, so the
        // replay is stateful and the EXPECTATION tracks the same rows. That is extra
        // coverage, not a workaround: it gates re-attachment too.
        var gridCache: [Int: [[Int]]] = [:]
        var expectedGrids: [Int: [[Int]]] = [:]
        var withSnapshot = 0, withGrid = 0, withStrippedGrid = 0, withEvents = 0

        for (i, step) in golden.steps.enumerated() {
            let actual = try PackedFrame.frameResult(step.packed, gridCache: &gridCache)

            // events / commands ride as JSON and must survive verbatim: compare
            // whole decoded values against the fixture's, so a dropped or mangled
            // field fails, not just a lost element.
            #expect(actual.events == step.frame.events, "step \(i): events")
            #expect(actual.commands == step.frame.commands, "step \(i): commands")
            if !actual.events.isEmpty { withEvents += 1 }

            guard let wantSnap = step.frame.snapshot else {
                #expect(actual.snapshot == nil, "step \(i): snapshot must be omitted")
                continue
            }
            withSnapshot += 1
            let got = try #require(actual.snapshot, "step \(i): snapshot missing")
            #expect(got.elapsed == wantSnap.elapsed, "step \(i): elapsed")
            #expect(got.players.count == wantSnap.players.count, "step \(i): player count")

            for (j, wp) in wantSnap.players.enumerated() {
                let gp = got.players[j]
                let wantGrid: [[Int]]
                if let g = wp.grid {
                    expectedGrids[wp.id] = g
                    wantGrid = g
                    withGrid += 1
                } else {
                    withStrippedGrid += 1
                    wantGrid = try #require(expectedGrids[wp.id],
                                            "step \(i): fixture stripped player \(wp.id)'s grid before ever sending it")
                }
                // Compare the whole player at once: every field matters to the
                // renderer, and a per-field list here would rot as fields are added.
                #expect(gp == PlayerSnapshot(
                    id: wp.id, grid: wantGrid, currentPiece: wp.currentPiece,
                    ghost: wp.ghost.map { GhostSnapshot(anchorCol: $0.anchorCol, anchorRow: $0.anchorRow, blocks: $0.blocks) },
                    holdPiece: wp.holdPiece, nextPieces: wp.nextPieces, level: wp.level,
                    lines: wp.lines, alive: wp.alive, pendingGarbage: wp.pendingGarbage,
                    clearingCells: wp.clearingCells, gridVersion: wp.gridVersion),
                    "step \(i): player \(j) (id \(wp.id)) decoded differently")
            }
        }

        // A green run against a fixture that never exercised the interesting paths
        // would prove nothing.
        #expect(withSnapshot > 0, "fixture never carried a snapshot")
        #expect(withGrid > 0, "fixture never carried a grid")
        #expect(withStrippedGrid > 0, "fixture never stripped a grid, so re-attachment went untested")
        #expect(withEvents > 0, "fixture never carried events")
    }

    @Test func rejectsAForeignLayoutVersion() throws {
        let golden = try loadGolden()
        let packed = try #require(golden.steps.first).packed
        // Bump the version code unit; every value is +1 biased on the wire.
        let bumped = String(UnicodeScalar(UInt8(PackedFrame.packVersion + 42))) + packed.dropFirst()
        var cache: [Int: [[Int]]] = [:]
        #expect(throws: (any Error).self, "a foreign layout version must fail loudly, not be misread") {
            _ = try PackedFrame.frameResult(bumped, gridCache: &cache)
        }
    }
}
