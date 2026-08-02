package com.hexstacker.tv.ui

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Focusable text button — the web `.btn-primary`/`.btn-secondary` + tvOS
 * `MenuButton`, built on `Modifier.clickable` (whose non-touch-mode focus target
 * gives D-pad navigation, skip-disabled, and DPAD_CENTER/ENTER activation from
 * the native focus engine).
 *
 * Visuals (mirror `MenuButton.setFocused` + CSS, A2):
 *  - primary enabled → vertical gradient `[tint, tint*0.82]` (CSS color-mix 82% black)
 *  - secondary → borderless `--bg-card-soft` (web `.btn-secondary`)
 *  - disabled → quiet `--bg-card`, no border (web `.btn-primary:disabled`)
 *  - text: disabled `--text-secondary`, primary `--btn-primary-text`, secondary `--text-primary`
 *  - 16px corner (var(--radius-btn)); borderless at rest — focus adds the white
 *    4dp ring + scale 1.06. Disabled has no scale but STAYS focusable (ring only),
 *    so the empty lobby seats initial focus on the disabled Start (the main action)
 *    instead of letting the focus engine grab the ⓘ (tvOS parity)
 *  - rest carries the web --shadow-sm; focus grows it into a lift (the TV focus
 *    convention, shared with the tvOS ChromeButtonChrome); DPAD_CENTER press
 *    sinks the pill back to rest size and drops the shadow (web .btn:active
 *    translateY(1px) + box-shadow: none, at 10-foot strength)
 *
 * The label is uppercased here (CSS `text-transform`, not data).
 */
@Composable
fun ChromeButton(
    text: String,
    primary: Boolean,
    tint: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    focusRequester: FocusRequester? = null,
    fontSize: TextUnit,
    contentPadding: PaddingValues,
    minWidth: Dp = Dp.Unspecified,
) {
    var focused by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    // Disabled pills stay focusable but must not sink (web: no :active on :disabled).
    val pressed = interaction.collectIsPressedAsState().value && enabled
    val scale by animateFloatAsState(
        targetValue = if (pressed) 1f else if (focused && enabled) 1.06f else 1f,
        // Slightly springy on focus, tracking the tvOS focus engine's feel;
        // the press dip is a fast plain ease so the click lands instantly.
        animationSpec = if (pressed) {
            tween(100)
        } else {
            spring(dampingRatio = 0.75f, stiffness = Spring.StiffnessMediumLow)
        },
        label = "chromeButtonScale",
    )
    val shape = RoundedCornerShape(Tokens.radiusBtn)
    // web --shadow-sm at rest, grown into the focus lift; gone while pressed
    // (web .btn:active) or disabled (web .btn-primary:disabled). Snaps rather
    // than animates, like the web (theme.css transitions transform + filter only).
    val shadowModifier = when {
        !enabled || pressed -> Modifier
        focused -> Modifier.shadowLift(Tokens.radiusBtn)
        else -> Modifier.shadowSm(Tokens.radiusBtn)
    }

    val fillModifier = when {
        enabled && primary -> Modifier.background(Brush.verticalGradient(listOf(tint, scaledColor(tint, 0.82f))), shape)
        enabled -> Modifier.background(Tokens.bgCardSoft, shape) // .btn-secondary (borderless)
        else -> Modifier.background(Tokens.bgCard, shape) // .btn-primary:disabled
    }
    // Borderless at rest (A2); focus adds the white ring.
    val ringModifier = if (focused) Modifier.border(2.dp, Tokens.white, shape) else Modifier
    val textColor = when {
        !enabled -> Tokens.textSecondary
        primary -> Tokens.btnPrimaryText
        else -> Tokens.textPrimary
    }

    androidx.compose.foundation.layout.Box(
        modifier
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .then(if (minWidth != Dp.Unspecified) Modifier.widthIn(min = minWidth) else Modifier)
            .then(shadowModifier) // before clip(): the blur must not be cut at the pill bounds
            .clip(shape)
            .then(fillModifier)
            .then(ringModifier)
            .then(focusRequester?.let { Modifier.focusRequester(it) } ?: Modifier)
            .onFocusChanged { focused = it.isFocused }
            // clickable provides the focus target itself (focusable-in-non-touch-mode)
            // and stays enabled even for a disabled button, so the focus node survives
            // enable/disable (a disabled Start holds focus in the empty lobby, and
            // enabling it must not drop focus). The action is gated instead; semantics
            // carry the disabled state for accessibility. The explicit interaction
            // source feeds the press-sink visual above.
            //
            // indication = null: the scale/shadow above IS the feedback. The default
            // (LocalIndication, unset app-wide) is foundation's debug indication, which
            // washes focus with 10% and press with 30% black. That has no web/tvOS
            // counterpart, and the gallery can't see it: its headless host seeds
            // `focused` without firing the focus interactions that would draw it.
            .semantics { if (!enabled) disabled() }
            .clickable(interactionSource = interaction, indication = null) {
                if (enabled) onClick()
            }
            .padding(contentPadding),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text.uppercase(),
            style = AppType.buttonLabel.copy(fontSize = fontSize, color = textColor),
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** sRGB component scale toward black — CSS `color-mix(in srgb, c <f*100>%, black)`. */
internal fun scaledColor(c: Color, f: Float): Color =
    Color(red = c.red * f, green = c.green * f, blue = c.blue * f, alpha = c.alpha)
