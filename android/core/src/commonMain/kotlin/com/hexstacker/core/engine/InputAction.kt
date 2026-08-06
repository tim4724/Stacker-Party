package com.hexstacker.core.engine

/**
 * Discrete controller input actions (mirror `protocol.js` INPUT). Soft drop is a
 * separate start/end pair (see [EngineBridge.softDropStart] / [EngineBridge.softDropEnd]),
 * not an action token.
 */
enum class InputAction(val wire: String) {
    LEFT("left"),
    RIGHT("right"),
    ROTATE_CW("rotate_cw"),
    ROTATE_CCW("rotate_ccw"),
    HARD_DROP("hard_drop"),
    HOLD("hold");

    companion object {
        private val byWire = entries.associateBy { it.wire }
        fun fromWire(wire: String): InputAction? = byWire[wire]
    }
}
