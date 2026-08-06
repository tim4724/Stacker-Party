package com.hexstacker.tv.ui

import android.graphics.Bitmap
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Density
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R
import kotlinx.coroutines.delay
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 180px tile of grayscale noise (the web bakes the equivalent from an SVG
 * feTurbulence data URI). Seeded xorshift (same seed as the tvOS tile) so
 * screenshot captures stay byte-stable across launches. Same seed, but no longer the
 * same image as tvOS, which still writes the raw byte — the argument below applies
 * there too, so `ResultsView.swift` should follow.
 *
 * Deviation is kept to a QUARTER of the full 0..255 swing. This is a dither, so it
 * only has to cover the ~1 level of quantisation it is breaking up; the full-range
 * version read as visible grain rather than dither, and specifically as BLUE grain,
 * because `Overlay` scales each pixel's perturbation by the backdrop and the plum
 * backdrop is bluest. (The web's feTurbulence is fractal noise clustered around
 * mid-grey, not the uniform white noise a raw PRNG byte gives, so the wide swing was
 * never faithful either.) Measured: +-3 levels before, +-0.6 after.
 */
private val noiseBrush: ShaderBrush by lazy {
    val side = 180
    var state = -0x61C8864680B583EBL // 0x9E3779B97F4A7C15
    val pixels = IntArray(side * side)
    for (i in pixels.indices) {
        state = state xor (state shl 13)
        state = state xor (state ushr 7)
        state = state xor (state shl 17)
        val v = 128 + (((state and 0xFF).toInt() - 128) shr 2)
        pixels[i] = (0xFF shl 24) or (v shl 16) or (v shl 8) or v
    }
    val bitmap = Bitmap.createBitmap(pixels, side, side, Bitmap.Config.ARGB_8888)
    ShaderBrush(ImageShader(bitmap.asImageBitmap(), TileMode.Repeated, TileMode.Repeated))
}

/**
 * The results backdrop (scrim + winner glow + dither), rasterised ONCE per
 * (size, winner colour) instead of once per frame.
 *
 * All three layers are constant for as long as the screen is up, but every entrance
 * frame and every D-pad focus change damages the full screen, and HWUI re-rasterises
 * whatever sits under a damaged region — so the whole recipe was re-shaded per frame.
 * On a Google TV Streamer (PowerVR Rogue GE9215) that measured **19.3 ms per frame**,
 * over the entire 16.67 ms budget on its own, before a single row was drawn: the
 * radial costs ~4 ms and the tiled-noise OVERLAY pass ~13 ms, because a separable
 * blend mode against a full-screen shader is the worst case for a tile-based deferred
 * GPU. Blitting the baked result instead costs 2.7 ms (`BackdropPerfTest`), which is
 * what turns the results entrance and its focus moves back into 60 fps frames.
 *
 * Baked at 1:1, as the lobby vignette ([LobbyBackground]'s GlowCache) also is: a
 * dither only does anything at destination resolution, so neither backdrop can be
 * cached at reduced size.
 *
 * The one divergence: the OVERLAY blend is baked against the scrim alone, whereas it
 * used to blend against the scrim already composited over the frozen board showing
 * through the scrim's 12% transparency. That shifts the dither by a fraction of a
 * level at 5% alpha, and leaves its de-banding job over the gradient untouched.
 */
private class BackdropCache {
    private var cached: ImageBitmap? = null
    private var cachedW = 0
    private var cachedH = 0
    private var cachedGlow: Color = Color.Unspecified

    fun get(scope: DrawScope, winnerGlow: Color): ImageBitmap? {
        val w = scope.size.width.roundToInt()
        val h = scope.size.height.roundToInt()
        if (w <= 0 || h <= 0) return null
        cached?.let { if (w == cachedW && h == cachedH && winnerGlow == cachedGlow) return it }
        cachedW = w
        cachedH = h
        cachedGlow = winnerGlow
        return render(scope, w, h, winnerGlow).also { cached = it }
    }

    /** Replays the ORIGINAL draw calls into an offscreen bitmap, so the recipe stays
     *  single-sourced rather than re-derived against a second graphics API. */
    private fun render(scope: DrawScope, w: Int, h: Int, winnerGlow: Color): ImageBitmap {
        val image = ImageBitmap(w, h)
        CanvasDrawScope().draw(
            density = Density(scope.density, scope.fontScale),
            layoutDirection = scope.layoutDirection,
            canvas = androidx.compose.ui.graphics.Canvas(image),
            size = Size(w.toFloat(), h.toFloat()),
        ) {
            drawRect(Tokens.overlayBg)
            val cx = size.width * 0.5f
            val cy = size.height * 0.3f
            drawRect(
                Brush.radialGradient(
                    colors = listOf(winnerGlow, Color.Transparent),
                    center = Offset(cx, cy),
                    // web: 60% of the farthest-corner distance from the glow center
                    radius = 0.6f * hypot(max(cx, size.width - cx), max(cy, size.height - cy)),
                ),
            )
            // Anti-banding dither (web #results-screen::before): the low-alpha
            // radial above bands visibly on 8-bit panels; tiled grayscale noise
            // at 0.05 with overlay blending breaks the bands perceptually.
            drawRect(noiseBrush, alpha = 0.05f, blendMode = BlendMode.Overlay)
        }
        return image
    }
}

/**
 * Results overlay (web `renderResults` / `#results-screen`, tvOS `buildResults`).
 * Ranked rows over the frozen board: winner radial glow, player-colored rank +
 * name, lines/level stats, recessed-socket late-joiner rows. NO title/heading (web
 * `#results-screen` is just the list + buttons, no logo). The PLAY AGAIN primary
 * CTA is host-tinted (web `applyHostTint`). No anti-misclick gate on the TV (a
 * couch remote, not a phone): buttons are live and focusable immediately.
 *
 * Stateless: [results] from the coordinator's `showResults`, [hostColorIndex] the
 * current host's color slot; [onPlayAgain] = `remoteStartMatch()`, [onNewGame] =
 * `remoteReturnToLobby()`.
 */
@Composable
fun ResultsScreen(
    results: List<ResultCard>,
    hostColorIndex: Int?,
    onPlayAgain: () -> Unit,
    onNewGame: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sorted = remember(results) { results.sortedBy { it.rank ?: 999 } }
    val solo = sorted.size == 1
    val winnerGlow = sorted.firstOrNull()?.colorIndex
        ?.let { playerColor(it).copy(alpha = 0.08f) }
        ?: Color(0xFFFFD700).copy(alpha = 0.06f) // default gold #ffd700 @ 0.06

    val playAgainFocus = remember { FocusRequester() }
    // Buttons are live immediately — no anti-misclick gate on the TV. Grab D-pad
    // focus for the primary CTA on entry.
    LaunchedEffect(Unit) { playAgainFocus.requestFocus() }

    // Buttons fade in with the list (web .result-actions fade, matching the 0.4s
    // row stagger duration; no per-row delay). Reduce Motion shows them settled
    // (web results.css forces this gate open under prefers-reduced-motion).
    val reduceMotion = LocalReduceMotion.current
    val buttonsEnter = remember { Animatable(if (reduceMotion) 1f else 0f) }
    if (!reduceMotion) LaunchedEffect(Unit) { buttonsEnter.animateTo(1f, tween(400)) }

    val backdrop = remember { BackdropCache() }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .drawBehind {
                val image = backdrop.get(this, winnerGlow) ?: return@drawBehind
                drawImage(image)
            },
    ) {
        val vp = Vp(maxWidth.value, maxHeight.value)
        Column(
            Modifier
                .fillMaxSize()
                .padding(horizontal = (vp.wDp * 0.05f).dp, vertical = (vp.hDp * 0.05f).dp),
            // No wordmark on results (matches web #results-screen); center the list +
            // buttons as a group with a gap between them.
            verticalArrangement = Arrangement.spacedBy(vp.vhDp(24f, 3f, 48f), Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                // Web #results-list: width 90%, max-width 860px.
                Modifier.widthIn(max = vp.vwDp(0f, 90f, 860f)).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(vp.vhDp(8f, 1f, 16f)),
            ) {
                sorted.forEachIndexed { i, res ->
                    // Keyed like LobbyScreen's PlayerGrid: late joiners append to `sorted` at
                    // runtime, and the key keeps each row's entrance Animatable with its player.
                    key(res.playerId) {
                        ResultRow(res = res, index = i, solo = solo, vp = vp)
                    }
                }
            }

            Row(
                Modifier.graphicsLayer {
                    alpha = buttonsEnter.value
                    // No offscreen buffer (see LobbyScreen's EntranceBand): PLAY AGAIN
                    // is focused during this fade and its ring + 1.06 scale overflow
                    // the Row bounds, which the Auto strategy's alpha buffer clips.
                    compositingStrategy = CompositingStrategy.ModulateAlpha
                },
                horizontalArrangement = Arrangement.spacedBy(vp.vwDp(12.8f, 1.5f, 24f)),
            ) {
                ChromeButton(
                    text = stringResource(R.string.play_again),
                    primary = true,
                    tint = hostTint(hostColorIndex), // web tints the primary CTA with the host color (applyHostTint)
                    focusRequester = playAgainFocus,
                    fontSize = vp.vhSp(17.6f, 2.4f, 27.2f),
                    contentPadding = PaddingValues(
                        horizontal = vp.vwDp(24f, 3f, 48f),
                        vertical = vp.vhDp(14.4f, 2f, 27.2f),
                    ),
                    minWidth = vp.vhDp(260f, 34f, 420f),
                    onClick = onPlayAgain,
                )
                ChromeButton(
                    text = stringResource(R.string.new_game),
                    primary = false,
                    tint = Tokens.accentPrimary,
                    fontSize = vp.vhSp(17.6f, 2.4f, 27.2f),
                    contentPadding = PaddingValues(
                        horizontal = vp.vwDp(24f, 3f, 48f),
                        vertical = vp.vhDp(14.4f, 2f, 27.2f),
                    ),
                    minWidth = vp.vhDp(260f, 34f, 420f),
                    onClick = onNewGame,
                )
            }
        }
    }
}

@Composable
private fun ResultRow(res: ResultCard, index: Int, solo: Boolean, vp: Vp) {
    val shape = RoundedCornerShape(Tokens.radiusCard) // .result-row 20px (A2)
    // Hoisted so they can be used inside non-composable lambdas / branches below.
    val lateJoinerRank = stringResource(R.string.late_joiner_rank) // DisplayUI '–' rank
    val playerFallback = stringResource(R.string.player)
    val playerCol = res.colorIndex?.let { playerColor(it) }
    val rankSize = vp.vhSp(24f, 3f, 44.8f) // .result-rank/.result-name clamp(1.5rem,3vh,2.8rem)
    val statsSize = vp.vhSp(19.2f, 2.6f, 35.2f) // .result-stats clamp(1.2rem,2.6vh,2.2rem)
    val statsStyle = AppType.resultStats.copy(fontSize = statsSize, color = Tokens.textSecondary)
    val gap = vp.px(20f) // .result-row gap 1.25rem

    // Stagger entrance: fade + slide up, delay 0.2 + i*0.08 s. Reduce Motion
    // renders the row settled (decorative entrance).
    val reduceMotion = LocalReduceMotion.current
    val enter = remember(index) { Animatable(if (reduceMotion) 1f else 0f) }
    if (!reduceMotion) LaunchedEffect(index) {
        delay((200L + index * 80L))
        enter.animateTo(1f, tween(400))
    }

    // Borderless card matching the lobby's tonal cards (web .result-row A2:
    // bg-card + --shadow-sm); late joiners get the recessed socket treatment
    // (.result-row--joining: no shadow) instead of a dashed rim.
    val base = Modifier
        .fillMaxWidth()
        .graphicsLayer {
            alpha = enter.value * if (res.newPlayer) 0.75f else 1f
            translationY = (1f - enter.value) * 7.5.dp.toPx()
        }

    val bordered = if (res.newPlayer) {
        base
            .clip(shape)
            .background(Tokens.socketEmpty, shape)
            .border(0.5.dp, Tokens.hairlineFaint, shape)
    } else {
        base
            .shadowSm(Tokens.radiusCard)
            .clip(shape)
            .background(Tokens.bgCard, shape)
    }

    Row(
        // .result-row padding: left clamp(0.7rem,1.3vw,1.3rem), right
        // clamp(1.2rem,2.4vw,2.4rem), vertical clamp(0.8rem,1.6vh,1.5rem).
        bordered.padding(
            PaddingValues(
                start = vp.vwDp(11.2f, 1.3f, 20.8f),
                end = vp.vwDp(19.2f, 2.4f, 38.4f),
                top = vp.vhDp(12.8f, 1.6f, 24f),
                bottom = vp.vhDp(12.8f, 1.6f, 24f),
            ),
        ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!solo) {
            Text(
                text = if (res.newPlayer) lateJoinerRank else res.rank?.toString().orEmpty(),
                style = AppType.resultRank.copy(fontSize = rankSize, color = playerCol ?: Tokens.textSecondary),
                modifier = Modifier.widthIn(min = vp.px(24f)), // web min-width 1ch (~24px)
            )
            Spacer(Modifier.width(gap))
        }
        Text(
            text = res.name.ifEmpty { playerFallback },
            style = AppType.resultName.copy(fontSize = rankSize, color = playerCol ?: Tokens.textSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(gap))
        if (res.newPlayer) {
            Text(
                text = stringResource(R.string.new_player),
                style = statsStyle,
            )
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(vp.px(24f))) { // .result-stats gap 1.5rem
                Text(
                    text = pluralStringResource(R.plurals.n_lines, res.lines ?: 0, res.lines ?: 0),
                    style = statsStyle,
                )
                Text(
                    text = stringResource(R.string.level_n, res.level ?: 1),
                    style = statsStyle,
                )
            }
        }
    }
}

@Preview(widthDp = 960, heightDp = 540)
@Composable
private fun ResultsPreview() {
    ResultsScreen(
        results = listOf(
            ResultCard(0, 1, "ALEX", 0, 12, 4),
            ResultCard(1, 2, "SAM", 4, 8, 3),
            ResultCard(2, null, "JORDAN", 6, null, null, newPlayer = true),
        ),
        hostColorIndex = 0,
        onPlayAgain = {},
        onNewGame = {},
    )
}
