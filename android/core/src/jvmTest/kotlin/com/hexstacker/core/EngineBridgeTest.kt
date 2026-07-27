package com.hexstacker.core

import com.dokar.quickjs.quickJs
import com.hexstacker.core.engine.EngineBootstrap
import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.engine.EngineBridge.PlayerSpec
import com.hexstacker.core.engine.InputAction
import com.hexstacker.core.engine.PackedFrame
import com.hexstacker.core.model.EngineConstants
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import kotlinx.coroutines.runBlocking
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Ports the appletv `EngineCheck/main.swift` checks through the typed Kotlin
 * bridge. The engine's bit-for-bit QuickJS parity is already proven by
 * [FrameGoldenConformanceTest]; this guards the typed decode boundary +
 * determinism via data-class structural equality.
 */
class EngineBridgeTest {

    private fun bundle(): String {
        val p = System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set by build")
        return File(p).readText()
    }

    private suspend fun newBridge() = EngineBridge.create(bundle())

    @Test
    fun loadAndSpawnShape() = runBlocking {
        val b = newBridge()
        try {
            b.createGame(listOf(PlayerSpec(0, 1), PlayerSpec(1, 1)), seed = 0xC0FFEE)
            val snap = b.snapshot()
            assertEquals(listOf(0, 1), snap.players.map { it.id })
            val p0 = snap.players[0]
            assertEquals(EngineConstants.VISIBLE_ROWS, p0.grid.size)
            assertTrue(p0.grid.all { it.size == EngineConstants.COLS }, "every row is 9 cols")
            val piece = assertNotNull(p0.currentPiece)
            assertNotNull(p0.ghost)
            assertEquals(3, p0.nextPieces.size)
            assertNull(p0.holdPiece)
            assertEquals(EngineConstants.PIECE_TYPE_TO_ID[piece.type], piece.typeId)
            assertTrue(piece.blocks.size in 3..4, "a tromino/tetromino has 3-4 blocks")
        } finally {
            b.close()
        }
    }

    @Test
    fun hardDropLocks() = runBlocking {
        val b = newBridge()
        try {
            b.createGame(listOf(PlayerSpec(0, 1), PlayerSpec(1, 1)), seed = 1)
            b.drainEvents()
            b.processInput(0, InputAction.HARD_DROP)
            val events = b.drainEvents()
            val lock = events.find { it.type == "piece_lock" && it.playerId == 0 }
            assertNotNull(lock, "hard_drop emits a piece_lock for player 0")
            assertTrue(lock.typeId!! in 1..6)
            assertTrue(lock.blocks!!.isNotEmpty())
        } finally {
            b.close()
        }
    }

    @Test
    fun holdSwapsCurrentPiece() = runBlocking {
        val b = newBridge()
        try {
            b.createGame(listOf(PlayerSpec(0, 1)), seed = 1)
            val before = b.snapshot().players[0].currentPiece!!.type
            b.processInput(0, InputAction.HOLD)
            assertEquals(before, b.snapshot().players[0].holdPiece)
        } finally {
            b.close()
        }
    }

    /** Wire-level half of the grid strip/resend cycle: the shim omits a player's
     *  grid once its gridVersion has been delivered, keeps gridVersion for cache
     *  keying, and re-sends the grid after a lock bumps the version. */
    @Test
    fun shimStripsUnchangedGridsOnTheWire() = runBlocking {
        quickJs {
            evaluate<Any?>(bundle())
            evaluate<Any?>(EngineBootstrap.SHIM + "\nvoid 0;")
            evaluate<Any?>("Bridge.create([[0,1],[1,1]], 7)")
            // Frames cross packed, so assert on the DECODED payload rather than on
            // substrings of JSON: a stripped grid arrives as an empty list, and
            // re-attaching cached rows is EngineBridge's job, not the reader's.
            val first = PackedFrame.decode(evaluate<String>("Bridge.framePacked(0)"))
            // HOLD changes the scene (so the snapshot is delivered at all — see the
            // scene-signature omission) without touching any grid: the delivered
            // snapshot strips every player's unchanged grid.
            evaluate<Any?>("Bridge.processInput(0, 'hold')")
            val second = PackedFrame.decode(evaluate<String>("Bridge.framePacked(16)"))
            assertTrue(
                assertNotNull(first.snapshot).players.all { it.grid.isNotEmpty() },
                "first pull carries full grids",
            )
            val secondPlayers = assertNotNull(second.snapshot, "hold re-delivers the snapshot").players
            assertTrue(secondPlayers.all { it.grid.isEmpty() }, "unchanged grids are stripped from later pulls")
            // gridVersion is what the strip decides on, so it has to survive the strip:
            // compare it to the full pull rather than merely assert it is a number.
            val firstVersions = assertNotNull(first.snapshot).players.associate { it.id to it.gridVersion }
            assertEquals(firstVersions, secondPlayers.associate { it.id to it.gridVersion },
                "gridVersion rides even on a frame whose grids were stripped")
            evaluate<Any?>("Bridge.processInput(0, 'hard_drop')") // lock bumps p0's gridVersion
            val third = PackedFrame.decode(evaluate<String>("Bridge.snapshotPacked()"))
            assertTrue(
                assertNotNull(third.snapshot).players.any { it.grid.isNotEmpty() },
                "a lock re-sends the changed grid",
            )
        }
        Unit
    }

    /** Wire-level half of the scene-signature cycle: frameJSON omits the whole
     *  snapshot while the scene is render-identical to the last delivered one,
     *  keeps events/commands on the wire, and re-delivers on a scene change. */
    @Test
    fun shimOmitsRenderIdenticalSnapshots() = runBlocking {
        quickJs {
            evaluate<Any?>(bundle())
            evaluate<Any?>(EngineBootstrap.SHIM + "\nvoid 0;")
            evaluate<Any?>("Bridge.create([[0,1],[1,1]], 7)")
            val first = PackedFrame.decode(evaluate<String>("Bridge.framePacked(0)"))
            assertNotNull(first.snapshot, "first pull delivers the snapshot")
            // 16ms later: no input, no gravity step, same timer second — omitted.
            val second = PackedFrame.decode(evaluate<String>("Bridge.framePacked(16)"))
            assertEquals(null, second.snapshot, "a render-identical frame omits the snapshot")
            assertNotNull(second.events, "events stay on the wire")
            assertNotNull(second.commands, "commands stay on the wire")
            evaluate<Any?>("Bridge.processInput(0, 'left')") // moves p0's piece
            val third = PackedFrame.decode(evaluate<String>("Bridge.framePacked(33)"))
            assertNotNull(third.snapshot, "a scene change re-delivers the snapshot")
        }
        Unit
    }

    /** Bridge-level half: consumers always see full, identical grids across
     *  pulls (the cached rows are re-attached), and a lock delivers the new grid. */
    @Test
    fun bridgeReattachesStrippedGrids() = runBlocking {
        val b = newBridge()
        try {
            b.createGame(listOf(PlayerSpec(0, 1), PlayerSpec(1, 1)), seed = 7)
            val first = assertNotNull(b.frame(0.0).snapshot, "first frame delivers a snapshot")
            first.players.forEach {
                assertEquals(EngineConstants.VISIBLE_ROWS, it.grid.size, "first pull carries full grids")
            }
            // HOLD changes the scene (so the frame delivers) but no grid: the wire
            // drops the grids, and the re-attached snapshots stay complete and identical.
            b.processInput(0, InputAction.HOLD)
            val second = assertNotNull(b.frame(16.0).snapshot, "a scene change delivers a snapshot")
            assertEquals(first.players.map { it.grid }, second.players.map { it.grid })

            // A lock bumps player 0's gridVersion: the next pull delivers the new grid.
            b.processInput(0, InputAction.HARD_DROP)
            val before = second.players.first { it.id == 0 }
            val after = b.snapshot().players.first { it.id == 0 }
            assertNotEquals(before.gridVersion, after.gridVersion)
            assertEquals(EngineConstants.VISIBLE_ROWS, after.grid.size)
            assertTrue(after.grid.flatten().any { it != 0 }, "locked cells present in the resent grid")
        } finally {
            b.close()
        }
    }

    /** Bridge-level half of the scene-signature cycle: frame() returns a null
     *  snapshot for render-identical frames; snapshot() stays a full pure read. */
    @Test
    fun bridgeOmitsRenderIdenticalFrameSnapshots() = runBlocking {
        val b = newBridge()
        try {
            b.createGame(listOf(PlayerSpec(0, 1), PlayerSpec(1, 1)), seed = 7)
            val first = assertNotNull(b.frame(0.0).snapshot)
            assertNull(b.frame(16.0).snapshot, "render-identical frame omits the snapshot")
            // snapshot() is a pure read: always full, and it must NOT update the
            // scene ledger (a countdown-static pull would otherwise suppress the
            // first PLAYING delivery).
            val pure = b.snapshot()
            assertEquals(first.players.map { it.grid }, pure.players.map { it.grid })
            assertNull(b.frame(33.0).snapshot, "a snapshot() read doesn't re-arm delivery")
            b.processInput(0, InputAction.LEFT) // moves p0's piece
            assertNotNull(b.frame(50.0).snapshot, "a scene change re-delivers the snapshot")
            Unit
        } finally {
            b.close()
        }
    }

    @Test
    fun rekeyMovesBoardToNewId() = runBlocking {
        val b = newBridge()
        try {
            b.createGame(listOf(PlayerSpec(0, 3), PlayerSpec(1, 1)), seed = 0xC0FFEE)
            b.processInput(0, InputAction.HARD_DROP) // build some stack on board 0
            b.drainEvents()
            val before = b.snapshot().players.first { it.id == 0 }

            // Cross-device claim: board 0 is reclaimed under a new peerIndex (5).
            assertTrue(b.rekey(0, 5), "rekey of an existing board returns true")
            assertFalse(b.rekey(0, 5), "rekey of a now-absent id is a no-op")

            val snap = b.snapshot()
            assertEquals(listOf(5, 1), snap.players.map { it.id }, "board 0 -> 5, snapshot order preserved")
            val after = snap.players.first { it.id == 5 }
            assertEquals(before.level, after.level)
            assertEquals(before.lines, after.lines)
            assertEquals(before.grid, after.grid, "the reclaimed board keeps its locked stack")
            assertNull(after.holdPiece, "no hold yet")

            // Inputs now drive the reclaimed board under the new id (HOLD has no cooldown).
            b.processInput(5, InputAction.HOLD)
            assertTrue(
                b.snapshot().players.first { it.id == 5 }.holdPiece != null,
                "input on the new id reaches the reclaimed board",
            )
        } finally {
            b.close()
        }
    }

    @Test
    fun deterministicAcrossRuns() = runBlocking {
        val a = scriptedRun(seed = 0xBADCAFE)
        val c = scriptedRun(seed = 0xBADCAFE)
        assertEquals(a.first, c.first, "final snapshot must be identical for the same seed+inputs")
        assertEquals(a.second, c.second, "event stream must be identical for the same seed+inputs")
        assertTrue(a.second.isNotEmpty(), "the scripted run produced events")
    }

    @Test
    fun seedSensitivity() = runBlocking {
        val b = newBridge()
        try {
            b.createGame(listOf(PlayerSpec(0, 1)), seed = 1)
            val s1 = b.snapshot().players[0].nextPieces
            b.createGame(listOf(PlayerSpec(0, 1)), seed = 2)
            val s2 = b.snapshot().players[0].nextPieces
            assertNotEquals(s1, s2, "different seeds produce different piece sequences")
        } finally {
            b.close()
        }
    }

    /** A fixed deterministic input/tick schedule; returns the final snapshot + all events. */
    private suspend fun scriptedRun(seed: Long): Pair<GameSnapshot, List<GameEvent>> {
        val b = newBridge()
        return try {
            b.createGame(listOf(PlayerSpec(0, 1), PlayerSpec(1, 1)), seed)
            val events = mutableListOf<GameEvent>()
            var now = 0.0
            for (i in 0 until 1500) {
                val pid = i % 2
                when (i % 7) {
                    0 -> b.processInput(pid, InputAction.LEFT)
                    1 -> b.processInput(pid, InputAction.RIGHT)
                    2 -> b.processInput(pid, InputAction.ROTATE_CW)
                    3 -> if (i % 13 == 3) b.processInput(pid, InputAction.HOLD)
                    4 -> if (i % 5 == 4) b.processInput(pid, InputAction.HARD_DROP)
                    else -> Unit
                }
                now += EngineConstants.LOGIC_TICK_MS
                events += b.frame(now).events
                if (b.isEnded()) break
            }
            b.snapshot() to events
        } finally {
            b.close()
        }
    }
}
