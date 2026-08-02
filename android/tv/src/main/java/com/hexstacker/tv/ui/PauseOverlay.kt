package com.hexstacker.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.hexstacker.tv.R

/**
 * Pause overlay (web `#pause-overlay`, tvOS `setPaused`): "PAUSED" over a
 * compact Game Music switch row and a Continue / New Game button pair. The music
 * row is the Android/tvOS addition (the display has no toolbar mute on TV).
 * Default focus = CONTINUE; D-pad Up from the buttons reaches the music switch.
 *
 * Stateless: [musicOn] (= !isMuted) and [hostColorIndex] from the coordinator;
 * [onToggleMusic] flips mute, [onContinue] = `remoteTogglePause()`,
 * [onNewGame] = `remoteReturnToLobby()`.
 */
@Composable
fun PauseOverlay(
    hostColorIndex: Int?,
    musicOn: Boolean,
    onToggleMusic: () -> Unit,
    onContinue: () -> Unit,
    onNewGame: () -> Unit,
    modifier: Modifier = Modifier,
    musicFocusedForShot: Boolean = false,
) {
    val continueFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { continueFocus.requestFocus() }
    val hostColor = hostTint(hostColorIndex)

    BoxWithConstraints(modifier.fillMaxSize().background(Tokens.overlayBg)) {
        val vp = Vp(maxWidth.value, maxHeight.value)
        val btnMin = vp.vhDp(260f, 34f, 420f) // overlay CTA min-width clamp(260px,34vh,420px)
        val btnGap = vp.vwDp(16f, 2f, 32f) // #pause-buttons gap clamp(1rem,2vw,2rem)
        val btnFont = vp.vhSp(17.6f, 2.4f, 27.2f) // clamp(1.1rem,2.4vh,1.7rem)
        val btnPad = PaddingValues(
            horizontal = vp.vwDp(24f, 3f, 48f),
            vertical = vp.vhDp(14.4f, 2f, 27.2f),
        )

        Column(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(15.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.paused),
                style = AppType.pauseTitle.copy(
                    fontSize = vp.vhSp(25.6f, 4f, 56f), // clamp(1.6rem,4vh,3.5rem)
                    color = Tokens.textPrimary,
                ),
            )

            // Content-hugging: the label sits right next to the switch (a row spanning
            // the button pair left a large dead gap between them).
            MusicSwitch(
                isOn = musicOn,
                tint = hostColor,
                rowHeight = vp.vhDp(66f, 7f, 108f),
                onToggle = onToggleMusic,
                focusedForShot = musicFocusedForShot,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(btnGap)) {
                ChromeButton(
                    text = stringResource(R.string.continue_btn),
                    primary = true,
                    tint = hostColor,
                    focusRequester = continueFocus,
                    fontSize = btnFont,
                    contentPadding = btnPad,
                    minWidth = btnMin,
                    onClick = onContinue,
                )
                ChromeButton(
                    text = stringResource(R.string.new_game),
                    primary = false,
                    tint = Tokens.accentPrimary,
                    fontSize = btnFont,
                    contentPadding = btnPad,
                    minWidth = btnMin,
                    onClick = onNewGame,
                )
            }
        }
    }
}

@Preview(widthDp = 960, heightDp = 540)
@Composable
private fun PausePreview() {
    var on by remember { mutableStateOf(true) }
    PauseOverlay(
        hostColorIndex = 4,
        musicOn = on,
        onToggleMusic = { on = !on },
        onContinue = {},
        onNewGame = {},
    )
}
