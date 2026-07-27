import Foundation

/// Hand-rolled decoding for the engine's 60 Hz pulls (`frame()` / `snapshot()`).
/// Codable's JSONDecoder walks every field through reflection-driven container
/// machinery, which showed up as the dominant Swift-side cost of the per-frame
/// pull; mapping the JSONSerialization object tree directly is several times
/// cheaper. The cold paths (gallery fixtures, drainEvents) keep Codable.
///
/// Also the re-attachment point for the shim's grid stripping: the JS Bridge
/// omits `grid` for players whose `gridVersion` it already delivered (the
/// dominant payload of the pull), and `player(_:gridCache:)` substitutes the
/// cached rows so every downstream consumer still sees a full GameSnapshot.
enum FrameParsing {

    struct ParseError: Error, CustomStringConvertible {
        let field: String
        var description: String { "missing or invalid field: \(field)" }
    }

    // MARK: - Entry points

    static func frameResult(_ json: Any, gridCache: inout [Int: [[Int]]]) throws -> FrameResult {
        guard let dict = json as? [String: Any] else { throw ParseError(field: "frame") }
        // Absent `snapshot`: the frame was render-identical to the last delivered
        // one, so PartyCore omitted it (deliverFrame). Nothing to decode, and the
        // grid cache stays as it is — the next delivered snapshot strips against
        // exactly what this host last saw.
        let snap = dict["snapshot"]
        return FrameResult(
            events: try (dict["events"] as? [Any] ?? []).map { try event($0) },
            snapshot: snap == nil ? nil : try gameSnapshot(snap!, gridCache: &gridCache),
            commands: try (dict["commands"] as? [Any] ?? []).map { try command($0) })
    }

    static func gameSnapshot(_ json: Any, gridCache: inout [Int: [[Int]]]) throws -> GameSnapshot {
        guard let dict = json as? [String: Any],
              let playersJSON = dict["players"] as? [Any] else { throw ParseError(field: "snapshot.players") }
        return GameSnapshot(
            players: try playersJSON.map { try player($0, gridCache: &gridCache) },
            elapsed: try req(double(dict["elapsed"]), "snapshot.elapsed"))
    }

    // MARK: - Players

    private static func player(_ json: Any, gridCache: inout [Int: [[Int]]]) throws -> PlayerSnapshot {
        guard let d = json as? [String: Any] else { throw ParseError(field: "player") }
        let id = try req(int(d["id"]), "player.id")
        let playerGrid: [[Int]]
        if let g = grid(d["grid"]) {
            gridCache[id] = g
            playerGrid = g
        } else if let cached = gridCache[id] {
            playerGrid = cached   // stripped by the shim: version unchanged since last full send
        } else {
            throw ParseError(field: "player.grid (stripped with no cached rows for id \(id))")
        }
        return PlayerSnapshot(
            id: id,
            grid: playerGrid,
            currentPiece: try value(d["currentPiece"]).map { try piece($0) },
            ghost: try value(d["ghost"]).map { try ghost($0) },
            holdPiece: value(d["holdPiece"]) as? String,
            nextPieces: value(d["nextPieces"]) as? [String] ?? [],
            level: try req(int(d["level"]), "player.level"),
            lines: try req(int(d["lines"]), "player.lines"),
            alive: try req(bool(d["alive"]), "player.alive"),
            pendingGarbage: int(d["pendingGarbage"]) ?? 0,
            clearingCells: try value(d["clearingCells"]).map { try cells($0, "player.clearingCells") },
            gridVersion: try req(int(d["gridVersion"]), "player.gridVersion"))
    }

    private static func piece(_ json: Any) throws -> PieceSnapshot {
        guard let d = json as? [String: Any] else { throw ParseError(field: "currentPiece") }
        return PieceSnapshot(
            type: try req(d["type"] as? String, "piece.type"),
            typeId: try req(int(d["typeId"]), "piece.typeId"),
            anchorCol: try req(int(d["anchorCol"]), "piece.anchorCol"),
            anchorRow: try req(int(d["anchorRow"]), "piece.anchorRow"),
            cells: try axials(d["cells"]),
            blocks: try cells(d["blocks"], "piece.blocks"))
    }

    private static func ghost(_ json: Any) throws -> GhostSnapshot {
        guard let d = json as? [String: Any] else { throw ParseError(field: "ghost") }
        return GhostSnapshot(
            anchorCol: try req(int(d["anchorCol"]), "ghost.anchorCol"),
            anchorRow: try req(int(d["anchorRow"]), "ghost.anchorRow"),
            blocks: try cells(d["blocks"], "ghost.blocks"))
    }

    // MARK: - Events / commands

    private static func event(_ json: Any) throws -> GameEvent {
        guard let d = json as? [String: Any] else { throw ParseError(field: "event") }
        return GameEvent(
            type: try req(d["type"] as? String, "event.type"),
            playerId: int(d["playerId"]),
            typeId: int(d["typeId"]),
            lines: int(d["lines"]),
            blocks: try value(d["blocks"]).map { try cells($0, "event.blocks") },
            clearCells: try value(d["clearCells"]).map { try cells($0, "event.clearCells") },
            rows: value(d["rows"]) as? [Int],
            senderId: int(d["senderId"]),
            toId: int(d["toId"]))
    }

    private static func command(_ json: Any) throws -> HostCommand {
        guard let d = json as? [String: Any] else { throw ParseError(field: "command") }
        return HostCommand(
            type: try req(d["type"] as? String, "command.type"),
            playerId: int(d["playerId"]),
            senderId: int(d["senderId"]),
            toId: int(d["toId"]),
            typeId: int(d["typeId"]),
            lines: int(d["lines"]),
            blocks: try value(d["blocks"]).map { try cells($0, "command.blocks") },
            clearCells: try value(d["clearCells"]).map { try cells($0, "command.clearCells") },
            level: int(d["level"]),
            alive: bool(d["alive"]),
            garbageIncoming: int(d["garbageIncoming"]),
            elapsed: double(d["elapsed"]),
            results: try value(d["results"]).map { json -> [PlayerResult] in
                guard let arr = json as? [Any] else { throw ParseError(field: "command.results") }
                return try arr.map { try result($0) }
            })
    }

    private static func result(_ json: Any) throws -> PlayerResult {
        guard let d = json as? [String: Any] else { throw ParseError(field: "result") }
        return PlayerResult(
            playerId: try req(int(d["playerId"]), "result.playerId"),
            alive: try req(bool(d["alive"]), "result.alive"),
            lines: try req(int(d["lines"]), "result.lines"),
            level: try req(int(d["level"]), "result.level"),
            rank: try req(int(d["rank"]), "result.rank"))
    }

    // MARK: - Scalar / shape helpers

    /// JSON `null` (NSNull) and absent keys both read as nil.
    private static func value(_ v: Any?) -> Any? { v is NSNull ? nil : v }

    private static func int(_ v: Any?) -> Int? { (value(v) as? NSNumber)?.intValue }
    private static func double(_ v: Any?) -> Double? { (value(v) as? NSNumber)?.doubleValue }
    private static func bool(_ v: Any?) -> Bool? { value(v) as? Bool }

    private static func req<T>(_ v: T?, _ field: String) throws -> T {
        guard let v else { throw ParseError(field: field) }
        return v
    }

    /// `[[col, row], ...]` pair arrays.
    private static func cells(_ v: Any?, _ field: String) throws -> [Cell] {
        guard let arr = value(v) as? [Any] else { throw ParseError(field: field) }
        var out: [Cell] = []
        out.reserveCapacity(arr.count)
        for e in arr {
            guard let pair = e as? [Any], pair.count >= 2,
                  let col = int(pair[0]), let row = int(pair[1]) else { throw ParseError(field: field) }
            out.append(Cell(col: col, row: row))
        }
        return out
    }

    /// `[{q, r}, ...]` axial-offset objects.
    private static func axials(_ v: Any?) throws -> [Axial] {
        guard let arr = value(v) as? [Any] else { throw ParseError(field: "piece.cells") }
        return try arr.map { e in
            guard let d = e as? [String: Any], let q = int(d["q"]), let r = int(d["r"]) else {
                throw ParseError(field: "piece.cells")
            }
            return Axial(q: q, r: r)
        }
    }

    /// `[[Int]]` grid rows; nil when the key is absent (stripped) or null.
    private static func grid(_ v: Any?) -> [[Int]]? {
        guard let rows = value(v) as? [Any] else { return nil }
        var out: [[Int]] = []
        out.reserveCapacity(rows.count)
        for row in rows {
            if let ints = row as? [Int] {
                out.append(ints)
            } else if let anys = row as? [Any] {
                var r: [Int] = []
                r.reserveCapacity(anys.count)
                for cell in anys {
                    guard let i = int(cell) else { return nil }
                    r.append(i)
                }
                out.append(r)
            } else {
                return nil
            }
        }
        return out
    }
}
