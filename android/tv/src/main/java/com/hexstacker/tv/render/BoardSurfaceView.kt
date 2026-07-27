package com.hexstacker.tv.render

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.os.SystemClock
import android.util.AttributeSet
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.annotation.VisibleForTesting
import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.model.EventType
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.model.PlayerState
import com.hexstacker.core.render.LayoutEngine
import com.hexstacker.core.render.Theme
import com.hexstacker.tv.R
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Per-seat presentation metadata supplied by the coordinator (NOT engine state). */
data class SeatMeta(
    val playerId: Int,
    val name: String,
    val colorSlot: Int,
    val startLevel: Int = 1,
)

/**
 * One animated garbage-meter effect (render-thread-owned). Incoming-attack indicators
 * carry the attacker color; defence cancel-flashes carry white. `rowStart`/`lines` are
 * mutated by the shift/trim bookkeeping (port of DisplayGame.js garbage effect logic).
 */
internal class GarbageFx(
    val startMs: Double,
    val durationMs: Double,
    val maxAlpha: Double,
    val colorInt: Int,
    var lines: Int,
    var rowStart: Int,
)

/**
 * The top-level live board surface: one full-screen [SurfaceView] hosting up to
 * 8 [BoardRenderer]s laid out via `LayoutEngine`, plus a single [BoardAnimations]
 * and the match timer. A near-1:1 port of `public/display/DisplayRender.renderFrame`
 * (clear → per-board shake+draw → animations → timer).
 *
 * Decoupled + stateless w.r.t. networking: the coordinator pushes data in via the
 * ingress methods below (game thread); a dedicated render thread reads the latest
 * and redraws every vsync while content changes. When nothing new was pushed AND no
 * wall-clock animation/pulse is running (countdown, pause, results), the thread
 * idle-skips instead of re-rendering an identical full-screen frame — see
 * [contentVersion] and the activity flag [drawFrame] returns. This covers most
 * GAMEPLAY frames too: the engine shim's scene signature (EngineBootstrap) omits
 * render-identical snapshots from frame(), so pieces sitting between discrete
 * grid steps push nothing here (web parity: DisplayRender's computeRenderSig).
 * Embed in Compose later via `AndroidView({ BoardSurfaceView(it) })`.
 */
class BoardSurfaceView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : SurfaceView(context, attrs), SurfaceHolder.Callback {

    private val fonts = Fonts(context)
    private val stampCache = HexStampCache()
    private val animations = BoardAnimations().also {
        it.setFonts(fonts)
        // Line-clear popups (i18n double / triple).
        it.setPopupLabels(context.getString(R.string.double_clear), context.getString(R.string.triple_clear))
    }
    private val qrCache = QrCache()

    private val timerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fonts.bold
        textAlign = Paint.Align.CENTER
        color = Theme.textPrimary.argb(Theme.Opacity.label) // cream, web drawTimer (A2)
        letterSpacing = 0.15f
    }

    // Render-thread-owned (built/read only on the render thread).
    private var renderers: List<BoardRenderer> = emptyList()
    private var seatIndexByPlayerId: Map<Int, Int> = emptyMap()
    // Pre-game/lobby empty PlayerStates, memoized per seat index. The grid + nextPieces are
    // shared constants, so an entry only changes when its seat's id/level changes; caching
    // avoids a fresh allocation per board every frame while no match snapshot is present.
    private var emptySnapshots: Array<PlayerState?> = emptyArray()

    // Board-grid rows of the current layout, for the timer size (web cachedGridRows).
    private var gridRows = 1
    // Timer cache (render thread): the string changes once per second, not per frame.
    // Glyphs are drawn one-by-one (fixed advances), so cache the per-glyph strings too.
    private var timerCachedSeconds = -1L
    private var timerCachedStr = ""
    private var timerGlyphs: Array<String> = emptyArray()
    // Glyph-advance scratch: sized for "MM:SS" (5 glyphs) but grown if a match ever runs
    // long enough for minutes to reach 3 digits ("100:00" and beyond, 6+ glyphs).
    private var timerAdvances = FloatArray(5)

    // Garbage-meter effects (render-thread-owned): playerId -> active fx. Mirrors the web
    // garbageIndicatorEffects / garbageDefenceEffects maps (attacker-colored + white flashes).
    private val garbageIndicator = HashMap<Int, MutableList<GarbageFx>>()
    private val garbageDefence = HashMap<Int, MutableList<GarbageFx>>()
    // Last-drawn pendingGarbage per player (pre-event), so a garbage_cancelled can place its
    // flash on the rows that were there before the engine reduced the count this frame.
    private val pendingByPlayer = HashMap<Int, Int>()

    // textHeight override: real Orbitron 'Mg' glyph metrics so multi-board sizing/centering
    // matches the web's ctx.measureText path (LayoutEngine's default is a coarse Swift approx).
    private val measurePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = fonts.bold }
    private val measureRect = Rect()
    private val textHeightOverride: (Double) -> Double = { cs ->
        val nameSize = max(Theme.Font.nameMinPx, cs * Theme.Font.nameScale)
        measurePaint.textSize = nameSize.toFloat()
        measurePaint.getTextBounds("Mg", 0, 2, measureRect)
        measureRect.height().toDouble() + cs * 0.6 // measured glyph box + nameGap (web textHeight)
    }

    // Ingress state (written game/main thread; read render thread).
    @Volatile private var latestSnapshot: GameSnapshot? = null
    @Volatile private var seats: List<SeatMeta> = emptyList()
    @Volatile private var playerCount = 0
    @Volatile private var surfaceW = 0
    @Volatile private var surfaceH = 0
    @Volatile private var layoutDirty = false

    private val eventQueue = ConcurrentLinkedQueue<GameEvent>()
    private val disconnects = ConcurrentHashMap<Int, String>()

    @Volatile private var running = false
    private var renderThread: Thread? = null

    // Bumped whenever visible content changes; the render thread compares it against
    // the last-drawn value to idle-skip identical frames. All writers are on the main
    // thread (the coordinator runs on the main dispatcher), so `++` doesn't race.
    @Volatile private var contentVersion = 0L

    // What the idle render thread parks on. It used to poll with sleep(8), which put up
    // to 8ms (mean 4) between a snapshot arriving and the repaint starting — and the idle
    // path is the COMMON one mid-game, since `animating` is only true while a pulse or
    // effect is live. Signalling it instead makes that wake immediate.
    private val contentLock = ReentrantLock()
    private val contentChanged = contentLock.newCondition()

    init {
        holder.addCallback(this)
    }

    // ── Ingress (game thread) ─────────────────────────────────────────────────

    /** Mark the visible content changed and wake the render thread if it is parked.
     *  Every ingress method below ends with this; nothing else may touch
     *  [contentVersion], or a submit could land without a wake and wait out the
     *  park timeout instead of drawing now. */
    private fun bumpContent() {
        contentLock.withLock {
            contentVersion++
            contentChanged.signalAll()
        }
    }

    /** Set/replace the viewport + seats → rebuild renderers via LayoutEngine. */
    fun setViewport(widthPx: Int, heightPx: Int, playerCount: Int, seats: List<SeatMeta>) {
        this.surfaceW = widthPx
        this.surfaceH = heightPx
        this.playerCount = playerCount
        this.seats = seats
        this.layoutDirty = true
        bumpContent()
    }

    /** Newest engine snapshot (volatile reference swap; render thread reads latest). */
    fun submitSnapshot(snapshot: GameSnapshot) {
        latestSnapshot = snapshot
        bumpContent()
    }

    /** One PartyCore.frame() event → drives the animation layer. */
    fun onGameEvent(event: GameEvent) {
        eventQueue.add(event)
        bumpContent()
    }

    /** Per-board disconnect/rejoin overlay; null clears it. */
    fun setDisconnected(playerId: Int, joinUrl: String?) {
        if (joinUrl == null) disconnects.remove(playerId) else disconnects[playerId] = joinUrl
        bumpContent()
    }

    /** Clear snapshot/animations/disconnects (game end, return to lobby). */
    fun clear() {
        latestSnapshot = null
        disconnects.clear()
        eventQueue.clear()
        bumpContent()
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Runtime locale switch. The manifest self-handles `locale` (recreating the
     * Activity would tear down the room), and the framework still dispatches the new
     * Configuration to attached views — so re-resolve the Canvas-layer strings here:
     * the popup labels directly, and the per-renderer HUD labels by marking the
     * layout dirty (rebuildLayout constructs fresh BoardRenderers, whose constructor
     * reads the now-updated resources). Compose chrome updates itself.
     */
    override fun onConfigurationChanged(newConfig: Configuration?) {
        super.onConfigurationChanged(newConfig)
        animations.setPopupLabels(context.getString(R.string.double_clear), context.getString(R.string.triple_clear))
        layoutDirty = true
        bumpContent()
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        running = true
        renderThread = RenderThread().also { it.start() }
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        surfaceW = width
        surfaceH = height
        layoutDirty = true
        bumpContent()
    }

    /**
     * Stop the render thread and wait for it to exit. Idempotent.
     *
     * Call this from the main thread BEFORE hiding the board (visibility=GONE). Tearing the
     * SurfaceView down while the render thread still holds a buffer dequeued inside
     * lockHardwareCanvas races SurfaceFlinger's buffer teardown and blocks the main-thread
     * traversal for ~1-2s on return-to-lobby (measured: Choreographer "Skipped 57 frames",
     * HWUI "Davey! 1016ms", "buffers were freed while being dequeued"). Stopping first — while
     * the surface is still valid — lets the thread finish its in-flight lock/unlockCanvas and
     * exit, so the join is bounded to the current frame (~16ms) and the teardown is clean.
     *
     * The join loops until the thread is confirmed dead: a still-running thread that then drew
     * onto a recycled bitmap would throw "trying to use a recycled bitmap" (or touch a dead
     * Surface), so callers must never free bitmaps until this returns.
     */
    fun stopRenderThread() {
        running = false
        // Wake a parked thread so the join below is bounded by its in-flight frame
        // rather than by the park timeout.
        contentLock.withLock { contentChanged.signalAll() }
        renderThread?.let { t ->
            var joined = false
            while (!joined) {
                try {
                    t.join()
                    joined = true
                } catch (_: InterruptedException) {
                    // Retry the join; never proceed until the thread is confirmed dead.
                }
            }
        }
        renderThread = null
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        // Normally the thread is already stopped by showScreen(LOBBY) before the surface is
        // hidden (that's what avoids the teardown race); this handles surface loss we don't
        // initiate (backgrounding, config change). Either way the thread is dead before the
        // bitmaps are freed.
        stopRenderThread()
        for (r in renderers) r.recycle()
        renderers = emptyList()
        stampCache.clear()
        qrCache.clear()
        // Drop live anims BEFORE recycling their stamp bitmaps (each anim holds
        // its stamp reference; a surviving one would draw a recycled bitmap).
        animations.clear()
        animations.releaseStamps()
        garbageIndicator.clear()
        garbageDefence.clear()
        pendingByPlayer.clear()
    }

    // ── Render thread ─────────────────────────────────────────────────────────

    private inner class RenderThread : Thread("hex-render") {
        override fun run() {
            val h = holder
            var lastDrawnVersion = -1L
            var animating = true
            while (running) {
                // Idle park: nothing pushed since the last draw and no wall-clock
                // animation/pulse running — the frame would be identical, so wait to be
                // woken instead of burning GPU on it (countdown, pause, and results
                // screens spend nearly all their time here, and so does ordinary
                // gameplay between grid steps).
                //
                // Re-checked INSIDE the monitor: a bumpContent() landing between the
                // test and the lock would otherwise not be seen, and the thread would
                // sit out the whole timeout with a fresh snapshot already waiting. The
                // timeout is a belt-and-braces bound, not the wake mechanism.
                if (contentVersion == lastDrawnVersion && !animating) {
                    parkUntilContentChanges(lastDrawnVersion)
                    continue
                }
                var canvas: Canvas? = null
                try {
                    // Capture BEFORE drawing: content pushed mid-draw keeps the version
                    // ahead of lastDrawnVersion, so the next iteration re-renders it.
                    val version = contentVersion
                    canvas = h.lockHardwareCanvas()
                    if (canvas == null) {
                        sleep(8)
                        continue
                    }
                    animating = drawFrame(canvas)
                    lastDrawnVersion = version
                } catch (t: Throwable) {
                    // Surface-teardown races land here benignly (running flips false first);
                    // anything else would silently blank the board forever, so leave a trace.
                    if (running) Log.w(TAG, "drawFrame failed", t)
                } finally {
                    if (canvas != null) runCatching { h.unlockCanvasAndPost(canvas) }
                }
            }
        }
    }

    /**
     * Park the render thread until an ingress method signals new content (or the app
     * stops). [lastDrawnVersion] is re-tested inside the lock because a `bumpContent()`
     * between the caller's test and this one would otherwise go unseen and leave a
     * fresh snapshot waiting out the whole timeout.
     */
    private fun parkUntilContentChanges(lastDrawnVersion: Long) {
        contentLock.withLock {
            if (!running || contentVersion != lastDrawnVersion) return
            // An interrupt here means teardown; `running` is already false by then, so
            // returning simply lets the loop re-test and exit.
            runCatching { contentChanged.await(IDLE_PARK_MS, TimeUnit.MILLISECONDS) }
        }
    }

    /**
     * Test-only: render one full multi-board frame straight onto [canvas], bypassing
     * the SurfaceView render thread (which needs a real Surface + hardware canvas that
     * a headless JVM/Robolectric run has no way to provide). This is the exact path the
     * render thread runs every vsync, so a screenshot captured through it is a genuine
     * in-game frame. Call after [setViewport] + [submitSnapshot].
     */
    @VisibleForTesting
    internal fun renderFrameForTest(canvas: Canvas) = drawFrame(canvas)

    /** Returns true while any wall-clock animation is live (board pulses, overlay
     *  anims, garbage fx) — the render thread must keep drawing frames for those even
     *  though no new content arrives; false lets it idle-skip. */
    private fun drawFrame(canvas: Canvas): Boolean {
        val nowMs = SystemClock.uptimeMillis().toDouble()

        if (layoutDirty) rebuildLayout()

        canvas.drawColor(Theme.bgPrimary.toArgb()) // full clear (#1E1A2B)

        animations.beginFrame(nowMs)
        drainEvents(nowMs)
        pruneGarbageFx(nowMs)

        var pulsing = false
        val snap = latestSnapshot
        if (snap == null) {
            // Pre-game static boards.
            for (i in renderers.indices) {
                val seat = seats.getOrNull(i) ?: continue
                pulsing = renderers[i].render(canvas, emptySnapshotFor(i, seat), nowMs) || pulsing
            }
        } else {
            val players = snap.players
            for (j in players.indices) {
                val r = renderers.getOrNull(j) ?: continue
                val player = players[j]
                val shake = animations.shakeOffsetFor(r.boardX, r.boardY)
                val shaking = shake.x != 0f || shake.y != 0f
                if (shaking) {
                    canvas.save()
                    canvas.translate(shake.x, shake.y)
                }
                pulsing = r.render(canvas, player, nowMs) || pulsing
                r.drawGarbageEffects(canvas, garbageIndicator[player.id], nowMs, 0.2) // incoming attack
                r.drawGarbageEffects(canvas, garbageDefence[player.id], nowMs, 0.3)   // defence flash
                disconnects[player.id]?.let { url ->
                    r.drawDisconnectedOverlay(canvas, qrCache.get(url))
                }
                if (shaking) canvas.restore()
            }
            // Remember this frame's pending as the "old" value for next frame's cancel rowStart.
            for (p in players) pendingByPlayer[p.id] = p.pendingGarbage
        }

        animations.update(nowMs)
        animations.render(canvas)

        snap?.elapsed?.let { drawTimer(canvas, it) }

        // Garbage fx maps are pruned to empty above once their windows expire, so
        // non-empty means a meter flash is still animating.
        return pulsing || !animations.isIdle() ||
            garbageIndicator.isNotEmpty() || garbageDefence.isNotEmpty()
    }

    private fun drainEvents(nowMs: Double) {
        while (true) {
            val e = eventQueue.poll() ?: break
            dispatch(e, nowMs)
        }
    }

    private fun dispatch(e: GameEvent, nowMs: Double) {
        when (e.type) {
            EventType.PIECE_LOCK -> {
                val r = rendererFor(e.playerId) ?: return
                val blocks = e.blocks ?: return
                val tid = e.typeId ?: return
                animations.addHexLockFlash(r, blocks, colorInt(Theme.pieceColors[tid] ?: TvColors.white))
            }
            EventType.LINE_CLEAR -> {
                val r = rendererFor(e.playerId) ?: return
                val cells = e.clearCells ?: return
                val lines = e.lines ?: return
                animations.addHexCellClear(r, cells, lines)
            }
            EventType.GARBAGE_SENT -> {
                val toId = e.toId ?: return
                val lines = e.lines ?: return
                rendererFor(toId)?.let { animations.addGarbageShake(it.boardX, it.boardY) } // shake the RECEIVER
                val attacker = e.senderId?.let { seatColorInt(it) } ?: TvColors.white.toArgb()
                // Shift existing indicators up by `lines`, drop scrolled-off, push the new one
                // over the top rows of the (grown) meter. Port of onGarbageSent (DisplayGame.js).
                val list = garbageIndicator.getOrPut(toId) { mutableListOf() }
                for (fx in list) fx.rowStart -= lines
                list.removeAll { it.rowStart + it.lines <= 0 }
                list.add(GarbageFx(nowMs, 1000.0, 0.94, attacker, lines, maxOf(0, VIS_ROWS - lines)))
            }
            EventType.GARBAGE_CANCELLED -> {
                val pid = e.playerId ?: return
                val lines = e.lines ?: return
                val oldPending = pendingByPlayer[pid] ?: 0
                val cancelled = minOf(lines, oldPending)
                if (cancelled > 0) {
                    // Flash the rows that vanish from the TOP of the old meter
                    // (cream defence — web _getDefenceColor = text.primary, A2).
                    garbageDefence.getOrPut(pid) { mutableListOf() }
                        .add(GarbageFx(nowMs, 400.0, 0.9, Theme.textPrimary.toArgb(), cancelled, VIS_ROWS - oldPending))
                }
                // Front-trim indicator effects by the cancelled amount (defended garbage).
                garbageIndicator[pid]?.let { list ->
                    var remaining = lines
                    while (remaining > 0 && list.isNotEmpty()) {
                        val front = list[0]
                        if (front.lines <= remaining) { remaining -= front.lines; list.removeAt(0) }
                        else { front.lines -= remaining; front.rowStart += remaining; remaining = 0 }
                    }
                }
            }
            EventType.PLAYER_KO -> {
                val r = rendererFor(e.playerId) ?: return
                animations.addKO(r.boardX, r.boardY, r.boardWidth, r.boardHeight, r.cellSize.toDouble(), r.outlineAbsPath(0.0))
            }
        }
    }

    /** Attacker's identity color as ARGB, resolved from the seat roster (null if unknown). */
    private fun seatColorInt(playerId: Int): Int? {
        val idx = seatIndexByPlayerId[playerId] ?: return null
        val slot = seats.getOrNull(idx)?.colorSlot ?: return null
        return Theme.playerColor(slot).toArgb()
    }

    /** Drop expired garbage effects (age >= duration); empty player lists are removed. */
    private fun pruneGarbageFx(nowMs: Double) {
        pruneFxMap(garbageIndicator, nowMs)
        pruneFxMap(garbageDefence, nowMs)
    }

    private fun pruneFxMap(map: HashMap<Int, MutableList<GarbageFx>>, nowMs: Double) {
        val it = map.values.iterator()
        while (it.hasNext()) {
            val list = it.next()
            list.removeAll { fx -> nowMs - fx.startMs >= fx.durationMs }
            if (list.isEmpty()) it.remove()
        }
    }

    private fun rendererFor(playerId: Int?): BoardRenderer? {
        val pid = playerId ?: return null
        val seat = seatIndexByPlayerId[pid] ?: return null
        return renderers.getOrNull(seat)
    }

    private fun rebuildLayout() {
        // Clear the flag BEFORE snapshotting the inputs: a setViewport()/surfaceChanged()
        // landing mid-rebuild re-marks it and the next frame rebuilds with the fresh
        // values. Clearing at the end would swallow that concurrent update.
        layoutDirty = false
        val w = surfaceW
        val h = surfaceH
        val s = seats
        if (w <= 0 || h <= 0 || s.isEmpty()) { layoutDirty = true; return } // not ready; retry next frame

        for (r in renderers) r.recycle()

        val n = if (playerCount > 0) playerCount else s.size
        // Keep boards inside the TV title-safe area: lay out within a 5%-inset
        // rectangle and shift each origin by the margin (surface stays full-bleed).
        val marginX = w * Theme.Size.tvOverscan
        val marginY = h * Theme.Size.tvOverscan
        val layout = LayoutEngine.layout(n, w - 2 * marginX, h - 2 * marginY, textHeightOverride)
        gridRows = layout.gridRows

        val newRenderers = ArrayList<BoardRenderer>(layout.placements.size)
        val idx = HashMap<Int, Int>()
        for ((i, pl) in layout.placements.withIndex()) {
            val seat = s.getOrNull(i) ?: continue
            newRenderers.add(
                BoardRenderer(
                    context = context,
                    geometry = layout.geometry,
                    boardX = (pl.originX + marginX).toFloat(),
                    boardY = (pl.originY + marginY).toFloat(),
                    colorSlot = seat.colorSlot,
                    name = seat.name,
                    stampCache = stampCache,
                    fonts = fonts,
                ),
            )
            idx[seat.playerId] = i
        }
        renderers = newRenderers
        seatIndexByPlayerId = idx
        animations.clear()
        // Fresh match layout: drop any garbage effects / stale pending / timer string
        // (render-thread state, safe to clear here).
        garbageIndicator.clear()
        garbageDefence.clear()
        pendingByPlayer.clear()
        emptySnapshots = arrayOfNulls(newRenderers.size)
        timerCachedSeconds = -1L
    }

    // ── Timer (port of DisplayUI.drawTimer) ──────────────────────────────────
    private fun drawTimer(canvas: Canvas, elapsedMs: Double) {
        val totalSeconds = floor(elapsedMs / 1000.0).toLong()
        // The string only changes once per second; reuse it (and the advances array) otherwise.
        if (totalSeconds != timerCachedSeconds) {
            timerCachedSeconds = totalSeconds
            timerCachedStr = String.format(Locale.US, "%02d:%02d", totalSeconds / 60, totalSeconds % 60)
            timerGlyphs = Array(timerCachedStr.length) { timerCachedStr[it].toString() }
        }
        val timeStr = timerCachedStr

        // Fixed size relative to view height, not cell size, so the clock reads the
        // same regardless of board count and matches the web/tvOS renderers (all
        // three size off full screen height; only the position is title-safe inset).
        // Two board rows (7-8 players) leave no free band above the top boards, so
        // shrink the clock to sit inside the name-label band instead of overlapping
        // the board frames (web drawTimer applies the same factor).
        var timerSize = max(24f, min(surfaceH * 0.04f, 60f))
        if (gridRows > 1) timerSize *= 0.6f
        // Nudge the clock into the same TV title-safe margin as the boards, matching
        // tvOS (which positions the timer inside playRect). Web has no inset (margin 0).
        val marginX = surfaceW * Theme.Size.tvOverscan.toFloat()
        val marginY = surfaceH * Theme.Size.tvOverscan.toFloat()
        val labelSize = timerSize.roundToInt().toFloat()
        val digitAdvance = labelSize * 0.92f
        val colonAdvance = labelSize * 0.52f

        if (timerAdvances.size < timeStr.length) timerAdvances = FloatArray(timeStr.length)
        val advances = timerAdvances // reused across frames; grown above for long matches
        var timerWidth = 0f
        for (i in timeStr.indices) {
            val a = if (timeStr[i] == ':') colonAdvance else digitAdvance
            advances[i] = a
            timerWidth += a
        }

        val n = renderers.size
        // Odd board counts: left-anchor (a centered clock overlaps the middle board).
        // Centering is unchanged by the inset (symmetric margins keep it at surfaceW/2).
        val startX = if (n > 0 && n % 2 == 1) {
            marginX + timerSize * 0.3f
        } else {
            surfaceW / 2f - timerWidth / 2f
        }
        val y = marginY + timerSize * 0.6f

        timerPaint.textSize = labelSize
        var cursorX = startX
        for (k in timeStr.indices) {
            val charX = cursorX + advances[k] / 2f
            canvas.drawTextB(timerGlyphs[k], charX, y, timerPaint, TextBaseline.TOP)
            cursorX += advances[k]
        }
    }

    /** Cached empty PlayerState for seat [index], rebuilt only if its id/level changed. */
    private fun emptySnapshotFor(index: Int, seat: SeatMeta): PlayerState {
        if (emptySnapshots.size <= index) emptySnapshots = emptySnapshots.copyOf(index + 1)
        val cached = emptySnapshots[index]
        if (cached != null && cached.id == seat.playerId && cached.level == seat.startLevel) {
            return cached
        }
        return emptySnapshot(seat).also { emptySnapshots[index] = it }
    }

    private fun emptySnapshot(seat: SeatMeta): PlayerState = PlayerState(
        id = seat.playerId,
        grid = EMPTY_GRID,
        currentPiece = null,
        ghost = null,
        holdPiece = null,
        nextPieces = emptyList(),
        level = seat.startLevel,
        lines = 0,
        alive = true,
        pendingGarbage = 0,
        clearingCells = null,
        gridVersion = 0,
    )

    private companion object {
        private const val TAG = "BoardSurfaceView"

        /** Upper bound on an idle park. A bumpContent() signal is what actually wakes the
         *  thread; this only bounds the wait if a wake is ever missed. */
        private const val IDLE_PARK_MS = 50L
        private const val VIS_ROWS = EngineConstants.VISIBLE_ROWS // 15
        private val EMPTY_GRID: List<List<Int>> =
            List(EngineConstants.VISIBLE_ROWS) { List(EngineConstants.COLS) { 0 } }
    }
}
