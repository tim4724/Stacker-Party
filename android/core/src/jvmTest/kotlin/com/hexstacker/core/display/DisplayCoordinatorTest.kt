package com.hexstacker.core.display

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.net.Msg
import com.hexstacker.core.net.RelayTransport
import com.hexstacker.core.net.RoomState
import com.hexstacker.core.room.PlayerRecord
import com.hexstacker.core.room.RoomSnapshot
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.double
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
 * [RelayTransport] (records sent frames + retained snapshots) + a fake
 * [DisplayOutput] (records side-effects) + a REAL [EngineBridge] driven from the
 * QuickJS bundle (the `hexcore.bundle` system property, as the engine tests do).
 * The bridge is not optional any more, even for lobby-only cases: the room brain
 * lives in that same JS runtime.
 *
 * Drives the lifecycle: connect -> lobby -> hello -> start_game -> countdown
 * 3/2/1/GO -> playing -> top-out -> results -> play_again -> return_to_lobby, and
 * asserts against the RETAINED ROOM SNAPSHOT at each step, because that snapshot is
 * now the entire protocol: the ten per-event room messages this display used to
 * send are gone (see [retiredRoomMessagesAreNeverSent]).
 */
class DisplayCoordinatorTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun bundle(): String {
        val p = System.getProperty("hexcore.bundle") ?: error("hexcore.bundle not set by build")
        return File(p).readText()
    }

    /** The room brain and each match's game share ONE runtime, so the provider hands
     *  back the same bridge every time (as :tv's engineAsync() does). */
    private fun provider(bridge: EngineBridge): suspend () -> EngineBridge = { bridge }

    private fun type(o: JsonObject): String? = (o["type"] as? JsonPrimitive)?.contentOrNull
    private fun hello(name: String) = buildJsonObject { put("type", Msg.HELLO); put("name", name) }
    private fun simple(t: String) = buildJsonObject { put("type", t) }
    private fun input(action: String) = buildJsonObject { put("type", Msg.INPUT); put("action", action) }

    /** The last published room snapshot, decoded — the exact bytes a controller gets. */
    private fun FakeTransport.lastState(): RoomSnapshot = json.decodeFromJsonElement(states.last())

    @Test
    fun fullLifecycleLobbyToResults() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport()
            val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()

            t.created("ROOM42", "inst1"); coord.awaitIdle()
            assertEquals(DisplayScreen.LOBBY, out.screens.last())
            assertEquals("ROOM42", out.lastRoom)

            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            assertEquals(2, coord.room.size)
            // Room changes publish ONE retained snapshot (set_state), never a fanout.
            assertEquals(setOf(1, 2), t.lastState().players.keys)
            // peer_joined is a PLACEHOLDER row: the slot is claimed for the others, but the
            // joiner's own controller waits for its HELLO before rendering an identity.
            assertFalse(t.lastState().player(1)!!.helloSeen)

            // hello -> the snapshot carries the identity (no WELCOME any more)
            t.deliver(1, hello("Alex")); coord.awaitIdle()
            assertEquals("Alex", coord.room.player(1)!!.name)
            val afterHello = t.lastState()
            assertTrue(afterHello.player(1)!!.helloSeen)
            assertEquals("Alex", afterHello.player(1)!!.name)
            assertEquals(1, afterHello.hostPeerIndex)
            assertEquals(RoomState.LOBBY, afterHello.state)

            // start_game -> beginCountdown (boards visible behind overlay)
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)
            assertEquals(DisplayScreen.GAME, out.screens.last())
            // Controllers route themselves off roomState; the digits stay display-only.
            assertEquals(RoomState.COUNTDOWN, t.lastState().state)

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
            coord.tick(500.0)
            assertEquals(RoomState.PLAYING, coord.state)
            assertEquals(RoomState.PLAYING, t.lastState().state)

            // late joiner during PLAYING: in the roster, out of the participant list, so
            // their controller renders the waiting screen from the snapshot alone.
            t.deliver(3, hello("Zoe")); coord.awaitIdle()
            val withLate = t.lastState()
            assertTrue(withLate.has(3))
            assertFalse(withLate.isParticipant(3), "a late joiner waits out the round")
            assertEquals(listOf(1, 2), withLate.participants)

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
            assertTrue(
                t.sent.any { it.first >= 0 && type(it.second) == Msg.PLAYER_STATE },
                "a KO still unicasts player_state (the controller's own HUD, not room state)",
            )
            val results = assertNotNull(out.lastResults)
            assertTrue(results.isNotEmpty())
            assertTrue(results.all { it.playerName != null }, "results enriched with names")
            assertTrue(results.any { it.playerId == 3 && it.newPlayer }, "late joiner appears as newPlayer")
            // The RESULTS snapshot replays the ranking, so a controller that (re)joins on
            // the results screen still sees it.
            val ranking = assertNotNull(t.lastState().results)
            assertEquals(results.size, ranking.size)
            assertFalse(t.lastState().player(2)!!.alive, "a KO'd player is dead in the snapshot")

            // play_again -> new countdown
            t.deliver(1, simple(Msg.PLAY_AGAIN)); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)

            // return_to_lobby -> lobby, published
            t.deliver(1, simple(Msg.RETURN_TO_LOBBY)); coord.awaitIdle()
            assertEquals(RoomState.LOBBY, coord.state)
            assertEquals(DisplayScreen.LOBBY, out.screens.last())
            assertEquals(RoomState.LOBBY, t.lastState().state)
            assertEquals(null, t.lastState().results, "the stale ranking is dropped")

            coord.stop()
        } finally {
            bridge.close()
        }
    }

    /**
     * The ten room messages the snapshot replaced. A display that still sends any of
     * them is talking to a controller that no longer listens, which is exactly the
     * bug this port fixes; keep the list here so a re-introduction fails loudly.
     */
    @Test
    fun retiredRoomMessagesAreNeverSent() = runBlocking {
        // Literal wire strings on purpose: the Msg constants are deleted, and the
        // point of this test is that these BYTES never reach a controller again.
        // return_to_lobby still exists as a controller -> display REQUEST, so it
        // is listed for the outbound direction only, which is all this checks.
        val retired = setOf(
            "welcome", "lobby_update", "game_start", "countdown", "game_end",
            "game_over", "game_paused", "game_resumed", "return_to_lobby", "display_muted",
        )
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            t.deliver(1, simple(Msg.PAUSE_GAME)); coord.awaitIdle()
            t.deliver(1, simple(Msg.RESUME_GAME)); coord.awaitIdle()
            t.deliver(1, buildJsonObject { put("type", Msg.SET_DISPLAY_MUTE); put("muted", true) })
            coord.awaitIdle()
            coord.remoteToggleMute()
            t.deliver(1, simple(Msg.RETURN_TO_LOBBY)); coord.awaitIdle()
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()

            val sentTypes = t.sent.mapNotNull { type(it.second) }.toSet()
            assertEquals(emptySet(), sentTypes intersect retired, "retired room messages went out")
            assertTrue(t.states.isNotEmpty(), "the room went out as retained snapshots instead")
            coord.stop()
        } finally { bridge.close() }
    }

    // Render-on-input: a controller input renders the applied state on the spot, without
    // waiting for the next frame() tick. A non-input message must NOT render.
    @Test
    fun inputRendersImmediatelyWithoutWaitingForTick() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport()
            val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
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
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)

            // pause: the overlay locally, and `paused` in the published snapshot (the only
            // pause a controller can act on).
            t.deliver(1, simple(Msg.PAUSE_GAME)); coord.awaitIdle()
            assertTrue(out.pausedFlag)
            assertTrue(t.lastState().paused)

            // resume
            t.deliver(1, simple(Msg.RESUME_GAME)); coord.awaitIdle()
            assertFalse(out.pausedFlag)
            assertFalse(t.lastState().paused)

            // Pause again, then everyone disconnects. The manual pause converts into a
            // silent auto-pause: the stranded overlay hides (Continue can't be reached
            // while everyone is gone, so a shown overlay could never be dismissed), but
            // the game stays paused. A DISPLAY-remote resume is still blocked (a
            // controller resume would reconnect the sender first; the remote does not).
            t.deliver(1, simple(Msg.PAUSE_GAME)); coord.awaitIdle()
            assertTrue(out.pausedFlag, "manual pause shows the overlay")
            t.peerLeft(1); t.peerLeft(2); coord.awaitIdle()
            assertEquals(0, coord.brain.connectedCount())
            assertFalse(out.pausedFlag, "overlay hides when the last player drops during a manual pause")
            assertFalse(t.lastState().paused, "and controllers are told the pause is no longer actionable")

            val resumesBefore = out.musicResumes
            coord.remoteTogglePause()
            assertFalse(out.pausedFlag, "overlay stays hidden; resume blocked while everyone is disconnected")
            assertEquals(resumesBefore, out.musicResumes, "game stays paused (no resume) while everyone is disconnected")

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
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport()
            val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0L })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle() // slots 0 / 1, host = 1

            // set_level: reject out-of-range, accept in-range
            t.deliver(1, buildJsonObject { put("type", Msg.SET_LEVEL); put("level", 99) }); coord.awaitIdle()
            assertEquals(1, coord.room.player(1)!!.startLevel)
            t.deliver(1, buildJsonObject { put("type", Msg.SET_LEVEL); put("level", 7) }); coord.awaitIdle()
            assertEquals(7, coord.room.player(1)!!.startLevel)

            // set_color: reject taken slot, accept free slot
            t.deliver(1, buildJsonObject { put("type", Msg.SET_COLOR); put("colorIndex", 1) }); coord.awaitIdle()
            assertEquals(0, coord.room.player(1)!!.color)
            t.deliver(1, buildJsonObject { put("type", Msg.SET_COLOR); put("colorIndex", 3) }); coord.awaitIdle()
            assertEquals(3, coord.room.player(1)!!.color)

            // ping -> pong echoes t
            t.sent.clear()
            t.deliver(2, buildJsonObject { put("type", Msg.PING); put("t", 42.5) }); coord.awaitIdle()
            val pong = t.sent.firstOrNull { it.first == 2 && type(it.second) == Msg.PONG }
            assertNotNull(pong)
            assertEquals(42.5, pong.second["t"]!!.jsonPrimitive.double)

            // room full: fill to 8, the 9th controller is rejected
            for (i in 3..8) t.peerJoined(i)
            coord.awaitIdle()
            assertEquals(8, coord.room.size)
            t.sent.clear()
            t.peerJoined(9); coord.awaitIdle()
            assertEquals(8, coord.room.size, "peer_joined into a full room is refused silently")
            // The error only goes out on a HELLO: that is the message with a controller
            // behind it waiting for an answer.
            t.deliver(9, hello("Nope")); coord.awaitIdle()
            assertTrue(t.sent.any { it.first == 9 && type(it.second) == Msg.ERROR })
            assertEquals(8, coord.room.size)

            coord.stop()
        } finally { bridge.close() }
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
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)

            val pausesBefore = out.musicPauses
            t.peerLeft(1); t.peerLeft(2); coord.awaitIdle()
            assertTrue(coord.brain.allParticipantsDisconnected())
            assertTrue(out.musicPauses > pausesBefore, "music paused on all-disconnect")
            assertFalse(t.lastState().paused, "an auto-pause is display-internal, never published as actionable")
            assertFalse(out.pausedFlag, "no pause overlay for a silent auto-pause")

            // Any message from a dropped participant reconnects it and lifts the auto-pause.
            t.deliver(1, simple(Msg.PING)); coord.awaitIdle()
            assertEquals(RoomState.PLAYING, coord.state)
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
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            t.deliver(3, hello("Zoe")); coord.awaitIdle() // late joiner (waiting for next game)
            assertTrue(coord.brain.hasLateJoiners())

            now = 1000.0
            t.peerLeft(1); t.peerLeft(2); coord.awaitIdle() // arms the 5s grace deadline
            assertEquals(RoomState.PLAYING, coord.state, "still playing during the grace window")

            now = 6100.0
            coord.tick(1200.0) // 1Hz sweep fires graceTick past the deadline
            assertEquals(RoomState.LOBBY, coord.state, "grace elapsed -> back to lobby for the late joiner")
            assertEquals(RoomState.LOBBY, t.lastState().state)

            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun livenessSweepDisconnectsSilentControllerWithRejoinUrl() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            // Keep peer 2 alive; let peer 1 go silent past LIVENESS_TIMEOUT_MS (3s).
            now = 3500.0
            t.deliver(2, simple(Msg.PING)); coord.awaitIdle() // refreshes peer 2 presence
            out.disconnects.clear()
            coord.tick(1100.0) // 1Hz sweep -> brain.tick(now, seen) -> expired -> rejoin QR
            assertTrue(coord.brain.isDisconnected(1), "silent controller marked disconnected")
            assertFalse(coord.brain.isDisconnected(2), "recently-seen controller stays connected")
            val overlay = out.disconnects.lastOrNull { it.first == 1 }
            assertNotNull(overlay)
            assertTrue(overlay.second?.contains("claim=1") == true, "rejoin overlay carries ?claim=<peerIndex>")

            coord.stop()
        } finally { bridge.close() }
    }

    /** The snapshot is the controller's authority on pause state, so a rejoin must publish
     *  the state the display will actually be in — not a stale paused=true chased by a
     *  resume. A controller that latched the first and missed the second sat on a pause
     *  overlay whose Continue did nothing: the display was no longer paused, so
     *  resumeGame()'s manual-pause guard dropped the request. (Reported from a live Wi-Fi
     *  drop on tvOS; Android had the same ordering.) */
    @Test
    fun rejoinSnapshotReportsResumedNotStalePaused() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1))
            assertEquals(RoomState.PLAYING, coord.state)

            // Link drops mid-game: the sim freezes, nothing can be published.
            coord.onLinkStateChanged(RelayTransport.ConnectionState.RECONNECTING); coord.awaitIdle()
            t.states.clear()

            // Link returns and the relay answers the rejoin.
            coord.onLinkStateChanged(RelayTransport.ConnectionState.OPEN); coord.awaitIdle()
            t.joined("R", listOf(1)); coord.awaitIdle()

            assertTrue(t.states.isNotEmpty(), "the rejoin republishes the room")
            assertTrue(
                t.states.none { json.decodeFromJsonElement<RoomSnapshot>(it).paused },
                "no snapshot may report the pause the display is lifting in the same breath",
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
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            t.deliver(1, simple(Msg.PING)); t.deliver(2, simple(Msg.PING)); coord.awaitIdle()
            t.deliver(3, hello("Zoe")); coord.awaitIdle() // late joiner -> arms the grace path
            assertTrue(coord.brain.hasLateJoiners())

            // Our socket drops. No controller traffic can reach us for the whole reconnect
            // budget (~13s of capped backoff), so every lastSeen goes stale.
            coord.onLinkStateChanged(RelayTransport.ConnectionState.RECONNECTING); coord.awaitIdle()
            now = 12_000.0
            coord.tick(1100.0); coord.tick(1100.0)
            assertFalse(coord.brain.isDisconnected(1), "our outage must not expire a controller")
            assertFalse(coord.brain.isDisconnected(2), "our outage must not expire a controller")
            assertEquals(RoomState.PLAYING, coord.state, "the match is not grace-returned to the lobby")

            // Socket back, but the relay hasn't answered our join yet: it still drops
            // everything addressed to us, so the sweep must STAY off. Re-arming here (and
            // leaning on a re-stamp to cover the gap) only buys LIVENESS_TIMEOUT_MS, while
            // the handshake deadline is twice that — a slow `joined` would expire the room.
            coord.onLinkStateChanged(RelayTransport.ConnectionState.OPEN); coord.awaitIdle()
            now = 24_000.0
            coord.tick(1100.0); coord.tick(1100.0)
            assertFalse(coord.brain.isDisconnected(1), "socket-open alone must not re-arm the sweep")
            assertFalse(coord.brain.isDisconnected(2), "socket-open alone must not re-arm the sweep")
            assertEquals(RoomState.PLAYING, coord.state)

            // The `joined` reply reconciles the roster and re-stamps the survivors, so the
            // sweep comes back on with clean presence.
            t.joined("R", listOf(1, 2, 3)); coord.awaitIdle()
            coord.tick(1100.0)
            assertFalse(coord.brain.isDisconnected(1), "re-stamped by the roster reconcile")
            assertFalse(coord.brain.isDisconnected(2), "re-stamped by the roster reconcile")

            // ...and it really is on again: silence from here does expire a controller.
            now = 30_000.0
            coord.tick(1100.0)
            assertTrue(coord.brain.isDisconnected(1), "the sweep is live once we are back in the room")

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
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); coord.awaitIdle()
            t.deliver(1, hello("Alex")); coord.awaitIdle()
            t.deliver(1, buildJsonObject { put("type", Msg.SET_COLOR); put("colorIndex", 5) })
            coord.awaitIdle()
            assertEquals("Alex", coord.room.player(1)!!.name)
            assertEquals(5, coord.room.player(1)!!.color)

            t.sent.clear()
            t.peerJoined(1); coord.awaitIdle()
            assertEquals(1, coord.room.size, "no duplicate roster entry")
            assertEquals("Alex", coord.room.player(1)!!.name, "reconnect keeps the name")
            assertEquals(5, coord.room.player(1)!!.color, "reconnect keeps the colour slot")

            // Fill the room (peer 1 holds slot 5; 2..8 take the remaining seven), then
            // replay peer 1's join: with no free slot left, re-registering would answer
            // the returning player "Room is full" and its controller would hard-bail.
            for (i in 2..8) t.peerJoined(i)
            coord.awaitIdle()
            assertEquals(8, coord.room.size)
            t.sent.clear()
            t.peerJoined(1); coord.awaitIdle()
            assertEquals("Alex", coord.room.player(1)!!.name)
            assertEquals(5, coord.room.player(1)!!.color)
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
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); coord.awaitIdle()

            // remoteStartMatch from LOBBY -> COUNTDOWN
            coord.remoteStartMatch(); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)

            // remoteReturnToLobby -> LOBBY
            coord.remoteReturnToLobby(); coord.awaitIdle()
            assertEquals(RoomState.LOBBY, coord.state)

            // remoteToggleMute flips + publishes + drives output.setMuted (the host
            // controller's Game Music switch reads displayMuted off the snapshot).
            val muted = coord.remoteToggleMute()
            assertTrue(muted)
            assertTrue(out.mutedFlag, "remote mute silences TV music via output.setMuted")
            assertTrue(t.lastState().displayMuted)

            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun crossDeviceClaimReclaimsDroppedBoard() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            // Player 1 drops mid-game -> disconnected + per-board rejoin overlay.
            t.peerLeft(1); coord.awaitIdle()
            assertTrue(coord.brain.isDisconnected(1))

            // A returning phone gets a fresh peerIndex (5), then claims peer 1 via the ?claim= QR.
            t.peerJoined(5); coord.awaitIdle()
            out.disconnects.clear()
            t.deliver(5, buildJsonObject { put("type", Msg.HELLO); put("rejoinToken", 1) }); coord.awaitIdle()

            assertTrue(coord.room.has(5), "returning peer holds the reclaimed slot")
            assertFalse(coord.room.has(1), "the old peerIndex is gone (placeholder + old record merged)")
            assertFalse(coord.brain.isDisconnected(5), "the reclaimed board is connected")
            assertTrue(coord.room.isParticipant(5), "and it inherited the dropped board's seat")
            assertTrue(out.disconnects.any { it.first == 1 && it.second == null }, "old board's rejoin overlay cleared")
            assertEquals(RoomState.PLAYING, coord.state, "the match continues")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun activeParticipantCannotForgeClaim() = runBlocking {
        // An ACTIVE participant sending a claim HELLO for a dropped board is refused (a
        // genuine cross-device rejoin arrives under a fresh peer index); Game.rekeyPlayer
        // refuses the same case engine-side.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            t.peerLeft(1); coord.awaitIdle()
            assertTrue(coord.brain.isDisconnected(1))

            // Active participant 2 tries to claim player 1's dropped board.
            t.deliver(2, buildJsonObject { put("type", Msg.HELLO); put("rejoinToken", 1) }); coord.awaitIdle()
            assertTrue(coord.room.has(1), "the dropped board's slot is NOT absorbed")
            assertTrue(coord.brain.isDisconnected(1), "player 1 stays reclaimable")
            assertTrue(coord.room.has(2), "the forger keeps its own identity")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun autoNamesAreRoomUniqueAndSkipTheBlocklist() = runBlocking {
        // Auto-naming is the shared module's, not a Kotlin re-implementation: room-unique
        // HX-N picked at RANDOM from the allowed pool (Android used to pick lowest-free,
        // tvOS had no blocklist at all — which is precisely why it moved into RoomBrain).
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0L })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            for (i in 1..8) t.peerJoined(i)
            coord.awaitIdle()
            val names = coord.room.players.values.map { it.name }
            assertEquals(8, names.toSet().size, "auto names are room-unique")
            val blocked = setOf(4, 13, 17, 69)
            for (n in names) {
                val m = Regex("^HX-([1-9][0-9]?)$").matchEntire(n)
                assertNotNull(m, "auto name $n is not an HX name")
                assertFalse(m.groupValues[1].toInt() in blocked, "generated a blocklisted $n")
            }
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun closeRoomOnStop() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0L })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); coord.awaitIdle()
            t.sent.clear()
            coord.stop()
            // Deliberate exit tears the room down on the relay; the members' 4001
            // close frames are their party-over signal, so nothing is sent.
            assertEquals(1, t.roomCloses, "stop() sends close_room")
            assertTrue(t.sent.isEmpty(), "stop() sends nothing else")
        } finally { bridge.close() }
    }

    @Test
    fun nameSanitizingIsTheSharedModules() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0L })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            // Control chars (tab) stripped, then trimmed. Zero-width characters are KEPT:
            // the old Kotlin sanitizer carried a hand-rolled default-ignorable table that
            // neither of the other two displays had, so it is gone with the rest.
            t.deliver(1, hello("  A​l\tex  ")); coord.awaitIdle()
            assertEquals("A​lex", coord.room.player(1)!!.name)
            // Legacy "P2" slot name -> auto HX name, never applied verbatim.
            t.deliver(2, hello("P2")); coord.awaitIdle()
            assertTrue(coord.room.player(2)!!.name.startsWith("HX-"), "P1-8 legacy slot names are auto-named")
            // Overlong submissions are capped at NAME_MAX_LEN.
            t.deliver(3, hello("ThisNameIsFarTooLongToFit")); coord.awaitIdle()
            assertEquals("ThisNameIsFarToo", coord.room.player(3)!!.name)
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun displayRejoinReStampsSurvivorLiveness() = runBlocking {
        // onDisplayRejoined re-stamps presence for every surviving peer, so a survivor whose
        // last ping predates the display's own link drop is NOT expired by the first
        // liveness sweep after reconnect.
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)
            // Both controllers last pinged at t=0.
            t.deliver(1, simple(Msg.PING)); t.deliver(2, simple(Msg.PING)); coord.awaitIdle()

            // The display's relay link drops and rejoins ~2.5s later with both peers present.
            now = 2500.0
            t.joined("R", listOf(1, 2)); coord.awaitIdle()
            assertTrue(coord.room.has(1) && coord.room.has(2), "survivors kept on rejoin")

            // A liveness sweep at t=3200. Without the rejoin re-stamp both peers' last-seen would
            // still read t=0 (>3s stale) and both would be flagged disconnected here.
            now = 3200.0
            coord.tick(1100.0)
            assertFalse(coord.brain.isDisconnected(1), "rejoin re-stamped survivor 1's liveness")
            assertFalse(coord.brain.isDisconnected(2), "rejoin re-stamped survivor 2's liveness")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun allDropDuringCountdownAutoPausesOnStart() = runBlocking {
        // startPlaying() runs checkAllParticipantsDisconnected() right after entering
        // PLAYING, so an all-drop during COUNTDOWN silently auto-pauses at match start
        // instead of playing itself out unpaused.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            assertEquals(RoomState.COUNTDOWN, coord.state)

            // Enter the countdown, then everyone drops mid-countdown (no auto-pause yet).
            coord.tick(0.0) // step 0 -> "3"
            t.peerLeft(1); t.peerLeft(2); coord.awaitIdle()
            assertTrue(coord.brain.allParticipantsDisconnected())
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
        // beginCountdown() calls clearDisconnected(now) to re-stamp presence on the
        // everyone-present transition, so a controller that went quiet just before the
        // match isn't instantly flagged during COUNTDOWN.
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
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
            assertFalse(coord.brain.isDisconnected(2), "beginCountdown re-stamped the quiet controller's liveness")
            assertFalse(coord.brain.isDisconnected(1), "the host controller stays connected")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun linkResumeWaitsForRoomRejoinNotSocketOpen() = runBlocking {
        // The display's link-drop pause must lift on the relay's `joined` reply (roster
        // reconciled), NOT on raw socket OPEN — OPEN fires before the relay has processed
        // the join, so publishing then could be dropped server-side.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)

            // Link drops mid-game: silent pause (controllers unreachable).
            val pausesBefore = out.musicPauses
            coord.onLinkStateChanged(RelayTransport.ConnectionState.RECONNECTING); coord.awaitIdle()
            assertTrue(out.musicPauses > pausesBefore, "link drop pauses the running game")

            // Socket re-opens; the room-level join is still in flight -> no resume yet.
            val resumesBefore = out.musicResumes
            coord.onLinkStateChanged(RelayTransport.ConnectionState.OPEN); coord.awaitIdle()
            assertEquals(resumesBefore, out.musicResumes, "no resume before the room rejoin")

            // The relay's joined reply reconciles the roster -> the game resumes now.
            t.joined("R", listOf(1, 2)); coord.awaitIdle()
            assertTrue(out.musicResumes > resumesBefore, "music resumed with the game after joined")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun returnToLobbyPrunesJustExpiredController() = runBlocking {
        // pruneDisconnected must also drop a controller whose silence hasn't yet been
        // flagged by the 1 Hz liveness sweep (it prunes on isDisconnected || isExpired).
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.clock = { now }
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            // Both controllers last checked in at t=0; peer 2 then goes silent.
            t.deliver(1, simple(Msg.PING)); t.deliver(2, simple(Msg.PING)); coord.awaitIdle()
            coord.tick(1100.0) // fold the batched `seen` set into the brain

            // Host returns to lobby >3s later, BEFORE any liveness sweep flagged peer 2.
            now = 3500.0
            t.deliver(1, simple(Msg.RETURN_TO_LOBBY)); coord.awaitIdle()
            assertEquals(RoomState.LOBBY, coord.state)
            assertTrue(coord.room.has(1), "the just-seen host survives the prune")
            assertFalse(coord.room.has(2), "a silent-past-timeout controller is pruned without waiting for the sweep")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun pauseDuringCountdownFreezesAndResumeReplaysTheCurrentSecond() = runBlocking {
        // Web pauseGame/resumeGame support COUNTDOWN: pausing freezes the count and
        // resuming gives the current number its FULL second again, without re-showing it.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            t.deliver(1, simple(Msg.START_GAME)); coord.awaitIdle()
            coord.tick(0.0)      // "3"
            coord.tick(1000.0)   // "2"
            assertEquals(listOf<CountdownValue>(CountdownValue.Number(3), CountdownValue.Number(2)), out.countdowns)

            // Pause mid-"2": overlay + published pause, and the count freezes.
            t.deliver(1, simple(Msg.PAUSE_GAME)); coord.awaitIdle()
            assertTrue(out.pausedFlag, "pause overlay shows during a countdown pause")
            assertTrue(t.lastState().paused)
            coord.tick(5000.0)
            assertEquals(RoomState.COUNTDOWN, coord.state, "countdown frozen while paused")
            assertEquals(2, out.countdowns.size, "no further countdown steps while paused")

            // Resume: "2" replays its full second — 999ms later still nothing, 1ms more -> "1".
            t.deliver(1, simple(Msg.RESUME_GAME)); coord.awaitIdle()
            assertFalse(out.pausedFlag)
            assertFalse(t.lastState().paused)
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
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
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
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0xBADCAFEL })
            coord.start()
            toPlaying(coord, t, listOf(1, 2))
            assertEquals(RoomState.PLAYING, coord.state)

            t.relayError("Room not found"); coord.awaitIdle()
            assertEquals(RoomState.LOBBY, coord.state)
            assertEquals(0, coord.room.size, "dead room's roster cleared (every peer is unreachable)")
            assertEquals(1, t.freshCreates, "transport asked to create a fresh room")
            assertEquals(DisplayScreen.LOBBY, out.screens.last())

            // The relay's created reply re-arms the lobby with the new room code.
            t.created("NEW1", "inst2"); coord.awaitIdle()
            assertEquals("NEW1", out.lastRoom)

            // A transient relay error is non-fatal: nothing resets.
            t.peerJoined(1); coord.awaitIdle()
            t.relayError("some transient failure"); coord.awaitIdle()
            assertEquals(1, coord.room.size)
            assertEquals(1, t.freshCreates)
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun helloAutoNameReResolvesRoomUnique() = runBlocking {
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0L })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            val taken = coord.room.player(1)!!.name

            // A NEW controller submitting a stored auto-name that's already taken
            // re-resolves through the generator: no duplicates.
            t.deliver(3, buildJsonObject { put("type", Msg.HELLO); put("name", taken); put("autoName", true) })
            coord.awaitIdle()
            assertFalse(coord.room.player(3)!!.name == taken, "a taken auto-name is re-resolved")

            // An EXISTING auto-named player's rejoin HELLO excludes its own row from the
            // collision set, so its number survives the round trip.
            t.deliver(1, buildJsonObject { put("type", Msg.HELLO); put("name", taken); put("autoName", true) })
            coord.awaitIdle()
            assertEquals(taken, coord.room.player(1)!!.name)
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun helloPreferredColorHonoredCollisionFallsBack() = runBlocking {
        // The controller's persisted favourite rides HELLO and wins over the default slot
        // when free, removing the post-HELLO set_color round trip; a taken colour silently
        // falls back (the snapshot carries the truth either way).
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0L })
            coord.start()
            t.created("R", null); coord.awaitIdle()

            t.deliver(1, buildJsonObject { put("type", Msg.HELLO); put("name", "Alex"); put("colorIndex", 5) })
            coord.awaitIdle()
            assertEquals(5, coord.room.player(1)!!.color)
            assertEquals(5, t.lastState().player(1)!!.color, "the snapshot answers with the kept colour")

            t.deliver(2, buildJsonObject { put("type", Msg.HELLO); put("name", "Kim"); put("colorIndex", 5) })
            coord.awaitIdle()
            assertEquals(0, coord.room.player(2)!!.color, "taken colour falls back to lowest free")

            // A peer_joined-registered player's HELLO (existing branch) re-tints too.
            t.peerJoined(3); coord.awaitIdle()
            t.deliver(3, buildJsonObject { put("type", Msg.HELLO); put("name", "Ola"); put("colorIndex", 7) })
            coord.awaitIdle()
            assertEquals(7, coord.room.player(3)!!.color)
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun setNameEmptyOrLegacyResolvesToAutoName() = runBlocking {
        // Empty/legacy submissions resolve to a room-unique HX name via the generator
        // instead of being dropped; custom names apply as entered.
        val bridge = EngineBridge.create(bundle())
        try {
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0L })
            coord.start()
            t.created("R", null); coord.awaitIdle()
            t.peerJoined(1); coord.awaitIdle()

            t.deliver(1, buildJsonObject { put("type", Msg.SET_NAME); put("name", "Alex") }); coord.awaitIdle()
            assertEquals("Alex", coord.room.player(1)!!.name)

            t.deliver(1, buildJsonObject { put("type", Msg.SET_NAME); put("name", "P3") }); coord.awaitIdle()
            assertTrue(coord.room.player(1)!!.name.startsWith("HX-"), "legacy slot name re-resolves to HX")
            coord.stop()
        } finally { bridge.close() }
    }

    @Test
    fun retainedSnapshotShapeAndThrottle() = runBlocking {
        // The snapshot IS the protocol, and the level stepper / colour rose are the two
        // finger-speed controls the brain hints 'soon' for: leading + trailing, so a burst
        // collapses into one trailing publish that reads live state at fire time. The
        // window comes from RoomBrain.SNAPSHOT_THROTTLE_MS, not from a Kotlin constant.
        val bridge = EngineBridge.create(bundle())
        try {
            var now = 0.0
            val t = FakeTransport(); val out = FakeOutput()
            val coord = DisplayCoordinator(t, out, provider(bridge), seedProvider = { 0L })
            coord.clock = { now }
            coord.start()
            t.created("R", null); coord.awaitIdle()

            // A join is a 'now' hint: it publishes immediately, throttle or no throttle.
            t.peerJoined(1); t.peerJoined(2); coord.awaitIdle()
            assertEquals(2, t.states.size, "joins publish immediately")
            val snap = t.lastState()
            assertEquals(setOf(1, 2), snap.players.keys)
            assertEquals(1, snap.hostPeerIndex, "host pointer carried")
            assertEquals(listOf(1, 2), snap.participants)
            assertEquals(1, snap.player(2)!!.color)
            assertEquals(1, snap.player(2)!!.startLevel)

            // Level steps inside the window coalesce: pending, not published.
            now = 100.0
            t.deliver(2, buildJsonObject { put("type", Msg.SET_LEVEL); put("level", 5) }); coord.awaitIdle()
            t.deliver(2, buildJsonObject { put("type", Msg.SET_LEVEL); put("level", 9) }); coord.awaitIdle()
            assertEquals(2, t.states.size, "burst inside the window is pending, not published")

            // The trailing edge fires from the tick loop once the window elapses, reading
            // LIVE state (the final level).
            now = 650.0
            coord.tick(16.0)
            assertEquals(3, t.states.size, "trailing publish after the window")
            assertEquals(9, t.lastState().player(2)!!.startLevel)

            // A colour pick after a quiet period publishes immediately with the new colour.
            now = 2000.0
            t.deliver(2, buildJsonObject { put("type", Msg.SET_COLOR); put("colorIndex", 6) }); coord.awaitIdle()
            assertEquals(4, t.states.size)
            assertEquals(6, t.lastState().player(2)!!.color, "snapshot confirms the display-accepted colour")
            coord.stop()
        } finally { bridge.close() }
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
