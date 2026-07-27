import Foundation

/// Reader for the packed native wire format — a port of `PartyCore.unpackFrame`
/// (server/PartyCore.js), which is the reference implementation. Both are gated
/// against `tests/fixtures/partycore-packed-golden.json`, so a layout change that
/// lands on only one side fails the build instead of the TV.
///
/// Why this exists: the JS/native boundary, not the simulation, is what costs a
/// frame. At eight boards the physics is ~0.5 ms while `JSON.stringify` plus the
/// native decode is several milliseconds — most of it rebuilding objects the
/// renderer flattens again immediately. Every snapshot field is a small integer,
/// so the payload crosses as one integer per UTF-16 code unit instead.
///
/// Every value is biased +1 on the wire: both bridges hand JS strings over as C
/// strings, so a NUL code unit would truncate the payload — and 0 is the most
/// common raw value here (every empty grid cell). That same bias is why values
/// wider than one code unit cross as two FIFTEEN-bit halves rather than sixteen:
/// a raw 0xffff biases to 0x10000, which the packer's `fromCharCode` wraps back
/// to the very NUL the bias exists to avoid. Coordinates are biased by
/// `coordBias` on top of that, because a piece still in the spawn buffer has a
/// negative row.
enum PackedFrame {

    static let packVersion = 2
    private static let coordBias = 256
    private static let splitShift = 15

    struct PackedError: Error, CustomStringConvertible {
        let reason: String
        var description: String { "packed frame: \(reason)" }
    }

    /// `{events, commands}` stays JSON: both are small, rare and genuinely
    /// heterogeneous, so packing them would buy nothing and cost clarity.
    private struct Tail: Decodable {
        let events: [GameEvent]
        let commands: [HostCommand]
    }

    /// Decode a packed frame. `snapshot` is nil when the frame was render-identical
    /// to the last delivered one (PartyCore omits it). Grid stripping is undone
    /// from `gridCache`, exactly as `FrameParsing` does for the JSON path.
    static func frameResult(_ packed: String, gridCache: inout [Int: [[Int]]]) throws -> FrameResult {
        // One pass to UTF-16 units: `String` indexing is O(n) per access, so
        // walking the payload through it directly would be quadratic.
        let units = Array(packed.utf16)
        var at = 0
        func next() throws -> Int {
            guard at < units.count else { throw PackedError(reason: "payload ended early") }
            defer { at += 1 }
            return Int(units[at]) - 1
        }

        let version = try next()
        guard version == packVersion else {
            throw PackedError(reason: "layout version \(version), expected \(packVersion)")
        }

        var snapshot: GameSnapshot?
        if try next() == 1 {
            let count = try readSplit(next: next)
            let bodyStart = at
            snapshot = try readSnapshot(next: next, gridCache: &gridCache)
            // Landing anywhere but the tail means this reader and the packer have
            // drifted; trusting `count` instead would surface later as a confusing
            // JSON error from the tail.
            guard at == bodyStart + count else {
                throw PackedError(reason: "body read \(at - bodyStart) of \(count) values")
            }
        }

        let tailUnits = units[at...]
        guard let tailText = String(utf16CodeUnits: Array(tailUnits), count: tailUnits.count)
            .data(using: .utf8) else {
            throw PackedError(reason: "tail is not encodable")
        }
        let tail = try JSONDecoder().decode(Tail.self, from: tailText)
        return FrameResult(events: tail.events, snapshot: snapshot, commands: tail.commands)
    }

    // MARK: - Body

    /// Reassemble a value the packer split into two 15-bit halves, high first.
    private static func readSplit(next: () throws -> Int) throws -> Int {
        let hi = try next()
        return try (hi << splitShift) | next()
    }

    private static func readSnapshot(next: () throws -> Int,
                                     gridCache: inout [Int: [[Int]]]) throws -> GameSnapshot {
        let elapsed = Double(try readSplit(next: next))
        let count = try next()
        var players: [PlayerSnapshot] = []
        players.reserveCapacity(count)
        for _ in 0..<count { players.append(try readPlayer(next: next, gridCache: &gridCache)) }
        return GameSnapshot(players: players, elapsed: elapsed)
    }

    private static func readPlayer(next: () throws -> Int,
                                   gridCache: inout [Int: [[Int]]]) throws -> PlayerSnapshot {
        let id = try next()
        let level = try next()
        let lines = try readSplit(next: next)
        let alive = try next() == 1
        let pendingGarbage = try next()
        let gridVersion = try readSplit(next: next)

        let playerGrid: [[Int]]
        if try next() == 1 {
            let rows = try next()
            let cols = try next()
            var g: [[Int]] = []
            g.reserveCapacity(rows)
            for _ in 0..<rows {
                var row: [Int] = []
                row.reserveCapacity(cols)
                for _ in 0..<cols { row.append(try next()) }
                g.append(row)
            }
            gridCache[id] = g
            playerGrid = g
        } else if let cached = gridCache[id] {
            playerGrid = cached   // stripped: unchanged since the last full send
        } else {
            throw PackedError(reason: "stripped grid with no cached rows for id \(id)")
        }

        var piece: PieceSnapshot?
        if try next() == 1 {
            let typeId = try next()
            let anchorCol = try next() - coordBias
            let anchorRow = try next() - coordBias
            let cellCount = try next()
            var cells: [Axial] = []
            cells.reserveCapacity(cellCount)
            for _ in 0..<cellCount {
                let q = try next() - coordBias
                let r = try next() - coordBias
                cells.append(Axial(q: q, r: r))
            }
            piece = PieceSnapshot(
                type: try pieceType(typeId),
                typeId: typeId,
                anchorCol: anchorCol,
                anchorRow: anchorRow,
                cells: cells,
                blocks: try readCells(next: next))
        }

        var ghost: GhostSnapshot?
        if try next() == 1 {
            // The wire carries the ghost's typeId for hosts that colour from it;
            // this model deliberately doesn't store it (it always equals the
            // current piece's), so read past it.
            _ = try next()
            let anchorCol = try next() - coordBias
            let anchorRow = try next() - coordBias
            ghost = GhostSnapshot(anchorCol: anchorCol, anchorRow: anchorRow,
                                  blocks: try readCells(next: next))
        }

        let hold = try next()
        let nextCount = try next()
        var nextPieces: [String] = []
        nextPieces.reserveCapacity(nextCount)
        for _ in 0..<nextCount { nextPieces.append(try pieceType(next())) }
        let clearing = try next() == 1 ? try readCells(next: next) : nil

        return PlayerSnapshot(
            id: id,
            grid: playerGrid,
            currentPiece: piece,
            ghost: ghost,
            holdPiece: hold == 0 ? nil : try pieceType(hold),
            nextPieces: nextPieces,
            level: level,
            lines: lines,
            alive: alive,
            pendingGarbage: pendingGarbage,
            clearingCells: clearing,
            gridVersion: gridVersion)
    }

    private static func readCells(next: () throws -> Int) throws -> [Cell] {
        let count = try next()
        var out: [Cell] = []
        out.reserveCapacity(count)
        for _ in 0..<count {
            let col = try next() - coordBias
            let row = try next() - coordBias
            out.append(Cell(col: col, row: row))
        }
        return out
    }

    /// constants.js PIECE_TYPES, indexed by typeId-1. Mirrored (not derived), like
    /// the other constants this kit pins — see ParityTests.
    private static let pieceTypes = ["I3", "V3", "T3", "o", "d", "b"]

    private static func pieceType(_ typeId: Int) throws -> String {
        guard typeId >= 1, typeId <= pieceTypes.count else {
            throw PackedError(reason: "piece typeId \(typeId) out of range")
        }
        return pieceTypes[typeId - 1]
    }
}
