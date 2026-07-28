package com.hexstacker.core.testing

import app.cash.zipline.QuickJs

/**
 * Test-only sugar restoring the two shapes quickjs-kt gave for free, now that the engine
 * binding is Zipline's [QuickJs] (see EngineBridge's class comment for why it moved:
 * ~776us of per-call wrapper against ~78us).
 *
 * Named `evalAs`, not `evaluate`: Zipline's member `evaluate(script, fileName = ...)` is
 * callable with one argument, and a member always beats an extension, so an `evaluate<T>`
 * extension would simply be unreachable.
 *
 * Duplicated per test source set on purpose. Kotlin has no test-fixture visibility across
 * source sets or modules without publishing an artifact, and wiring a shared srcDir into
 * AGP 9's Kotlin source sets cost more build complexity than three copies of thirty lines.
 * If one changes, change all three: :core/jvmTest, :tv/test, :tv/androidTest.
 */
internal inline fun <reified T> QuickJs.evalAs(code: String): T {
    val value = evaluate(code, "test.js")
    @Suppress("UNCHECKED_CAST")
    // QuickJS hands small integers back as some Number; these call sites ask for Int.
    return if (T::class == Int::class && value is Number) value.toInt() as T else value as T
}

/** Create a runtime, run [block] against it, always close it. */
internal inline fun <T> quickJs(block: QuickJs.() -> T): T {
    val quickJs = QuickJs.create()
    return try {
        quickJs.block()
    } finally {
        quickJs.close()
    }
}
