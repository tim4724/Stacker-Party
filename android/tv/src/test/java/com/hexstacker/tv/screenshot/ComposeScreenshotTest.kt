package com.hexstacker.tv.screenshot

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.background
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.hexstacker.core.display.DisplayScreen
import com.hexstacker.core.net.RelayTransport
import com.hexstacker.tv.DisplayChrome
import com.hexstacker.tv.UiModel
import com.hexstacker.tv.ui.AboutScreen
import com.hexstacker.tv.ui.CountdownValue
import com.hexstacker.tv.ui.LicenseEntry
import com.hexstacker.tv.ui.LicensesScreen
import com.hexstacker.tv.ui.assembleLicenseList
import com.hexstacker.tv.ui.LobbyBackground
import com.hexstacker.tv.ui.LobbyData
import com.hexstacker.tv.ui.LobbyPlayer
import com.hexstacker.tv.ui.LobbyScreen
import com.hexstacker.tv.ui.PauseOverlay
import com.hexstacker.tv.ui.QrRenderer
import com.hexstacker.tv.ui.ResultCard
import com.hexstacker.tv.ui.Tokens
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Screenshot coverage for the Compose-for-TV display, for the cross-platform gallery.
 *
 * Every layered state (results, countdown, pause, the relay connection overlay, and
 * the create-room-failure overlay) renders through the app's real [DisplayChrome] —
 * the SAME composable [com.hexstacker.tv.MainActivity]'s `HexStackerApp` uses to lay
 * out the board, active screen, and overlays. The shot only constructs a [UiModel]
 * and hands `DisplayChrome` a baked board bitmap where the live app would hand it the
 * [com.hexstacker.tv.render.BoardSurfaceView]. So the shots exercise the real z-order
 * and the real derived logic (e.g. the reconnect overlay stacked over the waiting
 * lobby for a failed create) instead of a hand-assembled reconstruction that could drift.
 *
 * A few states stay as direct single-widget calls because they need a determinism
 * seam beyond the frozen ambient DisplayChrome takes: the lobby shots also inject a
 * frozen QR (async in the app); `licenses` injects a fixture dependency list (the real
 * list reads build-time AboutLibraries metadata not on the test classpath);
 * `pause_music` seeds the focused switch (real focus can't fire headless). None of
 * these reconstruct layering — each is one full-screen widget.
 *
 * All content data comes from the canonical cross-platform [GalleryFixtures] (the same
 * `HexCore.GalleryFixtures` the web and Apple TV galleries use, via QuickJS), so every
 * platform renders byte-identical rosters, join data, and results. The board layer is
 * the real [BoardFixtureRenderer].
 *
 * Runs headless on the JVM (no emulator) via Robolectric's NATIVE graphics mode +
 * Roborazzi. Rendered at the 1280x720 TV design viewport at hdpi (density 1.5) so the
 * PNGs come out at 1080p (1920x1080) with the same composition. These are record-only
 * smoke tests: capturing a frame asserts the composable renders without throwing, and
 * the PNGs land in `build/outputs/roborazzi/` for human review (regenerate with
 * `./gradlew :tv:recordRoborazziDebug`). They are NOT automated golden gates (no
 * goldens committed, `:tv:verifyRoborazziDebug` is not run), matching the repo rule
 * that UI regressions are caught via the gallery, not visual snapshots.
 *
 * Determinism: entrance/idle animations are frozen by disabling the compose test
 * clock's auto-advance and stepping a fixed amount, so infinite pulses (countdown
 * beat, lobby background) and time-gated reveals (the 1.5s results-button gate)
 * capture at a stable frame instead of a wall-clock-dependent one.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w960dp-h540dp-land-xhdpi") // 960x540dp @ 2.0 density = 1920x1080px
class ComposeScreenshotTest {

    @get:Rule
    val compose = createComposeRule()

    private val app get() = RuntimeEnvironment.getApplication()

    private fun shoot(name: String, settleMs: Long = 1_800L, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent(content)
        // Step past the entrance animations + the results 1.5s button gate to a fixed frame.
        compose.mainClock.advanceTimeBy(settleMs)
        compose.onRoot().captureRoboImage("$OUT/$name.png")
    }

    // Render a UiModel through the app's real DisplayChrome. `board` is the baked board
    // bitmap the live app would supply via BoardSurfaceView (null for lobby states,
    // where the app keeps the board hidden). This is the path every layered shot takes.
    private fun chromeShot(
        name: String,
        model: UiModel,
        board: Bitmap? = null,
    ) = shoot(name) {
        DisplayChrome(
            model = model,
            board = {
                if (board != null) {
                    Image(
                        bitmap = board.asImageBitmap(),
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.FillBounds,
                    )
                }
            },
            // Freeze the lobby ambient to the shared cross-platform fixture, exactly
            // like LobbyBackdrop below. Only the LOBBY branch of the chrome paints it,
            // but it costs nothing on the others and keeps every chromeShot capture
            // reproducible run-to-run.
            ambientPieces = GalleryFixtures.ambientPieces(),
        )
    }

    // The lobby backdrop DisplayChrome keeps beneath every lobby page (brand fill +
    // falling-piece ambient), with the ambient frozen to the shared cross-platform
    // fixture — the app's own ambient is live and random-seeded, so a capture of it
    // would differ every run. Same fixture chromeShot passes down.
    @Composable
    private fun LobbyBackdrop(content: @Composable () -> Unit) {
        Box(Modifier.fillMaxSize().background(Tokens.bgPrimary)) {
            LobbyBackground(
                Modifier.fillMaxSize(),
                active = true,
                fixedPieces = GalleryFixtures.ambientPieces(),
            )
            content()
        }
    }

    // Minimal lobby carrying just the host color, for the in-match overlays (pause /
    // results tint). The real UiModel keeps the lobby around through the whole match.
    private fun hostLobby(colorIndex: Int) = LobbyData(
        joinHost = "", joinCode = "", joinUrl = "", players = emptyList(), hostColorIndex = colorIndex,
    )

    // ── Lobby (direct: frozen QR + ambient background for a deterministic shot) ────

    private fun lobbyShot(name: String, count: Int, longNames: Boolean = false) {
        val join = GalleryFixtures.join
        val players = if (count == 0) emptyList() else GalleryFixtures.roster(count, longNames).map {
            LobbyPlayer(peerIndex = it.id, name = it.name, colorIndex = it.slot, level = it.level)
        }
        shoot(name) {
            // Frozen ambient via LobbyBackdrop so the lobby shots (and the web/tvOS
            // galleries) show identical falling pieces.
            LobbyBackdrop {
                LobbyScreen(
                    data = LobbyData(
                        joinHost = join.host,
                        joinCode = join.code,
                        joinUrl = join.qrText,
                        players = players,
                        hostColorIndex = if (players.isEmpty()) null else 0, // host is roster slot 0
                    ),
                    onStart = {},
                    // Inject a deterministic QR so the shot never races the async generator.
                    // Modules-only like the production rememberQrBitmap render.
                    qrOverride = QrRenderer.render(join.qrText, 480, light = 0x00000000), // crisp at 1080p
                    // Freeze the join line on the scan hint (web hint=1 / tvOS shotMode
                    // parity): the live crossfade never advances in a single captured frame.
                    scanHint = true,
                )
            }
        }
    }

    @Test fun lobby() = lobbyShot("lobby", 4)
    @Test fun lobby2p() = lobbyShot("lobby_2p", 2)
    @Test fun lobby8p() = lobbyShot("lobby_8p", 8)
    @Test fun lobbyLongNames() = lobbyShot("lobby_long_names", 4, longNames = true)
    @Test fun lobbyWaiting() = lobbyShot("lobby_waiting", 0)

    // ── Licenses (direct: injects a fixture dependency list) ──────────────────────

    // The fixture supplies only the dependency DATA (not the generated AboutLibraries
    // report, so the shot is deterministic and needs no build-time metadata on the
    // classpath). The display ORDER comes from the app's real assembleLicenseList, so
    // this shot renders through the same ordering the app runs — music + fonts lead,
    // deps sort alphabetically, QuickJS trails — and can't drift from it. The deps are
    // passed unsorted on purpose, to exercise that sort.
    @Test
    fun licenses() = shoot("licenses") {
        val deps = listOf(
            LicenseEntry("WebRTC SDK", "The WebRTC project authors", "The 3-Clause BSD License", null, "Copyright (c) 2011, The WebRTC project authors."),
            LicenseEntry("Compose UI", "The Android Open Source Project", "Apache License 2.0", null, "Apache License 2.0\n\n(full text...)"),
        )
        LobbyBackdrop {
            LicensesScreen(
                entries = assembleLicenseList(
                    deps = deps,
                    music = LicenseEntry("Lunar Joyride", "FoxSynergy", "CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/", null),
                    fonts = listOf(
                        LicenseEntry("Baloo 2", "Ek Type", "SIL Open Font License 1.1", null, "Copyright 2021 The Baloo 2 Project Authors"),
                        LicenseEntry("Orbitron", "The Orbitron Project Authors", "SIL Open Font License 1.1", null, "Copyright 2018 The Orbitron Project Authors"),
                    ),
                    quickJs = LicenseEntry("QuickJS", "Fabrice Bellard, Charlie Gordon et al.", "MIT License", null, "MIT License\n\n(full text...)"),
                ),
                onOpenLicense = {},
            )
        }
    }

    // ── About (direct: frozen ambient beneath, like the lobby shots) ──────────────

    // Two QR cards (Privacy / Imprint) + the licenses drill-in over the lobby
    // backdrop. The QR URLs derive from the locale (English default → /en/) and
    // labels come from resources.
    @Test
    fun about() = shoot("about") { LobbyBackdrop { AboutScreen(onOpenLicenses = {}) } }

    // ── Results (through DisplayChrome, over the real board layer) ────────────────

    private fun ResultsFixture.cards(): List<ResultCard> = entries.map {
        ResultCard(
            playerId = it.playerId,
            rank = it.rank,
            name = it.playerName,
            colorIndex = it.colorIndex,
            lines = it.lines,
            level = it.level,
        )
    }

    // Results/connection shots keep the board VISIBLE the way production does:
    // MainActivity holds BoardSurfaceView visible for every screen except the lobby,
    // and these overlays draw the translucent (0.88) overlayBg scrim so the frozen
    // boards show through faintly — matching web/tvOS's frosted-glass backdrop (minus
    // their blur, which a SurfaceView can't get).
    @Test
    fun results() = chromeShot(
        "results",
        UiModel(screen = DisplayScreen.RESULTS, results = GalleryFixtures.results(4).cards(), lobby = hostLobby(0)),
        board = boardLayer("lv1"),
    )

    @Test
    fun resultsSolo() = chromeShot(
        "results_solo",
        UiModel(screen = DisplayScreen.RESULTS, results = GalleryFixtures.results(1).cards(), lobby = hostLobby(0)),
        board = boardLayer("solo"),
    )

    // ── Countdown / pause (through DisplayChrome, over the real board layer) ───────

    /** Pre-game (empty) boards for the countdown seats, or a live variant snapshot. */
    private fun boardLayer(variant: String?): Bitmap {
        if (variant == null) {
            val seats = BoardFixtureRenderer.seats(GalleryFixtures.roster(4)) // fresh boards, lobby levels
            return BoardFixtureRenderer.render(app, seats)
        }
        val fx = GalleryFixtures.game(variant)
        val seats = BoardFixtureRenderer.seats(GalleryFixtures.roster(fx.variant.players), fx.variant.levels)
        return BoardFixtureRenderer.render(app, seats, fx.snapshot)
    }

    @Test
    fun countdown() = chromeShot(
        "countdown",
        UiModel(screen = DisplayScreen.GAME, countdown = CountdownValue.Number(3)),
        board = boardLayer(null), // 4 fresh/empty boards, roster(4) seat names
    )

    @Test
    fun pause() = chromeShot(
        "pause",
        UiModel(screen = DisplayScreen.GAME, paused = true, muted = false, lobby = hostLobby(0)),
        board = boardLayer("lv1"),
    )

    // Real focus events can't fire here (Robolectric's headless compose host never
    // gains window focus), so this seeds the switch's focused state through the
    // shot-only override — the same `focused` boolean the focus system drives, so the
    // styling is the genuine focused visual. Direct because that seed isn't a
    // production DisplayChrome/UiModel input.
    @Test
    fun pauseMusic() {
        val board = boardLayer("lv1")
        shoot("pause_music") {
            Box(Modifier.fillMaxSize()) {
                Image(
                    bitmap = board.asImageBitmap(),
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.FillBounds,
                )
                PauseOverlay(
                    hostColorIndex = 0,
                    musicOn = true,
                    onToggleMusic = {},
                    onContinue = {},
                    onNewGame = {},
                    musicFocusedForShot = true,
                )
            }
        }
    }

    // ── Connection overlay: lost room mid-game ────────────────────────────────────

    @Test
    fun connectionReconnecting() = chromeShot(
        "connection_reconnecting",
        // attempt 2 + MAX_RECONNECT_ATTEMPTS (from DisplayChrome) => "Attempt 2 of 5".
        UiModel(
            screen = DisplayScreen.GAME,
            connection = RelayTransport.ConnectionState.RECONNECTING,
            reconnectAttempt = 2,
        ),
        board = boardLayer("lv1"),
    )

    @Test
    fun connectionDisconnected() = chromeShot(
        "connection_disconnected",
        UiModel(
            screen = DisplayScreen.GAME,
            connection = RelayTransport.ConnectionState.CLOSED,
        ),
        board = boardLayer("lv1"),
    )

    // ── Create-room failure: no room yet ──────────────────────────────────────────
    // A failed first-launch create drives the same reconnect overlay as a lost room:
    // DisplayChrome falls the lobby back to WAITING_LOBBY (blank QR + empty player
    // grid) behind it — exactly the live create-failure path, not a reconstruction.
    // RECONNECTING = auto-retrying (counter starts at 1); CLOSED = exhausted.

    @Test
    fun createErrorRetry() = chromeShot(
        "create_error_retry",
        UiModel(
            screen = DisplayScreen.LOBBY,
            connection = RelayTransport.ConnectionState.RECONNECTING,
            reconnectAttempt = 1,
        ),
    )

    @Test
    fun createError() = chromeShot(
        "create_error",
        UiModel(
            screen = DisplayScreen.LOBBY,
            connection = RelayTransport.ConnectionState.CLOSED,
        ),
    )

    private companion object {
        // Roborazzi resolves relative paths from the module dir (the test working dir).
        const val OUT = "build/outputs/roborazzi"
    }
}
