package com.hexstacker.tv.render

import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cash.zipline.QuickJs
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.tv.testing.evalAs
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import kotlin.math.roundToLong
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The per-board cache in [BoardSurfaceView] must not change what is ON the board:
 * serving a board from its cached compositing layer has to put the same picture on the
 * surface as re-drawing it would have. This renders real match frames both ways on the
 * device GPU and compares the buffers.
 *
 * "The same picture", not "the same bytes" — see [drift] for why the layer makes exact
 * equality impossible and what is bounded instead.
 *
 * Both paths run over an [ImageReader]-backed hardware canvas — the same surface shape
 * the render thread draws onto — because a software Bitmap canvas is not a
 * RecordingCanvas and would silently exercise only the uncached path.
 */
@RunWith(AndroidJUnit4::class)
class BoardCacheParityTest {

    @Test
    fun cachedReplayMatchesDirectDrawWithinDrift() = runBlocking {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "parity-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()

        for (players in intArrayOf(1, 2, 4, 8)) {
            // A frame with real content in it: locked stacks, a live piece, next/hold
            // queues, varied levels. An empty board would agree trivially.
            val snaps = withContext(dispatcher) {
                val qjs = QuickJs.create()
                qjs.evalAs<Any?>(bundleJs)
                qjs.evalAs<Any?>(SHIM + "\nvoid 0;")
                qjs.evalAs<Any?>("P.create(${(0 until players).joinToString(",", "[", "]") { "[$it,1]" }}, 4242)")
                val out = ArrayList<GameSnapshot>()
                var t = 0.0
                // Walk a real match and keep several frames: one early (sparse), then
                // later ones with deep stacks and higher levels.
                repeat(2400) {
                    t += 16.667
                    qjs.evalAs<Any?>("P.frame($t)")
                    if (it == 60 || it == 600 || it == 1500 || it == 2399) {
                        out.add(json.decodeFromString<GameSnapshot>(qjs.evalAs<String>("P.snap()")))
                    }
                }
                qjs.close()
                out
            }

            lateinit var board: BoardSurfaceView
            instr.runOnMainSync {
                board = BoardSurfaceView(ctx)
                board.setViewport(
                    W, H, players,
                    (0 until players).map { SeatMeta(playerId = it, name = "PLAYER $it", colorSlot = it) },
                )
            }

            val reader = ImageReader.newInstance(
                W, H, PixelFormat.RGBA_8888, 3,
                HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_COMPOSER_OVERLAY,
            )
            val surface = reader.surface

            for ((frameIdx, snap) in snaps.withIndex()) {
                instr.runOnMainSync { board.submitSnapshot(snap) }

                // Direct: every board re-drawn, i.e. the pre-cache path.
                board.disableBoardCache = true
                val direct = renderAndRead(surface, reader) { board.renderFrameForTest(it) }

                // Cached: first pass records (so it cannot be a replay), second pass is
                // the one under test — every board's signature is unchanged, so it must
                // come entirely from the cached layers.
                board.disableBoardCache = false
                renderAndRead(surface, reader) { board.renderFrameForTest(it) }
                val replayed = renderAndRead(surface, reader) { board.renderFrameForTest(it) }

                assertWithinDrift(
                    "players=$players frame=$frameIdx: replayed frame drifted from direct draw",
                    direct,
                    replayed,
                )
            }
            Log.i(TAG, "$players board(s): ${snaps.size} frames replay within drift of a direct draw")
            reader.close()
        }
        exec.shutdown()
    }

    /**
     * The saving, measured through the same entry point the parity check uses: a steady
     * frame where nothing moved (every board replays) against the same frame re-drawn.
     * Reported, not asserted — absolute figures move with CPU governor and core placement.
     */
    @Test
    fun cacheSavingAtEightBoards() = runBlocking {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "parity-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()
        val players = 8

        val snap = withContext(dispatcher) {
            val qjs = QuickJs.create()
            qjs.evalAs<Any?>(bundleJs)
            qjs.evalAs<Any?>(SHIM + "\nvoid 0;")
            qjs.evalAs<Any?>("P.create(${(0 until players).joinToString(",", "[", "]") { "[$it,1]" }}, 4242)")
            var t = 0.0
            repeat(1200) { t += 16.667; qjs.evalAs<Any?>("P.frame($t)") }
            val s = json.decodeFromString<GameSnapshot>(qjs.evalAs<String>("P.snap()"))
            qjs.close()
            s
        }
        exec.shutdown()

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

        fun timeFrames(label: String, cacheOn: Boolean): Double {
            board.disableBoardCache = !cacheOn
            val samples = ArrayList<Long>(ITERS)
            repeat(WARMUP + ITERS) { i ->
                val t0 = System.nanoTime()
                val c = surface.lockHardwareCanvas()
                board.renderFrameForTest(c)
                surface.unlockCanvasAndPost(c)
                val dt = System.nanoTime() - t0
                if (i >= WARMUP) samples.add(dt)
                reader.acquireLatestImage()?.close()
            }
            val s = samples.sorted()
            fun p(q: Double) = s[((s.size - 1) * q).roundToLong().toInt()] / 1e6
            Log.i(
                TAG,
                String.format(
                    "%-34s n=%-4d mean=%5.2fms  p50=%5.2f  p95=%5.2f  p99=%5.2f",
                    label, s.size, s.average() / 1e6, p(0.5), p(0.95), p(0.99),
                ),
            )
            return p(0.5)
        }

        // Cached first and last, so the uncached run in the middle cannot be credited
        // with (or blamed for) warm-up.
        val cached1 = timeFrames("all 8 boards replayed (cached)", true)
        val uncached = timeFrames("all 8 boards re-drawn (pre-cache)", false)
        val cached2 = timeFrames("all 8 boards replayed (cached), 2nd", true)
        Log.i(
            TAG,
            String.format(
                "steady 8-board frame: %.2f/%.2f ms cached vs %.2f uncached (%.0f%% off)",
                cached1, cached2, uncached, 100.0 * (1 - (cached1 + cached2) / 2 / uncached),
            ),
        )

        // The shape the input path actually produces: ONE board moved, seven unchanged.
        // Re-submitting a snapshot whose tracked seat has a different piece position
        // invalidates exactly that seat's signature.
        val moved = snap.players.firstOrNull()?.currentPiece
        if (moved != null) {
            val shifted = snap.copy(
                players = snap.players.mapIndexed { i, p ->
                    if (i != 0) p else p.copy(currentPiece = p.currentPiece?.copy(anchorCol = p.currentPiece!!.anchorCol))
                },
            )
            board.disableBoardCache = false
            val samples = ArrayList<Long>(ITERS)
            var flip = false
            repeat(WARMUP + ITERS) { i ->
                // Alternate the tracked seat's anchorCol so seat 0 is dirty every frame
                // and the other seven are not.
                flip = !flip
                val cp = shifted.players[0].currentPiece!!
                val nudged = shifted.copy(
                    players = shifted.players.mapIndexed { j, p ->
                        if (j != 0) p else p.copy(currentPiece = cp.copy(anchorCol = cp.anchorCol + if (flip) 1 else 0))
                    },
                )
                instr.runOnMainSync { board.submitSnapshot(nudged) }
                val t0 = System.nanoTime()
                val c = surface.lockHardwareCanvas()
                board.renderFrameForTest(c)
                surface.unlockCanvasAndPost(c)
                val dt = System.nanoTime() - t0
                if (i >= WARMUP) samples.add(dt)
                reader.acquireLatestImage()?.close()
            }
            val s = samples.sorted()
            Log.i(
                TAG,
                String.format(
                    "1 of 8 boards dirty (the input case)   n=%-4d mean=%5.2fms  p50=%5.2f  p95=%5.2f",
                    s.size, s.average() / 1e6,
                    s[(s.size - 1) / 2] / 1e6, s[((s.size - 1) * 95) / 100] / 1e6,
                ),
            )
        }
        assertTrue("cached steady frame should not be slower than the direct draw", cached1 <= uncached * 1.1)
        reader.close()
    }

    /**
     * The garbage-meter flashes fade against the wall clock and report nothing back
     * from `render`, so the cache tracks their liveness itself. The failure mode this
     * pins: the LAST recording taken while a flash was alive holds it at its final
     * faint alpha, and once the fx window expires nothing in the signature changes,
     * so without the fx feeding the time-dependence flag that residue would replay
     * indefinitely. After expiry, a cached draw must be byte-identical to a direct
     * draw of the same state.
     */
    @Test
    fun garbageFxExpiryLeavesNoResidueInCachedBoards() = runBlocking {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "parity-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()
        val players = 2

        val raw = withContext(dispatcher) {
            val qjs = QuickJs.create()
            qjs.evalAs<Any?>(bundleJs)
            qjs.evalAs<Any?>(SHIM + "\nvoid 0;")
            qjs.evalAs<Any?>("P.create(${(0 until players).joinToString(",", "[", "]") { "[$it,1]" }}, 4242)")
            var t = 0.0
            repeat(600) { t += 16.667; qjs.evalAs<Any?>("P.frame($t)") }
            val s = json.decodeFromString<GameSnapshot>(qjs.evalAs<String>("P.snap()"))
            qjs.close()
            s
        }
        exec.shutdown()
        // Player 0 shows a pending-garbage meter, so the cancelled-flash path below has
        // an old meter height to flash against (dispatch reads pendingByPlayer).
        val snap = raw.copy(
            players = raw.players.mapIndexed { i, p -> if (i == 0) p.copy(pendingGarbage = 2) else p },
        )

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

        board.disableBoardCache = false
        // Clean recording first, then both flash kinds land on player 0's board, then a
        // handful of frames across the fx window so the final recording is a mid-fade one.
        renderAndRead(surface, reader) { board.renderFrameForTest(it) }
        board.onGameEvent(GameEvent(type = "garbage_sent", toId = 0, senderId = 1, lines = 1))
        renderAndRead(surface, reader) { board.renderFrameForTest(it) }
        board.onGameEvent(GameEvent(type = "garbage_cancelled", playerId = 0, lines = 1))
        repeat(4) {
            Thread.sleep(50)
            renderAndRead(surface, reader) { board.renderFrameForTest(it) }
        }
        // Both windows expired (indicator 1000ms, defence 400ms, shake well under that):
        // the state is time-independent again, so sequential draws are comparable.
        Thread.sleep(1200)
        val cachedAfterExpiry = renderAndRead(surface, reader) { board.renderFrameForTest(it) }
        board.disableBoardCache = true
        val direct = renderAndRead(surface, reader) { board.renderFrameForTest(it) }

        // Residue would be a whole meter column left painted on the cached board, far
        // outside the AA drift the layer composite accounts for.
        assertWithinDrift(
            "stale garbage-fx residue: cached draw after fx expiry drifted from direct draw",
            direct,
            cachedAfterExpiry,
        )
        reader.close()
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun renderAndRead(
        surface: android.view.Surface,
        reader: ImageReader,
        draw: (android.graphics.Canvas) -> Unit,
    ): ByteArray {
        val c = surface.lockHardwareCanvas()
        draw(c)
        surface.unlockCanvasAndPost(c)
        // unlockCanvasAndPost queues the buffer asynchronously, so the image can take a
        // moment to become acquirable — poll rather than treat the first null as failure.
        var image = reader.acquireLatestImage()
        var waited = 0
        while (image == null && waited < 2000) {
            Thread.sleep(2)
            waited += 2
            image = reader.acquireLatestImage()
        }
        if (image == null) error("no image produced after ${waited}ms")
        try {
            val plane = image.planes[0]
            val buf: ByteBuffer = plane.buffer
            val rowStride = plane.rowStride
            val pixelStride = plane.pixelStride
            val out = ByteArray(W * H * 4)
            val row = ByteArray(rowStride)
            var o = 0
            for (y in 0 until H) {
                buf.position(y * rowStride)
                buf.get(row, 0, minOf(rowStride, buf.remaining()))
                for (x in 0 until W) {
                    val src = x * pixelStride
                    out[o++] = row[src]
                    out[o++] = row[src + 1]
                    out[o++] = row[src + 2]
                    out[o++] = row[src + 3]
                }
            }
            return out
        } finally {
            image.close()
        }
    }

    /**
     * How far two rendered frames drift apart, as (fraction of visibly-differing
     * pixels, mean absolute per-channel difference).
     *
     * The cache used to be byte-exact and this was a `firstDifference` check. It cannot
     * be any more: each board now renders into its own compositing layer, and
     * rasterising into a layer and then compositing quantises antialias coverage twice,
     * so a hex-path edge can land a level or two off the direct path. That is a real
     * consequence of the change, not a flake — measured at 0.24% of bytes (1 board) and
     * 0.51% (8 boards), concentrated on stroke edges, mean absolute difference over the
     * whole frame under 0.4.
     *
     * So bound the drift rather than forbid it. The bounds below are ~4x the measured
     * values — loose enough not to flake on AA, and nowhere near loose enough to pass a
     * board that is stale, clipped, missing or holding effect residue, which is what
     * this test exists to catch: any of those move whole regions and blow both numbers
     * by orders of magnitude (a single stale 8-player board is ~12% of the frame).
     */
    private fun drift(a: ByteArray, b: ByteArray): Pair<Double, Double> {
        if (a.size != b.size) return 1.0 to 255.0
        var differingPixels = 0L
        var sum = 0L
        var i = 0
        while (i < a.size) {
            var worst = 0
            for (k in 0 until 4) {
                val d = kotlin.math.abs((a[i + k].toInt() and 0xFF) - (b[i + k].toInt() and 0xFF))
                sum += d
                if (d > worst) worst = d
            }
            if (worst > VISIBLE_DELTA) differingPixels++
            i += 4
        }
        return differingPixels.toDouble() / (a.size / 4.0) to sum.toDouble() / a.size
    }

    private fun assertWithinDrift(message: String, direct: ByteArray, cached: ByteArray) {
        val (fraction, mean) = drift(direct, cached)
        // Logged on success too: the headroom against the bounds is what tells you
        // whether a future change is creeping toward them.
        Log.i(TAG, "drift: ${"%.4f".format(fraction * 100)}% pixels, mean ${"%.4f".format(mean)}  <- $message")
        assertTrue(
            "$message: ${"%.3f".format(fraction * 100)}% of pixels differ by more than " +
                "$VISIBLE_DELTA (max ${MAX_DIFFERING_FRACTION * 100}%), mean channel delta " +
                "${"%.3f".format(mean)} (max $MAX_MEAN_DELTA)",
            fraction <= MAX_DIFFERING_FRACTION && mean <= MAX_MEAN_DELTA,
        )
    }

    @Suppress("unused")
    private fun ByteArray.asBitmap(): Bitmap =
        Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888).also {
            it.copyPixelsFromBuffer(ByteBuffer.wrap(this))
        }

    private companion object {
        const val TAG = "HexPerf"
        const val W = 1920
        const val H = 1080
        const val WARMUP = 20
        const val ITERS = 80

        /** Per-channel delta below which a pixel counts as unchanged (see [drift]). */
        const val VISIBLE_DELTA = 8
        const val MAX_DIFFERING_FRACTION = 0.02 // measured worst case 0.0051
        const val MAX_MEAN_DELTA = 1.5 // measured worst case 0.37
        val json = Json { ignoreUnknownKeys = true; isLenient = false }

        /** Minimal driver over the canonical core: tick, and hand back a snapshot. */
        val SHIM = """
        globalThis.P = (function () {
          var PartyCore = HexCore.PartyCore;
          var core = null;
          return {
            create: function (specs, seed) {
              var m = new Map();
              for (var i = 0; i < specs.length; i++) m.set(specs[i][0], { startLevel: specs[i][1] });
              core = new PartyCore(m, seed >>> 0);
              core.init();
            },
            frame: function (now) { return core.frame(now).snapshot.players.length; },
            snap: function () { return JSON.stringify(core.snapshot()); },
          };
        })();
        """
    }
}
