package com.hexstacker.core.parity

import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.testing.evalAs
import com.hexstacker.core.testing.quickJs
import java.io.File
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json

/**
 * Cross-engine parity for [EngineConstants]. EngineConstants is a hand-maintained Kotlin
 * mirror of `server/constants.js`; this pins every mirrored value equal to the JS source
 * so the two cannot silently drift (the "must not drift" contract in EngineConstants).
 *
 * `server/constants.js` is the actual file EngineConstants mirrors, so it is the source
 * of truth here: loaded into QuickJS via the [RenderMathJs] harness (which the render
 * parity test already uses) its UMD tail populates `window.GameConstants` with every
 * exported constant. The shipped bundle (dist/partycore.js / HexCore) does NOT re-export
 * that object; esbuild wraps each UMD module with its own `module`, so the
 * `window.GameConstants` browser branch never runs inside the bundle. The one gameplay
 * constant the bundle DOES surface is `HexCore.PartyCore.MAX_FRAME_DELTA_MS` (the
 * per-frame delta clamp), pinned separately by [maxFrameDeltaMatchesBundle].
 */
class EngineConstantsParityTest {

    private val json = Json

    @Test
    fun constantsMatchServerConstantsJs() = RenderMathJs().withContext { eval ->
        // server/constants.js UMD populates window.GameConstants in QuickJS (no `module`).
        suspend fun num(name: String): Double = eval.str("'' + window.GameConstants.$name").toDouble()
        suspend fun jsonOf(name: String): String = eval.str("JSON.stringify(window.GameConstants.$name)")

        // Integer counts / caps (exact).
        assertEquals(EngineConstants.COLS.toDouble(), num("COLS"), "COLS")
        assertEquals(EngineConstants.BUFFER_ROWS.toDouble(), num("BUFFER_ROWS"), "BUFFER_ROWS")
        assertEquals(EngineConstants.VISIBLE_ROWS.toDouble(), num("VISIBLE_ROWS"), "VISIBLE_ROWS")
        assertEquals(EngineConstants.TOTAL_ROWS.toDouble(), num("TOTAL_ROWS"), "TOTAL_ROWS")
        assertEquals(EngineConstants.GARBAGE_CELL.toDouble(), num("GARBAGE_CELL"), "GARBAGE_CELL")
        assertEquals(EngineConstants.MAX_PLAYERS.toDouble(), num("MAX_PLAYERS"), "MAX_PLAYERS")
        assertEquals(EngineConstants.COUNTDOWN_SECONDS.toDouble(), num("COUNTDOWN_SECONDS"), "COUNTDOWN_SECONDS")
        assertEquals(EngineConstants.MAX_SPEED_LEVEL.toDouble(), num("MAX_SPEED_LEVEL"), "MAX_SPEED_LEVEL")
        assertEquals(EngineConstants.SOFT_DROP_MULTIPLIER.toDouble(), num("SOFT_DROP_MULTIPLIER"), "SOFT_DROP_MULTIPLIER")
        assertEquals(EngineConstants.MAX_LOCK_RESETS.toDouble(), num("MAX_LOCK_RESETS"), "MAX_LOCK_RESETS")
        assertEquals(EngineConstants.MAX_DROPS_PER_TICK.toDouble(), num("MAX_DROPS_PER_TICK"), "MAX_DROPS_PER_TICK")

        // Millisecond timings (doubles; LOGIC_TICK_MS is 1000/60, so compare with tolerance).
        approx(EngineConstants.LOCK_DELAY_MS, num("LOCK_DELAY_MS"), "LOCK_DELAY_MS")
        approx(EngineConstants.LINE_CLEAR_DELAY_MS, num("LINE_CLEAR_DELAY_MS"), "LINE_CLEAR_DELAY_MS")
        approx(EngineConstants.LOGIC_TICK_MS, num("LOGIC_TICK_MS"), "LOGIC_TICK_MS")
        approx(EngineConstants.GARBAGE_DELAY_MS, num("GARBAGE_DELAY_MS"), "GARBAGE_DELAY_MS")
        approx(EngineConstants.SOFT_DROP_TIMEOUT_MS, num("SOFT_DROP_TIMEOUT_MS"), "SOFT_DROP_TIMEOUT_MS")
        approx(EngineConstants.HARD_DROP_MIN_INTERVAL_MS, num("HARD_DROP_MIN_INTERVAL_MS"), "HARD_DROP_MIN_INTERVAL_MS")
        approx(EngineConstants.MAX_FRAME_DELTA_MS, num("MAX_FRAME_DELTA_MS"), "MAX_FRAME_DELTA_MS")

        // Piece bag + garbage table (structural).
        assertEquals(
            json.decodeFromString<List<String>>(jsonOf("PIECE_TYPES")),
            EngineConstants.PIECE_TYPES,
            "PIECE_TYPES",
        )
        assertEquals(
            json.decodeFromString<Map<String, Int>>(jsonOf("PIECE_TYPE_TO_ID")),
            EngineConstants.PIECE_TYPE_TO_ID,
            "PIECE_TYPE_TO_ID",
        )
        // JS object keys are strings; compare on stringified Kotlin keys.
        assertEquals(
            json.decodeFromString<Map<String, Int>>(jsonOf("GARBAGE_TABLE")),
            EngineConstants.GARBAGE_TABLE.mapKeys { it.key.toString() },
            "GARBAGE_TABLE",
        )
    }

    @Test
    fun maxFrameDeltaMatchesBundle() = runBlocking {
        val src = File(System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set by build")).readText()
        quickJs {
            evalAs<Any?>(src)
            // The only gameplay constant the bundle exposes as a static: the per-frame
            // delta clamp PartyCore.frame() applies. It must equal the Kotlin mirror.
            val v = evalAs<String>("'' + HexCore.PartyCore.MAX_FRAME_DELTA_MS").toDouble()
            assertEquals(EngineConstants.MAX_FRAME_DELTA_MS, v, "HexCore.PartyCore.MAX_FRAME_DELTA_MS")
        }
        Unit
    }

    private fun approx(expected: Double, actual: Double, label: String) {
        assertTrue(abs(expected - actual) < 1e-9, "$label: expected $expected, got $actual")
    }
}
