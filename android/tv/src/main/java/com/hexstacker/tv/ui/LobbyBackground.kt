package com.hexstacker.tv.ui

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import com.hexstacker.core.render.HexGeometry
import com.hexstacker.tv.render.addRoundedHex
import kotlinx.coroutines.isActive
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

private val SQRT3 = sqrt(3f)

/**
 * Falling-piece welcome background (port of `WelcomeBackground.js`). Translucent
 * hex piece silhouettes raining down behind the lobby content. Drives a
 * `withFrameNanos` loop only while [active] (mirror tvOS `if !lobbyLayer.isHidden`);
 * the loop cancels when [active] flips false or the composable leaves.
 *
 * Two layers, and BOTH have to be cheap per frame. Giving the accent glow its own
 * Canvas keeps it out of the piece layer's re-RECORDING, but recording was never the
 * cost: the piece Canvas damages the full screen every frame, and HWUI re-RASTERISES
 * everything under a damaged region, so the glow was re-shaded 60 times a second
 * regardless of which Canvas it lived on. It is blitted from [GlowCache] now. Cells
 * likewise come from pre-rendered bitmap stamps ([PieceStampCache], the web
 * `getHexStamp` cache) with the piece opacity applied at draw time (web
 * `globalAlpha`), so the frame loop allocates nothing and shades nothing.
 *
 * The piece field lives in a 1920-wide reference space (the web/tvOS coordinate
 * space; height follows the canvas aspect) and is scaled to the canvas at draw
 * time, so pieces keep the same apparent size and speed on 1080p and 4K surfaces.
 *
 * When [fixedPieces] is non-null (screenshot fixtures), the live animation is
 * skipped entirely and exactly those pieces are painted — so the gallery lobby
 * shows the SAME frozen ambient columns as the web/tvOS galleries. Production
 * callers pass nothing and get the live field.
 */
@Composable
fun LobbyBackground(
    modifier: Modifier = Modifier,
    active: Boolean = true,
    fixedPieces: List<FallingPiece>? = null,
) {
    val field = remember { FallingPieceField() }
    val stamps = remember { PieceStampCache() }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val tick = remember { mutableStateOf(0L) } // bumped each frame to invalidate the Canvas

    // Keyed on size + active: the loop cancels and restarts when either changes,
    // so flipping `active` false stops the animation (mirror tvOS lobby gating).
    // A frozen fixture skips the loop outright — the shot must not race an animation.
    val reduceMotion = LocalReduceMotion.current
    LaunchedEffect(size, active, fixedPieces != null, reduceMotion) {
        if (fixedPieces != null || size == IntSize.Zero || !active) return@LaunchedEffect
        // Simulate in the reference space (drawFallingPiece scales to the canvas);
        // raw canvas px would halve the apparent piece size/speed on 4K surfaces.
        field.resize(REF_W, REF_W * size.height / size.width)
        // Reduce Motion parks the drift: the pool stays grid-seeded across the
        // screen, so the lobby keeps its scattered piece backdrop as a still,
        // like the frozen gallery fixture (tvOS BoardScene parity).
        if (reduceMotion) {
            tick.value++ // one invalidation to paint the seeded static field
            return@LaunchedEffect
        }
        var last = 0L
        while (isActive) {
            val now = withFrameNanos { it }
            val dt = if (last == 0L) 0f else min((now - last) / 1e9f, 0.05f)
            last = now
            field.advance(dt)
            tick.value = now
        }
    }

    val glow = remember { GlowCache() }

    Box(modifier) {
        Canvas(Modifier.fillMaxSize()) { drawLobbyGlow(glow) }
        Canvas(
            Modifier
                .fillMaxSize()
                .onSizeChanged { size = it },
        ) {
            tick.value // read so the draw phase re-runs each frame
            for (p in fixedPieces ?: field.pool) drawFallingPiece(p, stamps)
        }
    }
}

/** Reference width the piece field simulates in and fixtures are authored in
 *  (matches the web/tvOS 1920x1080 space); scaled to the canvas at draw time. */
private const val REF_W = 1920f

/** Accent-red radial glow baked behind the falling pieces (web `display.js`:
 *  cx 0.5, cy 0.3, alpha 0.06, stop end 0.55), painted over the parent's
 *  bgPrimary fill — blitted from [GlowCache] rather than shaded per frame. */
private fun DrawScope.drawLobbyGlow(cache: GlowCache) {
    val w = size.width.roundToInt()
    val h = size.height.roundToInt()
    val glow = cache.get(w, h) ?: return
    drawImage(glow) // baked at surface size, so this is a straight 1:1 blit
}

/**
 * The accent vignette, rasterised ONCE per surface size instead of once per frame.
 *
 * It used to be a full-screen `drawRect` with a `Brush.radialGradient`. The gradient
 * only depends on the canvas size, but the falling-piece Canvas above it invalidates
 * the whole screen every frame, and HWUI re-rasterises whatever is under a damaged
 * region — so the GPU re-shaded 2M pixels of identical gradient 60 times a second.
 * Measured on a Google TV Streamer (PowerVR Rogue GE9215) that was 6.25 ms of the
 * lobby's 10.2 ms GPU frame: more than the rest of the lobby put together, spent
 * redrawing a still image. Blitting a cached bitmap keeps the per-frame work a
 * texture fetch instead of a per-pixel radial-gradient evaluation.
 *
 * Baked 1:1 with `Paint.isDither`, NOT downsampled. An eighth-scale source upsampled
 * bilinearly looks like it would hide the 8-bit steps that make a low-alpha radial
 * band, but it cannot: the interpolation happens on the way into an 8-bit destination,
 * so the result re-quantises to the same levels. It measured as ~1-level steps 30-50px
 * wide — wide, smooth-edged bands, the most visible kind. Dithering has to be applied
 * at destination resolution to do anything, which is the same reason the results
 * backdrop bakes its noise 1:1.
 */
private class GlowCache {
    private var cached: ImageBitmap? = null
    private var cachedW = 0
    private var cachedH = 0

    fun get(w: Int, h: Int): ImageBitmap? {
        if (w <= 0 || h <= 0) return null
        cached?.let { if (w == cachedW && h == cachedH) return it }
        cachedW = w
        cachedH = h
        return render(w, h).also { cached = it }
    }

    private fun render(sw: Int, sh: Int): ImageBitmap {
        val bmp = Bitmap.createBitmap(sw, sh, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bmp)
        val cx = sw * 0.5f
        val cy = sh * 0.3f
        // Max distance from the (0.5w, 0.3h) center to the four corners.
        val maxCornerDistance = maxOf(
            maxOf(hypot(cx, cy), hypot(sw - cx, cy)),
            maxOf(hypot(cx, sh - cy), hypot(sw - cx, sh - cy)),
        )
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.isDither = true // the whole point: break the 8-bit steps at 1:1
        paint.shader = RadialGradient(
            cx, cy, 0.55f * maxCornerDistance,
            // Transparent BLACK as the end stop, exactly what `Color.Transparent`
            // gave the Compose brush — Skia interpolates gradient stops unpremultiplied,
            // so an end stop of a different hue would tint the falloff.
            Tokens.accentPrimary.copy(alpha = 0.06f).toArgb(), 0x00000000,
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, sw.toFloat(), sh.toFloat(), paint)
        return bmp.asImageBitmap()
    }
}

/** Draw one particle's hex cells by stamping the cached pillow bitmap at each cell,
 *  weighted by the particle opacity (web `globalAlpha` over a `getHexStamp` stamp).
 *  Positions/sizes are reference-space and scaled to the canvas here (scale 1 on a
 *  1080p surface, 2 on 4K); the stamp is rendered at the scaled size so it stays crisp. */
private fun DrawScope.drawFallingPiece(p: FallingPiece, stamps: PieceStampCache) {
    val scale = size.width / REF_W
    val stamp = stamps.get(p.colorArgb, p.blockSize * scale)
    val halfW = stamp.width / 2f
    val halfH = stamp.height / 2f
    val alpha = p.opacity.coerceIn(0f, 1f)
    for (cell in p.cells) {
        val q = cell[0]
        val r = cell[1]
        val cx = (p.x + p.blockSize * 1.5f * q) * scale
        val cy = (p.y + p.blockSize * SQRT3 * (r + q / 2f)) * scale
        drawImage(stamp, topLeft = Offset(cx - halfW, cy - halfH), alpha = alpha)
    }
}

/**
 * Pre-rendered hex-cell stamps, keyed on (color, whole-px block size) — the port of
 * the web `getHexStamp` cache. Each stamp is the full-opacity PILLOW recipe (web
 * `_stampHexPillow`, matching the favicon/app-icon look): a flat-fill rounded hex
 * with a top-left radial gloss and a bottom-edge shadow line. Rendering a stamp
 * once and blitting it per cell replaces the previous per-cell-per-frame
 * `Brush.radialGradient` (a native shader allocation) — the 60fps loop now only
 * does bitmap draws. Bounded: block sizes span 12..32 reference px times the fixed
 * canvas scale (≤64px on 4K) and there are 6 piece colors, so at most a few hundred
 * tiny bitmaps live here for the lobby's lifetime.
 */
private class PieceStampCache {
    private val cache = HashMap<Long, ImageBitmap>()

    fun get(colorArgb: Int, blockSize: Float): ImageBitmap {
        val px = blockSize.roundToInt().coerceAtLeast(1)
        val key = (colorArgb.toLong() shl 32) or px.toLong()
        return cache.getOrPut(key) { render(colorArgb, px) }
    }

    private fun render(colorArgb: Int, px: Int): ImageBitmap {
        val cr = px * 0.94f // circumradius == web `sCell` (getHexStamp cr = size/√3)
        val heightSize = SQRT3 * cr // web stamp `size` (drawn height) for line-width proportions
        val strokeW = max(0.5f, heightSize * 0.04f)
        // Pad past the hex bbox so the bottom shadow stroke + antialiasing aren't cropped.
        val pad = ceil(strokeW).toInt() + 1
        val w = ceil(2f * cr).toInt() + 2 * pad
        val h = ceil(heightSize).toInt() + 2 * pad
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bmp)
        val cx = w / 2f
        val cy = h / 2f
        val cornerR = cr * 0.15f
        val path = android.graphics.Path().apply { addRoundedHex(cx, cy, cr, cornerR) }
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        // Base: flat fill.
        paint.color = colorArgb
        canvas.drawPath(path, paint)
        // Radial gloss: white 0.3 -> transparent, center offset up-left. (Web uses a
        // two-point radial; Android is single-center, approximated at the web start.)
        paint.shader = RadialGradient(
            cx - cr * 0.05f, cy - cr * 0.1f, cr * 1.1f,
            0x4DFFFFFF, 0x00FFFFFF, Shader.TileMode.CLAMP,
        )
        canvas.drawPath(path, paint)
        paint.shader = null
        // Bottom shadow line across the two lower vertices, pulled inside the
        // rounded corners.
        val lineInset = cornerR / SQRT3
        val v1 = HexGeometry.unitVertices[1]
        val v2 = HexGeometry.unitVertices[2]
        paint.color = 0x40000000 // black at 0.25
        paint.strokeWidth = strokeW
        paint.style = Paint.Style.STROKE
        canvas.drawLine(
            cx + cr * v1.x.toFloat() - lineInset, cy + cr * v1.y.toFloat(),
            cx + cr * v2.x.toFloat() + lineInset, cy + cr * v2.y.toFloat(),
            paint,
        )
        return bmp.asImageBitmap()
    }
}
