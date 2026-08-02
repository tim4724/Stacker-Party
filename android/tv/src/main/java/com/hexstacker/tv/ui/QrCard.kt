package com.hexstacker.tv.ui

import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import com.hexstacker.tv.R
import kotlinx.coroutines.delay

/**
 * Frameless lobby QR (web A2 `#qr-container`): no card, no label — the white
 * QR square floats on its own; the quiet zone lives in its padding. Mirrors
 * tvOS `buildQRBlock`. [qrW] sizes the square (the lobby derives it from the
 * card width, web `calc(var(--card-w) + 40px)`); pass the pre-rendered
 * [qrBitmap] (cached).
 */
@Composable
fun QrBlock(
    qrBitmap: ImageBitmap?,
    vp: Vp,
    qrW: Dp,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .width(qrW)
            .aspectRatio(1f)
            // Radius scales with the block (web calc((--card-w + 40px) * 0.057),
            // same ratio as the player cards) so the QR and cards keep one corner
            // character at every size; padding stays clamp(6px,1.2vmin,14px).
            .clip(RoundedCornerShape(qrW * 0.057f))
            .background(Tokens.white)
            .padding(vp.vminDp(6f, 1.2f, 14f)),
        contentAlignment = Alignment.Center,
    ) {
        // The bitmap lands async (room `created` arrives mid-entrance): fade the
        // modules in over the already-white card instead of popping (tvOS 0.3s
        // module fade; the web paints its QR synchronously before the lobby is
        // revealed, so it has no equivalent).
        // Starts at full alpha when the bitmap is composed from the first
        // frame (gallery qrOverride) — animateFloatAsState only animates on change.
        val moduleAlpha by animateFloatAsState(
            if (qrBitmap != null) 1f else 0f,
            tween(300, easing = LinearOutSlowInEasing),
            label = "qrModules",
        )
        if (qrBitmap != null) {
            Image(
                bitmap = qrBitmap,
                contentDescription = null, // decorative; the join line is the text equivalent
                modifier = Modifier.fillMaxSize().alpha(moduleAlpha),
                contentScale = ContentScale.Fit,
            )
        }
    }
}

/**
 * Join line (web A2 `#join-line`): host + room code on one baseline,
 * crossfading with the localized "scan to join" hint every few seconds
 * (web DisplayConnection toggles `.show-hint` every 4.5s; 0.45s fade).
 * Starts on the URL so the address is the first thing a player can act on.
 */
@Composable
fun JoinLine(
    joinHost: String,
    joinCode: String,
    vp: Vp,
    modifier: Modifier = Modifier,
    // Freezes the crossfade on the scan hint for a static screenshot: the live
    // 4.5s beat never advances in a captured frame, so a shot would otherwise
    // always catch the URL phase (web parity: DisplayTestHarness `hint=1`).
    startOnHint: Boolean = false,
) {
    // Shared HUD face + size for URL and hint so the crossfade reads as one
    // line changing content (web clamp(1.05rem,2.2vmin,1.5rem)).
    val lineSize = vp.vminSp(16.8f, 2.2f, 24f)

    var showHint by remember { mutableStateOf(startOnHint) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(4500)
            showHint = !showHint
        }
    }
    val urlAlpha by animateFloatAsState(if (showHint) 0f else 1f, tween(450), label = "joinUrlAlpha")

    // Load fade for the WHOLE line, hint included (tvOS roomReady parity:
    // the URL fades in with the QR modules once the room confirms; before
    // that not even the hint shows). Starts at full alpha when composed with
    // the room already known (gallery fixtures) — animateFloatAsState only
    // animates on change.
    val loadAlpha by animateFloatAsState(
        if (joinHost.isNotEmpty() || joinCode.isNotEmpty()) 1f else 0f,
        tween(300, easing = LinearOutSlowInEasing),
        label = "joinLineLoad",
    )

    Box(modifier.alpha(loadAlpha), contentAlignment = Alignment.Center) {
        Row(Modifier.alpha(urlAlpha), verticalAlignment = Alignment.Bottom) {
            Text(
                text = joinHost.lowercase(), // .join-url__host text-transform lowercase
                style = AppType.joinHost.copy(fontSize = lineSize, color = Tokens.textSecondary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (joinCode.isNotEmpty()) {
                Text(
                    text = joinCode,
                    style = AppType.joinCode.copy(fontSize = lineSize, color = Tokens.accentSecondary),
                    maxLines = 1,
                )
            }
        }
        Text(
            text = stringResource(R.string.scan_hint),
            style = AppType.joinHost.copy(fontSize = lineSize, color = Tokens.textSecondary),
            modifier = Modifier.alpha(1f - urlAlpha),
            maxLines = 1,
            textAlign = TextAlign.Center,
        )
    }
}
