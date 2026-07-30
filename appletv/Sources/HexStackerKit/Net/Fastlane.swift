import Foundation

// Swift port of the receiver half of partyplug/PartyFastlane.js.
//
// The fastlane is a peer-to-peer WebRTC DataChannel that piggybacks controller
// input on top of the relay (which carries SDP/ICE signaling and is the always-
// available fallback). On the web it is bidirectional, but the tvOS display only
// ever plays the RECEIVER role: controllers push input over the channel; the
// display dedupes it and replies with cumulative acks. Every display -> controller
// message (welcome, lobby, countdown, player_state, ...) still rides the relay, so
// the display never enqueues a data packet of its own. The controller-only sender
// machinery (rolling send window, resend ticks, idle heartbeats, RTT-from-acks) is
// therefore intentionally absent — see PartyFastlane.js if a native controller is
// ever built.
//
// This file is the platform-agnostic netcode: the wire codec, per-peer dedup, ack
// emission, stats, and the silence watchdog. It has no WebRTC dependency, so it
// builds and is verified under Command Line Tools by FastlaneTests (`swift test`). The
// WebRTC transport (RTCPeerConnection, perfect negotiation, ICE, the DataChannel
// itself) lives in the app target and drives this core through `FastlaneNetcode`.
//
// Wire format (over the DataChannel), mirroring PartyFastlane.js exactly:
//
//   data:       { ps, t, h: [ ev, ... ] }   // controller -> display
//   heartbeat:  { ps, t, h: [] }            // controller -> display (idle)
//   ack:        { pa, t }                   // display -> controller
//
//   ps  — sender's newest event seq carried by this packet.
//   t   — sender's clock at send time (echoed back in the ack for its RTT calc).
//   h   — event payloads, newest first; per-entry seq is implicit: es[i] = ps - i.
//   pa  — receiver's highest event seq applied so far (cumulative).

/// The fastlane surface the display coordinator drives. The concrete WebRTC-backed
/// implementation lives in the app target; tests and headless builds inject nil.
public protocol InputFastlane: AnyObject {
    /// Routes one inbound relay message. Returns true iff it was an `__rtc`
    /// signaling envelope and was consumed (so app dispatch should skip it).
    func handleSignal(from: Int, data: [String: Any]) -> Bool
    /// Tear down the peer-to-peer channel to one controller (it left / was evicted).
    func closePeer(_ index: Int)
    /// Tear down every channel (app teardown / backgrounding).
    func closeAll()
    /// Delivered for each decoded controller event, on the same callback queue as
    /// relay messages, so the coordinator can route it through one input path.
    var onInput: ((_ from: Int, _ data: [String: Any]) -> Void)? { get set }
}

/// Tunables, mirroring PartyFastlane.js. Only the watchdog is live on the receiver.
public enum FastlaneConfig {
    /// Inbound silence (no packet, not even a heartbeat) before the peer is
    /// declared dead and torn down. 6× the controller's 500 ms idle-heartbeat
    /// cadence, so a few dropped heartbeats don't trigger a teardown.
    public static let watchdogMs: Double = 3000

    /// Upper bound on events applied from a single data packet. The web sender's
    /// resend ring is time-bounded (TTL), so a real `h` window is a handful of
    /// events and never approaches this; the cap stops a crafted/buggy DataChannel
    /// packet from fanning out into an unbounded burst of engine input calls.
    public static let maxEventsPerPacket = 256

    /// The relay envelope key that marks a WebRTC signaling message.
    public static let signalKey = "__rtc"

    /// True iff `data` is an `__rtc` signaling envelope (offer / answer / ice).
    public static func isSignalEnvelope(_ data: Any?) -> Bool {
        guard let dict = data as? [String: Any] else { return false }
        return dict[signalKey] != nil
    }
}

// MARK: - Scheduler abstraction (keeps the watchdog testable + the core pure)

/// A cancelable scheduled callback. The real implementation is a dispatch timer;
/// tests inject a manual scheduler so the watchdog fires deterministically.
public protocol FastlaneTimerToken: AnyObject {
    func cancel()
}

public protocol FastlaneScheduler: AnyObject {
    func schedule(afterMs: Double, _ work: @escaping () -> Void) -> FastlaneTimerToken
}

/// Production scheduler: a one-shot `DispatchSourceTimer` on the given queue.
public final class DispatchFastlaneScheduler: FastlaneScheduler {
    private let queue: DispatchQueue
    public init(queue: DispatchQueue = .main) { self.queue = queue }

    public func schedule(afterMs: Double, _ work: @escaping () -> Void) -> FastlaneTimerToken {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(Int(afterMs.rounded())))
        timer.setEventHandler(handler: work)
        timer.resume()
        return Token(timer)
    }

    private final class Token: FastlaneTimerToken {
        private var timer: DispatchSourceTimer?
        init(_ t: DispatchSourceTimer) { timer = t }
        func cancel() { timer?.cancel(); timer = nil }
    }
}

// MARK: - Receiver netcode

/// Read-only per-peer state, exposed for diagnostics and the headless verifier.
public struct FastlanePeerState {
    public let open: Bool
    public let lastAppliedEs: Int
    public let out: Int
    public let received: Int
    public let lastPsSeen: Int
}

/// The platform-agnostic receiver netcode. The WebRTC transport feeds it channel
/// lifecycle + raw bytes; it dedupes events, surfaces them via `onInput`, emits
/// acks via `send`, and tears a silent peer down via the watchdog. Single-threaded:
/// every method must be called on `callbackQueue` (the app marshals WebRTC's
/// callback threads onto it before calling in).
public final class FastlaneNetcode {

    private final class Peer {
        var open = true
        var lastAppliedEs = 0       // highest event seq applied from this peer
        var watchdog: FastlaneTimerToken?
    }

    private struct Stats {
        var out = 0                 // packets sent to this peer (acks)
        var received = 0            // packets received from this peer
        var lastPsSeen = 0          // highest inbound ps (= peer's max event seq)
    }

    // Transport hooks, wired by the WebRTC adapter.
    /// Write one encoded packet's bytes to the peer's DataChannel.
    public var send: ((_ peerIdx: Int, _ data: Data) -> Void)?
    /// Close the underlying RTCPeerConnection + channel for a peer (watchdog /
    /// explicit close). The resulting channel-closed callback is idempotent here.
    public var closeTransport: ((_ peerIdx: Int) -> Void)?

    // Consumer callbacks.
    public var onInput: ((_ peerIdx: Int, _ event: [String: Any]) -> Void)?
    public var onPeerReady: ((_ peerIdx: Int) -> Void)?
    public var onPeerClosed: ((_ peerIdx: Int) -> Void)?

    private var peers: [Int: Peer] = [:]
    // Stats outlive teardown so they aggregate across reconnects (lifetime totals).
    private var stats: [Int: Stats] = [:]

    private let now: () -> Double
    private let scheduler: FastlaneScheduler

    public init(now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
                scheduler: FastlaneScheduler = DispatchFastlaneScheduler()) {
        self.now = now
        self.scheduler = scheduler
    }

    // MARK: Channel lifecycle (called by the WebRTC adapter)

    /// The DataChannel to `peerIdx` opened. Resets per-session netcode state and
    /// arms the silence watchdog.
    public func peerChannelOpened(_ peerIdx: Int) {
        // Disarm a replaced session's still-pending watchdog: teardownPeer keys
        // by index, so the stale timer would otherwise fire (up to watchdogMs
        // later) and tear down this fresh, healthy channel.
        peers[peerIdx]?.watchdog?.cancel()
        let peer = Peer()
        peers[peerIdx] = peer
        onPeerReady?(peerIdx)
        resetWatchdog(peerIdx, peer)
    }

    /// One inbound DataChannel message (raw JSON bytes).
    public func peerReceived(_ peerIdx: Int, _ data: Data) {
        guard let peer = peers[peerIdx],
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        // Any well-formed packet refreshes the watchdog and the counters.
        resetWatchdog(peerIdx, peer)
        var s = statsFor(peerIdx)
        s.received += 1
        if let ps = Self.number(obj["ps"]).flatMap(Self.seqInt), ps > s.lastPsSeen { s.lastPsSeen = ps }
        stats[peerIdx] = s

        // The controller only ever sends data packets (`h` present); heartbeats are
        // data packets with `h: []`. Acks (`pa`) are a sender-side concern the
        // display never receives, so anything without `h` is ignored.
        if obj["h"] != nil { handleDataPacket(peerIdx, peer, obj) }
    }

    /// The DataChannel to `peerIdx` closed (remote close, ICE failure, or our own
    /// teardown). Idempotent.
    public func peerChannelClosed(_ peerIdx: Int) {
        teardownPeer(peerIdx, closeTransport: false)
    }

    // MARK: InputFastlane-style controls (called by the coordinator)

    public func closePeer(_ peerIdx: Int) {
        teardownPeer(peerIdx, closeTransport: true)
    }

    public func closeAll() {
        for idx in Array(peers.keys) { teardownPeer(idx, closeTransport: true) }
    }

    public func isOpen(_ peerIdx: Int) -> Bool { peers[peerIdx]?.open ?? false }

    // MARK: Receive path

    private func handleDataPacket(_ peerIdx: Int, _ peer: Peer, _ packet: [String: Any]) {
        // Drop malformed packets (no numeric / out-of-range ps) without acking —
        // mirrors the web, which also won't echo an ack for a packet it can't decode.
        guard let psD = Self.number(packet["ps"]), let ps = Self.seqInt(psD) else { return }
        let hAll = packet["h"] as? [[String: Any]] ?? []
        // Cap fan-out: `h` is newest-first, so keep the newest `maxEventsPerPacket`
        // (the ones most likely past lastAppliedEs). A real window never exceeds
        // this; still ack below so a legitimate sender never stalls.
        let h = hAll.count > FastlaneConfig.maxEventsPerPacket
            ? Array(hAll.prefix(FastlaneConfig.maxEventsPerPacket)) : hAll
        // Events arrive newest-first; apply oldest-first so onInput sees source
        // order. Per-entry seq is implicit: es[i] = ps - i. Dedup on lastAppliedEs
        // makes resends and out-of-order duplicates no-ops.
        var i = h.count - 1
        while i >= 0 {
            let es = ps - i
            if es > peer.lastAppliedEs {
                peer.lastAppliedEs = es
                onInput?(peerIdx, h[i])
            }
            i -= 1
        }
        // Always ack — even duplicates and heartbeats — so a lost ack gets another
        // chance to clear the controller's send ring. `t` is echoed for its RTT.
        sendAck(peerIdx, peer, t: packet["t"])
    }

    private func sendAck(_ peerIdx: Int, _ peer: Peer, t: Any?) {
        var ack: [String: Any] = ["pa": peer.lastAppliedEs]
        if let tD = Self.number(t) { ack["t"] = tD }
        writeRaw(peerIdx, ack)
    }

    private func writeRaw(_ peerIdx: Int, _ packet: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: packet) else { return }
        send?(peerIdx, data)
        var s = statsFor(peerIdx); s.out += 1; stats[peerIdx] = s
    }

    // MARK: Watchdog

    private func resetWatchdog(_ peerIdx: Int, _ peer: Peer) {
        peer.watchdog?.cancel()
        peer.watchdog = scheduler.schedule(afterMs: FastlaneConfig.watchdogMs) { [weak self] in
            // No inbound for watchdogMs — the channel is silently broken. Tear the
            // peer down so the coordinator/UI can fall back to the relay path.
            self?.teardownPeer(peerIdx, closeTransport: true)
        }
    }

    // MARK: Teardown

    /// Remove a peer and (optionally) close its transport. Idempotent: fires
    /// `onPeerClosed` exactly once per live peer. `closeTransport` is false when the
    /// transport already closed (the channel-closed callback drove us here) and true
    /// when WE initiate the close (watchdog / explicit closePeer).
    private func teardownPeer(_ peerIdx: Int, closeTransport: Bool) {
        guard let peer = peers.removeValue(forKey: peerIdx) else { return }
        peer.watchdog?.cancel()
        peer.open = false
        if closeTransport { self.closeTransport?(peerIdx) }
        onPeerClosed?(peerIdx)
    }

    // MARK: Stats / introspection

    public func getStats(_ peerIdx: Int) -> (out: Int, received: Int, lastPsSeen: Int)? {
        guard let s = stats[peerIdx] else { return nil }
        return (s.out, s.received, s.lastPsSeen)
    }

    public func getAllStats() -> [Int: (out: Int, received: Int, lastPsSeen: Int)] {
        var out: [Int: (out: Int, received: Int, lastPsSeen: Int)] = [:]
        for (k, s) in stats { out[k] = (s.out, s.received, s.lastPsSeen) }
        return out
    }

    /// Read-only snapshot for diagnostics and the headless verifier.
    public func peerState(_ peerIdx: Int) -> FastlanePeerState? {
        guard let peer = peers[peerIdx] else { return nil }
        let s = stats[peerIdx] ?? Stats()
        return FastlanePeerState(open: peer.open, lastAppliedEs: peer.lastAppliedEs,
                                 out: s.out, received: s.received, lastPsSeen: s.lastPsSeen)
    }

    private func statsFor(_ peerIdx: Int) -> Stats {
        if let s = stats[peerIdx] { return s }
        let s = Stats(); stats[peerIdx] = s; return s
    }

    /// Safe `ps` sequence read: a packet counter is a whole number well within
    /// Int64. Reject non-finite / out-of-range values instead of trapping in
    /// `Int(Double)` (the web never overflows, so a peer sending `ps: 1e308` must
    /// be dropped, not crash the display).
    private static func seqInt(_ d: Double) -> Int? {
        guard d.isFinite, abs(d) < 9.0e15 else { return nil }   // < 2^53
        return Int(d)
    }

    /// Lenient JSON-number read: returns nil for strings/bools/missing so a packet
    /// carrying `ps: "bogus"` is rejected exactly as the web's `typeof === 'number'`.
    ///
    /// A real boolean is identified by its CoreFoundation type, and that has to be
    /// the ONLY test. Swift bridges an NSNumber to `Bool` whenever its value is 0 or
    /// 1, so an `if v is Bool` guard ahead of this also swallowed the JSON number
    /// `0` — which is `ps` on every idle heartbeat before the first input, and `1` on
    /// the first input itself. Both were dropped un-acked, which broke the whole
    /// pre-first-input window: the sender's 3 s silence watchdog tore the channel
    /// down and re-negotiated on a loop through the lobby and countdown, and the
    /// first input landed only when the next packet resent it (`es = ps - i` covers
    /// it once `ps >= 2`). From two inputs on, heartbeats carry `ps = eventSeq` and
    /// it looked healthy. Only JSON-decoded values take the NSNumber path, which is
    /// why it reproduced solely against a real controller.
    private static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }
}
