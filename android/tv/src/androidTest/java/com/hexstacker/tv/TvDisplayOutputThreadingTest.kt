package com.hexstacker.tv

import android.os.Handler
import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hexstacker.core.display.CountdownValue
import com.hexstacker.core.display.DisplayScreen
import com.hexstacker.core.display.ResultEntry
import com.hexstacker.core.model.Axial
import com.hexstacker.core.model.EventType
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.model.Piece
import com.hexstacker.core.model.PlayerState
import com.hexstacker.core.room.PlayerRecord
import com.hexstacker.tv.audio.MusicPlayer
import com.hexstacker.tv.render.BoardSurfaceView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The coordinator drives [TvDisplayOutput] from the game thread, not Main
 * (PERF-INPUT-LATENCY.md §16), so every method here has to be safe there. Two things are
 * not, and both fail LOUDLY rather than subtly, which is what makes this test worth having:
 * ExoPlayer throws when touched off the thread that built it, and a View throws
 * `CalledFromWrongThreadException`. `TvDisplayOutput` routes exactly those through
 * `runOnMain`; this calls the whole `DisplayOutput` surface from a foreign thread and fails
 * if anything escapes that routing.
 *
 * It also pins the ORDER guarantee `showScreen` relies on: the board content it clears must
 * be cleared inline, because `renderSnapshot` runs inline too, and a posted clear would
 * land after a snapshot it was supposed to precede.
 */
@RunWith(AndroidJUnit4::class)
class TvDisplayOutputThreadingTest {

    @Test
    fun everyOutputCallIsSafeFromTheGameThread() {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val mainHandler = Handler(Looper.getMainLooper())

        lateinit var board: BoardSurfaceView
        lateinit var music: MusicPlayer
        lateinit var out: TvDisplayOutput
        // Both are built on Main in the app; ExoPlayer in particular binds to its
        // constructing thread, which is the whole reason runOnMain exists.
        instr.runOnMainSync {
            board = BoardSurfaceView(ctx)
            music = MusicPlayer(ctx)
            out = TvDisplayOutput(board, music, runOnMain = { block -> mainHandler.post(block) })
        }

        val gameThread = Executors.newSingleThreadExecutor { r -> Thread(r, "hex-game-test") }
        val failure = arrayOfNulls<Throwable>(1)
        val done = CountDownLatch(1)
        gameThread.execute {
            try {
                // The lobby/roster half.
                out.roomReady("ABCD", "https://example.test/c/ABCD")
                out.updateLobby(
                    listOf(
                        PlayerRecord(peerIndex = 0, playerName = "P0", colorSlot = 0, startLevel = 1),
                        PlayerRecord(peerIndex = 1, playerName = "P1", colorSlot = 1, startLevel = 1),
                    ),
                    hostPeerIndex = 0,
                )
                // Screen transitions, both directions — these touch View properties and the
                // render thread through runOnMain, and board content inline.
                out.showScreen(DisplayScreen.GAME)
                out.showCountdown(CountdownValue.Number(3))
                out.showCountdown(CountdownValue.Go)
                // The input path: must be safe inline, since posting it would reintroduce
                // the hop the game thread exists to remove.
                out.renderSnapshot(snapshot())
                out.handleGameEvent(
                    GameEvent(type = EventType.PIECE_LOCK, playerId = 0, typeId = 1, blocks = emptyList()),
                )
                out.setDisconnected(1, "https://example.test/c/ABCD")
                out.setDisconnected(1, null)
                // Audio — every one of these must be posted, or ExoPlayer throws here.
                out.playCountdownBeep(false)
                out.playCountdownBeep(true)
                out.startMusic()
                out.pauseMusic()
                out.resumeMusic()
                out.setMuted(true)
                out.setMuted(false)
                out.stopMusic()
                out.setPaused(true)
                out.setPaused(false)
                out.showResults(
                    listOf(
                        ResultEntry(playerId = 0, rank = 1, playerName = "P0", colorIndex = 0, lines = 4, level = 1),
                    ),
                )
                out.showScreen(DisplayScreen.LOBBY)
            } catch (t: Throwable) {
                failure[0] = t
            } finally {
                done.countDown()
            }
        }
        assertTrue("game-thread block did not finish", done.await(20, TimeUnit.SECONDS))
        failure[0]?.let { throw AssertionError("DisplayOutput call failed off Main: $it", it) }

        // Drain the posted work, then assert it actually landed rather than silently
        // vanishing (a swallowed post would make the test pass for the wrong reason).
        val drained = CountDownLatch(1)
        mainHandler.post { drained.countDown() }
        assertTrue("main queue did not drain", drained.await(20, TimeUnit.SECONDS))
        instr.waitForIdleSync()

        val state = out.state.value
        assertEquals(DisplayScreen.LOBBY, state.screen)
        assertEquals("ABCD", state.lobby?.joinCode)
        assertEquals(2, state.lobby?.players?.size)
        assertEquals(1, state.results.size)
        assertNull("countdown must clear on results", state.countdown)

        instr.runOnMainSync { music.release() }
        gameThread.shutdown()
    }

    /**
     * `showScreen(GAME)` clears the board inline; a snapshot submitted right after must
     * survive. If the clear were posted to Main it would run last and wipe it — the
     * regression this pins.
     */
    @Test
    fun showScreenClearsBeforeTheSnapshotItPrecedes() {
        val instr = InstrumentationRegistry.getInstrumentation()
        val ctx = instr.targetContext
        val mainHandler = Handler(Looper.getMainLooper())
        // Deliberately SLOW main posting, so an inline/posted ordering mistake is
        // guaranteed to show rather than depending on how quickly Main drains.
        val slowMain: (Runnable) -> Unit = { block -> mainHandler.postDelayed(block, 250) }

        lateinit var board: BoardSurfaceView
        lateinit var music: MusicPlayer
        lateinit var out: TvDisplayOutput
        instr.runOnMainSync {
            board = BoardSurfaceView(ctx)
            music = MusicPlayer(ctx)
            out = TvDisplayOutput(board, music, runOnMain = slowMain)
        }

        val gameThread = Executors.newSingleThreadExecutor()
        val done = CountDownLatch(1)
        gameThread.execute {
            out.showScreen(DisplayScreen.GAME)
            out.renderSnapshot(snapshot())
            done.countDown()
        }
        assertTrue(done.await(20, TimeUnit.SECONDS))

        // Let the delayed main-thread work run, then confirm the snapshot is still there.
        Thread.sleep(600)
        instr.waitForIdleSync()
        assertTrue(
            "the snapshot submitted after showScreen(GAME) was lost",
            board.hasSnapshotForTest(),
        )

        instr.runOnMainSync { music.release() }
        gameThread.shutdown()
    }

    private fun snapshot(): GameSnapshot = GameSnapshot(
        players = listOf(
            PlayerState(
                id = 0,
                grid = List(20) { List(9) { 0 } },
                currentPiece = Piece(
                    type = "o", typeId = 1, anchorCol = 4, anchorRow = 2,
                    cells = listOf(Axial(0, 0)), blocks = emptyList(),
                ),
                ghost = null,
                holdPiece = null,
                nextPieces = listOf("o"),
                level = 1,
                lines = 0,
                alive = true,
                pendingGarbage = 0,
                clearingCells = null,
                gridVersion = 1,
            ),
        ),
        elapsed = 1000.0,
    )
}
