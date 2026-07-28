package com.hexstacker.tv.perf

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cash.zipline.QuickJs
import com.hexstacker.tv.testing.evalAs
import java.util.concurrent.Executors
import kotlin.math.roundToLong
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What one engine call costs, and how much of it is reachable.
 *
 * This is the test that produced §15's finding: the ~776 us floor the shipping binding used
 * to carry was NOT QuickJS re-parsing the source, it was quickjs-kt's `evalInSession`
 * wrapper (a session allocation, `loadModules`, four suspending mutex acquisitions and ~5
 * JNI calls, for async/Promise semantics `EngineBootstrap.SHIM` never uses). Cost did not
 * grow with source length, and precompiling saved ~6%. That is what justified moving to
 * Zipline's synchronous binding (§15b), which does the same call in ~78 us.
 *
 * Kept pointed at the SHIPPING binding so the floor stays honest, and so a future binding
 * change has the same three separations to run:
 *  - source length sweep — is the floor PARSE (scales with length) or FIXED overhead?
 *  - `compile()` once + `execute(bytecode)` — what skipping the compile half is worth.
 *  - an interpolated 8-input batch — what passing arguments as source text costs.
 */
@RunWith(AndroidJUnit4::class)
class JsBindingPerfTest {

    @Test
    fun evaluateFloorComposition() = runBlocking {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val bundleJs = ctx.assets.open("partycore.js").bufferedReader().use { it.readText() }
        val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "binding-qjs") }
        val dispatcher = exec.asCoroutineDispatcher()

        withContext(dispatcher) {
            val qjs = QuickJs.create()
            qjs.evalAs<Any?>(bundleJs)
            qjs.evalAs<Any?>(EnginePerfTest.MEASURE_SHIM + "\nvoid 0;")
            qjs.evalAs<Any?>("B.create([[0,1],[1,1],[2,1],[3,1],[4,1],[5,1],[6,1],[7,1]], 12345)")
            repeat(600) { qjs.evalAs<Any?>("B.frameNoJson(${it * 16.667})") } // deep stacks

            header("is the evaluate floor parse, or the binding wrapper?")

            // 1. Source length sweep. `1` is the smallest expression there is; the padded
            //    variants are the same expression with comment bulk QuickJS must still
            //    tokenize. Flat cost => the floor is the wrapper, not the parser.
            measure("evaluate(\"1\")  [4 chars]") { qjs.evalAs<Int>("1") }
            val pad200 = "/*" + "x".repeat(200) + "*/1"
            val pad2000 = "/*" + "x".repeat(2000) + "*/1"
            measure("evaluate 200-char source") { qjs.evalAs<Int>(pad200) }
            measure("evaluate 2000-char source") { qjs.evalAs<Int>(pad2000) }

            // 2. Same trivial expression, precompiled — Zipline's `evaluate` is compile +
            //    execute, so this is what skipping the compile half is worth.
            val bc1 = qjs.compile("1", "bc.js")
            measure("execute(bytecode of \"1\")") { qjs.execute(bc1) }

            // 3. The real call, both ways. The source form is what ships; the bytecode form
            //    is only reachable for a call whose arguments are already inside the JS,
            //    since the bytecode is fixed.
            header("the real frame call, 8 seats")
            var t = 20000.0
            measure("evaluate source: B.frameNoJson(now)") {
                t += 16.667
                qjs.evalAs<Any?>("B.frameNoJson($t)")
            }
            // Park `now` in a global the compiled call reads, so the bytecode is stable.
            // This is the shape a "compile once, call many" bridge would use.
            qjs.evalAs<Any?>("globalThis.__now = $t")
            val bcFrame = qjs.compile("B.frameNoJson(globalThis.__now += 16.667)", "bc.js")
            measure("execute bytecode: same call") { qjs.execute(bcFrame) }

            // 4. What the interpolated ARGUMENT string costs: a full party's input batch
            //    crosses as JS source that QuickJS re-tokenizes on arrival.
            header("interpolated argument cost")
            val empty = "Bridge_stub_noop"
            qjs.evalAs<Any?>("globalThis.$empty = function(){ return 0 }")
            measure("call with no args") { qjs.evalAs<Int>("$empty()") }
            val batch8 = (0 until 8).joinToString(",") { "[$it,\"left\"]" }
            measure("call with an 8-input batch literal") { qjs.evalAs<Int>("$empty([$batch8])") }

            qjs.close()
        }
        exec.shutdown()
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun header(text: String) = Log.i(TAG, "=== $text ===")

    private suspend fun measure(label: String, body: suspend () -> Unit) {
        repeat(WARMUP) { body() }
        val samples = ArrayList<Long>(ITERS)
        repeat(ITERS) {
            val t0 = System.nanoTime()
            body()
            samples.add(System.nanoTime() - t0)
        }
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
        const val WARMUP = 100
        const val ITERS = 400
    }
}
