package com.hexstacker.core.net

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Wire-format coverage for [ControllerMessage.from] (the lenient inbound decoder) and
 * the [OutboundMessage] builders (display -> controller frames). The controllers speak
 * the web relay protocol, so these shapes must match public/shared/protocol.js exactly.
 */
class ProtocolCodecTest {

    private fun type(o: kotlinx.serialization.json.JsonObject) = o["type"]?.jsonPrimitive?.contentOrNull

    @Test
    fun coercesNumericStringsAndDoubles() {
        val m = ControllerMessage.from(
            buildJsonObject {
                put("type", "set_level")
                put("level", JsonPrimitive("7")) // string -> Int
                put("colorIndex", 3.0)           // double -> Int
                put("t", JsonPrimitive("42.5"))  // string -> Double
            },
        )!!
        assertEquals("set_level", m.type)
        assertEquals(7, m.level)
        assertEquals(3, m.colorIndex)
        assertEquals(42.5, m.t)
    }

    @Test
    fun booleanCoercionForFlags() {
        val m = ControllerMessage.from(
            buildJsonObject {
                put("type", "hello")
                put("autoName", true)
                put("muted", JsonPrimitive("true")) // string -> Boolean
            },
        )!!
        assertEquals(true, m.autoName)
        assertEquals(true, m.muted)
    }

    @Test
    fun nameMustBeAStringElseNull() {
        // A numeric `name` is rejected (isString guard) so it never becomes a player name.
        assertNull(ControllerMessage.from(buildJsonObject { put("type", "hello"); put("name", 42) })!!.name)
        assertEquals("Zoe", ControllerMessage.from(buildJsonObject { put("type", "hello"); put("name", "Zoe") })!!.name)
    }

    @Test
    fun claimFieldsDecodeForRejoin() {
        val m = ControllerMessage.from(
            buildJsonObject { put("type", "hello"); put("rejoinToken", JsonPrimitive("3")); put("rejoinId", 4) },
        )!!
        assertEquals(3, m.rejoinToken)
        assertEquals(4, m.rejoinId)
    }

    @Test
    fun missingTypeReturnsNull() {
        assertNull(ControllerMessage.from(buildJsonObject { put("action", "left") }))
    }

    @Test
    fun outboundBuilderShapes() {
        val ps = OutboundMessage.playerState(level = 5, lines = 12, alive = true, garbageIncoming = 3)
        assertEquals(Msg.PLAYER_STATE, type(ps))
        assertEquals(5, ps["level"]?.jsonPrimitive?.intOrNull)
        assertEquals(12, ps["lines"]?.jsonPrimitive?.intOrNull)
        assertEquals(3, ps["garbageIncoming"]?.jsonPrimitive?.intOrNull)

        // Short KO form omits level/lines.
        val dead = OutboundMessage.playerDead()
        assertEquals(Msg.PLAYER_STATE, type(dead))
        assertEquals(false, dead["alive"]?.jsonPrimitive?.contentOrNull?.toBoolean())
        assertNull(dead["level"])
    }

    @Test
    fun createFrameCarriesUrlTemplateAndOmitsNull() {
        // The relay rejects the whole create on an invalid template, so a frame
        // without one must omit the field entirely (explicitNulls = false), not
        // send "url": null.
        val bare = RelayJson.encodeToString(CreateFrame.serializer(), CreateFrame(clientId = "display", maxClients = 9))
        assertTrue(!bare.contains("\"url\""), "null url must be omitted from the wire")

        val templated = RelayJson.encodeToString(
            CreateFrame.serializer(),
            CreateFrame(clientId = "display", maxClients = 9, url = RelayConfig.CONTROLLER_URL_TEMPLATE),
        )
        assertTrue(
            templated.contains("\"url\":\"${RelayConfig.CONTROLLER_URL_TEMPLATE}\""),
            "create carries the controller-URL template",
        )
    }

    @Test
    fun sendFrameSerializesTypeFirst() {
        // The relay `send` envelope must encode `type` first to match the web byte layout.
        val json = RelayJson.encodeToString(SendFrame.serializer(), SendFrame(data = buildJsonObject { put("k", 1) }, to = 2))
        assertTrue(json.indexOf("\"type\"") < json.indexOf("\"data\""), "type precedes data in the encoded frame")
        assertTrue(json.contains("\"send\""))
    }

    // The game_end / game_start / countdown builders are gone with the retired
    // room protocol: the ranking now rides the retained snapshot instead. What is
    // left to encode is player_state, pong and error, covered above.
}
