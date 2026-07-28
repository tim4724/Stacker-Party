package com.hexstacker.core

import com.hexstacker.core.testing.evalAs
import com.hexstacker.core.testing.quickJs
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.runBlocking

/**
 * The core thesis of the Android port: the canonical game engine (the server JS
 * modules, bundled to dist/partycore.js as the `HexCore` iife) runs unchanged inside
 * QuickJS, and is driven through PartyCore.frame() exactly as the Apple TV
 * EngineBridge drives it through JavaScriptCore.
 *
 * This loads the REAL bundle, constructs a 2-player PartyCore, steps it, and
 * checks the snapshot shape + the frame() contract (events/snapshot/commands).
 * It does NOT yet assert byte-equality with the golden — that's the next test
 * once typed Snapshot models exist.
 */
class EngineBundleTest {

    private fun bundleSource(): String {
        val path = System.getProperty("hexcore.bundle")
            ?: error("hexcore.bundle system property not set by the build")
        val f = File(path)
        require(f.exists()) {
            "Engine bundle not found at $path. Run `npm run build` at the repo root first."
        }
        return f.readText()
    }

    @Test
    fun runsCanonicalEngineInQuickJs() = runBlocking {
        val src = bundleSource()
        quickJs {
            // 1. Load the bundle: defines globalThis.HexCore (PartyCore + RoomFlow).
            evalAs<Any?>(src)
            assertEquals(
                "function",
                evalAs<String>("typeof HexCore.PartyCore"),
                "HexCore.PartyCore must be exposed by the bundle",
            )

            // 2. Construct + init a 2-player game with a fixed seed (deterministic).
            evalAs<Any?>(
                """
                globalThis.__pc = new HexCore.PartyCore(
                    new Map([[0, { startLevel: 1 }], [1, { startLevel: 1 }]]),
                    12345,
                );
                __pc.init();
                globalThis.__now = 0;
                """.trimIndent(),
            )

            // 3. Snapshot shape: 2 players, 9 cols x 15 VISIBLE rows. The snapshot is
            // in visible-row space: getSnapshot does grid.slice(BUFFER_ROWS), so the 4
            // hidden spawn-buffer rows are clipped and piece/ghost anchors are shifted
            // by -BUFFER_ROWS. The native renderer consumes these visible coordinates.
            assertEquals(2, evalAs<Int>("__pc.snapshot().players.length"))
            assertEquals(9, evalAs<Int>("__pc.snapshot().players[0].grid[0].length"))
            assertEquals(15, evalAs<Int>("__pc.snapshot().players[0].grid.length"))

            // 4. Step ~2s of frames at 60Hz; a falling piece must be present.
            evalAs<Any?>("for (var i = 0; i < 120; i++) { __now += 16.67; __pc.frame(__now); }")
            assertEquals(
                1,
                evalAs<Int>("__pc.snapshot().players[0].currentPiece ? 1 : 0"),
                "a piece should be falling after 2s",
            )

            // 5. frame() honors the native contract: { events, snapshot, commands }.
            assertEquals(
                "commands,events,snapshot",
                evalAs<String>("Object.keys(__pc.frame(__now += 16.67)).sort().join(',')"),
            )
        }
        Unit
    }
}
