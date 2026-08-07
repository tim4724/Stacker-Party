package com.hexstacker.core.display

import com.hexstacker.core.engine.EngineBridge
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.net.Msg
import com.hexstacker.core.net.RoomState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.double
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Gamepads attached to the TV itself, as players.
 *
 * A pad is not a second kind of player. Every press becomes the SAME message a
 * phone would have sent and goes through the coordinator's ordinary inbound path,
 * so joining, auto-naming, colour slots, host election, liveness and pause all
 * keep running their one implementation. What a local seat skips is the relay,
 * which is why its peer index comes from a range the relay will never hand out —
 * see [PadSeats.LOCAL_SEAT_BASE] for the range and the packed-frame constraint
 * that makes it a HIGH POSITIVE one.
 *
 * The MAPPING is not here. Which button rotates, how fast a held direction
 * repeats and how the stick scales a soft drop live in `server/PadMapper.js` and
 * cross through [EngineBridge.padPollJson], because the web display, tvOS and
 * this must agree about what a press means. What IS here is the part that needs a
 * shell: which pads exist, which seat each holds, and where a menu press goes.
 *
 * Reading the hardware is a [PadSource], injected, so the lifecycle and routing
 * below are testable with no controller attached. The Android implementation
 * lives in :tv, where InputDevice does.
 */
interface PadSource {
    /**
     * Attached pads in STABLE slot order: a pad must keep its slot across polls
     * and reclaim it after a reconnect, or it would be a new player every time.
     */
    fun pads(): List<PadReading>

    /** Effects a phone gets as haptics through its own vibrate() call. */
    fun rumble(slot: Int, durationMs: Long, amplitude: Double)
}

data class PadReading(
    val slot: Int,
    /** The product string, cleaned up through the shared rules into a name. */
    val id: String,
    /** W3C "standard" mapping order, so one mapper serves every platform. */
    val buttons: List<Boolean>,
    /** `[leftX, leftY]`, y POSITIVE DOWN as the web reports it. The mapper reads
     *  nothing past the left stick, so nothing else is carried. */
    val axes: List<Double>,
)

/**
 * Button indices routed by hand here. The rest are the mapper's business and are
 * never named. Kept in sync with `PAD_BTN` in server/PadMapper.js.
 */
private object PadButton {
    const val FACE_DOWN = 0
    const val L1 = 4
    const val R1 = 5
    const val L2 = 6
    const val R2 = 7
    const val START = 9
}

internal class PadSeats(
    private val source: PadSource,
    private val coordinator: DisplayCoordinator,
) {
    companion object {
        /**
         * An id the relay will never hand out (it owns slot 0 and gives out
         * 1..MAX). Mirrors LOCAL_SEAT_BASE in server/PadMapper.js, which owns the
         * definition and the reason it must be POSITIVE: a player id reaches us
         * inside PartyCore's packed frame, where every integer is one UTF-16 code
         * unit, and a negative one is unencodable — packFrame throws, so the first
         * frame of a match with a pad seated kills the game. Pinned by
         * tests/protocol-swift-parity.test.js.
         */
        const val LOCAL_SEAT_BASE = 900

        /**
         * Derived from the pad's own slot, so a reconnecting pad lands back on the
         * same seat: a reconnect, not a new player.
         */
        fun seatId(slot: Int): Int = LOCAL_SEAT_BASE + slot

        /**
         * True for a seat this display owns rather than one the relay handed out.
         * Every per-peer send has to ask, because there is nothing to send to.
         */
        fun isLocalSeat(peerIndex: Int): Boolean = peerIndex >= LOCAL_SEAT_BASE
    }

    /** slot -> seat id, for pads that have actually joined. Game thread only. */
    private val seated = mutableMapOf<Int, Int>()

    /**
     * The seated slots, as an immutable snapshot for readers on OTHER threads:
     * [holdsSeat] is asked from the UI thread's dispatchKeyEvent and [hasSeats]
     * from the activity's tick gate, while [seated] mutates on the game thread.
     * Rewritten (never mutated) after every seat change, so a cross-thread read
     * sees a coherent set — at worst one poll stale, which both callers tolerate.
     */
    @kotlin.concurrent.Volatile
    private var seatedSlots: Set<Int> = emptySet()

    /** Slots whose join was refused (room full). A held button would otherwise
     *  re-send HELLO through the bridge on every poll; cleared once every button
     *  on that pad is released, so the retry is a fresh press, as on the web. */
    private val refused = mutableSetOf<Int>()

    val hasSeats: Boolean get() = seatedSlots.isNotEmpty()

    /**
     * Whether the pad in [slot] has actually joined. A press from one that has not
     * is a JOIN and must not also act, which [poll] already enforces internally by
     * handing that press to the mapper as a baseline. :tv asks the same question
     * at the other door, for the press Compose would otherwise turn into a click
     * on whatever is focused — Play Again on the results screen being the one that
     * bites.
     */
    fun holdsSeat(slot: Int?): Boolean = slot != null && seatedSlots.contains(slot)

    /**
     * Seats that joined on the LAST collect. Their press still goes to the
     * mapper, which is the point: it becomes the baseline, so the button that
     * joined reads as already-down rather than as a fresh press. What must not
     * happen is acting on it, or the bottom face button would join and start the
     * round in one press. Spans collect to route, which is why it is not a local.
     */
    private val joinedNow = mutableSetOf<Int>()

    /**
     * One poll's pad states: retire vanished pads, seat new ones, stamp
     * liveness. The mapping itself is the shim's; the CALLER decides which
     * crossing carries it — [poll]'s own, or the playing tick's frame
     * ([EngineBridge.framePads]), which is what keeps a playing tick at one
     * evaluate.
     */
    suspend fun collectStates(): JsonArray {
        val readings = source.pads()
        retireVanished(readings)
        joinedNow.clear()
        return buildJsonArray {
            for (reading in readings) {
                val existing = seated.containsKey(reading.slot)
                val seat = seatFor(reading) ?: continue
                if (!existing) joinedNow.add(seat)
                // A local seat sends nothing over the wire, so nothing else proves
                // it is still there. Its presence in this poll IS the proof; without
                // it the liveness sweep would expire an idle player mid-game.
                coordinator.markLocalSeatSeen(seat)
                add(
                    buildJsonObject {
                        put("seat", JsonPrimitive(seat))
                        put("buttons", JsonArray(reading.buttons.map { JsonPrimitive(it) }))
                        put("axes", JsonArray(reading.axes.map { JsonPrimitive(it) }))
                    }
                )
            }
        }
    }

    /**
     * Route one poll's results — the menu edges and the rumble flag; the game
     * input never comes back (the shim feeds it to the engine itself).
     */
    suspend fun route(results: JsonArray, playing: Boolean) {
        for (result in results) {
            val seat = result.jsonObject["seat"]?.jsonPrimitive?.int ?: continue
            // The joining press is a baseline, never an action. See joinedNow.
            if (joinedNow.contains(seat)) continue

            // The one effect driven by what the PLAYER did rather than what
            // happened to them. Fired off the mapping rather than the resulting
            // lock event, so the thump lands with the press.
            if (result.jsonObject["hardDrop"]?.jsonPrimitive?.boolean == true) {
                rumble(seat, "hardDrop")
            }
            val pressed = result.jsonObject["pressed"]?.jsonArray.orEmpty().map { it.jsonPrimitive.int }
            if (playing) {
                if (pressed.contains(PadButton.START)) {
                    coordinator.deliverLocal(seat, msg(Msg.PAUSE_GAME))
                }
                continue
            }
            // The UNPAUSED countdown, and only it. :tv consumes pad input during
            // the 3-2-1 (it is the GAME screen, unpaused), so nothing else hears
            // index 9 there and the remote could pause the countdown while a pad
            // could not. Once PAUSED the pad is NOT consumed — countdown included —
            // so the press reaches MainActivity's KEYCODE_BUTTON_START instead;
            // binding it here as well would toggle twice on one press and put the
            // overlay straight back up.
            if (coordinator.state == RoomState.COUNTDOWN) {
                if (!coordinator.paused && pressed.contains(PadButton.START)) {
                    // The DIRECT toggle, never remoteTogglePause: this runs inside
                    // the action consumer, and the acked public path would enqueue
                    // an action the consumer can never reach — a self-deadlock
                    // that froze the app on a pad's Start press mid-countdown.
                    coordinator.togglePause()
                }
                continue
            }
            for (step in result.jsonObject["nav"]?.jsonArray.orEmpty()) {
                onMenuNav(seat, step.jsonPrimitive.content)
            }
            for (index in pressed) onMenuPress(seat, index)
        }
    }

    /**
     * Collect, map and route in one go — the path for every tick that is NOT
     * running a frame (lobby, results, countdown, paused). The playing tick
     * rides its mapping on the frame crossing instead (see [collectStates]).
     * [nowMs] is the monotonic clock the mapper measures DAS and the soft-drop
     * keepalive against, NOT wall time.
     */
    suspend fun poll(nowMs: Double, playing: Boolean) {
        val states = collectStates()
        if (states.isEmpty()) return

        val results = try {
            coordinator.padPoll(states.toString(), nowMs, playing)
        } catch (e: Throwable) {
            coordinator.reportPadError("padPoll", e)
            return
        }
        route(results, playing)
    }

    // --- Seat lifecycle ------------------------------------------------------

    private suspend fun seatFor(reading: PadReading): Int? {
        val existing = seated[reading.slot]
        if (existing != null) {
            // The row can disappear without the pad going anywhere: a session
            // reset clears the whole roster. Give the seat up so the next press
            // joins the new room instead of feeding a player that is gone.
            if (!coordinator.hasPlayer(existing)) {
                seated.remove(reading.slot)
                seatedSlots = seated.keys.toSet()
                return null
            }
            return existing
        }
        // Any press joins. Naming one button would leave a player who pressed a
        // different one with no feedback, and no letter is right on every brand.
        // There is no welcome screen to exclude: a TV goes straight to the lobby.
        if (!reading.buttons.contains(true)) {
            refused.remove(reading.slot)
            return null
        }
        if (reading.slot in refused) return null
        return join(reading)
    }

    private suspend fun join(reading: PadReading): Int? {
        val seat = seatId(reading.slot)
        val name = coordinator.padName(reading.id)
        // The same HELLO a phone sends. autoName stays false: the pad's name is a
        // real (if borrowed) identity, not a request for an HX-n slot.
        coordinator.deliverLocal(
            seat,
            buildJsonObject {
                put("type", JsonPrimitive(Msg.HELLO))
                put("name", JsonPrimitive(name))
                put("autoName", JsonPrimitive(false))
            }
        )
        // A refused join (room full) leaves no row behind. Drop the seat, and
        // remember the refusal until the button is released (see [refused]).
        if (!coordinator.hasPlayer(seat)) {
            refused.add(reading.slot)
            return null
        }
        seated[reading.slot] = seat
        seatedSlots = seated.keys.toSet()
        return seat
    }

    private suspend fun retireVanished(readings: List<PadReading>) {
        val live = readings.map { it.slot }.toSet()
        refused.retainAll(live)
        for ((slot, seat) in seated.entries.toList()) {
            if (live.contains(slot)) continue
            seated.remove(slot)
            seatedSlots = seated.keys.toSet()
            // Same path as a phone closing its tab: mid-game the row is held (with
            // a rejoin QR) so a returning pad, or a phone scanning, resumes the
            // seat; in lobby or results it is dropped outright.
            coordinator.deliverLocal(seat, msg(Msg.LEAVE))
        }
    }

    // --- Menus ---------------------------------------------------------------

    /**
     * The lobby steps this seat's start level, which is why :tv stops routing pad
     * D-pad presses into Compose focus there: the D-pad cannot both move a focus
     * ring and set a level. Everywhere else outside play the pad is left alone to
     * drive focus like a remote, so Play Again and Continue need no binding here.
     */
    private suspend fun onMenuNav(seat: Int, direction: String) {
        if (coordinator.state != RoomState.LOBBY) return
        val step = if (direction == "right" || direction == "up") 1 else -1
        val level = coordinator.roomCore.levelAfterStep(seat, step) ?: return
        coordinator.deliverLocal(
            seat,
            buildJsonObject {
                put("type", JsonPrimitive(Msg.SET_LEVEL))
                put("level", JsonPrimitive(level))
            }
        )
    }

    /**
     * The lobby's actions, bound here because the pad owns that screen's input and
     * Compose focus never sees these presses. On the overlays the opposite holds,
     * so Play Again and Continue are deliberately absent.
     */
    private suspend fun onMenuPress(seat: Int, index: Int) {
        if (coordinator.state != RoomState.LOBBY) return

        // Starting the round is the host's call, the same rule the phones' lobby
        // renders. The bottom face button because it is the one a player reaches
        // for when they want something to happen, and Start because its meaning
        // holds on every brand. See server/PadMapper.js for why no face button is
        // brand-safe and why that does not matter in a lobby.
        if (index == PadButton.FACE_DOWN || index == PadButton.START) {
            if (seat == coordinator.room.hostPeerIndex) coordinator.deliverLocal(seat, msg(Msg.START_GAME))
            return
        }

        // Colour has no on-screen control to focus (the picker lives on the
        // phone), so it keeps a shoulder side of its own in each direction. The
        // room core resolves which slot is next; this then sends the same
        // SET_COLOR the phone's picker sends.
        val step = when (index) {
            PadButton.L1, PadButton.L2 -> -1
            PadButton.R1, PadButton.R2 -> 1
            else -> return
        }
        val next = coordinator.roomCore.colorAfterStep(seat, step) ?: return
        coordinator.deliverLocal(
            seat,
            buildJsonObject {
                put("type", JsonPrimitive(Msg.SET_COLOR))
                put("colorIndex", JsonPrimitive(next))
            }
        )
    }

    // --- Rumble --------------------------------------------------------------

    /**
     * Effects a phone gets as haptics, driven off engine events rather than a
     * message because the pad is local and the event is right there. Android has
     * one amplitude per effect rather than two motors, so the dual-rumble weak and
     * strong magnitudes collapse to the stronger of the pair.
     */
    suspend fun handle(event: GameEvent) {
        if (seated.isEmpty()) return
        when (event.type) {
            "garbage_sent" -> event.toId?.let { rumble(it, "garbageSent", event.lines ?: 0) }
            "garbage_cancelled" -> event.playerId?.let { rumble(it, "garbageCancelled") }
            // The stack just got shoved up. Distinct from garbage_sent, which is
            // only the telegraph: in between, this player could still have
            // cancelled it.
            "garbage_applied" -> event.playerId?.let { rumble(it, "garbageApplied", event.lines ?: 0) }
            "line_clear" -> event.playerId?.let { rumble(it, "lineClear", event.lines ?: 0) }
            "player_ko" -> event.playerId?.let { rumble(it, "playerKO") }
            else -> Unit
        }
    }

    /**
     * Cached across the whole session: the effect for a given (kind, lines) never
     * changes, and looking it up crosses the bridge.
     */
    private val effects = mutableMapOf<String, Effect?>()

    private data class Effect(val durationMs: Long, val amplitude: Double)

    private suspend fun rumble(seat: Int, kind: String, lines: Int = 0) {
        val slot = seated.entries.firstOrNull { it.value == seat }?.key ?: return
        val key = "$kind:$lines"
        val effect = if (effects.containsKey(key)) effects[key] else {
            val decoded = runCatching {
                val json = coordinator.padRumbleJson(kind, lines)
                val obj = Json.Default.parseToJsonElement(json).jsonObject
                Effect(
                    durationMs = obj.getValue("durationMs").jsonPrimitive.double.toLong(),
                    // Android's InputDevice vibrator has ONE motor where a
                    // dual-rumble pad has two, so the pair collapses to the
                    // stronger of them rather than averaging into mush.
                    amplitude = maxOf(
                        obj.getValue("weak").jsonPrimitive.double,
                        obj.getValue("strong").jsonPrimitive.double,
                    ),
                )
            }.getOrNull()
            effects[key] = decoded
            decoded
        }
        effect?.let { source.rumble(slot, it.durationMs, it.amplitude) }
    }

    private fun msg(type: String): JsonObject =
        buildJsonObject { put("type", JsonPrimitive(type)) }
}
