import Testing
import Foundation
@testable import HexStackerKit

// Receiver-side fastlane netcode tests, mirroring the receiver cases in
// partyplug/tests/party-fastlane.test.js. Run under `swift test` (works with only
// Command Line Tools; no full Xcode).

private final class ManualScheduler: FastlaneScheduler {
    final class Token: FastlaneTimerToken {
        var work: (() -> Void)?
        var canceled = false
        func cancel() { canceled = true; work = nil }
    }
    var pending: [Token] = []
    func schedule(afterMs: Double, _ work: @escaping () -> Void) -> FastlaneTimerToken {
        let t = Token(); t.work = work; pending.append(t); return t
    }
    func fireAll() {
        let live = pending.filter { !$0.canceled }
        pending.removeAll()
        for t in live { t.work?() }
    }
}

private final class Harness {
    let net: FastlaneNetcode
    let scheduler = ManualScheduler()
    var sent: [(to: Int, packet: [String: Any])] = []
    var input: [(from: Int, ev: [String: Any])] = []
    var ready: [Int] = []
    var closed: [Int] = []
    var transportClosed: [Int] = []

    init() {
        net = FastlaneNetcode(now: { 0 }, scheduler: scheduler)
        net.send = { [weak self] idx, data in
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            self?.sent.append((idx, obj))
        }
        net.closeTransport = { [weak self] idx in self?.transportClosed.append(idx) }
        net.onInput = { [weak self] idx, ev in self?.input.append((idx, ev)) }
        net.onPeerReady = { [weak self] idx in self?.ready.append(idx) }
        net.onPeerClosed = { [weak self] idx in self?.closed.append(idx) }
    }

    func recv(_ peerIdx: Int, _ packet: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: packet)
        net.peerReceived(peerIdx, data)
    }
}

@Suite struct FastlaneNetcodeTests {

    @Test func channelOpenSignalsReadyAndOpen() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        #expect(h.ready == [1])
        #expect(h.net.isOpen(1))
        #expect(!h.net.isOpen(2))
    }

    @Test func appliesNewEventsAscendingAndAdvancesSeq() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 3, "t": 0, "h": [["a": 3], ["a": 2], ["a": 1]]])
        #expect(h.input.map { $0.ev["a"] as? Int } == [1, 2, 3])
        #expect(h.net.peerState(1)?.lastAppliedEs == 3)
    }

    @Test func dedupesResends() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 3, "t": 0, "h": [["a": 3], ["a": 2], ["a": 1]]])
        h.recv(1, ["ps": 3, "t": 0, "h": [["a": 3], ["a": 2], ["a": 1]]])
        #expect(h.input.count == 3)
        #expect(h.net.peerState(1)?.lastAppliedEs == 3)
    }

    @Test func mixedPacketAppliesOnlyNewTail() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 2, "t": 0, "h": [["a": 2], ["a": 1]]])
        h.recv(1, ["ps": 4, "t": 0, "h": [["a": 4], ["a": 3], ["a": 2]]])
        #expect(h.input.map { $0.ev["a"] as? Int } == [1, 2, 3, 4])
        #expect(h.net.peerState(1)?.lastAppliedEs == 4)
    }

    @Test func ignoresMalformedPsWithoutAcking() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": "bogus", "t": 0, "h": [["a": 1]]])
        h.recv(1, ["t": 0, "h": [["a": 1]]])
        #expect(h.input.isEmpty)
        #expect(h.net.peerState(1)?.lastAppliedEs == 0)
        #expect(h.sent.isEmpty)
    }

    @Test func acksEveryDataPacketAndHeartbeat() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 2, "t": 100, "h": [["a": 2], ["a": 1]]])
        #expect(h.sent.count == 1)
        #expect(h.sent[0].packet["pa"] as? Int == 2)
        #expect(h.sent[0].packet["t"] as? Double == 100, "ack echoes t for RTT")
        h.recv(1, ["ps": 2, "t": 200, "h": [[String: Any]]()])   // heartbeat (h: []) is acked too
        #expect(h.sent.count == 2)
        #expect(h.sent[1].packet["pa"] as? Int == 2)
        #expect(h.sent[1].packet["t"] as? Double == 200, "heartbeat ack echoes the new t")
    }

    /// `ps` 0 and 1 are the two values Swift's NSNumber bridge also reports as
    /// `Bool`, and they are exactly the ones a live session opens with: every idle
    /// heartbeat carries `ps: 0` until the first input, which itself carries
    /// `ps: 1`. A guard that mistook them for booleans dropped both un-acked, so
    /// the sender's silence watchdog tore the channel down every 3 s for the whole
    /// pre-first-input window — while the display's own counters showed packets
    /// arriving, which is why it only ever showed up against a real controller.
    /// The rest of the suite starts at `ps: 2` and never touched it.
    @Test func acceptsZeroAndOneSequenceNumbers() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 0, "t": 100, "h": [[String: Any]]()])   // pre-input idle heartbeat
        #expect(h.sent.count == 1, "a ps:0 heartbeat is acked, or the sender's watchdog fires")
        #expect(h.sent[0].packet["pa"] as? Int == 0)
        h.recv(1, ["ps": 1, "t": 200, "h": [["a": 1]]])          // the FIRST input
        #expect(h.input.map { $0.ev["a"] as? Int } == [1], "the first input is applied, not dropped")
        #expect(h.sent.count == 2)
        #expect(h.sent[1].packet["pa"] as? Int == 1)
    }

    /// The truthiness guard still has to hold: a JSON boolean is not a sequence.
    @Test func rejectsBooleanSequenceNumbers() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": true, "t": 0, "h": [["a": 1]]])
        #expect(h.input.isEmpty)
        #expect(h.sent.isEmpty, "an undecodable packet is dropped without an ack")
    }

    @Test func statsTrackOutReceivedAndMaxPs() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.recv(1, ["ps": 5, "t": 0, "h": [["a": 5]]])
        h.recv(1, ["ps": 4, "t": 0, "h": [["a": 4]]])
        let s = h.net.getStats(1)
        #expect(s?.received == 2)
        #expect(s?.out == 2)
        #expect(s?.lastPsSeen == 5)
        #expect(h.net.getStats(99) == nil)
        // getAllStats aggregates the per-peer getStats (mirrors PartyFastlane.getAllStats).
        #expect(h.net.getAllStats()[1]?.out == 2)
    }

    @Test func capsOversizedEventArray() {
        // A crafted packet with a huge `h` must not fan out into an unbounded burst
        // of onInput calls; it is truncated to maxEventsPerPacket.
        let h = Harness()
        h.net.peerChannelOpened(1)
        let cap = FastlaneConfig.maxEventsPerPacket
        let oversized = (0..<(cap + 50)).map { ["a": $0] }
        h.recv(1, ["ps": cap + 50, "t": 0, "h": oversized])
        #expect(h.input.count == cap, "oversized h array is capped at maxEventsPerPacket")
    }

    @Test func watchdogTearsDownOnceOnSilence() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.scheduler.fireAll()
        #expect(h.transportClosed == [1])
        #expect(h.closed == [1])
        #expect(!h.net.isOpen(1))
        h.net.peerChannelClosed(1)   // late transport callback
        #expect(h.closed == [1])     // not double-fired
    }

    @Test func inboundResetsWatchdog() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        let openTimer = h.scheduler.pending[0]
        h.recv(1, ["ps": 1, "t": 0, "h": [["a": 1]]])
        #expect(h.net.isOpen(1))
        #expect(openTimer.canceled, "the previous watchdog timer is canceled")
        #expect(h.scheduler.pending.contains { !$0.canceled }, "a fresh watchdog is armed")
    }

    @Test func replacedChannelDisarmsTheStaleWatchdog() {
        // The controller re-offers (e.g. after an ICE hiccup) and the channel is
        // replaced before the first session's watchdog fired. The stale timer
        // must be disarmed — teardownPeer keys by index, so it would otherwise
        // tear down the fresh, healthy channel when its deadline lapses.
        let h = Harness()
        h.net.peerChannelOpened(1)
        let staleTimer = h.scheduler.pending[0]
        h.net.peerChannelOpened(1)
        #expect(staleTimer.canceled, "the replaced session's watchdog is disarmed")
        staleTimer.work?()   // simulate the old deadline lapsing anyway
        #expect(h.net.isOpen(1), "the fresh channel survives the old session's deadline")
        #expect(h.closed.isEmpty, "no spurious onPeerClosed")
    }

    @Test func explicitCloseTearsDown() {
        let h = Harness()
        h.net.peerChannelOpened(1)
        h.net.peerChannelOpened(2)
        h.net.closePeer(1)
        #expect(h.transportClosed == [1])
        #expect(h.closed == [1])
        #expect(h.net.isOpen(2))
        h.net.closeAll()
        #expect(Set(h.closed) == [1, 2])
        #expect(!h.net.isOpen(2), "no peers open after closeAll")
    }

    @Test func detectsSignalEnvelopes() {
        #expect(FastlaneConfig.isSignalEnvelope(["__rtc": "offer", "sdp": [:]]))
        #expect(FastlaneConfig.isSignalEnvelope(["__rtc": "ice", "candidate": [:]]))
        #expect(!FastlaneConfig.isSignalEnvelope(["type": "input"]))
        #expect(!FastlaneConfig.isSignalEnvelope(nil))
        #expect(!FastlaneConfig.isSignalEnvelope("plain string"))
    }
}
