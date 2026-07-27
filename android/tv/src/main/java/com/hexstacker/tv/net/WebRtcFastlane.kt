package com.hexstacker.tv.net

import android.content.Context
import android.util.Log
import com.hexstacker.core.net.Fastlane
import com.hexstacker.core.net.FastlaneReceiver
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Android ([org.webrtc]) implementation of the display side of the WebRTC fast-lane
 * (port of the receiving half of `partyplug/PartyFastlane.js`). The display is the
 * ANSWERER: controllers create the DataChannel + offer, we auto-accept, decode inputs
 * (via the pure [FastlaneReceiver]), and ack. We never initiate or send data packets.
 *
 * Threading: all peer state + signaling runs on one serial [exec] (like RelayClient's
 * executor), so the peer map / receiver / watchdog are single-threaded. WebRTC observer
 * callbacks re-post onto it; DataChannel `onMessage` copies the buffer synchronously
 * (it is reused after return) then hands the text to [exec].
 *
 * The channel is `{ ordered:false, maxRetransmits:0 }` (set by the controller); app-layer
 * dedup + rolling-window resend replace SCTP retransmits. [WATCHDOG_MS] of inbound silence
 * tears the peer down so the controller falls back to the relay.
 */
class WebRtcFastlane(context: Context, private val iceUrls: List<String>) : Fastlane {

    override var onInput: ((from: Int, data: JsonObject) -> Unit)? = null
    override var sendSignal: ((to: Int, data: JsonObject) -> Unit)? = null

    private val appContext = context.applicationContext
    private val exec = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "fastlane") }
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }
    private val peers = HashMap<Int, Peer>()
    private var factory: PeerConnectionFactory? = null

    private inner class Peer(val pc: PeerConnection) {
        var channel: DataChannel? = null
        // Replaced whenever a new DataChannel is adopted — see onDataChannel.
        var receiver = FastlaneReceiver()
        val pending = ArrayList<IceCandidate>()
        var remoteSet = false
        var watchdog: ScheduledFuture<*>? = null
        var inputCount = 0 // for a one-time "first input over P2P" log
    }

    init {
        // Factory init loads the libwebrtc native library (~100-300ms on TV-class CPUs),
        // so it runs on the serial executor instead of the constructing (main) thread —
        // constructing this in Activity.onCreate must not delay the first frame. No
        // ordering race: every use of `factory` (signals, dispose) is post()ed onto the
        // same serial executor, and this task is queued first.
        post {
            ensureFactoryInit(appContext)
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
            Log.i(TAG, "factory ready, iceServers=$iceUrls")
        }
    }

    // ── Fastlane API (all posted onto the serial executor) ────────────────────

    override fun handleSignal(from: Int, data: JsonObject) = post { onSignal(from, data) }
    override fun close(peerIndex: Int) = post { teardown(peerIndex) }
    override fun closeAll() = post { peers.keys.toList().forEach { teardown(it) } }

    /** Release the factory + all peers (Activity onDestroy). */
    fun dispose() {
        post {
            peers.keys.toList().forEach { teardown(it) }
            factory?.dispose(); factory = null
        }
        exec.shutdown()
    }

    /**
     * Post to the serial executor, swallowing RejectedExecutionException so a late WebRTC
     * native-thread callback that fires after [dispose] shut the executor down is a no-op
     * (mirrors RelayClient.executeSafe) instead of crashing the process during teardown.
     */
    private fun post(block: () -> Unit) {
        try {
            exec.execute(block)
        } catch (e: RejectedExecutionException) {
            // executor already shut down during teardown; drop the late callback.
        }
    }

    // ── Signaling (answerer) ──────────────────────────────────────────────────

    private fun onSignal(from: Int, data: JsonObject) {
        val kind = (data[Fastlane.RTC_KEY] as? JsonPrimitive)?.contentOrNull ?: return
        val peer = ensurePeer(from) ?: run { Log.w(TAG, "peer $from: no factory, dropping $kind"); return }
        when (kind) {
            "offer" -> {
                Log.i(TAG, "peer $from: offer received")
                val sdp = (data["sdp"] as? JsonObject)?.get("sdp")?.let { (it as? JsonPrimitive)?.contentOrNull } ?: return
                peer.pc.setRemoteDescription(
                    setObserver {
                        peer.remoteSet = true
                        peer.pending.forEach { runCatching { peer.pc.addIceCandidate(it) } }
                        if (peer.pending.isNotEmpty()) Log.i(TAG, "peer $from: flushed ${peer.pending.size} buffered ICE")
                        peer.pending.clear()
                        createAnswer(from, peer)
                    },
                    SessionDescription(SessionDescription.Type.OFFER, sdp),
                )
            }
            "ice" -> {
                val c = data["candidate"] as? JsonObject ?: return
                val cand = IceCandidate(
                    (c["sdpMid"] as? JsonPrimitive)?.contentOrNull,
                    (c["sdpMLineIndex"] as? JsonPrimitive)?.intOrNull ?: 0,
                    (c["candidate"] as? JsonPrimitive)?.contentOrNull ?: return,
                )
                Log.i(TAG, "peer $from: remote ICE ${summarizeCand(cand.sdp)} (buffered=${!peer.remoteSet})")
                if (peer.remoteSet) runCatching { peer.pc.addIceCandidate(cand) } else peer.pending.add(cand)
            }
            // The display never offers, so it should never receive an answer.
        }
    }

    private fun createAnswer(from: Int, peer: Peer) {
        peer.pc.createAnswer(
            object : SdpAdapter() {
                override fun onCreateSuccess(desc: SessionDescription) {
                    peer.pc.setLocalDescription(
                        setObserver {
                            Log.i(TAG, "peer $from: answer sent")
                            sendSignal?.invoke(
                                from,
                                buildJsonObject {
                                    put(Fastlane.RTC_KEY, "answer")
                                    putJsonObject("sdp") { put("type", "answer"); put("sdp", desc.description) }
                                },
                            )
                        },
                        desc,
                    )
                }
            },
            MediaConstraints(),
        )
    }

    // ── Peer + channel ────────────────────────────────────────────────────────

    private fun ensurePeer(from: Int): Peer? {
        peers[from]?.let { return it }
        val f = factory ?: return null
        val cfg = PeerConnection.RTCConfiguration(
            iceUrls.map { PeerConnection.IceServer.builder(it).createIceServer() },
        ).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }

        val pc = f.createPeerConnection(cfg, ObserverAdapter(from)) ?: return null
        val peer = Peer(pc)
        peers[from] = peer
        return peer
    }

    private fun onChannelMessage(from: Int, text: String) {
        val peer = peers[from] ?: return
        resetWatchdog(from, peer)
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        if (!FastlaneReceiver.isDataPacket(obj)) return // display only receives data packets
        val res = peer.receiver.onDataPacket(obj)
        if (res.events.isNotEmpty() && peer.inputCount == 0) Log.i(TAG, "peer $from: first input over P2P")
        peer.inputCount += res.events.size
        res.events.forEach { onInput?.invoke(from, it) }
        res.ack?.let { sendRaw(peer, it) }
    }

    private fun sendRaw(peer: Peer, obj: JsonObject) {
        val dc = peer.channel ?: return
        runCatching { dc.send(DataChannel.Buffer(ByteBuffer.wrap(obj.toString().encodeToByteArray()), false)) }
    }

    private fun resetWatchdog(from: Int, peer: Peer) {
        peer.watchdog?.cancel(false)
        peer.watchdog = exec.schedule(
            { Log.w(TAG, "peer $from: watchdog fired (no inbound ${WATCHDOG_MS}ms)"); teardown(from) },
            WATCHDOG_MS,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun teardown(from: Int) {
        val peer = peers.remove(from) ?: return
        Log.i(TAG, "peer $from: teardown (had channel=${peer.channel != null}, inputs=${peer.inputCount})")
        peer.watchdog?.cancel(false)
        // dispose() only releases the DataChannel ref — it does NOT free the observer
        // registered in onDataChannel, so skipping this leaks the native observer plus
        // the Kotlin object graph it pins (the anonymous Observer captures this fastlane)
        // on every controller reconnect.
        runCatching { peer.channel?.unregisterObserver() }
        runCatching { peer.channel?.dispose() }
        runCatching { peer.pc.dispose() }
    }

    // ── Observers ─────────────────────────────────────────────────────────────

    /** SdpObserver that runs [onSet] (on the serial exec) when set succeeds; no-ops otherwise. */
    private fun setObserver(onSet: () -> Unit): SdpObserver = object : SdpAdapter() {
        override fun onSetSuccess() { post(onSet) }
    }

    private inner class ObserverAdapter(private val from: Int) : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            Log.i(TAG, "peer $from: local ICE ${summarizeCand(candidate.sdp)}")
            post {
                sendSignal?.invoke(
                    from,
                    buildJsonObject {
                        put(Fastlane.RTC_KEY, "ice")
                        putJsonObject("candidate") {
                            put("candidate", candidate.sdp)
                            put("sdpMid", candidate.sdpMid)
                            put("sdpMLineIndex", candidate.sdpMLineIndex)
                        }
                    },
                )
            }
        }

        override fun onDataChannel(dc: DataChannel) {
            Log.i(TAG, "peer $from: data channel received (label=${dc.label()})")
            // Register the message observer SYNCHRONOUSLY (no dropped early packets); only the
            // per-message handling and state mutation hop onto the serial executor.
            dc.registerObserver(object : DataChannel.Observer {
                override fun onMessage(buffer: DataChannel.Buffer) {
                    val bytes = ByteArray(buffer.data.remaining())
                    buffer.data.get(bytes) // must copy here — the buffer is reused after return
                    val text = bytes.decodeToString()
                    post { onChannelMessage(from, text) }
                }

                // A closed channel tears the peer down, so a controller that re-offers
                // gets a FRESH peer (and a fresh receiver) instead of racing the 3 s
                // watchdog. Web does this via `channel.onclose -> _teardownPeer`;
                // appletv via onChannelState(.closed). Read the state here (valid on
                // the WebRTC thread), act on the serial executor.
                override fun onStateChange() {
                    val state = runCatching { dc.state() }.getOrNull()
                    if (state != DataChannel.State.CLOSED) return
                    post {
                        val peer = peers[from] ?: return@post
                        // Ignore an orphan channel that was already replaced.
                        if (peer.channel != null && peer.channel !== dc) return@post
                        Log.i(TAG, "peer $from: data channel closed")
                        teardown(from)
                    }
                }

                override fun onBufferedAmountChange(previousAmount: Long) {}
            })
            post {
                peers[from]?.let {
                    it.channel = dc
                    // Fresh channel means a fresh sender: the controller's event seq
                    // restarts at 1, so a carried-over lastAppliedEs would dedupe every
                    // new input away AND ack it as applied, silently killing P2P input
                    // for the rest of the session. Mirrors appletv's peerChannelOpened,
                    // which rebuilds the whole per-peer netcode state.
                    it.receiver = FastlaneReceiver()
                    it.inputCount = 0
                    resetWatchdog(from, it)
                }
            }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            Log.i(TAG, "peer $from: connectionState=$newState")
            if (newState == PeerConnection.PeerConnectionState.FAILED ||
                newState == PeerConnection.PeerConnectionState.CLOSED
            ) {
                post { teardown(from) }
            }
        }

        // ICE state is the key P2P-reachability signal: CONNECTED = a candidate pair
        // works (P2P up); FAILED = no pair worked (e.g. STUN-only through a symmetric
        // NAT, or an emulator's SLIRP network) — the controller then falls back to relay.
        override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
            Log.i(TAG, "peer $from: iceConnectionState=$newState")
        }

        override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {
            Log.i(TAG, "peer $from: iceGatheringState=$newState")
        }

        // Unused observer surface (data-only, answerer).
        override fun onSignalingChange(newState: PeerConnection.SignalingState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
    }

    private abstract class SdpAdapter : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        // A failed create/set means this peer never gets a data channel and silently
        // stays on the relay fallback — log it so a no-P2P device leaves a trail
        // (PartyFastlane.js warns on the same failures).
        override fun onCreateFailure(error: String?) { Log.w(TAG, "sdp create failed: $error") }
        override fun onSetFailure(error: String?) { Log.w(TAG, "sdp set failed: $error") }
    }

    companion object {
        private const val TAG = "Fastlane"

        /** Condense an ICE candidate line to "type addr:port [mdns]" for logging. */
        private fun summarizeCand(sdp: String): String {
            val p = sdp.substringAfter("candidate:", sdp).split(" ")
            val typ = p.getOrNull(6)?.let { if (it == "typ") p.getOrNull(7) else null } ?: "?"
            val addr = p.getOrNull(4) ?: "?"
            val port = p.getOrNull(5) ?: "?"
            return "$typ $addr:$port" + if (addr.endsWith(".local")) " [mdns]" else ""
        }

        // Mirror PartyFastlane WATCHDOG_MS: inbound silence before tearing the peer down.
        private const val WATCHDOG_MS = 3000L

        @Volatile private var factoryInitialized = false

        /** PeerConnectionFactory.initialize must run once per process. */
        @Synchronized
        private fun ensureFactoryInit(context: Context) {
            if (factoryInitialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .createInitializationOptions(),
            )
            factoryInitialized = true
        }
    }
}
