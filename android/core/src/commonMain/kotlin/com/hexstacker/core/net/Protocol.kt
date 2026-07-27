package com.hexstacker.core.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** Mirror of public/shared/protocol.js + the display-side relay constants. */
object RelayConfig {
    const val RELAY_URL = "wss://ws.hexstacker.com"
    const val STUN_URL = "stun:stun.hexstacker.com:3478"

    /** The display's clientId is the literal "display" so the relay restores slot 0 across reconnects. */
    const val DISPLAY_CLIENT_ID = "display"

    /** Slot 0 (display) + MAX_PLAYERS(8) controllers. */
    const val MAX_CLIENTS = 9

    /** Where phones load the controller (QR target) in a shipped build. Join URL = "<base>/<room>#<instance>". */
    const val DEFAULT_CONTROLLER_BASE_URL = "https://hexstacker.com"

    /**
     * The origin the QR / join URL actually points at. The web display reads this off
     * `window.location` for free, so a preview deploy retargets its own QR automatically;
     * a TV app has no origin to read, which is why the knob is explicit. Production
     * unless a debug launch calls [setControllerBase] (`--es hexHost`, see MainActivity),
     * which nothing in a shipped build does.
     */
    var controllerBaseUrl: String = DEFAULT_CONTROLLER_BASE_URL
        private set

    /**
     * Controller-URL template sent with `create`. The relay fills {room}/{instance}
     * and hands the result to clients that hold only the room code (`joined`,
     * `GET /room/:code`). Same shape as the QR join URL the web display registers
     * (controllerUrlTemplate in DisplayConnection.js).
     */
    val controllerUrlTemplate: String get() = "$controllerBaseUrl/{room}#{instance}"

    /**
     * Point the QR / join URL at another origin, e.g. a branch preview. Call before the
     * relay connects: the origin also rides the `create` frame as the controller-URL
     * template. A null/blank/unusable value leaves production in place, so the caller can
     * hand the raw launch value straight through. Mirrored by Protocol.setControllerBase (Swift).
     */
    fun setControllerBase(raw: String?): String {
        normalizedBase(raw)?.let { controllerBaseUrl = it }
        return controllerBaseUrl
    }

    /**
     * [raw] as a bare origin: trimmed, scheme defaulted to https, any path or trailing
     * slash dropped ("preview-x.hexstacker.com" -> "https://preview-x.hexstacker.com").
     * null when it names no host or carries a scheme a phone can't open.
     */
    fun normalizedBase(raw: String?): String? {
        var s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val scheme = s.substringBefore("://").lowercase()
        if (scheme != "http" && scheme != "https") return null
        val authority = s.substringAfter("://").takeWhile { it != '/' && it != '?' && it != '#' }
        if (authority.isEmpty()) return null
        return "$scheme://$authority"
    }

    const val MAX_RECONNECT_ATTEMPTS = 5
    const val RECONNECT_BASE_MS = 1000L
    const val RECONNECT_FACTOR = 1.5
    const val RECONNECT_CAP_MS = 5000L

    /** Tear down + reconnect if the self-echo goes silent this long (6x the 1Hz heartbeat). */
    const val SELF_HEARTBEAT_DEAD_MS = 6000L
    const val HEARTBEAT_INTERVAL_MS = 1000L

    /** A socket can complete the WS upgrade but never get a created/joined answer
     *  (wedged shard). The heartbeat only starts on created/joined, so this is the
     *  only canary during the handshake window — a silent relay is treated as a
     *  drop. Mirrors appletv RelayClient.handshakeTimeoutSeconds. */
    const val HANDSHAKE_TIMEOUT_MS = 6000L

    /** Relay eviction close code: another client claimed our clientId/slot. */
    const val CLOSE_CODE_REPLACED = 4000

    /** Room-teardown close code: the host sent close_room, or the relay's hostless
     *  grace expired. The room is gone (not just this socket), so reconnect logic
     *  must not rejoin it; the client unpins the room and creates a fresh one. */
    const val CLOSE_CODE_ROOM_CLOSED = 4001
}

/** Application message-type strings (data.type), verbatim from protocol.js. */
object Msg {
    // Controller -> Display
    const val HELLO = "hello"
    const val INPUT = "input"
    const val SOFT_DROP = "soft_drop"
    const val SOFT_DROP_END = "soft_drop_end"
    const val START_GAME = "start_game"
    const val PLAY_AGAIN = "play_again"
    const val RETURN_TO_LOBBY = "return_to_lobby"
    const val PAUSE_GAME = "pause_game"
    const val RESUME_GAME = "resume_game"
    const val LEAVE = "leave"
    const val SET_LEVEL = "set_level"
    const val SET_COLOR = "set_color"
    const val SET_NAME = "set_name"
    const val SET_DISPLAY_MUTE = "set_display_mute"
    const val PING = "ping"

    // Display -> specific controller
    const val PONG = "pong"
    const val PLAYER_STATE = "player_state"

    // Display -> all controllers (broadcast)
    const val ERROR = "error"

    /** Internal display self-liveness canary (echoed via relay slot 0); not in protocol.js MSG. */
    const val HEARTBEAT = "_heartbeat"
}

/** protocol.js ROOM_STATE. */
enum class RoomState(val wire: String) {
    LOBBY("lobby"),
    COUNTDOWN("countdown"),
    PLAYING("playing"),
    RESULTS("results");

    companion object {
        /** Decode the room core's `roomState`. An unknown value can only mean the
         *  bundle moved ahead of this mirror, and a lobby is the safe reading. */
        fun fromWire(wire: String?): RoomState = entries.firstOrNull { it.wire == wire } ?: LOBBY
    }
}

/**
 * Why the game is frozen. Wire values are the room core's `RoomCore.PAUSE`, and only
 * [MANUAL] ever reaches a controller: the other two are display-internal, they resolve
 * themselves, and a controller shown either would sit on a pause overlay whose Continue
 * the display ignores. Pinned by tests/protocol-android-parity.test.js.
 */
enum class PauseReason(val wire: String) {
    MANUAL("manual"),
    AUTO("auto"),
    CONNECTION("connection");
}

/** Tolerant decoder for relay frames. */
internal val RelayJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
    explicitNulls = false
}

// ---- Outbound frames (serialized to text and sent). `type` first so encoded bytes match the web. ----
@Serializable
data class CreateFrame(
    val type: String = "create",
    val clientId: String,
    val maxClients: Int,
    /** Controller-URL template ({room}/{instance}); omitted from the wire when null (explicitNulls = false). */
    val url: String? = null,
)

@Serializable
data class JoinFrame(val type: String = "join", val clientId: String, val room: String)

@Serializable
data class SendFrame(val type: String = "send", val data: JsonObject, val to: Int? = null)

@Serializable
data class SetStateFrame(val type: String = "set_state", val data: JsonObject)

@Serializable
data class CloseRoomFrame(val type: String = "close_room")

// ---- Inbound frames (decoded from the parsed root object, per type) ----
@Serializable
data class CreatedFrame(
    val room: String = "",
    val index: Int = 0,
    val instance: String? = null,
    val region: String? = null,
)

@Serializable
data class JoinedFrame(val room: String = "", val index: Int = 0, val peers: List<Int> = emptyList())

@Serializable
data class PeerEventFrame(val index: Int = -1)

@Serializable
data class MessageFrame(val from: Int = -1, val data: JsonObject = JsonObject(emptyMap()))

@Serializable
data class ErrorFrame(val message: String = "unknown relay error")

/**
 * Lenient inbound app-message parser (mirrors Protocol.swift ControllerMessage). The
 * `data` object on a `message` frame is heterogeneous; every field but `type` is
 * nullable, with number/string coercion matching the web display.
 */
data class ControllerMessage(
    val type: String,
    val action: String? = null,
    val speed: Double? = null,
    val name: String? = null,
    val autoName: Boolean? = null,
    val level: Int? = null,
    val colorIndex: Int? = null,
    val muted: Boolean? = null,
    val t: Double? = null,
    val rejoinId: Int? = null,
    val rejoinToken: Int? = null,
) {
    companion object {
        fun from(obj: JsonObject): ControllerMessage? {
            val type = obj.prim("type")?.contentOrNull ?: return null
            return ControllerMessage(
                type = type,
                action = obj.str("action"),
                speed = obj.dbl("speed"),
                name = obj.str("name"),
                autoName = obj.bool("autoName"),
                level = obj.int("level"),
                colorIndex = obj.int("colorIndex"),
                muted = obj.bool("muted"),
                t = obj.dbl("t"),
                rejoinId = obj.int("rejoinId"),
                rejoinToken = obj.int("rejoinToken"),
            )
        }

        private fun JsonObject.prim(k: String) = this[k] as? JsonPrimitive
        private fun JsonObject.str(k: String): String? =
            prim(k)?.let { if (it.isString) it.content else null }
        private fun JsonObject.bool(k: String): Boolean? = prim(k)?.booleanOrNull
        private fun JsonObject.int(k: String): Int? =
            prim(k)?.let { it.intOrNull ?: it.doubleOrNull?.toInt() ?: it.contentOrNull?.toIntOrNull() }
        private fun JsonObject.dbl(k: String): Double? =
            prim(k)?.let { it.doubleOrNull ?: it.contentOrNull?.toDoubleOrNull() }
    }
}

/** Fixed-shape display->controller payload builders (mirror Protocol.swift OutboundMessage). */
object OutboundMessage {
    fun pong(t: Double?): JsonObject = buildJsonObject {
        put("type", Msg.PONG); if (t != null) put("t", t)
    }

    fun error(message: String): JsonObject = buildJsonObject { put("type", Msg.ERROR); put("message", message) }
    fun playerState(lines: Int, alive: Boolean): JsonObject = buildJsonObject {
        put("type", Msg.PLAYER_STATE); put("lines", lines); put("alive", alive)
    }

    fun playerDead(): JsonObject = buildJsonObject { put("type", Msg.PLAYER_STATE); put("alive", false) }
}

/** The relay transport the DisplayCoordinator drives (mirror Protocol.swift RelayTransport). */
interface RelayTransport {
    fun connect()
    fun disconnect()
    fun sendTo(index: Int, data: JsonObject)
    fun broadcast(data: JsonObject)
    fun setState(data: JsonObject)

    /**
     * Forget the current (dead) room and open a fresh session: the next socket open
     * sends `create` instead of `join`, and the new room arrives via [onCreated].
     * Used when the relay reports the room gone after a display rejoin (the web's
     * resetToWelcome -> connectAndCreateRoom path).
     */
    fun createFresh()

    /**
     * Tear the room down for everyone (host/slot-0 only; the relay rejects it from
     * anyone else): the relay deletes the room (GET /room/:code turns 404, killing
     * stale rejoin links) and closes every member socket with 4001 "room closed".
     * No ack message; the sender's own 4001 close is the confirmation, unless it
     * disconnects first (fine on app exit, where the socket is going away anyway).
     */
    fun closeRoom()

    var onCreated: ((room: String, instance: String?, region: String?) -> Unit)?
    var onJoined: ((room: String, peers: List<Int>) -> Unit)?
    var onPeerJoined: ((index: Int) -> Unit)?
    var onPeerLeft: ((index: Int) -> Unit)?
    var onMessage: ((from: Int, data: JsonObject) -> Unit)?
    var onRelayError: ((message: String) -> Unit)?
    var onReplaced: (() -> Unit)?
    // reconnectAttempt is the current retry count, snapshotted at emission time (see
    // RelayClient.emitState) so the UI's "Attempt N of M" matches the delivered state
    // instead of a later read of the transport's still-mutating counter. Only
    // meaningful for RECONNECTING; other states pass whatever the counter reads.
    var onConnectionState: ((ConnectionState, reconnectAttempt: Int) -> Unit)?

    enum class ConnectionState { IDLE, CONNECTING, OPEN, RECONNECTING, CLOSED }
}
