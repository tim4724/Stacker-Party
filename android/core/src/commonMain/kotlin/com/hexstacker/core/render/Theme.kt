package com.hexstacker.core.render

/**
 * Palettes, style tiers, and theme tokens, ported from `public/shared/theme.js`.
 * Colors held as [Rgb], parity-checked against the JS hex strings.
 */
object Theme {

    val partyPalette: List<Rgb> = listOf(
        "#FF6B6B", "#4ECDC4", "#FFE066", "#A78BFA",
        "#7BED6F", "#F178D8", "#5B7FFF", "#FF8C42",
    ).map { Rgb.fromHex(it)!! }

    /** grid cell value -> color. 1..6 piece types, 9 garbage. Index 0 (empty) omitted. */
    val pieceColors: Map<Int, Rgb> = mapOf(
        1 to partyPalette[0], // #FF6B6B I3 red
        2 to partyPalette[1], // #4ECDC4 V3 teal
        3 to partyPalette[2], // #FFE066 T3 honey
        4 to partyPalette[3], // #A78BFA o  violet
        5 to partyPalette[4], // #7BED6F d  mint
        6 to partyPalette[5], // #F178D8 b  magenta
        9 to Rgb.fromHex("#808080")!!, // garbage gray (off-palette)
    )

    /** Reordered to a visible spectrum (NOT palette order); the remap is load-bearing. */
    val playerColors: List<Rgb> = listOf(
        partyPalette[0], // 0 Red
        partyPalette[7], // 1 Tangerine
        partyPalette[2], // 2 Honey
        partyPalette[4], // 3 Mint
        partyPalette[1], // 4 Teal
        partyPalette[6], // 5 Indigo
        partyPalette[3], // 6 Violet
        partyPalette[5], // 7 Magenta
    )

    /**
     * Out-of-range slots fall back to the index-0 color (Red), matching the board/UI
     * renderers' `PLAYER_COLORS[playerIndex] || PLAYER_COLORS[0]` guard
     * (BoardRenderer.js:25, UIRenderer.js:76); this helper feeds the native board/UI
     * renderers, so it mirrors them, not the lobby list's white `|| '#fff'` fallback
     * (DisplayUI.js:175). Latent today: MAX_PLAYERS == playerColors.size (8), so a slot
     * is always in range; aligned to avoid a future footgun.
     */
    fun playerColor(slot: Int): Rgb = playerColors.getOrElse(slot) { playerColors[0] }

    val bgPrimary = Rgb.fromHex("#1E1A2B")!!
    val bgSecondary = Rgb.fromHex("#181421")!!
    val bgBoard = Rgb.fromHex("#15121F")!!

    /**
     * Warm-paper hairline for socket rims and ring strokes — mirrors the
     * rgba(255,248,236,X) --border family in theme.css.
     */
    val hairline = Rgb.fromHex("#FFF8EC")!!

    /**
     * Cream outline pulse (== text primary #F7F1E8) — extends the "cream =
     * clear-related" vocabulary shared with the clear preview and clear glow.
     */
    val nearClear = Rgb.fromHex("#F7F1E8")!!

    /** Warm cream text primary (#F7F1E8) — canvas twin of --text-primary. */
    val textPrimary = nearClear

    object Opacity {
        const val faint = 0.04
        const val tint = 0.06
        const val boardTint = 0.12
        const val subtle = 0.08
        const val muted = 0.10
        const val grid = 0.18
        const val soft = 0.15
        const val hairline = 0.12 // socket-rim hairline strokes (× color hairline)
        const val highlight = 0.16
        const val shadow = 0.25
        const val label = 0.6
        const val wall = 0.5 // board wall stroke (player color)
        const val overlay = 0.75
        const val panel = 0.9
    }

    object Stroke {
        const val grid = 0.03
        const val border = 0.04
        const val ghost = 0.05
    }

    object Size {
        const val panelWidth = 4.5
        const val panelGap = 0.25
        const val canvasPad = 5.0
        const val blockGap = 0.03
        const val tvOverscan = 0.05 // TV title-safe margin per edge (Google/Apple ~5% overscan)
    }

    // Mirrors web THEME.font (public/shared/Theme.js): cellScale + minPx.
    object Font {
        const val nameScale = 0.9
        const val labelScale = 0.48
        const val miniScale = 0.6
        const val nameMinPx = 24.0
        const val labelMinPx = 14.0
    }

    enum class StyleTier { NORMAL, PILLOW, NEON_FLAT }

    /** getStyleTier: Lv 1-5 NORMAL, 6-10 PILLOW, 11+ NEON_FLAT. */
    fun styleTier(level: Int): StyleTier = when {
        level >= 11 -> StyleTier.NEON_FLAT
        level >= 6 -> StyleTier.PILLOW
        else -> StyleTier.NORMAL
    }

    /** The JS string token a tier maps to, for parity comparison. */
    fun styleTierToken(t: StyleTier): String = when (t) {
        StyleTier.NORMAL -> "normal"
        StyleTier.PILLOW -> "pillow"
        StyleTier.NEON_FLAT -> "neonFlat"
    }
}
