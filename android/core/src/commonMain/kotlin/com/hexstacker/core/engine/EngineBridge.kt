package com.hexstacker.core.engine

import app.cash.zipline.QuickJs
import com.hexstacker.core.model.EngineJson
import com.hexstacker.core.model.FrameResult
import com.hexstacker.core.model.GameEvent
import com.hexstacker.core.model.GameSnapshot
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.ContinuationInterceptor

/**
 * Typed Kotlin surface over the canonical HexStacker game engine running in
 * QuickJS. The Android analogue of `appletv/.../Engine/EngineBridge.swift`,
 * driving the SAME canonical server engine (bundled to `dist/partycore.js`)
 * through `PartyCore.frame(nowMs)`. Does NOT re-port game logic.
 *
 * Threading: the QuickJS C runtime is not thread-safe, and it calibrates its
 * stack-overflow guard against the stack of the thread that CREATED it — entering it from
 * any other thread turns a catchable JS error into a SIGSEGV, measured on device
 * (PERF-INPUT-LATENCY.md §14.1). So the runtime is created on [dispatcher] and every call
 * hops there, and [dispatcher] MUST be serial. On Android it is the app's one game thread,
 * which the coordinator runs on too, so [onEngineThread] calls straight through. The
 * [Mutex] additionally guarantees two calls never overlap on the one shared mutable `Game`.
 * Route the frame loop and controller input through the same coordinator coroutine so input
 * accumulates between frames exactly as the web does.
 *
 * The binding is Zipline's `QuickJs` (Cash App), not quickjs-kt, and that is a measured
 * choice: quickjs-kt routes every `evaluate` through `evalInSession` — a session
 * allocation, `loadModules`, four suspending mutex acquisitions and ~5 JNI calls — to
 * support async/Promise semantics [EngineBootstrap.SHIM] never uses. On a Google TV
 * Streamer that floor is ~776us PER CALL against ~900us of actual engine work for an
 * eight-seat frame; Zipline's synchronous binding does the same call in ~78us. Same engine,
 * so every golden fixture keeps its meaning.
 *
 * Two traps come with it, both load-bearing:
 *
 *  - **The C locale.** QuickJS parses decimal LITERALS through a locale-dependent `strtod`,
 *    so under `LC_ALL=de_DE.UTF-8` the source text `1.5` evaluates to 1 and `0.5` to 0 —
 *    silently corrupting every decimal constant in the engine bundle (gravity, the garbage
 *    table, colour math, geometry). Android carries no POSIX locale environment and bionic
 *    supports only "C", so a device is safe in practice — but "in practice" is not a thing
 *    to run game math on, which is why [assertDecimalParsing] checks it at bootstrap and
 *    refuses to hand back a bridge otherwise. Gradle's Test tasks pin `LC_ALL=C` for the
 *    same reason.
 *  - **Two bindings cannot coexist.** Both quickjs-kt and Zipline install
 *    `jni/<abi>/libquickjs.so`, so an artifact carrying both keeps one and the loser's JNI
 *    symbols vanish (`UnsatisfiedLinkError` from a native method that plainly exists).
 *
 * One bridge lives for the whole app: `createGame()` re-inits a fresh game per
 * match (the JS `Bridge.create` reassigns `core`) without re-parsing the bundle.
 */
class EngineBridge private constructor(
    private val qjs: QuickJs,
    private val dispatcher: CoroutineDispatcher,
    /** Non-null when [create] built the dispatcher itself, and so must shut its thread
     *  down in [close]. Null when the caller supplied one (Android's game thread), whose
     *  lifetime is not ours to end. */
    private val ownedDispatcher: ExecutorCoroutineDispatcher?,
) {
    private val lock = Mutex()

    // Grid rows last received per player, keyed by id. The JS shim strips a
    // player's `grid` from the 60 Hz frame()/snapshot() payloads while its
    // `gridVersion` is unchanged (the grid dominates the serialized snapshot
    // at 8 players, and it only changes on a lock/clear/garbage insert);
    // [PackedFrame.decode] substitutes these cached rows AS IT READS, so consumers
    // always see a full snapshot and a stripped player costs no extra allocation.
    // Guarded by [lock] like every engine call.
    private val gridCache = HashMap<Int, List<List<Int>>>()

    companion object {
        /**
         * A GENUINELY single-threaded dispatcher, not `Dispatchers.Default.limitedParallelism(1)`.
         * The difference matters: limitedParallelism(1) is serial but may run successive tasks
         * on DIFFERENT pool threads, and QuickJS records a stack base when the runtime is
         * created and compares every later call against it — so a migrated thread trips the
         * guard as a spurious "stack overflow" out of compile(). Confining the runtime to one
         * thread keeps the guard meaningful instead of having to switch it off.
         *
         * Android passes its own game-thread dispatcher and never uses this; it is the default
         * for tests and any caller that does not care.
         */
        @OptIn(DelicateCoroutinesApi::class)
        private fun defaultEngineDispatcher(): ExecutorCoroutineDispatcher =
            newSingleThreadContext("hex-engine")

        // Zipline's evaluate/compile take a fileName, surfaced only in JS stack traces —
        // named so an engine throw says which of the three it came from.
        private const val BUNDLE_FILE = "partycore.js"
        private const val SHIM_FILE = "engine-bootstrap.js"
        private const val CALL_FILE = "engine-call.js"

        /**
         * Fail fast if this runtime cannot parse a decimal literal, i.e. if the process C
         * locale is not decimal-point. See the class comment: the alternative to throwing
         * here is a game whose every fractional constant is quietly truncated, which no
         * test in the field would catch. Cheap — one evaluate, once per runtime.
         */
        private fun assertDecimalParsing(qjs: QuickJs) {
            val half = qjs.evaluate("String(0.5)", CALL_FILE)
            if (half != "0.5") {
                throw EngineException.decode(
                    "localeCheck",
                    IllegalStateException(
                        "QuickJS parsed the literal 0.5 as \"$half\": the process C locale is not " +
                            "decimal-point (LC_ALL/LC_NUMERIC), so every decimal constant in the " +
                            "engine bundle would truncate. Refusing to run.",
                    ),
                )
            }
        }

        /**
         * Build a ready bridge: create the QuickJS runtime, evaluate the engine bundle
         * (defines `globalThis.HexCore`) + the Bridge shim, verify both exist.
         *
         * @param bundleJs full text of `dist/partycore.js` (asset on device, file in tests)
         * @param dispatcher the SINGLE thread the runtime is confined to. Null builds one
         *   ([defaultEngineDispatcher]) which [close] then shuts down; Android passes its
         *   game thread, whose lifetime is not ours to end.
         */
        suspend fun create(
            bundleJs: String,
            dispatcher: CoroutineDispatcher? = null,
        ): EngineBridge {
            // Own the thread only when we made it, so close() can end it.
            val owned = if (dispatcher == null) defaultEngineDispatcher() else null
            @Suppress("NAME_SHADOWING") val dispatcher = dispatcher ?: owned!!
            // Build + bootstrap the QuickJS runtime off the Main thread (on [dispatcher]); all
            // later evaluate() calls hop here too (evalTyped/decode). The serial dispatcher + the
            // instance Mutex serialize every call, and the 90 KB bundle parse no longer hitches
            // the UI thread on the first match.
            return withContext(dispatcher) {
                val qjs = QuickJs.create()
                try {
                    assertDecimalParsing(qjs) // BEFORE the bundle: a bad locale mis-parses it
                    qjs.evaluate(bundleJs, BUNDLE_FILE)                        // -> globalThis.HexCore
                    qjs.evaluate(EngineBootstrap.SHIM + "\nvoid 0;", SHIM_FILE) // -> globalThis.Bridge
                    if (qjs.evaluate("typeof HexCore.PartyCore", CALL_FILE) != "function") {
                        throw EngineException.BridgeUnavailable
                    }
                    if (qjs.evaluate("typeof Bridge", CALL_FILE) != "object") {
                        throw EngineException.BridgeUnavailable
                    }
                } catch (e: Throwable) {
                    qjs.close()
                    throw EngineException.wrap("bootstrap", e)
                }
                EngineBridge(qjs, dispatcher, owned)
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
        decodePacked("snapshotPlayerPacked", packed).snapshot!!
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
        decodePacked("snapshotPacked", packed).snapshot!!
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
            decodePacked("framePacked", packed)
        }

    // --- Room core ----------------------------------------------------------
    //
    // The room's single source of truth (server/RoomCore.js, the same module the
    // web display and tvOS run): roster, auto-naming, colour slots, host election
    // and the retained snapshot controllers derive their whole UI from.
    // Everything crosses as JSON, and the surface is deliberately generic rather
    // than ~30 typed wrappers, because the binding has no call-with-arguments API:
    // every call is an interpolated source string, so one marshalling path per
    // direction is one place to get the escaping right (see [jsString]).
    //
    // Unlike the engine, the room core exists for the WHOLE session: created once at
    // coordinator start and surviving across matches, so [roomInit] must run
    // before any room event is handled.

    /**
     * Wrap a JS expression yielding JSON so that what crosses back is pure ASCII.
     *
     * The binding decodes an outbound JS string from UTF-8 and was found to mishandle
     * 4-byte sequences — every astral character, i.e. every emoji: the tail bytes are dropped,
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
    suspend fun close() {
        lock.withLock { withContext(dispatcher) { qjs.close() } }
        // After the runtime is gone, or the close above would have nowhere to run.
        ownedDispatcher?.close()
    }

    // --- internals -----------------------------------------------------------

    private suspend fun eval(label: String, code: String) {
        evalTyped<Any?>(label, code)
    }

    private suspend inline fun <reified T> evalTyped(label: String, code: String): T {
        val raw = try {
            onEngineThread { qjs.evaluate(code, CALL_FILE) }
        } catch (e: Throwable) {
            throw EngineException.wrap(label, e)
        }
        return castResult(label, raw)
    }

    /**
     * Run [block] on [dispatcher], calling it DIRECTLY when the caller is already there.
     *
     * The runtime is thread-confined (see the class comment), so the hop cannot simply be
     * dropped — a caller on another thread must still be moved. But on Android every engine
     * call already originates on the game thread, and `withContext` to the dispatcher you
     * are already on is not free even though it does not dispatch: it still builds an
     * undispatched coroutine and does the thread-context bookkeeping. Comparing the
     * interceptor is a reference check, and skips all of it.
     *
     * Measured at four seats: `snapshotPlayer` 1.53ms -> 1.16ms.
     */
    private suspend inline fun <T> onEngineThread(crossinline block: () -> T): T =
        if (currentCoroutineContext()[ContinuationInterceptor] === dispatcher) {
            block()
        } else {
            withContext(dispatcher) { block() }
        }

    /**
     * Zipline's `evaluate` returns `Any?` (a JS string arrives as a String, `undefined` and
     * `null` both as null), so the typed surface above casts here rather than at thirty call
     * sites. A wrong cast is a bug in this file, not in the engine, so it is reported as an
     * [EngineException] naming the call.
     */
    private inline fun <reified T> castResult(label: String, value: Any?): T {
        // `value is T` with a reified NULLABLE T already matches null, so `evalTyped<String?>`
        // of a JS null lands here and returns it. There is deliberately no null special-case
        // below: for a non-nullable T a null result is a real mismatch, and returning it as
        // `null as T` would defer the failure to an NPE somewhere with no context.
        if (value is T) return value
        throw EngineException.decode(
            label,
            IllegalStateException("unexpected result: ${value ?: "null"} (${value?.let { it::class.simpleName }})"),
        )
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
            PackedFrame.decode(packed, gridCache)
        } catch (e: Throwable) {
            throw EngineException.decode(label, e)
        }

    private suspend inline fun <reified T> decode(label: String, code: String): T {
        val json = try {
            onEngineThread { castResult<String>(label, qjs.evaluate(code, CALL_FILE)) }
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
 * The binding has no call-with-arguments API, so every call into JS is a source
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
