import Foundation
@testable import HexStackerKit

/// Builds the canonical core bundle ONCE per test run (the SAME `npm run
/// build:core` the app's pre-build phase uses) and exposes the `dist/` dir the
/// bridge loads `partycore.js` from. Rebuilding from source keeps the suite
/// honest: it exercises the shipped artifact regenerated from the canonical
/// modules, not a stale checkout. `static let` => built exactly once, lazily.
enum EngineFixture {
    static let repoRoot: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // HexStackerKitTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // appletv
        .deletingLastPathComponent()   // <repo>

    /// Build the core + conformance bundles once per run via the shared
    /// scripts/build-engine.sh (the SAME script the app's pre-build phase and the
    /// Android :tv build use), so node resolution and the bundle set don't drift
    /// between the native phases and this harness. `static let` => run exactly once.
    private static let built: Void = {
        run(["/bin/bash", "scripts/build-engine.sh", "build:native"])
    }()

    static let coreBundleDir: URL = {
        _ = built
        return repoRoot.appendingPathComponent("dist")
    }()

    /// The frame-golden conformance driver (globalThis.HexFrameTest), bundled
    /// from the same tests/helpers/partycore-frame-script.js the Node golden
    /// test replays. Built once per run, like coreBundleDir.
    static let frameTestBundle: URL = {
        _ = built
        return repoRoot.appendingPathComponent("dist/partycore-frame-test.js")
    }()

    /// The committed V8-recorded golden the conformance test byte-compares against.
    static let frameGolden = repoRoot.appendingPathComponent("tests/fixtures/partycore-frame-golden.json")

    /// The packed-wire golden: per step, the exact payload PartyCore.packFrame
    /// produced and the frame it must decode to. Read by both native readers, which
    /// is the point — a layout change that lands on only one of them fails a build
    /// rather than a TV.
    static let packedGolden = repoRoot.appendingPathComponent("tests/fixtures/partycore-packed-golden.json")

    /// The cross-platform RoomCore golden: constructor options, the canonical op
    /// log, and the expected return value + snapshot after every step. Self-contained
    /// on purpose — this leg can't `require` the JS fixture the Node leg reads.
    static let roomCoreGolden = repoRoot.appendingPathComponent("tests/fixtures/room-core-golden.json")

    private static func run(_ arguments: [String]) {
        let proc = Process()
        proc.currentDirectoryURL = repoRoot
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = arguments
        // node resolution lives in build-engine.sh; no PATH shim needed here.
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        let label = arguments.joined(separator: " ")
        do { try proc.run(); proc.waitUntilExit() }
        catch { fatalError("\(label) failed to launch (node/npm on PATH?): \(error)") }
        if proc.terminationStatus != 0 {
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            fatalError("\(label) failed (status \(proc.terminationStatus)):\n\(out)")
        }
    }
}

/// In-memory `RelayTransport`: records sends/broadcasts and lets a test drive the
/// inbound callbacks (peer joins, controller messages) directly, no network.
final class FakeTransport: RelayTransport {
    var onCreated: ((String, String?, String?) -> Void)?
    var onJoined: ((String, [Int]) -> Void)?
    var onPeerJoined: ((Int) -> Void)?
    var onPeerLeft: ((Int) -> Void)?
    var onMessage: ((Int, [String: Any]) -> Void)?
    var onRelayError: ((String) -> Void)?
    var connected = false
    var recreatedRoomCount = 0
    var sent: [(to: Int, data: [String: Any])] = []
    var broadcasts: [[String: Any]] = []
    var states: [[String: Any]] = []   // retained set_state snapshots
    func connect() { connected = true }
    func recreateRoom() { recreatedRoomCount += 1 }
    func sendTo(_ index: Int, _ data: [String: Any]) { sent.append((index, data)) }
    func broadcast(_ data: [String: Any]) { broadcasts.append(data) }
    func setState(_ data: [String: Any]) { states.append(data) }
    func didBroadcast(_ type: String) -> Bool { broadcasts.contains { ($0["type"] as? String) == type } }
    func didSend(_ type: String, to: Int) -> Bool {
        sent.contains { $0.to == to && ($0.data["type"] as? String) == type }
    }
}

/// Records the coordinator's side-effects so tests can assert screen changes,
/// countdowns, render calls, results, and pause state.
final class FakeOutput: DisplayOutput {
    var screen: DisplayScreen?
    var room: String?
    var joinURL: String?
    var countdowns: [CountdownValue] = []
    var renderCount = 0
    var lastSnapshot: GameSnapshot?
    var results: [MatchResult]?
    var musicStarted = false
    var paused = false
    var displayMuted: Bool?   // last setDisplayMuted value (nil = never called)
    var rejoinQRVisible: Set<Int> = []   // players currently showing a per-board rejoin QR
    var lobbyAmbient: [AmbientPiece]?    // last frozen lobby-background fixture (nil = never)
    var calls: [String] = []   // ordered call log (for ordering regressions)
    func showScreen(_ s: DisplayScreen) { screen = s; calls.append("showScreen") }
    func setPaused(_ p: Bool) { paused = p; calls.append("setPaused(\(p))") }
    func setDisplayMuted(_ m: Bool) { displayMuted = m }
    func setDisconnected(playerId: Int, joinURL: String?) {
        if joinURL != nil { rejoinQRVisible.insert(playerId) } else { rejoinQRVisible.remove(playerId) }
    }
    func setLobbyAmbient(_ pieces: [AmbientPiece]) { lobbyAmbient = pieces }
    var qrText: String?
    func roomReady(room: String, joinURL: String, qrText: String) {
        self.room = room; self.joinURL = joinURL; self.qrText = qrText
    }
    var roomClosedCount = 0
    func roomClosed() {
        roomClosedCount += 1
        room = nil; joinURL = nil; qrText = nil
        lobbyPlayers = []
        calls.append("roomClosed")
    }
    var lobbyPlayers: [PlayerRecord] = []   // last roster handed to the display lobby
    var lobbyHost: Int?
    func updateLobby(players: [PlayerRecord], hostPeerIndex: Int?) {
        lobbyPlayers = players
        lobbyHost = hostPeerIndex
    }
    func showCountdown(_ v: CountdownValue) { countdowns.append(v) }
    func renderSnapshot(_ s: GameSnapshot) { renderCount += 1; lastSnapshot = s }
    func showResults(_ r: [MatchResult]) { results = r; calls.append("showResults") }
    func playCountdownBeep(go: Bool) {}
    func startMusic() { musicStarted = true }
    func stopMusic() {}
    func pauseMusic() {}
    func resumeMusic() {}
}

/// Records the coordinator's fastlane calls and mimics the real signal
/// interception (consumes `__rtc` envelopes) so tests can assert the coordinator
/// wires the WebRTC fastlane up the way the web display does.
final class FakeFastlane: InputFastlane {
    var onInput: ((Int, [String: Any]) -> Void)?
    var signalsHandled: [(from: Int, data: [String: Any])] = []
    var closedPeers: [Int] = []
    var closeAllCount = 0
    func handleSignal(from: Int, data: [String: Any]) -> Bool {
        guard FastlaneConfig.isSignalEnvelope(data) else { return false }
        signalsHandled.append((from, data))
        return true
    }
    func closePeer(_ index: Int) { closedPeers.append(index) }
    func closeAll() { closeAllCount += 1 }
}
