package com.hexstacker.core.engine

import com.hexstacker.core.testing.evalAs
import com.hexstacker.core.testing.quickJs
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * [jsString] is load-bearing: the QuickJS binding has no call-with-arguments API, so every
 * call into the engine context is a source string Kotlin interpolates. Until the
 * room core landed, everything spliced in was an Int or a fixed enum constant.
 * Room payloads carry PLAYER NAMES — arbitrary user text — so a raw splice would
 * break on a quote or a backslash, and a crafted name could close the literal and
 * append a statement that runs inside the engine's own runtime.
 */
class JsStringTest {

    private val hostile = listOf(
        "plain",
        "quote\"inside",
        "single'quote",
        "back\\slash",
        "back\\\"slash-quote",
        "line\nbreak",
        "carriage\rreturn",
        "tab\there",
        "null\u0000byte",
        "bell\u0007",
        "del\u007Fchar",
        "line\u2028sep and\u2029para",
        "zero\u200Bwidth joiner\u200D",
        "emoji 🎮 ok",
        // The whole point: a name that would close the literal and run a statement.
        "\"; globalThis.pwned = 1; var ignored = \"",
        "\\\"); globalThis.pwned = 1; //",
    )

    @Test
    fun everyLiteralRoundTripsThroughQuickJs() = runBlocking {
        quickJs {
            for (s in hostile) {
                // Length first, and for every case: it proves the literal PARSED to the
                // right string even where reading it back cannot. The bridge marshals JS
                // strings out lossily: a NUL truncates, and the 4-byte UTF-8 of an astral
                // character mis-decodes. That is why the room reads come back ASCII-escaped
                // (EngineBridge.asciiJson, covered by emojiNamesSurviveTheReturnTrip below).
                assertEquals(s.length, evalAs<Int>("(${jsString(s)}).length"), "literal length for $s")
                if (s.any { it.isSurrogate() } || s.contains('\u0000')) continue
                assertEquals(s, evalAs<String>(jsString(s)), "literal for ${s.map { it.code }}")
            }
        }
    }

    @Test
    fun aCraftedNameCannotInjectAStatement() = runBlocking {
        quickJs {
            for (s in hostile) {
                val pwned = evalAs<Int>(
                    "globalThis.pwned = 0; var name = ${jsString(s)}; globalThis.pwned",
                )
                assertEquals(0, pwned, "injection escaped the literal for: $s")
            }
        }
    }

    /** End to end: a hostile name crossing the real room API survives verbatim (bar the
     *  control characters the room core itself strips) and runs nothing. */
    @Test
    fun hostileNamesSurviveTheRoomBridgeIntact() = runBlocking {
        val bundle = File(System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set")).readText()
        val bridge = EngineBridge.create(bundle)
        try {
            bridge.roomInit("{}")
            val name = "\"; globalThis.pwned = 1; \\\" ok"
            bridge.roomCallJson("hello", "[1, ${helloWith(name)}, 0]")
            val snapshot = Json.parseToJsonElement(bridge.roomSnapshotJson()).jsonObject
            val stored = snapshot["players"]!!.jsonObject["1"]!!.jsonObject["name"]!!.jsonPrimitive.content
            // NAME_MAX_LEN caps it; what matters is that it is a prefix of the submitted
            // text and not the result of anything having been executed.
            assertEquals(name.take(stored.length), stored)
        } finally {
            bridge.close()
        }
    }

    /**
     * The other half of the crossing: the bridge decodes an outbound JS string from
     * UTF-8 and mishandles the 4-byte sequences, so a name with an emoji used to come
     * back mangled — and could truncate the snapshot JSON into something that no longer
     * parses. EngineBridge re-encodes the room reads as pure ASCII for that reason.
     */
    @Test
    fun emojiNamesSurviveTheReturnTrip() = runBlocking {
        val bundle = File(System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set")).readText()
        val bridge = EngineBridge.create(bundle)
        try {
            bridge.roomInit("{}")
            val name = "Zo\u00EB \uD83C\uDFAE"
            bridge.roomCallJson("hello", "[1, ${helloWith(name)}, 0]")
            val snapshot = Json.parseToJsonElement(bridge.roomSnapshotJson()).jsonObject
            assertEquals(name, snapshot["players"]!!.jsonObject["1"]!!.jsonObject["name"]!!.jsonPrimitive.content)
            // ...and through the roster read the lobby renders from.
            assertEquals(name, Json.parseToJsonElement(bridge.roomCallJson("list")).jsonArray
                .single().jsonObject["playerName"]!!.jsonPrimitive.content)
        } finally {
            bridge.close()
        }
    }

    private fun helloWith(name: String): JsonObject = buildJsonObject { put("name", name) }
}
