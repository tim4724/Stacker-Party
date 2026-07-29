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
import com.hexstacker.tv.render.boardLayersEnabled
import com.hexstacker.tv.render.SeatMeta
import com.hexstacker.tv.testing.evalAs
import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.junit.Test
import org.junit.runner.RunWith

/**
 * SUSTAINED cost of the board repaint — the number [RenderPerfTest] cannot see.
 *
 * That test measures one `lockHardwareCanvas` → `unlockCanvasAndPost` round trip, which
 * returns as soon as the commands are SUBMITTED; the GPU finishes them afterwards. On a
 * tile-based deferred GPU (this TV is a PowerVR Rogue GE9215) submission is cheap and
 * rasterisation is not, so that number can sit at 3 ms while the GPU needs far longer to
 * actually retire the frame — and it is the GPU that decides whether 60 fps holds.
 *
 * Here the loop instead runs flat out against a 3-deep [ImageReader] swap chain. Once the
 * GPU falls behind, `lockHardwareCanvas` blocks on dequeue, so throughput converges on the
 * true per-frame GPU cost. Wall time / frames is therefore the sustainable frame time: under
 * 16.67 ms means 60 fps holds with headroom, over it means dropped frames.
 *
 * Not in CI (needs a real TV). Run:
 *   ./gradlew :tv:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.hexstacker.tv.perf.RenderThroughputTest
 * and read the `HexPerf` logcat tag.
 */
@RunWith(AndroidJUnit4::class)
class RenderThroughputTest {

    /**
     * The same 8-board frame at successively smaller render targets — the measurement
     * that rules resolution scaling OUT, and the reason to keep it around.
     *
     * A SurfaceView can render into a buffer smaller than its on-screen size
     * (`SurfaceHolder.setFixedSize`) and let the display scale it back up for free,
     * which looks like the obvious lever for a weaker GPU. It is not: on a Google TV
     * Streamer, 1280x720 is 44% of the pixels and saves only ~15% of the frame (7.09 ms
     * against 8.36 ms), because this frame is bound by per-draw cost — draw calls and
     * antialiased path coverage — not by fill. Trading real image quality for that is a
     * bad deal, and the per-board compositing layer attacks the actual bound instead
     * (see [compositingLayerSaving]).
     */
    @Test
    fun resolutionScaling() = runBlocking {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "perf-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()
        val players = 8

        val snap = withContext(dispatcher) {
            val qjs = QuickJs.create()
            qjs.evalAs<Any?>(bundleJs)
            qjs.evalAs<Any?>(EnginePerfTest.MEASURE_SHIM + "\nvoid 0;")
            val specs = (0 until players).joinToString(",", "[", "]") { "[$it,1]" }
            qjs.evalAs<Any?>("B.create($specs, 12345)")
            var t = 0.0
            repeat(400) { t += 16.667; qjs.evalAs<Any?>("B.frameNoJson($t)") }
            val js = qjs.evalAs<String>("B.snapJson()")
            qjs.close()
            json.decodeFromString<GameSnapshot>(js)
        }

        val sizes = listOf(1920 to 1080, 1600 to 900, 1280 to 720)
        val rigs = sizes.map { (w, h) ->
            lateinit var board: BoardSurfaceView
            instr.runOnMainSync {
                board = BoardSurfaceView(ctx)
                board.setViewport(
                    w, h, players,
                    (0 until players).map { SeatMeta(playerId = it, name = "PLAYER $it", colorSlot = it) },
                )
                board.submitSnapshot(snap)
            }
            val reader = ImageReader.newInstance(
                w, h, PixelFormat.RGBA_8888, 3,
                HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_COMPOSER_OVERLAY,
            )
            Triple(w to h, board, reader)
        }

        fun burst(board: BoardSurfaceView, reader: ImageReader, n: Int): Double {
            val surface = reader.surface
            val t0 = System.nanoTime()
            repeat(n) {
                val c = surface.lockHardwareCanvas()
                board.renderFrameForTest(c)
                surface.unlockCanvasAndPost(c)
                reader.acquireLatestImage()?.close()
            }
            return (System.nanoTime() - t0) / 1e6 / n
        }

        // Cached = the steady state (only boards whose inputs moved re-record);
        // re-record = the frame right after an input. Round-robin + median, because
        // the GPU's clocks drift enough between sequential passes to invent wins.
        for (cached in booleanArrayOf(true, false)) {
            for ((_, board, reader) in rigs) {
                board.disableBoardCache = !cached
                burst(board, reader, WARMUP)
            }
            val samples = HashMap<Pair<Int, Int>, MutableList<Double>>()
            repeat(ROUNDS) {
                for ((size, board, reader) in rigs) {
                    board.disableBoardCache = !cached
                    samples.getOrPut(size) { mutableListOf() }.add(burst(board, reader, ITERS))
                }
            }
            for ((w, h) in sizes) {
                val v = samples.getValue(w to h).sorted()
                val ms = v[v.size / 2]
                Log.i(
                    TAG,
                    String.format(
                        "res %4dx%-4d (%.2f x pixels) %-11s %5.2f ms/frame  [min %5.2f max %5.2f]",
                        w, h, (w * h).toDouble() / (1920.0 * 1080.0),
                        if (cached) "[cached]" else "[re-record]", ms, v.first(), v.last(),
                    ),
                )
            }
        }
        for ((_, board, reader) in rigs) {
            board.disableBoardCache = false
            reader.close()
        }
        exec.shutdown()
    }

    /**
     * What the per-board compositing layer is actually worth, both variants interleaved
     * in ONE process.
     *
     * Two surfaces are built up front — one whose cache nodes render into their own
     * texture, one using display lists alone — and then measured in alternating bursts,
     * reporting the median over the rounds. Comparing two sequential runs (or two
     * builds) cannot answer this: the same build measured 4.26 and 6.46 ms a frame
     * minutes apart purely on clock drift, which is larger than the effect.
     */
    @Test
    fun compositingLayerSaving() = runBlocking {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "perf-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()

        for (players in intArrayOf(1, 4, 8)) {
            val snap = withContext(dispatcher) {
                val qjs = QuickJs.create()
                qjs.evalAs<Any?>(bundleJs)
                qjs.evalAs<Any?>(EnginePerfTest.MEASURE_SHIM + "\nvoid 0;")
                val specs = (0 until players).joinToString(",", "[", "]") { "[$it,1]" }
                qjs.evalAs<Any?>("B.create($specs, 12345)")
                var t = 0.0
                repeat(400) { t += 16.667; qjs.evalAs<Any?>("B.frameNoJson($t)") }
                val js = qjs.evalAs<String>("B.snapJson()")
                qjs.close()
                json.decodeFromString<GameSnapshot>(js)
            }

            // Build one surface per variant. `boardLayersEnabled` is read when a node is
            // created, so warming each surface under its own setting pins it there.
            val rigs = listOf(true, false).map { layers ->
                boardLayersEnabled = layers
                lateinit var b: BoardSurfaceView
                instr.runOnMainSync {
                    b = BoardSurfaceView(ctx)
                    b.setViewport(
                        W, H, players,
                        (0 until players).map { SeatMeta(playerId = it, name = "PLAYER $it", colorSlot = it) },
                    )
                    b.submitSnapshot(snap)
                }
                val rd = ImageReader.newInstance(
                    W, H, PixelFormat.RGBA_8888, 3,
                    HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_COMPOSER_OVERLAY,
                )
                Triple(layers, b, rd)
            }

            fun burst(board: BoardSurfaceView, reader: ImageReader, n: Int): Double {
                val surface = reader.surface
                val t0 = System.nanoTime()
                repeat(n) {
                    val c = surface.lockHardwareCanvas()
                    board.renderFrameForTest(c)
                    surface.unlockCanvasAndPost(c)
                    reader.acquireLatestImage()?.close()
                }
                return (System.nanoTime() - t0) / 1e6 / n
            }

            for ((layers, b, rd) in rigs) {
                boardLayersEnabled = layers
                burst(b, rd, WARMUP) // creates this surface's nodes under its own setting
            }
            boardLayersEnabled = true // production default restored before measuring
            val samples = HashMap<Boolean, MutableList<Double>>()
            repeat(ROUNDS) {
                for ((layers, b, rd) in rigs) {
                    samples.getOrPut(layers) { mutableListOf() }.add(burst(b, rd, ROUND_ITERS))
                }
            }
            val withLayer = samples.getValue(true).sorted()
            val without = samples.getValue(false).sorted()
            val a = withLayer[withLayer.size / 2]
            val d = without[without.size / 2]
            Log.i(
                TAG,
                String.format(
                    "layer A/B %d board(s): display-list only %5.2f ms  ->  compositing layer %5.2f ms" +
                        "  (%+.0f%%)  [layer min %5.2f max %5.2f | list min %5.2f max %5.2f]",
                    players, d, a, 100.0 * (a - d) / d,
                    withLayer.first(), withLayer.last(), without.first(), without.last(),
                ),
            )
            for ((_, _, rd) in rigs) rd.close()
        }
        exec.shutdown()
    }

    @Test
    fun sustainedDrawCost() = runBlocking {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }

        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "perf-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()

        for (players in intArrayOf(1, 4, 8)) {
            // Same fixture as RenderPerfTest: tick a real match far enough that the boards
            // carry locked stacks (an empty board under-measures the per-cell fill work).
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

            // The board cache makes a REPEATED identical frame cheaper than a moving one
            // (every board replays its display list). Toggling the cache off for one pass
            // measures the worst case — every board re-recorded, i.e. the frame right after
            // an input moves a piece — so both bounds are on the record.
            for (cached in booleanArrayOf(true, false)) {
                board.disableBoardCache = !cached
                repeat(WARMUP) {
                    val c = surface.lockHardwareCanvas()
                    board.renderFrameForTest(c)
                    surface.unlockCanvasAndPost(c)
                    reader.acquireLatestImage()?.close()
                }
                val t0 = System.nanoTime()
                repeat(ITERS) {
                    val c = surface.lockHardwareCanvas()
                    board.renderFrameForTest(c)
                    surface.unlockCanvasAndPost(c)
                    reader.acquireLatestImage()?.close()
                }
                val perFrameMs = (System.nanoTime() - t0) / 1e6 / ITERS
                Log.i(
                    TAG,
                    String.format(
                        "sustained %d board(s) %-11s %6.2f ms/frame  (%5.1f fps)  %s",
                        players, if (cached) "[cached]" else "[re-record]",
                        perFrameMs, 1000.0 / perFrameMs,
                        if (perFrameMs <= 16.67) "60fps OK" else "OVER BUDGET",
                    ),
                )
            }
            board.disableBoardCache = false
            reader.close()
        }
        exec.shutdown()
    }

    private companion object {
        const val TAG = "HexPerf"
        const val W = 1920
        const val H = 1080
        const val WARMUP = 60
        const val ITERS = 300
        /** Round-robin repeats for the interleaved comparisons; median across them. */
        const val ROUNDS = 7
        /** Frames per round-robin burst — short, so drift spreads evenly across variants. */
        const val ROUND_ITERS = 60
        val json = Json { ignoreUnknownKeys = true; isLenient = false }
    }
}
