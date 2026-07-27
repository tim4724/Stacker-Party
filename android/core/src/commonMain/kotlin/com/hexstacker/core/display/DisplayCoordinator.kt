package com.hexstacker.core.display

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.engine.InputAction
import com.hexstacker.core.net.Fastlane
import com.hexstacker.core.model.Command
import com.hexstacker.core.model.CommandType
import com.hexstacker.core.model.EngineJson
import com.hexstacker.core.model.PlayerResult
import com.hexstacker.core.net.ControllerMessage
import com.hexstacker.core.net.Msg
import com.hexstacker.core.net.OutboundMessage
import com.hexstacker.core.net.RelayConfig
import com.hexstacker.core.net.RelayTransport
import com.hexstacker.core.net.RoomState
import com.hexstacker.core.room.RoomCoreClient
import com.hexstacker.core.room.RoomSnapshot
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.random.Random
import kotlin.time.DurationUnit
import kotlin.time.TimeSource

/**
 * The native display brain: owns the relay transport, the engine, and the display
 * half of the protocol (lobby -> countdown -> playing -> results). Everything that
 * IS the room — roster, auto-naming, colour slots, host election, the pause/mute/
 * results facts and the retained snapshot controllers render from — belongs to
 * [RoomCoreClient], i.e. to `server/RoomCore.js` running in the session's QuickJS
 * runtime, the same module the web display and Apple TV run. This class keeps the
 * transport, timers, rendering and audio, and nothing else.
 *
 * The snapshot IS the protocol: one `set_state` publish carries the whole room, and
 * the ten per-event messages this display used to send (welcome, lobby_update,
 * game_start, countdown, game_end, game_over, game_paused, game_resumed,
 * return_to_lobby, display_muted) are gone. What still goes out is what is not room
 * state: error("Room is full"), pong, and the targeted player_state.
 *
 * Threading (the Kotlin analogue of Swift's "everything on .main"): every inbound
 * relay callback, every remote-control action, and every [tick] is funnelled
 * through ONE [Channel] consumed by a single coroutine on [scope]'s
 * single-thread dispatcher. The consumer is the only thing that mutates the room core,
 * the pause flags, the countdown counters and the engine handle, so there is no
 * shared-state race and engine calls can suspend without interleaving.
 * [tick] / [awaitIdle] enqueue and await an ack, so callers observe a settled state
 * when they return.
 *
 * commonMain-only: depends on [RelayTransport] (interface), [EngineBridge],
 * the models, kotlinx.serialization.json and kotlinx.coroutines. No OkHttp / no
 * android.* — the concrete relay client lives in the Relay sibling subsystem.
 */
class DisplayCoordinator(
    private val transport: RelayTransport,
    private val output: DisplayOutput,
    /**
     * The session's ONE QuickJS runtime, awaited lazily. The room core and each
     * match's game live in the SAME context (the JS shim's `Bridge` holds both), so
     * this is deliberately a single provider rather than a separate engine factory:
     * two runtimes would mean two `Bridge` objects and a room nobody publishes.
     */
    private val bridgeProvider: suspend () -> EngineBridge,
    /** 32-bit unsigned seed in 0..0xFFFFFFFF; the engine applies `>>> 0`. */
    private val seedProvider: () -> Long = { Random.nextLong(0, 0x1_0000_0000L) },
    /** Optional WebRTC low-latency input path (relay is the fallback). Null = relay-only. */
    private val fastlane: Fastlane? = null,
    /** Observability for boundary errors that are swallowed to keep the loop alive
     *  (engine/parse failures). Wire to platform logging in :tv; no-op by default. */
    private val onError: (label: String, error: Throwable) -> Unit = { _, _ -> },
    dispatcher: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
) {
    private var brainOrNull: RoomCoreClient? = null

    /** The room core. Available from the consumer's first action onwards; see [consume]. */
    internal val roomCore: RoomCoreClient
        get() = brainOrNull ?: error("room core not initialized yet")

    /** The retained room snapshot: the display's read model AND what controllers get. */
    val room: RoomSnapshot get() = brainOrNull?.snapshot ?: RoomSnapshot.EMPTY
    val state: RoomState get() = room.state
    val isMuted: Boolean get() = muted

    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + dispatcher)
    private val actions = Channel<Action>(Channel.UNLIMITED)
    private var started = false

    private var engine: EngineBridge? = null
    private var roomCode: String? = null
    private var instance: String? = null

    // The three pause flags. Display-owned INPUTS to the snapshot (the room core projects
    // them into the single `paused` a controller sees), mirrored here because the
    // frame loop reads `paused` every tick and crossing into JS for that is absurd;
    // every write goes through the setters below, so the room core never falls behind.
    private var paused = false
    // Auto-pause (all game participants dropped mid-game) — distinct from a manual/remote
    // pause so a reconnect can auto-resume. Mirrors DisplayGame.js `autoPaused`.
    private var autoPaused = false
    // Set while the DISPLAY's own relay link is down; pauses the running game until we
    // reconnect (controllers are unreachable). Web pauses on link drop too.
    private var connectionPaused = false
    private var muted = false

    private suspend fun setPaused(value: Boolean) { paused = value; roomCore.setPaused(value) }
    private suspend fun setAutoPaused(value: Boolean) { autoPaused = value; roomCore.setAutoPaused(value) }
    private suspend fun setConnectionPaused(value: Boolean) {
        connectionPaused = value
        roomCore.setConnectionPaused(value)
    }

    // True while we are IN the room, not merely holding an open socket. Gates the
    // controller-liveness sweep (see checkLiveness): cleared the moment our link
    // drops, restored only by the relay's `created`/`joined` reply. Starts true so a
    // headless/test coordinator that never feeds link state still sweeps, matching
    // appletv's `relayConnected = true` default.
    private var relayConnected = true
    // Monotonic clock fed to engine.frame(); only deltas matter, so it never needs
    // resetting across games (a fresh game re-primes on its first frame()).
    private var frameClockMs = 0.0
    private var pendingSeed = 0L

    // Which boards currently show a rejoin overlay. The display's own rendering state,
    // and the cheap "was this peer gone?" test on the inbound path (web disconnectedQRs).
    // INVARIANT: this set and the room core's presence set move together — every site that
    // raises or clears a disconnect must touch BOTH, or host election (which reads the
    // roomCore) skips a present player.
    private val disconnectedBoards = HashSet<Int>()

    // Peers heard from since the last liveness tick. Liveness is pulled in one batched
    // roomCore.tick() per second instead of an onSeen crossing per inbound packet: at eight
    // controllers the input path is the hottest thing this coordinator does, and each
    // crossing is an interpolated eval plus a JSON parse.
    private val seenSinceTick = HashSet<Int>()

    // Retained-snapshot throttle (leading + trailing). Window comes from the room core
    // (RoomCore.SNAPSHOT_THROTTLE_MS) so the policy is single-sourced with the web.
    private var snapshotThrottleMs = 500.0
    private var lastSnapshotAt = -1e12
    private var snapshotPending = false

    // Countdown driven by accumulated frame time (deterministic + testable). Step 0
    // ("3") is emitted synchronously by beginCountdown; ticks advance the rest.
    private var countdownElapsed = 0.0
    private var countdownStep = 0 // 0->3, 1->2, 2->1, 3->GO, 4->start

    // Liveness: accumulates tick time to run a ~1 Hz sweep.
    private var livenessAccumMs = 0.0

    // Render-on-input coalescing: true once handleInput has pulled a snapshot
    // since the last tick(), so a message burst costs at most one full
    // serialize + decode + render per frame (see handleInput).
    private var renderedInputSinceTick = false

    // Monotonic source for liveness/grace timing (commonMain-safe).
    private val epoch = TimeSource.Monotonic.markNow()

    // Injectable wall clock (deterministic liveness/grace in tests). Null -> monotonic epoch.
    internal var clock: (() -> Double)? = null

    companion object {
        private const val STEP_MS = 1000.0   // DisplayCoordinator.swift stepMs
        private const val GO_HOLD_MS = 500.0 // goHoldMs (web GO->start setTimeout 500)

        /** constants.js LIVENESS_TIMEOUT_MS — a controller silent this long is gone. */
        private const val LIVENESS_TIMEOUT_MS = 3000.0

        /** constants.js LATE_JOINER_GRACE_MS — how long a late joiner waits for a
         *  fully-dropped match before it returns to the lobby for them. */
        private const val LATE_JOINER_GRACE_MS = 5000.0
    }

    // =====================================================================
    // Action plumbing
    // =====================================================================

    private enum class RemoteKind { START_MATCH, RETURN_TO_LOBBY, TOGGLE_PAUSE, PLAY_PAUSE, TOGGLE_MUTE }

    private sealed interface Action {
        data class Created(val room: String, val instance: String?) : Action
        data class Joined(val room: String, val peers: List<Int>) : Action
        data class PeerJoined(val index: Int) : Action
        data class PeerLeft(val index: Int) : Action
        data class Message(val from: Int, val data: JsonObject) : Action
        data class RelayError(val message: String) : Action
        data class Tick(val deltaMs: Double, val ack: CompletableDeferred<Unit>) : Action
        data class Remote(val kind: RemoteKind, val ack: CompletableDeferred<Boolean>?) : Action
        data class Link(val state: RelayTransport.ConnectionState) : Action
        data class Barrier(val ack: CompletableDeferred<Unit>) : Action
    }

    /** Wire transport + fastlane callbacks and start the single action consumer. */
    fun start() {
        if (started) return
        started = true
        transport.onCreated = { room, instance, _ -> actions.trySend(Action.Created(room, instance)) }
        transport.onJoined = { room, peers -> actions.trySend(Action.Joined(room, peers)) }
        transport.onPeerJoined = { idx -> actions.trySend(Action.PeerJoined(idx)) }
        transport.onPeerLeft = { idx -> actions.trySend(Action.PeerLeft(idx)) }
        transport.onMessage = { from, data -> actions.trySend(Action.Message(from, data)) }
        transport.onRelayError = { msg -> actions.trySend(Action.RelayError(msg)) }
        // Fast-lane: decoded P2P inputs enter the SAME single-consumer queue as relay
        // messages (identical handling); its signaling answers ride the relay back.
        fastlane?.let { fl ->
            fl.onInput = { from, data -> actions.trySend(Action.Message(from, data)) }
            fl.sendSignal = { to, data -> transport.sendTo(to, data) }
        }
        scope.launch { consume() }
        transport.connect()
    }

    /** Cancel the consumer + scope, tear the room down, and disconnect the transport. */
    fun stop() {
        if (!started) return
        // Deliberate exit (BACK out of the app): tear the room down on the relay.
        // Every controller gets a 4001 "room closed" (its terminal party-over
        // signal), and GET /room/:code turns 404 immediately, so stale rejoin
        // links die with the room. Backgrounding (Home) is NOT this path: the
        // Activity suspends the socket instead, and the party survives.
        runCatching { transport.closeRoom() }
        fastlane?.closeAll()
        transport.disconnect()
        actions.close()
        scope.cancel()
    }

    /**
     * Feed the DISPLAY's own relay-link state in (the app already surfaces it for the
     * reconnect overlay). A drop pauses the running game until we reconnect — mirrors the
     * web pausing on its own link loss. Runs on the single consumer so it can't race the FSM.
     */
    fun onLinkStateChanged(state: RelayTransport.ConnectionState) {
        actions.trySend(Action.Link(state))
    }

    private suspend fun consume() {
        // Room state exists before the JS runtime does: the relay's created/joined and
        // peer_joined land while the bundle is still being read and compiled. Since the
        // roomCore lives in that runtime, build it FIRST and let the actions queue in the
        // (unlimited) channel behind it — a queued room event is correct, a room event
        // handled without a room core is not. Unlike the per-match engine this happens once
        // per session; the room core then survives every match.
        try {
            val bridge = bridgeProvider()
            brainOrNull = RoomCoreClient.create(bridge, roomOptions())
            snapshotThrottleMs = roomCore.snapshotThrottleMs()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // Without a room core there is no room and nothing this display can usefully do.
            // Report it, then keep DRAINING: tick() and the remote actions wait on an ack,
            // so a consumer that simply stopped would freeze the render loop instead of
            // failing visibly. Draining keeps the app responsive on a dead room.
            onError("roomInit", e)
            for (action in actions) ack(action)
            return
        }
        for (action in actions) {
            try {
                when (action) {
                    is Action.Created -> handleCreated(action.room, action.instance)
                    is Action.Joined -> handleJoined(action.room, action.peers)
                    is Action.PeerJoined -> onPeerJoined(action.index)
                    is Action.PeerLeft -> onPeerLeft(action.index)
                    is Action.Message -> onMessage(action.from, action.data)
                    is Action.RelayError -> onRelayError(action.message)
                    is Action.Tick -> try {
                        tickLocked(action.deltaMs)
                    } finally {
                        action.ack.complete(Unit)
                    }
                    is Action.Link -> onLinkState(action.state)
                    is Action.Barrier -> action.ack.complete(Unit)
                    is Action.Remote -> {
                        var result = false
                        try {
                            result = handleRemote(action.kind)
                        } finally {
                            action.ack?.complete(result)
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Keep the consumer alive: a parse/engine error must not stop the loop.
                onError(action::class.simpleName ?: "action", e)
            }
        }
    }

    /** Complete whatever an action's caller is waiting on, without doing its work. */
    private fun ack(action: Action) {
        when (action) {
            is Action.Tick -> action.ack.complete(Unit)
            is Action.Barrier -> action.ack.complete(Unit)
            is Action.Remote -> action.ack?.complete(false)
            else -> {}
        }
    }

    /** RoomCore constructor options. maxPlayers is deliberately omitted: the room core
     *  defaults it from the bundle's own constants.js, so the room cap is not mirrored
     *  here at all. Liveness is injected because the shell owns no timing policy. */
    private fun roomOptions(): JsonObject = buildJsonObject {
        putJsonObject("liveness") {
            put("timeoutMs", LIVENESS_TIMEOUT_MS)
            put("graceMs", LATE_JOINER_GRACE_MS)
        }
    }

    /** Drive one frame. The render loop calls this every display tick with the real delta. */
    suspend fun tick(deltaMs: Double) {
        val ack = CompletableDeferred<Unit>()
        // trySend (the channel is UNLIMITED, so this only fails when it is closed): a tick
        // racing stop() is dropped rather than throwing ClosedSendChannelException.
        if (actions.trySend(Action.Tick(deltaMs, ack)).isSuccess) ack.await()
    }

    /** Suspend until every action enqueued so far has been processed (testing/UI sync). */
    suspend fun awaitIdle() {
        val ack = CompletableDeferred<Unit>()
        if (actions.trySend(Action.Barrier(ack)).isSuccess) ack.await()
    }

    // =====================================================================
    // Connection lifecycle
    // =====================================================================

    private fun handleCreated(code: String, instance: String?) {
        this.roomCode = code
        this.instance = instance
        // A fresh room means an empty roster, so there is nothing to re-stamp — but the
        // sweep must come back on, or the room-gone recovery path (error -> createFresh)
        // would leave liveness off for the rest of the session.
        relayConnected = true
        output.roomReady(code, joinUrl(code, instance))
        output.showScreen(DisplayScreen.LOBBY)
    }

    private suspend fun handleJoined(code: String, peers: List<Int>) {
        // The DISPLAY's own relay reconnect: reconcile the roster and republish.
        this.roomCode = code
        // Re-confirm the lobby QR: the link was down (QR untrusted, rendered dimmed)
        // and this `joined` proves the room survived, so the same code + QR are valid
        // again. The room-gone path re-confirms via handleCreated instead.
        output.roomReady(code, joinUrl(code, instance))
        // Re-stamp liveness for surviving peers, collecting the gone ones for onPeerLeft.
        // Mirrors onDisplayRejoined: a survivor whose last ping predates the display's link
        // drop must not be expired by the first liveness tick after reconnect, so refresh
        // presence for every peer still in the relay's list. Peers absent from that list are
        // gone, routed through the state-aware onPeerLeft (removes in LOBBY/RESULTS, keeps +
        // disconnect-overlay mid-game). Snapshot first: onPeerLeft mutates the roster.
        val now = nowWallMs()
        val gone = mutableListOf<Int>()
        for (id in room.players.keys) {
            if (id in peers) roomCore.onSeen(id, now) else gone.add(id)
        }
        for (id in gone) onPeerLeft(id)
        // Only NOW is the sweep safe to re-arm: until this reply the relay dropped
        // everything addressed to us, so every lastSeen was stale through no fault of the
        // controllers. Gating on socket-OPEN instead left a hole — the re-stamp there buys
        // exactly LIVENESS_TIMEOUT_MS, but the handshake deadline is twice that, so a slow
        // `joined` expired the whole roster. The loop above re-stamped the survivors, which
        // is strictly better than a blanket prime: it skips the peers the relay no longer
        // lists, and those just went through onPeerLeft. Web ties its re-stamp to the same
        // reply (onDisplayRejoined).
        relayConnected = true
        // The link-drop pause lifts here — after the roster reconcile above (so resumeGame's
        // allParticipantsDisconnected guard sees post-reconcile truth) and BEFORE the
        // publish below, because the snapshot reports `paused` and that is the controller's
        // authority. Resuming afterwards made every rejoin snapshot say paused=true and then
        // chase it with a second publish; a controller that latched the first and missed the
        // second was stranded on a pause overlay whose Continue cannot help, since
        // resumeGame() is gated on a manual pause and the display is no longer paused at all.
        if (connectionPaused) {
            setConnectionPaused(false)
            resumeGame()
        }
        // One publish replaces the per-survivor re-welcome fanout: the relay replays the
        // retained snapshot to every peer that (re)joins anyway, so this is what clears
        // their reconnect overlay and their display-gone bail timer.
        publishRoomSnapshot()
    }

    private suspend fun onPeerJoined(index: Int) {
        // The room core allocates the colour slot, invents the placeholder auto-name (with
        // helloSeen=false, so the joiner's own controller waits for its HELLO instead of
        // rendering a guessed identity), and decides whether this is a lobby member or a
        // late joiner waiting out the round. It refuses silently on a duplicate — an
        // in-session reconnect lands on the SAME relay slot, so the relay re-emits
        // peer_joined for a peer we already know, and re-registering would overwrite the
        // kept name/colour and, in a full room, bounce a legitimately returning player.
        val res = roomCore.peerJoined(index, nowWallMs())
        if (!res.added) return
        publishAs(res.publish)
    }

    private suspend fun onPeerLeft(index: Int) {
        fastlane?.close(index) // the P2P link died with the controller; it re-offers on reconnect
        // The room core owns the branch: mid-game an active participant keeps their row (so the
        // slot stays pinned for a cross-device reclaim), while a late joiner and anyone
        // leaving in lobby/results is dropped outright, with the sticky-host handoff and the
        // empty-results return to lobby decided inside.
        val res = roomCore.peerLeft(index)
        if (!res.known) return
        if (res.action == "disconnected") {
            showDisconnectBoard(index) // keeps the slot pinned for a seamless reconnect
            checkAllParticipantsDisconnected()
        } else {
            disconnectedBoards.remove(index)
            output.setDisconnected(index, null)
        }
        if (res.returnedToLobby) returnToLobbyUi()
        // Unconditional in every branch: someone is gone, the host may have moved, and a
        // mid-game departure flips that player's `alive` for the remaining boards. It also
        // covers the last-player-leaves case, where the retained snapshot must stop naming a
        // departed player (and a stale host) to the next peer that joins.
        publishAs(res.publish)
    }

    /**
     * 1 Hz liveness sweep: a controller silent past LIVENESS_TIMEOUT_MS is only marked
     * disconnected and shown a per-board rejoin QR, NOT removed from the roster. Mirrors
     * DisplayLiveness.js; the heavier roster-removal path (onPeerLeft) is reserved for a
     * real relay peer_left. The room core gates out the LOBBY and already-disconnected peers;
     * a controller that pings again is reconnected in [onMessage].
     */
    private suspend fun checkLiveness() {
        // Skip the sweep while the display's OWN link is down: no controller traffic
        // can arrive, so every lastSeen is stale through no fault of the controllers.
        // Without this a recoverable display outage flags the whole roster and, with a
        // late joiner waiting, grace-returns the match to the lobby. Web gets the same
        // effect from DisplayLiveness's `joinedRoom` early-return.
        if (!relayConnected) {
            seenSinceTick.clear()
            return
        }
        val res = roomCore.tick(nowWallMs(), seenSinceTick.toList())
        seenSinceTick.clear()
        if (res.expired.isNotEmpty()) {
            for (id in res.expired) showDisconnectBoard(id)
            checkAllParticipantsDisconnected() // no-ops outside PLAYING; arms grace / auto-pauses
            // A silent heartbeat timeout can take out the host — republish so the handoff
            // reaches the remaining controllers.
            publishRoomSnapshot()
        }
        // The late-joiner grace deadline (armed on the event path by
        // checkAllParticipantsDisconnected) fired: return to the lobby for them.
        if (res.graceFired) returnToLobby()
    }

    /**
     * Fold the batched `seen` set in before anything OUTSIDE the 1 Hz sweep reads
     * presence timing (the prune paths). Without it a controller that spoke since the
     * last tick still looks silent, and starting a match would drop it.
     */
    private suspend fun flushSeen() {
        if (seenSinceTick.isEmpty()) return
        val now = nowWallMs()
        for (id in seenSinceTick) roomCore.onSeen(id, now)
        seenSinceTick.clear()
    }

    /** Raise a per-board rejoin overlay and flag the peer absent. The overlay set and the
     *  room core's presence set MUST move together; this is the only place that raises both. */
    private suspend fun showDisconnectBoard(peerIndex: Int) {
        fastlane?.close(peerIndex) // the P2P link died with the controller; it re-offers
        disconnectedBoards.add(peerIndex)
        roomCore.markDisconnected(peerIndex)
        output.setDisconnected(peerIndex, rejoinUrl(peerIndex))
    }

    /**
     * All game participants dropped mid-game: return to lobby if the late-joiner grace
     * window has fired, else silently auto-pause (no overlay, nothing published — every
     * controller is gone). Port of DisplayGame.js `checkAllPlayersDisconnected`.
     */
    private suspend fun checkAllParticipantsDisconnected() {
        if (state != RoomState.PLAYING) return // don't auto-pause during COUNTDOWN
        if (!roomCore.allParticipantsDisconnected()) return
        // graceTick both arms and (once the window elapses) fires. Honour a fire here as
        // well as in the sweep: an event landing on/after the deadline between polls would
        // otherwise slip a full window.
        if (roomCore.graceTick(nowWallMs())) { returnToLobby(); return }
        if (paused) {
            // Already manually paused when the last player dropped: convert the
            // manual pause into a silent auto-pause and hide the stranded overlay.
            // resumeGame is gated shut while everyone is gone, so a manual pause
            // left showing could never be dismissed. A reconnect auto-resumes.
            if (!autoPaused) {
                setAutoPaused(true)
                output.setPaused(false)
                // userVisiblePaused just flipped true -> false: returning players must not
                // be handed a pause overlay whose Continue the display would ignore.
                publishRoomSnapshot()
            }
            return
        }
        // Silent pause: the composite stays invisible to controllers (userVisiblePaused is
        // false while autoPaused), so there is nothing to publish.
        setPaused(true)
        setAutoPaused(true)
        engine?.pause()
        engine?.resetFrameClock()
        output.pauseMusic()
    }

    /** A participant reconnected while auto-paused: resume. Port of `checkAutoResume`. */
    private suspend fun checkAutoResume() {
        if (!autoPaused) return
        setAutoPaused(false)
        resumeGame()
    }

    /**
     * The display's own relay link state. On a drop, pause the running game (controllers
     * are unreachable, so nothing can be published). The resume lives in [handleJoined], not
     * here: OPEN fires at raw-socket-open, before the relay has processed our join, so
     * resuming (and publishing) now could race ahead of the roster reconciliation and be
     * dropped server-side. The web equivalent (onDisplayRejoined) also resumes only after
     * the relay's `joined` reply. Re-arming the liveness sweep waits for the same reply,
     * for the same reason: see [relayConnected].
     */
    private suspend fun onLinkState(state: RelayTransport.ConnectionState) {
        when (state) {
            RelayTransport.ConnectionState.RECONNECTING, RelayTransport.ConnectionState.CLOSED -> {
                relayConnected = false
                val active = this.state == RoomState.PLAYING || this.state == RoomState.COUNTDOWN
                if (active && !paused) {
                    setPaused(true)
                    setConnectionPaused(true)
                    if (this.state == RoomState.PLAYING) { // COUNTDOWN: the engine isn't ticking yet
                        engine?.pause()
                        engine?.resetFrameClock()
                    }
                    output.pauseMusic()
                }
            }
            // OPEN is deliberately NOT the point the liveness sweep resumes — see
            // [relayConnected], re-armed in handleCreated/handleJoined instead.
            else -> {}
        }
    }

    // =====================================================================
    // Inbound messages
    // =====================================================================

    private suspend fun onMessage(from: Int, data: JsonObject) {
        // Fast-lane signaling (offer/ice) rides the relay tagged with __rtc — hand it to the
        // fastlane and stop (it isn't an app message). Decoded P2P inputs re-enter as messages.
        if (fastlane != null && Fastlane.isSignal(data)) {
            fastlane.handleSignal(from, data)
            return
        }
        val msg = ControllerMessage.from(data) ?: return
        // Any message proves the sender is alive. Batched: the 1 Hz sweep folds this set
        // into roomCore.tick(), which stamps presence before it decides who expired.
        seenSinceTick.add(from)
        val wasDisconnected = disconnectedBoards.remove(from)
        if (wasDisconnected) {
            roomCore.markReconnected(from)
            output.setDisconnected(from, null) // clear the rejoin overlay
        }
        when (msg.type) {
            Msg.HELLO -> handleHello(from, msg)
            Msg.INPUT -> handleInput(from, msg)
            Msg.SOFT_DROP -> if (state == RoomState.PLAYING && !paused) engine?.softDropStart(from, msg.speed?.toInt())
            Msg.SOFT_DROP_END -> if (state == RoomState.PLAYING) engine?.softDropEnd(from)
            Msg.START_GAME -> if (state == RoomState.LOBBY && room.size >= 1) beginCountdown()
            Msg.PLAY_AGAIN -> if (state == RoomState.RESULTS && room.size >= 1) beginCountdown()
            Msg.RETURN_TO_LOBBY -> returnToLobby()
            Msg.PAUSE_GAME -> pauseGame()
            Msg.RESUME_GAME -> resumeGame()
            Msg.LEAVE -> onPeerLeft(from)
            Msg.SET_LEVEL -> handleSetLevel(from, msg)
            Msg.SET_COLOR -> handleSetColor(from, msg)
            Msg.SET_NAME -> handleSetName(from, msg)
            Msg.SET_DISPLAY_MUTE -> handleSetMute(from, msg)
            Msg.PING -> transport.sendTo(from, OutboundMessage.pong(msg.t))
            else -> {}
        }
        // Auto-resume AFTER processing, so the reconnecting controller has already been sent
        // a snapshot describing the paused game before the resume publishes over the top of
        // it. markReconnected above already cleared the presence flag, so the next graceTick
        // drops the late-joiner deadline; no explicit cancel needed.
        if (wasDisconnected && room.isParticipant(from)) checkAutoResume()
    }

    private suspend fun handleHello(from: Int, msg: ControllerMessage) {
        // Everything a HELLO decides lives in the room core: the sanitized name (empty and
        // legacy P1-P8 submissions resolving to room-unique HX names), the preferred colour
        // (honoured right away, so the snapshot below already names the colour the
        // controller will keep), whether a cross-device rejoin claim is valid, and whether
        // the room is full.
        val res = roomCore.hello(from, helloBody(msg), nowWallMs())
        // The room half of a claim moved inside the room core; the game half is ours.
        if (res.claimed) res.oldPeerIndex?.let { applyReconnectClaim(it, from) }
        if (!res.accepted) {
            if (res.roomFull) transport.sendTo(from, OutboundMessage.error("Room is full"))
            return
        }
        // One publish settles everything a HELLO can move: this controller's own identity
        // (name, colour, level), the roster the others render, and the host, since a
        // reconnecting ex-host reclaims the role their pinned slot held through the
        // disconnect. A brand-new joiner needs it too: it is how they learn who they are
        // and which screen to show.
        publishAs(res.publish)
        if (res.claimed) checkAutoResume()
    }

    /** The HELLO body the room core reads. `claim` (from the rejoin QR) and the legacy
     *  `rejoinId` are normalized onto `rejoinToken`, which is what it looks for. */
    private fun helloBody(msg: ControllerMessage): JsonObject = buildJsonObject {
        msg.name?.let { put("name", it) }
        msg.autoName?.let { put("autoName", it) }
        msg.colorIndex?.let { put("colorIndex", it) }
        (msg.rejoinToken ?: msg.rejoinId ?: msg.claim)?.let { put("rejoinToken", it) }
    }

    /**
     * Finish a cross-device rejoin the room core has already accepted: everything keyed by peer
     * index that lives OUTSIDE the room (the P2P link, the rejoin overlays, the engine's
     * boards) moves from the old index to the new one. The room half (roster record, sticky
     * host slot, participant order, alive flags, cached ranking) moved inside the room core.
     */
    private suspend fun applyReconnectClaim(oldId: Int, newId: Int) {
        fastlane?.close(oldId) // drop the dropped device's P2P link; the returning device re-offers
        engine?.let { runCatching { it.rekey(oldId, newId) } } // no engine in RESULTS (roster-only claim)
        disconnectedBoards.remove(oldId)
        disconnectedBoards.remove(newId)
        output.setDisconnected(oldId, null) // clear the dropped board's rejoin overlay
        output.setDisconnected(newId, null)
    }

    private suspend fun handleInput(from: Int, msg: ControllerMessage) {
        if (state != RoomState.PLAYING || paused) return
        val action = msg.action ?: return
        val input = InputAction.fromWire(action) ?: return
        val e = engine ?: return
        e.processInput(from, input)
        // Render-on-input: reflect the applied input on the very next vsync instead of
        // waiting for the next frame() tick. snapshot() is a pure read (getSnapshot deep-copy,
        // no time advance), so this only front-runs the VISUAL; this frame's events/commands
        // (lock flash, garbage, sends) still flow on the next frame(). Guarded to PLAYING above.
        // Coalesced to one pull per frame (tvOS parity): each snapshot() is a full
        // serialize + decode, and an 8-player input burst can land several messages
        // inside one 16 ms window. Later inputs ride the tick's own snapshot.
        if (renderedInputSinceTick) return
        val snap = try { e.snapshot() } catch (t: Throwable) { onError("inputSnapshot", t); return }
        renderedInputSinceTick = true
        output.renderSnapshot(snap)
    }

    private suspend fun handleSetLevel(from: Int, msg: ControllerMessage) {
        val res = roomCore.setLevel(from, msg.level)
        if (!res.changed) return
        if (state == RoomState.LOBBY) refreshDisplayLobby()
        // Held-finger control: the room core's 'soon' hint routes this through the throttle, so
        // a burst of +/- taps collapses to ~2 publishes per second with the trailing one
        // carrying the final level. Outside the lobby the stepper is unreachable ('none').
        publishAs(res.publish)
    }

    private suspend fun handleSetColor(from: Int, msg: ControllerMessage) {
        // The room core silently rejects collisions so concurrent picks don't spam the sender
        // with errors; the next snapshot carries the truth.
        val res = roomCore.setColor(from, msg.colorIndex)
        if (!res.changed) return
        refreshDisplayLobby()
        publishAs(res.publish)
    }

    private suspend fun handleSetName(from: Int, msg: ControllerMessage) {
        // Allowed in every state, including mid-game (web onSetName): it only relabels the
        // player and never touches game state.
        val res = roomCore.setName(from, msg.name)
        if (!res.changed) return
        refreshDisplayLobby()
        publishAs(res.publish)
    }

    private suspend fun handleSetMute(from: Int, msg: ControllerMessage) {
        if (from != room.hostPeerIndex) return // host-only: the display's music is shared
        muted = (msg.muted == true)
        val res = roomCore.setMuted(muted)
        output.setMuted(muted) // actually silence/restore the TV music
        publishAs(res.publish)
    }

    // =====================================================================
    // Countdown + game
    // =====================================================================

    private suspend fun beginCountdown() {
        if (state != RoomState.LOBBY && state != RoomState.RESULTS) return
        // Mirrors startNewGame's ordering: drop everyone who went missing (including a peer
        // that dropped right as RESULTS appeared, before peer_left or the sweep flagged it),
        // clear the overlays, then re-stamp presence on this "everyone present" transition
        // so a controller that went quiet just before the match isn't instantly flagged.
        flushSeen()
        roomCore.clearAlive()
        roomCore.pruneDisconnected(nowWallMs())
        disconnectedBoards.clear()
        roomCore.clearDisconnected(nowWallMs())
        // Everyone who remained was disconnected: don't build a zero-player engine.
        if (room.size == 0) {
            // The prune changed the roster controllers render, so publish either way.
            if (state == RoomState.RESULTS) returnToLobby() else publishRoomSnapshot()
            return
        }
        // Fold in the late joiners who sat out the previous round.
        roomCore.admitWaiting()
        val transition = roomCore.transitionTo(RoomState.COUNTDOWN)
        if (!transition.changed) return
        // Publishes, and that is the whole countdown protocol now: controllers learn they
        // are counting down from snapshot.roomState (which dims their pad) and learn the
        // game is live from the COUNTDOWN -> PLAYING transition. The digits stay local.
        publishAs(transition.publish)
        // Board-layout order (join order, first joiner leftmost), pinned as the active set.
        val order = roomCore.freezeParticipantOrder()
        pendingSeed = seedProvider()
        setPaused(false)
        setAutoPaused(false)
        setConnectionPaused(false)
        countdownElapsed = 0.0
        if (!makeEngine(order)) {
            returnToLobby()
            return
        }
        // Empty boards behind the 3-2-1 overlay: the web nulls its render state during
        // COUNTDOWN so pieces/ghost appear only at GO. showScreen(GAME) resets the boards;
        // the first snapshot renders once PLAYING ticks.
        output.showScreen(DisplayScreen.GAME)
        // Step 0 ("3") fires synchronously with the screen switch, so the first GAME frame
        // already carries the countdown overlay instead of flashing bare boards.
        emitCountdownStep(0)
    }

    private suspend fun makeEngine(order: List<Int>): Boolean {
        val specs = order.map { EngineBridge.PlayerSpec(it, room.player(it)?.startLevel ?: 1) }
        return try {
            engine = bridgeProvider().also { it.createGame(specs, pendingSeed) }
            true
        } catch (e: Throwable) {
            onError("makeEngine", e)
            false
        }
    }

    private suspend fun startPlaying() {
        // Publishes: this is what moves controllers off the countdown-dimmed pad and arms
        // their touch input.
        publishAs(roomCore.transitionTo(RoomState.PLAYING).publish)
        // If everyone dropped during COUNTDOWN the match must pause (or return to lobby via
        // the grace window) instead of starting unpaused and playing itself out.
        checkAllParticipantsDisconnected()
    }

    private suspend fun tickLocked(rawDelta: Double) {
        renderedInputSinceTick = false // new frame: re-arm render-on-input
        // Only sanitize negatives/NaN here; do NOT clamp to MAX_FRAME_DELTA_MS.
        // The engine's frame() applies that cap itself (per its contract), and the
        // countdown must advance by real elapsed time (a 1000ms tick is one second
        // of countdown, not 50ms).
        val deltaMs = if (rawDelta.isFinite()) rawDelta.coerceAtLeast(0.0) else 0.0
        flushPendingSnapshot() // trailing edge of the set_state throttle
        livenessAccumMs += deltaMs
        if (livenessAccumMs >= 1000.0) {
            livenessAccumMs = 0.0
            checkLiveness()
        }
        when (state) {
            RoomState.COUNTDOWN -> advanceCountdown(deltaMs)
            RoomState.PLAYING -> {
                if (paused) return
                val e = engine ?: return
                frameClockMs += deltaMs
                val frame = try {
                    e.frame(frameClockMs)
                } catch (t: Throwable) {
                    onError("frame", t)
                    return
                }
                for (ev in frame.events) output.handleGameEvent(ev) // board animations
                // Omitted (null) when the frame is render-identical to the last
                // delivered one (shim scene signature): keep the retained snapshot
                // instead of re-rendering a pixel-identical full screen.
                frame.snapshot?.let { output.renderSnapshot(it) }
                dispatchCommands(frame.commands) // host effects -> sends + match end
            }
            RoomState.LOBBY, RoomState.RESULTS -> {}
        }
    }

    private suspend fun advanceCountdown(deltaMs: Double) {
        if (paused) return // a mid-countdown pause freezes the count (web clearCountdownTimers)
        countdownElapsed += deltaMs
        val nextStep = countdownStep + 1
        val threshold = if (nextStep <= 3) nextStep * STEP_MS else 3 * STEP_MS + GO_HOLD_MS
        if (countdownElapsed >= threshold) emitCountdownStep(nextStep)
    }

    private suspend fun emitCountdownStep(step: Int) {
        countdownStep = step
        when (step) {
            0 -> {
                output.showCountdown(CountdownValue.Number(3))
                output.playCountdownBeep(false)
            }
            1 -> {
                output.showCountdown(CountdownValue.Number(2))
                output.playCountdownBeep(false)
            }
            2 -> {
                output.showCountdown(CountdownValue.Number(1))
                output.playCountdownBeep(false)
            }
            3 -> {
                output.showCountdown(CountdownValue.Go)
                output.playCountdownBeep(true)
                // Start even while muted: MusicPlayer.start() runs the loop at volume 0, so a
                // later unmute is instantly audible (web keeps the graph running when muted).
                output.startMusic()
            }
            else -> startPlaying()
        }
    }

    /** Map the frame's normalized host-effect commands to controller sends + match end. */
    private suspend fun dispatchCommands(commands: List<Command>) {
        for (c in commands) {
            when (c.type) {
                CommandType.PLAYER_STATE -> {
                    val pid = c.playerId ?: continue
                    // Targeted, and NOT room state: it is what fires a controller's own
                    // level/lines HUD and its KO overlay the instant either happens.
                    if (c.level != null && c.lines != null && c.alive != null) {
                        transport.sendTo(pid, OutboundMessage.playerState(c.level, c.lines, c.alive, c.garbageIncoming ?: 0))
                    } else if (c.alive == false) {
                        transport.sendTo(pid, OutboundMessage.playerDead()) // short form after KO
                    }
                }
                CommandType.PLAYER_ELIMINATED -> c.playerId?.let {
                    // The snapshot's per-player `alive` is what a controller reconnecting
                    // right after a KO reads, so it lands on the dead board; that plus the
                    // targeted player_state above is why the game_over unicast could go.
                    publishAs(roomCore.setAlive(it, false).publish)
                }
                CommandType.GAME_END -> endGame(c.results ?: emptyList())
                else -> {
                    // pieceLock / lineClear / playerKO / garbageCancelled / garbageSent are rendered
                    // from events.
                }
            }
        }
    }

    private suspend fun endGame(results: List<PlayerResult>) {
        // Clear the pause flags first: the RESULTS publish below reports `paused`, and a
        // match that ended while flagged must not hand controllers a stale pause.
        setPaused(false)
        setAutoPaused(false)
        setConnectionPaused(false)
        // Label the ranking with roster names/colours and append the players who sat this
        // round out (flagged newPlayer), then stash it BEFORE the transition: the transition
        // publishes, and the RESULTS snapshot is what carries the ranking to controllers.
        val enriched = roomCore.enrichResults(rankingJson(results))
        roomCore.setResults(enriched)
        publishAs(roomCore.transitionTo(RoomState.RESULTS).publish)
        output.stopMusic()
        output.setPaused(false) // MUST precede showResults (clears the focus menu)
        output.showResults(decodeResults(enriched))
        output.showScreen(DisplayScreen.RESULTS)
        engine = null
    }

    private suspend fun returnToLobby() {
        if (state == RoomState.LOBBY) return
        setPaused(false)
        setAutoPaused(false)
        setConnectionPaused(false)
        engine = null
        output.stopMusic()
        output.setPaused(false)
        // Remove the players who went missing, then fold in the late joiners who were
        // waiting out the round.
        flushSeen()
        roomCore.pruneDisconnected(nowWallMs())
        roomCore.admitWaiting()
        roomCore.clearAlive()
        roomCore.setResults(null)
        // Publishes: controllers see roomState back at LOBBY and route themselves there,
        // which is what the RETURN_TO_LOBBY broadcast used to do.
        val res = roomCore.transitionTo(RoomState.LOBBY)
        returnToLobbyUi()
        publishAs(res.publish)
    }

    /** The display-side half of a lobby return (also used when the room core returns to the
     *  lobby by itself, on the last participant leaving RESULTS). */
    private suspend fun returnToLobbyUi() {
        disconnectedBoards.clear()
        roomCore.clearDisconnected(nowWallMs())
        output.showScreen(DisplayScreen.LOBBY)
    }

    /**
     * Relay protocol error. Port of the web's `error` case (DisplayConnection.js):
     * "Room not found" / "Room is full" after a display rejoin means the relay lost our
     * room while our link was down — the code on screen is dead (controllers get "Room
     * not found") and every roster entry is unreachable. The web resets to WELCOME and
     * creates a fresh room; the TV has no welcome screen, so reset straight to a
     * fresh-room lobby. Any other relay error is non-fatal (the web just warns).
     */
    private suspend fun onRelayError(message: String) {
        if (message != "Room not found" && message != "Room is full") return
        resetSession()
    }

    /** Full session reset + a fresh room (web resetToWelcome -> connectAndCreateRoom). */
    private suspend fun resetSession() {
        engine = null
        fastlane?.closeAll()
        output.stopMusic()
        output.setPaused(false)
        roomCode = null
        instance = null
        disconnectedBoards.clear()
        // Roster, participants, liveness, results, the pause flags and the room state, all
        // back to a fresh room. Mute survives (a device preference, not room state).
        roomCore.reset()
        paused = false
        autoPaused = false
        connectionPaused = false
        output.showScreen(DisplayScreen.LOBBY)
        refreshDisplayLobby()
        transport.createFresh() // handleCreated re-arms the room code + QR when `created` lands
    }

    /** Manual pause; allowed while PLAYING or mid-COUNTDOWN (web pauseGame). During
     *  COUNTDOWN the engine isn't ticking yet, so freezing [advanceCountdown] via
     *  [paused] is the whole freeze (web clearCountdownTimers). */
    private suspend fun pauseGame() {
        if (paused || (state != RoomState.PLAYING && state != RoomState.COUNTDOWN)) return
        setPaused(true)
        if (state == RoomState.PLAYING) {
            engine?.pause()
            engine?.resetFrameClock() // forget the frame clock so resume re-primes with delta 0
        }
        output.pauseMusic()
        output.setPaused(true)
        // userVisiblePaused may still be false here (a connection- or auto-pause is
        // display-internal); publishing either way keeps the snapshot honest.
        publishRoomSnapshot()
    }

    private suspend fun resumeGame() {
        if (!paused || (state != RoomState.PLAYING && state != RoomState.COUNTDOWN)) return
        if (roomCore.allParticipantsDisconnected()) return // web canResumeGame
        if (autoPaused) setAutoPaused(false)
        setConnectionPaused(false)
        setPaused(false)
        if (state == RoomState.COUNTDOWN) {
            // Web resume (startCountdown(callback, remaining)): the current number stays on
            // screen without a re-broadcast/beep and gets its FULL second again; a shown GO
            // re-arms the full 500ms hold. In the accumulator model that is a rewind to the
            // current step's start.
            if (countdownStep >= 0) countdownElapsed = countdownStep * STEP_MS
        } else {
            engine?.resume()
        }
        if (!muted) output.resumeMusic()
        output.setPaused(false)
        publishRoomSnapshot()
    }

    // =====================================================================
    // Remote controls (Android TV D-pad / play-pause)
    // =====================================================================

    fun remoteStartMatch() {
        actions.trySend(Action.Remote(RemoteKind.START_MATCH, null))
    }

    fun remoteReturnToLobby() {
        actions.trySend(Action.Remote(RemoteKind.RETURN_TO_LOBBY, null))
    }

    suspend fun remoteTogglePause() {
        val ack = CompletableDeferred<Boolean>()
        if (actions.trySend(Action.Remote(RemoteKind.TOGGLE_PAUSE, ack)).isSuccess) ack.await()
    }

    fun remotePlayPause() {
        actions.trySend(Action.Remote(RemoteKind.PLAY_PAUSE, null))
    }

    /** Toggle the display's own music mute; returns the new muted state. */
    suspend fun remoteToggleMute(): Boolean {
        val ack = CompletableDeferred<Boolean>()
        return if (actions.trySend(Action.Remote(RemoteKind.TOGGLE_MUTE, ack)).isSuccess) ack.await() else false
    }

    private suspend fun handleRemote(kind: RemoteKind): Boolean = when (kind) {
        RemoteKind.START_MATCH -> {
            if ((state == RoomState.LOBBY || state == RoomState.RESULTS) && room.size >= 1) beginCountdown()
            muted
        }
        RemoteKind.RETURN_TO_LOBBY -> {
            if (state != RoomState.LOBBY) returnToLobby()
            muted
        }
        RemoteKind.TOGGLE_PAUSE -> {
            if (state == RoomState.PLAYING || state == RoomState.COUNTDOWN) {
                if (paused) resumeGame() else pauseGame()
            }
            paused
        }
        RemoteKind.PLAY_PAUSE -> {
            when (state) {
                RoomState.LOBBY, RoomState.RESULTS -> if (room.size >= 1) beginCountdown()
                RoomState.COUNTDOWN, RoomState.PLAYING -> if (paused) resumeGame() else pauseGame()
            }
            muted
        }
        RemoteKind.TOGGLE_MUTE -> {
            muted = !muted
            val res = roomCore.setMuted(muted)
            output.setMuted(muted)
            publishAs(res.publish)
            muted
        }
    }

    // =====================================================================
    // Publishing the retained room snapshot
    // =====================================================================

    /**
     * Apply a mutator's publish hint, so call sites read as "do the thing, then honour
     * the hint". WHICH call takes which path is the room core's decision, not this file's:
     * every mutator returns 'now', 'soon' or 'none', and the web display and Apple TV
     * read the same hints. Only the timer is per-shell, because a timer needs a real
     * clock and the room core has none.
     */
    private suspend fun publishAs(hint: String) {
        when (hint) {
            RoomCoreClient.PUBLISH_NOW -> publishRoomSnapshot()
            RoomCoreClient.PUBLISH_SOON -> publishRoomSnapshotSoon()
        }
    }

    /**
     * Rapid, self-correcting roster churn (the +/- level stepper, the colour rose):
     * leading + trailing. The first change after a quiet period goes out immediately (the
     * controller's picker overlay closes on the display's echo, so it must not feel laggy),
     * and everything inside the window collapses into one trailing publish that reads live
     * state at fire time, so the latest value always wins. The tick loop drives the
     * trailing edge, so while backgrounded it fires on the next frame.
     */
    private suspend fun publishRoomSnapshotSoon() {
        if (nowWallMs() - lastSnapshotAt >= snapshotThrottleMs) publishRoomSnapshot()
        else snapshotPending = true
    }

    /**
     * Publish now, superseding any pending throttled publish. This is the ONLY thing the
     * display tells controllers about the room: the relay pushes the snapshot live to
     * everyone connected AND replays it to a (re)joining peer right after `joined`, so the
     * live-update path and the resync-after-a-blip path are the same code and cannot
     * disagree with each other.
     */
    private suspend fun publishRoomSnapshot() {
        snapshotPending = false
        lastSnapshotAt = nowWallMs()
        // The room moved, so the TV's own chrome moves with it: the roster card and the
        // host tint the results/pause overlays read. Mirrors the web publishRoomState
        // calling applyHostTint before it hands the snapshot to the relay.
        refreshDisplayLobby()
        // Built by RoomCore, byte-identically on the web and Apple TV: that is the point.
        transport.setState(roomCore.snapshotJson)
    }

    /** Fire a pending trailing snapshot once the throttle window has elapsed. */
    private suspend fun flushPendingSnapshot() {
        if (!snapshotPending) return
        if (nowWallMs() - lastSnapshotAt < snapshotThrottleMs) return
        publishRoomSnapshot()
    }

    /** Rebuild the display's own lobby UI. The roster comes from the room core's `list()`
     *  rather than the snapshot: the lobby sorts by join order and the snapshot, keyed by
     *  peer index, deliberately carries neither joinedAt nor connected. */
    private suspend fun refreshDisplayLobby() {
        output.updateLobby(roomCore.list(), room.hostPeerIndex)
    }

    // =====================================================================
    // Results marshalling
    // =====================================================================

    /** The raw ranking as the room core's enrichResults expects it (the engine's own fields;
     *  playerName/colorIndex/newPlayer are what it adds). */
    private fun rankingJson(results: List<PlayerResult>): JsonArray = buildJsonArray {
        for (r in results) {
            add(
                buildJsonObject {
                    put("playerId", r.playerId)
                    put("rank", r.rank)
                    put("lines", r.lines)
                    put("level", r.level)
                    put("alive", r.alive)
                },
            )
        }
    }

    private fun decodeResults(enriched: JsonArray): List<ResultEntry> =
        EngineJson.json.decodeFromJsonElement<List<ResultEntry>>(enriched)

    // =====================================================================
    // Helpers
    // =====================================================================

    private fun joinUrl(code: String, instance: String?): String {
        val frag = instance?.takeIf { it.isNotEmpty() }?.let { "#$it" } ?: ""
        return "${RelayConfig.CONTROLLER_BASE_URL}/$code$frag"
    }

    /** Cross-device rejoin URL for a dropped participant (carries ?claim=<idx>). */
    private fun rejoinUrl(peerIndex: Int): String {
        val r = roomCode ?: return ""
        val frag = instance?.takeIf { it.isNotEmpty() }?.let { "#$it" } ?: ""
        return "${RelayConfig.CONTROLLER_BASE_URL}/$r?claim=$peerIndex$frag"
    }

    private fun nowWallMs(): Double = clock?.invoke() ?: epoch.elapsedNow().toDouble(DurationUnit.MILLISECONDS)
}
