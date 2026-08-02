package com.hexstacker.tv.render

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

/**
 * Debug frame-cost HUD, drawn by [BoardSurfaceView]'s render loop into the very frame it
 * measures. Off unless `settings put global hexstacker_perf 1` (see
 * `MainActivity.refreshPerfHudSetting`, re-read on every foreground). Deliberately
 * styled as a debug readout — monospace green on a black slab — so it can never be
 * mistaken for product UI if one ever ships enabled by accident.
 *
 * WHY this exists rather than Android Studio's frame profiler: the board renders on its
 * own thread through `SurfaceHolder.lockHardwareCanvas()`, which never enters the app's
 * HWUI/ViewRootImpl pipeline. So `dumpsys gfxinfo` and Studio's "Janky frames" see the
 * Compose chrome ONLY — and during GAME the chrome composes nothing but overlays. They
 * will report a healthy 60fps while the board is dropping frames.
 *
 * What each number is actually telling you:
 *  - `draw` — wall time inside [BoardSurfaceView.drawFrame]: the CPU cost of recording
 *    the frame. On a tile-based deferred GPU (this TV is a PowerVR Rogue GE9215)
 *    submission is cheap and rasterisation is not, so a low `draw` does NOT mean the
 *    frame was cheap. That is the same trap `RenderThroughputTest` documents.
 *  - `lock` — time blocked in `lockHardwareCanvas()`. THIS is the GPU signal: once the
 *    GPU falls behind, the swap chain runs dry and the dequeue blocks. It is the same
 *    backpressure `RenderThroughputTest` measures sustained throughput against.
 *    Climbing toward the refresh interval means GPU-bound.
 *  - `tick` — wall time of one `DisplayCoordinator.tick()` on the game thread, i.e. the
 *    QuickJS engine step. Separates "the engine is slow" from "the paint is slow".
 *
 * `post/s` is frames POSTED per second, and it is deliberately NOT called fps: on this
 * view a low value is usually correct, not a stall. The render loop idle-parks whenever
 * no content changed and no wall-clock animation is live, and the engine's scene
 * signature already drops render-identical snapshots — so one board at level-1 gravity
 * settles at about 1 post/s (the clock's second rolling over) while `tps` still reads 60.
 * The per-frame costs (`draw`, `lock`) are the figures that mean the same thing in every
 * state; read those to judge health, and `post/s` to understand what work was skipped.
 *
 * Each figure is `mean/max` over the last [WINDOW_MS]. This is an instrument for watching
 * a real match from the couch, not a benchmark: the tick samples cross a thread boundary
 * and a window flip can drop one. The `perf` instrumentation tests remain the measurement
 * of record.
 */
internal class PerfHud {

    // Recorded AND rendered on the render thread, so these need no publication.
    private var frames = 0
    private var lockSumNs = 0L
    private var lockMaxNs = 0L
    private var drawSumNs = 0L
    private var drawMaxNs = 0L
    private var windowStartNs = 0L
    private var boardLine = "board  --"
    private var engineLine = "engine --"

    // Written by the game thread, drained here. Atomic so a drain racing a sample can
    // only lose that sample, never corrupt the accumulator.
    private val tickSumNs = AtomicLong(0)
    private val tickMaxNs = AtomicLong(0)
    private val tickCount = AtomicInteger(0)

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.MONOSPACE
        color = 0xFF3DFF8B.toInt()
    }
    private val slabPaint = Paint().apply { color = 0xC0000000.toInt() }

    /** Game thread: cost of one `DisplayCoordinator.tick()`. */
    fun recordTick(ns: Long) {
        tickSumNs.addAndGet(ns)
        tickCount.incrementAndGet()
        tickMaxNs.updateAndGet { if (ns > it) ns else it }
    }

    /**
     * Render thread: one loop iteration. [lockNs] is the time blocked acquiring the
     * buffer, [drawNs] the time spent recording the frame. Call BEFORE drawing the HUD
     * so its own cost stays out of the numbers it reports.
     */
    fun recordFrame(lockNs: Long, drawNs: Long) {
        frames++
        lockSumNs += lockNs
        drawSumNs += drawNs
        if (lockNs > lockMaxNs) lockMaxNs = lockNs
        if (drawNs > drawMaxNs) drawMaxNs = drawNs
    }

    /** Paint the readout at the bottom-left, inside the title-safe margin. */
    fun draw(canvas: Canvas, surfaceH: Int, marginX: Float, marginY: Float) {
        val now = System.nanoTime()
        if (windowStartNs == 0L) windowStartNs = now
        val elapsedNs = now - windowStartNs
        if (elapsedNs >= WINDOW_MS * 1_000_000L) {
            rebuildLines(elapsedNs)
            windowStartNs = now
        }

        val size = max(13f, surfaceH * 0.019f)
        textPaint.textSize = size
        val pad = size * 0.5f
        val lineH = size * 1.35f
        val w = max(textPaint.measureText(boardLine), textPaint.measureText(engineLine)) + pad * 2f
        val h = lineH * 2f + pad * 2f
        val left = marginX
        val top = surfaceH - marginY - h

        canvas.drawRect(left, top, left + w, top + h, slabPaint)
        // TOP baseline so the two lines sit on an even pitch regardless of the face's
        // ascent, matching how drawTimer places its glyphs.
        canvas.drawTextB(boardLine, left + pad, top + pad, textPaint, TextBaseline.TOP)
        canvas.drawTextB(engineLine, left + pad, top + pad + lineH, textPaint, TextBaseline.TOP)
    }

    /** Fold the window into two display strings, then reset it. Strings are rebuilt at
     *  most every [WINDOW_MS] so the HUD does not allocate per frame in the loop it is
     *  supposed to be measuring. */
    private fun rebuildLines(elapsedNs: Long) {
        val seconds = elapsedNs / 1_000_000_000.0
        val n = frames
        boardLine = if (n == 0) {
            "board  idle (no frames posted)"
        } else {
            // "post/s", not "fps": frames POSTED, which is legitimately ~1 on a quiet
            // board (see the class doc). Labelling it fps invites reading a working
            // idle-park as a stall.
            String.format(
                Locale.US,
                "board  post/s %-3d draw %.1f/%.1f  lock %.1f/%.1f",
                (n / seconds).toInt(),
                drawSumNs.toDouble() / n / 1e6,
                drawMaxNs / 1e6,
                lockSumNs.toDouble() / n / 1e6,
                lockMaxNs / 1e6,
            )
        }
        val ticks = tickCount.getAndSet(0)
        val tickSum = tickSumNs.getAndSet(0)
        val tickMax = tickMaxNs.getAndSet(0)
        engineLine = if (ticks == 0) {
            "engine idle (no ticks)"
        } else {
            String.format(
                Locale.US,
                "engine tps %-3d tick %.1f/%.1f ms",
                (ticks / seconds).toInt(),
                tickSum.toDouble() / ticks / 1e6,
                tickMax / 1e6,
            )
        }
        frames = 0
        lockSumNs = 0L
        lockMaxNs = 0L
        drawSumNs = 0L
        drawMaxNs = 0L
    }

    private companion object {
        /** Averaging window. Long enough that the figures are readable rather than
         *  flickering, short enough to see a stutter you just caused. */
        const val WINDOW_MS = 500L
    }
}
