package com.hexstacker.tv.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The web's one shadow token (--shadow-sm: 0 2px 4px rgba(0,0,0,0.32)) as a
 * blurred rounded rect behind the content, with its web px halved to dp.
 * Deliberately NOT Modifier.shadow: elevation shadows are composited by HWUI
 * and don't render under Robolectric, so the gallery columns would silently
 * lose them. Apply BEFORE clip() so the blur isn't cut at the card bounds.
 */
fun Modifier.shadowSm(cornerRadius: Dp): Modifier =
    softShadow(cornerRadius, dy = 1.dp, blur = 2.dp, color = 0x52000000) // web 0 2px 4px @0.32

/**
 * The focused button's grown shadow (the tvOS-style focus lift, shared with
 * the Apple TV ChromeButtonChrome): same recipe as [shadowSm], deeper and
 * softer so the focused pill separates from the backdrop.
 */
fun Modifier.shadowLift(cornerRadius: Dp): Modifier =
    softShadow(cornerRadius, dy = 4.dp, blur = 6.dp, color = 0x66000000) // 0 8px 12px @0.4 in web px

private fun Modifier.softShadow(cornerRadius: Dp, dy: Dp, blur: Dp, color: Int): Modifier = drawBehind {
    val r = cornerRadius.toPx()
    val dyPx = dy.toPx()
    drawIntoCanvas { canvas ->
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color
            maskFilter = android.graphics.BlurMaskFilter(blur.toPx(), android.graphics.BlurMaskFilter.Blur.NORMAL)
        }
        canvas.nativeCanvas.drawRoundRect(0f, dyPx, size.width, size.height + dyPx, r, r, paint)
    }
}
