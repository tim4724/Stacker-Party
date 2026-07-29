package com.hexstacker.tv.perf

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.Shader
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What a full-screen decorative backdrop costs per frame on this TV's GPU, shading it
 * live versus blitting it from a cache.
 *
 * Both the lobby vignette and the results backdrop are pure functions of (size, colour):
 * they never change while their screen is up. But anything animating above them damages
 * the full screen, and HWUI re-rasterises everything under a damaged region — so they get
 * re-shaded every frame to produce an identical image. This measures how much that costs
 * on a PowerVR Rogue GE9215 (tile-based deferred: fill and blending are the scarce
 * resource, so a per-pixel gradient plus a separable blend mode is the worst shape to
 * repeat 60 times a second).
 *
 * `radial` is the lobby recipe, `radial+noise` the results one (which adds a tiled noise
 * shader at BlendMode.OVERLAY to break up 8-bit banding). The two `cached blit` rows are
 * what each screen pays instead: eighth-scale-and-upsampled for the lobby vignette, and
 * 1:1 for the results backdrop, whose noise only dithers while it stays one texel per
 * pixel.
 *
 * Not in CI (needs a real TV). Run:
 *   ./gradlew :tv:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.hexstacker.tv.perf.BackdropPerfTest
 * and read the `HexPerf` logcat tag.
 */
@RunWith(AndroidJUnit4::class)
class BackdropPerfTest {

    @Test
    fun backdropCost() {
        val reader = ImageReader.newInstance(
            W, H, PixelFormat.RGBA_8888, 3,
            HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_COMPOSER_OVERLAY,
        )
        val surface = reader.surface

        val cx = W * 0.5f
        val cy = H * 0.3f
        val maxCorner = maxOf(
            maxOf(hypot(cx, cy), hypot(W - cx, cy)),
            maxOf(hypot(cx, H - cy), hypot(W - cx, H - cy)),
        )
        val gradientPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = RadialGradient(
                cx, cy, 0.55f * maxCorner, GLOW_ARGB, 0x00000000, Shader.TileMode.CLAMP,
            )
        }

        // Tiled grayscale noise at 0.05 over OVERLAY — the results anti-banding pass.
        val side = 180
        var state = -0x61C8864680B583EBL
        val px = IntArray(side * side)
        for (i in px.indices) {
            state = state xor (state shl 13)
            state = state xor (state ushr 7)
            state = state xor (state shl 17)
            val v = (state and 0xFF).toInt()
            px[i] = (0xFF shl 24) or (v shl 16) or (v shl 8) or v
        }
        val noiseBmp = Bitmap.createBitmap(px, side, side, Bitmap.Config.ARGB_8888)
        val noisePaint = Paint().apply {
            shader = BitmapShader(noiseBmp, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
            alpha = (0.05f * 255).toInt()
            blendMode = BlendMode.OVERLAY
        }

        // The cached equivalent: shade once at eighth scale, blit upsampled thereafter.
        val sw = max(2, ceil(W / 8f).toInt())
        val sh = max(2, ceil(H / 8f).toInt())
        val cacheBmp = Bitmap.createBitmap(sw, sh, Bitmap.Config.ARGB_8888)
        Canvas(cacheBmp).also { c ->
            val scx = sw * 0.5f
            val scy = sh * 0.3f
            val sMaxCorner = maxOf(
                maxOf(hypot(scx, scy), hypot(sw - scx, scy)),
                maxOf(hypot(scx, sh - scy), hypot(sw - scx, sh - scy)),
            )
            c.drawRect(
                0f, 0f, sw.toFloat(), sh.toFloat(),
                Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    shader = RadialGradient(
                        scx, scy, 0.55f * sMaxCorner, GLOW_ARGB, 0x00000000, Shader.TileMode.CLAMP,
                    )
                },
            )
        }
        val blitPaint = Paint().apply { isFilterBitmap = true }
        val srcRect = Rect(0, 0, sw, sh)
        val dstRect = Rect(0, 0, W, H)

        // Gradient + noise baked at 1:1 — what the results backdrop would blit.
        val fullBmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        Canvas(fullBmp).also { c ->
            c.drawRect(0f, 0f, W.toFloat(), H.toFloat(), gradientPaint)
            c.drawRect(0f, 0f, W.toFloat(), H.toFloat(), noisePaint)
        }

        val variants: List<Pair<String, (Canvas) -> Unit>> = listOf(
            "clear only" to { c -> c.drawColor(BG_ARGB) },
            "radial (lobby)" to { c ->
                c.drawColor(BG_ARGB)
                c.drawRect(0f, 0f, W.toFloat(), H.toFloat(), gradientPaint)
            },
            "radial+noise (results)" to { c ->
                c.drawColor(BG_ARGB)
                c.drawRect(0f, 0f, W.toFloat(), H.toFloat(), gradientPaint)
                c.drawRect(0f, 0f, W.toFloat(), H.toFloat(), noisePaint)
            },
            "cached blit" to { c ->
                c.drawColor(BG_ARGB)
                c.drawBitmap(cacheBmp, srcRect, dstRect, blitPaint)
            },
            // Full-res variant: the results backdrop cannot be cached downscaled,
            // because its noise dither only breaks banding while it stays 1:1.
            "cached blit (full-res)" to { c ->
                c.drawColor(BG_ARGB)
                c.drawBitmap(fullBmp, 0f, 0f, null)
            },
        )

        for ((label, draw) in variants) {
            repeat(WARMUP) {
                val c = surface.lockHardwareCanvas()
                draw(c)
                surface.unlockCanvasAndPost(c)
                reader.acquireLatestImage()?.close()
            }
            val t0 = System.nanoTime()
            repeat(ITERS) {
                val c = surface.lockHardwareCanvas()
                draw(c)
                surface.unlockCanvasAndPost(c)
                reader.acquireLatestImage()?.close()
            }
            val perFrame = (System.nanoTime() - t0) / 1e6 / ITERS
            Log.i(TAG, String.format("backdrop %-24s %6.2f ms/frame", label, perFrame))
        }
        reader.close()
    }

    private companion object {
        const val TAG = "HexPerf"
        const val W = 1920
        const val H = 1080
        const val WARMUP = 60
        const val ITERS = 240
        val BG_ARGB = Color.argb(255, 30, 26, 43) // Tokens.bgPrimary
        val GLOW_ARGB = Color.argb((0.06f * 255).toInt(), 255, 107, 107) // accentPrimary @ 0.06
    }
}
