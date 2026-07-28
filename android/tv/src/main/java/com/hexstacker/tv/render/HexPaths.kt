package com.hexstacker.tv.render

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import com.hexstacker.core.render.DoublePair
import com.hexstacker.core.render.HexGeometry
import com.hexstacker.core.render.Rgb
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.tan

/**
 * Hex path primitives + small drawing helpers shared by the Canvas renderer.
 *
 * All math is canvas Y-DOWN, exactly like the web (`public/shared/CanvasUtils.js`);
 * there is NO axis flip here (unlike the SpriteKit/Apple TV port). Whenever Swift
 * and JS disagree on a sign, the JS wins.
 */

/** Flat-top unit-hex vertices (circumradius 1) as floats, from `:core` geometry. */
internal val HEX_UNIT_F: Array<FloatArray> =
    HexGeometry.unitVertices
        .map { floatArrayOf(it.x.toFloat(), it.y.toFloat()) }
        .toTypedArray()

/** Pack an [Rgb] to an opaque ARGB int (Canvas/Paint color). */
internal fun colorInt(rgb: Rgb): Int = rgb.toArgb()

/** Round a 0..1 alpha to an 8-bit channel, matching the web `round(a*255)`. */
internal fun a255(a: Double): Int = (a * 255.0).roundToInt().coerceIn(0, 255)

/** ARGB int for [rgb] at fractional [alpha] (0..1). */
internal fun Rgb.argb(alpha: Double): Int = toArgb(a255(alpha))

/** Append a flat-top hex sub-path centered at (cx,cy), circumradius [r]. */
internal fun Path.addHex(cx: Float, cy: Float, r: Float) {
    moveTo(cx + r * HEX_UNIT_F[0][0], cy + r * HEX_UNIT_F[0][1])
    for (i in 1 until 6) lineTo(cx + r * HEX_UNIT_F[i][0], cy + r * HEX_UNIT_F[i][1])
    close()
}

/** Append a rounded-corner flat-top hex (port of `hexPathRounded`, tangent arcs). */
internal fun Path.addRoundedHex(cx: Float, cy: Float, r: Float, cornerR: Float) {
    if (cornerR <= 0f) {
        addHex(cx, cy, r)
        return
    }
    val pts = Array(6) { floatArrayOf(cx + r * HEX_UNIT_F[it][0], cy + r * HEX_UNIT_F[it][1]) }
    // Start at the midpoint of the V5->V0 edge so the first arc has a valid tangent.
    var curX = (pts[5][0] + pts[0][0]) / 2f
    var curY = (pts[5][1] + pts[0][1]) / 2f
    moveTo(curX, curY)
    for (i in 0 until 6) {
        val corner = pts[i]
        val next = pts[(i + 1) % 6]
        val end = tangentArcTo(curX, curY, corner[0], corner[1], next[0], next[1], cornerR)
        curX = end[0]
        curY = end[1]
    }
    close()
}

/**
 * Tangent-arc corner (Android `Path` has no `arcTo(x1,y1,x2,y2,r)`). Rounds the
 * corner at (cornerX,cornerY) given the incoming point (from*) and a point on the
 * outgoing edge (to*). Returns the arc's end tangent point so the caller can keep
 * tracing. Hex interior angles are 120°, so the geometry is always well-conditioned.
 */
private fun Path.tangentArcTo(
    fromX: Float, fromY: Float,
    cornerX: Float, cornerY: Float,
    toX: Float, toY: Float,
    radius: Float,
): FloatArray {
    var v1x = fromX - cornerX
    var v1y = fromY - cornerY
    var v2x = toX - cornerX
    var v2y = toY - cornerY
    val l1 = hypot(v1x, v1y)
    val l2 = hypot(v2x, v2y)
    if (l1 < 1e-4f || l2 < 1e-4f) {
        lineTo(cornerX, cornerY)
        return floatArrayOf(cornerX, cornerY)
    }
    v1x /= l1; v1y /= l1
    v2x /= l2; v2y /= l2
    val dot = (v1x * v2x + v1y * v2y).coerceIn(-1f, 1f)
    val angle = acos(dot) // interior angle at the corner
    val tanHalf = tan(angle / 2f)
    val tanLen = if (tanHalf > 1e-4f) radius / tanHalf else 0f
    val t1x = cornerX + v1x * tanLen
    val t1y = cornerY + v1y * tanLen
    val t2x = cornerX + v2x * tanLen
    val t2y = cornerY + v2y * tanLen

    var bx = v1x + v2x
    var by = v1y + v2y
    val bl = hypot(bx, by)
    if (bl < 1e-4f) {
        // Straight line (shouldn't happen for a hex) — just connect.
        lineTo(t1x, t1y)
        lineTo(t2x, t2y)
        return floatArrayOf(t2x, t2y)
    }
    bx /= bl; by /= bl
    val sinHalf = sin(angle / 2f)
    val cDist = if (sinHalf > 1e-4f) radius / sinHalf else radius
    val ccx = cornerX + bx * cDist
    val ccy = cornerY + by * cDist

    lineTo(t1x, t1y)
    val a1 = Math.toDegrees(atan2((t1y - ccy).toDouble(), (t1x - ccx).toDouble())).toFloat()
    val a2 = Math.toDegrees(atan2((t2y - ccy).toDouble(), (t2x - ccx).toDouble())).toFloat()
    var sweep = a2 - a1
    while (sweep <= -180f) sweep += 360f
    while (sweep > 180f) sweep -= 360f
    val oval = RectF(ccx - radius, ccy - radius, ccx + radius, ccy + radius)
    arcTo(oval, a1, sweep)
    return floatArrayOf(t2x, t2y)
}

/** Build a closed [Path] from outline vertices, offset by (dx,dy). */
internal fun outlinePath(verts: List<DoublePair>, dx: Float, dy: Float): Path {
    val p = Path()
    if (verts.isEmpty()) return p
    p.moveTo(verts[0].x.toFloat() + dx, verts[0].y.toFloat() + dy)
    for (i in 1 until verts.size) p.lineTo(verts[i].x.toFloat() + dx, verts[i].y.toFloat() + dy)
    p.close()
    return p
}

/** Rounded-rect path with the radius clamped to half the smaller side (web parity). */
internal fun roundRectPath(x: Float, y: Float, w: Float, h: Float, r: Float): Path {
    val rr = min(r, min(w / 2f, h / 2f))
    val p = Path()
    p.addRoundRect(RectF(x, y, x + w, y + h), rr, rr, Path.Direction.CW)
    return p
}

/** Canvas2D text-baseline parity (Android draws from the baseline; web offsets). */
internal enum class TextBaseline { TOP, MIDDLE, BOTTOM }

/** Draw [text] so its [baseline] edge sits at (x,y) — mirrors `ctx.textBaseline`.
 *
 *  Canvas2D's top/middle/bottom are edges of the EM SQUARE, not of the font's raw
 *  ascent/descent box. Chrome normalises the two so they sum to the font size and
 *  puts the alphabetic baseline `descent / (ascent + descent)` of an em above the
 *  bottom edge — measured at 0.333em for Baloo 2 and 0.200em for Orbitron, with
 *  top + bottom == 1.000em and middle at 0.500em for both.
 *
 *  Offsetting by the raw ascent/descent instead (which exceed the em on both of our
 *  faces: Baloo's box is 1.60em tall) pushes text away from its anchor — the board
 *  name sat 0.18 cellSize too high, and TOP-anchored labels ~0.2em too low.
 *
 *  Uses Paint.ascent()/descent() (primitive returns) rather than `paint.fontMetrics`,
 *  which allocates a fresh FontMetrics per call — this helper runs under all HUD text
 *  in the 60fps draw path. */
internal fun Canvas.drawTextB(
    text: String,
    x: Float,
    y: Float,
    paint: Paint,
    baseline: TextBaseline,
) {
    val ascent = -paint.ascent()
    val descent = paint.descent()
    val box = ascent + descent
    // Baseline offset from the em-square top, in px.
    val fromTop = if (box > 0f) paint.textSize * (ascent / box) else 0f
    val dy = when (baseline) {
        TextBaseline.TOP -> fromTop
        TextBaseline.MIDDLE -> fromTop - paint.textSize / 2f
        TextBaseline.BOTTOM -> fromTop - paint.textSize
    }
    drawText(text, x, y + dy, paint)
}
