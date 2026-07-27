package com.hexstacker.core.room

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.model.EngineJson
import com.hexstacker.core.net.PauseReason
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
 * `server/RoomCore.js` — the SAME module the web display and Apple TV run, shipped
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
class RoomCoreClient private constructor(private val bridge: EngineBridge) {

    /** The last snapshot the room core produced, decoded. */
    var snapshot: RoomSnapshot = RoomSnapshot.EMPTY
        private set

    /** The same snapshot as parsed JSON, published verbatim via `set_state` so the
     *  bytes on the wire are the room core's, not a Kotlin re-encoding of them. */
    var snapshotJson: JsonObject = JsonObject(emptyMap())
        private set

    val state: RoomState get() = snapshot.state
    val host: Int? get() = snapshot.hostPeerIndex
    val participants: List<Int> get() = snapshot.participants
    val size: Int get() = snapshot.size

    companion object {
        /** Publish hints (RoomCore.PUBLISH), pinned to the module by
         *  tests/protocol-android-parity.test.js. Every mutator returns one; the shells
         *  own the timer, because a throttle timer needs a real clock and the room core
         *  has none. How STRONG each hint is is not mirrored here — see [publishRank]. */
        const val PUBLISH_NONE = "none"
        const val PUBLISH_NOW = "now"
        const val PUBLISH_SOON = "soon"

        /**
         * Construct the room core inside [bridge]'s JS context and read its first snapshot.
         * [options] is the RoomCore constructor object (`liveness`, `maxPlayers`, ...).
         */
        suspend fun create(bridge: EngineBridge, options: JsonObject): RoomCoreClient {
            bridge.roomInit(options.toString())
            return RoomCoreClient(bridge).also { it.refresh() }
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

    /**
     * WHY the game is frozen, or null. The room core is the authority; this is a Kotlin
     * mirror because the frame loop reads it every tick and crossing into JS for that is
     * absurd. It lives HERE rather than in the coordinator so that the three calls able
     * to move it are the three below, in one file: a coordinator-side copy had to be
     * hand-cleared after [reset] and nothing would have caught the next call that forgot.
     *
     * Note the snapshot cannot serve this: it deliberately projects only
     * [PauseReason.MANUAL] into the single `paused` a controller is allowed to see.
     */
    var pauseReason: PauseReason? = null
        private set

    /** Freeze for [reason]. Takes effect while the room is RUNNING and nothing else has
     *  us frozen — first freeze wins, so a display-internal reason can never overwrite
     *  (and then silently lift) a host's deliberate pause. The rule lives in the room
     *  core so tvOS and the web display cannot answer it differently. */
    suspend fun pause(reason: PauseReason): Changed =
        pauseCall(call("pause", JsonPrimitive(reason.wire)))

    /** Lift the freeze if [reason] is why we are frozen; null ends it outright (the
     *  room-lifecycle clear: a new match, a return to the lobby). */
    suspend fun resume(reason: PauseReason?): Changed =
        pauseCall(call("resume", reason?.let { JsonPrimitive(it.wire) } ?: JsonNull))

    /** Every pause/resume answer carries the reason now in force whether or not the call
     *  changed anything, so the mirror re-syncs on refusals too and cannot drift. */
    private suspend fun pauseCall(json: String): Changed {
        val res: Changed = mutate(json)
        pauseReason = res.reason?.let { wire -> PauseReason.entries.firstOrNull { it.wire == wire } }
        return res
    }

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

    /** Fresh room: roster, participants, liveness, results and the pause all go. */
    suspend fun reset() {
        unitMutating(call("reset"))
        pauseReason = null   // reset() clears the room core's copy; the mirror follows here
    }

    // =====================================================================
    // Liveness (predicates in the room core, effects in the shell)
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

    /** The publish-throttle window (RoomCore.SNAPSHOT_THROTTLE_MS, exposed on the
     *  prototype for exactly this read), so the policy is single-sourced with the web
     *  instead of hand-mirrored into a Kotlin constant that then drifts. */
    suspend fun snapshotThrottleMs(): Double = decode(bridge.roomGetJson("snapshotThrottleMs"))

    /** How strong each publish hint is (RoomCore.publishRank), read for the same reason:
     *  a shell that batches mutations folds them down to the strongest hint, and which
     *  one that is belongs to the room core, not to three hand-written copies. */
    suspend fun publishRank(): Map<String, Int> = decode(bridge.roomGetJson("publishRank"))

    // =====================================================================
    // Internals
    // =====================================================================

    private suspend fun call(method: String, vararg args: JsonElement): String =
        bridge.roomCallJson(method, JsonArray(args.toList()).toString())

    /** Re-read the published snapshot. Runs after every call that can move it, so a
     *  publish always ships what the room core holds right now. */
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

    // ---- returned decisions (the room core's own result shapes) ----

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
        /** The pause reason now in force (pause/resume only); null means running. */
        val reason: String? = null,
        val publish: String = "none",
    )

    @Serializable
    data class LivenessTick(
        val expired: List<Int> = emptyList(),
        /** The late-joiner grace window elapsed: return to the lobby. */
        val graceFired: Boolean = false,
    )
}
