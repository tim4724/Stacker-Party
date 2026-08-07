package com.hexstacker.core.display

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.engine.InputAction
import com.hexstacker.core.net.Fastlane
import com.hexstacker.core.model.Command
import com.hexstacker.core.model.CommandType
import com.hexstacker.core.model.EngineJson
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.model.PlayerResult
import com.hexstacker.core.net.ControllerMessage
import com.hexstacker.core.net.Msg
import com.hexstacker.core.net.OutboundMessage
import com.hexstacker.core.net.PauseReason
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
import kotlinx.serialization.json.jsonArray
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
    /**
     * Gamepads attached to this TV, as players. Injected and null by default so
     * the screenshot tests and any offline harness cannot seat a controller that
     * happens to be plugged into the machine into a fixture roster. The web guards
     * the same case with window.__TEST__.
     */
    padSource: PadSource? = null,
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

    // WHY the game is frozen, or null. Owned by [RoomCoreClient], which mirrors the room
    // core's answer on every pause/resume/reset, so there is nothing to keep in step here.
    private val pauseReason: PauseReason? get() = brainOrNull?.pauseReason
    private val paused: Boolean get() = pauseReason != null
    private var muted = false

    /**
     * Apply the room core's decision to the engine, music and countdown. Called by the
     * two ops below, never directly: EVERY decision — whether a freeze takes at all,
     * which reason wins, which trigger may lift which freeze — belongs to
     * roomCore.pause/resume, which the web display and Apple TV run too. Nothing here
     * re-checks the room state or who is still connected.
     *
     * [wasPaused] is sampled by the callers BEFORE the room-core call, because [paused]
     * reads through to the answer that call already landed.
     */
    private suspend fun applyPause(res: RoomCoreClient.Changed, wasPaused: Boolean) {
        if (!res.changed || paused == wasPaused) return
        if (paused) {
            // Anything the players got in before the freeze still counts; dropping it
            // would silently eat the last input of every pause.
            flushInputs()
            engine?.pause()
            engine?.resetFrameClock() // forget the frame clock so resume re-primes with delta 0
            output.pauseMusic()
        } else {
            engine?.resume()
            if (!muted) output.resumeMusic()
            rewindCountdownStep()
            // Every thaw takes the overlay down, including one the operator raised by
            // hand during an auto-pause: without this a reconnect resumes the match
            // underneath a stale pause menu. Web's thawGame does the same.
            setPauseOverlay(false)
        }
    }

    private suspend fun freezePause(reason: PauseReason): RoomCoreClient.Changed {
        val wasPaused = paused
        return roomCore.pause(reason).also { applyPause(it, wasPaused) }
    }

    /** `null` is the room-lifecycle clear: it ends the freeze whatever it was. */
    private suspend fun liftPause(reason: PauseReason?): RoomCoreClient.Changed {
        val wasPaused = paused
        return roomCore.resume(reason).also { applyPause(it, wasPaused) }
    }

    /** Is the pause overlay on screen? Pure VIEW state, deliberately NOT [paused]:
     *  while auto-paused the overlay is the only route to New Game (every controller is
     *  gone, so no one can send RETURN_TO_LOBBY), and the operator can raise it without
     *  the freeze changing. Web's toolbar Pause / Continue pair does the same. */
    private var pauseOverlayShown = false

    private fun setPauseOverlay(shown: Boolean) {
        pauseOverlayShown = shown
        output.setPaused(shown)
    }

    /** The host pressed Pause (their controller or the TV remote). Refused outside a
     *  running game, and while already frozen for a display-internal reason. During
     *  COUNTDOWN the engine isn't ticking yet, so freezing [advanceCountdown] via
     *  [paused] is the whole freeze (web clearCountdownTimers). */
    private suspend fun pauseGame() {
        val res = freezePause(PauseReason.MANUAL)
        if (!res.changed) return
        setPauseOverlay(true)
        publishAs(res.publish)
    }

    /** The host pressed Continue. Refused unless the freeze is theirs to lift, and while
     *  every participant is gone (there would be nobody to play). In that second case the
     *  overlay deliberately stays up: it carries New Game, which is what an operator
     *  staring at an emptied room actually wants. */
    private suspend fun resumeGame() {
        val res = liftPause(PauseReason.MANUAL)
        if (!res.changed) return
        publishAs(res.publish)
    }

    /** Every participant dropped. Silent: controllers never see this reason, so the room
     *  core hints 'none' and nothing goes out — there is nobody left to tell. Refused if
     *  the host had already paused by hand (RoomCore rule 2), which is what keeps their
     *  pause and its Continue intact for whoever comes back. */
    private suspend fun autoPause() {
        val res = freezePause(PauseReason.AUTO)
        if (!res.changed) return
        publishAs(res.publish)
    }

    /** A participant came back. */
    private suspend fun autoResume() {
        val res = liftPause(PauseReason.AUTO)
        if (!res.changed) return
        publishAs(res.publish)
    }

    /** Our own relay link dropped: freeze the sim so it can't run blind. Publishing is
     *  best-effort by definition — the relay is exactly what we cannot reach. */
    private suspend fun connectionPause() {
        val res = freezePause(PauseReason.CONNECTION)
        if (!res.changed) return
        publishAs(res.publish)
    }

    /** The relay answered created/joined. Lifts ONLY a link-drop freeze, so a blip that
     *  landed on top of a host's manual pause leaves that pause standing. */
    private suspend fun connectionResume() {
        val res = liftPause(PauseReason.CONNECTION)
        if (!res.changed) return
        publishAs(res.publish)
    }

    /** Room-lifecycle clear (new match, return to lobby, fresh room): the pause ends
     *  outright, whatever it was, and the transition alongside it publishes. */
    private suspend fun clearPause() {
        liftPause(null)
    }

    /** Web resume (startCountdown(callback, remaining)): the current number stays on
     *  screen without a re-broadcast/beep and gets its FULL second again; a shown GO
     *  re-arms the full 500ms hold. In the accumulator model that is a rewind to the
     *  current step's start. */
    private fun rewindCountdownStep() {
        if (state == RoomState.COUNTDOWN && countdownStep >= 0) {
            countdownElapsed = countdownStep * STEP_MS
        }
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

    private val padSeats: PadSeats? = padSource?.let { PadSeats(it, this) }

    /**
     * Monotonic ms for the pad mapper. Its OWN accumulator, not [frameClockMs],
     * which only advances while a game is running: a mapper handed a frozen clock
     * would measure every DAS interval against the same instant.
     */
    private var padClockMs = 0.0

    /** Whether any pad currently holds a seat. :tv stops routing pad presses into
     *  Compose focus during a running match while one does, because there the
     *  D-pad is that seat's piece. */
    val hasPadSeats: Boolean get() = padSeats?.hasSeats ?: false

    /** See [PadSeats.holdsSeat]: a press from a pad with no seat is a join, and
     *  :tv swallows it so it cannot also click whatever Compose has focused. */
    fun padHoldsSeat(slot: Int?): Boolean = padSeats?.holdsSeat(slot) ?: false

    // --- What PadSeats needs from the coordinator ---------------------------

    /**
     * Deliver a message from a seat this display owns rather than the relay.
     * Deliberately the SAME entry point the relay's messages take: a pad that took
     * a different route would be a second implementation of joining, naming,
     * colour, host election and liveness.
     */
    internal suspend fun deliverLocal(seat: Int, data: JsonObject) = onMessage(seat, data)

    internal fun markLocalSeatSeen(seat: Int) { seenSinceTick.add(seat) }

    internal fun hasPlayer(seat: Int): Boolean = room.players.containsKey(seat)

    internal fun reportPadError(label: String, error: Throwable) = onError(label, error)

    internal suspend fun padName(rawId: String): String =
        runCatching { bridgeProvider().padName(rawId) }.getOrDefault("Gamepad")

    internal suspend fun padRumbleJson(kind: String, lines: Int): String =
        bridgeProvider().padRumbleJson(kind, lines)

    internal suspend fun padPoll(padsJson: String, nowMs: Double, playing: Boolean): JsonArray =
        EngineJson.json
            .parseToJsonElement(bridgeProvider().padPollJson(padsJson, nowMs, playing))
            .jsonArray

    /**
     * Send to one peer, unless the seat is LOCAL. A pad attached to this TV has no
     * connection to send down and its index is negative, which the relay could not
     * route anyway. Every per-peer send goes through here so one added later
     * inherits the rule instead of having to remember it.
     */
    private fun sendToPeer(peerIndex: Int, data: JsonObject) {
        if (PadSeats.isLocalSeat(peerIndex)) return
        transport.sendTo(peerIndex, data)
    }

    // Non-null only while a publishBatch block is running: the hint accumulated so far.
    // Doubles as the "are we batching" flag. Safe as a plain field: every room mutation
    // runs on the single action-channel consumer, so two batches can never interleave.
    private var batchHint: String? = null

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

    // Inputs accepted but not yet handed to the engine. Every call into QuickJS is a
    // source string the binding re-parses (~0.65ms floor on TV hardware, an order of
    // magnitude more than the input itself), so a frame's worth of input goes over as
    // ONE batch instead of one call each. Drained by [flushInputs], which MUST run
    // before anything else touches the engine, or a soft-drop / frame / snapshot would
    // observe the board before inputs that arrived earlier. Order is preserved.
    private val pendingInputs = ArrayList<Pair<Int, InputAction>>()

    // The last snapshot handed to the output. Kept so a per-seat render-on-input pull
    // can be merged into the room the renderer is already showing instead of pulling
    // all eight boards back out of the engine.
    private var lastSnapshot: GameSnapshot? = null

    // Monotonic source for liveness/grace timing (commonMain-safe).
    private val epoch = TimeSource.Monotonic.markNow()

    // Injectable wall clock (deterministic liveness/grace in tests). Null -> monotonic epoch.
    internal var clock: (() -> Double)? = null

    companion object {
        // Countdown beat. Pinned to server/constants.js by tests/protocol-android-parity.test.js;
        // the SEQUENCING below is per-shell on purpose (see that test).
        private const val STEP_MS = 1000.0
        private const val GO_HOLD_MS = 500.0

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
            publishRank = roomCore.publishRank()
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

    private suspend fun handleCreated(code: String, instance: String?) {
        // A `created` while we still hold a room means the OLD room is gone: the relay
        // tore it down (close 4001) and the transport unpinned it, so this is a
        // replacement, not a first open. Its roster and match cannot follow it into a
        // room those players were never in, so clear them before the new code goes up.
        // Otherwise the fresh lobby shows the dead room's seats until liveness expires
        // them. The error-recovery path resets before asking for its room (and clears
        // [roomCode] doing so), so nothing runs twice there.
        val keepMatch = isLocalOnlyMatch()
        if (roomCode != null && !keepMatch) resetSession()
        this.roomCode = code
        this.instance = instance
        // A fresh room means an empty roster, so there is nothing to re-stamp — but the
        // sweep must come back on, or the room-gone recovery path (error -> createFresh)
        // would leave liveness off for the rest of the session.
        relayConnected = true
        output.roomReady(code, joinUrl(code, instance))
        if (!keepMatch) output.showScreen(DisplayScreen.LOBBY)
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
        // The whole reconciliation is ONE change: however many peers went missing, plus
        // the resume below, collapse into a single publish at the end. Per-departure
        // publishes would ship half-reconciled rosters, and — because the resume comes
        // last — a paused=true snapshot chased by a paused=false one, which is exactly how
        // a controller ends up stranded on a pause overlay whose Continue cannot help.
        // Floor `now`: this publish has to reach controllers even when nothing moved,
        // because it also clears their reconnect overlay and display-gone bail timer.
        // Web onDisplayRejoined and tvOS onJoined batch the same span.
        publishBatch(floor = RoomCoreClient.PUBLISH_NOW) {
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
            // The link-drop pause lifts here — after the roster reconcile above and inside
            // the batch, because the snapshot reports `paused` and that is the controller's
            // authority. Resuming after the publish made every rejoin snapshot say
            // paused=true and then chase it with a second publish; a controller that latched
            // the first and missed the second was stranded on a pause overlay whose Continue
            // cannot help. connectionResume lifts ONLY a link-drop freeze, so a blip that
            // landed on a host's manual pause leaves that pause standing.
            connectionResume()
        }
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
            publishAs(RoomCoreClient.PUBLISH_NOW)
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
        // No-op if anything already has us frozen, a host's manual pause included: that
        // pause is theirs to lift, and its Continue keeps working throughout.
        autoPause()
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
                connectionPause()
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
            // flushInputs first: a soft-drop applied ahead of a queued left/right would
            // drop the piece down the column the controller had already moved off.
            Msg.SOFT_DROP -> if (state == RoomState.PLAYING && !paused) {
                flushInputs()
                engine?.softDropStart(from, msg.speed?.toInt())
            }
            Msg.SOFT_DROP_END -> if (state == RoomState.PLAYING) {
                flushInputs()
                engine?.softDropEnd(from)
            }
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
            Msg.PING -> sendToPeer(from, OutboundMessage.pong(msg.t))
            else -> {}
        }
        // Auto-resume AFTER processing, so the reconnecting controller has already been sent
        // a snapshot describing the paused game before the resume publishes over the top of
        // it. markReconnected above already cleared the presence flag, so the next graceTick
        // drops the late-joiner deadline; no explicit cancel needed.
        if (wasDisconnected && room.isParticipant(from)) autoResume()
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
            if (res.roomFull) sendToPeer(from, OutboundMessage.error("Room is full"))
            return
        }
        // One publish settles everything a HELLO can move: this controller's own identity
        // (name, colour, level), the roster the others render, and the host, since a
        // reconnecting ex-host reclaims the role their pinned slot held through the
        // disconnect. A brand-new joiner needs it too: it is how they learn who they are
        // and which screen to show.
        publishAs(res.publish)
        if (res.claimed) autoResume()
    }

    /** The HELLO body the room core reads. The legacy `rejoinId` is normalized onto
     *  `rejoinToken`, which is what it looks for. (The rejoin QR's `?claim=` param is
     *  sent by the controller AS `rejoinToken` — web and tvOS decode the same two.) */
    private fun helloBody(msg: ControllerMessage): JsonObject = buildJsonObject {
        msg.name?.let { put("name", it) }
        msg.autoName?.let { put("autoName", it) }
        msg.colorIndex?.let { put("colorIndex", it) }
        (msg.rejoinToken ?: msg.rejoinId)?.let { put("rejoinToken", it) }
    }

    /**
     * Finish a cross-device rejoin the room core has already accepted: everything keyed by peer
     * index that lives OUTSIDE the room (the P2P link, the rejoin overlays, the engine's
     * boards) moves from the old index to the new one. The room half (roster record, sticky
     * host slot, participant order, alive flags, cached ranking) moved inside the room core.
     */
    private suspend fun applyReconnectClaim(oldId: Int, newId: Int) {
        fastlane?.close(oldId) // drop the dropped device's P2P link; the returning device re-offers
        flushInputs() // queued input belongs to the board as it stands BEFORE the rekey
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
        if (engine == null) return
        // A ratchet drag that crossed several steps inside one pointermove arrives as
        // ONE counted message (the controller is capped at 25 msg/sec on AirConsole),
        // so expand it back into that many engine inputs. Absent or malformed n is a
        // single step; the clamp keeps an off-wire count bounded.
        val repeats = (msg.n ?: 1).coerceIn(1, RelayConfig.INPUT_MAX_REPEAT)
        repeat(repeats) { pendingInputs.add(from to input) }
        // Render-on-input: reflect the applied input on the very next vsync instead of
        // waiting for the next frame() tick. The pull is a pure read (no time advance),
        // so this only front-runs the VISUAL; this frame's events/commands (lock flash,
        // garbage, sends) still flow on the next frame(). Guarded to PLAYING above.
        // Coalesced to one pull per frame: an 8-player input burst can land several
        // messages inside one 16 ms window, and later inputs ride the tick's own
        // snapshot — they are already applied by then, because the flush below drains
        // everything pending, not just this message.
        if (renderedInputSinceTick) return
        renderedInputSinceTick = true
        val snap = try {
            val e = engine ?: return
            // ONE seat, merged into the room already on screen. Pulling all eight costs
            // ~9ms on an 8-player TV against ~2.7ms for one, and an input can only have
            // moved this board. The queued input rides INTO the pull rather than going
            // over in its own call — one boundary crossing instead of two.
            val batch = takeInputs()
            val prev = lastSnapshot
            val pulled = if (prev == null) null else e.snapshotPlayer(from, batch)
            if (prev == null) e.processInputs(batch) // no retained room: apply, then pull below
            val moved = pulled?.players?.firstOrNull()
            if (moved != null && prev!!.players.any { it.id == moved.id }) {
                // `elapsed` comes from the pull, not from `prev`: it drives the match
                // timer, and a merge that kept the retained value would freeze the clock
                // for as long as somebody held a direction down.
                prev.copy(
                    players = prev.players.map { if (it.id == moved.id) moved else it },
                    elapsed = pulled.elapsed,
                )
            } else {
                // Nothing retained to merge into (the first input of a match, before the
                // first frame() has delivered one), or a seat that snapshot predates.
                // Fall back to the full pull rather than skip the repaint.
                e.snapshot()
            }
        } catch (t: Throwable) {
            onError("inputSnapshot", t)
            return
        }
        renderSnapshot(snap)
    }

    /**
     * Hand every accepted-but-unsent input to the engine, in arrival order, as one
     * batch. MUST precede any other engine call: the engine is a single mutable
     * board set, so a soft-drop, a frame() or a snapshot that ran ahead of a queued
     * left/right would observe — and act on — a board the controller had already
     * moved past.
     */
    private suspend fun flushInputs() {
        val batch = takeInputs()
        if (batch.isEmpty()) return
        engine?.processInputs(batch)
    }

    /**
     * Drain the queue and hand it back, for a caller that is about to cross into the
     * engine anyway and can carry the inputs with it (the tick, the render-on-input
     * pull). Same ordering guarantee as [flushInputs] — the callee applies them
     * before it reads — for one boundary crossing instead of two.
     */
    private fun takeInputs(): List<Pair<Int, InputAction>> {
        if (pendingInputs.isEmpty()) return emptyList()
        val batch = pendingInputs.toList()
        pendingInputs.clear()
        return batch
    }

    /** The one place a snapshot reaches the output, so the retained copy the
     *  per-seat merge builds on can never fall out of step with what is drawn. */
    private fun renderSnapshot(snapshot: GameSnapshot) {
        lastSnapshot = snapshot
        output.renderSnapshot(snapshot)
    }

    /** Drop the per-match engine-side state. Runs wherever the engine handle is
     *  released: an input queued for a match that just ended has nothing to apply to,
     *  and a retained snapshot of it must not be merged into the NEXT match's boards. */
    private fun discardEngineState() {
        pendingInputs.clear()
        lastSnapshot = null
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
        // Mirrors startNewGame's ordering: drop the players the relay reported gone (a
        // still-connected one keeps their seat, however quiet), clear the overlays, then
        // re-stamp presence on this "everyone present" transition so a controller that
        // went quiet just before the match isn't instantly flagged.
        flushSeen()
        roomCore.clearAlive()
        roomCore.pruneDeparted()
        disconnectedBoards.clear()
        roomCore.clearDisconnected(nowWallMs())
        // The prune emptied the roster: don't build a zero-player engine.
        if (room.size == 0) {
            // The prune changed the roster controllers render, so publish either way.
            if (state == RoomState.RESULTS) returnToLobby() else publishAs(RoomCoreClient.PUBLISH_NOW)
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
        clearPause()
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
        discardEngineState() // a fresh match starts from an empty batch and no retained boards
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
        // Before the state switch, because a pad joins, picks a colour and steps
        // its level in the LOBBY, where none of the branches below run any input.
        padSeats?.let {
            padClockMs += deltaMs
            it.poll(padClockMs, state == RoomState.PLAYING && !paused)
        }
        when (state) {
            RoomState.COUNTDOWN -> advanceCountdown(deltaMs)
            RoomState.PLAYING -> {
                if (paused) return
                val e = engine ?: return
                frameClockMs += deltaMs
                val frame = try {
                    // Inputs that landed after this frame's render-on-input pull (or all
                    // of them, if none did) ride into the tick, so they are simulated in
                    // the frame they arrived in — same as the web applying each input
                    // synchronously ahead of the next rAF update — for one crossing
                    // rather than two.
                    e.frame(frameClockMs, takeInputs())
                } catch (t: Throwable) {
                    onError("frame", t)
                    return
                }
                for (ev in frame.events) {
                    output.handleGameEvent(ev) // board animations
                    // The same fan-out, for the effect that happens in a player's
                    // hands rather than on screen.
                    padSeats?.handle(ev)
                }
                // Omitted (null) when the frame is render-identical to the last
                // delivered one (shim scene signature): keep the retained snapshot
                // instead of re-rendering a pixel-identical full screen.
                frame.snapshot?.let { renderSnapshot(it) }
                // One frame is one change: a tick that KOs several players at once (a
                // garbage cascade, a simultaneous top-out) would otherwise publish the
                // whole room once per KO before anyone sees the first. No floor, so a
                // frame that moved nothing publishes nothing — which is what keeps this
                // free at 60 Hz. Web batches displayGame.update() for the same reason.
                publishBatch { dispatchCommands(frame.commands) } // host effects -> sends + match end
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
                    // Targeted, and NOT room state: pure per-player telemetry. `lines`
                    // is the one figure the room snapshot does not carry. Liveness is
                    // the snapshot's alone, recorded by PLAYER_ELIMINATED below, so a
                    // `player_ko` form sends nothing here (PlayerStateCommand in
                    // server/PartyCore.d.ts has why).
                    if (c.lines != null) {
                        sendToPeer(pid, OutboundMessage.playerState(c.lines))
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
        // Lift any pause first: the RESULTS publish below reports `paused`, and a match
        // that ended while frozen must not hand controllers a stale pause.
        clearPause()
        // Label the ranking with roster names/colours and append the players who sat this
        // round out (flagged newPlayer), then stash it BEFORE the transition: the transition
        // publishes, and the RESULTS snapshot is what carries the ranking to controllers.
        val enriched = roomCore.enrichResults(rankingJson(results))
        roomCore.setResults(enriched)
        publishAs(roomCore.transitionTo(RoomState.RESULTS).publish)
        output.stopMusic()
        setPauseOverlay(false) // MUST precede showResults (clears the focus menu)
        output.showResults(decodeResults(enriched))
        output.showScreen(DisplayScreen.RESULTS)
        engine = null
        discardEngineState()
    }

    private suspend fun returnToLobby() {
        if (state == RoomState.LOBBY) return
        clearPause()   // the LOBBY transition below publishes, so the lift rides it
        engine = null
        discardEngineState()
        output.stopMusic()
        setPauseOverlay(false)
        // Remove the players the relay reported gone, then fold in the late joiners who
        // were waiting out the round.
        flushSeen()
        roomCore.pruneDeparted()
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
        // See [isLocalOnlyMatch]: a pad-only match outlives its room, because it was
        // never played through one.
        if (!isLocalOnlyMatch()) resetSession()
        transport.createFresh() // handleCreated re-arms the room code + QR when `created` lands
    }

    /**
     * A match whose every player is a pad attached to this box. Such a match has no
     * presence at the relay AT ALL — local seats never join a room — so the relay
     * retires the room as soon as the display's own socket goes, which is exactly what
     * backgrounding does. The rejoin then answers "Room not found" and the recovery
     * path throws away a match the display is still holding, for a player who never
     * left the sofa.
     *
     * The premise of that recovery — a roster cannot follow the room, because those
     * players were never in the new one — holds for relay members and not for local
     * seats, which were never in the OLD room either. So the room is replaced
     * underneath the match and only the QR changes.
     *
     * Requires a pad to still HOLD its seat: with the controller gone there is nobody
     * left to carry the match for, and the ordinary reset is right.
     */
    private fun isLocalOnlyMatch(): Boolean {
        if (roomCore.state == RoomState.LOBBY || !hasPadSeats) return false
        val active = room.participants
        return active.isNotEmpty() && active.all { PadSeats.isLocalSeat(it) }
    }

    /**
     * Everything a lost room takes with it: the match, the audio, the overlays, the
     * roster and the room's own identity (web resetToWelcome). How the REPLACEMENT room
     * arrives is the caller's business: [onRelayError] asks the transport for one,
     * [handleCreated] already holds it.
     */
    private suspend fun resetSession() {
        engine = null
        discardEngineState()
        fastlane?.closeAll()
        output.stopMusic()
        setPauseOverlay(false)
        roomCode = null
        instance = null
        disconnectedBoards.clear()
        // Roster, participants, liveness, results, the pause reason and the room state,
        // all back to a fresh room. Mute survives (a device preference, not room state).
        roomCore.reset()

        output.showScreen(DisplayScreen.LOBBY)
        // Take the dead code off screen with it. Leaving it up (dimmed, as a mere link
        // drop does) offers a QR that resolves to nothing for the whole create
        // round-trip, and leaves the roster's cards standing under it.
        output.roomClosed()
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

    /** The remote's pause key (and Back / Menu during a game). No state guard: the room
     *  core refuses a freeze outside a running game, and the AUTO branch below is
     *  reachable only while one is already in force, which implies running. */
    private suspend fun togglePause() {
        when (pauseReason) {
            PauseReason.MANUAL -> resumeGame()
            // Nothing left to pause — but the overlay carries New Game, and with every
            // controller gone it is the only way out of a frozen match. Toggling the VIEW
            // leaves the freeze alone; a returning player still auto-resumes. The web
            // display's toolbar Pause (raise) / Continue (dismiss) pair is the same thing
            // split across two buttons.
            PauseReason.AUTO -> setPauseOverlay(!pauseOverlayShown)
            // CONNECTION: the reconnect overlay owns the screen. null: a fresh pause.
            else -> pauseGame()
        }
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
            togglePause()
            paused
        }
        RemoteKind.PLAY_PAUSE -> {
            when (state) {
                RoomState.LOBBY, RoomState.RESULTS -> if (room.size >= 1) beginCountdown()
                RoomState.COUNTDOWN, RoomState.PLAYING -> togglePause()
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
        batchHint?.let { batch ->
            // Inside a batch: fold instead of publishing. Strongest wins.
            if (hintRank(hint) > hintRank(batch)) batchHint = hint
            return
        }
        when (hint) {
            RoomCoreClient.PUBLISH_NOW -> publishRoomSnapshot()
            RoomCoreClient.PUBLISH_SOON -> publishRoomSnapshotSoon()
        }
    }

    /**
     * RoomCore.publishRank, read out of the module once the room core is up. The
     * fallback only covers the window before that, when nothing publishes anyway.
     * An unknown hint ranks 0, so it can never strengthen a batch.
     */
    private var publishRank: Map<String, Int> = mapOf(
        RoomCoreClient.PUBLISH_NONE to 0,
        RoomCoreClient.PUBLISH_SOON to 1,
        RoomCoreClient.PUBLISH_NOW to 2,
    )

    private fun hintRank(hint: String): Int = publishRank[hint] ?: 0

    /**
     * Run a group of room changes as ONE change: everything inside publishes once, when
     * the block returns. Without it a rejoin dropping four peers, or an engine frame that
     * KOs three players at once, publishes the whole room once per mutation — and every
     * one but the last describes a half-finished state no controller should ever render.
     *
     * Local rather than a RoomCore method because the block is a closure and the bridge is
     * JSON-only (the QuickJS binding has no call-with-arguments API), so a room-core version would
     * need begin/end as two extra interpolated `evaluate` calls per batch, around a frame
     * drain that runs every tick. The hints stay the room core's decision; only the
     * folding is here, and [publishAs] is already the one point every publish goes through.
     *
     * [floor] is the weakest hint the group may end on: leave it default and a group that
     * changed nothing stays silent (what makes wrapping the frame drain free), pass `now`
     * when the publish has to happen regardless. `finally` closes the fold, so a throw
     * mid-block still ships what did change. Web and tvOS carry this verbatim.
     *
     * `inline` so [body] can call suspend functions in the caller's context.
     */
    private suspend inline fun publishBatch(
        floor: String = RoomCoreClient.PUBLISH_NONE,
        body: () -> Unit,
    ) {
        batchHint = floor
        try {
            body()
        } finally {
            val hint = batchHint ?: floor
            batchHint = null
            publishAs(hint)
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
        return "${RelayConfig.controllerBaseUrl}/$code$frag"
    }

    /** Cross-device rejoin URL for a dropped participant (carries ?claim=<idx>). */
    private fun rejoinUrl(peerIndex: Int): String {
        val r = roomCode ?: return ""
        val frag = instance?.takeIf { it.isNotEmpty() }?.let { "#$it" } ?: ""
        return "${RelayConfig.controllerBaseUrl}/$r?claim=$peerIndex$frag"
    }

    private fun nowWallMs(): Double = clock?.invoke() ?: epoch.elapsedNow().toDouble(DurationUnit.MILLISECONDS)
}
