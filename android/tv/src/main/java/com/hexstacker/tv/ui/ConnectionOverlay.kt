package com.hexstacker.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R

/**
 * Full-screen overlay shown when the display's own relay link drops. Mirrors the
 * web: while auto-retrying it reads RECONNECTING / "Attempt N of M"; once the
 * client gives up it reads DISCONNECTED with a focusable RECONNECT button. Copy is
 * the web i18n source (no TV-only strings). A failed first-launch create drives the
 * same overlay as a lost room (RECONNECTING → DISCONNECTED).
 *
 * When [showReconnect] is false (a terminal slot-0 eviction: another display took over
 * the room), the DISCONNECTED copy is shown with no reconnect affordance, mirroring the
 * web dropping the reconnect button in that state.
 */
@Composable
fun ConnectionOverlay(
    disconnected: Boolean,
    onReconnect: () -> Unit = {},
    showReconnect: Boolean = true,
    // Current retry / max, shown as "Attempt N of M" while reconnecting (web parity).
    // 0 = the heartbeat path's unnumbered immediate retry (status line hidden).
    attempt: Int = 0,
    maxAttempts: Int = 0,
    // Host tint for the RECONNECT CTA (web: #reconnect-btn reads --player-color).
    // With the relay down no roster change can arrive, so the last-known host
    // color is exactly what the web shows too.
    hostColorIndex: Int? = null,
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }
    // Take focus when the RECONNECT button appears: nothing else on screen is focusable
    // in the gave-up state, so without this the D-pad can't activate the button at all.
    // Keyed on the same flags that compose the button, so the effect runs after the
    // recomposition that attached its focus target.
    LaunchedEffect(disconnected, showReconnect) {
        if (disconnected && showReconnect) runCatching { focus.requestFocus() }
    }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .background(Tokens.overlayBg),
        contentAlignment = Alignment.Center,
    ) {
        val vp = Vp(maxWidth.value, maxHeight.value)
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = if (disconnected) stringResource(R.string.disconnected)
                       else stringResource(R.string.reconnecting),
                style = AppType.connHeading,
                color = Tokens.textPrimary,
                // One heading scale for every full-screen overlay state — PAUSED,
                // Reconnecting, Disconnected all read at the same weight (web A2:
                // #pause-overlay h1, #reconnect-overlay h1: clamp(1.6rem,4vh,3.5rem)).
                fontSize = vp.vhSp(25.6f, 4f, 56f),
            )
            // Status line only while reconnecting (web/tvOS show none in the terminal
            // disconnected state — that screen is just heading + RECONNECT button).
            // attempt == 0 is the heartbeat path's unnumbered immediate retry:
            // heading-only, matching the web's empty status line.
            if (!disconnected && attempt > 0) {
                Spacer(Modifier.height(10.5.dp))
                Text(
                    // "Attempt N of M" (web clamps N to M).
                    text = stringResource(R.string.attempt_n_of_m, attempt.coerceAtMost(maxAttempts), maxAttempts),
                    style = AppType.connStatus,
                    color = Tokens.textSecondary,
                    // Legible from the couch (web A2 .game-overlay__status:
                    // clamp(1.2rem,2.4vh,1.6rem)).
                    fontSize = vp.vhSp(19.2f, 2.4f, 25.6f),
                )
            }
            if (disconnected && showReconnect) {
                Spacer(Modifier.height(30.dp))
                ChromeButton(
                    text = stringResource(R.string.reconnect),
                    primary = true,
                    tint = hostTint(hostColorIndex),
                    fontSize = vp.vhSp(17.6f, 2.4f, 27.2f),
                    contentPadding = PaddingValues(
                        horizontal = vp.vwDp(24f, 3f, 48f),
                        vertical = vp.vhDp(14.4f, 2f, 27.2f),
                    ),
                    minWidth = vp.vhDp(260f, 34f, 420f),
                    onClick = onReconnect,
                    focusRequester = focus,
                )
            }
        }
    }
}
