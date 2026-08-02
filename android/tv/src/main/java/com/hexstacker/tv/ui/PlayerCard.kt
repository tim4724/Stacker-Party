package com.hexstacker.tv.ui

import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R
import com.hexstacker.tv.render.addRoundedHex
import kotlin.math.max

/**
 * One lobby seat — a tonal filled player card or a recessed empty socket
 * (web `.player-card` / `.player-card.empty` A2, tvOS `buildPlayerCard`).
 * 2.5:1 aspect (web display .player-card override; the controller card
 * stays 2:1); [cardW] sets the width, aspect ratio derives the height.
 *
 * Filled: borderless 20dp card, the player color mixed into the surface
 * (color-mix 20% into `--bg-card`) and carried by the name; a quiet recessed
 * "LEVEL n" pill under the name.
 * Empty: recessed socket — flat dark inset (`rgba(21,18,31,0.55)`) with a
 * hairline ring and a faint hex opening, breathing slowly. No text.
 */
@Composable
fun PlayerCard(
    player: LobbyPlayer?,
    vp: Vp,
    cardW: Dp,
    modifier: Modifier = Modifier,
) {
    // web display card radius calc(--card-w * 0.057): scales with the card
    // (10dp at the 175dp cap) so shrunken grids keep the same corner
    // character instead of looking rounder.
    val radius = cardW * 0.057f
    val shape = RoundedCornerShape(radius)
    // Web display override: .player-card .identity-name clamp(1.5rem,4.5vmin,2.4rem)
    // (display.css 10-foot sizes; the theme.css clamp is the phone's).
    val nameSize = vp.vminSp(24f, 4.5f, 38.4f)
    val levelSize = vp.vminSp(12f, 2f, 18.4f) // .card-level__* clamp(0.75rem,2vmin,1.15rem)
    val padH = vp.vminDp(8f, 1.4f, 14f) // half padding clamp(8px,1.4vmin,14px)

    if (player == null) {
        // Empty slot — recessed socket with a faint hex opening, breathing
        // slowly (@keyframes breathe: opacity 0.5 → 0.27 → 0.5 over 3.2s
        // ease-in-out). Only the hex breathes; pulsing the whole card read
        // as background flicker once the lobby cards grew (web parity).
        // Reduce Motion holds the hex at its bright value (web: the breathe
        // keyframes are the one animation theme.css gates behind
        // prefers-reduced-motion).
        val hexAlpha = if (LocalReduceMotion.current) {
            0.5f
        } else {
            val breathe = rememberInfiniteTransition(label = "socketBreathe")
            breathe.animateFloat(
                initialValue = 0.5f,
                targetValue = 0.27f,
                animationSpec = infiniteRepeatable(
                    animation = tween(1600, easing = LinearOutSlowInEasing),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "socketBreatheAlpha",
            ).value
        }
        Box(
            modifier
                .width(cardW)
                .aspectRatio(2.5f)
                .clip(shape)
                .background(Tokens.socketEmpty, shape)
                .border(0.5.dp, Tokens.hairlineFaint, shape),
            contentAlignment = Alignment.Center,
        ) {
            // Faint rounded-hex opening (web .player-card__opening, sized
            // clamp(28px,5.5vmin,56px) wide for 10-foot viewing).
            SocketOpening(Modifier.size(vp.vminDp(28f, 5.5f, 56f)).alpha(hexAlpha))
        }
        return
    }

    val color = playerColor(player.colorIndex)
    // Shrink-to-fit, the Compose twin of the web name fitter: measure the name
    // at its stylesheet size and scale it down only when it would overflow the
    // padded card, to the same 0.6 floor; past that the ellipsis takes over.
    val density = LocalDensity.current
    val baseNameStyle = AppType.cardName.copy(
        fontSize = nameSize,
        color = color,
        platformStyle = PlatformTextStyle(includeFontPadding = false),
    )
    val measurer = rememberTextMeasurer()
    val fittedNameSize = remember(player.name, nameSize, cardW, padH, density) {
        val availPx = with(density) { (cardW - padH * 2).toPx() }
        val fullPx = measurer.measure(
            AnnotatedString(player.name),
            style = baseNameStyle,
            softWrap = false,
            maxLines = 1,
        ).size.width.toFloat()
        if (fullPx <= availPx) nameSize
        else nameSize * max(0.6f, availPx / fullPx * 0.98f)
    }
    // Web stacks the name's 1.15em line box (.identity-name line-height) and
    // the pill box — capping the name's box (the Wordmark pattern: Baloo's
    // natural box is ~1.6em and would push the pill down) matches the browser.
    val nameLineH = with(density) { nameSize.toDp() } * 1.15f
    Column(
        modifier
            .width(cardW)
            .aspectRatio(2.5f)
            .shadowSm(radius) // web .player-card box-shadow: var(--shadow-sm)
            .clip(shape)
            .background(Tokens.tonalCard(color), shape),
        // Web justify-content: space-evenly: the whitespace above the name,
        // between name and pill, and below the pill stays equal.
        verticalArrangement = Arrangement.SpaceEvenly,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.height(nameLineH).fillMaxWidth().padding(horizontal = padH), contentAlignment = Alignment.Center) {
            Text(
                text = player.name,
                style = baseNameStyle.copy(fontSize = fittedNameSize),
                modifier = Modifier.wrapContentHeight(unbounded = true),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
        }
        // Quiet "LEVEL n" pill — recessed dark chip so the level reads as
        // metadata under the colored name (web .card-level__pill).
        Row(
            Modifier
                .clip(CircleShape)
                .background(Tokens.socketPill, CircleShape)
                .padding(horizontal = vp.vminDp(10.35f, 1.6f, 15.15f), vertical = vp.vminDp(3f, 0.45f, 4.5f)),
            horizontalArrangement = Arrangement.spacedBy(vp.vminDp(5.25f, 0.8f, 7.5f)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.level_heading).uppercase(), // .card-level__heading text-transform uppercase
                style = AppType.cardLevelHeading.copy(fontSize = levelSize, color = Tokens.textSecondary),
            )
            Text(
                text = player.level.toString(),
                style = AppType.cardLevelValue.copy(fontSize = levelSize, color = Tokens.textPrimary),
            )
        }
    }
}

/**
 * The faint hex opening inside an empty socket (web `buildSocketOpening`'s SVG:
 * a rounded flat-top hex, cream stroke at 0.45 over a whisper fill).
 */
@Composable
private fun SocketOpening(modifier: Modifier = Modifier) {
    Canvas(modifier.aspectRatio(2f / 1.732f)) {
        val r = size.width / 2f
        val path = android.graphics.Path().apply {
            addRoundedHex(size.width / 2f, size.height / 2f, r * 0.9f, r * 0.12f)
        }.asComposePath()
        drawPath(path, Color(0x08FFF8EC)) // fill rgba(255,248,236,0.03)
        drawPath(path, Tokens.textPrimary.copy(alpha = 0.45f), style = Stroke(width = 1.5.dp.toPx()))
    }
}
