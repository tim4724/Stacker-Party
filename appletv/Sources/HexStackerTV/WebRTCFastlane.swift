import Foundation
import HexStackerKit

// WebRTC transport for the input fastlane — the tvOS analogue of the WebRTC half
// of partyplug/PartyFastlane.js. It owns one RTCPeerConnection per controller and
// drives the platform-agnostic `FastlaneNetcode` (the wire codec / dedup / acks /
// watchdog, in HexStackerKit) with channel lifecycle + raw bytes.
//
// tvOS ships no system WebRTC, so this links LiveKit's tvOS-capable distribution
// (https://github.com/livekit/webrtc-xcframework, module `LiveKitWebRTC`, symbols
// prefixed `LK`). The whole implementation is gated on `canImport(LiveKitWebRTC)`:
// if the package isn't added, `WebRTCFastlane.make()` returns nil and the display
// falls back to relay-only input — exactly the web's `typeof PartyFastlane` guard.
//
// Role: the display is always relay slot 0 and is the RECEIVER. Controllers create
// the unreliable/unordered DataChannel and send the offer on join; the display only
// auto-accepts offers, answers, trickles ICE, and forwards received packets to the
// netcode. It never creates an offer, so perfect-negotiation glare can't arise on
// this side (it is the impolite peer but never initiates).
//
// CANNOT be built or run under Command Line Tools (no LiveKitWebRTC, no tvOS SDK).
// Verify in Xcode against an Apple TV Simulator/device: add the SPM package (see
// project.yml), open a phone controller to the room QR, and confirm input rides
// the channel (the controller shows its fastlane bolt) with the relay still the
// fallback. The netcode it drives is verified headlessly by FastlaneTests (`swift test`).

#if canImport(LiveKitWebRTC)
import LiveKitWebRTC

/// WebRTC-backed `InputFastlane`. Single-threaded on the main queue: every WebRTC
/// delegate callback (which arrives on libwebrtc's signaling thread) hops to main
/// before touching the netcode or the peer map, matching the coordinator/relay
/// callback queue.
final class WebRTCFastlane: NSObject, InputFastlane {

    /// Construct the fastlane, or nil if WebRTC can't initialize. `sendSignal`
    /// ships an `__rtc` envelope to a controller over the relay (relay.sendTo).
    static func make(stunURL: String,
                     sendSignal: @escaping (_ peerIdx: Int, _ data: [String: Any]) -> Void)
        -> WebRTCFastlane? {
        WebRTCFastlane(stunURL: stunURL, sendSignal: sendSignal)
    }

    var onInput: ((Int, [String: Any]) -> Void)? {
        get { netcode.onInput }
        set { netcode.onInput = newValue }
    }

    // Per-controller WebRTC state. The netcode-side state lives in `netcode`.
    private final class PeerConn {
        let pc: LKRTCPeerConnection
        let observer: PeerObserver
        var channel: LKRTCDataChannel?
        var pendingCandidates: [LKRTCIceCandidate] = []
        init(pc: LKRTCPeerConnection, observer: PeerObserver) { self.pc = pc; self.observer = observer }
    }

    private let netcode: FastlaneNetcode
    private let sendSignal: (Int, [String: Any]) -> Void
    private let config: LKRTCConfiguration
    private let factory: LKRTCPeerConnectionFactory
    private var peers: [Int: PeerConn] = [:]

    // libwebrtc must initialize SSL exactly once per process.
    private static let sslOnce: Void = { LKRTCInitializeSSL() }()

    private init?(stunURL: String, sendSignal: @escaping (Int, [String: Any]) -> Void) {
        _ = WebRTCFastlane.sslOnce
        self.sendSignal = sendSignal
        self.factory = LKRTCPeerConnectionFactory()
        self.netcode = FastlaneNetcode()

        let cfg = LKRTCConfiguration()
        cfg.iceServers = [LKRTCIceServer(urlStrings: [stunURL])]
        cfg.sdpSemantics = .unifiedPlan
        // Match the controller: app-layer redundancy replaces SCTP retransmits, so
        // we don't need (and shouldn't pay for) a bundle/RTCP-mux negotiation here.
        self.config = cfg
        super.init()

        // Bridge the netcode's transport hooks to the live DataChannels.
        netcode.send = { [weak self] peerIdx, data in
            guard let channel = self?.peers[peerIdx]?.channel else { return }
            channel.sendData(LKRTCDataBuffer(data: data, isBinary: false))
        }
        netcode.closeTransport = { [weak self] peerIdx in
            self?.removePeerConn(peerIdx)
        }
    }

    // MARK: InputFastlane

    func handleSignal(from: Int, data: [String: Any]) -> Bool {
        // Consume ANY envelope carrying the signal key: a malformed non-string
        // kind must not leak into app dispatch (JS PartyFastlane consumes on
        // presence alone).
        guard data[FastlaneConfig.signalKey] != nil else { return false }
        guard let kind = data[FastlaneConfig.signalKey] as? String else { return true }
        // Always on main (relay callbacks are delivered on .main).
        switch kind {
        case "offer":  if let sdp = data["sdp"] as? [String: Any] { handleOffer(from: from, sdp: sdp) }
        case "answer": if let sdp = data["sdp"] as? [String: Any] { handleAnswer(from: from, sdp: sdp) }
        case "ice":    if let cand = data["candidate"] as? [String: Any] { handleIce(from: from, candidate: cand) }
        default: break
        }
        return true
    }

    // The netcode only knows peers whose DataChannel actually OPENED, so routing the
    // close through it alone would strand a connection still in offer/ICE (leaking an
    // RTCPeerConnection until ICE gives up ~30 s later, and handing a re-offer from the
    // same index that stale `pc`). Reap the transport map directly too; removePeerConn
    // is idempotent, so the netcode's own closeTransport callback double-firing is fine.
    func closePeer(_ index: Int) {
        netcode.closePeer(index)
        removePeerConn(index)
    }

    func closeAll() {
        netcode.closeAll()
        for idx in Array(peers.keys) { removePeerConn(idx) }
    }

    // MARK: Signaling

    private func ensurePeer(_ peerIdx: Int) -> PeerConn? {
        if let existing = peers[peerIdx] { return existing }
        let observer = PeerObserver(owner: self, peerIdx: peerIdx)
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: observer) else {
            return nil
        }
        let conn = PeerConn(pc: pc, observer: observer)
        peers[peerIdx] = conn
        return conn
    }

    private func handleOffer(from: Int, sdp: [String: Any]) {
        guard let conn = ensurePeer(from), let sdpStr = sdp["sdp"] as? String else { return }
        let remote = LKRTCSessionDescription(type: .offer, sdp: sdpStr)
        conn.pc.setRemoteDescription(remote) { [weak self] err in
            DispatchQueue.main.async {
                guard let self, err == nil, let conn = self.peers[from] else { return }
                self.drainPendingCandidates(conn)
                let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
                conn.pc.answer(for: constraints) { answer, _ in
                    DispatchQueue.main.async {
                        guard let answer, let conn = self.peers[from] else { return }
                        conn.pc.setLocalDescription(answer) { _ in
                            DispatchQueue.main.async {
                                self.sendSignal(from, ["__rtc": "answer",
                                                       "sdp": ["type": "answer", "sdp": answer.sdp]])
                            }
                        }
                    }
                }
            }
        }
    }

    // The display doesn't initiate offers, so it normally won't receive answers;
    // handled defensively for symmetry with PartyFastlane.
    private func handleAnswer(from: Int, sdp: [String: Any]) {
        guard let conn = peers[from], let sdpStr = sdp["sdp"] as? String else { return }
        conn.pc.setRemoteDescription(LKRTCSessionDescription(type: .answer, sdp: sdpStr)) { _ in }
    }

    private func handleIce(from: Int, candidate: [String: Any]) {
        guard let conn = ensurePeer(from), let cand = candidate["candidate"] as? String else { return }
        let mLineIndex = (candidate["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
        let ice = LKRTCIceCandidate(sdp: cand, sdpMLineIndex: mLineIndex,
                                    sdpMid: candidate["sdpMid"] as? String)
        // Candidates can arrive before the remote description; queue until it's set.
        // Capped: a peer spamming ICE frames without ever completing an offer
        // must not grow the queue unbounded (a real session sends a handful).
        if conn.pc.remoteDescription == nil {
            if conn.pendingCandidates.count < 32 { conn.pendingCandidates.append(ice) }
        } else {
            conn.pc.add(ice) { _ in }
        }
    }

    private func drainPendingCandidates(_ conn: PeerConn) {
        for ice in conn.pendingCandidates { conn.pc.add(ice) { _ in } }
        conn.pendingCandidates.removeAll()
    }

    private func removePeerConn(_ peerIdx: Int) {
        guard let conn = peers.removeValue(forKey: peerIdx) else { return }
        conn.channel?.close()
        conn.pc.close()
    }

    // MARK: Delegate callbacks (forwarded from PeerObserver, already on main)

    fileprivate func onIceCandidate(_ peerIdx: Int, _ candidate: LKRTCIceCandidate) {
        sendSignal(peerIdx, ["__rtc": "ice", "candidate": [
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid as Any,
            "sdpMLineIndex": Int(candidate.sdpMLineIndex),
        ]])
    }

    fileprivate func onDataChannel(_ peerIdx: Int, _ channel: LKRTCDataChannel) {
        guard let conn = peers[peerIdx] else { return }
        // Detach the channel we're replacing so its own state transitions stop routing
        // here. Don't close() it: an orphan from a rolled-back offer shares the SCTP
        // stream id, and closing would tear down the adopted channel remotely (the
        // same reason PartyFastlane._wireChannel only nulls the handlers).
        if let previous = conn.channel, previous !== channel { previous.delegate = nil }
        conn.channel = channel
        channel.delegate = conn.observer
        // If the controller's channel is already open by the time we adopt it,
        // prime the netcode immediately (didChangeState may have already fired).
        if channel.readyState == .open { netcode.peerChannelOpened(peerIdx) }
    }

    /// `channel` identifies WHICH channel transitioned: a detached orphan can still
    /// deliver a queued callback, and acting on it would tear down the adopted channel
    /// (on `.closed`) or rebuild the netcode peer mid-session, resetting `lastAppliedEs`
    /// so every subsequent input is deduped away (on `.open`). PartyFastlane guards the
    /// same way (`if (peer.channel !== channel) return`), as does the Android port.
    fileprivate func onChannelState(_ peerIdx: Int, _ channel: LKRTCDataChannel,
                                    _ state: LKRTCDataChannelState) {
        guard peers[peerIdx]?.channel === channel else { return }
        switch state {
        case .open:   netcode.peerChannelOpened(peerIdx)
        case .closed: netcode.peerChannelClosed(peerIdx); removePeerConn(peerIdx)
        default: break
        }
    }

    fileprivate func onChannelMessage(_ peerIdx: Int, _ buffer: LKRTCDataBuffer) {
        netcode.peerReceived(peerIdx, buffer.data)
    }

    fileprivate func onConnectionState(_ peerIdx: Int, _ state: LKRTCPeerConnectionState) {
        if state == .failed || state == .closed {
            netcode.peerChannelClosed(peerIdx)
            removePeerConn(peerIdx)
        }
    }
}

// MARK: - Per-peer delegate

/// One observer per RTCPeerConnection so the peer index travels with the callbacks
/// (the WebRTC delegate API only hands back the connection). Hops every callback to
/// main before touching `WebRTCFastlane`.
private final class PeerObserver: NSObject, LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate {
    weak var owner: WebRTCFastlane?
    let peerIdx: Int
    init(owner: WebRTCFastlane, peerIdx: Int) { self.owner = owner; self.peerIdx = peerIdx }

    func peerConnection(_ pc: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        let idx = peerIdx
        DispatchQueue.main.async { [weak self] in self?.owner?.onIceCandidate(idx, candidate) }
    }
    func peerConnection(_ pc: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
        let idx = peerIdx
        DispatchQueue.main.async { [weak self] in self?.owner?.onDataChannel(idx, dataChannel) }
    }
    func peerConnection(_ pc: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        let idx = peerIdx
        DispatchQueue.main.async { [weak self] in self?.owner?.onConnectionState(idx, newState) }
    }

    func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {
        let idx = peerIdx
        // Read the state here and carry the channel across the hop: by the time this
        // runs on main, readyState may have moved on and the channel may have been
        // replaced (see onChannelState's identity guard).
        let state = dataChannel.readyState
        DispatchQueue.main.async { [weak self] in
            self?.owner?.onChannelState(idx, dataChannel, state)
        }
    }
    func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        let idx = peerIdx
        DispatchQueue.main.async { [weak self] in self?.owner?.onChannelMessage(idx, buffer) }
    }

    // Unused delegate requirements (data-channel-only peer; no media, no streams).
    func peerConnection(_ pc: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ pc: LKRTCPeerConnection) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {}
    func peerConnection(_ pc: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
}

#endif
