package com.hexstacker.core.render

import com.hexstacker.core.model.EngineConstants
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** One board's origin within the viewport, plus its seat index. */
data class BoardPlacement(val originX: Double, val originY: Double, val seatIndex: Int)

data class BoardLayout(
    val cellSize: Double,
    val geometry: HexGeometry,
    val gridCols: Int,
    val gridRows: Int,
    val placements: List<BoardPlacement>,
)

/**
 * Multi-board layout, ported from `DisplayUI.calculateLayout`. Chooses the tile
 * grid for N players (1..8) and each board's origin.
 *
 * PARITY CAVEAT: the web `textHeight` measures live glyph ascent+descent via
 * `ctx.measureText('Mg')`, which is font-metric dependent and NOT byte-parity-able.
 * The default here uses the Swift approximation (nameSize + nameGap); inject
 * [textHeightOverride] in :tv with real `Paint.FontMetrics` for exact parity.
 */
object LayoutEngine {
    private const val padding = Theme.Size.canvasPad // 5.0
    private val totalCellsWide = (EngineConstants.COLS + 3 + 3).toDouble() // 15.0

    fun textHeight(cs: Double, override: ((Double) -> Double)? = null): Double {
        override?.let { return it(cs) }
        val nameSize = max(Theme.Font.nameMinPx, cs * Theme.Font.nameScale) // max(24, cs*0.9)
        val nameGap = cs * 0.6
        return nameSize + nameGap
    }

    /** Largest integer cellSize fitting one board + name into a tile. */
    fun cellSizeFor(
        viewportW: Double,
        viewportH: Double,
        tileCols: Int,
        tileRows: Int,
        textHeightOverride: ((Double) -> Double)? = null,
    ): Double {
        val boardRowsUnits = HexGeometry(cellSize = 1.0).boardHeight
        val aw = (viewportW - padding * (tileCols + 1)) / tileCols
        val ah = (viewportH - padding * (tileRows + 1)) / tileRows
        var cs = floor(min(aw / totalCellsWide, ah / boardRowsUnits))
        while (cs > 1 && cs * boardRowsUnits + textHeight(cs, textHeightOverride) > ah) cs -= 1
        return max(cs, 1.0)
    }

    /** Tile grid (cols,rows) for n players, picking whichever yields larger cellSize. */
    fun chooseGrid(
        n: Int,
        viewportW: Double,
        viewportH: Double,
        textHeightOverride: ((Double) -> Double)? = null,
    ): Pair<Int, Int> {
        fun cs(c: Int, r: Int) = cellSizeFor(viewportW, viewportH, c, r, textHeightOverride)
        return when (max(n, 1)) {
            1 -> 1 to 1
            2 -> 2 to 1
            3 -> 3 to 1
            4 -> if (cs(4, 1) >= cs(2, 2)) 4 to 1 else 2 to 2
            5, 6 -> if (cs(n, 1) >= cs(3, 2)) n to 1 else 3 to 2
            else -> {
                val nn = min(n, EngineConstants.MAX_PLAYERS)
                if (cs(nn, 1) >= cs(4, 2)) nn to 1 else 4 to 2
            }
        }
    }

    fun layout(
        n: Int,
        viewportW: Double,
        viewportH: Double,
        textHeightOverride: ((Double) -> Double)? = null,
    ): BoardLayout {
        val (gridCols, gridRows) = chooseGrid(n, viewportW, viewportH, textHeightOverride)
        val cellSize = cellSizeFor(viewportW, viewportH, gridCols, gridRows, textHeightOverride)
        val geo = HexGeometry(cellSize = cellSize)

        val maxSlots = gridCols * gridRows
        val cellAreaW = (viewportW - padding * (gridCols + 1)) / gridCols
        val cellAreaH = (viewportH - padding * (gridRows + 1)) / gridRows
        val nameArea = textHeight(cellSize, textHeightOverride)
        val totalContentH = geo.boardHeight + textHeight(cellSize, textHeightOverride)

        val placements = ArrayList<BoardPlacement>()
        for (i in 0 until min(n, maxSlots)) {
            val col = i % gridCols
            val row = i / gridCols
            val boardX = padding + col * (cellAreaW + padding) + (cellAreaW - geo.boardWidth) / 2
            val boardY = padding + row * (cellAreaH + padding) +
                (cellAreaH - totalContentH) / 2 + nameArea
            placements.add(BoardPlacement(boardX, boardY, i))
        }
        return BoardLayout(cellSize, geo, gridCols, gridRows, placements)
    }
}
