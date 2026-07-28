package com.hexstacker.tv

import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.hexstacker.core.display.CountdownValue
import com.hexstacker.core.display.DisplayCoordinator
import com.hexstacker.core.display.DisplayOutput
import com.hexstacker.core.display.DisplayScreen
import com.hexstacker.core.display.ResultEntry
import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import com.hexstacker.core.net.RelayClient
import com.hexstacker.core.net.RelayConfig
import com.hexstacker.core.net.RelayTransport
import com.hexstacker.core.room.PlayerRecord
import com.hexstacker.tv.audio.MusicPlayer
import com.hexstacker.tv.net.WebRtcFastlane
import com.hexstacker.tv.render.BoardSurfaceView
import com.hexstacker.tv.render.SeatMeta
import com.hexstacker.tv.ui.AboutScreen
import com.hexstacker.tv.ui.ConnectionOverlay
import com.hexstacker.tv.ui.CountdownOverlay
import com.hexstacker.tv.ui.LicenseTextScreen
import com.hexstacker.tv.ui.LicensesScreen
import com.hexstacker.tv.ui.LobbyBackground
import com.hexstacker.tv.ui.LobbyData
import com.hexstacker.tv.ui.LobbyPlayer
import com.hexstacker.tv.ui.LobbyScreen
import com.hexstacker.tv.ui.LocalReduceMotion
import com.hexstacker.tv.ui.Tokens
import com.hexstacker.tv.ui.systemAnimationsRemoved
import com.hexstacker.tv.ui.rememberLicenseEntries
import com.hexstacker.tv.ui.PauseOverlay
import com.hexstacker.tv.ui.ResultCard
import com.hexstacker.tv.ui.ResultsScreen
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.Executors
import com.hexstacker.tv.ui.CountdownValue as UiCountdownValue

/**
 * Android TV entry point. Wires the headless [DisplayCoordinator] (which drives the
 * QuickJS engine + relay + room FSM) to the native renderer ([BoardSurfaceView]),
 * the Compose-for-TV chrome, and the Media3 [MusicPlayer], via a [TvDisplayOutput]
 * bridge. The coordinator and the QuickJS engine share ONE dedicated game thread
 * ([gameDispatcher]), so an engine call costs no thread handoff and input handling never
 * queues behind Compose; [TvDisplayOutput] posts the few side-effects that do belong to
 * Main (ExoPlayer, View lifecycle) back to it.
 */
class MainActivity : ComponentActivity() {

    private lateinit var board: BoardSurfaceView
    private lateinit var music: MusicPlayer
    private lateinit var relay: RelayClient
    private lateinit var fastlane: WebRtcFastlane
    private lateinit var coordinator: DisplayCoordinator
    private lateinit var ui: TvDisplayOutput

    // One QuickJS runtime for the whole app: the session-lived room core plus a game
    // re-inited per match (Bridge.create, no bundle re-parse). Started as soon as the
    // coordinator's consumer asks for it, because the room core has to exist before the
    // first relay room event is handled; everyone awaits the SAME deferred, so a START
    // that beats the bootstrap just joins it instead of racing a second runtime into being.
    // @Volatile because the writer is now the game thread and onDestroy reads it on Main.
    @Volatile private var engineDeferred: Deferred<EngineBridge>? = null

    /**
     * THE game thread: the coordinator's dispatcher AND the engine's, one thread for both.
     *
     * An input used to cross three threads to be seen — the fastlane's executor, then the
     * coordinator's action channel on Main, then the engine's own dispatcher and back.
     * Sharing one dispatcher removes the last two: `withContext` to the dispatcher you are
     * already on does not dispatch, so every engine call is a plain call. Measured at eight
     * seats: 5.5-6.0ms -> 4.0ms p50 to the renderer (PERF-INPUT-LATENCY.md §16).
     *
     * It also takes input handling off the thread Compose and the Choreographer share,
     * which is where the p95 tail was coming from.
     *
     * QuickJS is created on this thread and only ever entered from it. That is load-bearing,
     * not incidental: the C runtime calibrates its stack-overflow guard against the creating
     * thread's stack, so a call from anywhere else turns a catchable JS error into a SIGSEGV
     * (§14.1 — this was measured, on the device, by doing it).
     */
    private val gameExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "hex-game") }
    private val gameDispatcher = gameExecutor.asCoroutineDispatcher()

    // The system "Remove animations" accessibility state, feeding LocalReduceMotion.
    // Compose state so a toggle picked up on resume recomposes the chrome.
    private var reduceMotion by mutableStateOf(false)

    /** Get-or-start the runtime creation. Called only from the coordinator's
     *  bridgeProvider, i.e. only from the game thread, so no lock is needed. */
    private fun engineAsync(): Deferred<EngineBridge> =
        engineDeferred ?: lifecycleScope.async(Dispatchers.IO) {
            // The asset read stays off the game thread; create() hops to [gameDispatcher]
            // itself, so the 168ms bundle parse — and every later call — happens there.
            val bundle = assets.open("partycore.js").bufferedReader().use { it.readText() }
            EngineBridge.create(bundle, gameDispatcher)
        }.also { engineDeferred = it }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Debug-only QR retarget, for testing a branch preview of the controller:
        //   adb shell am start -n com.hexstacker.tv/.MainActivity \
        //     --es hexHost preview-<branch>.hexstacker.com
        // Must happen before the relay connects (the origin also rides `create` as the
        // controller-URL template). Unset => production, so a launcher start is always
        // production. Debuggable builds only: any app on the device can send an extra,
        // and a release build must never let one repoint the QR.
        // Build-time origin first (`-PhexControllerHost=...`), so a RELEASE build can point
        // at a branch deploy: the launch extra below is debuggable-only on purpose, which
        // makes it unavailable in exactly the build you want for testing with R8 and
        // CheckJNI-off in play. Empty resource => production.
        val buildHost = getString(R.string.controller_host_override)
        if (buildHost.isNotEmpty()) RelayConfig.setControllerBase(buildHost)
        // Debug launches can still override it, which is the faster loop while developing.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            RelayConfig.setControllerBase(intent?.getStringExtra("hexHost"))
        }
        RelayConfig.controllerBaseUrl.let {
            if (it != RelayConfig.DEFAULT_CONTROLLER_BASE_URL) Log.i("MainActivity", "controller base: $it")
        }

        board = BoardSurfaceView(this)
        // The board must NOT grab D-pad focus, or the Compose lobby/results buttons
        // never receive it and the remote appears dead.
        board.isFocusable = false
        board.isFocusableInTouchMode = false
        // Start hidden: the app always launches into the lobby, and a VISIBLE SurfaceView
        // would create its surface + start the render thread at first layout, only for
        // showScreen(LOBBY) to join the thread and destroy the surface a few hundred ms
        // later (when the relay answers `created`) — a main-thread stall + window
        // recomposite right in the middle of the lobby entrance animation.
        board.visibility = View.GONE
        music = MusicPlayer(this)
        val mainHandler = Handler(Looper.getMainLooper())
        // The coordinator now calls DisplayOutput from the game thread, so the parts that
        // genuinely need Main (ExoPlayer, View lifecycle) get posted there.
        ui = TvDisplayOutput(board, music, runOnMain = { block -> mainHandler.post(block) })
        relay = RelayClient(callbackPoster = { block -> mainHandler.post(block) })
        // Surface the display's own relay link state: drives the RECONNECTING / DISCONNECTED
        // overlay AND tells the coordinator to pause/resume the running game on link loss
        // (coordinator is assigned just below; the first callback can't fire before connect()).
        relay.onConnectionState = { state, reconnectAttempt ->
            ui.setConnectionState(state, reconnectAttempt)
            coordinator.onLinkStateChanged(state)
        }
        // Slot-0 eviction (relay close 4000): another display took over this room.
        // RelayClient already disables reconnect and emits CLOSED; flag it as the
        // terminal "replaced" state so the overlay drops the RECONNECT button (re-arming
        // reconnect would only be evicted again). Fires right after the CLOSED state above.
        relay.onReplaced = { ui.setReplaced() }

        // Low-latency P2P controller input over a WebRTC DataChannel; the relay stays the
        // fallback (a controller whose fastlane can't open just sends input over the socket).
        fastlane = WebRtcFastlane(this, listOf(RelayConfig.STUN_URL))

        coordinator = DisplayCoordinator(
            transport = relay,
            output = ui,
            // ONE runtime for the session: the room core lives in it from
            // coordinator.start() onwards and each match's game is created in the same
            // context. Awaiting it is also what orders the bootstrap — room events can
            // arrive before the bundle has finished compiling, and they queue behind this.
            bridgeProvider = { engineAsync().await() },
            fastlane = fastlane,
            // Surface boundary errors the coordinator swallows to keep its loop alive
            // (engine/parse failures would otherwise vanish without a trace).
            onError = { label, e -> Log.w("DisplayCoordinator", label, e) },
            dispatcher = gameDispatcher,
        )

        requestLowLatencyDisplayMode()

        reduceMotion = systemAnimationsRemoved(this)
        setContent {
            val model by ui.state.collectAsStateWithLifecycle()
            CompositionLocalProvider(LocalReduceMotion provides reduceMotion) {
                HexStackerApp(
                    board = board,
                    model = model,
                    onStart = { coordinator.remoteStartMatch() },
                    onPlayAgain = { coordinator.remoteStartMatch() },
                    onNewGame = { coordinator.remoteReturnToLobby() },
                    onContinue = { lifecycleScope.launch { coordinator.remoteTogglePause() } },
                    // The coordinator's TOGGLE_MUTE drives output.setMuted (music + UI),
                    // so the overlay switch just needs to trigger it.
                    onToggleMusic = { lifecycleScope.launch { coordinator.remoteToggleMute() } },
                    onReconnect = { relay.reconnect() },
                )
            }
        }

        coordinator.start()

        // Render clock: drive coordinator.tick() once per frame on the main thread. Scoped to
        // repeatOnLifecycle(STARTED) so it stops requesting frames (and ticking the QuickJS
        // engine) while the app is backgrounded, and restarts with a fresh delta on return —
        // mirroring the web freezing the game when the tab is hidden.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                var last = 0L
                var acc = 0.0
                while (isActive) {
                    val now = awaitFrame()
                    val dt = if (last == 0L) 0.0 else (now - last) / 1_000_000.0
                    last = now
                    acc += dt
                    // In the lobby the tick's only work is 1s-granularity liveness/grace
                    // polling, so ~4Hz is plenty — skipping the other frames drops the
                    // per-frame Action.Tick + ack allocation churn while the app idles.
                    // Every other screen (countdown/gameplay/results) ticks per frame.
                    if (ui.state.value.screen == DisplayScreen.LOBBY) {
                        if (acc < LOBBY_TICK_MS) continue
                    } else if (acc > dt) {
                        // First tick after leaving the lobby: drop the skipped lobby
                        // frames' time so it can't eat into the 3-2-1 countdown.
                        acc = dt
                    }
                    coordinator.tick(acc)
                    acc = 0.0
                }
            }
        }

        // Warm ExoPlayer + the beep PCM during lobby idle, once the entrance animation
        // has played out (~950ms), so the countdown/GO have nothing left to build. Safe
        // to lose to lifecycle cancellation: first use re-creates it on demand. The
        // QuickJS runtime is no longer warmed here — coordinator.start() above already
        // asked for it, because the room core runs inside it.
        lifecycleScope.launch {
            awaitFrame()
            delay(WARMUP_DELAY_MS)
            music.warmUp()
        }

        // TTFD for Play's startup metrics + cloud-profile aggregation: the launch is
        // "fully drawn" once the real room's lobby (QR + join code) has rendered, not
        // at the first frame of the waiting lobby.
        lifecycleScope.launch {
            ui.state.first { it.lobby != null }
            awaitFrame()
            reportFullyDrawn()
        }
    }

    // True between a Home-press suspend (onStop) and the matching onStart resume,
    // so the first onStart of the process doesn't "resume" a connection that the
    // onCreate connect() is already opening.
    private var suspendedForBackground = false

    // True between onStop and the next onResume, telling a real background
    // round-trip (rejoin in flight, roomReady will re-confirm the QR) apart from a
    // transient onPause with no onStop (e.g. a system dialog), where onResume must
    // undo the precautionary QR dim itself because no rejoin will.
    private var stoppedSincePause = false

    /** Frames drawn between here and onStop feed the system's task snapshot — the
     *  image shown during the whole return transition. Dim the QR now, while frames
     *  still render, so a possibly-stale room code never presents as live on resume;
     *  by onStop it would miss the snapshot, and the happy-path rejoin clears the
     *  dim (roomReady) before the first live frame, making it invisible. */
    /**
     * Ask the display to switch into its low-latency mode (HDMI ALLM / "game mode"):
     * drop motion interpolation, noise reduction and the rest of the picture pipeline,
     * which on a TV sits between our buffer and the photons.
     *
     * This is very likely the largest single latency term left in the product, and it is
     * not in our code: TV post-processing typically costs 10-40 ms, against the ~7 ms of
     * app time the whole input path now takes (PERF-INPUT-LATENCY.md §14). It is also the
     * cheapest thing on the list, which is why it goes first.
     *
     * Set once, for the whole Activity, rather than per screen: the flag makes the display
     * renegotiate, and a TV that flashes or re-syncs on every lobby↔game transition would
     * be far worse than the milliseconds it saves. A party is a game session end to end.
     *
     * Nothing to verify from adb — whether a panel honours it, and what it is worth, needs
     * a camera or a latency tester on the real TV. The request is free either way: a
     * display that does not support it ignores it, which is why there is no fallback path.
     */
    private fun requestLowLatencyDisplayMode() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return // API 30; minSdk is 28
        // Log what the panel claims, so a "did this do anything?" question has an answer
        // in logcat rather than needing a rebuild to find out.
        val supported = runCatching { display?.isMinimalPostProcessingSupported }.getOrNull()
        window.setPreferMinimalPostProcessing(true)
        Log.i("MainActivity", "requested minimal post-processing (ALLM); display reports supported=$supported")
    }

    override fun onPause() {
        super.onPause()
        if (!isFinishing) ui.setQrPending(true)
    }

    override fun onResume() {
        super.onResume()
        // The accessibility "Remove animations" toggle lives outside the app;
        // re-read it on every return to the foreground.
        reduceMotion = systemAnimationsRemoved(this)
        // Transient pause (no onStop): the socket never suspended and the room is
        // unchanged, so lift onPause's precautionary dim — unless the link is
        // genuinely down, where roomReady clears it after the reconnect instead.
        if (!stoppedSincePause && ui.state.value.connection == RelayTransport.ConnectionState.OPEN) {
            ui.setQrPending(false)
        }
        stoppedSincePause = false
    }

    /** Background: silence music and suspend the relay socket (the tick loop already
     *  stops via repeatOnLifecycle). Backgrounding is recoverable (Home and back), so
     *  the party survives: closing the socket hands controllers an immediate
     *  peer_left(0) and they wait on their reconnect overlay instead of sitting in a
     *  live-looking room with a frozen display behind it. Skipped when finishing:
     *  onDestroy's coordinator.stop() must still send close_room over a live socket. */
    override fun onStop() {
        super.onStop()
        stoppedSincePause = true
        music.pauseForBackground()
        if (!isFinishing) {
            fastlane.closeAll() // controllers re-offer their P2P channels on rejoin
            relay.suspendSocket()
            suspendedForBackground = true
            // Graceful resume exists for rooms with PLAYERS. An empty lobby's room dies
            // with our socket at the relay (rooms live on members), so reopening would
            // rejoin a dead room, bounce off "Room not found", and visibly swap the QR
            // mid-lobby. Forget it and reset the card instead.
            if (ui.lobbyIsEmpty()) {
                relay.unpinRoom()
                ui.clearRoom()
            }
        }
    }

    /** Foreground: rejoin the suspended room (slot 0; the coordinator re-welcomes the
     *  waiting controllers on `joined`, or recovers via createFresh if the relay
     *  retired the room), and restore music only if a match is actively running. */
    override fun onStart() {
        super.onStart()
        // Every foreground entry (launch included): hold the audio output out of
        // standby so the countdown "3" — the first real sound of a session — doesn't
        // play over the output path's cold start (audible as a distorted first tick).
        // onStop undoes this via music.pauseForBackground().
        music.keepOutputWarm()
        if (suspendedForBackground) {
            suspendedForBackground = false
            relay.reconnect()
        }
        val m = ui.state.value
        // countdown == null gates out the 3/2/1/GO window: the screen is already GAME then,
        // but startMusic() only fires at GO. Resuming here mid-countdown would start the loop
        // from 0, which GO's startMusic() then restarts (an audible double-start).
        if (m.screen == DisplayScreen.GAME && !m.paused && !m.muted && m.countdown == null) {
            music.resumeFromBackground()
        }
    }

    /**
     * The single remote/keyboard context-key path: keys the focused Compose node
     * doesn't consume bubble up here, and during GAME (board + overlays only)
     * nothing is focused, so they arrive directly. Play/Pause is the context action
     * (start / pause / continue / play-again); P mirrors it for keyboards; Menu
     * pauses during a game. D-pad navigation + Select are left to Compose focus
     * on the lobby/results.
     *
     * BACK is intentionally NOT handled here: consuming it in onKeyDown would
     * suppress the OnBackPressedDispatcher (which fires the app's game-pause
     * BackHandler during GAME and the default finish() elsewhere). Routing BACK
     * through the dispatcher is what stops it from BOTH pausing the game AND
     * exiting the app; see the BackHandler in [HexStackerApp].
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_BUTTON_START,
            KeyEvent.KEYCODE_P,
            -> {
                // repeatCount == 0: act on the first press only; a held key auto-repeats
                // KeyDown, which would otherwise toggle pause/start over and over.
                if (event.repeatCount == 0) coordinator.remotePlayPause()
                return true
            }
            KeyEvent.KEYCODE_MENU -> {
                if (ui.state.value.screen == DisplayScreen.GAME) {
                    if (event.repeatCount == 0) lifecycleScope.launch { coordinator.remoteTogglePause() }
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        super.onDestroy()
        coordinator.stop()
        relay.shutdown() // stop the RelayClient serial executor so its worker thread dies
        fastlane.dispose() // release peer connections + the WebRTC factory
        music.release()
        // close() suspends (takes the engine lock, frees on the engine thread), so block
        // briefly here: teardown must not race an in-flight frame() on the way out.
        // A warm-up still in flight was already cancelled with lifecycleScope (create()'s
        // catch closes the runtime itself); await() then throws and there is nothing to
        // close, which runCatching swallows. Bounded so a wedged engine thread leaks the
        // runtime (the process is exiting anyway) instead of ANRing the main thread.
        runBlocking {
            engineDeferred?.let { d -> runCatching { withTimeout(1000) { d.await().close() } } }
        }
        // Strictly AFTER the close above: close() hops to this executor, and a shutdown()
        // first would reject that task and leak the runtime instead of freeing it.
        gameExecutor.shutdown()
    }
}

/** Immutable UI state the Compose tree renders from. */
data class UiModel(
    val screen: DisplayScreen = DisplayScreen.LOBBY,
    val lobby: LobbyData? = null,
    val countdown: UiCountdownValue? = null,
    val results: List<ResultCard> = emptyList(),
    val paused: Boolean = false,
    val muted: Boolean = false,
    val connection: RelayTransport.ConnectionState = RelayTransport.ConnectionState.IDLE,
    // Current retry number while RECONNECTING, for the "Attempt N of M" status (web parity).
    val reconnectAttempt: Int = 0,
    // Terminal slot-0 eviction: another display took over this room. Distinguishes a
    // "replaced" CLOSED (no reconnect affordance) from an ordinary give-up CLOSED.
    val replaced: Boolean = false,
    // The relay link dropped and the room hasn't been re-confirmed yet: the shown
    // QR/code may point at a dead room (a rejoin can bounce off "Room not found"
    // into a fresh room), so the lobby dims the QR card until `joined`/`created`
    // lands (roomReady).
    val qrPending: Boolean = false,
)

/**
 * Bridges the coordinator's [DisplayOutput] side-effects to the native renderer,
 * audio, and Compose state.
 *
 * Every method here runs on the GAME thread (the coordinator's dispatcher), NOT Main.
 * Most of it is fine there and must stay there — [renderSnapshot] and [handleGameEvent]
 * are the input path, and posting them to Main would put back the hop the game thread
 * exists to remove. [BoardSurfaceView]'s ingress is built for it (volatile fields,
 * concurrent collections, `bumpContent` under a lock) and `MutableStateFlow` is
 * thread-safe, with Compose collecting whatever it publishes.
 *
 * Two things are NOT: ExoPlayer asserts single-threaded access from where it was built,
 * and View properties plus the render thread's lifecycle belong to Main. Those go through
 * [runOnMain]. Note what that means for ORDER — a posted block runs after everything the
 * game thread does inline, so anything that must be sequenced against a snapshot has to
 * stay inline (see [showScreen]).
 */
class TvDisplayOutput(
    private val board: BoardSurfaceView,
    private val music: MusicPlayer,
    private val runOnMain: (Runnable) -> Unit,
) : DisplayOutput {

    private val _state = MutableStateFlow(UiModel())
    val state: StateFlow<UiModel> get() = _state

    private var room: String = ""
    private var joinUrl: String = ""
    private var roster: List<PlayerRecord> = emptyList()
    private var hostSlot: Int? = null

    override fun showScreen(screen: DisplayScreen) {
        // Board CONTENT inline, on the game thread. This has to stay inline: renderSnapshot
        // runs here too, and posting the clear to Main would let the countdown's first
        // snapshot land BEFORE the clear that is supposed to precede it, wiping it.
        //
        // Entering GAME (at COUNTDOWN): reset the boards to empty first, so the previous
        // match's frozen frame doesn't linger and no piece/ghost shows during the 3-2-1
        // (web nulls its render state during countdown; pieces appear only once PLAYING ticks).
        if (screen == DisplayScreen.GAME) { board.clear(); configureBoards() }
        if (screen == DisplayScreen.LOBBY) board.clear()
        // View + render-thread lifecycle on Main, in one block so their order holds.
        // Only render the board surface during GAME/RESULTS; hiding it in the lobby
        // stops its render thread (the surface is destroyed) and saves the GPU.
        //
        // Stop the render thread BEFORE hiding: tearing the SurfaceView down while the thread
        // still holds a dequeued buffer stalls the main thread on return-to-lobby (see
        // stopRenderThread), so the lobby wouldn't paint for ~1-2s.
        runOnMain {
            if (screen == DisplayScreen.LOBBY) board.stopRenderThread()
            board.visibility = if (screen == DisplayScreen.LOBBY) View.GONE else View.VISIBLE
            // Keep the TV awake for the whole match (COUNTDOWN+PLAYING = DisplayScreen.GAME);
            // the TV itself gets no input, so without this the screensaver can fire mid-game.
            // Mirrors the web wake lock (acquire on countdown, release on results/lobby).
            board.keepScreenOn = (screen == DisplayScreen.GAME)
        }
        _state.value = _state.value.copy(
            screen = screen,
            countdown = if (screen == DisplayScreen.LOBBY) null else _state.value.countdown,
        )
    }

    override fun roomReady(room: String, joinUrl: String) {
        this.room = room
        this.joinUrl = joinUrl
        // The relay confirmed the room (`created`, or `joined` after a rejoin), so the
        // QR is trustworthy again — this is the ONLY place that clears the pending dim.
        _state.value = _state.value.copy(lobby = buildLobby(), qrPending = false)
    }

    override fun updateLobby(players: List<PlayerRecord>, hostPeerIndex: Int?) {
        roster = players
        hostSlot = hostPeerIndex?.let { players.firstOrNull { p -> p.peerIndex == it }?.colorSlot }
        _state.value = _state.value.copy(lobby = buildLobby())
    }

    override fun showCountdown(value: CountdownValue) {
        val ui = when (value) {
            is CountdownValue.Number -> UiCountdownValue.Number(value.n)
            CountdownValue.Go -> UiCountdownValue.Go
        }
        _state.value = _state.value.copy(countdown = ui)
    }

    override fun renderSnapshot(snapshot: GameSnapshot) {
        board.submitSnapshot(snapshot)
        // Real gameplay frames mean the 3/2/1/GO sequence is over, so dismiss the
        // overlay. (During COUNTDOWN the engine isn't ticked, so the only snapshot
        // pushed is the one static frame at countdown start, which precedes the
        // first showCountdown — clearing a null/stale countdown there is harmless.)
        if (_state.value.countdown != null) {
            _state.value = _state.value.copy(countdown = null)
        }
    }

    override fun showResults(results: List<ResultEntry>) {
        _state.value = _state.value.copy(
            results = results.map {
                ResultCard(
                    playerId = it.playerId,
                    rank = it.rank,
                    name = it.playerName ?: resources.getString(R.string.player),
                    colorIndex = it.colorIndex,
                    lines = it.lines,
                    level = it.level,
                    newPlayer = it.newPlayer,
                )
            },
            countdown = null,
        )
    }

    // ── Audio: ExoPlayer is single-threaded and belongs to Main ───────────────

    override fun playCountdownBeep(go: Boolean) {
        runOnMain { if (go) music.playGoTone() else music.playCountdownBeep() }
    }

    override fun startMusic() { runOnMain { music.start() } }
    override fun stopMusic() { runOnMain { music.stop() } }
    override fun pauseMusic() { runOnMain { music.pause() } }
    override fun resumeMusic() { runOnMain { music.resume() } }

    override fun setMuted(muted: Boolean) {
        runOnMain { music.setMuted(muted) }
        // The switch state is ours, not ExoPlayer's, so it publishes without waiting for
        // Main — and it must not read music.isMuted, which is only valid over there.
        setMutedState(muted) // reflect in the pause-overlay switch
    }

    override fun handleGameEvent(event: GameEvent) {
        board.onGameEvent(event)
    }

    override fun setDisconnected(playerId: Int, joinUrl: String?) {
        board.setDisconnected(playerId, joinUrl)
    }

    override fun setPaused(paused: Boolean) {
        // `muted` comes from our own last-published value, not music.isMuted: reading
        // ExoPlayer from the game thread is exactly what runOnMain exists to avoid, and
        // setMuted keeps this field in step anyway.
        _state.value = _state.value.copy(paused = paused)
    }

    /** Reflect a mute toggle (from the pause-overlay switch) in the UI immediately. */
    fun setMutedState(muted: Boolean) {
        _state.value = _state.value.copy(muted = muted)
    }

    /** Direct QR-pending control for the Activity's pause/resume hooks (see
     *  MainActivity.onPause); link-state transitions set it via setConnectionState. */
    fun setQrPending(pending: Boolean) {
        _state.value = _state.value.copy(qrPending = pending)
    }

    /** No players seated: the relay room is memberless and dies with our socket. */
    fun lobbyIsEmpty(): Boolean = roster.isEmpty()

    /** Drop the room card so the next foreground presents like a fresh open — blank
     *  card, then the new room's QR — instead of a dimmed stale code that swaps once
     *  the rejoin bounces. Paired with RelayClient.unpinRoom (see MainActivity.onStop);
     *  mirrors appletv DisplayModel.appDidEnterBackground. */
    fun clearRoom() {
        room = ""
        joinUrl = ""
        roster = emptyList()
        hostSlot = null
        // Blank card, not a dimmed stale one.
        _state.value = _state.value.copy(lobby = buildLobby(), qrPending = false)
    }

    fun setConnectionState(state: RelayTransport.ConnectionState, reconnectAttempt: Int = 0) {
        // Any non-CLOSED transition (a fresh/re-established link) clears a stale terminal
        // "replaced" flag. onReplaced sets it right after this posts CLOSED, so a CLOSED
        // transition preserves whatever was there.
        _state.value = _state.value.copy(
            connection = state,
            reconnectAttempt = reconnectAttempt,
            replaced = if (state == RelayTransport.ConnectionState.CLOSED) _state.value.replaced else false,
            // Any link loss makes the shown QR untrusted. OPEN does NOT clear it —
            // the socket opens before the relay answers the join, and a "Room not
            // found" bounce swaps the room; only roomReady re-confirms.
            qrPending = if (state == RelayTransport.ConnectionState.OPEN) _state.value.qrPending else true,
        )
    }

    /** Terminal slot-0 eviction (relay close 4000): another display took over this room. */
    fun setReplaced() {
        _state.value = _state.value.copy(replaced = true)
    }

    private fun configureBoards() {
        val seats = roster.map { SeatMeta(it.peerIndex, it.playerName, it.colorSlot, it.startLevel) }
        val w = if (board.width > 0) board.width else resources.displayMetrics.widthPixels
        val h = if (board.height > 0) board.height else resources.displayMetrics.heightPixels
        board.setViewport(w, h, seats.size, seats)
    }

    private val resources get() = board.resources

    private fun buildLobby(): LobbyData {
        val host = joinUrl.substringAfter("://", "").substringBefore("/").ifEmpty {
            RelayConfig.controllerBaseUrl.substringAfter("://")
        }
        return LobbyData(
            joinHost = "$host/",
            joinCode = room,
            joinUrl = joinUrl.ifEmpty { RelayConfig.controllerBaseUrl },
            players = roster.map { LobbyPlayer(it.peerIndex, it.playerName, it.colorSlot, it.startLevel) },
            hostColorIndex = hostSlot,
        )
    }
}

// Lobby-idle coordinator tick interval (the tick work there is 1s-granularity
// liveness/grace polling; see the render-clock loop in MainActivity.onCreate).
private const val LOBBY_TICK_MS = 250.0

// Post-entrance delay before warming the engine + audio (the lobby entrance
// animation runs ~950ms; don't compete with it for CPU).
private const val WARMUP_DELAY_MS = 1000L

// The one fade token for every screen, page, and overlay change (tvOS parity:
// its single 300ms token, shared with the board layer's fades).
private const val FADE_MS = 300

// The one screen/page transition (see DisplayChrome): a plain cross-fade, safe
// because every full-screen surface shares the plum backdrop. sizeTransform is
// OFF: every screen is fullscreen, and the GAME branch composes nothing, so the
// default SizeTransform would shrink-clip the outgoing screen toward 0x0.
private fun screenCrossfade(): ContentTransform =
    ContentTransform(
        targetContentEnter = fadeIn(tween(FADE_MS)),
        initialContentExit = fadeOut(tween(FADE_MS)),
        sizeTransform = null,
    )

// Pre-room lobby: shown from launch until the relay answers `created`. Empty
// joinUrl => blank QR panel; empty roster => empty player grid + "waiting for
// players". The create-failure overlay renders on top of this (web / tvOS parity).
private val WAITING_LOBBY = LobbyData(
    joinHost = "",
    joinCode = "",
    joinUrl = "",
    players = emptyList(),
    hostColorIndex = null,
)

/** Lobby-local page stack: About opens from the lobby ⓘ, Licenses drills in from
 *  About, and a Licenses row pushes that license's full text as its own page. */
internal sealed interface LobbyPage {
    data object Lobby : LobbyPage
    data object About : LobbyPage
    data object Licenses : LobbyPage
    data class LicenseText(val index: Int) : LobbyPage
}

@Composable
private fun HexStackerApp(
    board: BoardSurfaceView,
    model: UiModel,
    onStart: () -> Unit,
    onPlayAgain: () -> Unit,
    onNewGame: () -> Unit,
    onContinue: () -> Unit,
    onToggleMusic: () -> Unit,
    onReconnect: () -> Unit,
) {
    // About + Open Source Licenses are lobby-only local pages (not coordinator
    // screens). Force back to the lobby whenever the game leaves it so none of
    // them lingers over a countdown/results.
    var page by remember { mutableStateOf<LobbyPage>(LobbyPage.Lobby) }
    LaunchedEffect(model.screen) {
        if (model.screen != DisplayScreen.LOBBY) page = LobbyPage.Lobby
    }
    // Back steps back one level (license text -> Licenses -> About -> Lobby) via
    // the OnBackPressedDispatcher, which consumes the press. A manual Compose Back
    // key handler instead let one Back both close the page (on KeyDown) AND finish
    // the Activity (the dispatcher fires on KeyUp), a double-back to the launcher.
    BackHandler(enabled = page != LobbyPage.Lobby) {
        page = when (page) {
            is LobbyPage.LicenseText -> LobbyPage.Licenses
            LobbyPage.Licenses -> LobbyPage.About
            else -> LobbyPage.Lobby
        }
    }
    // During a game (COUNTDOWN + PLAYING) Back toggles pause instead of exiting.
    // Going through the dispatcher (not onKeyDown) is what keeps a single Back
    // from BOTH pausing and finishing the Activity. Disabled on the lobby/results,
    // so Back there falls through to the default finish() and exits to the
    // launcher (Android TV: Back must eventually reach the home screen).
    BackHandler(enabled = model.screen == DisplayScreen.GAME) { onContinue() }

    DisplayChrome(
        model = model,
        // z0: the live board (visible during GAME + RESULTS, behind overlays).
        board = { AndroidView(factory = { board }, modifier = Modifier.fillMaxSize()) },
        onStart = onStart,
        onPlayAgain = onPlayAgain,
        onNewGame = onNewGame,
        onContinue = onContinue,
        onToggleMusic = onToggleMusic,
        onReconnect = onReconnect,
        page = page,
        onOpenAbout = { page = LobbyPage.About },
        onOpenLicenses = { page = LobbyPage.Licenses },
        onOpenLicense = { index -> page = LobbyPage.LicenseText(index) },
    )
}

/**
 * The display's full visual tree for a given [UiModel], in z-order: the board
 * layer, the countdown scrim directly above it (beneath the screens, so screen
 * fades reveal already-dimmed boards), the active screen (lobby / results —
 * GAME shows only the board), and the additive overlays (pause and the
 * relay-link connection overlay) on top.
 *
 * This is the SINGLE SOURCE OF TRUTH for "what's on screen for this state", shared by:
 *  - the live app ([HexStackerApp]), which passes the real [BoardSurfaceView] as
 *    [board] and drives [page] from local state, and
 *  - the screenshot gallery ([ComposeScreenshotTest]), which passes a baked board
 *    bitmap and a constructed [UiModel].
 * So the gallery shots render the real layering + the real derived logic (e.g. the
 * reconnect overlay stacked over the waiting lobby) instead of a hand-assembled
 * reconstruction that could silently drift from the app.
 */
@Composable
internal fun DisplayChrome(
    model: UiModel,
    board: @Composable () -> Unit,
    onStart: () -> Unit = {},
    onPlayAgain: () -> Unit = {},
    onNewGame: () -> Unit = {},
    onContinue: () -> Unit = {},
    onToggleMusic: () -> Unit = {},
    onReconnect: () -> Unit = {},
    // Lobby-local page (About / Licenses / license text). Hoisted so the host owns
    // Back handling + focus; the screenshot test drives it via the same parameter.
    page: LobbyPage = LobbyPage.Lobby,
    onOpenAbout: () -> Unit = {},
    onOpenLicenses: () -> Unit = {},
    onOpenLicense: (Int) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize()) {
        board()

        // Countdown 3-2-1-GO, INSERTED COMPLETE (no enter fade) BENEATH the
        // screen layer: match start reads as a fade-through — the outgoing
        // lobby/results fades out above the already-dimmed boards, so they
        // never show undimmed (tvOS parity: the countdown composite sits under
        // the exiting screen on a static z-order). The exit still fades: the
        // scrim lifts off the running boards. Hold the last non-null value so
        // that exit keeps rendering it. (The dismissal rides the first PLAYING
        // snapshot — GO + the coordinator's ~500ms hold — so the scrim never
        // lifts before gameplay actually renders.)
        var lastCountdown by remember { mutableStateOf(model.countdown) }
        model.countdown?.let { lastCountdown = it }
        AnimatedVisibility(
            visible = model.countdown != null,
            enter = EnterTransition.None,
            exit = fadeOut(tween(FADE_MS)),
        ) {
            lastCountdown?.let { CountdownOverlay(value = it) }
        }

        // The relay-link overlay outranks the pause overlay below it: both are
        // full-screen scrims, so stacking them doubles the dim (the web fadeHides
        // the pause overlay when the reconnect overlay comes up for the same
        // reason). paused survives underneath, so the pause overlay fades back in
        // when the link recovers.
        val connectionVisible = model.connection == RelayTransport.ConnectionState.RECONNECTING ||
            model.connection == RelayTransport.ConnectionState.CLOSED

        // One dissolve for every screen/page swap: LOBBY / GAME / RESULTS and the
        // window background all share the plum backdrop, so a uniform cross-fade
        // reads clean everywhere (the web's per-screen timings are not mirrored).
        // The lobby replays its own entrance stagger whenever it re-enters.
        AnimatedContent(
            targetState = model.screen,
            // Always fullscreen: the GAME branch composes nothing, so the
            // container size must not follow the content (see also the disabled
            // sizeTransform in screenCrossfade).
            modifier = Modifier.fillMaxSize(),
            transitionSpec = { screenCrossfade() },
            label = "screen",
        ) { screen ->
            when (screen) {
                // About / Licenses / license text each replace the lobby chrome (rather
                // than layering over it) so D-pad focus can't escape back to the buttons
                // underneath. The backdrop (brand fill + falling-piece ambient with the
                // accent vignette) sits BENEATH the page cross-fade, so page swaps fade
                // only their content over a continuous background (tvOS parity).
                DisplayScreen.LOBBY -> Box(Modifier.fillMaxSize().background(Tokens.bgPrimary)) {
                    LobbyBackground(Modifier.fillMaxSize(), active = true)
                    AnimatedContent(
                        targetState = page,
                        modifier = Modifier.fillMaxSize(),
                        transitionSpec = { screenCrossfade() },
                        label = "lobbyPage",
                    ) { p ->
                        when (p) {
                            is LobbyPage.LicenseText ->
                                LicenseTextScreen(entries = rememberLicenseEntries(), index = p.index)
                            LobbyPage.Licenses ->
                                LicensesScreen(entries = rememberLicenseEntries(), onOpenLicense = onOpenLicense)
                            LobbyPage.About -> AboutScreen(onOpenLicenses = onOpenLicenses)
                            LobbyPage.Lobby ->
                                // Render the lobby scaffold even before the room exists (model.lobby
                                // still null): a waiting lobby with a blank QR, so the create-failure
                                // overlay sits on top of the lobby (web / tvOS parity) instead of a
                                // bare screen. roomReady swaps in the real room + QR.
                                LobbyScreen(
                                    data = model.lobby ?: WAITING_LOBBY,
                                    onStart = onStart,
                                    qrPending = model.qrPending,
                                    onOpenAbout = onOpenAbout,
                                )
                        }
                    }
                }
                DisplayScreen.RESULTS -> ResultsScreen(
                    results = model.results,
                    hostColorIndex = model.lobby?.hostColorIndex,
                    onPlayAgain = onPlayAgain,
                    onNewGame = onNewGame,
                )
                DisplayScreen.GAME -> Unit // board only; the countdown layers on top below
            }
        }

        // Additive overlays on top of any screen. Content keeps rendering through
        // the exit fade: the pause fields stay valid, so read them directly.
        // Callbacks are gated on visibility (the web's .closing pointer-events
        // guard): a fading-out overlay keeps D-pad focus for the exit fade, and an
        // un-gated CONTINUE would re-pause the game it just resumed on a double press.
        val pauseVisible = model.paused && model.screen == DisplayScreen.GAME && !connectionVisible
        AnimatedVisibility(
            visible = pauseVisible,
            enter = fadeIn(tween(FADE_MS)),
            exit = fadeOut(tween(FADE_MS)),
        ) {
            PauseOverlay(
                hostColorIndex = model.lobby?.hostColorIndex,
                musicOn = !model.muted,
                onToggleMusic = { if (pauseVisible) onToggleMusic() },
                onContinue = { if (pauseVisible) onContinue() },
                onNewGame = { if (pauseVisible) onNewGame() },
            )
        }

        // Topmost: the display's own relay-link overlay (covers everything when our
        // connection to the relay drops). Hold the last overlay-worthy state so the
        // exiting overlay keeps its content through the fade-out instead of
        // recomposing to nothing when the link reopens.
        var lastConnection by remember { mutableStateOf(model.connection) }
        var lastReplaced by remember { mutableStateOf(model.replaced) }
        var lastReconnectAttempt by remember { mutableStateOf(model.reconnectAttempt) }
        if (connectionVisible) {
            lastConnection = model.connection
            lastReplaced = model.replaced
            lastReconnectAttempt = model.reconnectAttempt
        }
        AnimatedVisibility(
            visible = connectionVisible,
            enter = fadeIn(tween(FADE_MS)),
            exit = fadeOut(tween(FADE_MS)),
        ) {
            when (lastConnection) {
                RelayTransport.ConnectionState.RECONNECTING ->
                    ConnectionOverlay(
                        disconnected = false,
                        // Gated like the pause callbacks: RECONNECT stays focusable
                        // through the exit fade, and firing it against the
                        // just-recovered link would re-kick the reconnect machinery.
                        onReconnect = { if (connectionVisible) onReconnect() },
                        attempt = lastReconnectAttempt,
                        maxAttempts = RelayConfig.MAX_RECONNECT_ATTEMPTS,
                    )
                RelayTransport.ConnectionState.CLOSED ->
                    // A "replaced" eviction is terminal: show DISCONNECTED with no RECONNECT
                    // button (re-arming reconnect would only be evicted again), mirroring the
                    // web dropping the reconnect affordance in that state.
                    if (lastReplaced) ConnectionOverlay(disconnected = true, showReconnect = false)
                    else ConnectionOverlay(
                        disconnected = true,
                        onReconnect = { if (connectionVisible) onReconnect() },
                        hostColorIndex = model.lobby?.hostColorIndex,
                    )
                else -> Unit
            }
        }
    }
}
