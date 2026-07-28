package com.hexstacker.tv.ui

import android.content.Context
import androidx.annotation.RawRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.hexstacker.tv.R
import com.mikepenz.aboutlibraries.Libs

/**
 * One row of the Licenses screen: a shipped component and the license it
 * ships under. [body] is the full license text when available, otherwise null — the
 * screen then shows only the license name + [url].
 */
data class LicenseEntry(
    val name: String,
    val author: String?,
    val license: String?,
    val url: String?,
    val body: String?,
)

/**
 * Builds the licenses list once. It is the AboutLibraries-collected dependencies
 * (parsed from res/raw/aboutlibraries.json, generated at build time by the Gradle
 * plugin) plus the non-dependency attributions this app ships that a dependency
 * scan can't see: the MIT QuickJS engine bundled inside Zipline's native library,
 * the Orbitron font (OFL), and the lobby music (CC BY).
 *
 * The Apache-2.0 body — which nearly every dependency uses — is embedded in the
 * report by the plugin. Licenses it couldn't resolve to embedded text (the WebRTC
 * BSD-3-Clause) fall back to a bundled copy in res/raw; anything still missing shows
 * the license name + URL.
 */
@Composable
fun rememberLicenseEntries(): List<LicenseEntry> {
    val context = LocalContext.current
    return remember { buildLicenseEntries(context) }
}

private fun buildLicenseEntries(context: Context): List<LicenseEntry> {
    val json = rawText(context, R.raw.aboutlibraries)
    val libs = Libs.Builder().withJson(json).build()

    val deps = libs.libraries.map { lib ->
        val license = lib.licenses.firstOrNull()
        LicenseEntry(
            name = lib.name.ifBlank { lib.uniqueId },
            author = lib.developers.mapNotNull { it.name }.joinToString()
                .ifBlank { lib.organization?.name },
            license = license?.name,
            url = license?.url,
            body = license?.licenseContent ?: fallbackBody(context, license?.name),
        )
    }

    // Attributions that are not Gradle dependencies (so AboutLibraries never sees
    // them) but whose code / assets do ship in the APK.
    val music = LicenseEntry(
        name = "Lunar Joyride",
        author = "FoxSynergy",
        license = "CC BY 3.0",
        url = "https://creativecommons.org/licenses/by/3.0/",
        body = CC_BY_MUSIC,
    )
    // The raw OFL text is font-neutral; each font contributes its own copyright
    // header (tvOS parameterises the same way in LicensesOverlay.ofl11).
    val ofl = rawText(context, R.raw.license_ofl_1_1)
    val fonts = listOf(
        LicenseEntry(
            name = "Baloo 2",
            author = "Ek Type",
            license = "SIL Open Font License 1.1",
            url = "https://github.com/EkType/Baloo2",
            body = "$OFL_BALOO\n\n$ofl",
        ),
        LicenseEntry(
            name = "Orbitron",
            author = "The Orbitron Project Authors",
            license = "SIL Open Font License 1.1",
            url = "https://github.com/theleagueof/orbitron",
            body = "$OFL_ORBITRON\n\n$ofl",
        ),
    )
    val quickJs = LicenseEntry(
        name = "QuickJS",
        author = "Fabrice Bellard, Charlie Gordon et al.",
        license = "MIT License",
        url = "https://github.com/bellard/quickjs",
        body = rawText(context, R.raw.license_mit_quickjs),
    )
    return assembleLicenseList(deps, music, fonts, quickJs)
}

/**
 * Final display order for the Licenses screen: the app's most
 * audible/visible credits lead — [music] then the bundled [fonts] — followed
 * by the Gradle [deps] sorted alphabetically, with the bundled MIT QuickJS
 * engine ([quickJs]) trailing. Pure (no Android context) so the ordering is
 * unit-testable and the screenshot fixture renders through the same code the
 * app runs, rather than a hand-copied order that can silently drift.
 */
internal fun assembleLicenseList(
    deps: List<LicenseEntry>,
    music: LicenseEntry,
    fonts: List<LicenseEntry>,
    quickJs: LicenseEntry,
): List<LicenseEntry> =
    listOf(music) + fonts + deps.sortedBy { it.name.lowercase() } + quickJs

/** Bundled full text for licenses the AboutLibraries report couldn't embed itself. */
private fun fallbackBody(context: Context, licenseName: String?): String? {
    val n = licenseName?.lowercase() ?: return null
    return when {
        "bsd" in n && "3" in n -> rawText(context, R.raw.license_bsd_3_clause)
        else -> null
    }
}

private fun rawText(context: Context, @RawRes id: Int): String =
    context.resources.openRawResource(id).bufferedReader().use { it.readText() }

// Per-font OFL copyright headers, mirroring each font's upstream OFL.txt.
private const val OFL_BALOO =
    "Copyright 2019 The Baloo 2 Project Authors (https://github.com/EkType/Baloo2)"
private const val OFL_ORBITRON =
    "Copyright 2018 The Orbitron Project Authors (https://github.com/theleagueof/orbitron), " +
        "with Reserved Font Name: \"Orbitron\""

// CC licenses are canonically referenced by their deed URL rather than a bundled
// legal text; this is the standard CC-BY attribution for the lobby track.
private const val CC_BY_MUSIC =
    "\"Lunar Joyride\" by FoxSynergy\n" +
        "Licensed under Creative Commons Attribution 3.0 Unported (CC BY 3.0)\n" +
        "https://creativecommons.org/licenses/by/3.0/"
