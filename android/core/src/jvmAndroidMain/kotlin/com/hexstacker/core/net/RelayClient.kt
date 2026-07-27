package com.hexstacker.core.net

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

/**
 * The Party-Server WebSocket peer over OkHttp. Direct port of
 * `appletv/.../Net/RelayClient.swift`, emitting byte-compatible frames the live
 * relay (wss://ws.hexstacker.com) already speaks with the web + Apple TV peers.
 *
 * Threading: all mutable state is confined to a single serial executor [ops] (the
 * Swift serial DispatchQueue analogue), which also drives the timers. OkHttp
 * listener callbacks hop onto [ops]; consumer callbacks are delivered via
 * [callbackPoster] (inline for tests, main-thread on the app).
 */
class RelayClient(
    private val baseURL: String = RelayConfig.RELAY_URL,
    private val clientId: String = RelayConfig.DISPLAY_CLIENT_ID,
    private val maxClients: Int = RelayConfig.MAX_CLIENTS,
    private val callbackPoster: (block: () -> Unit) -> Unit = { it() },
    private val httpClient: OkHttpClient = defaultClient(),
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) : RelayTransport {

    override var onCreated: ((String, String?, String?) -> Unit)? = null
    override var onJoined: ((String, List<Int>) -> Unit)? = null
    override var onPeerJoined: ((Int) -> Unit)? = null
    override var onPeerLeft: ((Int) -> Unit)? = null
    override var onMessage: ((Int, JsonObject) -> Unit)? = null
    override var onRelayError: ((String) -> Unit)? = null
    override var onReplaced: (() -> Unit)? = null
    override var onConnectionState: ((RelayTransport.ConnectionState, Int) -> Unit)? = null

    private val ops = ScheduledThreadPoolExecutor(1).apply {
        removeOnCancelPolicy = true
        executeExistingDelayedTasksAfterShutdownPolicy = false
    }

    @Volatile private var webSocket: WebSocket? = null
    private var lastRoom: String? = null
    private var lastInstance: String? = null
    private var reconnectAttempt = 0
    private var shouldReconnect = true
    private var dropHandled = false
    private var reconnectFuture: ScheduledFuture<*>? = null
    private var heartbeatFuture: ScheduledFuture<*>? = null
    private var handshakeFuture: ScheduledFuture<*>? = null
    private var lastHeartbeatEcho = 0L

    // ----- public control (all hop onto ops) -----

    override fun connect() = ops.executeSafe {
        // Re-arm auto-reconnect on every explicit connect (mirrors PartyConnection.connect),
        // so reusing a client after disconnect() does not leave reconnect permanently off.
        shouldReconnect = true
        connectLocked()
    }

    override fun disconnect() = ops.executeSafe {
        shouldReconnect = false
        cancelReconnect()
        cancelHandshakeTimeout()
        stopHeartbeat()
        // Graceful close (not cancel): a frame queued just before — the exit
        // path's close_room — still flushes ahead of the close handshake.
        webSocket?.close(1000, null)
        webSocket = null
        emitState(RelayTransport.ConnectionState.CLOSED)
    }

    /**
     * Deliberate close while the app is backgrounded: tear down the socket and
     * timers with NO auto-reconnect, but keep the room pinned so a foreground
     * [reconnect] re-joins slot 0. Closing promptly hands the controllers an
     * immediate peer_left(0), so they react to the display's absence (reconnect
     * overlay, then their own bail) instead of sitting in a live-looking room
     * with nobody behind it. If the room is gone by the time we return, the
     * relay answers the join with "Room not found" and the coordinator recovers
     * via [createFresh]. Mirrors appletv RelayClient.suspend().
     */
    fun suspendSocket() = ops.executeSafe {
        cancelReconnect()
        cancelHandshakeTimeout()
        stopHeartbeat()
        dropHandled = true // suppress the drop handler for this deliberate cancel
        webSocket?.close(1000, null)
        webSocket = null
        emitState(RelayTransport.ConnectionState.CLOSED)
    }

    /**
     * Forget the pinned room WITHOUT touching the socket: the next (re)connect
     * handshake sends `create` instead of `join`. Used when the display suspends with
     * an EMPTY lobby — a memberless room dies with our socket at the relay anyway, so
     * resuming it would only bounce a join off "Room not found" before recreating,
     * visibly swapping the room code mid-lobby. Mirrors appletv RelayClient.unpinRoom.
     */
    fun unpinRoom() = ops.executeSafe {
        lastRoom = null
        lastInstance = null
    }

    override fun sendTo(index: Int, data: JsonObject) =
        ops.executeSafe { sendEnvelope(RelayJson.encodeToString(SendFrame(data = data, to = index))) }

    override fun broadcast(data: JsonObject) =
        ops.executeSafe { sendEnvelope(RelayJson.encodeToString(SendFrame(data = data))) }

    override fun setState(data: JsonObject) =
        ops.executeSafe { sendEnvelope(RelayJson.encodeToString(SetStateFrame(data = data))) }

    override fun closeRoom() =
        ops.executeSafe { sendEnvelope(RelayJson.encodeToString(CloseRoomFrame())) }

    /** Manual reconnect (user pressed RECONNECT after we gave up): clear the backoff
     *  and connect immediately. */
    fun reconnect() = ops.executeSafe {
        shouldReconnect = true
        reconnectAttempt = 0
        cancelReconnect()
        connectLocked()
    }

    /** Drop the dead room's identity and reconnect on the bare URL: [onSocketOpened]
     *  then sends `create` (a fresh room) instead of rejoining the lost one. */
    override fun createFresh() = ops.executeSafe {
        lastRoom = null
        lastInstance = null
        shouldReconnect = true
        reconnectAttempt = 0
        connectLocked()
    }

    /**
     * Stop and let the executor thread die. Call from onCleared/onDestroy. Also disposes
     * the (per-instance) OkHttp dispatcher/pool so a recreated Activity doesn't strand
     * idle threads and connections until their own timeouts.
     */
    fun shutdown() {
        disconnect()
        ops.executeSafe {
            ops.shutdown()
            httpClient.dispatcher.executorService.shutdown()
            httpClient.connectionPool.evictAll()
        }
    }

    // ----- connection lifecycle (run on ops) -----

    // `reconnecting` forces the RECONNECTING state even with the attempt counter
    // at 0 — the heartbeat path's immediate retry is unnumbered (web reconnectNow
    // parity), but must still pause the game and show the overlay.
    private fun connectLocked(reconnecting: Boolean = false) {
        cancelReconnect()
        cancelHandshakeTimeout()
        dropHandled = false
        emitState(if (reconnecting || reconnectAttempt > 0) RelayTransport.ConnectionState.RECONNECTING else RelayTransport.ConnectionState.CONNECTING)
        val old = webSocket
        val req = Request.Builder().url(currentURL()).build()
        val newWs = httpClient.newWebSocket(req, listener)
        webSocket = newWs
        old?.cancel()
    }

    private fun currentURL(): String {
        val room = lastRoom
        val inst = lastInstance
        return if (room != null && inst != null) {
            "$baseURL/${encodeURIComponent(room)}?instance=${encodeURIComponent(inst)}"
        } else {
            baseURL
        }
    }

    private fun onSocketOpened() {
        val room = lastRoom
        if (room != null) {
            sendEnvelope(RelayJson.encodeToString(JoinFrame(clientId = clientId, room = room)))
        } else {
            // The create registers the controller-URL template so clients holding
            // only the room code can resolve the controller page from the relay.
            sendEnvelope(
                RelayJson.encodeToString(
                    CreateFrame(
                        clientId = clientId,
                        maxClients = maxClients,
                        url = RelayConfig.controllerUrlTemplate,
                    ),
                ),
            )
        }
        startHandshakeTimeout()
        emitState(RelayTransport.ConnectionState.OPEN)
    }

    /** Arm the created/joined answer deadline; a silent relay is treated as a drop
     *  so the capped backoff (and eventually the gave-up overlay) applies. Mirrors
     *  appletv RelayClient.startHandshakeTimeout. */
    private fun startHandshakeTimeout() {
        cancelHandshakeTimeout()
        handshakeFuture = ops.schedule({
            val old = webSocket ?: return@schedule
            webSocket = null
            old.cancel()
            handleDrop(null)
        }, RelayConfig.HANDSHAKE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    private fun cancelHandshakeTimeout() {
        handshakeFuture?.cancel(false)
        handshakeFuture = null
    }

    private fun handleDrop(closeCode: Int?) {
        if (dropHandled) return
        dropHandled = true
        stopHeartbeat()
        cancelHandshakeTimeout()
        webSocket = null
        if (closeCode == RelayConfig.CLOSE_CODE_REPLACED) {
            shouldReconnect = false
            emitState(RelayTransport.ConnectionState.CLOSED)
            emit { onReplaced?.invoke() }
            return
        }
        // Room torn down by the relay: the room is gone, not just this socket.
        // Unpin it so the reconnect below opens a FRESH room (`create`) instead
        // of bouncing a join off "Room not found". Mirrors appletv RelayClient.
        if (closeCode == RelayConfig.CLOSE_CODE_ROOM_CLOSED) {
            lastRoom = null
            lastInstance = null
        }
        reconnectAttempt += 1
        if (shouldReconnect && reconnectAttempt <= RelayConfig.MAX_RECONNECT_ATTEMPTS) {
            val delay = min(
                RelayConfig.RECONNECT_BASE_MS * RelayConfig.RECONNECT_FACTOR.pow(reconnectAttempt - 1),
                RelayConfig.RECONNECT_CAP_MS.toDouble(),
            ).toLong()
            emitState(RelayTransport.ConnectionState.RECONNECTING)
            scheduleReconnect(delay)
        } else {
            emitState(RelayTransport.ConnectionState.CLOSED)
        }
    }

    private fun scheduleReconnect(delayMs: Long) {
        cancelReconnect()
        reconnectFuture = ops.schedule({ connectLocked() }, delayMs, TimeUnit.MILLISECONDS)
    }

    private fun cancelReconnect() {
        reconnectFuture?.cancel(false)
        reconnectFuture = null
    }

    private fun forceReconnect() {
        if (!shouldReconnect) return
        stopHeartbeat()
        dropHandled = true
        val old = webSocket
        webSocket = null
        old?.cancel()
        // This immediate retry is unnumbered (web reconnectNow parity): the overlay
        // shows heading-only until it fails, and that failure's handleDrop numbers the
        // next attempt. Force RECONNECTING even when the counter is still 0 —
        // CONNECTING would neither pause the game (DisplayCoordinator.onLinkState) nor
        // show the overlay, letting the sim run blind for the whole reconnect window.
        // The counter is NOT reset: web's reconnectNow() and appletv's forceReconnect()
        // both keep it, so a flapping link still exhausts its 5-attempt budget instead
        // of retrying forever.
        connectLocked(reconnecting = true)
    }

    // ----- heartbeat (self-echo liveness canary) -----

    private fun startHeartbeat() {
        stopHeartbeat()
        lastHeartbeatEcho = nowMs()
        heartbeatFuture = ops.scheduleWithFixedDelay(
            { heartbeatTick() },
            RelayConfig.HEARTBEAT_INTERVAL_MS,
            RelayConfig.HEARTBEAT_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun heartbeatTick() {
        val now = nowMs()
        if (now - lastHeartbeatEcho > RelayConfig.SELF_HEARTBEAT_DEAD_MS) {
            forceReconnect()
            return
        }
        val data = buildJsonObject { put("type", Msg.HEARTBEAT) }
        sendEnvelope(RelayJson.encodeToString(SendFrame(data = data, to = 0)))
    }

    private fun stopHeartbeat() {
        heartbeatFuture?.cancel(false)
        heartbeatFuture = null
    }

    // ----- inbound dispatch -----

    private fun handleFrame(text: String) {
        val root = runCatching { RelayJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        // The typed decodes below trust the relay's schema; a malformed field must drop
        // the frame, not throw out of the ops task (which would replace its worker thread).
        runCatching { dispatchFrame(root) }
    }

    private fun dispatchFrame(root: JsonObject) {
        when (root["type"]?.jsonPrimitive?.contentOrNull) {
            "message" -> {
                val f = RelayJson.decodeFromJsonElement<MessageFrame>(root)
                if (f.from == 0 && f.data["type"]?.jsonPrimitive?.contentOrNull == Msg.HEARTBEAT) {
                    lastHeartbeatEcho = nowMs()
                    return
                }
                emit { onMessage?.invoke(f.from, f.data) }
            }
            "created" -> {
                val f = RelayJson.decodeFromJsonElement<CreatedFrame>(root)
                lastRoom = f.room
                lastInstance = f.instance
                reconnectAttempt = 0
                cancelHandshakeTimeout()
                startHeartbeat()
                emit { onCreated?.invoke(f.room, f.instance, f.region) }
            }
            "joined" -> {
                val f = RelayJson.decodeFromJsonElement<JoinedFrame>(root)
                lastRoom = f.room.ifEmpty { lastRoom ?: "" }
                reconnectAttempt = 0
                cancelHandshakeTimeout()
                startHeartbeat()
                val room = lastRoom ?: ""
                emit { onJoined?.invoke(room, f.peers) }
            }
            "peer_joined" -> RelayJson.decodeFromJsonElement<PeerEventFrame>(root)
                .index.takeIf { it >= 0 }?.let { idx -> emit { onPeerJoined?.invoke(idx) } }
            "peer_left" -> RelayJson.decodeFromJsonElement<PeerEventFrame>(root)
                .index.takeIf { it >= 0 }?.let { idx -> emit { onPeerLeft?.invoke(idx) } }
            "error" -> {
                val f = RelayJson.decodeFromJsonElement<ErrorFrame>(root)
                emit { onRelayError?.invoke(f.message) }
            }
            else -> Unit // AirConsole-only / unknown — ignore
        }
    }

    private fun sendEnvelope(text: String) {
        webSocket?.send(text)
    }

    private fun emitState(s: RelayTransport.ConnectionState) {
        // Snapshot the attempt on the ops thread. The callback is posted to the main
        // thread and reconnectAttempt keeps mutating here (next drop increments it, a
        // successful reconnect resets it to 0), so reading it lazily on the main thread
        // could describe a different transition than the one being delivered.
        val attempt = reconnectAttempt
        emit { onConnectionState?.invoke(s, attempt) }
    }
    private fun emit(block: () -> Unit) = callbackPoster(block)

    private val listener = object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) = ops.executeSafe {
            if (ws === webSocket) onSocketOpened()
        }

        override fun onMessage(ws: WebSocket, text: String) = ops.executeSafe {
            if (ws === webSocket) handleFrame(text)
        }

        override fun onMessage(ws: WebSocket, bytes: ByteString) = ops.executeSafe {
            if (ws === webSocket) handleFrame(bytes.utf8())
        }

        override fun onClosing(ws: WebSocket, code: Int, reason: String) = ops.executeSafe {
            // Acknowledge the server-initiated close so OkHttp completes the handshake and
            // releases the connection promptly (otherwise it lingers until the TCP teardown).
            ws.close(1000, null)
            if (ws === webSocket) handleDrop(code)
        }

        override fun onClosed(ws: WebSocket, code: Int, reason: String) = ops.executeSafe {
            if (ws === webSocket) handleDrop(code)
        }

        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) = ops.executeSafe {
            if (ws === webSocket) handleDrop(null)
        }
    }

    companion object {
        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(0, TimeUnit.MILLISECONDS)
            .build()

        /** encodeURIComponent semantics (NOT java.net.URLEncoder, which form-encodes). */
        private val UNRESERVED: Set<Char> =
            (('A'..'Z') + ('a'..'z') + ('0'..'9') + listOf('-', '_', '.', '!', '~', '*', '\'', '(', ')')).toSet()

        internal fun encodeURIComponent(s: String): String = buildString {
            for (b in s.toByteArray(Charsets.UTF_8)) {
                val c = b.toInt() and 0xFF
                if (c.toChar() in UNRESERVED) {
                    append(c.toChar())
                } else {
                    append('%')
                    append("0123456789ABCDEF"[c shr 4])
                    append("0123456789ABCDEF"[c and 0x0F])
                }
            }
        }
    }
}

/** Swallow RejectedExecutionException so late hops after shutdown are no-ops. */
private inline fun ScheduledThreadPoolExecutor.executeSafe(crossinline block: () -> Unit) {
    try {
        execute { block() }
    } catch (e: RejectedExecutionException) {
        // executor shut down; ignore
    }
}
