package com.hexstacker.tv.perf

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.engine.InputAction
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.net.ControllerMessage
import com.hexstacker.core.net.Msg
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.Executors
import kotlin.math.roundToLong

/**
 * Splits the "brain" — the ~2.4 ms between an input reaching the coordinator and a snapshot
 * reaching the renderer, as `InputLatencyTest` measures it — into its stages.
 *
 * It exists because that number had become a residual: the JS binding is now ~0.08 ms and
 * the packed decode ~0.15 ms, which together account for a fraction of it, and the rest was
 * being attributed to "coordinator plumbing" by subtraction. Subtraction is not a
 * measurement, and optimising against it would be guesswork.
 *
 * Each stage is driven exactly as `DisplayCoordinator.onMessage` → `handleInput` drives it,
 * on ONE thread (the shipping shape: coordinator and engine share the game thread), so the
 * figures add up to something comparable with `InputLatencyTest`.
 */
@RunWith(AndroidJUnit4::class)
class BrainPerfTest {

    @Test
    fun whereTheBrainTimeGoes() = runBlocking {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "brain") }
        val dispatcher = exec.asCoroutineDispatcher()

        val bridge = EngineBridge.create(bundleJs, dispatcher)
        for (players in intArrayOf(2, 4, 8)) {
            header("brain stages, $players player(s)")
            bridge.createGame((0 until players).map { EngineBridge.PlayerSpec(it, 1) }, SEED)
            // Settle real content into the boards: an empty board under-measures the
            // per-seat copy and the decode both.
            var now = 0.0
            repeat(900) { now += 16.667; bridge.frame(now) }
            var snapshot: GameSnapshot = bridge.snapshot()

            // 1. The inbound message, as onMessage sees it: a parsed JsonObject that still
            //    has to become a ControllerMessage before anything can dispatch on it.
            val inputJson = buildJsonObject { put("type", Msg.INPUT); put("action", "left") }
            measure("ControllerMessage.from(JsonObject)", 400) {
                ControllerMessage.from(inputJson)
            }
            measure("InputAction.fromWire", 400) { InputAction.fromWire("left") }

            // 2. The action channel + coroutine resume. Both the fastlane and the relay
            //    reach the coordinator through this, and it is on the input path twice
            //    over (inbound message, and the tick's ack) — worth pricing on its own.
            val channel = Channel<Int>(Channel.UNLIMITED)
            val drained = Channel<Int>(Channel.UNLIMITED)
            val consumer = launch(dispatcher) { for (v in channel) drained.trySend(v) }
            measureSuspend("Channel send -> consumer resume", 400) {
                channel.trySend(1)
                drained.receive()
            }
            consumer.cancel()

            // 3. The engine crossing itself: ONE call, batch fused in, packed payload,
            //    decoded to objects. This is what render-on-input actually does.
            //
            // ON the engine dispatcher, which is the whole point: production runs the
            // coordinator there too, so `withContext(dispatcher)` inside EngineBridge does
            // not dispatch. Measuring from the instrumentation thread instead adds a full
            // thread round trip (~0.6-1.2 ms) that the app never pays — the first version
            // of this test did exactly that and made the call look like 2.2 ms.
            val batch = listOf(0 to InputAction.LEFT)
            withContext(dispatcher) {
                measureSuspend("bridge.snapshotPlayer(id, batch)", 300) {
                    bridge.snapshotPlayer(0, batch)
                }
                // The same crossing with no input to apply, so the batch's share shows.
                measureSuspend("bridge.snapshotPlayer(id, empty)", 300) {
                    bridge.snapshotPlayer(0, emptyList())
                }
            }
            // For contrast: the same call made from OFF the engine thread, i.e. what the
            // pre-game-thread split shape paid on every input.
            measureSuspend("bridge.snapshotPlayer, off-thread caller", 200) {
                bridge.snapshotPlayer(0, batch)
            }

            // 4. The merge handleInput does on the way out: rebuild the retained room with
            //    the one moved seat swapped in. Allocates a players list per input.
            val pulled = bridge.snapshotPlayer(0, emptyList())!!
            val moved = pulled.players.first()
            measure("merge moved seat into retained room", 400) {
                snapshot.copy(
                    players = snapshot.players.map { if (it.id == moved.id) moved else it },
                    elapsed = pulled.elapsed,
                )
            }

            // 5. A whole tick, for scale: what the 60 Hz loop costs beside all this.
            withContext(dispatcher) {
                measureSuspend("bridge.frame(now, batch) [the tick]", 300) {
                    now += 16.667
                    bridge.frame(now, batch)
                }
            }
            snapshot = bridge.snapshot()
        }
        bridge.close()
        exec.shutdown()
    }

    /**
     * `snapshotPlayer` is ~80% of the brain and — the telling part — costs the SAME at two
     * seats as at eight. A per-seat pull that does not scale with room size is not paying
     * for the other seats, so the cost is something flat. This splits it into JS work, the
     * packed encode, the boundary crossing and the Kotlin decode, against a private runtime
     * so each stage can be called on its own.
     *
     * It was written to test a suspicion that turned out to be right: `snapshotPlayer`
     * deep-copied the seat through `copyPlayer`, grid included, and `_stripUnchangedGrids`
     * then DELETED that grid on almost every pull — a render-on-input pull happens between
     * locks, so `gridVersion` has not moved. Every input duplicated 135 cells to throw them
     * straight away. `deliverSnapshotPlayerPacked` now consults the ledger first, so the
     * `snapshotPlayer` row below is the post-fix cost; the strip-first variant this test
     * used to carry is gone, because it is what production does now and a hand-copy of
     * `copyPlayer` in a test string would only diverge from it.
     */
    @Test
    fun whereTheSeatPullTimeGoes() = runBlocking {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "seat-pull") }
        val dispatcher = exec.asCoroutineDispatcher()

        withContext(dispatcher) {
            val qjs = app.cash.zipline.QuickJs.create()
            try {
                qjs.evaluate(bundleJs, "partycore.js")
                qjs.evaluate(SEAT_SHIM, "shim.js")
                for (players in intArrayOf(2, 8)) {
                    header("one seat pull, $players player(s)")
                    qjs.evaluate(
                        "S.create(${(0 until players).joinToString(",", "[", "]") { "[$it,1]" }}, 12345)",
                        "call.js",
                    )
                    var t = 0.0
                    repeat(900) { t += 16.667; qjs.evaluate("S.frame($t)", "call.js") }
                    qjs.evaluate("S.deliverPlayerLen(0)", "call.js") // prime the strip ledger

                    measure("js: game.getSnapshot() [live refs]", 300) {
                        qjs.evaluate("S.getSnapLen()", "call.js")
                    }
                    measure("js: snapshotPlayer() [copyPlayer]", 300) {
                        qjs.evaluate("S.snapPlayerLen(0)", "call.js")
                    }
                    measure("js: + strip + pack, length only", 300) {
                        qjs.evaluate("S.deliverPlayerLen(0)", "call.js")
                    }
                    measure("js: same, payload crosses to Kotlin", 300) {
                        qjs.evaluate("S.deliverPlayer(0)", "call.js")
                    }
                    val payload = qjs.evaluate("S.deliverPlayer(0)", "call.js") as String
                    Log.i(TAG, "  packed seat payload: ${payload.length} chars")
                }
            } finally {
                qjs.close()
            }
        }
        exec.shutdown()
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun header(text: String) = Log.i(TAG, "=== $text ===")

    private fun measure(label: String, iters: Int, body: () -> Unit) {
        repeat(iters / 4) { body() }
        val samples = ArrayList<Long>(iters)
        repeat(iters) {
            val t0 = System.nanoTime()
            body()
            samples.add(System.nanoTime() - t0)
        }
        report(label, samples)
    }

    private suspend fun measureSuspend(label: String, iters: Int, body: suspend () -> Unit) {
        repeat(iters / 4) { body() }
        val samples = ArrayList<Long>(iters)
        repeat(iters) {
            val t0 = System.nanoTime()
            body()
            samples.add(System.nanoTime() - t0)
        }
        report(label, samples)
    }

    private fun report(label: String, samples: List<Long>) {
        val s = samples.sorted()
        fun p(q: Double) = s[((s.size - 1) * q).roundToLong().toInt()] / 1000.0
        Log.i(
            TAG,
            String.format(
                "%-42s n=%-4d mean=%8.1fus  p50=%8.1f  p95=%8.1f",
                label, s.size, s.average() / 1000.0, p(0.5), p(0.95),
            ),
        )
    }

    private companion object {
        const val TAG = "HexPerf"
        const val SEED = 12345L

        /**
         * Drives PartyCore's per-seat pull directly, one stage per entry point, so the
         * ~2 ms can be attributed rather than subtracted. `*Len` variants return a length
         * instead of the payload, so the boundary crossing can be isolated from the work.
         *
         */
        val SEAT_SHIM = """
        globalThis.S = (function () {
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
            getSnapLen: function () { return core.game.getSnapshot().players.length; },
            snapPlayerLen: function (pid) { var s = core.snapshotPlayer(pid); return s ? s.players.length : 0; },
            deliverPlayerLen: function (pid) { var s = core.deliverSnapshotPlayerPacked(pid); return s ? s.length : 0; },
            deliverPlayer: function (pid) { return core.deliverSnapshotPlayerPacked(pid); },
          };
        })();
        """
    }
}
