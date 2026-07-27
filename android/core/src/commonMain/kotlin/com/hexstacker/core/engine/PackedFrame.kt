package com.hexstacker.core.engine

import com.hexstacker.core.model.Cell
import com.hexstacker.core.model.EngineJson
import com.hexstacker.core.model.FrameResult
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.model.Ghost
import com.hexstacker.core.model.Axial
import com.hexstacker.core.model.Piece
import com.hexstacker.core.model.PlayerState
import kotlinx.serialization.Serializable

/**
 * Reader for the packed native wire format — a port of `PartyCore.unpackFrame`
 * (server/PartyCore.js), which is the reference implementation. Both are gated
 * against `tests/fixtures/partycore-packed-golden.json`, so a layout change that
 * only lands on one side fails the build rather than the TV.
 *
 * Why this exists: the JS/native boundary, not the simulation, is what costs a
 * frame. At eight boards the physics is ~0.5ms while `JSON.stringify` plus a
 * kotlinx decode is ~11ms — most of it spent rebuilding objects the renderer
 * immediately flattens again. Every snapshot field is a small integer, so the
 * payload crosses as one integer per UTF-16 code unit instead.
 *
 * Every value is biased +1 on the wire: quickjs-kt hands JS strings over as C
 * strings, so a NUL code unit would truncate the payload — and 0 is the most
 * common raw value here (every empty grid cell). Coordinates are biased by
 * [COORD_BIAS] first, because a piece still in the spawn buffer has a negative row.
 */
internal object PackedFrame {

    const val PACK_VERSION = 1
    private const val COORD_BIAS = 256

    /** The `{events, commands}` tail, which stays JSON: both are small, rare, and
     *  genuinely heterogeneous, so packing them would buy nothing and cost clarity. */
    @Serializable
    private data class Tail(
        val events: List<com.hexstacker.core.model.GameEvent> = emptyList(),
        val commands: List<com.hexstacker.core.model.Command> = emptyList(),
    )

    /** Decode a packed frame. The snapshot is null when the frame was
     *  render-identical to the last delivered one (PartyCore omits it). */
    fun decode(packed: String): FrameResult {
        val r = Reader(packed)
        val version = r.next()
        check(version == PACK_VERSION) { "packed layout version $version, expected $PACK_VERSION" }
        var snapshot: GameSnapshot? = null
        if (r.next() == 1) {
            val count = (r.next() shl 16) or r.next()
            val bodyStart = r.at
            snapshot = readSnapshot(r)
            // Landing anywhere but the tail means the layout drifted between this
            // reader and the packer; trusting the count instead would surface as a
            // confusing JSON parse error further down.
            check(r.at == bodyStart + count) { "packed body: read ${r.at - bodyStart} of $count values" }
        }
        val tail = EngineJson.json.decodeFromString<Tail>(packed.substring(r.at))
        return FrameResult(events = tail.events, snapshot = snapshot, commands = tail.commands)
    }

    private class Reader(val s: String) {
        var at = 0
        fun next(): Int = s[at++].code - 1
    }

    private fun readSnapshot(r: Reader): GameSnapshot {
        val elapsed = ((r.next() shl 16) or r.next()).toDouble()
        val n = r.next()
        val players = ArrayList<PlayerState>(n)
        repeat(n) { players.add(readPlayer(r)) }
        return GameSnapshot(players = players, elapsed = elapsed)
    }

    private fun readPlayer(r: Reader): PlayerState {
        val id = r.next()
        val level = r.next()
        val lines = (r.next() shl 16) or r.next()
        val alive = r.next() == 1
        val pendingGarbage = r.next()
        val gridVersion = (r.next() shl 16) or r.next()

        // Absent whenever the delivery filter stripped it (unchanged since the last
        // one this host was sent); EngineBridge re-attaches its cached rows.
        var grid: List<List<Int>> = emptyList()
        if (r.next() == 1) {
            val rows = r.next()
            val cols = r.next()
            val g = ArrayList<List<Int>>(rows)
            repeat(rows) {
                val row = ArrayList<Int>(cols)
                repeat(cols) { row.add(r.next()) }
                g.add(row)
            }
            grid = g
        }

        var piece: Piece? = null
        if (r.next() == 1) {
            val typeId = r.next()
            val anchorCol = r.next() - COORD_BIAS
            val anchorRow = r.next() - COORD_BIAS
            val cellCount = r.next()
            val cells = ArrayList<Axial>(cellCount)
            repeat(cellCount) { cells.add(Axial(r.next() - COORD_BIAS, r.next() - COORD_BIAS)) }
            piece = Piece(
                type = PIECE_TYPES[typeId - 1],
                typeId = typeId,
                anchorCol = anchorCol,
                anchorRow = anchorRow,
                cells = cells,
                blocks = readCells(r),
            )
        }

        var ghost: Ghost? = null
        if (r.next() == 1) {
            val gt = r.next()
            ghost = Ghost(
                typeId = if (gt == 0) null else gt,
                anchorCol = r.next() - COORD_BIAS,
                anchorRow = r.next() - COORD_BIAS,
                blocks = readCells(r),
            )
        }

        val hold = r.next()
        val nextCount = r.next()
        val next = ArrayList<String>(nextCount)
        repeat(nextCount) { next.add(PIECE_TYPES[r.next() - 1]) }
        val clearing = if (r.next() == 1) readCells(r) else null

        return PlayerState(
            id = id,
            grid = grid,
            currentPiece = piece,
            ghost = ghost,
            holdPiece = if (hold == 0) null else PIECE_TYPES[hold - 1],
            nextPieces = next,
            level = level,
            lines = lines,
            alive = alive,
            pendingGarbage = pendingGarbage,
            clearingCells = clearing,
            gridVersion = gridVersion,
        )
    }

    private fun readCells(r: Reader): List<Cell> {
        val n = r.next()
        val out = ArrayList<Cell>(n)
        repeat(n) { out.add(Cell(r.next() - COORD_BIAS, r.next() - COORD_BIAS)) }
        return out
    }

    /** constants.js PIECE_TYPES, indexed by typeId-1. Pinned by
     *  tests/protocol-android-parity.test.js alongside the other mirrored constants. */
    private val PIECE_TYPES = listOf("I3", "V3", "T3", "o", "d", "b")
}
