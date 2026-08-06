package com.hexstacker.baselineprofile

import android.content.ComponentName
import android.content.Intent
import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Generates the app-specific baseline profile for the :tv app by exercising the
 * cold-start hot path: process start → first frame → lobby entrance animation
 * (wordmark / QR+grid / CTA bands) → falling-piece background loop → engine +
 * audio warm-up kicking in (~1s post-entrance).
 *
 * The in-game path (QuickJS frame loop, BoardSurfaceView render thread) is NOT
 * covered — starting a match needs a controller joined over the relay, which an
 * emulator run can't provide. Startup + lobby is where AOT matters most anyway;
 * gameplay code is hot for minutes and JIT-compiles itself quickly.
 *
 * Run with `./gradlew :tv:generateBaselineProfile` (downloads the managed AVD's
 * system image on first run). The profile is written to
 * `tv/src/release/generated/baselineProfiles/` and should be committed.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {

    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(
        packageName = TV_PACKAGE,
        // Everything this test exercises IS the startup path, so also emit a startup
        // profile — AGP uses it to lay out the launch classes contiguously in the dex.
        includeInStartupProfile = true,
    ) {
        pressHome()
        // Explicit component: the TV app registers only a LEANBACK_LAUNCHER intent
        // filter, so the default getLaunchIntentForPackage-based launch finds nothing
        // on a phone AVD.
        startActivityAndWait(
            Intent(Intent.ACTION_MAIN).apply {
                component = ComponentName(TV_PACKAGE, TV_ACTIVITY)
            },
        )
        // Let the full startup story play: entrance bands (~950ms), the falling-piece
        // background loop, the relay create/fail settling, and the post-entrance
        // engine + audio warm-up (fires at ~1s, QuickJS compile takes a moment).
        Thread.sleep(5_000)
    }

    private companion object {
        // The install identity (:tv's applicationId) and the activity's class name
        // are NOT the same string here: the app ships under the AirConsole game id
        // while its Kotlin package stays com.hexstacker.tv. ComponentName wants one
        // of each, so deriving the second from the first would resolve to nothing.
        const val TV_PACKAGE = "com.couchgames.stacker"
        const val TV_ACTIVITY = "com.hexstacker.tv.MainActivity"
    }
}
