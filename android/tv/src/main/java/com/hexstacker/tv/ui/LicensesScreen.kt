package com.hexstacker.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hexstacker.core.render.Theme
import com.hexstacker.tv.R
import kotlin.math.max

/**
 * Licenses list (drilled into from the About screen). One focusable row per
 * shipped component; Select opens that license's text as its own page
 * ([LicenseTextScreen]) and Back returns here via the app-level BackHandler
 * (see MainActivity). Renders transparent, over the lobby backdrop the host
 * chrome keeps beneath every lobby page.
 *
 * A page rather than the old fold-open-in-place (tvOS parity): an expanded
 * body grew the list by thousands of dp and needed hand-rolled key handling
 * to scroll the oversized focused row; a pushed page keeps the list fixed and
 * the text scrolls itself through the focus engine.
 *
 * The prebuilt AboutLibraries Compose UI is a mobile/touch Material list, so this
 * renders its own list in the app's brand/token design language instead, driven
 * by plain [LicenseEntry] data (see [rememberLicenseEntries]).
 *
 * Stateless: [entries] is supplied by the caller so screenshot tests can pass a
 * fixed fixture without loading the generated report.
 */
@Composable
fun LicensesScreen(
    entries: List<LicenseEntry>,
    onOpenLicense: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val firstRow = remember { FocusRequester() }

    BoxWithConstraints(modifier.fillMaxSize()) {
        val vp = Vp(maxWidth.value, maxHeight.value)
        val overscan = Theme.Size.tvOverscan.toFloat() // TV title-safe, each edge
        val overscanH = (vp.wDp * overscan).dp
        val overscanV = (vp.hDp * overscan).dp

        Column(Modifier.fillMaxSize().padding(horizontal = overscanH, vertical = overscanV)) {
            LicensePageTitle(text = stringResource(R.string.licenses_title), vp = vp)

            LazyColumn(
                Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(vp.vwDp(13.5f, 1.45f, 28.5f)),
            ) {
                itemsIndexed(entries, key = { i, e -> "${e.name}#$i" }) { index, entry ->
                    LicenseRow(
                        entry = entry,
                        vp = vp,
                        onOpen = { onOpenLicense(index) },
                        modifier = if (index == 0) Modifier.focusRequester(firstRow) else Modifier,
                    )
                }
            }
        }
    }

    // Seat focus on the first row so the remote is live on entry, including the
    // re-entry after a license page pops (this screen recomposes fresh then).
    // Guarded: with no entries there is no row carrying the requester.
    LaunchedEffect(Unit) {
        if (entries.isNotEmpty()) firstRow.requestFocus()
    }
}

/**
 * One license's full text as its own page (pushed by a Licenses row; the title
 * is the component name — existing data, no new copy). The body is sliced into
 * half-viewport blocks of monospace lines, each an INVISIBLE focus stop, and
 * the focus engine does the scrolling: Down focuses the next block and the
 * LazyColumn brings it into view, advancing half a screen per press (tvOS
 * LicenseTextView parity — no key interception needed). Fixed line counts
 * rather than paragraphs: paragraphs are uneven, so the text lurched a line
 * at a time through short ones.
 */
@Composable
fun LicenseTextScreen(
    entries: List<LicenseEntry>,
    index: Int,
    modifier: Modifier = Modifier,
) {
    val entry = entries.getOrNull(index) ?: return
    val firstBlock = remember { FocusRequester() }

    BoxWithConstraints(modifier.fillMaxSize()) {
        val vp = Vp(maxWidth.value, maxHeight.value)
        val overscan = Theme.Size.tvOverscan.toFloat() // TV title-safe, each edge
        val overscanH = (vp.wDp * overscan).dp
        val overscanV = (vp.hDp * overscan).dp

        // Monospace: display faces are unreadable at license-text length, and the
        // canonical texts are hard-wrapped for a fixed pitch. The explicit
        // lineHeight makes the block math below exact.
        val bodyStyle = TextStyle(
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp, // tvOS Menlo 20px at 1080p
            lineHeight = 13.5.sp,
            color = Tokens.textSecondary,
        )
        val lineHDp = with(LocalDensity.current) { bodyStyle.lineHeight.toDp() }
        val body = entry.body ?: entry.url ?: ""
        val blocks = remember(body, lineHDp, maxHeight) {
            val per = max(4, ((maxHeight.value * 0.5f) / lineHDp.value).toInt())
            body.split("\n").chunked(per).map { it.joinToString("\n") }
        }

        Column(Modifier.fillMaxSize().padding(horizontal = overscanH, vertical = overscanV)) {
            LicensePageTitle(text = entry.name, vp = vp)

            LazyColumn(Modifier.fillMaxSize()) {
                itemsIndexed(blocks) { i, block ->
                    Text(
                        text = block,
                        style = bodyStyle,
                        modifier = Modifier
                            .fillMaxWidth()
                            .then(if (i == 0) Modifier.focusRequester(firstBlock) else Modifier)
                            .focusable(),
                    )
                }
            }
        }
    }

    // Seat focus on the first block so D-pad scrolling is live on entry.
    LaunchedEffect(Unit) {
        firstBlock.requestFocus()
    }
}

/** Shared page heading for the Licenses list and license-text pages. */
@Composable
private fun LicensePageTitle(text: String, vp: Vp) {
    Text(
        text = text,
        style = AppType.wordmarkMain.copy(
            fontSize = vp.vhSp(33f, 5f, 52.05f),
            letterSpacing = 0.08.em,
            color = Tokens.textPrimary,
        ),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(bottom = vp.vhDp(18f, 2.5f, 27f)),
    )
}

/**
 * A focusable license row: borderless raised card in the app card language
 * (web .result-row: bg-card + --shadow-sm, the lobby player-card surface),
 * name over author, the license pinned right as a quiet recessed capsule chip
 * (the lobby LEVEL pill). Focus adds the shared white ring + 6% wash, minus
 * the scale pop, which reads wrong on a full-width row. Select opens the
 * license text page.
 */
@Composable
private fun LicenseRow(
    entry: LicenseEntry,
    vp: Vp,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var focused by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(Tokens.radiusCard)

    Row(
        modifier
            .fillMaxWidth()
            // Press sinks the full-width row flat instead of the pill scale
            // dip (which reads wrong at this width): wash and shadow drop
            // together (web .btn:active box-shadow: none; tvOS LicenseRowStyle).
            .then(if (pressed) Modifier else Modifier.shadowSm(Tokens.radiusCard))
            .clip(shape)
            .background(Tokens.bgCard, shape)
            .then(if (focused && !pressed) Modifier.background(Tokens.white.copy(alpha = 0.06f), shape) else Modifier)
            .then(if (focused) Modifier.border(2.dp, Tokens.white, shape) else Modifier)
            .onFocusChanged { focused = it.isFocused }
            .clickable(interactionSource = interaction, indication = null) { onOpen() }
            .padding(
                horizontal = vp.vwDp(30f, 2f, 39f),
                vertical = vp.vwDp(18f, 1.45f, 28.5f),
            ),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.5.dp)) {
            Text(
                text = entry.name,
                style = AppType.resultName.copy(fontSize = 13.5.sp, color = Tokens.textPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            entry.author?.takeIf { it.isNotBlank() }?.let {
                Text(
                    text = it,
                    style = AppType.musicCredit.copy(fontSize = 9.sp, color = Tokens.textSecondary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        entry.license?.let {
            Text(
                text = it,
                style = AppType.musicCredit.copy(
                    fontSize = 9.75.sp,
                    letterSpacing = 0.06.em,
                    color = Tokens.textSecondary,
                ),
                maxLines = 1,
                modifier = Modifier
                    .clip(RoundedCornerShape(percent = 50))
                    .background(Tokens.socketPill, RoundedCornerShape(percent = 50))
                    .padding(horizontal = 9.75.dp, vertical = 6.dp),
            )
        }
    }
}

@Preview(widthDp = 960, heightDp = 540)
@Composable
private fun LicensesPreview() {
    LicensesScreen(
        entries = listOf(
            LicenseEntry("Compose UI", "The Android Open Source Project", "Apache License 2.0", null, "Apache text..."),
            LicenseEntry("WebRTC SDK", "The WebRTC project authors", "The 3-Clause BSD License", null, "BSD text..."),
            LicenseEntry("Orbitron", "The Orbitron Project Authors", "SIL Open Font License 1.1", null, "OFL text..."),
            LicenseEntry("Lunar Joyride", "FoxSynergy", "CC BY 3.0", null, "Music credit..."),
        ),
        onOpenLicense = {},
    )
}
