package com.hexstacker.core.room

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * One roster row, decoded from the room brain's `list()` (join order, oldest first).
 *
 * The FULL record, unlike the wire snapshot's per-player entry: it also carries
 * [joinedAt] (the monotonic join counter the board layout and host election tie-break
 * on) and [connected], which the snapshot deliberately does not ship. Read it where
 * the lobby/board layout needs more than the snapshot has.
 *
 * Immutable: `server/RoomBrain.js` (running in QuickJS) is the only writer, and this
 * is a decoded copy of what it holds. Nothing here may be mutated locally — a write
 * that doesn't go through the brain is exactly the drift this refactor removed.
 *
 * Field names follow the JS record, except `playerIndex`, which is the dense COLOUR
 * SLOT (0..MAX_PLAYERS-1) rather than the relay peer index; it is remapped to
 * [colorSlot] here so that distinction survives on this side.
 */
@Serializable
data class PlayerRecord(
    val peerIndex: Int,
    val playerName: String = "",
    @SerialName("playerIndex") val colorSlot: Int = 0,
    val startLevel: Int = 1,
    /** Kit-owned monotonic join counter (NOT a wall clock); first joiner leftmost. */
    val joinedAt: Int = 0,
    /** Kit-owned presence flag; false while the peer sits in the disconnect window. */
    val connected: Boolean = true,
    /** False until this player's own HELLO lands (peer_joined registers a placeholder
     *  row with a guessed name/colour so the palette slot is claimed immediately). */
    val helloSeen: Boolean = true,
)
