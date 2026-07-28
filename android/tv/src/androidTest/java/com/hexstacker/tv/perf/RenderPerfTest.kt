package com.hexstacker.tv.perf

import android.graphics.PixelFormat
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cash.zipline.QuickJs
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.tv.render.BoardSurfaceView
import com.hexstacker.tv.render.SeatMeta
import com.hexstacker.tv.testing.evalAs
import java.util.concurrent.Executors
import kotlin.math.roundToLong
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What one full-screen board repaint costs on the TV's GPU path. Draws through the
 * SAME [BoardSurfaceView.renderFrameForTest] entry point the render thread runs every
 * vsync, onto a real hardware canvas backed by an [ImageReader] (not a software
 * Bitmap, which would measure a completely different pipeline).
 *
 * This is RECORD + submit time on the drawing thread, not GPU completion — but it is
 * the part that sits between "a snapshot arrived" and "a buffer is queued", which is
 * the half of the render latency the app controls.
 */
@RunWith(AndroidJUnit4::class)
class RenderPerfTest {

    @Test
    fun drawCost() = runBlocking {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }

        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "perf-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()

        for (players in intArrayOf(1, 2, 4, 8)) {
            // A snapshot with real content: tick a match far enough that the boards have
            // locked pieces in them (an empty board under-measures the per-cell work).
            val snap = withContext(dispatcher) {
                val qjs = QuickJs.create()
                qjs.evalAs<Any?>(bundleJs)
                qjs.evalAs<Any?>(EnginePerfTest.MEASURE_SHIM + "\nvoid 0;")
                val specs = (0 until players).joinToString(",", "[", "]") { "[$it,1]" }
                qjs.evalAs<Any?>("B.create($specs, 12345)")
                var t = 0.0
                repeat(1200) { t += 16.667; qjs.evalAs<Any?>("B.frameNoJson($t)") }
                val js = qjs.evalAs<String>("B.snapJson()")
                qjs.close()
                json.decodeFromString<GameSnapshot>(js)
            }

            lateinit var board: BoardSurfaceView
            instr.runOnMainSync {
                board = BoardSurfaceView(ctx)
                board.setViewport(
                    W, H, players,
                    (0 until players).map { SeatMeta(playerId = it, name = "PLAYER $it", colorSlot = it) },
                )
                board.submitSnapshot(snap)
            }

            val reader = ImageReader.newInstance(
                W, H, PixelFormat.RGBA_8888, 3,
                HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_COMPOSER_OVERLAY,
            )
            val surface = reader.surface
            val samples = ArrayList<Long>(ITERS)
            repeat(WARMUP + ITERS) { i ->
                val t0 = System.nanoTime()
                val canvas = surface.lockHardwareCanvas()
                board.renderFrameForTest(canvas)
                surface.unlockCanvasAndPost(canvas)
                val dt = System.nanoTime() - t0
                if (i >= WARMUP) samples.add(dt)
                reader.acquireLatestImage()?.close()
            }

            // Split out the full-screen clear: it is a fixed cost independent of board
            // count, so knowing its share says whether the draw is dominated by the
            // boards or by the background it paints them onto.
            val clearSamples = ArrayList<Long>(ITERS)
            repeat(WARMUP + ITERS) { i ->
                val t0 = System.nanoTime()
                val canvas = surface.lockHardwareCanvas()
                canvas.drawColor(android.graphics.Color.BLACK)
                surface.unlockCanvasAndPost(canvas)
                val dt = System.nanoTime() - t0
                if (i >= WARMUP) clearSamples.add(dt)
                reader.acquireLatestImage()?.close()
            }
            val cs = clearSamples.sorted()
            Log.i(TAG, String.format("  clear-only (no boards)  p50=%5.2fms", cs[cs.size / 2] / 1e6))

            val s = samples.sorted()
            fun p(q: Double) = s[((s.size - 1) * q).roundToLong().toInt()] / 1e6
            Log.i(
                TAG,
                String.format(
                    "drawFrame %d board(s) @%dx%d  n=%d mean=%5.2fms  p50=%5.2f  p95=%5.2f  max=%5.2f",
                    players, W, H, s.size, s.average() / 1e6, p(0.5), p(0.95), p(1.0),
                ),
            )
            reader.close()
        }
        exec.shutdown()
    }

    private companion object {
        const val TAG = "HexPerf"
        const val W = 1920
        const val H = 1080
        const val WARMUP = 30
        const val ITERS = 120
        val json = Json { ignoreUnknownKeys = true; isLenient = false }
    }
}
