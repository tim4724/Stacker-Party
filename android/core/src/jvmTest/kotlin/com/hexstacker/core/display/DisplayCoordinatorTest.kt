package com.hexstacker.core.display

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.net.Msg
import com.hexstacker.core.net.RelayTransport
import com.hexstacker.core.net.RoomState
import com.hexstacker.core.room.PlayerRecord
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Headless full-loop coverage for [DisplayCoordinator] using a fake
 * [RelayTransport] (records sent frames) + a fake [DisplayOutput] (records
 * side-effects) + a REAL [EngineBridge] driven from the QuickJS bundle (the
 * `hexcore.bundle` system property, as the engine tests do).
 *
 * Drives the lifecycle: connect -> lobby -> hello/welcome -> start_game ->
 * countdown 3/2/1/GO -> playing -> top-out -> results -> play_again ->
 * return_to_lobby, asserting the right MSG types go out at each step.
 */
class DisplayCoordinatorTest {

    private fun bundle(): String {
        val p = System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set by build")
        return File(p).readText()
    }

    private fun realFactory(bridge: EngineBridge): suspend (List<EngineBridge.PlayerSpec>, Long) -> EngineBridge =
        { players, seed -> bridge.createGame(players, seed); bridge }

    private fun type(o: JsonObject): String? = (o["type"] as? JsonPrimitive)?.contentOrNull
    private fun hello(name: String) = buildJsonObject { put("type", Msg.HELLO); put("name", name) }
    private fun simple(t: String) = buildJsonObject { put("type", t) }
    private fun input(action: String) = buildJsonObject { put("type", Msg.INPUT); put("action", action) }

    @Test
    fun fullLifecycleLobbyToResults() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport()
            val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()

            t.created("ROOM42", "inst1"); coord.awaitIdle()
            assertEquals(DisplayScreen.LOBBY, out.screens.last())
            assertEquals("ROOM42", out.lastRoom)

            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            assertEquals(2, coord.flow.size)
            // Lobby changes publish ONE retained snapshot (set_state), not a fanout.
            assertTrue(t.states.isNotEmpty(), "peer joins publish a retained room snapshot")

            // hello -> welcome (LOBBY form includes alive/paused)
            t.sent.clear()
            t.deliver(1, hello("Alex")); coord.awaitIdle()
            assertEquals("Alex", coord.flow.player(1)!!.playerName)
            val welcome = t.sent.firstOrNull { it.first == 1 && type(it.second) == Msg.WELCOME }
            assertNotNull(welcome)
            assertTrue(welcome.second.containsKey("alive"))
            assertTrue(welcome.second.containsKey("paused"))

            // start_game -> beginCountdown (boards visible behind overlay)
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)
            assertEquals(DisplayScreen.GAME, out.screens.last())

            // deterministic countdown: entry=3, +1000=2, +1000=1, +1000=GO(music), +500=start
            coord.tick(0.0)
            coord.tick(1000.0)
            coord.tick(1000.0)
            coord.tick(1000.0)
            assertEquals(
                listOf(
                    CountdownValue.Number(3),
                    CountdownValue.Number(2),
                    CountdownValue.Number(1),
                    CountdownValue.Go,
                ),
                out.countdowns,
            )
            assertEquals(1, out.beeps.count { it }, "exactly one GO beep")
            assertTrue(out.musicStarted)
            assertEquals(RoomState.COUNTDOWN, coord.state) // GO holds, not yet PLAYING
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.COUNTDOWN })
            coord.tick(500.0)
            assertEquals(RoomState.PLAYING, coord.state)
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.GAME_START })

            // late joiner during PLAYING -> welcome omits alive/paused
            t.sent.clear()
            t.deliver(3, hello("Zoe")); coord.awaitIdle()
            val lateWelcome = t.sent.firstOrNull { it.first == 3 && type(it.second) == Msg.WELCOME }
            assertNotNull(lateWelcome)
            assertFalse(lateWelcome.second.containsKey("alive"))
            assertFalse(lateWelcome.second.containsKey("paused"))

            // drive participants to top-out -> gameEnd command -> RESULTS
            var guard = 0
            while (coord.state == RoomState.PLAYING && guard < 4000) {
                t.deliver(1, input("hard_drop"))
                t.deliver(2, input("hard_drop"))
                coord.awaitIdle()
                coord.tick(50.0)
                guard++
            }
            assertEquals(RoomState.RESULTS, coord.state, "game tops out within the tick budget")
            assertEquals(DisplayScreen.RESULTS, out.screens.last())
            assertTrue(out.musicStopped)
            assertTrue(out.setPausedCalls.last() == false, "setPaused(false) runs before showResults")
            assertTrue(t.sent.any { it.first >= 0 && type(it.second) == Msg.GAME_OVER }, "a KO unicast game_over")
            assertNotNull(t.sent.lastOrNull { it.first == -1 && type(it.second) == Msg.GAME_END })
            val results = assertNotNull(out.lastResults)
            assertTrue(results.isNotEmpty())
            assertTrue(results.all { it.playerName != null }, "results enriched with names")
            assertTrue(results.any { it.playerId == 3 && it.newPlayer }, "late joiner appears as newPlayer")

            // play_again -> new countdown
            t.deliver(1, simple(Msg.PLAY_AGAIN)); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)

            // return_to_lobby -> lobby + broadcast
            t.sent.clear()
            t.deliver(1, simple(Msg.RETURN_TO_LOBBY)); coord.awaitIdle()
            assertEquals(RoomState.LOBBY, coord.state)
            assertEquals(DisplayScreen.LOBBY, out.screens.last())
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.RETURN_TO_LOBBY })

            coord.stop()
        } finally {
            bridge.close()
        }
    }

    // Render-on-input: a controller input renders the applied state on the spot, without
    // waiting for the next frame() tick. A non-input message must NOT render.
    @Test
    fun inputRendersImmediatelyWithoutWaitingForTick() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport()
            val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("ROOM", "i"); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            coord.tick(0.0); coord.tick(1000.0); coord.tick(1000.0); coord.tick(1000.0); coord.tick(500.0)
            assertEquals(RoomState.PLAYING, coord.state)

            val beforeInput = out.snapshots.size
            t.deliver(1, input("left")); coord.awaitIdle() // no tick() in between
            assertTrue(out.snapshots.size > beforeInput, "input renders immediately (render-on-input)")

            val afterInput = out.snapshots.size
            t.deliver(1, simple(Msg.PING)); coord.awaitIdle()
            assertEquals(afterInput, out.snapshots.size, "a non-input message does not render")

            coord.stop()
        } finally {
            bridge.close()
        }
    }

    @Test
    fun pauseResumeAndConnectedGuard() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport()
            val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            coord.tick(0.0); coord.tick(1000.0); coord.tick(1000.0); coord.tick(1000.0); coord.tick(500.0)
            assertEquals(RoomState.PLAYING, coord.state)

            // pause
            t.sent.clear()
            t.deliver(1, simple(Msg.PAUSE_GAME)); coord.awaitIdle()
            assertTrue(out.pausedFlag)
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.GAME_PAUSED })

            // resume
            t.sent.clear()
            t.deliver(1, simple(Msg.RESUME_GAME)); coord.awaitIdle()
            assertFalse(out.pausedFlag)
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.GAME_RESUMED })

            // Pause again, then everyone disconnects. The manual pause converts into a
            // silent auto-pause: the stranded overlay hides (Continue can't be reached
            // while everyone is gone, so a shown overlay could never be dismissed), but
            // the game stays paused. A DISPLAY-remote resume is still blocked (a
            // controller resume would reconnect the sender first; the remote does not).
            t.deliver(1, simple(Msg.PAUSE_GAME)); coord.awaitIdle()
            assertTrue(out.pausedFlag, "manual pause shows the overlay")
            t.peerLeft(1); t.peerLeft(2); coord.awaitIdle()
            assertEquals(0, coord.flow.connectedCount)
            assertFalse(out.pausedFlag, "overlay hides when the last player drops during a manual pause")

            t.sent.clear()
            val resumesBefore = out.musicResumes
            coord.remoteTogglePause()
            assertFalse(out.pausedFlag, "overlay stays hidden; resume blocked while everyone is disconnected")
            assertEquals(resumesBefore, out.musicResumes, "game stays paused (no resume) while everyone is disconnected")
            assertFalse(t.sent.any { type(it.second) == Msg.GAME_RESUMED })

            // A participant reconnecting lifts the converted auto-pause.
            t.deliver(1, simple(Msg.PING)); coord.awaitIdle()
            assertTrue(out.musicResumes > resumesBefore, "reconnect resumes the game")

            coord.stop()
        } finally {
            bridge.close()
        }
    }

    @Test
    fun messageHandlingLobby() = runBlocking {
        val t = FakeTransport()
        val out = FakeOutput()
        val coord = DisplayCoordinator(
            t,
            out,
            engineFactory = { _, _ -> error("engine must not be built in the lobby message test") },
            seedProvider = { 0L },
        )
        coord.start()
        t.created("R", null); coord.awaitIdle()
        t.peerJoined(1); t.peerJoined(2); coord.awaitIdle() // slots 0 / 1, host = 1

        // set_level: reject out-of-range, accept in-range
        t.deliver(1, buildJsonObject { put("type", Msg.SET_LEVEL); put("level", 99) }); coord.awaitIdle()
        assertEquals(1, coord.flow.player(1)!!.startLevel)
        t.deliver(1, buildJsonObject { put("type", Msg.SET_LEVEL); put("level", 7) }); coord.awaitIdle()
        assertEquals(7, coord.flow.player(1)!!.startLevel)

        // set_color: reject taken slot, accept free slot
        t.deliver(1, buildJsonObject { put("type", Msg.SET_COLOR); put("colorIndex", 1) }); coord.awaitIdle()
        assertEquals(0, coord.flow.player(1)!!.colorSlot)
        t.deliver(1, buildJsonObject { put("type", Msg.SET_COLOR); put("colorIndex", 3) }); coord.awaitIdle()
        assertEquals(3, coord.flow.player(1)!!.colorSlot)

        // ping -> pong echoes t
        t.sent.clear()
        t.deliver(2, buildJsonObject { put("type", Msg.PING); put("t", 42.5) }); coord.awaitIdle()
        val pong = t.sent.firstOrNull { it.first == 2 && type(it.second) == Msg.PONG }
        assertNotNull(pong)
        assertEquals(42.5, pong.second["t"]!!.jsonPrimitive.double)

        // room full: fill to 8, the 9th controller is rejected
        for (i in 3..8) t.peerJoined(i)
        coord.awaitIdle()
        assertEquals(8, coord.flow.size)
        t.sent.clear()
        t.peerJoined(9); coord.awaitIdle()
        assertTrue(t.sent.any { it.first == 9 && type(it.second) == Msg.ERROR })
        assertEquals(8, coord.flow.size)

        coord.stop()
    }

    /** Drive connect -> lobby -> peers -> start -> countdown to PLAYING. */
    private suspend fun toPlaying(coord: DisplayCoordinator, t: FakeTransport, peers: List<Int>) {
        t.created("R", null); coord.awaitIdle()
        for (p in peers) t.peerJoined(p)
        coord.awaitIdle()
        t.deliver(peers.first(), simple(Msg.START_GAME)); coord.awaitIdle()
        coord.tick(0.0); coord.tick(1000.0); coord.tick(1000.0); coord.tick(1000.0); coord.tick(500.0)
    }

    @Test
    fun allParticipantsDropAutoPausesSilentlyThenReconnectResumes() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)

            val pausesBefore = out.musicPauses
            t.sent.clear()
            t.peerLeft(1); t.peerLeft(2); coord.awaitIdle()
            assertTrue(coord.flow.allParticipantsDisconnected())
            assertTrue(out.musicPauses > pausesBefore, "music paused on all-disconnect")
            assertFalse(t.sent.any { type(it.second) == Msg.GAME_PAUSED }, "auto-pause is silent (controllers gone)")
            assertFalse(out.pausedFlag, "no pause overlay for a silent auto-pause")

            // Any message from a dropped participant reconnects it and lifts the auto-pause.
            t.sent.clear()
            t.deliver(1, simple(Msg.PING)); coord.awaitIdle()
            assertEquals(RoomState.PLAYING, coord.state)
            assertTrue(t.sent.any { type(it.second) == Msg.GAME_RESUMED }, "auto-resume broadcasts GAME_RESUMED")
            assertTrue(out.musicResumes > 0, "music resumed on reconnect")

            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun graceWindowReturnsToLobbyWhenAllDropWithLateJoinerWaiting() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            t.deliver(3, hello("Zoe")); coord.awaitIdle() // late joiner (waiting for next game)
            assertTrue(coord.flow.hasLateJoiners())

            now = 1000.0
            t.peerLeft(1); t.peerLeft(2); coord.awaitIdle() // arms the 5s grace deadline
            assertEquals(RoomState.PLAYING, coord.state, "still playing during the grace window")

            now = 6100.0
            coord.tick(1200.0) // 1Hz sweep fires graceTick past the deadline
            assertEquals(RoomState.LOBBY, coord.state, "grace elapsed -> back to lobby for the late joiner")
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.RETURN_TO_LOBBY })

            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun livenessSweepDisconnectsSilentControllerWithRejoinUrl() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            // Keep peer 2 alive; let peer 1 go silent past LIVENESS_TIMEOUT_MS (3s).
            now = 3500.0
            t.deliver(2, simple(Msg.PING)); coord.awaitIdle() // refreshes peer 2 presence
            out.disconnects.clear()
            coord.tick(1100.0) // 1Hz sweep -> expiredPeers(now) -> checkLiveness marks disconnected + rejoin QR
            assertTrue(coord.flow.isDisconnected(1), "silent controller marked disconnected")
            assertFalse(coord.flow.isDisconnected(2), "recently-seen controller stays connected")
            val overlay = out.disconnects.lastOrNull { it.first == 1 }
            assertNotNull(overlay)
            assertTrue(overlay.second?.contains("claim=1") == true, "rejoin overlay carries ?claim=<peerIndex>")

            coord.stop()
        } finally { bridge.close() }
    }

    /** The rejoin WELCOME is the controller's authority on pause state, so it must report
     *  the state the display will actually be in — not a stale paused=true chased by a
     *  GAME_RESUMED. A controller that latched the first and missed the second sat on a
     *  pause overlay whose Continue did nothing: the display was no longer paused, so
     *  resumeGame()'s manual-pause guard dropped the request and no GAME_RESUMED followed.
     *  (Reported from a live Wi-Fi drop on tvOS; Android had the same ordering.) */
    @Test
    fun rejoinWelcomeReportsResumedNotStalePaused() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1))
            assertEquals(RoomState.PLAYING, coord.state)

            // Link drops mid-game: the sim freezes, nothing can be broadcast.
            coord.onLinkStateChanged(RelayTransport.ConnectionState.RECONNECTING); coord.awaitIdle()
            t.sent.clear()

            // Link returns and the relay answers the rejoin.
            coord.onLinkStateChanged(RelayTransport.ConnectionState.OPEN); coord.awaitIdle()
            t.joined("R", listOf(1)); coord.awaitIdle()

            val welcome = t.sent.last { it.first == 1 && type(it.second) == Msg.WELCOME }.second
            assertEquals(
                false,
                (welcome["paused"] as? JsonPrimitive)?.content?.toBoolean(),
                "WELCOME must not report the pause the display is lifting in the same breath",
            )
            coord.stop()
        } finally { bridge.close() }
    }

    /** The display's OWN link being down is not the controllers' fault: their silence
     *  must not expire them (and, with a late joiner waiting, grace-return the match). */
    @Test
    fun livenessSweepIsSuppressedWhileTheDisplayLinkIsDown() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            t.deliver(1, simple(Msg.PING)); t.deliver(2, simple(Msg.PING)); coord.awaitIdle()
            t.deliver(3, hello("Zoe")); coord.awaitIdle() // late joiner -> arms the grace path
            assertTrue(coord.flow.hasLateJoiners())

            // Our socket drops. No controller traffic can reach us for the whole reconnect
            // budget (~13s of capped backoff), so every lastSeen goes stale.
            coord.onLinkStateChanged(RelayTransport.ConnectionState.RECONNECTING); coord.awaitIdle()
            now = 12_000.0
            coord.tick(1100.0); coord.tick(1100.0)
            assertFalse(coord.flow.isDisconnected(1), "our outage must not expire a controller")
            assertFalse(coord.flow.isDisconnected(2), "our outage must not expire a controller")
            assertEquals(RoomState.PLAYING, coord.state, "the match is not grace-returned to the lobby")

            // Socket back, but the relay hasn't answered our join yet: it still drops
            // everything addressed to us, so the sweep must STAY off. Re-arming here (and
            // leaning on a re-stamp to cover the gap) only buys LIVENESS_TIMEOUT_MS, while
            // the handshake deadline is twice that — a slow `joined` would expire the room.
            coord.onLinkStateChanged(RelayTransport.ConnectionState.OPEN); coord.awaitIdle()
            now = 24_000.0
            coord.tick(1100.0); coord.tick(1100.0)
            assertFalse(coord.flow.isDisconnected(1), "socket-open alone must not re-arm the sweep")
            assertFalse(coord.flow.isDisconnected(2), "socket-open alone must not re-arm the sweep")
            assertEquals(RoomState.PLAYING, coord.state)

            // The `joined` reply reconciles the roster and re-stamps the survivors, so the
            // sweep comes back on with clean presence.
            t.joined("R", listOf(1, 2, 3)); coord.awaitIdle()
            coord.tick(1100.0)
            assertFalse(coord.flow.isDisconnected(1), "re-stamped by the roster reconcile")
            assertFalse(coord.flow.isDisconnected(2), "re-stamped by the roster reconcile")

            // ...and it really is on again: silence from here does expire a controller.
            now = 30_000.0
            coord.tick(1100.0)
            assertTrue(coord.flow.isDisconnected(1), "the sweep is live once we are back in the room")

            coord.stop()
        } finally { bridge.close() }
    }

    /** An in-session controller reconnect lands on the SAME relay slot, so the relay
     *  re-emits peer_joined for a peer we already know. Re-registering it would reset
     *  the kept name/colour and, in a full room, bounce a legitimate player. */
    @Test
    fun duplicatePeerJoinedKeepsIdentityAndNeverBouncesRoomFull() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); coord.awaitIdle()
            t.deliver(1, hello("Alex")); coord.awaitIdle()
            t.deliver(1, buildJsonObject { put("type", Msg.SET_COLOR); put("colorIndex", 5) })
            coord.awaitIdle()
            assertEquals("Alex", coord.flow.player(1)!!.playerName)
            assertEquals(5, coord.flow.player(1)!!.colorSlot)

            t.sent.clear()
            t.peerJoined(1); coord.awaitIdle()
            assertEquals(1, coord.flow.size, "no duplicate roster entry")
            assertEquals("Alex", coord.flow.player(1)!!.playerName, "reconnect keeps the name")
            assertEquals(5, coord.flow.player(1)!!.colorSlot, "reconnect keeps the colour slot")

            // Fill the room (peer 1 holds slot 5; 2..8 take the remaining seven), then
            // replay peer 1's join: with no free slot left, re-registering would answer
            // the returning player "Room is full" and its controller would hard-bail.
            for (i in 2..8) t.peerJoined(i)
            coord.awaitIdle()
            assertEquals(8, coord.flow.size)
            t.sent.clear()
            t.peerJoined(1); coord.awaitIdle()
            assertEquals("Alex", coord.flow.player(1)!!.playerName)
            assertEquals(5, coord.flow.player(1)!!.colorSlot)
            assertFalse(
                t.sent.any { type(it.second) == Msg.ERROR },
                "a peer we already know is never told the room is full",
            )

            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun remoteControlsDriveLifecycleAndMute() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); coord.awaitIdle()

            // remoteStartMatch from LOBBY -> COUNTDOWN
            coord.remoteStartMatch(); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)

            // remoteReturnToLobby -> LOBBY
            coord.remoteReturnToLobby(); coord.awaitIdle()
            assertEquals(RoomState.LOBBY, coord.state)

            // remoteToggleMute flips + broadcasts + drives output.setMuted
            t.sent.clear()
            val muted = coord.remoteToggleMute()
            assertTrue(muted)
            assertTrue(out.mutedFlag, "remote mute silences TV music via output.setMuted")
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.DISPLAY_MUTED })

            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun crossDeviceClaimReclaimsDroppedBoard() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            // Player 1 drops mid-game -> disconnected + per-board rejoin overlay.
            t.peerLeft(1); coord.awaitIdle()
            assertTrue(coord.flow.isDisconnected(1))

            // A returning phone gets a fresh peerIndex (5), then claims peer 1 via the ?claim= QR.
            t.peerJoined(5); coord.awaitIdle()
            out.disconnects.clear()
            t.deliver(5, buildJsonObject { put("type", Msg.HELLO); put("rejoinToken", 1) }); coord.awaitIdle()

            assertTrue(coord.flow.contains(5), "returning peer holds the reclaimed slot")
            assertFalse(coord.flow.contains(1), "the old peerIndex is gone (placeholder + old record merged)")
            assertFalse(coord.flow.isDisconnected(5), "the reclaimed board is connected")
            assertTrue(out.disconnects.any { it.first == 1 && it.second == null }, "old board's rejoin overlay cleared")
            assertEquals(RoomState.PLAYING, coord.state, "the match continues")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun activeParticipantCannotForgeClaim() = runBlocking {
        // Web claimReconnectPeer guard: an ACTIVE participant sending a claim HELLO for a
        // dropped board is refused (a genuine cross-device rejoin arrives under a fresh
        // peer index); Game.rekeyPlayer refuses the same case engine-side.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            t.peerLeft(1); coord.awaitIdle()
            assertTrue(coord.flow.isDisconnected(1))

            // Active participant 2 tries to claim player 1's dropped board.
            t.deliver(2, buildJsonObject { put("type", Msg.HELLO); put("rejoinToken", 1) }); coord.awaitIdle()
            assertTrue(coord.flow.contains(1), "the dropped board's slot is NOT absorbed")
            assertTrue(coord.flow.isDisconnected(1), "player 1 stays reclaimable")
            assertTrue(coord.flow.contains(2), "the forger keeps its own identity")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun autoNameSkipsBlocklist() = runBlocking {
        val t = FakeTransport(); val out = FakeOutput()
        val coord = DisplayCoordinator(t, out, engineFactory = { _, _ -> error("no engine") }, seedProvider = { 0L })
        coord.start()
        t.created("R", null); coord.awaitIdle()
        t.peerJoined(1); t.peerJoined(2); t.peerJoined(3); t.peerJoined(4); coord.awaitIdle()
        // HX-1, HX-2, HX-3, then 4 is blocklisted -> HX-5.
        assertEquals("HX-1", coord.flow.player(1)!!.playerName)
        assertEquals("HX-3", coord.flow.player(3)!!.playerName)
        assertEquals("HX-5", coord.flow.player(4)!!.playerName, "auto-name skips the blocklisted 4")
        coord.stop()
    }

    @Test
    fun closeRoomOnStop() = runBlocking {
        val t = FakeTransport(); val out = FakeOutput()
        val coord = DisplayCoordinator(t, out, engineFactory = { _, _ -> error("no engine") }, seedProvider = { 0L })
        coord.start()
        t.created("R", null); coord.awaitIdle()
        t.peerJoined(1); coord.awaitIdle()
        t.sent.clear()
        coord.stop()
        // Deliberate exit tears the room down on the relay; the members' 4001
        // close frames are their party-over signal, so nothing is broadcast.
        assertEquals(1, t.roomCloses, "stop() sends close_room")
        assertTrue(t.sent.isEmpty(), "stop() broadcasts nothing")
    }

    @Test
    fun sanitizeNameStripsControlAndZeroWidthAndRemapsLegacySlot() = runBlocking {
        val t = FakeTransport(); val out = FakeOutput()
        val coord = DisplayCoordinator(t, out, engineFactory = { _, _ -> error("no engine") }, seedProvider = { 0L })
        coord.start()
        t.created("R", null); coord.awaitIdle()
        // control chars (tab) + zero-width space stripped, trimmed.
        t.deliver(1, hello("  A​l\tex  ")); coord.awaitIdle()
        assertEquals("Alex", coord.flow.player(1)!!.playerName)
        // Legacy "P2" slot name -> auto HX name, never applied verbatim.
        t.deliver(2, hello("P2")); coord.awaitIdle()
        assertTrue(coord.flow.player(2)!!.playerName.startsWith("HX-"), "P1-8 legacy slot names are auto-named")
        coord.stop()
    }

    @Test
    fun displayRejoinReStampsSurvivorLiveness() = runBlocking {
        // FINDING #1: onDisplayRejoined re-stamps flow.onSeen for every surviving peer, so a
        // survivor whose last ping predates the display's own link drop is NOT expired by the
        // first liveness sweep after reconnect.
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)
            // Both controllers last pinged at t=0.
            t.deliver(1, simple(Msg.PING)); t.deliver(2, simple(Msg.PING)); coord.awaitIdle()

            // The display's relay link drops and rejoins ~2.5s later with both peers present.
            now = 2500.0
            t.joined("R", listOf(1, 2)); coord.awaitIdle()
            assertTrue(coord.flow.contains(1) && coord.flow.contains(2), "survivors kept on rejoin")

            // A liveness sweep at t=3200. Without the rejoin re-stamp both peers' last-seen would
            // still read t=0 (>3s stale) and both would be flagged disconnected here.
            now = 3200.0
            coord.tick(1100.0)
            assertFalse(coord.flow.isDisconnected(1), "rejoin re-stamped survivor 1's liveness")
            assertFalse(coord.flow.isDisconnected(2), "rejoin re-stamped survivor 2's liveness")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun allDropDuringCountdownAutoPausesOnStart() = runBlocking {
        // FINDING #2: startPlaying() runs checkAllParticipantsDisconnected() right after entering
        // PLAYING, so an all-drop during COUNTDOWN silently auto-pauses at match start instead of
        // playing itself out unpaused.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)

            // Enter the countdown, then everyone drops mid-countdown (no auto-pause yet).
            coord.tick(0.0) // step 0 -> "3"
            t.peerLeft(1); t.peerLeft(2); coord.awaitIdle()
            assertTrue(coord.flow.allParticipantsDisconnected())
            assertEquals(RoomState.COUNTDOWN, coord.state, "no auto-pause during COUNTDOWN")
            assertFalse(out.pausedFlag)

            // Finish the countdown -> startPlaying -> checkAllParticipantsDisconnected silent-pauses.
            val pausesBefore = out.musicPauses
            coord.tick(1000.0); coord.tick(1000.0); coord.tick(1000.0); coord.tick(500.0)
            assertEquals(RoomState.PLAYING, coord.state)
            assertTrue(out.musicPauses > pausesBefore, "silent auto-pause on start when all participants gone")
            assertFalse(out.pausedFlag, "silent auto-pause shows no pause overlay")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun beginCountdownReStampsLastSeenSoQuietControllerSurvivesCountdown() = runBlocking {
        // FINDING #4: beginCountdown() calls flow.clearDisconnected(now) to re-stamp lastSeen on
        // the everyone-present transition, so a controller that went quiet just before the match
        // isn't instantly flagged during COUNTDOWN.
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            // Both controllers check in at t=0 (stamps lastSeen); peer 2 then stays quiet.
            t.deliver(1, hello("Ann")); t.deliver(2, hello("Bo")); coord.awaitIdle()

            // The host starts the match just under the 3s liveness timeout.
            now = 2900.0
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)

            // A liveness sweep during COUNTDOWN. Without the beginCountdown re-stamp, quiet peer 2's
            // last-seen would still read t=0 (>3s stale) and it would be flagged disconnected.
            now = 3500.0
            coord.tick(0.0)    // step 0 -> "3"
            coord.tick(1100.0) // 1Hz sweep at now=3500
            assertFalse(coord.flow.isDisconnected(2), "beginCountdown re-stamped the quiet controller's liveness")
            assertFalse(coord.flow.isDisconnected(1), "the host controller stays connected")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun linkResumeWaitsForRoomRejoinNotSocketOpen() = runBlocking {
        // The display's link-drop pause must lift on the relay's `joined` reply (roster
        // reconciled), NOT on raw socket OPEN — OPEN fires before the relay has processed
        // the join, so a GAME_RESUMED broadcast then could be dropped server-side.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)

            // Link drops mid-game: silent pause (controllers unreachable, no broadcast).
            val pausesBefore = out.musicPauses
            coord.onLinkStateChanged(RelayTransport.ConnectionState.RECONNECTING); coord.awaitIdle()
            assertTrue(out.musicPauses > pausesBefore, "link drop pauses the running game")

            // Socket re-opens; the room-level join is still in flight -> no resume yet.
            t.sent.clear()
            coord.onLinkStateChanged(RelayTransport.ConnectionState.OPEN); coord.awaitIdle()
            assertFalse(t.sent.any { type(it.second) == Msg.GAME_RESUMED }, "no resume before the room rejoin")

            // The relay's joined reply reconciles the roster -> the game resumes now.
            t.joined("R", listOf(1, 2)); coord.awaitIdle()
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.GAME_RESUMED }, "resume after joined")
            assertTrue(out.musicResumes > 0, "music resumed with the game")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun returnToLobbyPrunesJustExpiredController() = runBlocking {
        // pruneDisconnected must also drop a controller whose silence hasn't yet been
        // flagged by the 1 Hz liveness sweep (web prunes on isDisconnected || isExpired).
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            // Both controllers last checked in at t=0; peer 2 then goes silent.
            t.deliver(1, simple(Msg.PING)); t.deliver(2, simple(Msg.PING)); coord.awaitIdle()

            // Host returns to lobby >3s later, BEFORE any liveness sweep flagged peer 2.
            now = 3500.0
            t.deliver(1, simple(Msg.RETURN_TO_LOBBY)); coord.awaitIdle()
            assertEquals(RoomState.LOBBY, coord.state)
            assertTrue(coord.flow.contains(1), "the just-seen host survives the prune")
            assertFalse(coord.flow.contains(2), "a silent-past-timeout controller is pruned without waiting for the sweep")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun pauseDuringCountdownFreezesAndResumeReplaysTheCurrentSecond() = runBlocking {
        // Web pauseGame/resumeGame support COUNTDOWN: pausing freezes the count
        // (clearCountdownTimers) and resuming gives the current number its FULL second
        // again (startCountdown(callback, remaining)) without re-broadcasting it.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            coord.tick(0.0)      // "3"
            coord.tick(1000.0)   // "2"
            assertEquals(listOf<CountdownValue>(CountdownValue.Number(3), CountdownValue.Number(2)), out.countdowns)

            // Pause mid-"2": overlay + broadcast, and the count freezes.
            t.sent.clear()
            t.deliver(1, simple(Msg.PAUSE_GAME)); coord.awaitIdle()
            assertTrue(out.pausedFlag, "pause overlay shows during a countdown pause")
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.GAME_PAUSED })
            coord.tick(5000.0)
            assertEquals(RoomState.COUNTDOWN, coord.state, "countdown frozen while paused")
            assertEquals(2, out.countdowns.size, "no further countdown steps while paused")

            // Resume: "2" replays its full second — 999ms later still nothing, 1ms more -> "1".
            t.sent.clear()
            t.deliver(1, simple(Msg.RESUME_GAME)); coord.awaitIdle()
            assertFalse(out.pausedFlag)
            assertTrue(t.sent.any { it.first == -1 && type(it.second) == Msg.GAME_RESUMED })
            coord.tick(999.0)
            assertEquals(2, out.countdowns.size, "current number replays a FULL second after resume")
            coord.tick(1.0)
            assertEquals(CountdownValue.Number(1), out.countdowns.last())

            // Finish: GO + the 500ms hold -> PLAYING.
            coord.tick(1000.0)
            assertEquals(CountdownValue.Go, out.countdowns.last())
            coord.tick(500.0)
            assertEquals(RoomState.PLAYING, coord.state)
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun pauseAtGoReplaysTheFullGoHoldOnResume() = runBlocking {
        // Web: remaining == 0 (GO on screen) re-arms the full 500ms goTimeout on resume.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); coord.awaitIdle()
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            coord.tick(0.0); coord.tick(1000.0); coord.tick(1000.0); coord.tick(1000.0) // -> GO
            assertEquals(CountdownValue.Go, out.countdowns.last())

            coord.remoteTogglePause()
            coord.tick(2000.0)
            assertEquals(RoomState.COUNTDOWN, coord.state, "GO hold frozen while paused")

            coord.remoteTogglePause()
            coord.tick(499.0)
            assertEquals(RoomState.COUNTDOWN, coord.state, "GO hold replays in full after resume")
            coord.tick(1.0)
            assertEquals(RoomState.PLAYING, coord.state)
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun roomNotFoundAfterRejoinResetsToFreshRoom() = runBlocking {
        // Port of the web's 'error' protocol case: the relay lost our room while the
        // display's link was down, so the rejoin fails with "Room not found". The code on
        // screen is dead (controllers can't join it) — reset the session and create a
        // fresh room instead of keeping the stale QR up (web resetToWelcome path).
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, realFactory(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)

            t.relayError("Room not found"); coord.awaitIdle()
            assertEquals(RoomState.LOBBY, coord.state)
            assertEquals(0, coord.flow.size, "dead room's roster cleared (every peer is unreachable)")
            assertEquals(1, t.freshCreates, "transport asked to create a fresh room")
            assertEquals(DisplayScreen.LOBBY, out.screens.last())

            // The relay's created reply re-arms the lobby with the new room code.
            t.created("NEW1", "inst2"); coord.awaitIdle()
            assertEquals("NEW1", out.lastRoom)

            // A transient relay error is non-fatal: nothing resets.
            t.peerJoined(1); coord.awaitIdle()
            t.relayError("some transient failure"); coord.awaitIdle()
            assertEquals(1, coord.flow.size)
            assertEquals(1, t.freshCreates)
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun helloAutoNameReResolvesRoomUnique() = runBlocking {
        val t = FakeTransport(); val out = FakeOutput()
        val coord = DisplayCoordinator(t, out, engineFactory = { _, _ -> error("no engine") }, seedProvider = { 0L })
        coord.start()
        t.created("R", null); coord.awaitIdle()
        t.peerJoined(1); t.peerJoined(2); coord.awaitIdle() // auto-named HX-1, HX-2

        // A NEW controller submitting a stored auto-name that's already taken re-resolves
        // through the generator (web sanitizePlayerName with requestedAutoName): no duplicates.
        t.deliver(3, buildJsonObject { put("type", Msg.HELLO); put("name", "HX-1"); put("autoName", true) })
        coord.awaitIdle()
        assertEquals("HX-3", coord.flow.player(3)!!.playerName)

        // An EXISTING auto-named player's rejoin HELLO excludes itself from the collision
        // set (keeps its own number) and can't steal another player's.
        t.deliver(1, buildJsonObject { put("type", Msg.HELLO); put("name", "HX-2"); put("autoName", true) })
        coord.awaitIdle()
        assertEquals("HX-1", coord.flow.player(1)!!.playerName)
        coord.stop()
    }

    @Test
    fun helloPreferredColorHonoredCollisionFallsBack() = runBlocking {
        // Web helloPreferredColor: the controller's persisted favorite rides HELLO and
        // wins over the default slot when free, removing the post-WELCOME set_color
        // round trip; a taken color silently falls back (WELCOME carries the truth).
        val t = FakeTransport(); val out = FakeOutput()
        val coord = DisplayCoordinator(t, out, engineFactory = { _, _ -> error("no engine") }, seedProvider = { 0L })
        coord.start()
        t.created("R", null); coord.awaitIdle()

        t.deliver(1, buildJsonObject { put("type", Msg.HELLO); put("name", "Alex"); put("colorIndex", 5) })
        coord.awaitIdle()
        assertEquals(5, coord.flow.player(1)!!.colorSlot)
        val welcome = t.sent.first { it.first == 1 && type(it.second) == Msg.WELCOME }
        assertEquals(5, welcome.second["colorIndex"]!!.jsonPrimitive.int, "WELCOME answers with the kept color")

        t.deliver(2, buildJsonObject { put("type", Msg.HELLO); put("name", "Kim"); put("colorIndex", 5) })
        coord.awaitIdle()
        assertEquals(0, coord.flow.player(2)!!.colorSlot, "taken color falls back to lowest free")

        // A peer_joined-registered player's HELLO (existing branch) re-tints too.
        t.peerJoined(3); coord.awaitIdle()
        t.deliver(3, buildJsonObject { put("type", Msg.HELLO); put("name", "Ola"); put("colorIndex", 7) })
        coord.awaitIdle()
        assertEquals(7, coord.flow.player(3)!!.colorSlot)
        coord.stop()
    }

    @Test
    fun setNameEmptyOrLegacyResolvesToAutoName() = runBlocking {
        // Web onSetName: empty/legacy submissions resolve to a room-unique HX name
        // via the generator instead of being dropped; custom names apply as entered.
        val t = FakeTransport(); val out = FakeOutput()
        val coord = DisplayCoordinator(t, out, engineFactory = { _, _ -> error("no engine") }, seedProvider = { 0L })
        coord.start()
        t.created("R", null); coord.awaitIdle()
        t.peerJoined(1); coord.awaitIdle()

        t.deliver(1, buildJsonObject { put("type", Msg.SET_NAME); put("name", "Alex") }); coord.awaitIdle()
        assertEquals("Alex", coord.flow.player(1)!!.playerName)

        t.deliver(1, buildJsonObject { put("type", Msg.SET_NAME); put("name", "P3") }); coord.awaitIdle()
        assertEquals("HX-1", coord.flow.player(1)!!.playerName, "legacy slot name re-resolves to HX")
        coord.stop()
    }

    @Test
    fun retainedSnapshotShapeAndThrottle() = runBlocking {
        // Web PR #170 parity: lobby changes publish ONE retained set_state snapshot
        // ({hostPeerIndex, players:{idx:{name,color}}}), throttled leading+trailing
        // (400ms) so a join storm collapses to one leading + one trailing publish
        // that reads live state at fire time.
        var now = 0.0
        val t = FakeTransport(); val out = FakeOutput()
        val coord = DisplayCoordinator(t, out, engineFactory = { _, _ -> error("no engine") }, seedProvider = { 0L })
        coord.clock = { now }
        coord.start()
        t.created("R", null); coord.awaitIdle()

        // Leading edge: the first join publishes immediately.
        t.peerJoined(1); coord.awaitIdle()
        assertEquals(1, t.states.size, "leading publish is immediate")

        // Burst inside the window coalesces: no new publish yet.
        t.peerJoined(2); t.peerJoined(3); coord.awaitIdle()
        assertEquals(1, t.states.size, "burst inside the window is pending, not published")

        // The trailing edge fires from the tick loop once the window elapses,
        // reading LIVE state (all three players, latest colors).
        now = 450.0
        coord.tick(16.0)
        assertEquals(2, t.states.size, "trailing publish after the window")
        val snap = t.states.last()
        val players = snap["players"]!!.jsonObject
        assertEquals(setOf("1", "2", "3"), players.keys)
        assertEquals(1, snap["hostPeerIndex"]!!.jsonPrimitive.int, "host pointer carried")
        val p2 = players["2"]!!.jsonObject
        assertEquals("HX-2", p2["name"]!!.jsonPrimitive.content)
        assertEquals(1, p2["color"]!!.jsonPrimitive.int)

        // A color pick after a quiet period publishes immediately with the new color.
        now = 2000.0
        t.deliver(2, buildJsonObject { put("type", Msg.SET_COLOR); put("colorIndex", 6) }); coord.awaitIdle()
        assertEquals(3, t.states.size)
        assertEquals(
            6,
            t.states.last()["players"]!!.jsonObject["2"]!!.jsonObject["color"]!!.jsonPrimitive.int,
            "snapshot confirms the display-accepted color",
        )
        coord.stop()
    }

    // ---- fakes ----

    private class FakeTransport : RelayTransport {
        val sent = mutableListOf<Pair<Int, JsonObject>>() // (to, data); to == -1 for broadcast
        val states = mutableListOf<JsonObject>() // retained set_state snapshots
        var freshCreates = 0
        var roomCloses = 0

        override var onCreated: ((room: String, instance: String?, region: String?) -> Unit)? = null
        override var onJoined: ((room: String, peers: List<Int>) -> Unit)? = null
        override var onPeerJoined: ((index: Int) -> Unit)? = null
        override var onPeerLeft: ((index: Int) -> Unit)? = null
        override var onMessage: ((from: Int, data: JsonObject) -> Unit)? = null
        override var onRelayError: ((message: String) -> Unit)? = null
        override var onReplaced: (() -> Unit)? = null
        override var onConnectionState: ((RelayTransport.ConnectionState, Int) -> Unit)? = null

        override fun connect() {}
        override fun disconnect() {}
        override fun sendTo(index: Int, data: JsonObject) { sent += index to data }
        override fun broadcast(data: JsonObject) { sent += -1 to data }
        override fun setState(data: JsonObject) { states += data }
        override fun createFresh() { freshCreates++ }
        override fun closeRoom() { roomCloses++ }

        // inbound drivers
        fun created(room: String, inst: String?) = onCreated?.invoke(room, inst, null)
        fun joined(room: String, peers: List<Int>) = onJoined?.invoke(room, peers)
        fun peerJoined(i: Int) = onPeerJoined?.invoke(i)
        fun peerLeft(i: Int) = onPeerLeft?.invoke(i)
        fun deliver(from: Int, data: JsonObject) = onMessage?.invoke(from, data)
        fun relayError(msg: String) = onRelayError?.invoke(msg)
    }

    private class FakeOutput : DisplayOutput {
        val screens = mutableListOf<DisplayScreen>()
        val countdowns = mutableListOf<CountdownValue>()
        val snapshots = mutableListOf<GameSnapshot>()
        val events = mutableListOf<GameEvent>()
        val beeps = mutableListOf<Boolean>()
        val setPausedCalls = mutableListOf<Boolean>()
        val disconnects = mutableListOf<Pair<Int, String?>>()
        var lastResults: List<ResultEntry>? = null
        var lastRoom: String? = null
        var lastLobby: List<PlayerRecord>? = null
        var lobbyUpdates = 0
        var musicStarted = false
        var musicStopped = false
        var musicPauses = 0
        var musicResumes = 0
        var pausedFlag = false
        var mutedFlag = false

        override fun showScreen(screen: DisplayScreen) { screens += screen }
        override fun roomReady(room: String, joinUrl: String) { lastRoom = room }
        override fun updateLobby(players: List<PlayerRecord>, hostPeerIndex: Int?) { lobbyUpdates++; lastLobby = players }
        override fun showCountdown(value: CountdownValue) { countdowns += value }
        override fun renderSnapshot(snapshot: GameSnapshot) { snapshots += snapshot }
        override fun showResults(results: List<ResultEntry>) { lastResults = results }
        override fun playCountdownBeep(go: Boolean) { beeps += go }
        override fun startMusic() { musicStarted = true }
        override fun stopMusic() { musicStopped = true }
        override fun pauseMusic() { musicPauses++ }
        override fun resumeMusic() { musicResumes++ }
        override fun handleGameEvent(event: GameEvent) { events += event }
        override fun setDisconnected(playerId: Int, joinUrl: String?) { disconnects += playerId to joinUrl }
        override fun setPaused(paused: Boolean) { this.pausedFlag = paused; setPausedCalls += paused }
        override fun setMuted(muted: Boolean) { this.mutedFlag = muted }
    }
}
