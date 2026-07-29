package com.hexstacker.tv.render

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import com.hexstacker.core.model.Cell
import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.model.PlayerState
import com.hexstacker.core.render.ColorMath
import com.hexstacker.core.render.HexCell
import com.hexstacker.core.render.HexGeometry
import com.hexstacker.core.render.Rgb
import com.hexstacker.core.render.Theme
import com.hexstacker.core.render.Zigzag
import com.hexstacker.core.render.outlineVertices
import com.hexstacker.tv.R
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Renders ONE player's board + HUD from a [PlayerState], onto an
 * `android.graphics.Canvas`. A merged near-1:1 port of
 * `public/display/BoardRenderer.js` + `public/display/UIRenderer.js` (the Apple TV
 * `BoardNode.swift` merges them the same way).
 *
 * Canvas is Y-DOWN exactly like the web — NO axis flip. All geometry/colors come
 * from `:core` (`HexGeometry`, `Theme`, `ColorMath`, `Zigzag`); this class only
 * composes them onto pixels.
 *
 * Threading: construct + render + [recycle] on the render thread only. Caches
 * (`bgCache`, `gridCache`, chrome) are owned here and rebuilt on the documented
 * invalidation keys (tier / gridVersion / boxHeight).
 */
class BoardRenderer(
    context: Context,
    private val geometry: HexGeometry,
    val boardX: Float,
    val boardY: Float,
    private val colorSlot: Int,
    val name: String,
    private val stampCache: HexStampCache,
    private val fonts: Fonts,
) {
    // ── Localized HUD labels (resolved once; i18n values are already uppercase) ─
    // Mirror `public/shared/i18n.js`: hold/next/level/lines/ko/disconnected/
    // scan_to_rejoin. Drawn verbatim (no render-site transform).
    private val labelHold: String = context.getString(R.string.hold)
    private val labelNext: String = context.getString(R.string.next)
    private val labelLevel: String = context.getString(R.string.level)
    private val labelLines: String = context.getString(R.string.lines)
    private val labelKo: String = context.getString(R.string.ko)
    private val labelDisconnected: String = context.getString(R.string.disconnected)
    private val labelScanToRejoin: String = context.getString(R.string.scan_to_rejoin)

    // ── Geometry (Double from :core → Float for drawing) ──────────────────────
    val cellSize: Float = geometry.cellSize.toFloat()
    val hexSize: Float = geometry.hexSize.toFloat()
    val hexH: Float = geometry.hexH.toFloat()
    val colW: Float = geometry.colW.toFloat()
    val hexW: Float = geometry.hexW.toFloat()
    val boardWidth: Float = geometry.boardWidth.toFloat()
    val boardHeight: Float = geometry.boardHeight.toFloat()

    private val cellSizeD = geometry.cellSize
    private val sCell: Float = geometry.sCell.toFloat()
    private val gridLineWidth: Float = geometry.gridLineWidth.toFloat()
    private val borderWidth: Float = geometry.borderWidth.toFloat()
    private val sqrt3 = sqrt(3.0)

    private val ceilBW = ceil(geometry.boardWidth).toInt()
    private val ceilBH = ceil(geometry.boardHeight).toInt()
    private val bgPad: Int = max(2, ceil(cellSizeD * Theme.Stroke.border * 0.5).toInt() + 1)
    private val chromePad: Int = max(2, ceil(cellSizeD * Theme.Stroke.border * 0.3).toInt() + 1)

    // ── Accent + cached colors ────────────────────────────────────────────────
    private val accent = Theme.playerColor(colorSlot)
    private val accentInt = accent.toArgb()
    private val lum = ColorMath.luminance01(accent)
    private val gridAlpha = Theme.Opacity.grid + (1 - lum) * 0.08
    private val tintFillInt = accent.argb(Theme.Opacity.boardTint)
    private val wallStrokeInt = accent.argb(Theme.Opacity.wall)
    private val hairlineStrokeInt = Theme.hairline.argb(Theme.Opacity.hairline)
    // Tonal panel fill — the canvas (srgb) approximation of the A2 recipe
    // color-mix(in oklab, player-color 20%, bg-card), same as UIRenderer._panelFill.
    private val panelFillInt = Rgb(
        (accent.r * 0.2 + TvColors.bgCard.r * 0.8 + 0.5).toInt(),
        (accent.g * 0.2 + TvColors.bgCard.g * 0.8 + 0.5).toInt(),
        (accent.b * 0.2 + TvColors.bgCard.b * 0.8 + 0.5).toInt(),
    ).toArgb()
    private val panelStrokeInt = accent.argb(Theme.Opacity.soft)

    // ── HUD metrics (web parity) ──────────────────────────────────────────────
    private val panelGapF = (cellSizeD * Theme.Size.panelGap).toFloat()
    private val miniSizeD = cellSizeD * Theme.Font.miniScale
    private val miniSizeF = miniSizeD.toFloat()
    private val boxSizeF = (miniSizeD * Theme.Size.panelWidth).toFloat()
    private val labelSizeD = max(Theme.Font.labelMinPx, cellSizeD * Theme.Font.labelScale)
    private val labelSizeF = labelSizeD.toFloat()
    private val valueSizeF = max(Theme.Font.labelMinPx, cellSizeD * Theme.Font.labelScale * 1.3).toFloat()
    private val rowHeightF = (labelSizeD + valueSizeF + cellSizeD * 0.4).toFloat()
    private val nameSizeF = max(Theme.Font.nameMinPx, cellSizeD * Theme.Font.nameScale).toFloat()
    private val disconnectLabelSizeF = max(10.0, cellSizeD * Theme.Font.nameScale).toFloat()
    private val meterXF = (boardX - cellSizeD * 1.07).toFloat()
    private val koTextSizeF = max(20.0, cellSizeD * 2).toFloat()
    private val pieceSpacingF = miniSizeF * 3.5f
    private val nextStartYF = boardY + labelSizeF + cellSize * 0.2f
    // NEXT panel is always sized for 3 pieces (the engine never previews fewer).
    private val nextBoxHF = pieceSpacingF * 3f

    // ── Paints (reused; never allocate inside render) ─────────────────────────
    private val stampPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isFilterBitmap = true }
    private val miniPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isFilterBitmap = true }
    private val gridAlphaPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isFilterBitmap = true }
    private val ghostFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val ghostStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val previewFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val previewStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val nearClearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val clearingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val meterStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = gridLineWidth }
    private val meterFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    // Player name is the identity voice (Baloo 2), not the HUD face — same split
    // as the web (UIRenderer `_fontName` uses getBrandFont()).
    private val namePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fonts.brandBold; textSize = nameSizeF; textAlign = Paint.Align.LEFT
    }
    // Labels: quiet uppercase metadata — cream at label alpha with the wide
    // 0.2em tracking of .card-level__heading (A2).
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fonts.bold; textSize = labelSizeF; textAlign = Paint.Align.LEFT
        color = Theme.textPrimary.argb(Theme.Opacity.label); letterSpacing = 0.2f
    }
    private val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fonts.bold; textSize = valueSizeF; textAlign = Paint.Align.LEFT
        color = Theme.textPrimary.toArgb()
    }
    private val koWashPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        // Brand-plum dim (never a black/red wash) — canvas twin of --overlay-bg (A2).
        color = Theme.bgPrimary.argb(Theme.Opacity.overlay)
    }
    private val koTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fonts.black; textSize = koTextSizeF; textAlign = Paint.Align.CENTER
        color = colorInt(TvColors.koText) // danger token (web THEME.color.ko.text)
    }

    // Disconnect-overlay paints + QR dst rect (deterministic per instance; reused,
    // never allocate in draw). Config is constant, so it is set once here.
    private val disconnectOverlayPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        // Brand-plum board dim — canvas twin of --overlay-bg (never a black wash).
        color = Theme.bgPrimary.argb(Theme.Opacity.overlay)
    }
    private val disconnectTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fonts.semibold; textSize = disconnectLabelSizeF; textAlign = Paint.Align.CENTER
        color = accentInt; letterSpacing = 0.1f
    }
    private val disconnectCardPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = TvColors.white.toArgb()
    }
    private val disconnectBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        // Web uses the FIXED tangerine accent.secondary (#FF8C42), not the player color.
        style = Paint.Style.STROKE; strokeWidth = 1f; color = Theme.partyPalette[7].argb(0.15)
    }
    private val qrDstRect = RectF()

    // ── Reusable Paths (render thread only; never allocate in draw). Rebuilt only
    // when their inputs change (see the per-path keys below): an unchanged Path keeps
    // its generation id, so pulse-driven redraw frames (near-clear / clearing glow,
    // which repaint every vsync with only paint alpha moving) reuse Skia's cached
    // tessellation instead of re-rasterizing identical geometry. garbageFxPath is
    // the exception: its rows shift while an effect animates, so it stays per-frame.
    private val ghostPath = Path()
    private val previewPath = Path()
    private val nearClearPath = Path()
    private val clearingPath = Path()
    private val garbageMeterPath = Path()
    private val garbageFxPath = Path()
    // Board outline (absolute, outset 0.0). Deterministic per instance (geometry +
    // boardX/boardY are final); read-only at both use sites (drawKO clip, disconnect
    // overlay fill), so it is built once and reused instead of per frame.
    private val boardOutlineAbsPath: Path = outlinePath(geometry.outlineVertices(0.0), boardX, boardY)
    // ── Per-frame allocation elision (memo by typeId; invalidated on tier change) ──
    private var cachedGhostType = -1
    private var cachedGhostColor: ColorMath.Ghost? = null
    private val pieceStamps = arrayOfNulls<Stamp>(10) // stack/current-piece stamps by typeId (1..6, 9)
    private val miniStamps = arrayOfNulls<Stamp>(10)   // HOLD/NEXT mini-piece stamps by typeId
    private val miniStampSize = sqrt3 * (miniSizeD * 0.58) * (1 - Theme.Size.blockGap * 2)

    // ── Caches + invalidation keys ────────────────────────────────────────────
    private var bgCache: Bitmap? = null
    private var cachedBgTier: Theme.StyleTier? = null
    private var gridCache: Bitmap? = null
    private var cachedGridVersion = -1
    private var cachedGridTier: Theme.StyleTier? = null

    private var holdChromeCache: Bitmap? = null
    private var nextChromeCache: Bitmap? = null
    private var cachedChromeTier: Theme.StyleTier? = null

    // Zigzag clear-preview cache (recomputed only when ghost/rotation/grid changes).
    private var prevGhostCol = -1
    private var prevGhostRow = -1
    private var prevGhostType = -1
    private var prevGhostGV = -1
    private var prevRotQ = 0
    private var prevRotR = 0
    private var cachedPreviewCells: List<HexCell> = emptyList()

    // Near-clear pulse cache (depends only on the locked stack).
    private var cachedNcCells: List<HexCell> = emptyList()
    private var cachedNcGV = -1

    private var currentTier: Theme.StyleTier = Theme.StyleTier.NORMAL

    // ── Absolute cell centers (board placement + board-local hexCenter) ───────
    fun hexCenterX(col: Int, row: Int): Float = boardX + colW * col + hexSize
    fun hexCenterY(col: Int, row: Int): Float = boardY + hexH * (row + 0.5f * (col and 1)) + hexH / 2f

    /** Board outline as an absolute (screen-space) closed path; used by the KO anim. */
    fun outlineAbsPath(outset: Double): Path =
        outlinePath(geometry.outlineVertices(outset), boardX, boardY)

    /**
     * Absolute screen-space bounds of EVERYTHING [render], [drawGarbageEffects] and
     * [drawDisconnectedOverlay] can touch: the well, the HOLD panel and garbage meter
     * to its left, the NEXT panel and level/lines block to its right, and the name
     * above it. The surface view sizes each board's cache layer to this, so it must
     * never under-cover — anything outside would be silently clipped.
     *
     * Deliberately generous (a [cellSize] margin on every side): an oversized layer
     * costs a little texture memory, an undersized one drops pixels. All inputs are
     * construction-fixed, so this is computed once. Shake is excluded on purpose — it
     * rides on the layer's translation, not its contents.
     */
    val contentBounds: RectF = run {
        val margin = cellSize
        // Left: whichever of the HOLD panel / garbage meter reaches further out.
        val holdLeft = boardX - panelGapF - boxSizeF - chromePad
        val meterLeft = meterXF - sCell
        // Bottom: the level/lines block hangs below the well on some layouts.
        val linesBottom = nextStartYF + nextBoxHF + cellSize * 0.5f + rowHeightF +
            labelSizeF + cellSize * 0.1f + valueSizeF
        RectF(
            min(holdLeft, meterLeft) - margin,
            // The name is BOTTOM-anchored just above the well; its box climbs ~1 em.
            boardY - cellSize * 0.2f - nameSizeF - margin,
            boardX + boardWidth + panelGapF + boxSizeF + chromePad + margin,
            max(boardY + boardHeight + bgPad, linesBottom) + margin,
        )
    }

    // ──────────────────────────────────────────────────────────────────────────
    /** Returns true while a wall-clock pulse (near-clear / clearing glow) is on screen,
     *  so the surface view keeps rendering frames even though the snapshot is unchanged. */
    fun render(canvas: Canvas, p: PlayerState, nowMs: Double): Boolean {
        val tier = Theme.styleTier(p.level)
        currentTier = tier

        if (cachedChromeTier != tier) {
            holdChromeCache?.recycle(); holdChromeCache = null
            nextChromeCache?.recycle(); nextChromeCache = null
            cachedChromeTier = tier
            // Drop resolved-stamp memos (owned/recycled by stampCache, not us).
            pieceStamps.fill(null)
            miniStamps.fill(null)
        }

        // 1. Board bg (well + grid + walls) — cached single blit.
        if (bgCache == null || cachedBgTier != tier) {
            bgCache?.recycle()
            bgCache = buildBoardBgCache(tier)
            cachedBgTier = tier
        }
        canvas.drawBitmap(bgCache!!, boardX - bgPad, boardY - bgPad, null)

        // 2. Locked stack — cached, rebuilt on gridVersion / tier change.
        if (p.gridVersion != cachedGridVersion || tier != cachedGridTier) {
            buildGridCache(p, tier)
            cachedGridVersion = p.gridVersion
            cachedGridTier = tier
        }
        gridCache?.let { canvas.drawBitmap(it, boardX, boardY, stampPaint) }

        drawGhost(canvas, p)
        drawPreview(canvas, p)
        val nearClearPulsing = drawNearClear(canvas, p, nowMs)
        drawCurrentPiece(canvas, p, tier)
        val clearingPulsing = drawClearing(canvas, p, nowMs)

        // HUD
        drawName(canvas)
        drawHold(canvas, p, tier)
        drawNext(canvas, p, tier)
        drawLevelLines(canvas, p)
        if (p.pendingGarbage > 0) drawGarbageMeter(canvas, p.pendingGarbage)
        if (!p.alive) drawKO(canvas)

        return nearClearPulsing || clearingPulsing
    }

    // Resolved-stamp lookup: cache the (tier, pieceColors[typeId], size) stamp by typeId so
    // the steady-state frame does no String-key build / map lookup (invalidated on tier change).
    private fun pieceStamp(typeId: Int, tier: Theme.StyleTier): Stamp {
        pieceStamps.getOrNull(typeId)?.let { return it }
        val color = Theme.pieceColors[typeId] ?: TvColors.white
        return stampCache.get(tier, color, geometry.stampHeight).also {
            if (typeId in pieceStamps.indices) pieceStamps[typeId] = it
        }
    }

    private fun miniStamp(typeId: Int, tier: Theme.StyleTier): Stamp {
        miniStamps.getOrNull(typeId)?.let { return it }
        val color = Theme.pieceColors[typeId] ?: TvColors.white
        return stampCache.get(tier, color, miniStampSize).also {
            if (typeId in miniStamps.indices) miniStamps[typeId] = it
        }
    }

    // ── 1. Board background cache ─────────────────────────────────────────────
    private fun buildBoardBgCache(tier: Theme.StyleTier): Bitmap {
        val bmp = Bitmap.createBitmap(ceilBW + bgPad * 2, ceilBH + bgPad * 2, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)

        // Opaque pre-fill so the padded border blends with the surface clear.
        p.color = colorInt(Theme.bgPrimary)
        c.drawRect(0f, 0f, (ceilBW + bgPad * 2).toFloat(), (ceilBH + bgPad * 2).toFloat(), p)
        c.translate(bgPad.toFloat(), bgPad.toFloat())

        // Well fill, clipped to the board outline. Neon → pure black for max
        // contrast; otherwise a flat recessed deeper-plum well (bg.board) +
        // player tint — the same socket treatment as the lobby's empty player
        // slots (A2 dropped the gradient).
        c.save()
        c.clipPath(outlinePath(geometry.outlineVertices(0.0), 0f, 0f))
        if (tier == Theme.StyleTier.NEON_FLAT) {
            p.color = colorInt(TvColors.black)
            c.drawRect(0f, 0f, ceilBW.toFloat(), ceilBH.toFloat(), p)
        } else {
            p.color = colorInt(Theme.bgBoard)
            c.drawRect(0f, 0f, ceilBW.toFloat(), ceilBH.toFloat(), p)
            p.color = tintFillInt
            c.drawRect(0f, 0f, ceilBW.toFloat(), ceilBH.toFloat(), p)
        }
        c.restore()

        // Grid lines: stroke opaque on a temp bitmap, then composite at gridAlpha
        // (coincident hex edges would otherwise double the alpha — GOTCHA §8.6).
        val temp = Bitmap.createBitmap(ceilBW, ceilBH, Bitmap.Config.ARGB_8888)
        val tc = Canvas(temp)
        val gridPath = Path()
        for (row in 0 until geometry.visibleRows) {
            for (col in 0 until geometry.cols) {
                val center = geometry.hexCenter(col, row)
                gridPath.addHex(center.x.toFloat(), center.y.toFloat(), hexSize)
            }
        }
        val gp = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = accentInt
            strokeWidth = gridLineWidth
        }
        tc.drawPath(gridPath, gp)
        gridAlphaPaint.alpha = a255(gridAlpha)
        c.drawBitmap(temp, 0f, 0f, gridAlphaPaint)
        gridAlphaPaint.alpha = 255
        temp.recycle()

        // Outer wall stroke (outset outline) — a calmer player wall, then a
        // crisp warm-paper hairline on top so the well gets the same socket
        // rim as the lobby's empty player slots (A2).
        val wallPath = outlinePath(geometry.outlineVertices(geometry.wallOutset), 0f, 0f)
        p.style = Paint.Style.STROKE
        p.color = wallStrokeInt
        p.strokeWidth = borderWidth
        c.drawPath(wallPath, p)
        p.color = hairlineStrokeInt
        p.strokeWidth = 1f
        c.drawPath(wallPath, p)

        return bmp
    }

    // ── 2. Locked-stack cache ─────────────────────────────────────────────────
    private fun buildGridCache(p: PlayerState, tier: Theme.StyleTier) {
        val bmp = gridCache ?: Bitmap.createBitmap(ceilBW, ceilBH, Bitmap.Config.ARGB_8888).also { gridCache = it }
        bmp.eraseColor(0)
        val c = Canvas(bmp)
        val grid = p.grid
        for (r in grid.indices) {
            val rowArr = grid[r]
            for (col in rowArr.indices) {
                val v = rowArr[col]
                if (v > 0) {
                    val stamp = pieceStamp(v, tier)
                    val center = geometry.hexCenter(col, r)
                    c.drawBitmap(stamp.bitmap, stamp.blitLeft(center.x.toFloat()), stamp.blitTop(center.y.toFloat()), stampPaint)
                }
            }
        }
    }

    // ── 3. Ghost ──────────────────────────────────────────────────────────────
    // Ghost-path key: the blocks are fully determined by (typeId, rotation via
    // cells[0], landing anchor), so the Path is rebuilt only when one of those
    // changes. typeId = -1 is the "invalid, rebuild next time" sentinel.
    private var ghostPathType = -1
    private var ghostPathCol = 0
    private var ghostPathRow = 0
    private var ghostPathRotQ = 0
    private var ghostPathRotR = 0
    private var ghostPathDrawn = false

    private fun drawGhost(canvas: Canvas, p: PlayerState) {
        val ghost = p.ghost
        val piece = p.currentPiece
        if (ghost == null || piece == null || !p.alive) {
            ghostPathType = -1
            return
        }
        if (piece.typeId != cachedGhostType) {
            cachedGhostType = piece.typeId
            cachedGhostColor = ColorMath.ghost(Theme.pieceColors[piece.typeId] ?: TvColors.white)
        }
        val g = cachedGhostColor ?: return
        val c0 = piece.cells.firstOrNull()
        val rotQ = c0?.q ?: 0
        val rotR = c0?.r ?: 0
        if (piece.typeId != ghostPathType || ghost.anchorCol != ghostPathCol ||
            ghost.anchorRow != ghostPathRow || rotQ != ghostPathRotQ || rotR != ghostPathRotR
        ) {
            ghostPathType = piece.typeId; ghostPathCol = ghost.anchorCol
            ghostPathRow = ghost.anchorRow; ghostPathRotQ = rotQ; ghostPathRotR = rotR
            ghostPath.rewind()
            var drawn = false
            for (b in ghost.blocks) {
                if (b.row in 0 until VIS) {
                    ghostPath.addHex(hexCenterX(b.col, b.row), hexCenterY(b.col, b.row), sCell)
                    drawn = true
                }
            }
            ghostPathDrawn = drawn
        }
        if (!ghostPathDrawn) return
        ghostFillPaint.color = g.rgb.argb(g.fillAlpha)
        canvas.drawPath(ghostPath, ghostFillPaint)
        ghostStrokePaint.color = g.rgb.argb(g.outlineAlpha)
        ghostStrokePaint.strokeWidth = gridLineWidth
        canvas.drawPath(ghostPath, ghostStrokePaint)
    }

    // ── 4. Zigzag clear preview ───────────────────────────────────────────────
    private var previewPathDrawn = false

    private fun drawPreview(canvas: Canvas, p: PlayerState) {
        val ghost = p.ghost
        val piece = p.currentPiece
        if (ghost == null || piece == null || !p.alive) {
            cachedPreviewCells = emptyList()
            prevGhostCol = -1; prevGhostRow = -1; prevGhostType = -1
            prevGhostGV = -1; prevRotQ = 0; prevRotR = 0
            previewPathDrawn = false
            return
        }
        val c0 = piece.cells.firstOrNull()
        val rotQ = c0?.q ?: 0
        val rotR = c0?.r ?: 0
        if (ghost.anchorCol != prevGhostCol || ghost.anchorRow != prevGhostRow ||
            piece.typeId != prevGhostType || p.gridVersion != prevGhostGV ||
            rotQ != prevRotQ || rotR != prevRotR
        ) {
            prevGhostCol = ghost.anchorCol; prevGhostRow = ghost.anchorRow
            prevGhostType = piece.typeId; prevGhostGV = p.gridVersion
            prevRotQ = rotQ; prevRotR = rotR
            val grid = p.grid
            val ghostSet = HashSet<Int>(ghost.blocks.size * 2)
            for (b in ghost.blocks) ghostSet.add(b.col * STRIDE + b.row)
            cachedPreviewCells = Zigzag.clearable(
                cols = COLS,
                totalRows = grid.size,
                isFilled = { col, row -> grid[row][col] > 0 || (col * STRIDE + row) in ghostSet },
                ghostContributes = { col, row -> grid[row][col] == 0 && (col * STRIDE + row) in ghostSet },
            )
            // Rebuild the Path with the cells (same key), so unchanged frames draw
            // the identical Path object.
            previewPath.rewind()
            var drawn = false
            for (cl in cachedPreviewCells) {
                if (cl.row in 0 until VIS) {
                    previewPath.addHex(hexCenterX(cl.col, cl.row), hexCenterY(cl.col, cl.row), hexSize)
                    drawn = true
                }
            }
            previewPathDrawn = drawn
        }
        if (!previewPathDrawn) return
        // Clear-related effects speak cream (text primary), not pure white —
        // warm flashes sit better on the plum surfaces (A2).
        previewFillPaint.color = Theme.textPrimary.argb(0.2)
        canvas.drawPath(previewPath, previewFillPaint)
        previewStrokePaint.color = Theme.textPrimary.argb(0.4)
        previewStrokePaint.strokeWidth = gridLineWidth
        canvas.drawPath(previewPath, previewStrokePaint)
    }

    // ── 5. Near-clear pulse ───────────────────────────────────────────────────
    // Path key: (grid the cells came from, clearing row floor). The pulse itself is
    // paint-alpha only, so the Path stays stable across its every-vsync repaints.
    private var ncPathGV = Int.MIN_VALUE
    private var ncPathRowFloor = -2
    private var ncPathDrawn = false

    /** Returns true when the pulse was drawn (it animates on the wall clock). */
    private fun drawNearClear(canvas: Canvas, p: PlayerState, nowMs: Double): Boolean {
        if (!p.alive) {
            cachedNcCells = emptyList()
            cachedNcGV = -1
            ncPathGV = Int.MIN_VALUE
            return false
        }
        val clearing = !p.clearingCells.isNullOrEmpty()
        if (!clearing && p.gridVersion != cachedNcGV) {
            val grid = p.grid
            cachedNcCells = Zigzag.nearClear(COLS, grid.size, isFilled = { col, row -> grid[row][col] > 0 })
            cachedNcGV = p.gridVersion
        }
        if (cachedNcCells.isEmpty()) return false

        var rowFloor = -1
        if (clearing) for (cc in p.clearingCells!!) if (cc.row > rowFloor) rowFloor = cc.row

        if (cachedNcGV != ncPathGV || rowFloor != ncPathRowFloor) {
            ncPathGV = cachedNcGV
            ncPathRowFloor = rowFloor
            nearClearPath.rewind()
            var drawn = false
            for (cl in cachedNcCells) {
                if (cl.row <= rowFloor) continue
                nearClearPath.addHex(hexCenterX(cl.col, cl.row), hexCenterY(cl.col, cl.row), sCell)
                drawn = true
            }
            ncPathDrawn = drawn
        }
        if (!ncPathDrawn) return false
        val alpha = 0.60 + 0.20 * sin(2 * PI * nowMs / 600)
        nearClearPaint.color = Theme.nearClear.toArgb()
        nearClearPaint.alpha = a255(alpha)
        nearClearPaint.strokeWidth = gridLineWidth * 1.5f
        canvas.drawPath(nearClearPath, nearClearPaint)
        return true
    }

    // ── 6. Current piece ──────────────────────────────────────────────────────
    private fun drawCurrentPiece(canvas: Canvas, p: PlayerState, tier: Theme.StyleTier) {
        val piece = p.currentPiece ?: return
        if (!p.alive) return
        val stamp = pieceStamp(piece.typeId, tier)
        for (b in piece.blocks) {
            if (b.row in 0 until VIS) {
                val cx = hexCenterX(b.col, b.row)
                val cy = hexCenterY(b.col, b.row)
                canvas.drawBitmap(stamp.bitmap, stamp.blitLeft(cx), stamp.blitTop(cy), stampPaint)
            }
        }
    }

    // ── 7. Clearing-cells glow ────────────────────────────────────────────────
    // Path key: the clearingCells list itself, by identity — snapshots are immutable
    // value copies, and the render loop retains the same object while the scene is
    // unchanged, so the every-vsync glow frames reuse the built Path.
    private var clearingPathCells: List<Cell>? = null
    private var clearingPathDrawn = false

    /** Returns true when the glow was drawn (it animates on the wall clock). */
    private fun drawClearing(canvas: Canvas, p: PlayerState, nowMs: Double): Boolean {
        val cells = p.clearingCells ?: return false
        if (cells.isEmpty()) return false
        val alpha = 0.3 + 0.2 * sin((nowMs / 150) * PI)
        if (cells !== clearingPathCells) {
            clearingPathCells = cells
            clearingPath.rewind()
            var drawn = false
            for (cc in cells) {
                if (cc.row in 0 until VIS) {
                    clearingPath.addHex(hexCenterX(cc.col, cc.row), hexCenterY(cc.col, cc.row), sCell)
                    drawn = true
                }
            }
            clearingPathDrawn = drawn
        }
        if (!clearingPathDrawn) return false
        clearingPaint.color = Theme.textPrimary.toArgb()
        clearingPaint.alpha = a255(alpha)
        canvas.drawPath(clearingPath, clearingPaint)
        return true
    }

    // ── HUD: name / hold / next / level-lines / garbage / KO ──────────────────
    private fun drawName(canvas: Canvas) {
        val nameY = boardY - cellSize * 0.13f
        namePaint.color = accentInt
        canvas.drawTextB(name, boardX + cellSize * 0.07f, nameY - cellSize * 0.07f, namePaint, TextBaseline.BOTTOM)
    }

    private fun drawHold(canvas: Canvas, p: PlayerState, tier: Theme.StyleTier) {
        val panelY = boardY
        val panelX = boardX - panelGapF - boxSizeF
        if (holdChromeCache == null) {
            holdChromeCache = buildPanelChromeCache(boxSizeF, boxSizeF, labelHold, tier)
        }
        blitChrome(canvas, holdChromeCache!!, panelX, panelY)
        val hold = p.holdPiece
        if (hold != null) {
            val boxY = panelY + labelSizeF + cellSize * 0.2f
            drawMiniPiece(canvas, panelX + boxSizeF / 2f, boxY + boxSizeF / 2f, hold, tier, 255)
        }
    }

    private fun drawNext(canvas: Canvas, p: PlayerState, tier: Theme.StyleTier) {
        val panelX = boardX + boardWidth + panelGapF
        val panelY = boardY
        if (nextChromeCache == null) {
            nextChromeCache = buildPanelChromeCache(boxSizeF, nextBoxHF, labelNext, tier)
        }
        blitChrome(canvas, nextChromeCache!!, panelX, panelY)
        for (i in 0 until min(p.nextPieces.size, 3)) {
            val py = nextStartYF + i * pieceSpacingF + pieceSpacingF / 2f
            val alpha = if (i == 0) 1.0 else 0.7 - i * 0.06
            drawMiniPiece(canvas, panelX + boxSizeF / 2f, py, p.nextPieces[i], tier, a255(alpha))
        }
    }

    // Level/lines strings change rarely; cache them like the surface view's timer string
    // instead of allocating two Strings per board per frame.
    private var levelCached = Int.MIN_VALUE
    private var levelStr = ""
    private var linesCached = Int.MIN_VALUE
    private var linesStr = ""

    private fun drawLevelLines(canvas: Canvas, p: PlayerState) {
        val panelX = boardX + boardWidth + panelGapF
        val belowNextY = nextStartYF + nextBoxHF + cellSize * 0.5f
        val linesY = belowNextY + rowHeightF
        val valueYOffset = labelSizeF + cellSize * 0.1f

        if (p.level != levelCached) { levelCached = p.level; levelStr = p.level.toString() }
        if (p.lines != linesCached) { linesCached = p.lines; linesStr = p.lines.toString() }

        canvas.drawTextB(labelLevel, panelX, belowNextY, labelPaint, TextBaseline.TOP)
        canvas.drawTextB(labelLines, panelX, linesY, labelPaint, TextBaseline.TOP)
        canvas.drawTextB(levelStr, panelX, belowNextY + valueYOffset, valuePaint, TextBaseline.TOP)
        canvas.drawTextB(linesStr, panelX, linesY + valueYOffset, valuePaint, TextBaseline.TOP)
    }

    // Meter-path key: the shown line count (geometry is construction-fixed).
    private var meterPathLines = 0

    private fun drawGarbageMeter(canvas: Canvas, pending: Int) {
        val lines = min(pending, VIS)
        if (lines == 0) return
        if (lines != meterPathLines) {
            meterPathLines = lines
            garbageMeterPath.rewind()
            for (i in 0 until lines) {
                val row = VIS - 1 - i
                val cy = boardY + hexH * row + hexH / 2f
                garbageMeterPath.addHex(meterXF, cy, sCell)
            }
        }
        // Garbage meter speaks cream (A2), not pure white.
        meterStrokePaint.color = Theme.textPrimary.argb(Theme.Opacity.label)
        canvas.drawPath(garbageMeterPath, meterStrokePaint)
        meterFillPaint.color = Theme.textPrimary.argb(Theme.Opacity.muted)
        canvas.drawPath(garbageMeterPath, meterFillPaint)
    }

    /**
     * Animated garbage-meter effects over the pending-garbage column: incoming attack
     * indicators (attacker-colored) and defence cancel-flashes (cream). Port of
     * `UIRenderer._drawGarbageEffects` — a fading fill over rows [rowStart, rowStart+lines)
     * plus a cream top-edge stripe. Called by the surface view after the static meter.
     * [effects] is render-thread-owned; expired entries are pruned by the caller.
     */
    internal fun drawGarbageEffects(canvas: Canvas, effects: List<GarbageFx>?, nowMs: Double, highlightAlpha: Double) {
        if (effects.isNullOrEmpty()) return
        val topEdgeOffset = sCell * sqrt3.toFloat() / 2f
        val stripeInset = sCell * 0.05f
        val stripeH = sCell * 0.06f
        val halfStripeW = sCell / 2f
        for (fx in effects) {
            val elapsed = nowMs - fx.startMs
            if (elapsed >= fx.durationMs) continue
            val alpha = (1.0 - elapsed / fx.durationMs) * fx.maxAlpha
            garbageFxPath.rewind()
            var drawn = false
            val last = min(fx.rowStart + fx.lines, VIS)
            for (row in fx.rowStart until last) {
                if (row < 0) continue
                val cy = boardY + hexH * row + hexH / 2f
                garbageFxPath.addHex(meterXF, cy, sCell)
                drawn = true
            }
            if (!drawn) continue
            meterFillPaint.color = fx.colorInt
            meterFillPaint.alpha = a255(alpha)
            canvas.drawPath(garbageFxPath, meterFillPaint)
            // Cream top-edge stripe on each row of the effect.
            meterStrokePaint.color = Theme.textPrimary.toArgb()
            meterStrokePaint.alpha = a255(highlightAlpha * (alpha / fx.maxAlpha))
            meterStrokePaint.style = Paint.Style.FILL
            for (row in fx.rowStart until last) {
                if (row < 0) continue
                val cy = boardY + hexH * row + hexH / 2f
                canvas.drawRect(meterXF - halfStripeW, cy - topEdgeOffset + stripeInset, meterXF + halfStripeW, cy - topEdgeOffset + stripeInset + stripeH, meterStrokePaint)
            }
            meterStrokePaint.style = Paint.Style.STROKE
            meterStrokePaint.alpha = 255
        }
        meterFillPaint.alpha = 255
    }

    private fun drawKO(canvas: Canvas) {
        canvas.save()
        canvas.clipPath(boardOutlineAbsPath)
        canvas.drawRect(boardX, boardY, boardX + boardWidth, boardY + boardHeight, koWashPaint)
        canvas.drawTextB(labelKo, boardX + boardWidth / 2f, boardY + boardHeight / 2f, koTextPaint, TextBaseline.MIDDLE)
        canvas.restore()
    }

    // ── Mini piece (HOLD / NEXT) ──────────────────────────────────────────────
    private fun drawMiniPiece(canvas: Canvas, centerX: Float, centerY: Float, pieceType: String, tier: Theme.StyleTier, alpha: Int) {
        val b = MiniPieceBounds.table[pieceType] ?: return
        val typeId = EngineConstants.PIECE_TYPE_TO_ID[pieceType] ?: return

        val hexS = miniSizeD * 0.58
        val mHexH = sqrt3 * hexS
        val mColW = 1.5 * hexS
        val cols = b.maxC - b.minC + 1
        val totalW = mColW * (cols - 1) + 2 * hexS
        val ox = centerX - (totalW / 2).toFloat()
        val oy = centerY - (mHexH * b.visMidUnits).toFloat()

        val stamp = miniStamp(typeId, tier) // size == sqrt3 * drawS (miniStampSize)
        miniPaint.alpha = alpha
        for (o in b.offsets) {
            val px = ox + (mColW * (o.col - b.minC) + hexS).toFloat()
            val py = oy + (mHexH * (o.row - b.minR + 0.5 * (o.col and 1)) + mHexH / 2).toFloat()
            canvas.drawBitmap(stamp.bitmap, stamp.blitLeft(px), stamp.blitTop(py), miniPaint)
        }
        miniPaint.alpha = 255
    }

    // ── Panel chrome cache (header label + rounded panel) ─────────────────────
    private fun buildPanelChromeCache(boxW: Float, boxH: Float, label: String, tier: Theme.StyleTier): Bitmap {
        val labelGap = (cellSizeD * 0.2).toFloat()
        val bmpW = ceil(boxW + chromePad * 2).toInt()
        val bmpH = ceil(labelSizeF + labelGap + boxH + chromePad * 2).toInt()
        val bmp = Bitmap.createBitmap(bmpW, bmpH, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

        // Opaque pre-fill (matches the main canvas bg under the panel blit).
        fill.color = colorInt(Theme.bgPrimary)
        c.drawRect(0f, 0f, bmpW.toFloat(), bmpH.toFloat(), fill)

        // Header label at top — quiet uppercase metadata: cream at label alpha
        // with the wide 0.2em tracking of .card-level__heading (A2).
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = fonts.bold; textSize = labelSizeF; textAlign = Paint.Align.CENTER
            color = Theme.textPrimary.argb(Theme.Opacity.label); letterSpacing = 0.2f
        }
        c.drawTextB(label, chromePad + boxW / 2f, chromePad.toFloat(), text, TextBaseline.TOP)

        paintPanelChrome(c, fill, stroke, chromePad.toFloat(), chromePad + labelSizeF + labelGap, boxW, boxH, tier)
        return bmp
    }

    // Tonal panel recipe (A2) — mirrors the .player-card primitive: one flat
    // player-mixed fill, borderless. The neon tier keeps its black fill + thin
    // player-tinted rim (the black fill can't carry identity).
    private fun paintPanelChrome(c: Canvas, fill: Paint, stroke: Paint, x: Float, y: Float, w: Float, h: Float, tier: Theme.StyleTier) {
        val r = (cellSizeD * 0.2).toFloat()
        val rr = roundRectPath(x, y, w, h, r)
        if (tier == Theme.StyleTier.NEON_FLAT) {
            fill.color = colorInt(TvColors.black)
            c.drawPath(rr, fill)
            stroke.color = panelStrokeInt
            stroke.strokeWidth = max(1.0, cellSizeD * Theme.Stroke.border * 0.6).toFloat()
            c.drawPath(rr, stroke)
        } else {
            fill.color = panelFillInt
            c.drawPath(rr, fill)
        }
    }

    private fun blitChrome(canvas: Canvas, cache: Bitmap, panelX: Float, panelY: Float) {
        canvas.drawBitmap(cache, panelX - chromePad, panelY - chromePad, null)
    }

    // ── Disconnect overlay (secondary; QR supplied by the surface view) ───────

    // The card geometry only depends on the (construction-fixed) board rect, so the two
    // rounded-rect paths are built on the first QR frame and reused — the overlay shows
    // for as long as a board stays dropped, and per-frame Paths would be pure GC churn.
    private var disconnectCardRR: Path? = null
    private var disconnectQrClip: Path? = null

    fun drawDisconnectedOverlay(canvas: Canvas, qr: Bitmap?) {
        canvas.drawPath(boardOutlineAbsPath, disconnectOverlayPaint)

        if (qr == null) {
            canvas.drawTextB(labelDisconnected, boardX + boardWidth / 2f, boardY + boardHeight / 2f, disconnectTextPaint, TextBaseline.MIDDLE)
            return
        }
        val labelGap = disconnectLabelSizeF * 1.2f
        val qrSize = min(boardWidth, boardHeight) * 0.5f
        val qrRadius = qrSize * 0.08f
        val pad = qrSize * 0.06f
        val outerSize = qrSize + pad * 2
        val totalH = outerSize + labelGap + disconnectLabelSizeF
        val groupY = boardY + (boardHeight - totalH) / 2f
        val outerX = boardX + (boardWidth - outerSize) / 2f

        // Card fill + rim share one path (identical bounds).
        val cardRR = disconnectCardRR
            ?: roundRectPath(outerX, groupY, outerSize, outerSize, qrRadius).also { disconnectCardRR = it }
        canvas.drawPath(cardRR, disconnectCardPaint)
        canvas.drawPath(cardRR, disconnectBorderPaint)

        val qrClip = disconnectQrClip
            ?: roundRectPath(outerX + pad, groupY + pad, qrSize, qrSize, max(1f, qrRadius - pad)).also { disconnectQrClip = it }
        canvas.save()
        canvas.clipPath(qrClip)
        qrDstRect.set(outerX + pad, groupY + pad, outerX + pad + qrSize, groupY + pad + qrSize)
        canvas.drawBitmap(qr, null, qrDstRect, stampPaint)
        canvas.restore()

        canvas.drawTextB(labelScanToRejoin, boardX + boardWidth / 2f, groupY + outerSize + labelGap, disconnectTextPaint, TextBaseline.TOP)
    }

    fun recycle() {
        bgCache?.recycle(); bgCache = null
        gridCache?.recycle(); gridCache = null
        holdChromeCache?.recycle(); holdChromeCache = null
        nextChromeCache?.recycle(); nextChromeCache = null
    }

    companion object {
        private const val VIS = EngineConstants.VISIBLE_ROWS // 15
        private const val COLS = EngineConstants.COLS // 9
        private const val STRIDE = EngineConstants.TOTAL_ROWS // 19, keeps buffer rows collision-free
        // HUD copy is localized via string resources resolved in the constructor
        // (labelHold/labelNext/labelLevel/labelLines/labelKo/labelDisconnected/
        // labelScanToRejoin), mirroring `public/shared/i18n.js`.
    }
}
