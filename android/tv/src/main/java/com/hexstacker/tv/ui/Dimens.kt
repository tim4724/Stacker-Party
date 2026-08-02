package com.hexstacker.tv.ui

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min

/**
 * CSS-`clamp()` helper bound to a viewport, mirroring the vmin/vw/vh units used across
 * display.css and theme.css. Build one per screen from a FULL-SCREEN
 * `BoxWithConstraints`:
 *
 * ```
 * BoxWithConstraints(Modifier.fillMaxSize()) { val vp = Vp(maxWidth.value, maxHeight.value); ... }
 * ```
 *
 * **`lo`/`hi` are web px** — the literal value from the CSS `clamp()`, so a call site
 * here reads identically to the matching one in `appletv/`'s `Vp` and can be diffed
 * against it. [px] converts; the `pct` term is viewport-relative and needs no
 * conversion on any platform.
 *
 * That conversion is the whole reason this differs from the tvOS twin. tvOS lays out in
 * a 1920x1080 POINT space on every Apple TV, which is 1:1 with the web's design
 * viewport, so its bounds are web px already. Android TV pins a 960x540dp window
 * instead — the same guarantee, half the number (1080p panel: density 2.0; 4K panel:
 * density 4.0; both 960x540dp) — so web px land at half as many dp here.
 *
 * Getting that wrong is not cosmetic: bounds authored as raw web px made the results
 * CTAs 440px wide against the 367.2px the web computes, because a floor in the wrong
 * unit BINDS where the web's never does. Note it scales by the viewport, not by
 * `Density`: density is 4.0 on a 4K-native panel, and dividing by it would pin elements
 * to a fixed pixel size instead of letting the design scale with the screen.
 */
class Vp(val wDp: Float, val hDp: Float) {
    val vmin: Float = min(wDp, hDp)

    /** Web px -> dp at this viewport (0.5x on Android TV's fixed 960dp-wide window). */
    fun px(webPx: Float): Dp = (webPx * wDp / DESIGN_W).dp

    private fun clamp(lo: Float, pref: Float, hi: Float): Float {
        val s = wDp / DESIGN_W
        return pref.coerceIn(min(lo * s, hi * s), max(lo * s, hi * s))
    }

    fun vminDp(lo: Float, pct: Float, hi: Float): Dp = clamp(lo, pct / 100f * vmin, hi).dp
    fun vminSp(lo: Float, pct: Float, hi: Float): TextUnit = clamp(lo, pct / 100f * vmin, hi).sp
    fun vhDp(lo: Float, pct: Float, hi: Float): Dp = clamp(lo, pct / 100f * hDp, hi).dp
    fun vhSp(lo: Float, pct: Float, hi: Float): TextUnit = clamp(lo, pct / 100f * hDp, hi).sp
    fun vwDp(lo: Float, pct: Float, hi: Float): Dp = clamp(lo, pct / 100f * wDp, hi).dp
}

/** The web display's design viewport width in css px, which tvOS mirrors 1:1 in points. */
private const val DESIGN_W = 1920f
