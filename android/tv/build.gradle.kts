// :tv — the Android TV app (Leanback). Renders natively (Jetpack Compose for TV
// + android.graphics.Canvas) and drives the canonical game engine that runs in
// QuickJS inside :core. AGP 9 compiles Kotlin built-in (no separate kotlin
// plugin needed).
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.roborazzi)
    // Collects dependency + license metadata into res/raw/aboutlibraries.json at
    // build time (consumed by the Open Source Licenses screen). Auto-wired into the
    // Android resource pipeline as long as the export output path is left default.
    alias(libs.plugins.aboutlibraries)
    // Consumer side of :baselineprofile — merges the generated app profile (plus the
    // library profiles) into the release artifact. Regenerate with
    // `./gradlew :tv:generateBaselineProfile` after big UI/startup changes.
    alias(libs.plugins.baselineprofile)
}

// Open-source license report generation (res/raw/aboutlibraries.json, consumed by
// the licenses screen). offlineMode is left off so the plugin embeds the full SPDX
// license text (the Apache-2.0 body covering ~94 of the deps) into the report; it
// does NOT enable the GitHub remote-license API (fetchRemoteLicense stays off), so
// no per-repo network calls happen. Licenses the plugin can't resolve to embedded
// text (the WebRTC BSD-3-Clause) and non-dependency attributions (Orbitron font,
// lobby music, the MIT QuickJS engine bundled in quickjs-kt) are supplied by the
// screen itself (see Licenses.kt) — if the plugin ever can't fetch a body, the
// screen falls back to the license name + URL, so the build never hard-fails.
// includePlatform=false drops the Compose BOM (a platform artifact, no code).
aboutLibraries {
    offlineMode = false
    collect {
        includePlatform = false
    }
    export {
        prettyPrint = true
    }
}

// The canonical engine bundle (dist/partycore.js, the HexCore iife) is the EXACT
// same JS artifact the web/tests use. It is git-ignored and built from the JS
// sources, so it cannot drift; the app bundles it into assets and loads it in
// QuickJS at runtime.
val engineBundleAssets = layout.buildDirectory.dir("generated/engineAssets")
val repoRoot = rootProject.layout.projectDirectory.dir("..")
val engineBundle = repoRoot.file("dist/partycore.js")

// Regenerate the bundle from source at build time, the Gradle analog of the Xcode
// "Sync engine JS" pre-build phase: a fresh clone builds and runs the APK with no
// manual `npm run build` first, and the bundle can never be stale. Node resolution
// and the fresh-clone `npm ci` bootstrap live in scripts/build-engine.sh, the SAME
// script sync-engine.sh runs, so the toolchain handling can't drift between the two
// native phases. Declared inputs/outputs let Gradle skip this when nothing changed.
val buildEngineBundle = tasks.register<Exec>("buildEngineBundle") {
    workingDir = repoRoot.asFile
    // /bin/bash by absolute path so locating the shell itself doesn't depend on the
    // (possibly minimal) PATH Gradle inherits; the script resolves node from there.
    commandLine("/bin/bash", "scripts/build-engine.sh", "build:core")
    // The core bundle's module graph is server/*.js + partyplug/RoomFlow.js, driven
    // by scripts/build.js — any change there must rebuild it (see server/core-entry.js).
    inputs.dir(repoRoot.dir("server")).withPropertyName("engineSources")
    inputs.file(repoRoot.file("partyplug/RoomFlow.js")).withPropertyName("roomFlow")
    inputs.file(repoRoot.file("scripts/build.js")).withPropertyName("buildScript")
    inputs.file(repoRoot.file("scripts/build-engine.sh")).withPropertyName("buildEngineScript")
    outputs.file(engineBundle)
}
val syncEngineBundle = tasks.register<Copy>("syncEngineBundle") {
    from(buildEngineBundle)
    into(engineBundleAssets)
}

// Release signing is driven by a gitignored `android/keystore.properties` (see
// keystore.properties.example). It is absent on CI and other machines, so
// `hasReleaseKeystore` is false there and the release build falls back to debug
// signing — the project still builds and tests. A real Play Store upload needs
// the file present with the upload keystore it points at.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}
// storeFile is an absolute path to the upload keystore, so the .jks can live anywhere
// on the machine, outside the repo. `file()` leaves an absolute path untouched —
// unlike a relative one, which it would re-root under this module (android/tv), not
// where the keystore actually is.
val releaseStoreFile = keystoreProps.getProperty("storeFile")?.let { file(it) }
val hasReleaseKeystore = releaseStoreFile != null

android {
    namespace = "com.hexstacker.tv"
    compileSdk = 37
    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }
    defaultConfig {
        // Deliberately NOT the namespace above, and not tvOS's bundle id: an
        // AirConsole build must ship under the AirConsole game id, which is frozen
        // at creation, and Play package names are permanent from the first upload.
        // Claiming it now is what keeps a single binary able to serve both the
        // standalone and the AirConsole mode later. The Kotlin package stays
        // com.hexstacker.tv, so this only ever appears as the install identity.
        applicationId = "com.couchgames.stacker"
        minSdk = 28
        targetSdk = 36
        // Stamped by the release workflow, the Gradle analog of tvOS's
        // xcodebuild MARKETING_VERSION / CURRENT_PROJECT_VERSION overrides: a
        // unique versionCode (Play rejects a reused one, so the constant 1
        // below could only ever be uploaded once) and the bare-semver tag as
        // versionName. The placeholders are what every non-release build gets.
        // How the workflow derives the code, and which band is reserved for
        // hand-built phoneTest uploads, lives in .github/workflows/release.yml —
        // stating it here too is just a second copy to drift.
        versionCode = (findProperty("hexVersionCode") as String?)?.toInt() ?: 1
        versionName = (findProperty("hexVersionName") as String?) ?: "1.0"
        // On-device navigation tests (NavigationTest): run locally against an
        // Android TV emulator via `:tv:connectedDebugAndroidTest` (not wired
        // into CI, which has no emulator).
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // armeabi-v7a is NOT legacy here: the Google TV Streamer (and the older
        // Chromecast with Google TV) run a 32-bit-only userspace, so an
        // arm64-only APK cannot install on them at all. x86_64 is for the
        // emulator. x86 stays dropped (no current TV or emulator needs it).
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }
    // Controller/QR origin, chosen at BUILD time:
    //   ./gradlew :tv:installRelease -PhexControllerHost=main.hexstacker.com
    // Empty (the default) means production. This exists because the `--es hexHost` launch
    // extra is deliberately debuggable-only — any app on the device can send an extra, and
    // a shipped build must never let one repoint the QR — so it is unavailable in exactly
    // the build you want when testing a branch WITH release optimisations on. A build-time
    // value has no runtime attack surface at all.
    defaultConfig {
        resValue(
            "string",
            "controller_host_override",
            (findProperty("hexControllerHost") as String?).orEmpty(),
        )
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed with the real upload keystore when android/keystore.properties
            // is present; otherwise debug-signed so the release build stays
            // installable for testing on machines/CI without the keystore.
            signingConfig = signingConfigs.getByName(if (hasReleaseKeystore) "release" else "debug")
        }
        // A release build that also installs on phones and tablets
        // (src/phoneTest/AndroidManifest.xml). Play's closed-testing
        // requirement wants 12 testers for 14 continuous days, and testers who
        // own only a phone cannot install a leanback-required app at all.
        // Same applicationId, so it uploads to the same Play track; bump
        // -PhexVersionCode past the last release or Play rejects it.
        //
        // Deliberately a build type and not a flag on `release`: CI builds
        // `release`, so no tag can ever ship the phone-installable manifest to
        // the TV listing by accident.
        create("phoneTest") {
            initWith(getByName("release"))
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = false
        resValues = true // for controller_host_override above; off by default in AGP 9
    }
    // Robolectric-backed screenshot tests (Roborazzi) need the merged resources +
    // assets (Orbitron fonts, localized strings) on the JVM unit-test classpath.
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
    // The QuickJS test shim is identical for the JVM unit tests and the instrumentation
    // tests, so it lives in one place both source sets read rather than as two copies that
    // drift. (:core needs its own — different module, and Kotlin has no cross-module test
    // visibility without publishing a fixtures artifact.)
    // Plain File (not a Provider): AGP 9 disallows Provider in the legacy
    // SourceSet API. Ordering is carried by the preBuild dependency below.
    sourceSets["main"].assets.srcDir(engineBundleAssets.get().asFile)
}

kotlin {
    jvmToolchain(17)
}

tasks.named("preBuild") {
    dependsOn(syncEngineBundle)
}

// The screenshot tests derive their fixture data by running the canonical engine
// bundle (dist/partycore.js) in QuickJS on the Robolectric host JVM, exactly as
// :core:jvmTest does. Point them at the repo-root bundle by absolute path so the
// test is hermetic regardless of the working directory.
tasks.withType<Test>().configureEach {
    val repoRoot = rootProject.layout.projectDirectory.dir("..")
    val bundle = repoRoot.file("dist/partycore.js")
    systemProperty("hexcore.bundle", bundle.asFile.absolutePath)
    // A systemProperty is NOT a file input, so without this a rebuilt bundle leaves these
    // tests UP-TO-DATE and they never re-run against it. Same reasoning as :core, including
    // why this is `files` rather than `file` (dist/ is generated and untracked).
    inputs.files(bundle)
        .withPropertyName("hexcoreBundle")
        .withPathSensitivity(PathSensitivity.NONE)
}

// :tv resolves the ANDROID variant of the QuickJS binding transitively through :core,
// whose AAR only bundles Android ELF .so files — those can't load on the host JVM the
// Robolectric unit tests run on. Drop it from the unit-test runtime classpath and
// substitute the desktop-JVM variant (added as testImplementation below), which ships the
// host natives (libquickjs.dylib / .so / .dll) behind the identical API.
//
// The exclude is not optional hygiene: both variants install `jni/<abi>/libquickjs.so`, so
// a classpath carrying two of them keeps one and the loser's JNI symbols go missing —
// UnsatisfiedLinkError from a native method that plainly exists.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    exclude(group = "app.cash.zipline", module = "zipline-android")
}

dependencies {
    implementation(project(":core"))
    baselineProfile(project(":baselineprofile"))

    // Parses the generated res/raw/aboutlibraries.json for the licenses screen
    // (data only — the screen renders its own TV-focusable list, not the M3 UI).
    implementation(libs.aboutlibraries.core)

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.profileinstaller)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.lifecycle.runtime.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // Audio (Media3/ExoPlayer) + QR (ZXing)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.common)
    implementation(libs.zxing.core)
    implementation(libs.kotlinx.coroutines.android)
    // JSON types cross the :core Fastlane interface (JsonObject) + the WebRTC binding builds
    // signaling/ack envelopes; the runtime API only (no serialization compiler plugin needed).
    implementation(libs.kotlinx.serialization.json)

    // WebRTC fast-lane: prebuilt libwebrtc (org.webrtc.*) for low-latency P2P
    // controller input over an unreliable DataChannel, with the relay as fallback.
    implementation(libs.webrtc.sdk)

    // ── Screenshot tests (JVM, no emulator): Roborazzi renders the Compose screens
    // and the Canvas BoardRenderer under Robolectric's native-graphics mode and
    // writes PNGs for CI artifacts + golden diffing. `./gradlew :tv:recordRoborazziDebug`.
    testImplementation(composeBom)
    testImplementation(libs.junit)
    // Runs the canonical engine bundle in QuickJS on the host JVM to source the
    // cross-platform gallery fixtures (see GalleryFixtures test helper). The -jvm
    // variant carries the desktop natives the android AAR lacks.
    testImplementation(libs.zipline.jvm)
    testImplementation(libs.kotlinx.coroutines.core)
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.androidx.compose.ui.test.junit4)
    // Supplies the empty ComponentActivity that createComposeRule() hosts content in.
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    // ── On-device navigation tests (uiautomator drives the real remote keys against
    // the installed app, the Android analog of the tvOS UITests/NavigationTests).
    // Local-only: `./gradlew :tv:connectedDebugAndroidTest` with a TV emulator attached.
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.uiautomator)
    // EnginePerfTest drives its own QuickJS with a measurement shim, to separate
    // engine compute from JSON.stringify (the shipping shim only ever returns JSON).
    // :core keeps quickjs-kt `implementation`, so it isn't on this classpath already.
    androidTestImplementation(libs.zipline)
    androidTestImplementation(libs.kotlinx.coroutines.core)
}
