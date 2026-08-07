package com.hexstacker.tv

import android.os.VibrationEffect
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import com.hexstacker.core.display.PadReading
import com.hexstacker.core.display.PadSource

/**
 * Reads attached gamepads through InputDevice and presents them in the W3C
 * "standard" mapping the shared mapper expects (`server/PadMapper.js`). This file
 * is the ONLY place that knows what an Android KeyEvent is; what a press MEANS is
 * either in the portable mapper or in PadSeats.
 *
 * Android delivers button state as EVENTS, not as a queryable snapshot the way
 * `navigator.getGamepads()` and GameController do, so this keeps its own held-key
 * state per device, fed by the Activity's dispatchKeyEvent. The axes DO come as a
 * snapshot on each MotionEvent, so those are cached from the last one seen.
 *
 * Two conversions matter and both fail silently rather than loudly:
 *
 *  - Y AXIS SIGN. AXIS_Y is already positive-DOWN, which happens to match the web,
 *    so it is passed through. It is called out here because the tvOS source has to
 *    flip its equivalent, and a reader comparing the two would otherwise assume
 *    one of them is wrong.
 *  - HAT vs D-PAD. Most pads report their d-pad as AXIS_HAT_X/Y rather than as
 *    KEYCODE_DPAD_*, so both are folded into the same four button indices. A pad
 *    reporting only hats would otherwise look like it had no d-pad at all.
 */
class AndroidPadSource : PadSource {

    /** deviceId -> held buttons, in W3C index order. */
    private val held = mutableMapOf<Int, BooleanArray>()

    /**
     * deviceId -> buttons pressed since the last poll, whether or not they are
     * still down.
     *
     * Android hands us discrete key events while the consumer SAMPLES, and the
     * lobby samples at ~4Hz to stay idle-cheap. A tap is far shorter than 250ms,
     * so a press and its release can land entirely between two samples and vanish
     * — including the very first press, the one that joins. Latching until the
     * poll has seen it makes input independent of the sampling rate rather than
     * betting on it. Web and tvOS have no equivalent because both read a live
     * hardware snapshot, where a press cannot go missing this way.
     */
    private val latched = mutableMapOf<Int, BooleanArray>()

    /** deviceId -> `[leftX, leftY, rightX, rightY]` from the last MotionEvent. */
    private val axes = mutableMapOf<Int, DoubleArray>()

    /** deviceId -> hat-derived `[up, down, left, right]`. See onMotionEvent. */
    private val hats = mutableMapOf<Int, BooleanArray>()

    /** Stable slot per device, so a reconnecting pad reclaims its seat. */
    private val slots = mutableMapOf<Int, Int>()


    /**
     * Feed from the Activity's dispatchKeyEvent. Returns true when the press
     * belonged to a gamepad and was recorded, which is the caller's cue to stop it
     * reaching Compose focus. See MainActivity for when that suppression applies.
     */
    fun onKeyEvent(event: KeyEvent): Boolean {
        if (!isGamepad(event.device)) return false
        val index = buttonIndex(event.keyCode) ?: return false
        val down = event.action == KeyEvent.ACTION_DOWN
        state(event.deviceId)[index] = down
        if (down) latch(event.deviceId)[index] = true
        return true
    }

    /** Feed from the Activity's dispatchGenericMotionEvent. */
    fun onMotionEvent(event: MotionEvent): Boolean {
        if (!isGamepad(event.device)) return false
        if (event.action != MotionEvent.ACTION_MOVE) return false
        axes[event.deviceId] = doubleArrayOf(
            event.getAxisValue(MotionEvent.AXIS_X).toDouble(),
            // Already positive-DOWN on Android, unlike GameController. Not a bug.
            event.getAxisValue(MotionEvent.AXIS_Y).toDouble(),
            event.getAxisValue(MotionEvent.AXIS_Z).toDouble(),
            event.getAxisValue(MotionEvent.AXIS_RZ).toDouble(),
        )
        // Triggers are ANALOG on most pads: they arrive as an axis here and never
        // as KEYCODE_BUTTON_L2/R2 at all, so without this L2 and R2 simply do
        // nothing. Two axis pairs because vendors disagree about which they
        // report, and some report both. Past halfway counts as pressed, matching
        // the digital sense the shared mapper expects.
        val leftTrigger = maxOf(
            event.getAxisValue(MotionEvent.AXIS_LTRIGGER),
            event.getAxisValue(MotionEvent.AXIS_BRAKE),
        )
        val rightTrigger = maxOf(
            event.getAxisValue(MotionEvent.AXIS_RTRIGGER),
            event.getAxisValue(MotionEvent.AXIS_GAS),
        )
        val buttons = state(event.deviceId)
        if (leftTrigger > 0.5f && !buttons[L2]) latch(event.deviceId)[L2] = true
        if (rightTrigger > 0.5f && !buttons[R2]) latch(event.deviceId)[R2] = true
        buttons[L2] = leftTrigger > 0.5f
        buttons[R2] = rightTrigger > 0.5f

        // A hat IS the d-pad on most pads, and arrives here rather than as a key.
        // Kept SEPARATE from the key-driven state and OR-ed at read time: a pad
        // that reports both would otherwise have its hat snapshot clear the
        // direction its keycode just set, on every motion event.
        val hatX = event.getAxisValue(MotionEvent.AXIS_HAT_X)
        val hatY = event.getAxisValue(MotionEvent.AXIS_HAT_Y)
        hats[event.deviceId] = booleanArrayOf(
            hatY < -0.5f,   // up
            hatY > 0.5f,    // down
            hatX < -0.5f,   // left
            hatX > 0.5f,    // right
        )
        return true
    }

    override fun pads(): List<PadReading> {
        val readings = mutableListOf<PadReading>()
        for (id in InputDevice.getDeviceIds()) {
            val device = InputDevice.getDevice(id) ?: continue
            if (!isGamepad(device)) continue
            val buttons = state(id).copyOf()
            // A press the poll has not seen yet counts as down for exactly this
            // reading, then clears: still-held keys keep themselves true through
            // `held`, and a released one reads false next poll, which is the edge
            // the mapper needs.
            latched[id]?.let { pending ->
                for (i in pending.indices) {
                    if (pending[i]) buttons[i] = true
                    pending[i] = false
                }
            }
            hats[id]?.let { hat ->
                buttons[UP] = buttons[UP] || hat[0]
                buttons[DOWN] = buttons[DOWN] || hat[1]
                buttons[LEFT] = buttons[LEFT] || hat[2]
                buttons[RIGHT] = buttons[RIGHT] || hat[3]
            }
            readings.add(
                PadReading(
                    slot = slot(id),
                    id = device.name ?: "Gamepad",
                    buttons = buttons.toList(),
                    axes = (axes[id] ?: DoubleArray(4)).toList(),
                )
            )
        }
        // Forget devices that are gone, so a slot can be reused rather than
        // leaking one per reconnect over a long session.
        val live = InputDevice.getDeviceIds().toSet()
        held.keys.retainAll(live)
        latched.keys.retainAll(live)
        axes.keys.retainAll(live)
        hats.keys.retainAll(live)
        slots.keys.retainAll(live)
        return readings.sortedBy { it.slot }
    }

    override fun rumble(slot: Int, durationMs: Long, amplitude: Double) {
        val deviceId = slots.entries.firstOrNull { it.value == slot }?.key ?: return
        val vibrator = InputDevice.getDevice(deviceId)?.vibrator ?: return
        if (!vibrator.hasVibrator()) return
        val scaled = (amplitude * 255).toInt().coerceIn(1, 255)
        vibrator.vibrate(VibrationEffect.createOneShot(durationMs, scaled))
    }

    // --- internals -----------------------------------------------------------

    private fun state(deviceId: Int): BooleanArray =
        held.getOrPut(deviceId) { BooleanArray(17) }

    private fun latch(deviceId: Int): BooleanArray =
        latched.getOrPut(deviceId) { BooleanArray(17) }

    private fun slot(deviceId: Int): Int = slots.getOrPut(deviceId) {
        val taken = slots.values.toSet()
        var next = 0
        while (taken.contains(next)) next++
        next
    }

    private fun isGamepad(device: InputDevice?): Boolean {
        val sources = device?.sources ?: return false
        return sources and InputDevice.SOURCE_GAMEPAD == InputDevice.SOURCE_GAMEPAD ||
            sources and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK
    }

    /** Android keycode to W3C "standard" index, by PHYSICAL position. */
    private fun buttonIndex(keyCode: Int): Int? = when (keyCode) {
        KeyEvent.KEYCODE_BUTTON_A -> 0      // bottom face on every brand
        KeyEvent.KEYCODE_BUTTON_B -> 1
        KeyEvent.KEYCODE_BUTTON_X -> 2
        KeyEvent.KEYCODE_BUTTON_Y -> 3
        KeyEvent.KEYCODE_BUTTON_L1 -> 4
        KeyEvent.KEYCODE_BUTTON_R1 -> 5
        KeyEvent.KEYCODE_BUTTON_L2 -> 6
        KeyEvent.KEYCODE_BUTTON_R2 -> 7
        // 8 is Select/Back, which the mapper leaves unbound on purpose.
        KeyEvent.KEYCODE_BUTTON_START, KeyEvent.KEYCODE_MENU -> 9
        KeyEvent.KEYCODE_DPAD_UP -> UP
        KeyEvent.KEYCODE_DPAD_DOWN -> DOWN
        KeyEvent.KEYCODE_DPAD_LEFT -> LEFT
        KeyEvent.KEYCODE_DPAD_RIGHT -> RIGHT
        else -> null
    }

    private companion object {
        const val L2 = 6
        const val R2 = 7
        const val UP = 12
        const val DOWN = 13
        const val LEFT = 14
        const val RIGHT = 15
    }
}
