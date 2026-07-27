package com.hexstacker.core.room

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.model.EngineJson
import com.hexstacker.core.net.RoomState
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * The room's single source of truth, reached from Kotlin.
 *
 * `server/RoomBrain.js` — the SAME module the web display and Apple TV run, shipped
 * inside `dist/partycore.js` — owns the roster, auto-naming, name sanitizing, colour
 * slots, host election, the pause/mute/results facts a display owns, and the retained
 * snapshot controllers derive their whole UI from. This class is a typed Kotlin
 * surface over it, and nothing else in :core may re-implement any of that: the three
 * displays used to, and they drifted (three auto-name algorithms, three name
 * sanitizers, one platform with no blocklist at all) where a regex parity guard could
 * not see it.
 *
 * Marshalling: quickjs-kt has no call-with-arguments API, so every call is an
 * interpolated source string and everything crosses as JSON through the bridge's four
 * generic room entry points (see [EngineBridge.roomCallJson]). Arguments are built as
 * [JsonElement]s and escaped by `jsString`, never spliced raw — room payloads carry
 * player names, i.e. arbitrary user text.
 *
 * [snapshot] is re-read after every mutator, so callers get a settled read model for
 * free and can never publish a stale snapshot; pure reads skip the extra crossing.
 *
 * SESSION-lived, unlike the per-match engine: created once at coordinator start and
 * surviving across matches, so it must exist before the first room event is handled.
 */
class RoomBrainClient private constructor(private val bridge: EngineBridge) {

    /** The last snapshot the brain produced, decoded. */
    var snapshot: RoomSnapshot = RoomSnapshot.EMPTY
        private set

    /** The same snapshot as parsed JSON, published verbatim via `set_state` so the
     *  bytes on the wire are the brain's, not a Kotlin re-encoding of them. */
    var snapshotJson: JsonObject = JsonObject(emptyMap())
        private set

    val state: RoomState get() = snapshot.state
    val host: Int? get() = snapshot.hostPeerIndex
    val participants: List<Int> get() = snapshot.participants
    val size: Int get() = snapshot.size

    companion object {
        /** Publish hints. Every mutator returns one; the shells own the timer, because
         *  a throttle timer needs a real clock and the brain has none. */
        const val PUBLISH_NOW = "now"
        const val PUBLISH_SOON = "soon"

        /**
         * Construct the brain inside [bridge]'s JS context and read its first snapshot.
         * [options] is the RoomBrain constructor object (`liveness`, `maxPlayers`, ...).
         */
        suspend fun create(bridge: EngineBridge, options: JsonObject): RoomBrainClient {
            bridge.roomInit(options.toString())
            return RoomBrainClient(bridge).also { it.refresh() }
        }
    }

    // =====================================================================
    // Roster lifecycle
    // =====================================================================

    suspend fun peerJoined(peerIndex: Int, nowMs: Double): PeerJoined =
        mutate(call("peerJoined", num(peerIndex), num(nowMs)))

    /** [msg] is the raw HELLO body: `{ name, autoName, colorIndex, rejoinToken }`. */
    suspend fun hello(peerIndex: Int, msg: JsonObject, nowMs: Double): Hello =
        mutate(call("hello", num(peerIndex), msg, num(nowMs)))

    suspend fun peerLeft(peerIndex: Int): PeerLeft = mutate(call("peerLeft", num(peerIndex)))

    /** Join order, oldest first, with the fields the wire snapshot omits. */
    suspend fun list(): List<PlayerRecord> = decode(call("list"))

    // =====================================================================
    // Controller settings
    // =====================================================================

    suspend fun setLevel(peerIndex: Int, level: Int?): Changed =
        mutate(call("setLevel", num(peerIndex), num(level)))

    suspend fun setColor(peerIndex: Int, colorIndex: Int?): Changed =
        mutate(call("setColor", num(peerIndex), num(colorIndex)))

    suspend fun setName(peerIndex: Int, name: String?): Changed =
        mutate(call("setName", num(peerIndex), str(name)))

    // =====================================================================
    // Snapshot inputs the display owns
    // =====================================================================

    suspend fun setAlive(peerIndex: Int, alive: Boolean): Changed =
        mutate(call("setAlive", num(peerIndex), JsonPrimitive(alive)))

    suspend fun clearAlive() = unitMutating(call("clearAlive"))

    suspend fun setResults(results: JsonArray?) =
        unitMutating(call("setResults", results ?: JsonNull))

    suspend fun setMuted(muted: Boolean): Changed = mutate(call("setMuted", JsonPrimitive(muted)))

    suspend fun setPaused(paused: Boolean) = unitMutating(call("setPaused", JsonPrimitive(paused)))
    suspend fun setAutoPaused(paused: Boolean) = unitMutating(call("setAutoPaused", JsonPrimitive(paused)))
    suspend fun setConnectionPaused(paused: Boolean) =
        unitMutating(call("setConnectionPaused", JsonPrimitive(paused)))

    // =====================================================================
    // Room lifecycle
    // =====================================================================

    suspend fun transitionTo(to: RoomState): Changed = mutate(call("transitionTo", str(to.wire)))

    /** Board-layout order for the round about to start (join order, first joiner leftmost). */
    suspend fun freezeParticipantOrder(): List<Int> = mutate(call("freezeParticipantOrder"))

    /** Drop everyone who went missing; returns the peers removed. */
    suspend fun pruneDisconnected(nowMs: Double): List<Int> =
        mutate(call("pruneDisconnected", num(nowMs)))

    /** Fold the late joiners of the round that just ended into the participant list. */
    suspend fun admitWaiting(): List<Int> = mutate(call("admitWaiting"))

    /** Label a finished ranking with roster names/colours and append the players who
     *  sat the round out (flagged `newPlayer`). Returns the enriched array. */
    suspend fun enrichResults(ranking: JsonArray): JsonArray = decode(call("enrichResults", ranking))

    suspend fun reset() = unitMutating(call("reset"))

    // =====================================================================
    // Liveness (predicates in the brain, effects in the shell)
    // =====================================================================

    suspend fun onSeen(peerIndex: Int, nowMs: Double) = unit(call("onSeen", num(peerIndex), num(nowMs)))

    /**
     * One batched liveness pull, called once per second by the shell instead of
     * crossing the bridge on every inbound controller packet: [seen] is the set of
     * peers heard from since the last tick. Returns decisions, never effects, and
     * moves nothing the snapshot carries, so it skips the snapshot re-read.
     */
    suspend fun tick(nowMs: Double, seen: List<Int>): LivenessTick =
        decode(call("tick", num(nowMs), JsonArray(seen.map { JsonPrimitive(it) })))

    suspend fun markDisconnected(peerIndex: Int) = unitMutating(call("markDisconnected", num(peerIndex)))
    suspend fun markReconnected(peerIndex: Int) = unitMutating(call("markReconnected", num(peerIndex)))
    suspend fun clearDisconnected(nowMs: Double) = unitMutating(call("clearDisconnected", num(nowMs)))

    suspend fun isDisconnected(peerIndex: Int): Boolean = decode(call("isDisconnected", num(peerIndex)))
    suspend fun allParticipantsDisconnected(): Boolean = decode(call("allParticipantsDisconnected"))
    suspend fun hasLateJoiners(): Boolean = decode(call("hasLateJoiners"))
    suspend fun graceTick(nowMs: Double): Boolean = decode(call("graceTick", num(nowMs)))
    suspend fun connectedCount(): Int = decode(bridge.roomGetJson("connectedCount"))

    /** The publish-throttle window (RoomBrain.SNAPSHOT_THROTTLE_MS, exposed on the
     *  prototype for exactly this read), so the policy is single-sourced with the web
     *  instead of hand-mirrored into a Kotlin constant that then drifts. */
    suspend fun snapshotThrottleMs(): Double = decode(bridge.roomGetJson("snapshotThrottleMs"))

    // =====================================================================
    // Internals
    // =====================================================================

    private suspend fun call(method: String, vararg args: JsonElement): String =
        bridge.roomCallJson(method, JsonArray(args.toList()).toString())

    /** Re-read the published snapshot. Runs after every call that can move it, so a
     *  publish always ships what the brain holds right now. */
    private suspend fun refresh() {
        val js = bridge.roomSnapshotJson()
        snapshotJson = EngineJson.json.parseToJsonElement(js).jsonObject
        snapshot = EngineJson.json.decodeFromJsonElement(RoomSnapshot.serializer(), snapshotJson)
    }

    private suspend inline fun <reified T> mutate(json: String): T {
        val result: T = decode(json)
        refresh()
        return result
    }

    /** Void mutators that move the snapshot: the three pause flags, alive, results and
     *  reset all project into it, so the read model must follow them. */
    private suspend fun unitMutating(json: String) {
        unit(json)
        refresh()
    }

    private fun unit(json: String) {
        // Void mutators answer "null"; the check exists only to catch a method whose
        // shape changed under us (a JS throw already surfaced as an exception).
        check(json == "null") { "unexpected room return value: $json" }
    }

    private inline fun <reified T> decode(json: String): T = EngineJson.json.decodeFromString(json)

    private fun num(value: Int?): JsonElement = if (value == null) JsonNull else JsonPrimitive(value)
    private fun num(value: Double): JsonElement = JsonPrimitive(value)
    private fun str(value: String?): JsonElement = if (value == null) JsonNull else JsonPrimitive(value)

    // ---- returned decisions (the brain's own result shapes) ----

    @Serializable
    data class PeerJoined(
        val added: Boolean = false,
        val colorIndex: Int? = null,
        /** False for a late joiner: they wait out the round. */
        val joinedLobby: Boolean = false,
        val publish: String = "none",
    )

    @Serializable
    data class Hello(
        val accepted: Boolean = false,
        val isNew: Boolean = false,
        val colorIndex: Int? = null,
        /** A cross-device rejoin claim was honoured; the shell remaps its own
         *  peer-indexed structures from [oldPeerIndex]. */
        val claimed: Boolean = false,
        val oldPeerIndex: Int? = null,
        val roomFull: Boolean = false,
        val publish: String = "none",
    )

    @Serializable
    data class PeerLeft(
        val known: Boolean = false,
        /** `disconnected` (keep the row, raise a rejoin QR) | `removed` | `none`. */
        val action: String = "none",
        val returnedToLobby: Boolean = false,
        val publish: String = "none",
    )

    @Serializable
    data class Changed(
        val changed: Boolean = false,
        val level: Int? = null,
        val colorIndex: Int? = null,
        val name: String? = null,
        val publish: String = "none",
    )

    @Serializable
    data class LivenessTick(
        val expired: List<Int> = emptyList(),
        /** The late-joiner grace window elapsed: return to the lobby. */
        val graceFired: Boolean = false,
    )
}
