package com.hexstacker.core.engine

import com.dokar.quickjs.QuickJs
import com.hexstacker.core.model.EngineJson
import com.hexstacker.core.model.FrameResult
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Typed Kotlin surface over the canonical HexStacker game engine running in
 * QuickJS. The Android analogue of `appletv/.../Engine/EngineBridge.swift`,
 * driving the SAME canonical server engine (bundled to `dist/partycore.js`)
 * through `PartyCore.frame(nowMs)`. Does NOT re-port game logic.
 *
 * Threading: the QuickJS C runtime is not thread-safe (though it has no thread
 * affinity), and quickjs-kt runs `evaluate` on the CALLER's thread — the
 * [dispatcher] passed to `QuickJs.create` only dispatches its async-function jobs,
 * which this shim never uses. Serialization is what matters, and the [Mutex] here
 * (plus quickjs-kt's own internal lock) guarantees two `evaluate` calls never
 * overlap on the one shared mutable `Game`. Route the frame loop and controller
 * input through the same coordinator coroutine so input accumulates between
 * frames exactly as the web does.
 *
 * One bridge lives for the whole app: `createGame()` re-inits a fresh game per
 * match (the JS `Bridge.create` reassigns `core`) without re-parsing the bundle.
 */
class EngineBridge private constructor(
    private val qjs: QuickJs,
    private val dispatcher: CoroutineDispatcher,
) {
    private val lock = Mutex()

    // Grid rows last received per player, keyed by id. The JS shim strips a
    // player's `grid` from the 60 Hz frame()/snapshot() payloads while its
    // `gridVersion` is unchanged (the grid dominates the serialized snapshot
    // at 8 players, and it only changes on a lock/clear/garbage insert);
    // [reattachGrids] substitutes these cached rows so consumers always see a
    // full snapshot. Guarded by [lock] like every engine call.
    private val gridCache = HashMap<Int, List<List<Int>>>()

    companion object {
        /**
         * Build a ready bridge: create QuickJS (with [dispatcher] as its async-job
         * dispatcher), evaluate the engine bundle (defines `globalThis.HexCore`) +
         * the Bridge shim, verify both exist.
         *
         * @param bundleJs full text of `dist/partycore.js` (asset on device, file in tests)
         * @param dispatcher a SERIAL dispatcher; defaults to a private limitedParallelism(1)
         */
        suspend fun create(
            bundleJs: String,
            dispatcher: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
        ): EngineBridge {
            // Build + bootstrap the QuickJS runtime off the Main thread (on [dispatcher]); all
            // later evaluate() calls hop here too (evalTyped/decode). The serial dispatcher + the
            // instance Mutex serialize every call, and the 90 KB bundle parse no longer hitches
            // the UI thread on the first match.
            return withContext(dispatcher) {
                val qjs = QuickJs.create(dispatcher)
                try {
                    qjs.evaluate<Any?>(bundleJs)                          // -> globalThis.HexCore
                    qjs.evaluate<Any?>(EngineBootstrap.SHIM + "\nvoid 0;") // -> globalThis.Bridge
                    if (qjs.evaluate<String>("typeof HexCore.PartyCore") != "function") {
                        throw EngineException.BridgeUnavailable
                    }
                    if (qjs.evaluate<String>("typeof Bridge") != "object") {
                        throw EngineException.BridgeUnavailable
                    }
                } catch (e: Throwable) {
                    qjs.close()
                    throw EngineException.wrap("bootstrap", e)
                }
                EngineBridge(qjs, dispatcher)
            }
        }
    }

    // --- game control --------------------------------------------------------

    /** Construct + init() a new game. [players] order fixes snapshot order. */
    suspend fun createGame(players: List<PlayerSpec>, seed: Long): Unit = lock.withLock {
        gridCache.clear() // fresh match: the shim's sent-grid ledger resets too
        val specs = players.joinToString(",", "[", "]") { "[${it.id},${it.startLevel}]" }
        eval("create", "Bridge.create($specs, $seed)")
    }

    /** Discrete input: left|right|rotate_cw|hard_drop|hold (hard_drop locks synchronously). */
    suspend fun processInput(playerId: Int, action: InputAction): Unit = lock.withLock {
        eval("processInput", "Bridge.processInput($playerId, '${action.wire}')")
    }

    /**
     * Apply a batch of inputs, in order, in ONE evaluate. Every call into QuickJS is
     * a source string this binding re-parses (~0.65ms floor on TV hardware, dwarfing
     * the input itself), so a full party's frame of input is worth collapsing: 8
     * separate calls measure 5.9ms against 1.1ms batched. Empty batch = no call.
     */
    suspend fun processInputs(batch: List<Pair<Int, InputAction>>) {
        if (batch.isEmpty()) return
        lock.withLock { eval("processInputs", "Bridge.processInputs(${inputsJs(batch)})") }
    }

    /**
     * Value-copy snapshot of ONE seat, with `players` holding just that player.
     * The render-on-input path: an input moves one board, and pulling all eight
     * costs ~9ms against ~2.7ms for one. Null when the id owns no board.
     */
    suspend fun snapshotPlayer(
        playerId: Int,
        inputs: List<Pair<Int, InputAction>> = emptyList(),
    ): GameSnapshot? = lock.withLock {
        val packed = evalTyped<String?>(
            "snapshotPlayerPacked",
            "Bridge.snapshotPlayerPacked($playerId, ${inputsJs(inputs)})",
        ) ?: return@withLock null
        reattachGrids(decodePacked("snapshotPlayerPacked", packed).snapshot!!)
    }

    suspend fun softDropStart(playerId: Int, speed: Int? = null): Unit = lock.withLock {
        val call = if (speed == null) "Bridge.softDropStart($playerId)"
        else "Bridge.softDropStart($playerId, $speed)"
        eval("softDropStart", call)
    }

    suspend fun softDropEnd(playerId: Int): Unit = lock.withLock {
        eval("softDropEnd", "Bridge.softDropEnd($playerId)")
    }

    suspend fun pause(): Unit = lock.withLock { eval("pause", "Bridge.pause()") }
    suspend fun resume(): Unit = lock.withLock { eval("resume", "Bridge.resume()") }

    /**
     * Cross-device claim: rekey the engine's per-player state (board, garbage queue,
     * cooldown) from [oldId] to [newId] so a returning controller's inputs hit the
     * reclaimed board. Returns true if a board moved; false also when [newId] already
     * owns a board (the engine's forged-claim guard). Calls `PartyCore.rekeyPlayer`.
     */
    suspend fun rekey(oldId: Int, newId: Int): Boolean = lock.withLock {
        val ok = evalTyped<Boolean>("rekey", "Bridge.rekeyPlayer($oldId, $newId)")
        // Follow the engine's board move in the grid cache (the shim drops both
        // ids from its sent-grid ledger, so the next pull re-sends a full grid).
        if (ok) gridCache.remove(oldId)?.let { gridCache[newId] = it }
        ok
    }

    /**
     * Forget the previous frame() timestamp; the next frame() re-primes with
     * deltaMs=0. MUST be called whenever leaving the active loop (pause, results).
     * Mirrors the web `prevFrameTime = 0` reset.
     */
    suspend fun resetFrameClock(): Unit = lock.withLock {
        eval("resetFrameClock", "Bridge.resetFrameClock()")
    }

    suspend fun isEnded(): Boolean = lock.withLock {
        evalTyped("isEnded", "Bridge.isEnded()")
    }

    // --- reads ---------------------------------------------------------------

    suspend fun snapshot(): GameSnapshot = lock.withLock {
        val packed = evalTyped<String>("snapshotPacked", "Bridge.snapshotPacked()")
        reattachGrids(decodePacked("snapshotPacked", packed).snapshot!!)
    }

    suspend fun drainEvents(): List<GameEvent> = lock.withLock {
        decode("drainEventsJSON", "Bridge.drainEventsJSON()")
    }

    /**
     * The blessed native integration surface. Caps nowMs->deltaMs, ticks the engine
     * (self-gating on paused/ended), returns this frame's events + value-copy snapshot
     * + normalized host commands.
     *
     * The snapshot is null when the frame is render-identical to the last one this
     * bridge delivered (the shim's scene signature) — skip the repaint and keep the
     * retained snapshot. [snapshot] is unaffected: it always returns a full copy.
     *
     * @param nowMs monotonic ms; only deltas matter, origin is free.
     */
    suspend fun frame(nowMs: Double, inputs: List<Pair<Int, InputAction>> = emptyList()): FrameResult =
        lock.withLock {
            // [inputs] ride along rather than going over in their own call: each call
            // is a source string QuickJS re-parses (~0.65ms floor on TV hardware), so
            // fusing them halves a tick's boundary crossings. They are applied before
            // the tick, exactly as a separate processInputs call would have been.
            val packed = evalTyped<String>(
                "framePacked",
                "Bridge.framePacked(${jsNum(nowMs)}, ${inputsJs(inputs)})",
            )
            val frame = decodePacked("framePacked", packed)
            frame.snapshot?.let { frame.copy(snapshot = reattachGrids(it)) } ?: frame
        }

    // --- Room core ----------------------------------------------------------
    //
    // The room's single source of truth (server/RoomCore.js, the same module the
    // web display and tvOS run): roster, auto-naming, colour slots, host election
    // and the retained snapshot controllers derive their whole UI from.
    // Everything crosses as JSON, and the surface is deliberately generic rather
    // than ~30 typed wrappers, because quickjs-kt has no call-with-arguments API:
    // every call is an interpolated source string, so one marshalling path per
    // direction is one place to get the escaping right (see [jsString]).
    //
    // Unlike the engine, the room core exists for the WHOLE session: created once at
    // coordinator start and surviving across matches, so [roomInit] must run
    // before any room event is handled.

    /**
     * Wrap a JS expression yielding JSON so that what crosses back is pure ASCII.
     *
     * quickjs-kt decodes an outbound JS string from UTF-8 and mishandles 4-byte
     * sequences — every astral character, i.e. every emoji: the tail bytes are dropped,
     * which both mangles a player's name and can truncate the JSON into something that
     * no longer parses. Re-encoding each non-ASCII code unit as a \uXXXX escape keeps
     * the JSON valid, decodes back to the exact same text on this side, and costs a
     * regex pass over ~1 KB. Only the ROOM reads need it: the engine's frame/snapshot
     * payloads are numeric.
     */
    private fun asciiJson(expr: String): String =
        "($expr).replace(/[\\u0080-\\uffff]/g, function (c) {" +
            " return '\\\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); })"

    suspend fun roomInit(optionsJson: String = "{}"): Unit = lock.withLock {
        eval("roomInit", "Bridge.roomInit(${jsString(optionsJson)})")
    }

    /**
     * Invoke a RoomCore method. [argsJson] is a JSON array of its arguments; the
     * JSON-encoded return value comes back (`"null"` for void methods).
     */
    suspend fun roomCallJson(method: String, argsJson: String = "[]"): String = lock.withLock {
        evalTyped<String>("roomCall($method)", asciiJson("Bridge.roomCall(${jsString(method)}, ${jsString(argsJson)})"))
    }

    /** Read a RoomCore property (`state`, `host`, `participants`, ...) as JSON. */
    suspend fun roomGetJson(property: String): String = lock.withLock {
        evalTyped<String>("roomGet($property)", asciiJson("Bridge.roomGet(${jsString(property)})"))
    }

    /** The retained room snapshot, ready to hand straight to `set_state`. */
    suspend fun roomSnapshotJson(): String = lock.withLock {
        evalTyped<String>("roomSnapshotJSON", asciiJson("Bridge.roomSnapshotJSON()"))
    }

    /**
     * Close the QuickJS runtime. `suspend` + [lock] so it can never overlap an
     * in-flight frame()/input call; hopping to [dispatcher] additionally keeps the
     * native teardown off the caller's (Main) thread.
     */
    suspend fun close() = lock.withLock { withContext(dispatcher) { qjs.close() } }

    // --- internals -----------------------------------------------------------

    /** Substitute cached rows for shim-stripped grids (see [gridCache]) and
     *  refresh the cache from the grids that did arrive. */
    private fun reattachGrids(snap: GameSnapshot): GameSnapshot {
        var stripped = false
        val players = snap.players.map { p ->
            if (p.grid.isEmpty()) {
                stripped = true
                val cached = gridCache[p.id]
                    ?: error("stripped grid for player ${p.id} with no cached rows")
                p.copy(grid = cached)
            } else {
                gridCache[p.id] = p.grid
                p
            }
        }
        return if (stripped) snap.copy(players = players) else snap
    }

    private suspend fun eval(label: String, code: String) {
        evalTyped<Any?>(label, code)
    }

    private suspend inline fun <reified T> evalTyped(label: String, code: String): T =
        try {
            withContext(dispatcher) { qjs.evaluate<T>(code) } // run QuickJS off the caller (Main) thread
        } catch (e: Throwable) {
            throw EngineException.wrap(label, e)
        }

    /**
     * Decode a packed frame. Deliberately NOT hopped to another dispatcher: it runs
     * on the engine dispatcher the caller is already on. The JSON decode this
     * replaced cost ~3ms and was worth moving off the caller's thread; the packed
     * decode is ~0.16ms at eight seats, which is less than the ~0.5-0.7ms a
     * dispatcher round trip costs on this hardware — the hop was more expensive
     * than the work it was protecting the caller from.
     */
    private fun decodePacked(label: String, packed: String): FrameResult =
        try {
            PackedFrame.decode(packed)
        } catch (e: Throwable) {
            throw EngineException.decode(label, e)
        }

    private suspend inline fun <reified T> decode(label: String, code: String): T {
        val json = try {
            withContext(dispatcher) { qjs.evaluate<String>(code) } // run QuickJS off the caller (Main) thread
        } catch (e: Throwable) {
            throw EngineException.wrap(label, e)
        }
        return try {
            // Parse OFF the coordinator's (Main) dispatcher: the per-frame snapshot JSON (up
            // to 8 boards) is pure to deserialize and touches no coordinator state, so moving
            // it to Default keeps the frame parse from competing with UI/input on the main thread.
            withContext(Dispatchers.Default) { EngineJson.json.decodeFromString<T>(json) }
        } catch (e: Throwable) {
            throw EngineException.decode(label, e)
        }
    }

    /** `[[id,'action'],…]`, or `null` for an empty batch so the shim can skip the
     *  loop entirely. Actions come from a fixed enum, so no escaping is needed. */
    private fun inputsJs(batch: List<Pair<Int, InputAction>>): String =
        if (batch.isEmpty()) "null"
        else batch.joinToString(",", "[", "]") { "[${it.first},'${it.second.wire}']" }

    data class PlayerSpec(val id: Int, val startLevel: Int = 1)
}

/**
 * Emit a JS-valid numeric literal. Kotlin `Double.toString()` is locale-invariant
 * (always `.`, never grouping; `E` notation which JS accepts), so it is safe; we
 * only guard non-finite so a glitch never injects `NaN`/`Infinity` into a script.
 */
internal fun jsNum(d: Double): String = if (d.isFinite()) d.toString() else "0"

/**
 * Emit a JS string literal (quotes included) for [s].
 *
 * quickjs-kt has no call-with-arguments API, so every call into JS is a source
 * string Kotlin interpolates. Until the room core landed, everything spliced in
 * was an Int or a fixed enum constant and [jsNum] was the only sanitizer needed.
 * Room payloads carry PLAYER NAMES, i.e. arbitrary user text, so splicing them
 * raw would break on a quote or a backslash and would let a crafted name inject
 * script into the engine context.
 *
 * Beyond the JSON escapes: U+2028/U+2029 are legal inside a JSON string but were
 * line terminators in JS source before ES2019, and DEL is escaped so a name can
 * never carry an invisible control character through into the literal.
 */
internal fun jsString(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (ch in s) {
        when {
            ch == '"' -> sb.append("\\\"")
            ch == '\\' -> sb.append("\\\\")
            ch == '\n' -> sb.append("\\n")
            ch == '\r' -> sb.append("\\r")
            ch == '\t' -> sb.append("\\t")
            ch < ' ' || ch == '\u007F' || ch == '\u2028' || ch == '\u2029' ->
                sb.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
            else -> sb.append(ch)
        }
    }
    sb.append('"')
    return sb.toString()
}
