import Foundation
import JavaScriptCore
import HexStackerKit

/// Loads the WEB renderer's actual math (geometry, palette, color utilities,
/// style tiers) from the canonical JS files into JavaScriptCore and exposes it
/// typed. Used by the cross-engine parity tests to assert the native Swift
/// ports (HexGeometry / Theme / ColorMath) compute identical results to the
/// web Canvas renderer, so both engines place the same colored hex in the same
/// cell.
///
/// Loads: server/constants.js (computeHexGeometry), public/shared/theme.js
/// (PIECE_COLORS / PLAYER_COLORS / getStyleTier), public/shared/CanvasUtils.js
/// (lightenColor / darkenColor / ghostColor).
///
/// TEST TARGET ONLY, like the Android twin (jvmTest's RenderMathJs.kt): it reads
/// JS out of the repo working tree, which no shipped app has, so it has no
/// business compiling into the kit the app links.
final class RenderMathJS {

    enum ParityError: Error { case load(String), eval(String) }

    private let ctx: JSContext

    init(serverDir: URL, sharedDir: URL) throws {
        guard let ctx = JSContext() else { throw ParityError.load("no JSContext") }
        self.ctx = ctx
        var thrown: String?
        ctx.exceptionHandler = { _, exc in thrown = exc?.toString() }

        ctx.evaluateScript("var window = {};")

        func load(_ url: URL, append: String = "") throws {
            guard let src = try? String(contentsOf: url, encoding: .utf8) else {
                throw ParityError.load(url.lastPathComponent)
            }
            ctx.evaluateScript(src + "\n" + append, withSourceURL: url)
            if let e = thrown { throw ParityError.eval("\(url.lastPathComponent): \(e)") }
        }

        try load(serverDir.appendingPathComponent("constants.js"))
        // theme.js / CanvasUtils.js are plain top-level scripts; attach the
        // bindings we need to globalThis from inside the same evaluation.
        try load(sharedDir.appendingPathComponent("theme.js"), append: """
            globalThis.__PIECE_COLORS = PIECE_COLORS;
            globalThis.__PLAYER_COLORS = PLAYER_COLORS;
            globalThis.__getStyleTier = getStyleTier;
            """)
        try load(sharedDir.appendingPathComponent("CanvasUtils.js"), append: """
            globalThis.__lighten = lightenColor;
            globalThis.__darken = darkenColor;
            globalThis.__ghost = ghostColor;
            """)
        ctx.evaluateScript("""
            globalThis.__geom = function(cs){ return window.GameConstants.computeHexGeometry(9,15,cs); };
            globalThis.__center = function(col,row,cs){
              var g = __geom(cs);
              return [g.colW*col + g.hexSize, g.hexH*(row + 0.5*(col&1)) + g.hexH/2];
            };
            // Zigzag clear detection — wrap the engine functions with grid+ghost
            // closures, mirroring exactly how BoardRenderer.js calls them.
            globalThis.__clearable = function(grid, cols, ghost){
              var totalRows = grid.length;
              var gs = {};
              if (ghost) for (var i=0;i<ghost.length;i++) gs[ghost[i][0]+','+ghost[i][1]]=true;
              var isFilled = function(c,r){ return grid[r][c] > 0 || !!gs[c+','+r]; };
              var ghostContributes = ghost ? function(c,r){ return grid[r][c]===0 && !!gs[c+','+r]; } : null;
              return window.GameConstants.findClearableZigzags(cols, totalRows, isFilled, ghostContributes).clearCells;
            };
            globalThis.__nearClear = function(grid, cols){
              var totalRows = grid.length;
              var isFilled = function(c,r){ return grid[r][c] > 0; };
              return window.GameConstants.findNearClearZigzags(cols, totalRows, isFilled);
            };
            // Board-perimeter outline ring, board-local origin (bx = by = 0),
            // mirroring how BoardRenderer.js calls it for the wall stroke
            // (outset > 0) and the well clip path (outset 0).
            globalThis.__outline = function(cs, outset){
              var g = __geom(cs);
              return window.GameConstants.computeHexOutlineVerts(0, 0, g.hexSize, g.hexH, g.colW, 9, 15, outset);
            };
            """)
        if let e = thrown { throw ParityError.eval(e) }
    }

    struct Geometry { let hexSize, hexH, colW, boardWidth, boardHeight: Double }

    func geometry(cellSize: Double) -> Geometry {
        let g = ctx.evaluateScript("__geom(\(cellSize))")!
        return Geometry(
            hexSize: g.objectForKeyedSubscript("hexSize").toDouble(),
            hexH: g.objectForKeyedSubscript("hexH").toDouble(),
            colW: g.objectForKeyedSubscript("colW").toDouble(),
            boardWidth: g.objectForKeyedSubscript("boardWidth").toDouble(),
            boardHeight: g.objectForKeyedSubscript("boardHeight").toDouble())
    }

    func hexCenter(col: Int, row: Int, cellSize: Double) -> (x: Double, y: Double) {
        let arr = ctx.evaluateScript("__center(\(col),\(row),\(cellSize))")!.toArray() as! [NSNumber]
        return (arr[0].doubleValue, arr[1].doubleValue)
    }

    func pieceColors() -> [Int: RGB] {
        let json = ctx.evaluateScript("JSON.stringify(__PIECE_COLORS)")!.toString()!
        let dict = (try? JSONDecoder().decode([String: String].self, from: Data(json.utf8))) ?? [:]
        var out: [Int: RGB] = [:]
        for (k, v) in dict { if let id = Int(k), let rgb = RGB(hex: v) { out[id] = rgb } }
        return out
    }

    func playerColors() -> [RGB] {
        let json = ctx.evaluateScript("JSON.stringify(__PLAYER_COLORS)")!.toString()!
        let arr = (try? JSONDecoder().decode([String].self, from: Data(json.utf8))) ?? []
        return arr.compactMap { RGB(hex: $0) }
    }

    func styleTier(level: Int) -> String {
        ctx.evaluateScript("__getStyleTier(\(level))")!.toString()!
    }

    // MARK: Engine constants (constants.js): drift guard for EngineConstants

    /// A numeric export of `window.GameConstants` (e.g. "MAX_PLAYERS").
    func numericConstant(_ name: String) -> Double {
        ctx.evaluateScript("window.GameConstants.\(name)")!.toDouble()
    }

    func pieceTypes() -> [String] {
        let json = ctx.evaluateScript("JSON.stringify(window.GameConstants.PIECE_TYPES)")!.toString()!
        return (try? JSONDecoder().decode([String].self, from: Data(json.utf8))) ?? []
    }

    func pieceTypeToId() -> [String: Int] {
        let json = ctx.evaluateScript("JSON.stringify(window.GameConstants.PIECE_TYPE_TO_ID)")!.toString()!
        return (try? JSONDecoder().decode([String: Int].self, from: Data(json.utf8))) ?? [:]
    }

    // MARK: Zigzag clear detection (constants.js)

    func clearable(grid: [[Int]], cols: Int, ghost: [Cell]?) -> [Cell] {
        let ghostJS = ghost.map { "[" + $0.map { "[\($0.col),\($0.row)]" }.joined(separator: ",") + "]" } ?? "null"
        let call = "JSON.stringify(__clearable(\(Self.gridJS(grid)),\(cols),\(ghostJS)))"
        return Self.parseCells(ctx.evaluateScript(call)!.toString()!)
    }

    func nearClear(grid: [[Int]], cols: Int) -> [Cell] {
        let call = "JSON.stringify(__nearClear(\(Self.gridJS(grid)),\(cols)))"
        return Self.parseCells(ctx.evaluateScript(call)!.toString()!)
    }

    /// computeHexOutlineVerts (constants.js): the board wall / well-clip ring.
    func outline(cellSize: Double, outset: Double) -> [(x: Double, y: Double)] {
        let json = ctx.evaluateScript("JSON.stringify(__outline(\(cellSize),\(outset)))")!.toString()!
        guard let pairs = try? JSONDecoder().decode([[Double]].self, from: Data(json.utf8)) else { return [] }
        return pairs.compactMap { $0.count == 2 ? (x: $0[0], y: $0[1]) : nil }
    }

    private static func gridJS(_ grid: [[Int]]) -> String {
        "[" + grid.map { "[" + $0.map(String.init).joined(separator: ",") + "]" }.joined(separator: ",") + "]"
    }

    // "[[col,row],...]" -> [Cell]
    private static func parseCells(_ json: String) -> [Cell] {
        guard let pairs = try? JSONDecoder().decode([[Int]].self, from: Data(json.utf8)) else { return [] }
        return pairs.compactMap { $0.count == 2 ? Cell(col: $0[0], row: $0[1]) : nil }
    }

    func lighten(_ hex: String, _ percent: Double) -> RGB? {
        Self.parseRGB(ctx.evaluateScript("__lighten('\(hex)',\(percent))")!.toString()!)
    }

    func darken(_ hex: String, _ percent: Double) -> RGB? {
        Self.parseRGB(ctx.evaluateScript("__darken('\(hex)',\(percent))")!.toString()!)
    }

    struct Ghost { let rgb: RGB; let outlineAlpha: Double; let fillAlpha: Double }

    func ghost(_ hex: String) -> Ghost? {
        let json = ctx.evaluateScript("JSON.stringify(__ghost('\(hex)'))")!.toString()!
        guard let dict = try? JSONDecoder().decode([String: String].self, from: Data(json.utf8)),
              let outline = dict["outline"], let fill = dict["fill"],
              let (rgb, a) = Self.parseRGBA(outline), let (_, fa) = Self.parseRGBA(fill) else { return nil }
        return Ghost(rgb: rgb, outlineAlpha: a, fillAlpha: fa)
    }

    // "rgb(r, g, b)" -> RGB
    static func parseRGB(_ s: String) -> RGB? {
        let nums = s.components(separatedBy: CharacterSet(charactersIn: "rgba(), "))
            .compactMap { Double($0) }
        guard nums.count >= 3 else { return nil }
        return RGB(Int(nums[0]), Int(nums[1]), Int(nums[2]))
    }

    // "rgba(r, g, b, a)" -> (RGB, alpha)
    static func parseRGBA(_ s: String) -> (RGB, Double)? {
        let nums = s.components(separatedBy: CharacterSet(charactersIn: "rgba(), "))
            .compactMap { Double($0) }
        guard nums.count >= 4 else { return nil }
        return (RGB(Int(nums[0]), Int(nums[1]), Int(nums[2])), nums[3])
    }
}
