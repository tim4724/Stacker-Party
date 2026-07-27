package com.hexstacker.core.room

import com.hexstacker.core.net.RoomState
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray

/**
 * The retained room snapshot, decoded from `RoomBrain.snapshotJSON()`.
 *
 * This is the protocol: the display publishes exactly this object via the relay's
 * `set_state` and sends nothing else about the room, and controllers derive their
 * whole UI from it, screen routing included. It is also the display's own read
 * model — the coordinator branches on [state], [participants] and [hostPeerIndex]
 * far too often to cross into JS for each one, and re-reading the published
 * snapshot after every mutation is the cheapest way to stay honest about it.
 *
 * The wire keys are the brain's; do not rename them.
 */
@Serializable
data class RoomSnapshot(
    val roomState: String = "lobby",
    val hostPeerIndex: Int? = null,
    /** Only a host-pressed pause. The auto- (everyone gone) and connection pauses
     *  are display-internal, so they deliberately never reach a controller. */
    val paused: Boolean = false,
    val displayMuted: Boolean = false,
    /** Who is actually in the running match, in board-layout order. A player in
     *  [players] but absent here during countdown/playing joined late. */
    val participants: List<Int> = emptyList(),
    /** Keyed by relay peer index (a sparse id, NOT a colour slot). */
    val players: Map<Int, RoomPlayer> = emptyMap(),
    /** The final ranking; present only while [state] is RESULTS. */
    val results: JsonArray? = null,
) {
    val state: RoomState get() = RoomState.fromWire(roomState)
    val size: Int get() = players.size

    fun player(peerIndex: Int): RoomPlayer? = players[peerIndex]
    fun has(peerIndex: Int): Boolean = players.containsKey(peerIndex)
    fun isParticipant(peerIndex: Int): Boolean = participants.contains(peerIndex)

    companion object {
        /** Before the brain exists (see DisplayCoordinator.consume): an empty lobby. */
        val EMPTY = RoomSnapshot()
    }
}

/** One player as controllers see them. [color] is the dense colour slot. */
@Serializable
data class RoomPlayer(
    val name: String = "",
    val color: Int = 0,
    val startLevel: Int = 1,
    val alive: Boolean = true,
    val helloSeen: Boolean = true,
)
