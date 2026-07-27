package com.hexstacker.tv.perf

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.dokar.quickjs.QuickJs
import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.engine.InputAction
import com.hexstacker.core.model.FrameResult
import com.hexstacker.core.model.GameSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.Executors
import kotlin.math.roundToLong

/**
 * On-device latency profile of the input -> engine -> snapshot path, run against the
 * REAL `dist/partycore.js` the app ships in its assets. Not wired into CI: run it by
 * hand against a TV with `./gradlew :tv:connectedDebugAndroidTest \
 *   -Pandroid.testInstrumentationRunnerArguments.class=com.hexstacker.tv.perf.EnginePerfTest`
 * and read the `HexPerf` logcat tag.
 *
 * Splits every hot call into its three real costs — QuickJS compute, `JSON.stringify`,
 * kotlinx decode — because the app pays all three per input (DisplayCoordinator's
 * render-on-input pulls a full snapshot) and only the first is irreducible.
 */
@RunWith(AndroidJUnit4::class)
class EnginePerfTest {

    private val bundle: String by lazy {
        InstrumentationRegistry.getInstrumentation().targetContext
            .assets.open("partycore.js").bufferedReader().use { it.readText() }
    }

    // ── measurement helpers ──────────────────────────────────────────────────

    private class Stats(val label: String, samples: LongArray) {
        val sorted = samples.sortedArray()
        val n = sorted.size
        fun pct(p: Double): Double = sorted[((n - 1) * p).roundToLong().toInt()] / 1000.0 // us
        val mean = sorted.average() / 1000.0
        override fun toString(): String = String.format(
            "%-34s n=%-4d mean=%8.1fus  p50=%8.1f  p95=%8.1f  p99=%8.1f  max=%8.1f",
            label, n, mean, pct(0.50), pct(0.95), pct(0.99), pct(1.0),
        )
    }

    private inline fun measure(label: String, warmup: Int, iters: Int, body: (Int) -> Unit): Stats {
        repeat(warmup) { body(it) }
        val samples = LongArray(iters)
        for (i in 0 until iters) {
            val t0 = System.nanoTime()
            body(warmup + i)
            samples[i] = System.nanoTime() - t0
        }
        return Stats(label, samples).also { Log.i(TAG, it.toString()) }
    }

    private fun header(text: String) = Log.i(TAG, "=== $text ===")

    // ── 1. bundle bootstrap ──────────────────────────────────────────────────

    @Test
    fun bootstrapCost() = runBlocking {
        header("bootstrap (bundle ${bundle.length / 1024} KB)")
        // Not looped: this happens once per process and the second parse would hit warm
        // caches that the real cold start never sees.
        val t0 = System.nanoTime()
        val bridge = EngineBridge.create(bundle)
        val ms = (System.nanoTime() - t0) / 1e6
        Log.i(TAG, String.format("EngineBridge.create (cold)          %.1f ms", ms))
        bridge.close()
    }

    // ── 2. the input path, through the real EngineBridge ─────────────────────

    /**
     * What DisplayCoordinator.handleInput actually costs per controller tap: a
     * `processInput` eval plus (for the first input of each frame) a full
     * `snapshot()` = stringify + decode. Measured from a foreign thread, so the
     * `withContext(dispatcher)` hops the app pays are included.
     */
    @Test
    fun inputPath() = runBlocking {
        val bridge = EngineBridge.create(bundle)
        for (players in PLAYER_COUNTS) {
            header("input path, $players player(s)")
            bridge.createGame((0 until players).map { EngineBridge.PlayerSpec(it, 1) }, SEED)
            // Prime the grid cache + scene signature with one real frame.
            bridge.frame(0.0)

            measure("processInput (eval + 1 hop)", 50, 300) { i ->
                runBlocking { bridge.processInput(i % players, if (i % 2 == 0) InputAction.LEFT else InputAction.RIGHT) }
            }
            measure("snapshot() (stringify+decode)", 20, 200) {
                runBlocking { bridge.snapshot() }
            }
            measure("input+snapshot (one tap)", 20, 200) { i ->
                runBlocking {
                    bridge.processInput(i % players, if (i % 2 == 0) InputAction.LEFT else InputAction.RIGHT)
                    bridge.snapshot()
                }
            }
            var now = 1000.0
            measure("frame() (tick + maybe snapshot)", 30, 400) {
                now += 16.667
                runBlocking { bridge.frame(now) }
            }
        }
        bridge.close()
    }

    // ── 3. where the time inside a call goes ─────────────────────────────────

    /**
     * The same work split three ways on ONE thread (no coroutine hops), against a
     * private QuickJS with a measurement shim: engine compute, `JSON.stringify`,
     * kotlinx decode. This is what says whether the input path is engine-bound or
     * marshalling-bound.
     */
    @Test
    fun costBreakdown() = runBlocking {
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "perf-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()
        withContext(dispatcher) {
            val qjs = QuickJs.create(dispatcher)
            qjs.evaluate<Any?>(bundle)
            qjs.evaluate<Any?>(MEASURE_SHIM + "\nvoid 0;")

            // Warm ART's JIT on the decoders before the first measured block: otherwise the
            // block that happens to run first carries everyone else's compilation cost and
            // reads 2-3x slow (that is what made the first run's numbers disagree with the
            // identical-payload run right after it).
            qjs.evaluate<Any?>("B.create([[0,1]], $SEED)")
            qjs.evaluate<Any?>("B.frameJson(0)")
            repeat(200) {
                engineJson.decodeFromString<GameSnapshot>(qjs.evaluate<String>("B.snapJson()"))
                engineJson.decodeFromString<FrameResult>(qjs.evaluate<String>("B.frameJson(${it * 16.667})"))
            }

            for (players in PLAYER_COUNTS) {
                header("cost breakdown, $players player(s)")
                val specs = (0 until players).joinToString(",", "[", "]") { "[$it,1]" }
                qjs.evaluate<Any?>("B.create($specs, $SEED)")
                qjs.evaluate<Any?>("B.frameJson(0)")

                measure("qjs: processInput only", 50, 300) { i ->
                    qjs.evaluate<Any?>("B.processInput(${i % players}, '${if (i % 2 == 0) "left" else "right"}')")
                }
                measure("qjs: core.snapshot(), no JSON", 20, 200) {
                    qjs.evaluate<Any?>("B.snapNoJson()")
                }
                measure("qjs: snapshot + stringify", 20, 200) {
                    qjs.evaluate<String>("B.snapJson()")
                }
                var now = 1000.0
                measure("qjs: core.frame(), no JSON", 30, 400) {
                    now += 16.667
                    qjs.evaluate<Any?>("B.frameNoJson($now)")
                }
                measure("qjs: frame + stringify", 30, 400) {
                    now += 16.667
                    qjs.evaluate<String>("B.frameJson($now)")
                }

                // Kotlin-side decode of exactly those payloads. The strip ledger has to be
                // PRIMED first: its first call always emits full grids (nothing sent yet), so
                // capturing that one would measure the unstripped payload under a name that
                // claims otherwise. Every later call is what the app actually pays per input,
                // because left/right does not bump gridVersion.
                qjs.evaluate<String>("B.snapJsonStripped()")
                val stripped = qjs.evaluate<String>("B.snapJsonStripped()")
                val snapJson = qjs.evaluate<String>("B.snapJson()")
                val frameJson = qjs.evaluate<String>("B.frameJson(${now + 16.667})")
                Log.i(
                    TAG,
                    "payload bytes: full snapshot=${snapJson.length}  grid-stripped=${stripped.length}" +
                        "  frame=${frameJson.length}",
                )
                measure("kotlinx: decode full snapshot", 20, 200) {
                    engineJson.decodeFromString<GameSnapshot>(snapJson)
                }
                measure("kotlinx: decode stripped snapshot", 20, 200) {
                    engineJson.decodeFromString<GameSnapshot>(stripped)
                }
                measure("kotlinx: decode frame", 20, 200) {
                    engineJson.decodeFromString<FrameResult>(frameJson)
                }
                // What EngineBridge.reattachGrids then costs on top of a stripped decode.
                val decoded = engineJson.decodeFromString<GameSnapshot>(stripped)
                val cache = HashMap<Int, List<List<Int>>>()
                engineJson.decodeFromString<GameSnapshot>(snapJson).players.forEach { cache[it.id] = it.grid }
                measure("kotlin: reattachGrids", 20, 200) {
                    decoded.copy(players = decoded.players.map { p -> p.copy(grid = cache.getValue(p.id)) })
                }
            }
            qjs.close()
        }
        exec.shutdown()
    }

    // ── 3b. what one `evaluate` costs before any game work happens ───────────

    /**
     * quickjs-kt has no call-with-arguments API, so every engine call is a fresh JS
     * SOURCE STRING that QuickJS re-parses and re-compiles per call. This prices that
     * floor, and prices merging the coordinator's two per-input calls
     * (`processInput` then `snapshotJSON`) into one `evaluate`.
     */
    @Test
    fun evalOverhead() = runBlocking {
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "perf-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()
        withContext(dispatcher) {
            val qjs = QuickJs.create(dispatcher)
            qjs.evaluate<Any?>(bundle)
            qjs.evaluate<Any?>(MEASURE_SHIM + "\nvoid 0;")

            header("per-evaluate floor")
            measure("evaluate(\"void 0\")", 200, 1000) { qjs.evaluate<Any?>("void 0") }
            measure("evaluate(\"1+1\")", 200, 1000) { qjs.evaluate<Any?>("1+1") }
            measure("evaluate returning a string", 200, 1000) { qjs.evaluate<String>("'x'") }
            measure("evaluate returning 5 KB string", 100, 500) { qjs.evaluate<String>("B.filler()") }

            for (players in intArrayOf(1, 8)) {
                header("one eval vs two, $players player(s)")
                val specs = (0 until players).joinToString(",", "[", "]") { "[$it,1]" }
                qjs.evaluate<Any?>("B.create($specs, $SEED)")
                qjs.evaluate<Any?>("B.frameJson(0)")
                measure("two evals: input; then snapshot", 20, 200) { i ->
                    qjs.evaluate<Any?>("B.processInput(${i % players}, '${if (i % 2 == 0) "left" else "right"}')")
                    qjs.evaluate<String>("B.snapJson()")
                }
                measure("one eval: inputThenSnapshot", 20, 200) { i ->
                    qjs.evaluate<String>("B.inputThenSnap(${i % players}, '${if (i % 2 == 0) "left" else "right"}')")
                }
            }
            qjs.close()
        }
        exec.shutdown()
    }

    // ── 3c. do the proposed fixes actually pay? ──────────────────────────────

    /**
     * Prices the three changes the review recommends, against the shapes they would
     * replace, so none of them is argued from theory:
     *
     *  1. render-on-input pulling only the player who moved, not all 8 boards;
     *  2. draining a burst of queued inputs through ONE `evaluate` instead of one each;
     *  3. computing the scene signature off `game.getSnapshot()`'s live refs, so a
     *     render-identical frame skips `copyPlayer`'s deep copy entirely.
     */
    @Test
    fun proposedFixes() = runBlocking {
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "perf-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()
        withContext(dispatcher) {
            val qjs = QuickJs.create(dispatcher)
            qjs.evaluate<Any?>(bundle)
            qjs.evaluate<Any?>(MEASURE_SHIM + "\nvoid 0;")
            // JIT warmup (see costBreakdown).
            qjs.evaluate<Any?>("B.create([[0,1]], $SEED)")
            repeat(200) { engineJson.decodeFromString<GameSnapshot>(qjs.evaluate<String>("B.snapJson()")) }

            for (players in intArrayOf(4, 8)) {
                header("proposed fixes, $players player(s)")
                val specs = (0 until players).joinToString(",", "[", "]") { "[$it,1]" }
                qjs.evaluate<Any?>("B.create($specs, $SEED)")
                qjs.evaluate<Any?>("B.frameJson(0)")
                qjs.evaluate<String>("B.snapJsonStripped()") // prime the strip ledger

                // 1. whole-room pull vs single-seat pull, both including the Kotlin decode.
                measure("NOW:  all-seat snapshot + decode", 20, 200) {
                    engineJson.decodeFromString<GameSnapshot>(qjs.evaluate<String>("B.snapJsonStripped()"))
                }
                measure("FIX:  one-seat snapshot + decode", 20, 200) { i ->
                    engineJson.decodeFromString<GameSnapshot>(qjs.evaluate<String>("B.snapPlayerJson(${i % players})"))
                }

                // 2. a full party's worth of input in one frame: one eval each vs one total.
                val batch = (0 until players).joinToString(",", "[", "]") { "[$it,\"left\"]" }
                measure("NOW:  $players inputs, one eval each", 20, 200) {
                    for (p in 0 until players) qjs.evaluate<Any?>("B.processInput($p, 'left')")
                }
                measure("FIX:  $players inputs, single eval", 20, 200) {
                    qjs.evaluate<Any?>("B.processInputs($batch)")
                }

                // 3. frame(): always deep-copy, vs signature-first off the live refs. The
                //    piece is only moving under gravity here, so most frames are
                //    render-identical — exactly the case the shim already discards.
                var now = 1000.0
                measure("NOW:  frame, always deep-copies", 30, 400) {
                    now += 16.667
                    qjs.evaluate<String>("B.frameJson($now)")
                }
                measure("FIX:  frame, signature before copy", 30, 400) {
                    now += 16.667
                    qjs.evaluate<String>("B.frameJsonSigFirst($now)")
                }
                val skipped = qjs.evaluate<Any?>("B.sigFirstSkipped()")
                Log.i(TAG, "  frames that skipped the deep copy: $skipped / 430")
            }
            qjs.close()
        }
        exec.shutdown()
    }

    // ── 3d. the shipped fix, through the real bridge ─────────────────────────

    /**
     * The old per-input shape (`processInput` + whole-room `snapshot`) against the
     * shipped one (`processInputs` batch + `snapshotPlayer`), both through the real
     * [EngineBridge] with its real coroutine hops. Warmed together in one process so
     * neither carries the other's JIT cost.
     */
    @Test
    fun inputPathBeforeAfter() = runBlocking {
        val bridge = EngineBridge.create(bundle)
        // Warm both shapes before any measurement.
        bridge.createGame(listOf(EngineBridge.PlayerSpec(0, 1)), SEED)
        bridge.frame(0.0)
        repeat(150) {
            bridge.processInput(0, InputAction.LEFT); bridge.snapshot()
            bridge.processInputs(listOf(0 to InputAction.RIGHT)); bridge.snapshotPlayer(0)
        }
        for (players in PLAYER_COUNTS) {
            header("per-input shapes, $players player(s)")
            bridge.createGame((0 until players).map { EngineBridge.PlayerSpec(it, 1) }, SEED)
            bridge.frame(0.0)
            measure("OLD: processInput + snapshot", 30, 200) { i ->
                runBlocking {
                    bridge.processInput(i % players, if (i % 2 == 0) InputAction.LEFT else InputAction.RIGHT)
                    bridge.snapshot()
                }
            }
            measure("NEW: processInputs + snapPlayer", 30, 200) { i ->
                runBlocking {
                    bridge.processInputs(listOf((i % players) to if (i % 2 == 0) InputAction.LEFT else InputAction.RIGHT))
                    bridge.snapshotPlayer(i % players)
                }
            }
        }
        bridge.close()
    }

    // ── 4. what a coroutine hop costs on this CPU ────────────────────────────

    /**
     * Every EngineBridge call is `withContext(serialDispatcher)`, and `decode` adds a
     * second hop to `Dispatchers.Default`. Price them, so the breakdown above can be
     * read against the plumbing around it.
     */
    @Test
    fun dispatchOverhead() = runBlocking {
        header("coroutine plumbing")
        val exec = Executors.newSingleThreadExecutor()
        val serial = exec.asCoroutineDispatcher()
        measure("withContext(serial) round trip", 200, 2000) {
            runBlocking { withContext(serial) { } }
        }
        measure("withContext(Default) round trip", 200, 2000) {
            runBlocking { withContext(Dispatchers.Default) { } }
        }
        measure("two hops (bridge decode path)", 200, 2000) {
            runBlocking { withContext(serial) { }; withContext(Dispatchers.Default) { } }
        }
        exec.shutdown()
    }

    // ── 5. the room snapshot (published on every roster change) ──────────────

    @Test
    fun roomSnapshot() = runBlocking {
        val bridge = EngineBridge.create(bundle)
        bridge.roomInit("{}")
        for (i in 0 until 8) {
            bridge.roomCallJson("peerJoined", "[$i, ${i * 100.0}]")
            bridge.roomCallJson("hello", """[$i, {"name":"Player $i"}, ${i * 100.0}]""")
        }
        header("room core, 8 players")
        measure("roomSnapshotJson (ascii re-encode)", 20, 200) {
            runBlocking { bridge.roomSnapshotJson() }
        }
        measure("roomCallJson(list)", 20, 200) {
            runBlocking { bridge.roomCallJson("list") }
        }
        bridge.close()
    }

    internal companion object {
        const val TAG = "HexPerf"

        /** Same config as :core's internal EngineJson (which this module cannot see). */
        val engineJson = Json { ignoreUnknownKeys = true; isLenient = false }

        const val SEED = 12345L
        val PLAYER_COUNTS = intArrayOf(1, 4, 8)

        /**
         * Measurement-only shim: the shipping one (EngineBootstrap.SHIM) always
         * stringifies, so it cannot separate engine compute from serialization.
         * `snapJsonStripped` reproduces its grid-stripping so the saving is visible.
         */
        val MEASURE_SHIM = """
        globalThis.B = (function () {
          var PartyCore = HexCore.PartyCore;
          var core = null;
          var sent = {};
          var prevNow = null, lastSig = null, skipped = 0;
          // Verbatim copy of the shipping shim's signature (EngineBootstrap), so the
          // signature-first variant below skips exactly the frames the real one skips.
          function sceneSig(snap) {
            var sig = '' + Math.floor(snap.elapsed / 1000);
            for (var i = 0; i < snap.players.length; i++) {
              var p = snap.players[i];
              sig += '|' + p.id + ':' + (p.alive ? 1 : 0) + ':' + p.lines + ':' + p.level
                + ':' + p.pendingGarbage + ':' + p.gridVersion + ':' + (p.holdPiece || '');
              var cp = p.currentPiece;
              if (cp) sig += ':' + cp.typeId + ':' + cp.anchorCol + ':' + cp.anchorRow
                + ':' + cp.cells[0].q + ':' + cp.cells[0].r;
            }
            return sig;
          }
          function strip(snap) {
            for (var i = 0; i < snap.players.length; i++) {
              var p = snap.players[i];
              if (sent[p.id] === p.gridVersion) delete p.grid;
              else sent[p.id] = p.gridVersion;
            }
            return snap;
          }
          return {
            create: function (specs, seed) {
              var m = new Map();
              for (var i = 0; i < specs.length; i++) m.set(specs[i][0], { startLevel: specs[i][1] });
              core = new PartyCore(m, seed >>> 0);
              core.init();
              sent = {}; prevNow = null; lastSig = null; skipped = 0;
            },
            processInput: function (p, a) { core.processInput(p, a); },
            snapNoJson: function () { return core.snapshot().players.length; },
            snapJson: function () { return JSON.stringify(core.snapshot()); },
            snapJsonStripped: function () { return JSON.stringify(strip(core.snapshot())); },
            frameNoJson: function (now) { return core.frame(now).snapshot.players.length; },
            frameJson: function (now) { return JSON.stringify(core.frame(now)); },
            inputThenSnap: function (p, a) { core.processInput(p, a); return JSON.stringify(core.snapshot()); },
            filler: function () { return new Array(5000).join('x'); },

            // --- shapes the review proposes, priced against the ones above ---

            // One seat instead of the whole room. Copies the same fields PartyCore's
            // copyPlayer does (the renderer needs no less), just for one board, and
            // honours the same grid-stripping ledger.
            snapPlayerJson: function (pid) {
              var snap = core.game.getSnapshot();
              for (var i = 0; i < snap.players.length; i++) {
                var s = snap.players[i];
                if (s.id !== pid) continue;
                var p = {
                  id: s.id,
                  grid: s.grid.map(function (row) { return row.slice(); }),
                  currentPiece: s.currentPiece ? {
                    type: s.currentPiece.type, typeId: s.currentPiece.typeId,
                    anchorCol: s.currentPiece.anchorCol, anchorRow: s.currentPiece.anchorRow,
                    cells: s.currentPiece.cells.map(function (c) { return { q: c.q, r: c.r }; }),
                    blocks: s.currentPiece.blocks.map(function (b) { return [b[0], b[1]]; })
                  } : null,
                  ghost: s.ghost ? {
                    typeId: s.currentPiece ? s.currentPiece.typeId : null,
                    anchorCol: s.ghost.anchorCol, anchorRow: s.ghost.anchorRow,
                    blocks: s.ghost.blocks.map(function (b) { return [b[0], b[1]]; })
                  } : null,
                  holdPiece: s.holdPiece, nextPieces: s.nextPieces.slice(),
                  level: s.level, lines: s.lines, alive: s.alive,
                  pendingGarbage: s.pendingGarbage,
                  clearingCells: s.clearingCells
                    ? s.clearingCells.map(function (c) { return [c[0], c[1]]; }) : null,
                  gridVersion: s.gridVersion
                };
                if (sent[p.id] === p.gridVersion) delete p.grid; else sent[p.id] = p.gridVersion;
                return JSON.stringify({ players: [p], elapsed: snap.elapsed });
              }
              return 'null';
            },

            // A whole frame's worth of queued input through one evaluate.
            processInputs: function (batch) {
              for (var i = 0; i < batch.length; i++) core.processInput(batch[i][0], batch[i][1]);
            },

            // frame(), but the scene signature is computed off getSnapshot()'s LIVE refs,
            // so a render-identical frame never pays for copyPlayer at all.
            frameJsonSigFirst: function (now) {
              var deltaMs = prevNow == null ? 0 : Math.min(Math.max(0, now - prevNow), 50);
              prevNow = now;
              if (deltaMs > 0) core.game.update(deltaMs);
              var events = core.drainEvents();
              var live = core.game.getSnapshot();
              var sig = sceneSig(live);
              if (sig === lastSig) { skipped++; return JSON.stringify({ events: events, commands: [] }); }
              lastSig = sig;
              var full = core.snapshot();
              return JSON.stringify({ events: events, snapshot: strip(full), commands: [] });
            },
            sigFirstSkipped: function () { var s = skipped; skipped = 0; return s; }
          };
        })();
        """.trimIndent()
    }
}
