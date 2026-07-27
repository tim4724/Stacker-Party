import Foundation

// Codable mirror of the canonical engine's data contract (server/Game.js,
// server/PlayerBoard.js). Field names match the JS object keys EXACTLY so the
// snapshot JSON produced by `JSON.stringify(game.getSnapshot())` decodes
// directly. Coordinate convention: a board "block"/"cell" is the 2-element JSON
// array `[col, row]` == `[x, y]`. Internal piece `cells` are `{q, r}` axial
// offsets (a different shape, see `Axial`).

/// A board position decoded from a 2-element `[col, row]` JSON array.
public struct Cell: Decodable, Equatable, Hashable {
    public let col: Int
    public let row: Int

    public init(col: Int, row: Int) {
        self.col = col
        self.row = row
    }

    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        col = try c.decode(Int.self)   // index 0 = col / x
        row = try c.decode(Int.self)   // index 1 = row / y
    }

    public var x: Int { col }
    public var y: Int { row }
}

/// Axial hex offset (`{q, r}`) used by `currentPiece.cells`. Not the same as
/// `Cell`; only needed if rendering from `cells` rather than `blocks`.
public struct Axial: Decodable, Equatable, Hashable {
    public let q: Int
    public let r: Int
}

public struct PieceSnapshot: Decodable, Equatable {
    public let type: String        // "I3","V3","T3","o","d","b"
    public let typeId: Int         // 1...6, also the value used in `grid`
    public let anchorCol: Int
    public let anchorRow: Int      // visible coords; CAN be negative (buffer)
    public let cells: [Axial]
    public let blocks: [Cell]      // absolute visible-coord cells to render
}

public struct GhostSnapshot: Decodable, Equatable {
    public let anchorCol: Int
    public let anchorRow: Int
    public let blocks: [Cell]      // use the current piece's typeId for color
}

public struct PlayerSnapshot: Decodable, Equatable {
    public let id: Int
    public let grid: [[Int]]       // 15 rows x 9 cols, grid[row][col], top->bottom
    public let currentPiece: PieceSnapshot?   // nil during line-clear / after death
    public let ghost: GhostSnapshot?
    public let holdPiece: String?  // piece-type name string, or nil
    public let nextPieces: [String]            // next 3 piece-type names
    public let level: Int
    public let lines: Int
    public let alive: Bool
    public let pendingGarbage: Int             // total incoming garbage lines
    public let clearingCells: [Cell]?          // cells mid clear-animation, or nil
    public let gridVersion: Int                // dirty-flag for cached grid render
}

public struct GameSnapshot: Decodable, Equatable {
    public let players: [PlayerSnapshot]       // constructor / join order
    public let elapsed: Double                 // ms
}

// MARK: - Pre-game (countdown) projection

public extension PlayerSnapshot {
    /// A pre-game copy showing only the empty well: strips the spawn piece, ghost,
    /// hold, and next queue so the 3-2-1 countdown renders bare boards (matching the
    /// web, which draws empty boards until play begins). The renderer already skips
    /// these when nil/empty, so no renderer change is needed.
    func preGame() -> PlayerSnapshot {
        PlayerSnapshot(id: id, grid: grid, currentPiece: nil, ghost: nil,
                       holdPiece: nil, nextPieces: [], level: level, lines: lines,
                       alive: alive, pendingGarbage: 0, clearingCells: nil,
                       gridVersion: gridVersion)
    }
}

public extension GameSnapshot {
    /// Per-player `preGame()` — bare boards for the pre-game countdown.
    func preGame() -> GameSnapshot {
        GameSnapshot(players: players.map { $0.preGame() }, elapsed: elapsed)
    }
}

/// The shared visual-parity fixture: a single board with one known piece color
/// per column on the bottom row. Both the web harness (scripts/parity) and the
/// native HEXSNAP render draw this exact state so their pixels can be compared.
public enum VisualParityFixture {
    public static let cellSize = 40.0
    /// (col, typeId) on the bottom visible row (row 14).
    public static let bottomRow = [1, 2, 3, 4, 5, 6, 9, 1, 2]

    public static func grid() -> [[Int]] {
        var g = Array(repeating: Array(repeating: 0, count: EngineConstants.cols),
                      count: EngineConstants.visibleRows)
        g[EngineConstants.visibleRows - 1] = bottomRow
        return g
    }

    public static func snapshot() -> PlayerSnapshot {
        // Uses the synthesized memberwise init (internal, same module).
        PlayerSnapshot(id: 0, grid: grid(), currentPiece: nil, ghost: nil, holdPiece: nil,
                       nextPieces: [], level: 1, lines: 0, alive: true, pendingGarbage: 0,
                       clearingCells: nil, gridVersion: 1)
    }
}

/// One entry from PartyCore's drained events buffer (the inverted onEvent +
/// onGameEnd push). All non-`type` fields are optional because each event type
/// populates a different subset (see server/Game.js / PartyCore.d.ts).
public struct GameEvent: Decodable, Equatable {
    public let type: String        // piece_lock | line_clear | player_ko | garbage_cancelled | garbage_sent | game_end
    public let playerId: Int?
    public let typeId: Int?        // piece_lock
    public let lines: Int?         // line_clear / garbage_cancelled / garbage_sent
    public let blocks: [Cell]?     // piece_lock
    public let clearCells: [Cell]? // line_clear
    public let rows: [Int]?        // line_clear (always [] in practice)
    public let senderId: Int?      // garbage_sent
    public let toId: Int?          // garbage_sent
}

public struct PlayerResult: Decodable, Equatable {
    public let playerId: Int
    public let alive: Bool
    public let lines: Int
    public let level: Int
    public let rank: Int           // 1-based, pre-sorted

    /// The raw ranking as the room core's `enrichResults` expects it: the room core
    /// labels each row with the roster's name/colour in place and appends the
    /// players who sat the round out.
    public var payload: [String: Any] {
        ["playerId": playerId, "alive": alive, "lines": lines, "level": level, "rank": rank]
    }
}

/// One normalized host-effect command from `PartyCore.frame()`. Like `GameEvent`,
/// every non-`type` field is optional because each command type populates a
/// different subset. The host maps `type` -> MSG / sendTo / animation; see the
/// `HostCommand` union in server/PartyCore.d.ts.
public struct HostCommand: Decodable, Equatable {
    public let type: String        // pieceLock | lineClear | playerState | playerKO | playerEliminated | garbageCancelled | garbageSent | gameEnd
    public let playerId: Int?
    public let senderId: Int?      // garbageSent
    public let toId: Int?          // garbageSent
    public let typeId: Int?        // pieceLock
    public let lines: Int?         // lineClear / playerState / garbageCancelled / garbageSent
    public let blocks: [Cell]?     // pieceLock
    public let clearCells: [Cell]? // lineClear
    public let level: Int?         // playerState (full)
    public let alive: Bool?        // playerState
    public let garbageIncoming: Int?    // playerState (full form)
    public let elapsed: Double?         // gameEnd
    public let results: [PlayerResult]? // gameEnd (raw, pre-enrichment)
}

/// The result of one `PartyCore.frame()` pull: this frame's complete event
/// record, a value-copy snapshot, and the normalized host-effect commands.
public struct FrameResult: Decodable {
    public let events: [GameEvent]
    public let snapshot: GameSnapshot
    public let commands: [HostCommand]
}

// MARK: - Gallery fixtures (server/GalleryFixtures.js)

// Codable mirrors of the canonical screen-gallery fixture shapes. Field names
// match the JS object keys exactly so `JSON.stringify(GalleryFixtures.*)` decodes
// directly. The game-board fixtures reuse `GameSnapshot` (the same value-copy
// player shape PartyCore produces).

/// One lobby card from `GalleryFixtures.roster(count)`. `id == slot == colorIndex`.
public struct GalleryRosterEntry: Decodable, Equatable {
    public let id: Int
    public let slot: Int
    public let name: String
    public let level: Int
}

/// `GalleryFixtures.JOIN`: the displayed host/code and the (separate) QR target.
public struct GalleryJoin: Decodable, Equatable {
    public let host: String     // "hexstacker.com/"
    public let code: String     // "TEST"
    public let qrText: String   // "https://hexstacker.com/TEST12"
}

/// One ranked row from `GalleryFixtures.results(count)`.
public struct GalleryResultEntry: Decodable, Equatable {
    public let playerId: Int
    public let playerName: String
    public let colorIndex: Int
    public let rank: Int
    public let lines: Int
    public let level: Int
}

/// `GalleryFixtures.results(count)`: the finished-match ranking + elapsed time.
public struct GalleryResults: Decodable, Equatable {
    public let elapsed: Double
    public let results: [GalleryResultEntry]
}

/// An axial `(q, r)` offset decoded from a 2-element `[q, r]` JSON array (the
/// shape `ambientPieces()` cells use — distinct from `Axial`'s `{q, r}` object).
public struct AxialCell: Decodable, Equatable {
    public let q: Int
    public let r: Int
    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        q = try c.decode(Int.self)
        r = try c.decode(Int.self)
    }
}

/// One frozen lobby-background piece from `GalleryFixtures.ambientPieces()`. The
/// origin is in a 1920x1080 Y-DOWN reference space (y can spill past the edges);
/// `size` is a hex circumradius; `cells` are engine-rotated axial offsets.
public struct AmbientPiece: Decodable, Equatable {
    public let typeId: Int
    public let cells: [AxialCell]
    public let x: Double
    public let y: Double
    public let size: Double
    public let opacity: Double
}

// MARK: - Engine constants mirrored from server/constants.js

public enum EngineConstants {
    public static let cols = 9
    public static let visibleRows = 15
    public static let bufferRows = 4
    public static let totalRows = 19
    public static let garbageCell = 9
    public static let maxPlayers = 8
    public static let lockDelayMs = 500.0
    public static let lineClearDelayMs = 400.0
    public static let garbageDelayMs = 2000.0
    public static let softDropMultiplier = 20
    public static let maxSpeedLevel = 15
    public static let countdownSeconds = 3

    /// Piece-type name -> cell value / typeId (1...6).
    public static let pieceTypeToId: [String: Int] = [
        "I3": 1, "V3": 2, "T3": 3, "o": 4, "d": 5, "b": 6,
    ]
    public static let pieceTypes = ["I3", "V3", "T3", "o", "d", "b"]
}
