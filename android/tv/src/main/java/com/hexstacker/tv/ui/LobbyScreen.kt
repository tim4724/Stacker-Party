package com.hexstacker.tv.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.hexstacker.core.render.Theme
import com.hexstacker.tv.R
import kotlinx.coroutines.launch
import kotlin.math.ceil
import kotlin.math.max

/**
 * Full lobby (web `#lobby-screen` / `updatePlayerList`, tvOS `buildLobby`):
 * HEX STACKER wordmark + PARTY subtitle, QR card, player-card grid, and the
 * host-tinted START button, rendered over the host chrome's lobby backdrop
 * (brand fill + falling-piece ambient). Stateless — [data] is supplied by the
 * integrator (players pre-sorted by join time); [onStart] fires
 * `remoteStartMatch()`.
 *
 * The QR bitmap is rendered once per join URL off-thread (see
 * [rememberLobbyQrBitmap]); pass [qrOverride] to inject a pre-rendered bitmap
 * instead.
 */
// Dim level for the QR card while the room awaits re-confirmation (matches tvOS).
private const val QR_PENDING_ALPHA = 0.4f

@Composable
fun LobbyScreen(
    data: LobbyData,
    onStart: () -> Unit,
    modifier: Modifier = Modifier,
    qrOverride: androidx.compose.ui.graphics.ImageBitmap? = null,
    // The relay link dropped and the room isn't re-confirmed yet: the shown QR/code
    // may point at a dead room (a rejoin can land in a fresh room), so dim the card
    // until the rejoin settles. Visual-only — no TV-only copy to invent.
    qrPending: Boolean = false,
    // When supplied, the top-right ⓘ becomes a focusable button that opens the
    // About screen (Privacy / Imprint QR + Open Source Licenses); null keeps it a
    // plain, non-focusable glyph (previews / screenshot fixtures with no navigation).
    onOpenAbout: (() -> Unit)? = null,
    // Freezes the join line on the scan hint for a static screenshot (the live
    // crossfade never advances in a captured frame); production leaves it false.
    scanHint: Boolean = false,
) {
    val startFocus = remember { FocusRequester() }
    val generatedQr by rememberLobbyQrBitmap(data.joinUrl) // called unconditionally (Compose rule)
    // Blank QR while there's no room yet (empty joinUrl): the pre-room / create-failure
    // lobby shows an empty white QR panel, matching the web + tvOS displays.
    val qrBitmap = qrOverride ?: generatedQr?.takeIf { data.joinUrl.isNotBlank() }
    val hasPlayers = data.players.isNotEmpty()
    // The initial relay connect also flags pending (MainActivity treats any
    // non-OPEN link as pending), which used to dim the still-blank card
    // mid-entrance and pop it bright when the room confirmed. Only dim when
    // there is actually a QR/code on screen that could mislead (tvOS parity).
    val dimAlpha = if (qrPending && data.joinUrl.isNotBlank()) QR_PENDING_ALPHA else 1f

    // Seat D-pad focus on Start (the main action) on entry: the disabled Start is
    // still a stable focus target (ChromeButton gates the action, not the focus
    // node), so the engine doesn't grab the ⓘ in an empty lobby (tvOS parity).
    LaunchedEffect(Unit) { startFocus.requestFocus() }

    // Transparent: the host chrome owns the lobby backdrop (brand fill +
    // falling-piece ambient), shared with the About/Licenses pages so page
    // swaps fade only the content (tvOS parity). Screenshot fixtures wrap this
    // in the same backdrop with frozen pieces.
    Box(modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val vp = Vp(maxWidth.value, maxHeight.value)
            val overscan = Theme.Size.tvOverscan.toFloat() // TV title-safe, each edge
            val overscanH = (vp.wDp * overscan).dp
            val overscanV = (vp.hDp * overscan).dp

            Column(
                Modifier.fillMaxSize().padding(horizontal = overscanH, vertical = overscanV),
                verticalArrangement = Arrangement.SpaceEvenly,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // Title band — fadeDown. The pure wordmark centers exactly (A2:
                // the triad mark moved to the corner badge below).
                EntranceBand(startOffsetY = (-8).dp, durationMs = 600, delayMs = 0) {
                    Wordmark(mainSize = vp.vminSp(25.6f, 7f, 80f))
                }

                // Body band (web #lobby-body): the QR | grid row (#lobby-main)
                // with the join/hint line tucked close beneath it — fadeUp 0.15s.
                EntranceBand(startOffsetY = 8.dp, durationMs = 600, delayMs = 150) {
                    // Web --card-w clamp(150px, 36vmin, 350px): sized so a 16-char
                    // name (the platform-wide cap) fits at the full name size.
                    var cardW = vp.vminDp(150f, 36f, 350f)
                    // Web #qr-container calc(var(--card-w) + 40px): always a touch
                    // taller than the two-card column beside it (2:1 cards stack
                    // to cardW + gap).
                    var qrW = cardW + vp.px(40f)
                    // Slot bucket (web updatePlayerList's --cols): pad to 4 placeholder
                    // slots (8 at 4K widths), one row of 4 columns once 5+ are visible.
                    val placeholderSlots = if (vp.wDp >= 2400f) 8 else 4 // web: innerWidth >= 2400 ? 8 : 4
                    val visibleSlots = max(placeholderSlots, data.players.size).coerceAtMost(8)
                    val cols = if (visibleSlots > 4) 4 else 2
                    // Horizontal fit (web grid minmax(0,...) / tvOS LobbyMetrics):
                    // shrink QR + cards proportionally when the widest row (a 4-wide
                    // roster next to the QR) would overflow the overscan-safe width.
                    val gap = vp.vminDp(8f, 1.5f, 18f)
                    val rowW = qrW + vp.vminDp(16f, 3f, 40f) + (cardW + gap) * cols - gap
                    val budget = (vp.wDp * (1f - 2f * overscan)).dp
                    if (rowW > budget) {
                        val s = budget / rowW
                        cardW *= s
                        qrW *= s
                    }
                    Column(
                        verticalArrangement = Arrangement.spacedBy(vp.vminDp(10f, 2.2f, 22f)),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(vp.vminDp(16f, 3f, 40f)),
                        ) {
                            QrBlock(
                                qrBitmap = qrBitmap,
                                vp = vp,
                                qrW = qrW,
                                modifier = Modifier.alpha(dimAlpha),
                            )
                            PlayerGrid(
                                players = data.players,
                                vp = vp,
                                visibleSlots = visibleSlots,
                                cols = cols,
                                cardW = cardW,
                                gap = gap,
                            )
                        }
                        JoinLine(
                            joinHost = data.joinHost,
                            joinCode = data.joinCode,
                            vp = vp,
                            // The stale-room pending dim covers the code too (the
                            // line is what could mislead), matching the QR.
                            modifier = Modifier.alpha(dimAlpha),
                            startOnHint = scanHint,
                        )
                    }
                }

                // CTA band — fadeUp 0.45s.
                EntranceBand(startOffsetY = 8.dp, durationMs = 500, delayMs = 450) {
                    val ctaText = if (hasPlayers) {
                        pluralStringResource(R.plurals.start_n_players, data.players.size, data.players.size)
                    } else {
                        stringResource(R.string.waiting_for_players)
                    }
                    ChromeButton(
                        text = ctaText, // uppercased by ChromeButton (.btn text-transform)
                        primary = true,
                        tint = hostTint(data.hostColorIndex),
                        enabled = hasPlayers,
                        focusRequester = startFocus,
                        // Height matches the overlay action buttons (same font +
                        // vertical padding) so every button is a uniform height; the
                        // wider horizontal padding keeps the CTA a roomy pill.
                        fontSize = vp.vhSp(17.6f, 2.4f, 27.2f), // clamp(1.1rem,2.4vh,1.7rem)
                        contentPadding = PaddingValues(
                            horizontal = vp.vwDp(32f, 4f, 96f), // clamp(2rem,4vw,6rem)
                            vertical = vp.vhDp(14.4f, 2f, 27.2f), // clamp(0.9rem,2vh,1.7rem)
                        ),
                        onClick = onStart,
                    )
                }
            }

            // Triad corner badge — the mark's spot now that the h1 is the pure
            // wordmark (web .brand-badge, fadeIn 0.6s after 0.3s).
            BadgeFadeIn(
                Modifier
                    .align(Alignment.TopStart)
                    .padding(top = overscanV, start = overscanH),
            ) {
                TriadMark(Modifier.size(vp.vminDp(40f, 6.4f, 80f)))
            }

            // Top-right ⓘ: the entry to the About screen (Privacy / Imprint QR +
            // Open Source Licenses). Icon-only by design — no TV-only string to
            // invent. When navigation is wired it is focusable (D-pad Up from Start
            // reaches it); otherwise a plain glyph (previews / screenshot fixtures).
            InfoButton(
                onOpen = onOpenAbout,
                diameter = vp.vminDp(51f, 6f, 78f),
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = overscanV, end = overscanH),
            )
        }
    }
}

/**
 * Top-right ⓘ button — the lobby entry to the About screen. With [onOpen] it is a
 * focusable circular button (white focus ring, D-pad reachable above Start); without
 * it, a plain non-focusable glyph (previews / screenshot fixtures). Icon-only: the
 * universal info affordance needs no text, so there is no TV-only copy to mirror.
 */
@Composable
private fun InfoButton(
    onOpen: (() -> Unit)?,
    diameter: Dp,
    modifier: Modifier = Modifier,
) {
    var focused by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val ringFocused = onOpen != null && focused
    // Focus pops the disc slightly (tvOS InfoCircleStyle parity); press sinks
    // it back and deepens the recess (web .icon-btn:active).
    val scale by animateFloatAsState(
        targetValue = if (pressed) 1f else if (ringFocused) 1.06f else 1f,
        label = "infoButtonScale",
    )
    // Round utility button (A2 .icon-btn): recessed translucent disc + warm
    // hairline ring, not a card-colored chip.
    Box(
        modifier
            .size(diameter)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(CircleShape)
            .background(if (pressed) Tokens.socketBtnPressed else Tokens.socketBtn, CircleShape)
            .border(
                width = if (ringFocused) 1.5.dp else 0.5.dp,
                color = if (ringFocused) Tokens.white else Tokens.hairlineRing,
                shape = CircleShape,
            )
            .then(
                if (onOpen != null) {
                    Modifier
                        .onFocusChanged { focused = it.isFocused }
                        .clickable(
                            interactionSource = interaction,
                            indication = null,
                            onClick = onOpen,
                        )
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        // Drawn info glyph (dot + rounded stem) rather than a font letter, so it reads
        // as an icon and stays identical to the tvOS button regardless of the font.
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(diameter * 0.055f),
        ) {
            Box(
                Modifier
                    .size(diameter * 0.13f)
                    .background(Tokens.textPrimary, CircleShape),
            )
            Box(
                Modifier
                    .size(width = diameter * 0.13f, height = diameter * 0.3f)
                    .background(Tokens.textPrimary, RoundedCornerShape(percent = 50)),
            )
        }
    }
}

/**
 * Player-card grid: packs N players into the first N seats. The slot/column
 * bucket and sizing come from the caller (LobbyScreen computes them once,
 * shared with the QR row-fit; web `updatePlayerList` + `--cols`).
 *
 * A hand-rolled row/column grid, NOT LazyVerticalGrid: lazy containers clip
 * content to their bounds (the scrollable-viewport clip, applied even with
 * scrolling disabled), which cuts off the join-pop's scale overshoot on cards
 * along the grid's outer edge. The join-pop replays only for genuinely new
 * players, tracked by an explicit seen-set (web `lobbyKnownPlayers`):
 * `key(peerIndex)` alone is not enough, because keyed siblings only match
 * within the same Row, so a card pushed across a row boundary by a grid
 * reflow (5th player joins, someone leaves) would lose its composition state
 * and re-pop.
 */
@Composable
private fun PlayerGrid(players: List<LobbyPlayer>, vp: Vp, visibleSlots: Int, cols: Int, cardW: Dp, gap: Dp) {
    val rows = ceil(visibleSlots / cols.toFloat()).toInt()

    // Seen peerIndexes. Pruned to the live roster first, so a departed player's
    // index pops again if it is ever reassigned. Mutating a remembered set during
    // composition is safe here: both operations are idempotent per roster state.
    val knownPlayers = remember { mutableSetOf<Int>() }
    knownPlayers.retainAll(players.mapTo(mutableSetOf()) { it.peerIndex })

    Column(verticalArrangement = Arrangement.spacedBy(gap)) {
        for (row in 0 until rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                for (col in 0 until cols) {
                    val slot = row * cols + col
                    when {
                        slot >= visibleSlots -> Spacer(Modifier.width(cardW))
                        else -> {
                            val player = players.getOrNull(slot)
                            key(player?.peerIndex ?: "empty-$slot") {
                                if (player != null) {
                                    // add() is true only the first time this player is
                                    // composed; a reflowed (re-created) card skips the pop.
                                    val isNew = remember(player.peerIndex) { knownPlayers.add(player.peerIndex) }
                                    JoinPop(play = isNew) { PlayerCard(player, vp, cardW) }
                                } else {
                                    PlayerCard(null, vp, cardW)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** slotPopIn: scale 0.6→1 + fade, one back-out overshoot (peaks ~1.07 just
 *  past halfway) with the bezier's long tail as the settle — 0.5s
 *  cubic-bezier(0.34, 1.8, 0.64, 1), mirroring web display.css (keep in sync).
 *  The same curve drives the alpha, exactly like the CSS animation; past its
 *  overshoot the eased fraction exceeds 1, so the layer clamps it.
 *  [play] = false renders the card settled (a known player re-composed by a
 *  grid reflow must not re-pop). */
private val SlotPopEasing = CubicBezierEasing(0.34f, 1.8f, 0.64f, 1f)

@Composable
private fun JoinPop(play: Boolean, content: @Composable () -> Unit) {
    // Reduce Motion renders the card settled: the pop is decorative.
    val animate = play && !LocalReduceMotion.current
    val scale = remember { Animatable(if (animate) 0.6f else 1f) }
    val alpha = remember { Animatable(if (animate) 0f else 1f) }
    if (animate) LaunchedEffect(Unit) {
        launch { scale.animateTo(1f, tween(500, easing = SlotPopEasing)) }
        launch { alpha.animateTo(1f, tween(500, easing = SlotPopEasing)) }
    }
    Box(
        Modifier.graphicsLayer {
            scaleX = scale.value
            scaleY = scale.value
            this.alpha = alpha.value.coerceAtMost(1f)
            // alpha<1 with the default Auto strategy composites into an offscreen buffer
            // that CLIPS to the layer bounds — the 1.08 overshoot would lose its edges
            // mid-pop. ModulateAlpha applies alpha without a buffer (no clipping),
            // matching CSS opacity which never clips.
            compositingStrategy = CompositingStrategy.ModulateAlpha
        },
    ) { content() }
}

/** Plain fade-in for the corner brand badge (web .brand-badge: fadeIn 0.6s 0.3s).
 *  Reduce Motion renders it settled (decorative entrance). */
@Composable
private fun BadgeFadeIn(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val reduce = LocalReduceMotion.current
    val anim = remember { Animatable(if (reduce) 1f else 0f) }
    if (!reduce) LaunchedEffect(Unit) {
        anim.animateTo(1f, tween(durationMillis = 600, delayMillis = 300, easing = FastOutSlowInEasing))
    }
    Box(modifier.graphicsLayer { alpha = anim.value }) { content() }
}

/** fadeDown/fadeUp entrance: vertical offset → 0 with alpha 0 → 1, played once.
 *  Reduce Motion renders the band settled: the slide + stagger are exactly the
 *  class of motion the setting opts out of. */
@Composable
private fun EntranceBand(
    startOffsetY: Dp,
    durationMs: Int,
    delayMs: Int,
    content: @Composable () -> Unit,
) {
    val reduce = LocalReduceMotion.current
    val anim = remember { Animatable(if (reduce) 1f else 0f) }
    if (!reduce) LaunchedEffect(Unit) {
        anim.animateTo(1f, tween(durationMillis = durationMs, delayMillis = delayMs, easing = FastOutSlowInEasing))
    }
    Box(
        Modifier.graphicsLayer {
            alpha = anim.value
            translationY = startOffsetY.toPx() * (1f - anim.value)
            // No offscreen buffer (see JoinPop): a START button focused during the
            // entrance overflows the band bounds (focus scale + ring) and the Auto
            // strategy's alpha buffer would clip it while it slides in.
            compositingStrategy = CompositingStrategy.ModulateAlpha
        },
    ) { content() }
}

@Preview(widthDp = 960, heightDp = 540)
@Composable
private fun LobbyPreview() {
    Box(Modifier.fillMaxSize().background(Tokens.bgPrimary)) {
        LobbyBackground(Modifier.fillMaxSize(), active = true)
        LobbyPreviewContent()
    }
}

@Composable
private fun LobbyPreviewContent() {
    LobbyScreen(
        data = LobbyData(
            joinHost = "play.hexstacker.com/",
            joinCode = "WXYZ",
            joinUrl = "https://play.hexstacker.com/WXYZ",
            players = listOf(
                LobbyPlayer(0, "ALEX", 0, 3),
                LobbyPlayer(1, "SAM", 4, 1),
                LobbyPlayer(2, "JORDAN", 6, 5),
            ),
            hostColorIndex = 0,
        ),
        onStart = {},
    )
}
