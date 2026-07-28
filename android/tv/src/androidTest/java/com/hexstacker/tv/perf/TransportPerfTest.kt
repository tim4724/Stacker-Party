package com.hexstacker.tv.perf

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cash.zipline.QuickJs
import com.hexstacker.core.model.GameSnapshot
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
 * Answers two questions the input-latency work raised but never measured directly:
 *
 *  1. How much of a frame is actually SIMULATION, versus copying and marshalling it
 *     across the JS/native boundary? (Derived earlier by subtracting two separately
 *     warmed blocks, which is not a measurement.)
 *  2. What would a non-JSON transport buy? Prototyped here as a packed UTF-16 string
 *     — every snapshot field is a small integer, so it fits one code unit per value and
 *     rides the SAME string return path the bridge already uses, with no JSON on either
 *     side.
 *
 * Everything runs on one thread against one warmed QuickJS, so the four variants are
 * directly comparable.
 */
@RunWith(AndroidJUnit4::class)
class TransportPerfTest {

    @Test
    fun whereFrameTimeGoes() = runBlocking {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val bundle = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "perf-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()

        withContext(dispatcher) {
            val qjs = QuickJs.create()
            qjs.evalAs<Any?>(bundle)
            qjs.evalAs<Any?>(SHIM + "\nvoid 0;")

            // Global JIT warmup so the first measured block doesn't carry everyone's cost.
            qjs.evalAs<Any?>("T.create([[0,1],[1,1]], 12345)")
            repeat(150) {
                json.decodeFromString<GameSnapshot>(qjs.evalAs<String>("T.frameJson(${it * 16.667})"))
                decodePacked(qjs.evalAs<String>("T.framePacked(${it * 16.667})"))
            }

            for (players in intArrayOf(1, 4, 8)) {
                Log.i(TAG, "=== $players player(s) ===")
                val specs = (0 until players).joinToString(",", "[", "]") { "[$it,1]" }
                qjs.evalAs<Any?>("T.create($specs, 12345)")
                var now = 1000.0

                // (1) Pure simulation: update + drainEvents + toCommands. NO snapshot copy,
                //     no serialization. This is the irreducible game work per frame.
                measure("sim only (update+drain+commands)", 40, 400) {
                    now += 16.667
                    qjs.evalAs<Any?>("T.simOnly($now)")
                }
                // (2) + the value-copy snapshot every delivery path builds.
                measure("+ copyPlayer deep copy", 40, 400) {
                    now += 16.667
                    qjs.evalAs<Any?>("T.simCopy($now)")
                }
                // (3) + JSON.stringify, i.e. what crosses today.
                measure("+ JSON.stringify (crosses today)", 40, 400) {
                    now += 16.667
                    qjs.evalAs<String>("T.frameJson($now)")
                }
                // (4) The packed alternative: straight off the LIVE refs, no deep copy,
                //     no JSON, one code unit per value.
                measure("packed, live refs, no copy", 40, 400) {
                    now += 16.667
                    qjs.evalAs<String>("T.framePacked($now)")
                }

                // Native-side decode of each, measured separately.
                val js = qjs.evalAs<String>("T.frameJson(${now + 16.667})")
                val packed = qjs.evalAs<String>("T.framePacked(${now + 33.3})")
                Log.i(TAG, "  payload: json=${js.length} chars  packed=${packed.length} chars")
                measure("decode: kotlinx JSON -> objects", 40, 300) { json.decodeFromString<GameSnapshot>(js) }
                measure("decode: packed -> objects", 40, 300) { decodePackedToObjects(packed) }
                measure("decode: packed -> flat ints", 40, 300) { decodePacked(packed) }

                // The rows above all carry GRIDS, which is the rare case: the delivery
                // filter strips a grid whose gridVersion has not moved, so ~97% of live
                // frames carry none. Measure that steady state separately, or the
                // grid-flattening win looks far bigger than it is in practice.
                val stripped = qjs.evalAs<String>("T.framePackedNoGrid(${now + 50.0})")
                Log.i(TAG, "  steady-state payload: packed-no-grid=${stripped.length} chars")
                measure("steady: packed -> objects", 40, 300) { decodePackedNoGrid(stripped, boxed = true) }
                measure("steady: packed -> flat ints", 40, 300) { decodePackedNoGrid(stripped, boxed = false) }
            }
            qjs.close()
        }
        exec.shutdown()
    }

    /**
     * Read the packed frame into flat int arrays — the shape a renderer wants anyway.
     * No boxing, no intermediate objects: one IntArray per board plus a small header.
     */
    private fun decodePacked(s: String): Int {
        var i = 0
        val n = s[i++].code - 1
        i++ // elapsed hi
        i++ // elapsed lo
        var cells = 0
        repeat(n) {
            i += HEADER_FIELDS
            val grid = IntArray(GRID_CELLS)
            for (c in 0 until GRID_CELLS) grid[c] = s[i + c].code - 1
            i += GRID_CELLS
            cells += grid.size
        }
        return cells
    }

    /**
     * Packed decode into the SAME boxed model the shipped reader builds
     * (List<List<Int>> grids, per-cell objects). Sits between the two extremes and
     * is what says how much of the remaining cost is the WIRE FORMAT versus the
     * MODEL: `decode: packed -> flat ints` is the same bytes with primitive arrays.
     */
    private fun decodePackedToObjects(s: String): Int {
        var i = 0
        fun next(): Int = s[i++].code - 1
        val n = next()
        next(); next() // elapsed hi/lo
        var cells = 0
        repeat(n) {
            repeat(HEADER_FIELDS) { next() }
            val grid = ArrayList<List<Int>>(15)
            repeat(15) {
                val row = ArrayList<Int>(9)
                repeat(9) { row.add(next()) }
                grid.add(row)
            }
            cells += grid.size
        }
        return cells
    }

    /**
     * The steady-state payload: header fields plus one piece and one ghost per seat,
     * no grid. `boxed` picks between building the per-cell objects the shipped reader
     * builds and reading the same values into primitive arrays — which is exactly the
     * change being considered, isolated from the grid.
     */
    private fun decodePackedNoGrid(s: String, boxed: Boolean): Int {
        var i = 0
        fun next(): Int = s[i++].code - 1
        val n = next()
        next(); next()
        var acc = 0
        repeat(n) {
            repeat(HEADER_FIELDS) { next() }
            val blockCount = next()
            if (boxed) {
                val blocks = ArrayList<Pair<Int, Int>>(blockCount)
                repeat(blockCount) { blocks.add(Pair(next(), next())) }
                acc += blocks.size
            } else {
                val flat = IntArray(blockCount * 2)
                for (k in 0 until blockCount * 2) flat[k] = next()
                acc += flat.size
            }
        }
        return acc
    }

    private inline fun measure(label: String, warmup: Int, iters: Int, body: () -> Unit) {
        repeat(warmup) { body() }
        val samples = LongArray(iters)
        for (i in 0 until iters) {
            val t0 = System.nanoTime()
            body()
            samples[i] = System.nanoTime() - t0
        }
        report(label, samples)
    }

    private fun report(label: String, samples: LongArray) {
        samples.sort()
        val n = samples.size
        val p50 = samples[((n - 1) * 0.5).roundToLong().toInt()] / 1000.0
        val p95 = samples[((n - 1) * 0.95).roundToLong().toInt()] / 1000.0
        Log.i(
            TAG,
            String.format("%-34s mean=%8.1fus  p50=%8.1f  p95=%8.1f", label, samples.average() / 1000.0, p50, p95),
        )
    }

    private companion object {
        const val TAG = "HexPerf"
        const val GRID_CELLS = 15 * 9
        const val HEADER_FIELDS = 16
        val json = Json { ignoreUnknownKeys = true; isLenient = false }

        /**
         * `simOnly` reaches past PartyCore.frame() to time update+drain+commands without
         * the snapshot copy frame() always makes. `framePacked` builds the wire payload
         * straight from getSnapshot()'s LIVE refs — the copy exists so a host can retain a
         * snapshot, and a payload being serialized on the spot never needs to.
         */
        val SHIM = """
        globalThis.T = (function () {
          var PartyCore = HexCore.PartyCore;
          var core = null, prevNow = null;
          function step(now) {
            var d = prevNow == null ? 0 : Math.min(Math.max(0, now - prevNow), 50);
            prevNow = now;
            if (d > 0) core.game.update(d);
            return core.drainEvents();
          }
          var CH = String.fromCharCode;
          return {
            create: function (specs, seed) {
              var m = new Map();
              for (var i = 0; i < specs.length; i++) m.set(specs[i][0], { startLevel: specs[i][1] });
              core = new PartyCore(m, seed >>> 0);
              core.init();
              prevNow = null;
            },
            simOnly: function (now) {
              var ev = step(now);
              var live = core.game.getSnapshot();
              return PartyCore.toCommands(ev, live).length;
            },
            simCopy: function (now) {
              var ev = step(now);
              var snap = core.snapshot();
              return PartyCore.toCommands(ev, snap).length;
            },
            frameJson: function (now) {
              var ev = step(now);
              var snap = core.snapshot();
              PartyCore.toCommands(ev, snap);
              return JSON.stringify(snap);
            },
            // One UTF-16 code unit per value. Every field is a small non-negative int
            // (coords are biased by 64 so a piece still in the spawn buffer stays >= 0).
            // The steady-state shape: no grid, but the per-cell lists a frame always
            // carries (piece blocks + ghost blocks).
            framePackedNoGrid: function (now) {
              var ev = step(now);
              var live = core.game.getSnapshot();
              PartyCore.toCommands(ev, live);
              var ps = live.players, out = [];
              out.push(ps.length + 1);
              var e = Math.floor(live.elapsed);
              out.push(((e >> 16) & 0xffff) + 1, (e & 0xffff) + 1);
              for (var i = 0; i < ps.length; i++) {
                var p = ps[i], cp = p.currentPiece, g = p.ghost;
                out.push(p.id + 1, p.level + 1, (p.lines & 0xffff) + 1, (p.alive ? 1 : 0) + 1,
                         p.pendingGarbage + 1, (p.gridVersion & 0xffff) + 1,
                         (cp ? 1 : 0) + 1, (cp ? cp.typeId : 0) + 1,
                         (cp ? cp.anchorCol + 64 : 0) + 1, (cp ? cp.anchorRow + 64 : 0) + 1,
                         (cp ? cp.cells[0].q + 64 : 0) + 1, (cp ? cp.cells[0].r + 64 : 0) + 1,
                         (g ? 1 : 0) + 1, (g ? g.anchorCol + 64 : 0) + 1,
                         (g ? g.anchorRow + 64 : 0) + 1, 1);
                var blocks = (cp ? cp.blocks : []).concat(g ? g.blocks : []);
                out.push(blocks.length + 1);
                for (var b = 0; b < blocks.length; b++) {
                  out.push(blocks[b][0] + 64 + 1, blocks[b][1] + 64 + 1);
                }
              }
              return CH.apply(null, out);
            },
            framePacked: function (now) {
              var ev = step(now);
              var live = core.game.getSnapshot();
              PartyCore.toCommands(ev, live);
              var ps = live.players, out = [];
              // +1 on EVERY value: the bridge hands JS strings over as C strings, so a
              // zero code unit truncates the payload -- and 0 is the most common value
              // here (every empty grid cell). Found the hard way: the first packed frame
              // came back one character long.
              out.push(ps.length + 1);
              var e = Math.floor(live.elapsed);
              out.push(((e >> 16) & 0xffff) + 1, (e & 0xffff) + 1);
              for (var i = 0; i < ps.length; i++) {
                var p = ps[i], cp = p.currentPiece, g = p.ghost;
                out.push(p.id + 1, p.level + 1, (p.lines & 0xffff) + 1, (p.alive ? 1 : 0) + 1,
                         p.pendingGarbage + 1, (p.gridVersion & 0xffff) + 1,
                         (cp ? 1 : 0) + 1, (cp ? cp.typeId : 0) + 1,
                         (cp ? cp.anchorCol + 64 : 0) + 1, (cp ? cp.anchorRow + 64 : 0) + 1,
                         (cp ? cp.cells[0].q + 64 : 0) + 1, (cp ? cp.cells[0].r + 64 : 0) + 1,
                         (g ? 1 : 0) + 1, (g ? g.anchorCol + 64 : 0) + 1,
                         (g ? g.anchorRow + 64 : 0) + 1, 1);
                var grid = p.grid;
                for (var r = 0; r < grid.length; r++) {
                  var row = grid[r];
                  for (var c = 0; c < row.length; c++) out.push(row[c] + 1);
                }
              }
              return CH.apply(null, out);
            }
          };
        })();
        """.trimIndent()
    }
}
