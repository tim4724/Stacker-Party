import Testing
@testable import HexStackerKit

// Pure-logic tests for the kit (geometry, theme, color math). Run under
// `swift test` (works with only Command Line Tools; no full Xcode).
//
// The room/host FSM used to be tested here against a hand-ported Swift RoomFlow.
// That port is gone: the room layer is server/RoomBrain.js running in the shared
// JavaScriptCore context, so its behaviour is pinned by the cross-platform golden
// (RoomBrainConformanceTests) and its Node twin, not by a second implementation.

@Suite struct GeometryTests {
    @Test func boardDimensions() {
        let g = HexGeometry(cellSize: 14)
        #expect(abs(g.boardWidth - 9 * 14) < 1e-9)
        #expect(abs(g.hexSize - 9) < 1e-9)
        #expect(abs(g.hexW - 2 * g.hexSize) < 1e-9)
        #expect(HexGeometry.unitVertices.count == 6, "a hex has six unit vertices")
    }

    @Test func columnParityStagger() {
        let g = HexGeometry(cellSize: 14)
        let c00 = g.hexCenter(col: 0, row: 0)
        let c10 = g.hexCenter(col: 1, row: 0)
        let c01 = g.hexCenter(col: 0, row: 1)
        #expect(abs(c00.x - g.hexSize) < 1e-9)                  // first center sits one hexSize in
        #expect(abs(c00.y - g.hexH * 0.5) < 1e-9)              // ...and half a hex down
        #expect(abs((c10.y - c00.y) - g.hexH * 0.5) < 1e-9)   // odd column down half a hex
        #expect(abs((c01.y - c00.y) - g.hexH) < 1e-9)          // row pitch == hexH
    }

    @Test func colorMathMatchesCanvas() {
        #expect(ColorMath.lighten(RGB(100, 100, 100), 15) == RGB(115, 115, 115))
        #expect(ColorMath.darken(RGB(100, 100, 100), 10) == RGB(90, 90, 90))
        #expect(ColorMath.neonDark(RGB(255, 255, 255)) == RGB(76, 76, 76))
        #expect(abs(ColorMath.luminance01(RGB(255, 255, 255)) - 1.0) < 1e-9, "white luminance is 1.0")
        #expect(Theme.playerColor(slot: 0) == RGB(255, 107, 107), "slot 0 is the canonical first player color")
    }

    @Test func layoutBuckets() {
        let l2 = LayoutEngine.layout(playerCount: 2, viewportW: 1920, viewportH: 1080)
        #expect(l2.gridCols == 2 && l2.gridRows == 1)
        #expect(l2.placements.count == 2)
        let l4 = LayoutEngine.layout(playerCount: 4, viewportW: 1920, viewportH: 1080)
        #expect(l4.placements.count == 4)
    }

    @Test func styleTierByLevel() {
        #expect(Theme.tier(forLevel: 1) == .normal)
        #expect(Theme.tier(forLevel: 6) == .pillow)
        #expect(Theme.tier(forLevel: 11) == .neonFlat)
    }
}
