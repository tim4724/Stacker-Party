package com.hexstacker.core.engine

import com.hexstacker.core.model.GameSnapshot
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Gates [PackedFrame] against the fixture recorded by the JS reference decoder
 * (`tests/partycore-packed.test.js` -> `tests/fixtures/partycore-packed-golden.json`).
 *
 * The fixture carries, per step, the exact packed payload and the frame it must
 * decode to. That is what stops the two readers drifting: a layout change that
 * lands in `PartyCore.js` but not here fails on the build machine instead of
 * silently mis-rendering a board on a TV.
 */
class PackedFrameTest {

    private val golden: JsonObject by lazy {
        val path = System.getProperty("hexcore.packed.golden")
            ?: error("hexcore.packed.golden not set by the build")
        val f = File(path)
        require(f.exists()) { "Missing $path — record it with `npm test` (partycore-packed.test.js)" }
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = false }

    @Test
    fun decodesEveryGoldenStepExactly() {
        val steps = golden["steps"]!!.jsonArray
        assertTrue(steps.size > 10, "fixture is too small to be meaningful: ${steps.size} steps")
        var withSnapshot = 0
        var withGrid = 0
        var withStrippedGrid = 0
        var withEvents = 0
        // The reader substitutes cached rows for stripped grids as it reads, so the
        // replay is stateful and the EXPECTATION has to track the same rows. That is
        // extra coverage, not a workaround: it gates re-attachment, which a per-step
        // comparison against the raw fixture never touched.
        val gridCache = HashMap<Int, List<List<Int>>>()
        val expectedGrids = HashMap<Int, List<List<Int>>>()
        for ((i, step) in steps.withIndex()) {
            val obj = step.jsonObject
            val packed = obj["packed"]!!.jsonPrimitive.content
            val expected = obj["frame"]!!.jsonObject

            val actual = PackedFrame.decode(packed, gridCache)

            // events / commands ride as JSON and must survive verbatim.
            assertEquals(
                expected["events"]!!.jsonArray.size, actual.events.size,
                "step $i: event count",
            )
            assertEquals(
                expected["commands"]!!.jsonArray.size, actual.commands.size,
                "step $i: command count",
            )

            val expectedSnap = expected["snapshot"]
            if (expectedSnap == null) {
                assertEquals(null, actual.snapshot, "step $i: snapshot must be omitted")
                continue
            }
            withSnapshot++
            val want = json.decodeFromString<GameSnapshot>(expectedSnap.toString())
            val got = assertNotNull(actual.snapshot, "step $i: snapshot missing")
            assertEquals(want.elapsed, got.elapsed, "step $i: elapsed")
            assertEquals(want.players.size, got.players.size, "step $i: player count")
            for ((j, wp) in want.players.withIndex()) {
                val gp = got.players[j]
                // A stripped grid must come back as the rows this player last sent.
                val wantPlayer = if (wp.grid.isNotEmpty()) {
                    expectedGrids[wp.id] = wp.grid
                    withGrid++
                    wp
                } else {
                    withStrippedGrid++
                    val rows = assertNotNull(
                        expectedGrids[wp.id],
                        "step $i: fixture stripped player ${wp.id}'s grid before ever sending it",
                    )
                    wp.copy(grid = rows)
                }
                // Compare the whole player at once: every field matters to the
                // renderer, and a per-field list here would rot as fields are added.
                assertEquals(wantPlayer, gp, "step $i: player $j (id ${wp.id}) decoded differently")
            }
            if (actual.events.isNotEmpty()) withEvents++
        }
        // A green run against a fixture that never exercised the interesting paths
        // would prove nothing.
        assertTrue(withSnapshot > 0, "fixture never carried a snapshot")
        assertTrue(withGrid > 0, "fixture never carried a grid")
        assertTrue(withStrippedGrid > 0, "fixture never stripped a grid, so re-attachment went untested")
        assertTrue(withEvents > 0, "fixture never carried events")
    }

    @Test
    fun rejectsAForeignLayoutVersion() {
        val steps = golden["steps"]!!.jsonArray
        val packed = steps[0].jsonObject["packed"]!!.jsonPrimitive.content
        // Bump the version code unit; every value is +1 biased on the wire.
        val bumped = (PackedFrame.PACK_VERSION + 42).toChar() + packed.substring(1)
        val e = runCatching { PackedFrame.decode(bumped, HashMap()) }.exceptionOrNull()
        assertNotNull(e, "a foreign layout version must fail loudly, not be misread")
        assertTrue(
            e.message?.contains("version") == true,
            "the failure should name the version, got: ${e.message}",
        )
    }
}
