package com.hexstacker.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the web-px -> dp convention [Vp] encodes.
 *
 * The whole of `ui/` is authored against the web display's 1920x1080 css-px design
 * space, while Android TV pins a 960x540dp window on every panel. Getting that factor
 * wrong is silent: the `vh`/`vw` terms stay right, so only the clamp BOUNDS drift, and
 * only on the screens where one happens to bind. It shipped that way once — bounds
 * authored as raw web px made the overlay CTAs 440px wide against the web's 367.2px.
 *
 * These are arithmetic assertions, not golden images, because the failure mode is
 * arithmetic. The gallery covers what it looks like.
 */
class DimensTest {

    /** The Android TV window, whatever the panel: 1080p at density 2.0, 4K at 4.0. */
    private val tv = Vp(960f, 540f)

    @Test
    fun `web px convert to half as many dp`() {
        assertEquals(10f, tv.px(20f).value, 1e-4f)
        assertEquals(110f, tv.px(220f).value, 1e-4f)
    }

    @Test
    fun `a bound binds at the same viewport fraction the web clamps at`() {
        // web: clamp(260px, 34vh, 420px) at 1080p -> 34vh = 367.2px, floor inactive.
        // The TV must land on the same 367.2 physical px, i.e. 183.6dp at density 2.
        assertEquals(183.6f, tv.vhDp(260f, 34f, 420f).value, 1e-3f)
    }

    @Test
    fun `a floor still binds when the viewport term falls under it`() {
        // web: clamp(260px, 10vh, 420px) at 1080p -> 108px, floored to 260px.
        assertEquals(130f, tv.vhDp(260f, 10f, 420f).value, 1e-3f)
    }

    @Test
    fun `a ceiling still binds when the viewport term exceeds it`() {
        // web: --card-w clamp(150px, 36vmin, 350px) at 1080p -> 388.8px, capped to 350.
        assertEquals(175f, tv.vminDp(150f, 36f, 350f).value, 1e-3f)
    }

    @Test
    fun `the percentage term is resolution-independent`() {
        // Same design at twice the logical size must scale, not stay pinned to px.
        assertEquals(2f * tv.vhDp(0f, 34f, 9999f).value, Vp(1920f, 1080f).vhDp(0f, 34f, 9999f).value, 1e-3f)
    }
}
