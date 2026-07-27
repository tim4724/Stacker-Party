// :core — the platform-agnostic Kotlin port core, mirroring appletv/HexStackerKit.
//
// Kotlin Multiplatform (jvm + android targets) on purpose: the JS engine binding
// (quickjs-kt) ships per-platform natives, so the jvm() target runs the golden
// conformance tests on the desktop JVM (no emulator) while the android target
// hands the app the correct .so files. A plain kotlin-jvm module would leak
// desktop natives into the Android app.
plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kotlin.multiplatform.library)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvm()
    androidLibrary {
        namespace = "com.hexstacker.core"
        compileSdk = 37
        minSdk = 28
    }
    jvmToolchain(17)

    sourceSets {
        // Intermediate source set shared by jvm + android for code that needs
        // OkHttp (which has no common KMP metadata). RelayClient lives here so the
        // jvm() target runs it in tests and the android target ships it.
        val jvmAndroidMain = create("jvmAndroidMain") { dependsOn(commonMain.get()) }
        jvmMain { dependsOn(jvmAndroidMain) }
        androidMain { dependsOn(jvmAndroidMain) }

        commonMain {
            dependencies {
                implementation(libs.quickjs.kt)
                implementation(libs.kotlinx.coroutines.core)
                implementation(libs.kotlinx.serialization.json)
            }
        }
        jvmAndroidMain.dependencies {
            implementation(libs.okhttp)
        }
        jvmTest {
            dependencies {
                implementation(kotlin("test"))
                implementation(libs.kotlinx.coroutines.core)
            }
        }
    }
}

// Point the JVM tests at the canonical native core bundle (dist/partycore.js,
// produced by `npm run build` at the repo root — the same iife the Android app
// will load into QuickJS from assets). Passed as an absolute path so the test is
// hermetic regardless of the test working directory.
tasks.withType<Test>().configureEach {
    val repoRoot = rootProject.layout.projectDirectory.dir("..")
    systemProperty("hexcore.bundle", repoRoot.file("dist/partycore.js").asFile.absolutePath)
    // Cross-engine conformance: the frame() golden driver bundle + the V8-recorded
    // golden it must reproduce when run in QuickJS.
    systemProperty("hexcore.frametest.bundle", repoRoot.file("dist/partycore-frame-test.js").asFile.absolutePath)
    systemProperty("hexcore.frametest.golden", repoRoot.file("tests/fixtures/partycore-frame-golden.json").asFile.absolutePath)
    // Cross-platform room conformance: the op log + expected snapshots the SAME
    // RoomCore module produces in Node and in JavaScriptCore on tvOS.
    systemProperty("hexcore.roombrain.golden", repoRoot.file("tests/fixtures/room-core-golden.json").asFile.absolutePath)
    // Render-math parity: the canonical web JS the Kotlin ports must match byte-for-byte.
    systemProperty("hexcore.web.constants", repoRoot.file("server/constants.js").asFile.absolutePath)
    systemProperty("hexcore.web.theme", repoRoot.file("public/shared/theme.js").asFile.absolutePath)
    systemProperty("hexcore.web.canvasutils", repoRoot.file("public/shared/CanvasUtils.js").asFile.absolutePath)
    // Opt-in live relay smoke test: ./gradlew :core:jvmTest -Dhexcore.relay.live=1
    systemProperty("hexcore.relay.live", System.getProperty("hexcore.relay.live") ?: "0")
}
