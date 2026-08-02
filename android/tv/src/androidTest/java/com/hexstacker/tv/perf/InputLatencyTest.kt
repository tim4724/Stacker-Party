package com.hexstacker.tv.perf

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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
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
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToLong

/**
 * End-to-end controller-input latency inside the display brain: from the moment a
 * decoded INPUT lands on the coordinator's inbound callback (exactly where
 * WebRtcFastlane's executor hands it over) to the moment a snapshot carrying that
 * input's effect reaches [DisplayOutput.renderSnapshot] — i.e. the moment the board
 * would repaint.
 *
 * Everything but the radio and the pixels is the shipping code: the real
 * DisplayCoordinator and the real EngineBridge sharing one game thread as MainActivity
 * wires them, over the real `partycore.js`, with a real 60 Hz tick loop. What it does NOT
 * include is the render thread's own wake + draw + present, so treat the numbers as a floor.
 *
 * Correlation is by CONTENT, not by call order: a left/right input moves
 * `currentPiece.anchorCol`, so a sample only completes on a snapshot whose anchorCol
 * actually changed. A tick's own repaint landing in between cannot short-circuit it.
 */
@RunWith(AndroidJUnit4::class)
class InputLatencyTest {

    // The SHIPPING shape: MainActivity runs the coordinator and the engine on one game
    // thread, so these are the live numbers. 2-4 players is the ordinary party, so those
    // are the ones that get quoted.
    @Test fun latency1Player() = runLatency(players = 1, busyPeers = 0)
    @Test fun latency2Players() = runLatency(players = 2, busyPeers = 0)
    @Test fun latency3PlayersAllBusy() = runLatency(players = 3, busyPeers = 2)
    @Test fun latency4Players() = runLatency(players = 4, busyPeers = 0)
    @Test fun latency4PlayersAllBusy() = runLatency(players = 4, busyPeers = 3)
    @Test fun latency8Players() = runLatency(players = 8, busyPeers = 0)

    /** Every other seat hammering input too — the party case the TV is actually for. */
    @Test fun latency8PlayersAllBusy() = runLatency(players = 8, busyPeers = 7)

    /**
     * The one measurement that settles the one-game-thread change, because it is the only
     * one immune to run order. Each test above gets its own JUnit instance, so whichever
     * runs first pays ART's JIT and the four-case ranking ends up reflecting order as much
     * as cost (the first pass here showed 4-player "legacy" beating "shipping" purely by
     * running 7th instead of 1st). This runs BOTH shapes inside ONE method, twice each,
     * alternating —
     * so a real difference shows as both passes agreeing, and warm-up shows as pass 2
     * beating pass 1 in both shapes.
     *
     * legacy = the pre-game-thread shape: coordinator on `Dispatchers.Main`, engine on its
     * own dispatcher, so an input crossed the action channel to Main and then hopped to the
     * engine thread and back.
     */
    @Test fun shapeComparison4Players() = runBlocking { compareShapes(players = 4, busyPeers = 0) }
    @Test fun shapeComparison8Players() = runBlocking { compareShapes(players = 8, busyPeers = 0) }

    private suspend fun compareShapes(players: Int, busyPeers: Int) {
        Log.i(TAG, "=== shape A/B, $players player(s), alternating, 2 passes each ===")
        for (pass in 1..2) {
            for (oneThread in listOf(false, true)) {
                measureLatency(players, busyPeers, oneThread, pass)
            }
        }
    }

    private fun runLatency(players: Int, busyPeers: Int, oneThread: Boolean = true) = runBlocking {
        measureLatency(players, busyPeers, oneThread, pass = 0)
    }

    // coroutineScope: the 60 Hz ticker below is a child job, and `launch` needs a scope.
    private suspend fun measureLatency(
        players: Int,
        busyPeers: Int,
        oneThread: Boolean,
        pass: Int,
    ): Unit = coroutineScope {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }

        val out = LatencyOutput()
        val transport = FakeTransport()
        // One dedicated thread shared by the coordinator AND the bridge, or the shipping
        // split (coordinator on Main, engine on its own dispatcher).
        val gameExec = if (oneThread) Executors.newSingleThreadExecutor { r -> Thread(r, "game") } else null
        val gameDispatcher = gameExec?.asCoroutineDispatcher()
        val coordinatorDispatcher = gameDispatcher ?: Dispatchers.Main // what MainActivity uses
        val coordinator = DisplayCoordinator(
            transport = transport,
            output = out,
            bridgeProvider = {
                bridge ?: (
                    if (gameDispatcher != null) EngineBridge.create(bundleJs, gameDispatcher)
                    else EngineBridge.create(bundleJs)
                    ).also { bridge = it }
            },
            seedProvider = { SEED },
            onError = { label, e -> Log.w(TAG, "coordinator error: $label", e) },
            dispatcher = coordinatorDispatcher,
        )
        coordinator.start()
        transport.onCreated?.invoke("TEST", null, null)
        for (i in 0 until players) {
            transport.onPeerJoined?.invoke(i)
            transport.onMessage?.invoke(i, buildJsonObject { put("type", Msg.HELLO); put("name", "P$i") })
        }
        coordinator.awaitIdle()

        // Start the match and tick the 3-2-1 out (the coordinator drives the countdown
        // off accumulated tick time, so this is real elapsed countdown, not a skip).
        transport.onMessage?.invoke(0, buildJsonObject { put("type", Msg.START_GAME) })
        repeat(20) { coordinator.tick(200.0) } // 4s > 3x1000 + 500 GO hold
        coordinator.awaitIdle()
        check(out.screen == DisplayScreen.GAME) { "expected GAME, got ${out.screen}" }

        // The 60 Hz render clock, exactly as MainActivity drives it.
        val ticker = launch(coordinatorDispatcher) {
            while (true) {
                coordinator.tick(16.667)
                delay(16)
            }
        }
        // Background seats generating their own input, off the main thread — the load
        // the coordinator's single action consumer really sees at a full party.
        val noise = Executors.newSingleThreadScheduledExecutor()
        if (busyPeers > 0) {
            noise.scheduleAtFixedRate({
                for (p in 1..busyPeers) transport.onMessage?.invoke(p, input(if (p % 2 == 0) "left" else "right"))
            }, 0, INPUT_PERIOD_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        }

        delay(500) // let gravity settle the first piece

        // Warm ART's JIT on the whole round trip before sampling. Without this the
        // measurement is dominated by which test ran FIRST in the process, not by what
        // it measures — the four cases used to rank by player count purely because the
        // per-input cost scaled with it, and once that scaling was removed they ranked
        // by run order instead. Discarded samples, same code path as the real ones.
        for (i in 0 until WARMUP) {
            val before = out.anchorCol(TRACKED) ?: continue
            val done = CompletableDeferred<Long>()
            out.arm(TRACKED, before, done)
            transport.onMessage?.invoke(TRACKED, input(if (i % 2 == 0) "left" else "right"))
            withTimeoutOrNull(500) { done.await() }
            out.disarm()
            delay(INPUT_PERIOD_MS)
        }

        val samples = ArrayList<Long>(SAMPLES)
        var misses = 0
        for (i in 0 until SAMPLES) {
            val before = out.anchorCol(TRACKED)
            if (before == null) { misses++; delay(INPUT_PERIOD_MS); continue }
            val done = CompletableDeferred<Long>()
            out.arm(TRACKED, before, done)
            val t0 = System.nanoTime()
            transport.onMessage?.invoke(TRACKED, input(if (i % 2 == 0) "left" else "right"))
            val t1 = withTimeoutOrNull(500) { done.await() }
            out.disarm()
            if (t1 == null) misses++ else samples.add(t1 - t0)
            delay(INPUT_PERIOD_MS) // ~a held finger's repeat rate
        }

        // Stop the tick loop and let it settle BEFORE closing the bridge below: a tick
        // still in flight would evaluate against a closed QuickJS and spray the log with
        // "Already closed" teardown noise that reads like a real engine failure.
        ticker.cancelAndJoin()
        noise.shutdownNow()
        coordinator.awaitIdle()

        val label = "$players player(s)" + (if (busyPeers > 0) ", $busyPeers busy" else "") +
            (if (oneThread) " [shipping: one game thread]" else " [legacy: coordinator on Main]") +
            if (pass > 0) " pass $pass" else ""
        Log.i(TAG, "=== input -> renderSnapshot, $label ===")
        report(samples, misses)
        Log.i(TAG, String.format("renderSnapshot rate during run: %.1f/s", out.renderRate()))
        bridge?.close()
        bridge = null
        if (gameExec != null) gameExec.shutdown() // not `?.`: JUnit rejects a Unit? test method
    }

    private fun report(samples: List<Long>, misses: Int) {
        if (samples.isEmpty()) { Log.i(TAG, "no samples (misses=$misses)"); return }
        val s = samples.sorted()
        fun p(q: Double) = s[((s.size - 1) * q).roundToLong().toInt()] / 1e6
        Log.i(
            TAG,
            String.format(
                "n=%-4d misses=%-3d mean=%6.2fms  p50=%6.2f  p95=%6.2f  p99=%6.2f  max=%6.2f",
                s.size, misses, s.average() / 1e6, p(0.5), p(0.95), p(0.99), p(1.0),
            ),
        )
    }

    private fun input(action: String): JsonObject =
        buildJsonObject { put("type", Msg.INPUT); put("action", action) }

    // ── fakes ────────────────────────────────────────────────────────────────

    /** Records every renderSnapshot and completes an armed sample once the tracked
     *  player's anchorCol actually moved. */
    private class LatencyOutput : DisplayOutput {
        @Volatile var screen: DisplayScreen = DisplayScreen.LOBBY
        @Volatile private var latest: GameSnapshot? = null
        @Volatile private var renders = 0
        private var firstRenderNs = 0L
        private val armed = AtomicReference<Armed?>(null)

        class Armed(val playerId: Int, val was: Int, val done: CompletableDeferred<Long>)

        fun arm(playerId: Int, was: Int, done: CompletableDeferred<Long>) =
            armed.set(Armed(playerId, was, done))

        fun disarm() = armed.set(null)

        fun anchorCol(playerId: Int): Int? =
            latest?.players?.firstOrNull { it.id == playerId }?.currentPiece?.anchorCol

        fun renderRate(): Double {
            val dt = (System.nanoTime() - firstRenderNs) / 1e9
            return if (dt > 0) renders / dt else 0.0
        }

        override fun renderSnapshot(snapshot: GameSnapshot) {
            val now = System.nanoTime()
            if (renders == 0) firstRenderNs = now
            renders++
            latest = snapshot
            val a = armed.get() ?: return
            val col = snapshot.players.firstOrNull { it.id == a.playerId }?.currentPiece?.anchorCol
            if (col != null && col != a.was && armed.compareAndSet(a, null)) a.done.complete(now)
        }

        override fun showScreen(screen: DisplayScreen) { this.screen = screen }
        override fun roomReady(room: String, joinUrl: String) {}
        override fun roomClosed() {}
        override fun updateLobby(players: List<PlayerRecord>, hostPeerIndex: Int?) {}
        override fun showCountdown(value: CountdownValue) {}
        override fun showResults(results: List<ResultEntry>) {}
        override fun playCountdownBeep(go: Boolean) {}
        override fun startMusic() {}
        override fun stopMusic() {}
        override fun pauseMusic() {}
        override fun resumeMusic() {}
    }

    /** Swallows everything outbound; the inbound callbacks are the injection points. */
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

    private var bridge: EngineBridge? = null

    private companion object {
        const val TAG = "HexPerf"
        const val SEED = 12345L
        const val TRACKED = 0
        const val WARMUP = 120
        const val SAMPLES = 150
        const val INPUT_PERIOD_MS = 60L // a held finger repeats around here
    }
}
