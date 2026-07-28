import Foundation

// Visual theme values mirrored from public/shared/theme.js. RGB tuples are kept
// platform-agnostic (the tvOS layer maps them to UIColor); this lets the values
// be unit-checked on macOS.

public enum Theme {

    // Cell value (grid / typeId) -> color. 1...6 are piece types, 9 is garbage.
    public static let pieceColors: [Int: RGB] = [
        1: RGB(0xFF, 0x6B, 0x6B),  // I3 red
        2: RGB(0x4E, 0xCD, 0xC4),  // V3 teal
        3: RGB(0xFF, 0xE0, 0x66),  // T3 honey
        4: RGB(0xA7, 0x8B, 0xFA),  // o  violet
        5: RGB(0x7B, 0xED, 0x6F),  // d  mint
        6: RGB(0xF1, 0x78, 0xD8),  // b  magenta
        9: RGB(0x80, 0x80, 0x80),  // garbage gray
    ]

    // Per-player accent palette (color slot -> color), spectrum-ordered.
    public static let playerColors: [RGB] = [
        RGB(0xFF, 0x6B, 0x6B),  // 0 red
        RGB(0xFF, 0x8C, 0x42),  // 1 tangerine
        RGB(0xFF, 0xE0, 0x66),  // 2 honey
        RGB(0x7B, 0xED, 0x6F),  // 3 mint
        RGB(0x4E, 0xCD, 0xC4),  // 4 teal
        RGB(0x5B, 0x7F, 0xFF),  // 5 indigo
        RGB(0xA7, 0x8B, 0xFA),  // 6 violet
        RGB(0xF1, 0x78, 0xD8),  // 7 magenta
    ]

    public static func playerColor(slot: Int) -> RGB {
        // Out-of-range falls back to slot 0 (red), matching the web's
        // `PLAYER_COLORS[idx] || PLAYER_COLORS[0]` (e.g. UIRenderer.js).
        guard slot >= 0, slot < playerColors.count else { return playerColors[0] }
        return playerColors[slot]
    }

    // Background colors.
    public static let bgPrimary = RGB(0x1E, 0x1A, 0x2B)    // main canvas
    public static let bgSecondary = RGB(0x18, 0x14, 0x21)  // deeper plum panel bg
    public static let bgBoard = RGB(0x15, 0x12, 0x1F)      // flat recessed well fill / socket base
    // Warm-paper hairline for socket rims and ring strokes — mirrors the
    // rgba(255,248,236,X) --border family in theme.css (THEME.color.hairline).
    public static let hairline = RGB(0xFF, 0xF8, 0xEC)
    // Cream outline pulse (== text.primary) — extends the "cream =
    // clear-related" vocabulary shared with the clear preview and clear glow.
    public static let nearClear = RGB(0xF7, 0xF1, 0xE8)

    // Opacity tokens.
    public enum Opacity {
        public static let boardTint = 0.12
        public static let grid = 0.18
        public static let hairline = 0.12  // socket-rim hairline strokes (× hairline color)
        public static let wall = 0.5       // board wall stroke (player color)
        public static let highlight = 0.16
        public static let shadow = 0.25
        public static let overlay = 0.75   // dark overlays (board-area KO/disconnect dim)
        public static let subtle = 0.08
    }

    // Size / stroke tokens.
    public enum Size {
        public static let canvasPad = 5.0   // outer margin and inter-tile gap
        public static let blockGap = 0.03
    }
    public enum Stroke {
        public static let grid = 0.03
        public static let border = 0.04
        public static let ghost = 0.05
    }

    // MARK: Style tiers (driven by player level)

    public enum StyleTier: Equatable {
        case normal     // Lv 1-5: gradient + highlight/shadow bands
        case pillow     // Lv 6-10: rounded, radial gloss
        case neonFlat   // Lv 11+: dark fill + bright rim
    }

    public static func tier(forLevel level: Int) -> StyleTier {
        if level >= 11 { return .neonFlat }
        if level >= 6 { return .pillow }
        return .normal
    }
}

// MARK: - Multi-board layout (ported from DisplayUI.calculateLayout)

public struct BoardPlacement: Equatable {
    /// Board origin (top-left of bounding box), canvas Y-down, viewport space.
    public let originX: Double
    public let originY: Double
    public let seatIndex: Int
}

public struct BoardLayout: Equatable {
    public let cellSize: Double
    public let geometry: HexGeometry
    public let gridCols: Int
    public let gridRows: Int
    public let placements: [BoardPlacement]
}

public enum LayoutEngine {
    private static let padding = Theme.Size.canvasPad
    private static let totalCellsWide = Double(EngineConstants.cols) + 3 + 3   // board + side panels

    /// Height reserved above the board for the player-name label. Approximation:
    /// the web measures real glyph metrics here (DisplayUI.js measureHeight,
    /// ascent+descent of 'Mg' ≈ 0.9·nameSize), so native boards come out
    /// marginally smaller/lower for the same viewport. Layout is not part of the
    /// byte-parity contract; keep the two visually close if either side changes.
    public static func textHeight(_ cs: Double) -> Double {
        let nameSize = max(24.0, cs * 0.9)
        let nameGap = cs * 0.6
        return nameSize + nameGap
    }

    /// Largest integer cellSize that fits one board + name into a tile of the
    /// given grid over the viewport.
    public static func cellSizeFor(viewportW w: Double, viewportH h: Double,
                                   tileCols cols: Int, tileRows rows: Int) -> Double {
        let boardRowsUnits = HexGeometry(cellSize: 1).boardHeight
        let aw = (w - padding * Double(cols + 1)) / Double(cols)
        let ah = (h - padding * Double(rows + 1)) / Double(rows)
        var cs = (min(aw / totalCellsWide, ah / boardRowsUnits)).rounded(.down)
        while cs > 1 && cs * boardRowsUnits + textHeight(cs) > ah { cs -= 1 }
        return max(cs, 1)
    }

    /// Pick the tile grid (cols, rows) for n players, choosing whichever
    /// arrangement yields the larger cellSize at the breakpoints.
    public static func chooseGrid(playerCount n: Int, viewportW w: Double, viewportH h: Double) -> (cols: Int, rows: Int) {
        switch max(n, 1) {
        case 1: return (1, 1)
        case 2: return (2, 1)
        case 3: return (3, 1)
        case 4:
            return cellSizeFor(viewportW: w, viewportH: h, tileCols: 4, tileRows: 1)
                >= cellSizeFor(viewportW: w, viewportH: h, tileCols: 2, tileRows: 2) ? (4, 1) : (2, 2)
        case 5, 6:
            return cellSizeFor(viewportW: w, viewportH: h, tileCols: n, tileRows: 1)
                >= cellSizeFor(viewportW: w, viewportH: h, tileCols: 3, tileRows: 2) ? (n, 1) : (3, 2)
        default: // 7, 8 (and clamp above)
            let nn = min(n, EngineConstants.maxPlayers)
            return cellSizeFor(viewportW: w, viewportH: h, tileCols: nn, tileRows: 1)
                >= cellSizeFor(viewportW: w, viewportH: h, tileCols: 4, tileRows: 2) ? (nn, 1) : (4, 2)
        }
    }

    public static func layout(playerCount n: Int, viewportW w: Double, viewportH h: Double) -> BoardLayout {
        let (gridCols, gridRows) = chooseGrid(playerCount: n, viewportW: w, viewportH: h)
        let cellSize = cellSizeFor(viewportW: w, viewportH: h, tileCols: gridCols, tileRows: gridRows)
        let geo = HexGeometry(cellSize: cellSize)

        let maxSlots = gridCols * gridRows
        let cellAreaW = (w - padding * Double(gridCols + 1)) / Double(gridCols)
        let cellAreaH = (h - padding * Double(gridRows + 1)) / Double(gridRows)
        let nameArea = textHeight(cellSize)
        let totalContentH = geo.boardHeight + textHeight(cellSize)

        var placements: [BoardPlacement] = []
        for i in 0..<min(n, maxSlots) {
            let col = i % gridCols
            let row = i / gridCols
            let boardX = padding + Double(col) * (cellAreaW + padding) + (cellAreaW - geo.boardWidth) / 2
            let boardY = padding + Double(row) * (cellAreaH + padding)
                + (cellAreaH - totalContentH) / 2 + nameArea
            placements.append(BoardPlacement(originX: boardX, originY: boardY, seatIndex: i))
        }

        return BoardLayout(cellSize: cellSize, geometry: geo, gridCols: gridCols, gridRows: gridRows, placements: placements)
    }
}
