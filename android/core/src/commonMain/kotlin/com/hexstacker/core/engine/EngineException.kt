package com.hexstacker.core.engine

import kotlinx.coroutines.CancellationException

/**
 * Typed engine failures. The QuickJS binding throws a Kotlin exception when JS throws, so
 * we just try/catch around `evaluate` and wrap (no Swift-style ExceptionBox).
 */
sealed class EngineException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    object BridgeUnavailable : EngineException("Bridge/HexCore not available after bootstrap")
    class Eval(label: String, cause: Throwable) : EngineException("Engine eval failed: $label", cause)
    class Decode(label: String, cause: Throwable) : EngineException("Failed to decode $label", cause)

    companion object {
        // The engine methods catch Throwable to rewrap JS failures; CancellationException
        // must pass through untouched so coroutine cancellation (e.g. navigating away
        // mid-frame) stays cooperative instead of surfacing as a spurious engine error.
        fun wrap(label: String, e: Throwable): EngineException {
            if (e is CancellationException) throw e
            return if (e is EngineException) e else Eval(label, e)
        }

        fun decode(label: String, e: Throwable): EngineException {
            if (e is CancellationException) throw e
            return Decode(label, e)
        }
    }
}
