package com.hexstacker.core

import com.hexstacker.core.testing.evalAs
import com.hexstacker.core.testing.quickJs
import java.io.File
import kotlin.test.Test
import kotlin.test.fail
import kotlinx.coroutines.runBlocking

/**
 * Cross-engine conformance: drives the EXACT deterministic timeline that produced
 * tests/fixtures/partycore-frame-golden.json (recorded under V8/Node) through the
 * canonical engine running in QuickJS, and asserts the per-frame
 * { deltaMs, events, commands, boards:[gridHash, snapHash] } stream is identical
 * byte-for-byte.
 *
 * Why this is the load-bearing proof of the whole port:
 *  - It runs the SAME JS driver (bundled from tests/helpers/partycore-frame-script.js)
 *    that the Node test uses, so there is zero reimplementation and zero drift.
 *  - The recorded values are hashes/ints/strings (no raw floats), but a
 *    gravityCounter float divergence between V8 and QuickJS would still change a
 *    piece/grid position and flip a hash, so this catches it. A green run means
 *    the documented round-then-compare workaround is NOT needed for QuickJS.
 */
class FrameGoldenConformanceTest {

    private fun fileFromProp(prop: String): File {
        val path = System.getProperty(prop) ?: error("$prop not set by the build")
        val f = File(path)
        require(f.exists()) {
            "Missing $path. Run `npm run build:native` at the repo root."
        }
        return f
    }

    @Test
    fun quickJsReproducesFrameGoldenByteForByte() = runBlocking {
        val driver = fileFromProp("hexcore.frametest.bundle").readText()
        val golden = fileFromProp("hexcore.frametest.golden").readText()

        val produced = quickJs {
            evalAs<Any?>(driver)
            evalAs<String>("JSON.stringify(HexFrameTest.runPartyCoreFrameScript(), null, 2)")
        }

        val expected = golden.trimEnd('\n')
        if (expected != produced) reportFirstDivergence(expected, produced)
    }

    /** A 73 KB string diff is useless in an assertion; pinpoint the first differing line instead. */
    private fun reportFirstDivergence(expected: String, actual: String): Nothing {
        val e = expected.lines()
        val a = actual.lines()
        val n = minOf(e.size, a.size)
        var i = 0
        while (i < n && e[i] == a[i]) i++
        val window = (maxOf(0, i - 2)..minOf(n - 1, i + 2)).joinToString("\n") { idx ->
            "  [$idx] exp: ${e.getOrNull(idx)}\n  [$idx] got: ${a.getOrNull(idx)}"
        }
        fail(
            "QuickJS frame() output diverged from the V8 golden at line $i " +
                "(expected ${e.size} lines, got ${a.size}):\n$window",
        )
    }
}
