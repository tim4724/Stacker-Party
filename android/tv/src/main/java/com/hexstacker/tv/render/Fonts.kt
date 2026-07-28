package com.hexstacker.tv.render

import android.content.Context
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat
import com.hexstacker.tv.R

/**
 * The board renderer's two type voices, mirroring theme.css (see also ui/AppType.kt,
 * which carries the same split for the Compose chrome):
 *   - Orbitron (`--font-hud`) — HUD labels, stat values, timer, KO. Bundled at
 *     `assets/fonts/Orbitron[wght].ttf` (the same file the Apple TV port ships),
 *     with a monospace fallback that mirrors `getDisplayFont()`'s
 *     `'Orbitron' || '"Courier New", monospace'` contract on the web.
 *   - Baloo 2 (`--font-brand`) — the player name above each board, which is the
 *     identity voice on the web too (UIRenderer `_fontName` uses `getBrandFont()`).
 *
 * Both ship as variable fonts, and the weight has to be requested by NAMING THE
 * wght AXIS. `Typeface.create(family, weight, false)` does not move it: advances
 * stay at Regular and Canvas applies a synthetic bold instead, so 700 and 900
 * come out identical and neither matches the real instance the web and tvOS draw.
 * This is the Canvas counterpart of the `FontVariation.Settings` the Compose
 * chrome passes in ui/AppType.kt, which exists for the same reason.
 *
 * Assets can name the axis directly via [Typeface.Builder]; `res/font` cannot, so
 * Baloo goes through the `baloo2_bold.xml` family, which carries the axis instead.
 */
class Fonts(context: Context) {

    /** 600-weight Orbitron — the per-board disconnect / "scan to rejoin" overlay labels. */
    val semibold: Typeface = orbitron(context, 600)

    /** 700-weight Orbitron — panel labels, stat values, timer. */
    val bold: Typeface = orbitron(context, 700)

    /** 900-weight Orbitron — KO label and line-clear text popups. */
    val black: Typeface = orbitron(context, 900)

    /** 700-weight Baloo 2 — the player name above the board (web `_fontName`). */
    val brandBold: Typeface =
        runCatching { ResourcesCompat.getFont(context, R.font.baloo2_bold) }.getOrNull()
            ?: Typeface.DEFAULT_BOLD

    private companion object {
        private const val ORBITRON_ASSET = "fonts/Orbitron[wght].ttf"

        fun orbitron(context: Context, weight: Int): Typeface =
            runCatching {
                Typeface.Builder(context.assets, ORBITRON_ASSET)
                    .setFontVariationSettings("'wght' $weight")
                    .build()
            }.getOrNull() ?: Typeface.MONOSPACE
    }
}
