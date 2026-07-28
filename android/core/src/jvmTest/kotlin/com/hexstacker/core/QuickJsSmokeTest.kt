package com.hexstacker.core

import com.hexstacker.core.testing.evalAs
import com.hexstacker.core.testing.quickJs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.runBlocking

/**
 * Spike de-risk: proves the QuickJS binding resolves from Maven Central, its native
 * library loads on this desktop JVM (macOS arm64), and arbitrary JS evaluates.
 * If this is green, the "run the canonical engine in QuickJS" thesis holds and
 * we move on to loading the real HexCore bundle through it.
 */
class QuickJsSmokeTest {
    @Test
    fun evaluatesArithmetic() = runBlocking {
        val result = quickJs { evalAs<Int>("1 + 2") }
        assertEquals(3, result)
    }

    @Test
    fun evaluatesString() = runBlocking {
        val result = quickJs { evalAs<String>("'hex' + 'stacker'") }
        assertEquals("hexstacker", result)
    }
}
