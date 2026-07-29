package com.hexstacker.tv.perf

import android.graphics.PixelFormat
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hexstacker.core.display.CountdownValue
import com.hexstacker.core.display.DisplayCoordinator
import com.hexstacker.core.display.DisplayOutput
import com.hexstacker.core.display.DisplayScreen
import com.hexstacker.core.display.ResultEntry
import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.net.Msg
import com.hexstacker.core.net.RelayTransport
import com.hexstacker.core.room.PlayerRecord
import com.hexstacker.tv.render.BoardSurfaceView
import com.hexstacker.tv.render.SeatMeta
import com.hexstacker.tv.render.boardLayersEnabled
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.roundToLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Controller input to PIXELS ON THE SURFACE, at a 4-board layout.
 *
 * [InputLatencyTest] stops at `renderSnapshot` and says so — it excludes "the render
 * thread's own wake + draw + present", which is most of what a player perceives as the
 * board reacting. This carries the same input all the way to a posted frame:
 *
 *   input decoded -> coordinator -> engine tick -> snapshot -> submitSnapshot
 *     -> render thread wakes -> drawFrame -> unlockCanvasAndPost
 *
 * Everything but the radio and the physical panel is shipping code: the real
 * DisplayCoordinator and EngineBridge sharing one game thread the way MainActivity wires
 * them, over the real `partycore.js` at a real 60 Hz tick, feeding a real
 * [BoardSurfaceView] laid out for four seats and drawing onto a real hardware canvas.
 *
 * The render thread here mirrors the shipping one's SHAPE rather than reusing it (that
 * one is private and starts from a real `surfaceCreated`): it parks on a condition, is
 * signalled at the same instant `submitSnapshot` signals the real one, then draws and
 * posts. Wake cost is therefore a like-for-like condition signal, not a poll.
 *
 * Correlation is by CONTENT, not call order: a left/right input moves
 * `currentPiece.anchorCol`, and a sample only completes on a POSTED FRAME that was drawn
 * from a snapshot whose anchorCol actually moved. Gravity repaints in between cannot
 * short-circuit it.
 *
 * NOT included, and additive on top of these numbers: SurfaceFlinger composition and
 * scanout, which cost up to one refresh interval (16.7 ms at 60 Hz) before light
 * actually changes on the panel.
 *
 * Not in CI (needs a real TV). Run:
 *   ./gradlew :tv:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.hexstacker.tv.perf.InputToDisplayLatencyTest
 * and read the `HexPerf` logcat tag.
 */
@RunWith(AndroidJUnit4::class)
class InputToDisplayLatencyTest {

    /** The shipping configuration at the layout the question is about. */
    @Test
    fun inputToDisplay4Boards() = runBlocking {
        // Both cache shapes, alternating, two passes each: this device's clocks drift
        // enough that a single sequential pair would show run order as a difference.
        for (pass in 1..2) {
            for (layers in listOf(true, false)) {
                measure(players = 4, busyPeers = 0, layers = layers, pass = pass)
            }
        }
    }

    /** Every other seat hammering input too — the party case the TV is actually for. */
    @Test
    fun inputToDisplay4BoardsAllBusy() = runBlocking {
        measure(players = 4, busyPeers = 3, layers = true, pass = 0)
    }

    private suspend fun measure(
        players: Int,
        busyPeers: Int,
        layers: Boolean,
        pass: Int,
    ): Unit = coroutineScope {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }

        // ── the display surface + its render thread ──────────────────────────
        boardLayersEnabled = layers
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

        val out = LatencyOutput()
        val renderLock = ReentrantLock()
        val renderWake = renderLock.newCondition()
        // `pending` is only touched under renderLock, which supplies the happens-before;
        // `running` is read outside it, so it needs its own atomic.
        var pending = false
        val running = java.util.concurrent.atomic.AtomicBoolean(true)
        out.onSnapshot = {
            board.submitSnapshot(it)
            renderLock.withLock { pending = true; renderWake.signalAll() }
        }

        val renderThread = Thread({
            while (running.get()) {
                renderLock.withLock {
                    while (running.get() && !pending) renderWake.await()
                    pending = false
                }
                if (!running.get()) break
                // Read the state this frame is about to draw BEFORE drawing it, so the
                // completion below can be attributed to the right input.
                val drawnCol = out.anchorCol(TRACKED)
                val c = surface.lockHardwareCanvas() ?: continue
                board.renderFrameForTest(c)
                surface.unlockCanvasAndPost(c)
                val posted = System.nanoTime()
                reader.acquireLatestImage()?.close()
                out.onFramePosted(drawnCol, posted)
            }
        }, "test-render").also { it.start() }

        // ── the shipping brain: coordinator + engine on ONE game thread ──────
        val gameExec = Executors.newSingleThreadExecutor { r -> Thread(r, "game") }
        val gameDispatcher = gameExec.asCoroutineDispatcher()
        val transport = FakeTransport()
        var bridge: EngineBridge? = null
        val coordinator = DisplayCoordinator(
            transport = transport,
            output = out,
            bridgeProvider = { bridge ?: EngineBridge.create(bundleJs, gameDispatcher).also { bridge = it } },
            seedProvider = { SEED },
            onError = { label, e -> Log.w(TAG, "coordinator error: $label", e) },
            dispatcher = gameDispatcher,
        )
        coordinator.start()
        transport.onCreated?.invoke("TEST", null, null)
        for (i in 0 until players) {
            transport.onPeerJoined?.invoke(i)
            transport.onMessage?.invoke(i, buildJsonObject { put("type", Msg.HELLO); put("name", "P$i") })
        }
        coordinator.awaitIdle()

        transport.onMessage?.invoke(0, buildJsonObject { put("type", Msg.START_GAME) })
        repeat(20) { coordinator.tick(200.0) } // tick the real 3-2-1 out
        coordinator.awaitIdle()
        check(out.screen == DisplayScreen.GAME) { "expected GAME, got ${out.screen}" }

        val ticker = launch(gameDispatcher) {
            while (true) {
                coordinator.tick(16.667)
                delay(16)
            }
        }
        val noise = Executors.newSingleThreadScheduledExecutor()
        if (busyPeers > 0) {
            noise.scheduleAtFixedRate({
                for (p in 1..busyPeers) transport.onMessage?.invoke(p, input(if (p % 2 == 0) "left" else "right"))
            }, 0, INPUT_PERIOD_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        }
        delay(500) // let gravity settle the first piece

        // Warm ART's JIT over the WHOLE round trip, draw included; discarded.
        repeat(WARMUP) { i ->
            val before = out.anchorCol(TRACKED)
            if (before != null) {
                val done = CompletableDeferred<Sample>()
                out.arm(TRACKED, before, done)
                transport.onMessage?.invoke(TRACKED, input(if (i % 2 == 0) "left" else "right"))
                withTimeoutOrNull(500) { done.await() }
                out.disarm()
            }
            delay(INPUT_PERIOD_MS)
        }

        val total = ArrayList<Long>(SAMPLES)
        val brain = ArrayList<Long>(SAMPLES)
        var misses = 0
        for (i in 0 until SAMPLES) {
            val before = out.anchorCol(TRACKED)
            if (before == null) { misses++; delay(INPUT_PERIOD_MS); continue }
            val done = CompletableDeferred<Sample>()
            out.arm(TRACKED, before, done)
            val t0 = System.nanoTime()
            transport.onMessage?.invoke(TRACKED, input(if (i % 2 == 0) "left" else "right"))
            val s = withTimeoutOrNull(500) { done.await() }
            out.disarm()
            if (s == null) misses++ else {
                total.add(s.postedNs - t0)
                brain.add(s.snapshotNs - t0)
            }
            delay(INPUT_PERIOD_MS)
        }

        ticker.cancelAndJoin()
        noise.shutdownNow()
        coordinator.awaitIdle()
        running.set(false)
        renderLock.withLock { pending = true; renderWake.signalAll() }
        renderThread.join()

        val shape = if (layers) "compositing layer" else "display-list only"
        val label = "$players board(s)" + (if (busyPeers > 0) ", $busyPeers busy" else "") +
            " [$shape]" + if (pass > 0) " pass $pass" else ""
        Log.i(TAG, "=== input -> POSTED FRAME, $label ===")
        report("  input -> snapshot (brain)  ", brain, 0)
        report("  input -> posted frame      ", total, misses)
        if (total.isNotEmpty() && brain.isNotEmpty()) {
            val t = total.sorted()[total.size / 2] / 1e6
            val b = brain.sorted()[brain.size / 2] / 1e6
            Log.i(
                TAG,
                String.format(
                    "  render half (wake+draw+post) p50 = %.2f ms;  + up to one 16.7 ms vsync to scanout",
                    t - b,
                ),
            )
        }
        bridge?.close()
        gameExec.shutdown()
        reader.close()
        boardLayersEnabled = true
    }

    private fun report(prefix: String, samples: List<Long>, misses: Int) {
        if (samples.isEmpty()) { Log.i(TAG, "$prefix no samples (misses=$misses)"); return }
        val s = samples.sorted()
        fun p(q: Double) = s[((s.size - 1) * q).roundToLong().toInt()] / 1e6
        Log.i(
            TAG,
            String.format(
                "%s n=%-4d misses=%-3d mean=%6.2fms  p50=%6.2f  p95=%6.2f  p99=%6.2f  max=%6.2f",
                prefix, s.size, misses, s.average() / 1e6, p(0.5), p(0.95), p(0.99), p(1.0),
            ),
        )
    }

    private fun input(action: String): JsonObject =
        buildJsonObject { put("type", Msg.INPUT); put("action", action) }

    // ── fakes ────────────────────────────────────────────────────────────────

    private class Sample(val snapshotNs: Long, val postedNs: Long)

    /**
     * Bridges the coordinator to the surface and completes a sample only once a POSTED
     * frame carried the moved piece.
     */
    private class LatencyOutput : DisplayOutput {
        @Volatile var screen: DisplayScreen = DisplayScreen.LOBBY
        @Volatile private var latest: GameSnapshot? = null
        @Volatile var onSnapshot: ((GameSnapshot) -> Unit)? = null
        private val armed = AtomicReference<Armed?>(null)

        class Armed(
            val playerId: Int,
            val was: Int,
            val done: CompletableDeferred<Sample>,
        ) {
            @Volatile var snapshotNs: Long = 0
        }

        fun arm(playerId: Int, was: Int, done: CompletableDeferred<Sample>) =
            armed.set(Armed(playerId, was, done))

        fun disarm() = armed.set(null)

        fun anchorCol(playerId: Int): Int? =
            latest?.players?.firstOrNull { it.id == playerId }?.currentPiece?.anchorCol

        override fun renderSnapshot(snapshot: GameSnapshot) {
            latest = snapshot
            val a = armed.get()
            if (a != null && a.snapshotNs == 0L) {
                val col = snapshot.players.firstOrNull { it.id == a.playerId }?.currentPiece?.anchorCol
                if (col != null && col != a.was) a.snapshotNs = System.nanoTime()
            }
            onSnapshot?.invoke(snapshot)
        }

        /** Called by the render thread once a frame drawn from [drawnCol] is posted. */
        fun onFramePosted(drawnCol: Int?, postedNs: Long) {
            val a = armed.get() ?: return
            if (a.snapshotNs == 0L) return // the moved snapshot has not been produced yet
            if (drawnCol == null || drawnCol == a.was) return // this frame predates the move
            if (armed.compareAndSet(a, null)) a.done.complete(Sample(a.snapshotNs, postedNs))
        }

        override fun showScreen(screen: DisplayScreen) { this.screen = screen }
        override fun roomReady(room: String, joinUrl: String) {}
        override fun updateLobby(players: List<PlayerRecord>, hostPeerIndex: Int?) {}
        override fun showCountdown(value: CountdownValue) {}
        override fun showResults(results: List<ResultEntry>) {}
        override fun playCountdownBeep(go: Boolean) {}
        override fun startMusic() {}
        override fun stopMusic() {}
        override fun pauseMusic() {}
        override fun resumeMusic() {}
    }

    private class FakeTransport : RelayTransport {
        override fun connect() {}
        override fun disconnect() {}
        override fun sendTo(index: Int, data: JsonObject) {}
        override fun broadcast(data: JsonObject) {}
        override fun setState(data: JsonObject) {}
        override fun createFresh() {}
        override fun closeRoom() {}
        override var onCreated: ((String, String?, String?) -> Unit)? = null
        override var onJoined: ((String, List<Int>) -> Unit)? = null
        override var onPeerJoined: ((Int) -> Unit)? = null
        override var onPeerLeft: ((Int) -> Unit)? = null
        override var onMessage: ((Int, JsonObject) -> Unit)? = null
        override var onRelayError: ((String) -> Unit)? = null
        override var onReplaced: (() -> Unit)? = null
        override var onConnectionState: ((RelayTransport.ConnectionState, Int) -> Unit)? = null
    }

    private companion object {
        const val TAG = "HexPerf"
        const val SEED = 12345L
        const val TRACKED = 0
        const val W = 1920
        const val H = 1080
        const val WARMUP = 120
        const val SAMPLES = 150
        const val INPUT_PERIOD_MS = 60L // a held finger repeats around here
    }
}
