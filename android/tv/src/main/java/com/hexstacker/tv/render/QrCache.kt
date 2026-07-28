package com.hexstacker.tv.render

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import com.hexstacker.tv.ui.QrRenderer
import java.util.concurrent.ConcurrentHashMap

/**
 * Encodes join-URLs to QR [Bitmap]s for the per-board disconnect overlay, cached per
 * URL. Delegates to the shared [QrRenderer] so the rejoin QR gets the SAME branded look
 * as the lobby QR and the web `renderQR` (rounded `--bg-card` plum modules on white,
 * EC level L, 1-module quiet zone) rather than plain black squares. The bitmap is
 * rendered at a fixed module resolution and scaled to the board's QR box at draw time.
 *
 * The encode is a multi-ms operation, so it happens in [warm] on the caller's thread
 * (the game thread, at the moment a disconnect is recorded); [get] is a plain lookup
 * the render thread can run per frame. A failed encode is negative-cached, not retried
 * every frame for as long as the player stays disconnected.
 */
internal class QrCache(private val sidePx: Int = 320) {

    private companion object {
        /** Negative-cache sentinel: this URL failed to encode once, stop trying. */
        val FAILED: Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ALPHA_8)
    }

    private val cache = ConcurrentHashMap<String, Bitmap>()

    /** Cache lookup only, never renders. Null until [warm] has run (or the encode failed). */
    fun get(url: String): Bitmap? = cache[url]?.takeIf { it !== FAILED }

    /** Render and cache [url] now, on the calling thread. */
    fun warm(url: String) {
        cache.getOrPut(url) {
            runCatching { QrRenderer.render(url, sidePx).asAndroidBitmap() }.getOrNull() ?: FAILED
        }
    }

    fun clear() {
        for (b in cache.values) if (b !== FAILED) b.recycle()
        cache.clear()
    }
}
