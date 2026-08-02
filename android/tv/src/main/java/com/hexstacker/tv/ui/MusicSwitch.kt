package com.hexstacker.tv.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hexstacker.tv.R

/**
 * The host's "Game Music" on/off control (the display-side mute), surfaced in the
 * pause overlay as a compact focusable row: label, then the switch (web
 * `.settings-switch`, tvOS `MusicSwitch`). Switch geometry mirrors the web
 * 52:30 track / 24px thumb / 3px inset. ON → track = host tint, thumb right;
 * OFF → track = white@0.12, thumb left. ON means music is playing.
 *
 * Stateless: [isOn] is owned by the caller; [onToggle] flips it (the integrator
 * calls `remoteToggleMute()` and passes the new value back as [isOn]).
 *
 * [focusedForShot] seeds the focused visual for the gallery screenshot tests:
 * Robolectric's headless Compose host never gains window focus, so real focus
 * events can't reach [onFocusChanged] there. The seed drives the exact same
 * `focused` state the focus system drives, and any real focus event overrides it.
 */
@Composable
fun MusicSwitch(
    isOn: Boolean,
    tint: Color,
    rowHeight: Dp,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    focusedForShot: Boolean = false,
) {
    var focused by remember { mutableStateOf(focusedForShot) }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // Press sinks the row back to rest size (the ChromeButton press treatment;
    // web .btn:active).
    val scale by animateFloatAsState(
        targetValue = if (pressed) 1f else if (focused) 1.03f else 1f,
        label = "musicSwitchScale",
    )
    val shape = RoundedCornerShape(Tokens.radiusMd)

    val trackH = rowHeight * 0.46f
    val trackW = trackH * (52f / 30f)
    val knobD = trackH * (24f / 30f)
    val margin = trackH * (3f / 30f)
    val thumbX by animateDpAsState(
        targetValue = if (isOn) trackW - margin - knobD else margin,
        // Reduce Motion snaps the thumb (tvOS parity); otherwise the
        // animateDpAsState default spring.
        animationSpec = if (LocalReduceMotion.current) {
            snap()
        } else {
            spring(visibilityThreshold = Dp.VisibilityThreshold)
        },
        label = "musicSwitchThumb",
    )

    Row(
        modifier
            .height(rowHeight)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(shape)
            .background(if (focused) Tokens.white.copy(alpha = 0.06f) else Color.Transparent, shape)
            .then(if (focused) Modifier.border(2.dp, Tokens.white, shape) else Modifier)
            // `|| focusedForShot`: the headless host still emits an initial
            // isFocused=false, which would clobber the seeded shot state.
            .onFocusChanged { focused = it.isFocused || focusedForShot }
            // toggleable, not clickable: it provides the same focus target and press
            // interactions (it IS clickable underneath, so D-pad focus and activation
            // are unchanged) and additionally publishes the on/off state to the
            // accessibility tree — the web control this mirrors carries
            // `role="switch" aria-checked`, and Role.Switch is how a screen reader
            // hears the same thing here. The state is announced from the framework's
            // own localized strings, so nothing is added to strings.xml. The explicit
            // interaction source feeds the press-sink visual above, which is why
            // indication is null (see ChromeButton).
            .toggleable(
                value = isOn,
                interactionSource = interaction,
                indication = null,
                role = Role.Switch,
                onValueChange = { onToggle() },
            )
            .padding(horizontal = rowHeight * 0.5f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(rowHeight * 0.75f),
    ) {
        Text(
            text = stringResource(R.string.settings_game_music), // NOT uppercased (gotcha #8)
            style = AppType.musicLabel.copy(fontSize = (rowHeight.value * 0.40f).sp, color = Tokens.textPrimary),
        )
        Box(
            Modifier
                .size(width = trackW, height = trackH)
                .clip(RoundedCornerShape(percent = 50))
                .background(if (isOn) tint else Tokens.white.copy(alpha = 0.12f)),
        ) {
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .offset(x = thumbX)
                    .size(knobD)
                    .clip(CircleShape)
                    .background(Tokens.white),
            )
        }
    }
}
