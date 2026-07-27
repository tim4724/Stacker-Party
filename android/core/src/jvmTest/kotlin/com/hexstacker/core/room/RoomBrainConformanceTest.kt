package com.hexstacker.core.room

import com.hexstacker.core.engine.EngineBridge
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * RoomBrain conformance: the Android TV leg.
 *
 * `tests/fixtures/room-brain-golden.json` is a self-contained artifact — the
 * constructor options, an 88-step op log, and the expected return value plus full
 * snapshot after every step. Node replays it (tests/room-brain-conformance.test.js),
 * JavaScriptCore replays it on tvOS, and QuickJS replays it here.
 *
 * Because all three legs run the SAME JavaScript, this is not asking "did someone
 * re-implement the room wrong" any more. It asks "does this bridge marshal
 * correctly" — a far smaller surface, and the same shape as the engine's existing
 * FrameGoldenConformance gate. The op log deliberately covers the paths a
 * marshalling bug hides in: peer_joined before hello, colour collisions, auto-naming
 * with a blocklisted preference, name sanitizing (control chars, a zero-width
 * joiner, overlong, whitespace-only, legacy P-names), sparse AirConsole-style peer
 * indices, the three pause flags, suspend + cross-device rejoin, batched liveness
 * ticks, late-joiner grace, results enrichment, and a full room rejecting one more.
 */
class RoomBrainConformanceTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun bundle(): String =
        File(System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set by build")).readText()

    private fun golden(): JsonObject {
        val path = System.getProperty("hexcore.roombrain.golden")
            ?: error("hexcore.roombrain.golden not set by build")
        return json.parseToJsonElement(File(path).readText()).jsonObject
    }

    @Test
    fun replaysTheGoldenOpLogThroughTheBridge() = runBlocking {
        val g = golden()
        val ops = g["ops"]!!.jsonArray
        val steps = g["steps"]!!.jsonArray
        assertEquals(ops.size, steps.size, "golden ops/steps disagree")

        val bridge = EngineBridge.create(bundle())
        try {
            // rngSeed (not rng) rides the options object: the bridges are JSON-only and
            // cannot pass a function, and auto-naming — one of the behaviours that had
            // silently diverged across the three platforms — has to be IN the log.
            bridge.roomInit(g["init"]!!.jsonObject.toString())

            for (i in 0 until ops.size) {
                val op = ops[i].jsonObject
                val get = op["g"]?.jsonPrimitive?.content
                val method = op["m"]?.jsonPrimitive?.content
                val label = if (get != null) "step $i (get $get)" else "step $i ($method)"

                val returned = if (get != null) {
                    bridge.roomGetJson(get)
                } else {
                    val args = op["a"]?.jsonArray ?: JsonArray(emptyList())
                    bridge.roomCallJson(method!!, args.toString())
                }

                assertEquals(
                    steps[i].jsonObject["result"],
                    json.parseToJsonElement(returned),
                    "$label: return value",
                )
                assertEquals(
                    steps[i].jsonObject["snapshot"],
                    json.parseToJsonElement(bridge.roomSnapshotJson()),
                    "$label: snapshot",
                )
            }
        } finally {
            bridge.close()
        }
    }

    /** The window the shell's publish timer runs on comes from the module through the
     *  bridge, so the policy cannot be hand-mirrored into a Kotlin constant that drifts. */
    @Test
    fun exposesTheModuleSnapshotThrottle() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val client = RoomBrainClient.create(bridge, JsonObject(emptyMap()))
            assertEquals(500.0, client.snapshotThrottleMs())
        } finally {
            bridge.close()
        }
    }
}
